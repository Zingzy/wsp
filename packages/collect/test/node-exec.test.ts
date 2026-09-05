// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Host, HostExec, RunOptions } from "../src/host.js";
import { LIST_BUDGET_MS, LIST_SCRIPTS, shellAliases } from "../src/index.js";
import { nodeExec } from "../src/live-host.js";
import { fakeHost } from "./fake-host.js";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
  pids.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A job whose parent is gone is reaped by launchd, so it may read as alive for a moment after the kill. */
const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 100 && alive(pid); i += 1) await new Promise(r => setTimeout(r, 20));
  return !alive(pid);
};

const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "wsp-exec-"));
  dirs.push(d);
  return d;
};

/** Polls the pid file a shell writes so the pid is known before it is judged; a loaded machine starts a child late. */
const pidIn = async (file: string): Promise<number> => {
  for (let i = 0; i < 400 && !existsSync(file); i += 1) await new Promise(r => setTimeout(r, 20));
  const pid = Number(readFileSync(file, "utf8").trim());
  pids.push(pid);
  return pid;
};

describe("nodeExec.run", () => {
  it("returns stdout on exit 0 and nothing on a failure or a missing command", async () => {
    expect(await nodeExec.run("/bin/sh", ["-c", "printf hi"])).toBe("hi");
    expect(await nodeExec.run("/bin/sh", ["-c", "echo out; exit 3"])).toBeUndefined();
    expect(await nodeExec.run("/nonexistent/wsp-bin", [])).toBeUndefined();
  });

  it("gives every child end of file on stdin, so a shell that reads it returns at once", async () => {
    expect(await nodeExec.run("/bin/sh", ["-c", "read x; echo done"], { timeoutMs: 5000 })).toBe("done\n");
  });

  it("adds the given variables to the collector's own environment", async () => {
    expect(await nodeExec.run("/bin/sh", ["-c", 'echo "$WSP_COLLECT:${PATH:+path}"'], { env: { WSP_COLLECT: "1" } })).toBe("1:path\n");
    expect(await nodeExec.run("/bin/sh", ["-c", 'echo "[$WSP_COLLECT]"'])).toBe("[]\n");
  });

  it("an empty home is a new directory HOME and ZDOTDIR point at, over anything env says, gone when the run ends", async () => {
    const out = await nodeExec.run("/bin/sh", ["-c", 'echo "$HOME"; echo "$ZDOTDIR"; ls -A "$HOME" | wc -l; touch "$HOME/left"'], { emptyHome: true, env: { ZDOTDIR: "/nowhere" } });
    const [home, zdotdir, count] = out?.split("\n") ?? [];
    expect(home).toMatch(/wsp-home-/);
    expect(home).not.toBe(process.env["HOME"]);
    expect(zdotdir).toBe(home);
    expect(count?.trim()).toBe("0");
    expect(existsSync(home ?? "")).toBe(false);
  });

  it("ends a child that ignores TERM at the budget with the kill signal asked for", async () => {
    const d = scratch();
    const out = nodeExec.run("/bin/sh", ["-c", `trap '' TERM; echo $$ > ${join(d, "pid")}; while :; do sleep 1; done`], { timeoutMs: 300, killSignal: "SIGKILL" });
    const pid = await pidIn(join(d, "pid"));
    expect(alive(pid)).toBe(true);
    expect(await out).toBeUndefined();
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it("does not wait on a grandchild that kept stdout after the child exited, and ends it with the run", async () => {
    const d = scratch();
    const out = await nodeExec.run("/bin/sh", ["-c", `sleep 30 & echo $! > ${join(d, "pid")}; echo listed`]);
    const pid = await pidIn(join(d, "pid"));
    expect(out).toBe("listed\n");
    expect(await gone(pid)).toBe(true);
  }, 15_000);

  it("the budget ends the whole process group: a job a real zshrc started is dead when the run ends", async () => {
    const d = scratch();
    writeFileSync(join(d, ".zshrc"), `sleep 100 & echo $! > ${join(d, "job")}; echo $$ > ${join(d, "pid")}; wait\n`);
    const out = nodeExec.run("/bin/zsh", ["-ic", LIST_SCRIPTS["zsh"]], { env: { ZDOTDIR: d, WSP_COLLECT: "1" }, timeoutMs: 500, killSignal: "SIGKILL" });
    const shell = await pidIn(join(d, "pid"));
    const job = await pidIn(join(d, "job"));
    expect(alive(shell)).toBe(true);
    expect(alive(job)).toBe(true);
    expect(await out).toBeUndefined();
    expect(alive(shell)).toBe(false);
    expect(await gone(job)).toBe(true);
  }, 15_000);
});

describe("the interactive listing over a real shell", () => {
  it("is run with stdin closed, WSP_COLLECT=1 and a ten second budget ended by SIGKILL; a shell that never exits is killed and the rc files answer", async () => {
    const d = scratch();
    const shell = join(d, "zsh");
    writeFileSync(shell, `#!/bin/sh\n[ "$1" = --warm ] && exit 0\ntrap '' TERM\necho $$ > ${join(d, "pid")}\nread x\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
    /** The first exec of a freshly written script takes 440 ms median here, up to 1.6 s, the next 6 ms; paid before the 500 ms budget below. */
    execFileSync(shell, ["--warm"]);
    let seen: RunOptions | undefined;
    const exec: HostExec = {
      which: nodeExec.which,
      run: (cmd, args, opts) => {
        seen = opts;
        return nodeExec.run(cmd, args, { ...opts, timeoutMs: 500 });
      },
    };
    const fake = fakeHost({ shell, files: { "/etc/shells": `${shell}\n`, "~/.zshrc": "alias ls=eza\n" } });
    const host: Host = { ...fake, exec };
    const row = { rung: "shell" as const, id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 10, default: "bring" as const };
    const done = shellAliases(host, [row]);
    const pid = await pidIn(join(d, "pid"));
    await done;
    expect(seen).toEqual({ env: { WSP_COLLECT: "1" }, timeoutMs: LIST_BUDGET_MS, killSignal: "SIGKILL" });
    expect(LIST_BUDGET_MS).toBe(10_000);
    expect(alive(pid)).toBe(false);
    expect(row).toMatchObject({ aliasesFrom: "files", aliases: [{ name: "ls", kind: "alias", runs: "eza" }] });
  }, 15_000);
});

describe("the listing over real zsh with a scratch ZDOTDIR", () => {
  const terminals: { terminal: string; env: Record<string, string> }[] = [
    { terminal: "ghostty", env: { TERM_PROGRAM: "ghostty" } },
    { terminal: "Apple_Terminal", env: { TERM_PROGRAM: "Apple_Terminal", TERM_SESSION_ID: "wsp-test" } },
  ];
  it.each(terminals)("under $terminal an rc that returns on WSP_COLLECT is read from the files, one that defines an alias is listed by the shell", async ({ env }) => {
    const row = async (zshrc: string) => {
      const d = scratch();
      writeFileSync(join(d, ".zshrc"), zshrc);
      const exec: HostExec = { which: nodeExec.which, run: (cmd, args, opts) => nodeExec.run(cmd, args, { ...opts, env: { ...env, ZDOTDIR: d, ...opts?.env } }) };
      const fake = fakeHost({ shell: "/bin/zsh", files: { "/etc/shells": "/bin/zsh\n", "~/.zshrc": zshrc } });
      const r = { rung: "shell" as const, id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 10, default: "bring" as const };
      await shellAliases({ ...fake, exec }, [r]);
      return r;
    };
    expect(await row('[ "$WSP_COLLECT" = 1 ] && return\nalias v=nvim\n')).toMatchObject({ aliasesFrom: "files", aliases: [{ name: "v", kind: "alias", runs: "nvim" }] });
    expect(await row("alias v=nvim\n")).toMatchObject({ aliasesFrom: "shell", aliases: [{ name: "v", kind: "alias", runs: "nvim" }] });
  }, 30_000);
});
