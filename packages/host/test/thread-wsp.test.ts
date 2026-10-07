// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localWiring, makeRuntime, servingWiring } from "../src/cli.js";
import type { RunningWsp } from "../src/mcp-install.js";
import { threadBinDir, writeThreadWsp } from "../src/shim.js";
import { writeStub } from "../../protocol/test/stub-script.js";

/** No socket on stdin: Debian's bash -c reads bashrc in place of BASH_ENV when stdin is one, taking it for rshd, and
 * node hands a child socketpairs. */
const SHELL_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

/** A shell on the PATH this suite runs under, by its full path: the Ubuntu runners have no zsh, so its cases skip
 * there and bash's prove the same order. */
const onPath = (name: string): string | undefined => (process.env["PATH"] ?? "").split(delimiter).filter(d => d !== "").map(d => join(d, name)).find(p => existsSync(p));
const ZSH = onPath("zsh");
const BASH = onPath("bash");
const SHELLS = [["zsh", ZSH], ["bash", BASH]] as const;
const present = SHELLS.flatMap(([, path]) => (path === undefined ? [] : [path]));

describe("the wsp a thread's shell runs on this computer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-thread-bin-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a script beside the state file that runs the command this host was started as, with every word the shell gave it", () => {
    const statePath = join(dir, "home", "state.json");
    const echo = join(dir, "echo argv.mjs");
    writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const at = writeThreadWsp(statePath, { command: process.execPath, args: [echo] });
    expect(at).toBe(threadBinDir(statePath));
    expect(threadBinDir(statePath)).toBe(join(dir, "home", "thread-bin"));
    expect(statSync(join(at, "wsp")).mode & 0o111).not.toBe(0);
    expect(JSON.parse(execFileSync(join(at, "wsp"), ["threads", "a 'b' c", "--json"], { encoding: "utf8" }))).toEqual(["threads", "a 'b' c", "--json"]);
    // Written again over itself, so a host restarted on another build points the folder at that build.
    writeThreadWsp(statePath, { command: process.execPath, args: [echo, "run"] });
    expect(JSON.parse(execFileSync(join(at, "wsp"), ["x"], { encoding: "utf8" }))).toEqual(["run", "x"]);
  });

  it("comes first on the PATH a turn here is launched with, ahead of any wsp the person's own PATH holds", () => {
    const statePath = join(dir, "state.json");
    const bin = threadBinDir(statePath);
    const wiring = localWiring(dir, { PATH: `/usr/bin${delimiter}/bin` }, undefined, statePath, undefined, () => {}, bin);
    expect(wiring.env()["PATH"]).toBe(`${bin}${delimiter}/usr/bin${delimiter}/bin`);
    // A wiring for a line that serves no turn leaves the PATH it was given alone.
    expect(localWiring(dir, { PATH: "/usr/bin" }, undefined, statePath, undefined, () => {}).env()["PATH"]).toBe("/usr/bin");
  });

  /** A host started as node on its script, which is the one road that needs the script written rather than found. */
  const started = (script: string): RunningWsp => ({ execPath: process.execPath, execArgv: [], argv: [process.execPath, script], version: "0.0.0", PATH: "" });

  it("a host that turns reach writes its own wsp and puts it first on their PATH; one that turns do not reach writes nothing", () => {
    const statePath = join(dir, "home", "state.json");
    const served = servingWiring(statePath, { here: {}, run: started("/opt/wsp/dist/bin.js") }, dir, { PATH: "/usr/bin" });
    expect(served.env()["PATH"]).toBe(`${threadBinDir(statePath)}${delimiter}/usr/bin`);
    expect(readFileSync(join(threadBinDir(statePath), "wsp"), "utf8")).toContain("/opt/wsp/dist/bin.js");
    const other = join(dir, "other", "state.json");
    expect(servingWiring(other, undefined, dir, { PATH: "/usr/bin" }).env()["PATH"]).toBe("/usr/bin");
    expect(existsSync(threadBinDir(other))).toBe(false);
  });

  for (const [name, shell] of SHELLS) {
    it.skipIf(shell === undefined)(`is the wsp a ${name} login shell in a turn reaches, after the person's profile has put an older one first`, () => {
      const home = join(dir, "person");
      const older = join(home, ".local", "bin");
      mkdirSync(older, { recursive: true });
      writeStub(join(older, "wsp"), "#!/bin/sh\necho older\n");
      // The profile every login shell re-reads, as Codex's /bin/zsh -lc does: it puts the older install first and
      // leaves a mark, so the person's own files are seen to run as they would.
      const profile = 'export PATH="$HOME/.local/bin:$PATH"; export PROFILE_RAN=1\n';
      for (const file of [".zprofile", ".bash_profile"]) writeFileSync(join(home, file), profile);
      writeFileSync(join(home, ".zshenv"), "export ZSHENV_RAN=1\n");
      const echo = join(dir, "thread.mjs");
      writeFileSync(echo, 'console.log("thread");\n');
      const statePath = join(dir, "home", "state.json");
      const env = servingWiring(statePath, { here: {}, run: started(echo) }, home, { PATH: "/usr/bin:/bin", HOME: home }).env();
      const run = (args: string[]): string => execFileSync(shell!, args, { env, encoding: "utf8", stdio: SHELL_STDIO }).trim();
      expect(run(["-lc", "wsp"]), `${name} -lc`).toBe("thread");
      expect(run(["-c", "wsp"]), `${name} -c`).toBe("thread");
      expect(run(["-lc", "echo $PROFILE_RAN"]), `${name} -lc read the person's profile`).toBe("1");
      // A login shell the command itself starts, inside the agent's own, of every shell this computer has.
      expect(run(["-lc", present.map(p => `${p} -lc wsp`).join("; ")]), `${name} -lc nesting`).toBe(present.map(() => "thread").join("\n"));
      if (name === "zsh") expect(run(["-lc", "echo $ZSHENV_RAN"])).toBe("1");
    });
  }

  const ownStartup = (): { env: Record<string, string>; bin: string } => {
    const own = join(dir, "zdot");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, ".zprofile"), 'export PATH="/elsewhere:$PATH"; export OWN_ZPROFILE=1\n');
    const bashEnv = join(dir, "bash env");
    writeFileSync(bashEnv, 'export PATH="/elsewhere:$PATH"; export OWN_BASH_ENV=1\n');
    const statePath = join(dir, "home", "state.json");
    const env = servingWiring(statePath, { here: {}, run: started(join(dir, "none.mjs")) }, dir, { PATH: "/usr/bin:/bin", HOME: dir, ZDOTDIR: own, BASH_ENV: bashEnv }).env();
    return { env, bin: threadBinDir(statePath) };
  };

  // The front of PATH only: the computer's own /etc profile may rebuild the rest.
  it.skipIf(ZSH === undefined)("runs the person's own ZDOTDIR where the launch carried one, and still comes first after it", () => {
    const { env, bin } = ownStartup();
    expect(execFileSync(ZSH!, ["-lc", 'echo "$OWN_ZPROFILE $PATH"'], { env, encoding: "utf8", stdio: SHELL_STDIO }).trim()).toMatch(`1 ${bin}:/elsewhere:`);
  });

  it.skipIf(BASH === undefined)("runs the person's own BASH_ENV where the launch carried one, and still comes first after it", () => {
    const { env, bin } = ownStartup();
    expect(execFileSync(BASH!, ["-c", 'echo "$OWN_BASH_ENV $PATH"'], { env, encoding: "utf8", stdio: SHELL_STDIO }).trim()).toMatch(`1 ${bin}:/elsewhere:`);
  });

  it("is what a runtime built to serve turns wires, with no wiring handed in", async () => {
    const statePath = join(dir, "served", "state.json");
    const rt = makeRuntime({}, statePath, undefined, {}, { here: {}, run: started("/opt/wsp/dist/bin.js") });
    try {
      expect(readFileSync(join(threadBinDir(statePath), "wsp"), "utf8")).toContain("/opt/wsp/dist/bin.js");
    } finally {
      await rt.close();
    }
  });
});
