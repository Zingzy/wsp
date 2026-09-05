// SPDX-License-Identifier: AGPL-3.0-only
// The launch and poll contract over a scripted guest: a log that grows between
// polls, an exit file, a leader that can die or be killed, and a machine that
// naps mid-run. The last block runs the real guest commands under this
// machine's bash with setsid shimmed, since macOS has none.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEADLINE_EXIT, INLINE_EXEC_MS, execDetached } from "../src/exec-detached.js";
import type { ExecResult, Machine } from "../src/machine.js";

interface Step {
  out?: string;
  err?: string;
  exit?: number;
  dead?: boolean;
  /** The poll fails as it does while the machine is paused. */
  nap?: boolean;
}

interface Call {
  cmd: string;
  timeoutMs: number | undefined;
}

/** A guest that answers the transport: steps apply one per poll, before the poll reads. */
function guest(steps: Step[]) {
  let out = Buffer.alloc(0);
  let err = Buffer.alloc(0);
  let exit = "";
  let alive = true;
  let script: string | undefined;
  let step = 0;
  const calls: Call[] = [];
  const kills: string[] = [];
  const polls: { out: number; err: number }[] = [];
  let cleaned = 0;
  const machine = {
    id: "m1",
    async exec(cmd: string, o?: { timeoutMs?: number }): Promise<ExecResult> {
      calls.push({ cmd, timeoutMs: o?.timeoutMs });
      if (cmd.includes("echo WSP_LAUNCHED")) {
        script = Buffer.from(cmd.match(/printf %s '([A-Za-z0-9+/=]*)'/)?.[1] ?? "", "base64").toString("utf8");
        return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
      }
      if (cmd.includes("kill -TERM")) {
        kills.push(cmd);
        alive = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd.startsWith("rm -")) {
        cleaned++;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd.includes("echo WSP_POLL")) {
        const s = steps[step];
        if (s !== undefined) {
          step++;
          if (s.nap) throw Object.assign(new Error("Bad Gateway"), { kind: "transient", status: 502 });
          if (s.out !== undefined) out = Buffer.concat([out, Buffer.from(s.out)]);
          if (s.err !== undefined) err = Buffer.concat([err, Buffer.from(s.err)]);
          if (s.exit !== undefined) exit = String(s.exit);
          if (s.dead) alive = false;
        }
        const from = { out: Number(cmd.match(/tail -c \+(\d+) "\$b\.out"/)?.[1]) - 1, err: Number(cmd.match(/tail -c \+(\d+) "\$b\.err"/)?.[1]) - 1 };
        polls.push(from);
        const chunk = (buf: Buffer, at: number) => buf.subarray(at, at + 262_144).toString("base64");
        return { exitCode: 0, stdout: `WSP_POLL\n${exit}\n${chunk(out, from.out)}\n${chunk(err, from.err)}\n${alive ? "up" : "down"}\nWSP_POLL_END\n`, stderr: "" };
      }
      throw new Error(`guest got an unexpected command: ${cmd}`);
    },
  } as unknown as Machine;
  return { machine, calls, kills, polls, script: () => script, cleaned: () => cleaned };
}

describe("execDetached over a scripted guest", () => {
  it("launches the script detached, reads both streams from where the last poll stopped, and returns the exit file", async () => {
    const g = guest([{ out: "one\ntw" }, { out: "o\nthree\n", err: "warn\n" }, { exit: 3 }]);
    const lines: string[] = [];
    const res = await execDetached(g.machine, "brew install gh", { deadlineMs: 10_000, pollMs: 1, onLine: l => lines.push(l) });
    expect(res).toEqual({ exitCode: 3, stdout: "one\ntwo\nthree\n", stderr: "warn\n" });
    expect(lines).toEqual(["one", "two", "three", "warn"]);
    expect(g.script()).toBe("brew install gh");
    expect(g.polls).toEqual([{ out: 0, err: 0 }, { out: 6, err: 0 }, { out: 14, err: 5 }]);
    expect(g.cleaned()).toBe(1);
    expect(g.kills).toEqual([]);
  });

  it("every exec it sends is bounded at the inline cap", async () => {
    const g = guest([{ out: "x\n", exit: 0 }]);
    await execDetached(g.machine, "true", { deadlineMs: 10_000, pollMs: 1 });
    expect(g.calls.length).toBeGreaterThanOrEqual(3);
    for (const c of g.calls) expect(c.timeoutMs, c.cmd).toBeLessThanOrEqual(INLINE_EXEC_MS);
  });

  it("a full chunk is followed at once by the next read from the new offset", async () => {
    const big = "x".repeat(262_144) + "tail\n";
    const g = guest([{ out: big, exit: 0 }]);
    const res = await execDetached(g.machine, "true", { deadlineMs: 10_000, pollMs: 1 });
    expect(res.stdout).toBe(big);
    expect(g.polls.map(p => p.out)).toEqual([0, 262_144]);
  });

  it("the exit file ends the run only once nothing is left to read", async () => {
    const g = guest([{ exit: 0, out: "a".repeat(262_144) }, { out: "b\n" }]);
    const res = await execDetached(g.machine, "true", { deadlineMs: 10_000, pollMs: 1 });
    expect(res.stdout).toBe(`${"a".repeat(262_144)}b\n`);
  });

  it("past the deadline it kills the recorded pid with its group and answers 124 with the output so far", async () => {
    const g = guest([{ out: "started\n" }]);
    const t0 = Date.now();
    const res = await execDetached(g.machine, "sleep 999", { deadlineMs: 40, pollMs: 1 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.exitCode).toBe(DEADLINE_EXIT);
    expect(res.stdout).toBe("started\n");
    expect(g.kills).toHaveLength(1);
    expect(g.kills[0]).toMatch(/p=\$\(cat "\$b\.pid"[^\n]*kill -TERM -- "-\$p" "\$p"[^\n]*kill -KILL -- "-\$p" "\$p"/);
    expect(g.cleaned()).toBe(1);
  });

  it("a poll that fails while the machine naps is retried after a pause and the run completes", async () => {
    const g = guest([{ out: "before\n" }, { nap: true }, { nap: true }, { out: "after\n", exit: 0 }]);
    const res = await execDetached(g.machine, "true", { deadlineMs: 10_000, pollMs: 1 });
    expect(res).toEqual({ exitCode: 0, stdout: "before\nafter\n", stderr: "" });
    expect(g.calls.filter(c => c.cmd.includes("echo WSP_POLL"))).toHaveLength(4);
  });

  it("a nap that outlasts the deadline still ends in 124, with the kill attempted", async () => {
    const g = guest(Array.from({ length: 200 }, () => ({ nap: true })));
    const res = await execDetached(g.machine, "true", { deadlineMs: 30, pollMs: 1 });
    expect(res.exitCode).toBe(DEADLINE_EXIT);
  });

  it("a leader gone without an exit file answers -1 and says so on stderr", async () => {
    const g = guest([{ out: "partial" }, { dead: true }]);
    const lines: string[] = [];
    const res = await execDetached(g.machine, "true", { deadlineMs: 10_000, pollMs: 1, onLine: l => lines.push(l) });
    expect(res.exitCode).toBe(-1);
    expect(res.stdout).toBe("partial");
    expect(res.stderr).toContain("ended without reporting an exit code");
    expect(lines).toEqual(["partial"]);
  });

  it("a launch that does not confirm fails the run before any poll", async () => {
    const machine = { id: "m9", exec: async () => ({ exitCode: 1, stdout: "", stderr: "bash: base64: not found" }) } as unknown as Machine;
    await expect(execDetached(machine, "true", { deadlineMs: 1_000, pollMs: 1 })).rejects.toThrow(/launch failed on m9.*base64: not found/);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** This machine's bash as the guest; setsid is perl's setpgrp where the OS has none and base64 loses -w0. */
function localGuest(): { machine: Machine; runDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-detached-"));
  dirs.push(dir);
  const shimDir = join(dir, "shims");
  mkdirSync(shimDir);
  if (!existsSync("/proc/1/stat")) {
    const shims = {
      setsid: "#!/bin/sh\nexec perl -e 'setpgrp(0, 0); exec @ARGV or die $!' -- \"$@\"\n",
      base64: '#!/bin/sh\nargs=""\nfor a in "$@"; do [ "$a" = "-w0" ] || args="$args $a"; done\nexec /usr/bin/base64 $args\n',
    };
    for (const [name, body] of Object.entries(shims)) {
      writeFileSync(join(shimDir, name), body);
      chmodSync(join(shimDir, name), 0o755);
    }
  }
  const machine = {
    id: "local",
    exec: (cmd: string) =>
      new Promise<ExecResult>(resolve => {
        execFile("bash", ["-c", cmd], { env: { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` }, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
          resolve({ exitCode: e === null ? 0 : ((e as { code?: number }).code ?? 1), stdout, stderr });
        });
      }),
  } as unknown as Machine;
  return { machine, runDir: join(dir, "run") };
}

describe("execDetached over this machine's bash", () => {
  it("runs the real launch, poll and cleanup commands: exit code, both streams, and no files left", async () => {
    const { machine, runDir } = localGuest();
    const lines: string[] = [];
    const res = await execDetached(machine, "echo one; sleep 0.3; echo two; echo warn >&2; exit 3", { deadlineMs: 20_000, pollMs: 50, onLine: l => lines.push(l) }, runDir);
    expect(res).toEqual({ exitCode: 3, stdout: "one\ntwo\n", stderr: "warn\n" });
    // A poll reads stdout then stderr, so where warn lands among the lines is timing; each stream keeps its order.
    expect(lines.filter(l => l !== "warn")).toEqual(["one", "two"]);
    expect(lines).toContain("warn");
    const left = await machine.exec(`ls ${runDir}`);
    expect(left.stdout).toBe("");
  });

  it("a launch posted twice under one base, as a retried exec does, starts the script once", async () => {
    const { machine, runDir } = localGuest();
    const marks = join(runDir, "..", "marks");
    const retrying = {
      id: "local",
      exec: async (cmd: string, o?: { timeoutMs?: number }) => {
        const first = await machine.exec(cmd, o);
        return cmd.includes("echo WSP_LAUNCHED") ? machine.exec(cmd, o) : first;
      },
    } as unknown as Machine;
    const res = await execDetached(retrying, `echo ran >> ${marks}; echo hi`, { deadlineMs: 20_000, pollMs: 50 }, runDir);
    expect(res).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
    expect(readFileSync(marks, "utf8")).toBe("ran\n");
    expect((await machine.exec(`ls ${runDir}`)).stdout).toBe("");
  });

  it("the deadline kill ends the launched session for real", async () => {
    const { machine, runDir } = localGuest();
    // The deadline counts from before the launch, so under load the kill can land before the script's first line: the launch answers once it is on disk.
    const started = () => existsSync(runDir) && readdirSync(runDir).some(f => f.endsWith(".out") && statSync(join(runDir, f)).size > 0);
    const settled = {
      id: "local",
      exec: async (cmd: string, o?: { timeoutMs?: number }) => {
        const res = await machine.exec(cmd, o);
        if (cmd.includes("echo WSP_LAUNCHED")) while (!started()) await new Promise(r => setTimeout(r, 20));
        return res;
      },
    } as unknown as Machine;
    const res = await execDetached(settled, "echo pid $$; sleep 30", { deadlineMs: 800, pollMs: 50 }, runDir);
    expect(res.exitCode).toBe(DEADLINE_EXIT);
    const pid = Number(/pid (\d+)/.exec(res.stdout)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 200));
    expect(await machine.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).toMatchObject({ stdout: "gone\n" });
    expect((await machine.exec(`ls ${runDir}`)).stdout).toBe("");
  }, 15_000);
});
