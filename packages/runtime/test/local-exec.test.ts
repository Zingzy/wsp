// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXEC_CHUNK_BYTES, endRun, shellQuote, turnCutLine, type ExecStream } from "@wsp/protocol";
import { gateLoop } from "../../protocol/test/stub-script.js";
import { groupExists, localExecStream, ownOrphans, type GroupWorkReader } from "../src/local-exec.js";
import { LINUX_SHELL_PRELUDE } from "./linux-shell.js";
import { alive, gone, grandchild, sweepStrays } from "./strays.js";

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

/** A tree burning one core, counted on the clock the idle rule compares its readings against. A real burner is no
 * use here: ps answers whole seconds of CPU on Linux, so a tree given a fraction of a loaded box shows nothing at
 * all until a whole second of its own has passed, and no idle limit is long enough to outrun that ratio. */
function burningTree(now: () => number): GroupWorkReader {
  const from = now();
  return (_pgid, then) => then(Math.floor((now() - from) / 10));
}

describe("local exec stream", () => {
  let root: string;
  let runDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localexec-"));
    runDir = join(root, "runs");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    sweepStrays();
  });

  it("streams stdout and stderr by line and answers with the exit code", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory("printf 'a\\nb\\n'; printf 'e\\n' 1>&2; exit 5", { env: {} });
    const [lines, code] = await Promise.all([collect(stream.lines), stream.exited]);
    expect(lines.sort()).toEqual(["a", "b", "e"]);
    expect(code).toBe(5);
  });

  it("names the process it leads, which is the group every process of the turn is in", async () => {
    const factory = localExecStream({ root, runDir });
    // The shell prints its own pid and its group; both are the leader's, and the pid the stream reports is that one.
    const stream = factory("echo $$; ps -o pgid= -p $$", { env: {} });
    const [lines] = await Promise.all([collect(stream.lines), stream.exited]);
    expect(stream.pid).toBe(Number(lines[0]));
    expect(Number(lines[1]!.trim())).toBe(stream.pid);
  });

  it("runs in the workspace folder", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory("pwd", { env: {} });
    const lines = await collect(stream.lines);
    expect(lines.join("")).toContain(root.replace(/^\/private/, ""));
    expect(await stream.exited).toBe(0);
  });

  it("an input channel is the child's stdin: the seed lands, write appends, closeInput ends it", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory(`cat > ${join(root, "in.txt")}`, { env: {}, input: ["first"] });
    expect(await stream.write("second")).toBe("written");
    stream.closeInput();
    expect(await stream.exited).toBe(0);
    expect(readFileSync(join(root, "in.txt"), "utf8")).toBe("first\nsecond\n");
  });

  it("closeInput reaches a node child as the end of its stdin, so a harness exits on its own after its reply", async () => {
    const factory = localExecStream({ root, runDir, pollMs: 10 });
    const reader = `process.stdin.resume(); process.stdin.on("end", () => process.exit(7))`;
    const stream = factory(`${shellQuote(process.execPath)} -e ${shellQuote(reader)}`, { env: {}, input: ["first"] });
    stream.closeInput();
    const code = await Promise.race([stream.exited, new Promise(resolve => setTimeout(() => resolve("still reading"), 5_000))]);
    if (code === "still reading") stream.kill();
    expect(code).toBe(7);
  }, 15_000);

  it("a stream started without an input channel refuses a write", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory("true", { env: {} });
    await expect(stream.write("x")).rejects.toThrow("no input channel");
    await stream.exited;
  });

  it("a child that never writes is cut at the idle limit with the same line a cloud turn gets, and exited reads null", async () => {
    const factory = localExecStream({ root, runDir, idleMs: 120, deadlineMs: 60_000, pollMs: 10 });
    const stream = factory("sleep 30", { env: {} });
    const started = Date.now();
    await expect(collect(stream.lines)).rejects.toThrow(/^stopped after \d+m \d\ds with no output for 0m$/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await stream.exited).toBeNull();
    expect(turnCutLine("idle", 130, 120)).toMatch(/with no output for 0m$/);
  });

  it("reads an exit file that exists and is empty as a run still writing, and answers the code that lands in it", async () => {
    // A group of this test's own, standing for the shell that is between the truncate of its exit file and the
    // write of the code; its pid is one this test started and wrote down, never one found by name.
    const shell = spawn("bash", ["-c", "sleep 300"], { detached: true, stdio: "ignore" });
    shell.unref();
    const pid = shell.pid!;
    expect(pid).toBeGreaterThan(0);
    try {
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const base = join(runDir, "bbbbbbbbbbbb");
      mkdirSync(`${base}.d`, { mode: 0o700 });
      writeFileSync(`${base}.pid`, `${pid}\n`);
      writeFileSync(`${base}.log`, "");
      writeFileSync(`${base}.exit`, "");
      const attached = await localExecStream({ root, runDir, pollMs: 10 }).attach!(base, { input: false, startedAt: Date.now() });
      expect(attached).not.toBe("gone");
      const stream = attached as ExecStream;
      // Longer than the reap's 200 ms group poll, so a poll that settled on the empty file would be seen here.
      const waited = new Promise<string>(resolve => setTimeout(() => resolve("still writing"), 500));
      expect(await Promise.race([stream.exited, waited])).toBe("still writing");
      writeFileSync(`${base}.exit`, "7\n");
      expect(await stream.exited).toBe(7);
    } finally {
      // The reap the settle runs takes the group where the run settled; a red run leaves it to this.
      if (alive(pid)) process.kill(-pid, "SIGKILL");
      await gone(pid);
    }
  }, 15_000);

  it("a child that prints nothing while the tree it started burns a core is not cut at the idle limit", async () => {
    const factory = localExecStream({ root, runDir, idleMs: 400, deadlineMs: 30_000, pollMs: 20, readWork: burningTree(Date.now) });
    const stream = factory("sleep 2; echo still working; sleep 20", { env: {} });
    // The line lands five idle limits into a silent turn, so only the tree's work can have held the turn open.
    const first = stream.lines[Symbol.asyncIterator]().next();
    const late = new Promise<string>(resolve => setTimeout(() => resolve("the turn printed nothing and was not cut"), 10_000));
    expect(await Promise.race([first, late])).toEqual({ value: "still working", done: false });
    stream.kill();
    expect(await stream.exited).not.toBe(0);
  }, 15_000);

  it("a child that prints nothing while the tree it started sleeps is cut at the idle limit, and the cut leaves no grandchild", async () => {
    const marker = join(root, "idle.pid");
    const factory = localExecStream({ root, runDir, idleMs: 400, deadlineMs: 30_000, pollMs: 20 });
    const stream = factory(`sleep 20 & echo $! > ${marker}; sleep 20`, { env: {} });
    const sleeping = await grandchild(marker);
    const reading = collect(stream.lines).then(() => undefined, (e: unknown) => e as Error);
    // The cut takes the group, so the grandchild is gone before the cut's own words reach the reader.
    await gone(sleeping);
    expect((await reading)?.message).toMatch(/^stopped after \d+m \d\ds with no output for 0m$/);
    expect(await stream.exited).toBeNull();
  }, 20_000);

  it("a child stopped on a question only a person can answer is not cut at the idle limit", async () => {
    let waiting = true;
    const factory = localExecStream({ root, runDir, idleMs: 120, deadlineMs: 60_000, pollMs: 10 }, () => waiting);
    const stream = factory("sleep 1.2; echo answered; sleep 20", { env: {} });
    const first = stream.lines[Symbol.asyncIterator]().next();
    const late = new Promise<string>(resolve => setTimeout(() => resolve("the turn was cut while it waited"), 4_000));
    // The silence runs many idle limits long; only the question held the turn open.
    expect(await Promise.race([first, late])).toEqual({ value: "answered", done: false });
    waiting = false;
    await expect(collect(stream.lines)).rejects.toThrow(/with no output for 0m$/);
    expect(await stream.exited).toBeNull();
  }, 10_000);

  it("a child that keeps writing past the wall is cut at the cap", async () => {
    const factory = localExecStream({ root, runDir, idleMs: 60_000, deadlineMs: 150, pollMs: 10 });
    const stream = factory(gateLoop(join(root, "stop"), { each: "echo tick" }), { env: {} });
    await expect(collect(stream.lines)).rejects.toThrow(/at the 0m turn limit; send to continue where it stopped, or change the limit in Settings > Computers$/);
    expect(await stream.exited).toBeNull();
  });

  it("a turn re-opened after a restart is cut at its first start plus the wall, not at the re-open plus the wall", async () => {
    const WALL_MS = 3_000;
    const reading = new Set<() => void>();
    const startedAt = Date.now();
    const launched = localExecStream({ root, runDir, idleMs: 60_000, deadlineMs: WALL_MS, pollMs: 20, reading })(gateLoop(join(root, "stop"), { each: "echo tick" }), { env: {} });
    await new Promise(resolve => setTimeout(resolve, WALL_MS / 2));
    // The host goes: its reader lets go of the run, which keeps running, and the next host re-opens it by handle.
    for (const drop of [...reading]) drop();
    const attachedAt = Date.now();
    const attached = (await localExecStream({ root, runDir, idleMs: 60_000, deadlineMs: WALL_MS, pollMs: 20 }).attach!(launched.run!, { input: false, startedAt })) as ExecStream;
    await expect(collect(attached.lines)).rejects.toThrow(/turn limit; send to continue where it stopped, or change the limit in Settings > Computers$/);
    // Half the wall was left when it was re-opened, and that half is all it got.
    expect(Date.now() - attachedAt).toBeLessThan(WALL_MS * 0.9);
    expect(await attached.exited).toBeNull();
  }, 15_000);

  it("a run that finished while no host read it keeps its reply when it is re-opened past its wall", async () => {
    const WALL_MS = 1_000;
    const reading = new Set<() => void>();
    const startedAt = Date.now();
    const launched = localExecStream({ root, runDir, idleMs: 60_000, deadlineMs: WALL_MS, pollMs: 20, reading })("sleep 0.3; echo the-reply", { env: {} });
    for (const drop of [...reading]) drop();
    await new Promise(resolve => setTimeout(resolve, WALL_MS * 1.2));
    const attached = (await localExecStream({ root, runDir, idleMs: 60_000, deadlineMs: WALL_MS, pollMs: 20 }).attach!(launched.run!, { input: false, startedAt })) as ExecStream;
    expect(await collect(attached.lines)).toEqual(["the-reply"]);
    expect(await attached.exited).toBe(0);
  }, 15_000);

  it("a run still going when it is re-opened past its wall hands over what it printed before the cut", async () => {
    const WALL_MS = 1_000;
    const reading = new Set<() => void>();
    const startedAt = Date.now();
    const launched = localExecStream({ root, runDir, idleMs: 60_000, deadlineMs: WALL_MS, pollMs: 20, reading })("echo while-away; sleep 30", { env: {} });
    for (const drop of [...reading]) drop();
    await new Promise(resolve => setTimeout(resolve, WALL_MS * 1.2));
    const attached = (await localExecStream({ root, runDir, idleMs: 60_000, deadlineMs: WALL_MS, pollMs: 20 }).attach!(launched.run!, { input: false, startedAt })) as ExecStream;
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const line of attached.lines) seen.push(line);
      })(),
    ).rejects.toThrow(/turn limit; send to continue where it stopped, or change the limit in Settings > Computers$/);
    expect(seen).toEqual(["while-away"]);
    expect(await attached.exited).toBeNull();
  }, 15_000);

  it("the defaults are the turn's own limits, so a quick command is never cut", async () => {
    const stream = localExecStream({ root, runDir })("printf ok", { env: {} });
    expect(await collect(stream.lines)).toEqual(["ok"]);
    expect(await stream.exited).toBe(0);
  });

  it("a run that ignores TERM keeps what it printed after the last poll, past one chunk of it, once the KILL ends it", async () => {
    // A poll slower than the grace, so no read falls between the TERM and the KILL: the lines are read at the end or never.
    const stream = localExecStream({ root, runDir, pollMs: 1_500 })(`trap 'head -c ${EXEC_CHUNK_BYTES + 1000} /dev/zero | tr "\\0" x; echo; echo last words' TERM; echo ready; ${gateLoop(join(root, "stop"))}`, { env: {} });
    const lines = stream.lines[Symbol.asyncIterator]();
    expect(await lines.next()).toEqual({ value: "ready", done: false });
    await new Promise(resolve => setTimeout(resolve, 100));
    await endRun(stream, 300);
    const rest = await collect({ [Symbol.asyncIterator]: () => lines });
    expect(rest).toContain("x".repeat(EXEC_CHUNK_BYTES + 1000));
    expect(rest.at(-1)).toBe("last words");
  });

  it("kill ends the child", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory("sleep 10", { env: {} });
    stream.kill();
    expect(await stream.exited).not.toBe(0);
  });
});

describe("what a run leaves on this computer", () => {
  let root: string;
  let runDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localexec-files-"));
    runDir = join(root, "runs");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    sweepStrays();
  });

  const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);

  it("every file a turn's launch writes is owner-only from its first byte, and so is the folder they sit in", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory(`sleep 300 & echo $! > ${join(root, "child")}; sleep 300`, { env: { ANTHROPIC_API_KEY: "sk-ant-x-not-a-key" }, input: ["hello"] });
    const child = await grandchild(join(root, "child"));
    const base = stream.run!;

    expect(modeOf(runDir)).toBe("700");
    expect(modeOf(`${base}.d`)).toBe("700");
    // The script carries the command; the input channel carries what a person sends into the turn; the log carries
    // everything the agent prints.
    for (const suffix of ["sh", "in", "log"]) expect([suffix, modeOf(`${base}.${suffix}`)]).toEqual([suffix, "600"]);

    // No file holding anything of the person's is open to another login: the run's own bookkeeping (a pid, a tail's
    // pid, an exit code) is written by the shell at its own umask, and the folder at 700 is what keeps that out of
    // anyone else's reach.
    const carries = new Set(["sh", "in", "log"]);
    const readable = readdirSync(runDir).filter(name => carries.has(name.split(".").at(-1)!) && (statSync(join(runDir, name)).mode & 0o077) !== 0);
    expect(readable).toEqual([]);

    stream.kill();
    await stream.exited;
    await gone(child);
  }, 20_000);

  /** Every file under the run folder that holds `value`, read whole. */
  const holding = (value: string): string[] =>
    readdirSync(runDir, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => join(e.parentPath, e.name))
      .filter(path => readFileSync(path, "utf8").includes(value));

  it("a turn and an exec launched with a key reach it in their environment, and no file under the run folder holds it", async () => {
    const key = `sk-ant-x-${randomBytes(8).toString("hex")}`;
    const gate = join(root, "gate");
    const factory = localExecStream({ root, runDir, pollMs: 10 });
    const seen = 'case "$ANTHROPIC_API_KEY" in sk-ant-x-*) echo "seen ${#ANTHROPIC_API_KEY}";; esac';
    // A turn as an agent's launch makes one, its prompt on an input channel; an exec as the exec verb makes one.
    const turn = factory(`${seen}; read -r line; echo "got $line"`, { env: { ANTHROPIC_API_KEY: key }, input: ["hello"], inputAfter: new Promise(() => {}) });
    const exec = factory(`${seen}; ${gateLoop(gate)}`, { env: { ANTHROPIC_API_KEY: key } });
    try {
      const turnLines = turn.lines[Symbol.asyncIterator]();
      const execLines = exec.lines[Symbol.asyncIterator]();
      expect(await turnLines.next()).toEqual({ value: `seen ${key.length}`, done: false });
      expect(await execLines.next()).toEqual({ value: `seen ${key.length}`, done: false });

      // Both are running, each held on its own gate, with every file of theirs on disk.
      expect(holding(key)).toEqual([]);

      writeFileSync(gate, "");
      expect(await execLines.next()).toEqual({ value: undefined, done: true });
      turn.kill();
      expect([await exec.exited, await turn.exited]).toEqual([0, null]);
      expect(readdirSync(runDir)).toEqual([]);
    } finally {
      turn.kill();
      exec.kill();
      await Promise.all([turn.exited, exec.exited]);
    }
  }, 20_000);

  it("a script an older host wrote with the key in it is gone once its run ends, read or swept", async () => {
    const key = `sk-ant-x-${randomBytes(8).toString("hex")}`;
    const gate = join(root, "gate");
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    /** A run as a host before this one launched it: the environment as export lines at the top of its script. */
    const started: number[] = [];
    const older = (id: string, command: string): string => {
      const base = join(runDir, id);
      mkdirSync(`${base}.d`, { mode: 0o700 });
      writeFileSync(`${base}.sh`, `export ANTHROPIC_API_KEY=${shellQuote(key)}\n( ${command}\n)\necho $? > ${shellQuote(`${base}.exit`)}\n`, { mode: 0o600 });
      writeFileSync(`${base}.log`, "", { mode: 0o600 });
      const log = openSync(`${base}.log`, "a");
      const child = spawn("bash", [`${base}.sh`], { cwd: root, stdio: ["ignore", log, log], detached: true });
      child.unref();
      closeSync(log);
      started.push(child.pid!);
      writeFileSync(`${base}.pid`, `${child.pid}\n`);
      return base;
    };
    try {
      const read = older("aaaaaaaaaaaa", `${gateLoop(gate)}; echo done`);
      const ended = older("bbbbbbbbbbbb", "echo done");
      await vi.waitFor(() => expect(readFileSync(`${ended}.exit`, "utf8").trim()).toBe("0"), { timeout: 5_000 });
      expect(holding(key).sort()).toEqual([`${read}.sh`, `${ended}.sh`]);

      // The host that comes next re-opens the run its rows hold and sweeps the one they do not.
      const next = localExecStream({ root, runDir, pollMs: 10 });
      const attached = (await next.attach!(read, { input: false, startedAt: Date.now() })) as ExecStream;
      expect(await next.sweep!([read])).toEqual([ended]);
      writeFileSync(gate, "");
      expect(await Promise.all([collect(attached.lines), attached.exited])).toEqual([["done"], 0]);
      expect(readdirSync(runDir)).toEqual([]);
    } finally {
      for (const pid of started) if (groupExists(pid)) process.kill(-pid, "SIGKILL");
    }
  }, 20_000);

  it("a run whose recorded pid leads somebody else's group is cleaned up and never signalled", async () => {
    // A process group of this test's own, standing for whatever this computer handed that pid to after the run
    // that recorded it was gone. Its pid is one this test started and wrote down, never one found by name.
    const stranger = spawn("bash", ["-c", "sleep 300"], { detached: true, stdio: "ignore" });
    stranger.unref();
    const strangerPid = stranger.pid!;
    expect(strangerPid).toBeGreaterThan(0);
    try {
      // A claim from long before that process started, with its pid written into the run's pid file.
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const base = join(runDir, "aaaaaaaaaaaa");
      mkdirSync(`${base}.d`, { mode: 0o700 });
      writeFileSync(`${base}.pid`, `${strangerPid}\n`);
      const old = new Date(Date.now() - 600_000);
      utimesSync(`${base}.d`, old, old);

      const swept = await localExecStream({ root, runDir }).sweep!([]);

      expect(swept).toEqual([base]);
      // The files are gone, so nothing attaches to it again; the process group is not.
      expect(readdirSync(runDir)).toEqual([]);
      expect(alive(strangerPid)).toBe(true);
    } finally {
      process.kill(-strangerPid, "SIGKILL");
      await vi.waitFor(() => expect(alive(strangerPid)).toBe(false), { timeout: 5_000 });
    }
  }, 20_000);
});

describe("the processes a run starts with", () => {
  it("are read once the subshell that backgrounded the input pump has gone, so the pump is never a turn's leftover", async () => {
    // The script (100) runs the agent (101), which forked the pump's launcher (102) before it was exec'd; the
    // launcher starts tail (103) and the read loop (104) and exits. On a loaded computer it can still stand when the
    // agent first prints.
    const launcherUp = [{ pid: 100, ppid: 9 }, { pid: 101, ppid: 100 }, { pid: 102, ppid: 101 }, { pid: 103, ppid: 102 }, { pid: 104, ppid: 102 }];
    const launcherGone = [{ pid: 100, ppid: 9 }, { pid: 101, ppid: 100 }, { pid: 103, ppid: 1 }, { pid: 104, ppid: 1 }];
    const reads = [launcherUp, launcherUp, launcherGone];
    expect([...(await ownOrphans(async () => reads.shift() ?? launcherGone, 100))].sort()).toEqual([103, 104]);
  });
});

describe("a real turn's process group", () => {
  let root: string;
  let runDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localexec-group-"));
    runDir = join(root, "runs");
  });
  /** Runs a case waits on for an end it may never reach when it fails: killed after it, so a red run leaves no child. */
  const ending: ExecStream[] = [];
  const ended = <T extends ExecStream>(stream: T): T => (ending.push(stream), stream);
  afterEach(() => {
    for (const stream of ending.splice(0)) stream.kill();
    rmSync(root, { recursive: true, force: true });
    sweepStrays();
  });

  /** The pid the command wrote for what it left running, once it has. */
  const leftRunning = (): Promise<number> => grandchild(join(root, "child"));

  it("a child the command left running is gone when the turn ends, and the stream ends although that child held its stdout", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory(`sleep 300 & echo $! > ${join(root, "child")}; echo hi`, { env: {} });
    // Read before the assertion that hangs while the bug is there, so a red run still records what to clean up.
    const pid = await leftRunning();
    expect(await collect(stream.lines)).toEqual(["hi"]);
    expect(await stream.exited).toBe(0);
    await gone(pid);
  }, 15_000);

  it("a turn the idle limit cut takes its whole group with it, and still ends on the cut's words", async () => {
    const factory = localExecStream({ root, runDir, idleMs: 120, deadlineMs: 60_000, pollMs: 10 });
    const stream = factory(`sleep 300 & echo $! > ${join(root, "child")}; sleep 300`, { env: {} });
    const pid = await leftRunning();
    await expect(collect(stream.lines)).rejects.toThrow(/with no output for 0m$/);
    expect(await stream.exited).toBeNull();
    await gone(pid);
  }, 15_000);

  it("a factory that never launched a run attaches to it by handle and reads its whole log from the first byte", async () => {
    const gate = join(root, "gate");
    const factory = localExecStream({ root, runDir });
    const launched = factory(`echo first; ${gateLoop(gate)}; echo second; sleep 30`, { env: {} });
    const run = launched.run!;
    expect(run.startsWith(`${runDir}/`)).toBe(true);
    // The run has printed its first line to the log on disk before anything attaches to it.
    expect(await launched.lines[Symbol.asyncIterator]().next()).toEqual({ value: "first", done: false });

    // A second factory, standing for the host that comes next: it never launched this run and re-opens it by handle.
    const next = localExecStream({ root, runDir });
    const attached = await next.attach!(run, { input: false, startedAt: Date.now() });
    expect(attached).not.toBe("gone");
    const reader = (attached as ExecStream).lines[Symbol.asyncIterator]();
    // The line printed before this reader existed reaches it, which is what reading the log from byte zero is for.
    expect(await reader.next()).toEqual({ value: "first", done: false });
    writeFileSync(gate, "go\n");
    expect(await reader.next()).toEqual({ value: "second", done: false });
    launched.kill();
    await launched.exited;
  }, 20_000);

  it("an attach to a run whose input channel was never written ends it and answers gone, and one with a message attaches", async () => {
    const reading = new Set<() => void>();
    const factory = localExecStream({ root, runDir, reading });
    const unprompted = factory(`sleep 300 & echo $! > ${join(root, "child")}; cat > /dev/null`, { env: {}, input: [] });
    const pid = await grandchild(join(root, "child"));
    const prompted = factory("cat > /dev/null", { env: {}, input: ["hello"] });
    // The host that launched them goes: a reader of its own still polling would reap the run under the attach.
    for (const stop of [...reading]) stop();
    const next = localExecStream({ root, runDir, pollMs: 500 });
    expect(await next.attach!(unprompted.run!, { input: true, startedAt: Date.now() })).toBe("gone");
    await gone(pid);
    expect(existsSync(`${unprompted.run!}.d`)).toBe(false);
    const attached = await next.attach!(prompted.run!, { input: true, startedAt: Date.now() });
    expect(attached).not.toBe("gone");
    (attached as ExecStream).closeInput();
    expect(await (attached as ExecStream).exited).toBe(0);
  }, 20_000);

  it("a held seed reaches the child only once it is due, and once", async () => {
    let due: () => void = () => {};
    const inputAfter = new Promise<void>(resolve => (due = resolve));
    const factory = localExecStream({ root, runDir });
    const stream = ended(factory("cat", { env: {}, input: ["hello"], inputAfter }));
    const reader = stream.lines[Symbol.asyncIterator]();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(readFileSync(`${stream.run!}.in`, "utf8")).toBe("");
    due();
    expect(await reader.next()).toEqual({ value: "hello", done: false });
    stream.closeInput();
    expect(await stream.exited).toBe(0);
  }, 20_000);

  it("a line written or an end asked for before a held seed is due goes after the seed, and the seed is never lost", async () => {
    const factory = localExecStream({ root, runDir });
    const written = ended(factory("cat", { env: {}, input: ["first"], inputAfter: new Promise(() => {}) }));
    expect(await written.write("second")).toBe("written");
    written.closeInput();
    const closed = ended(factory("cat", { env: {}, input: ["first"], inputAfter: new Promise(() => {}) }));
    closed.closeInput();
    for (const [stream, lines] of [[written, ["first", "second"]], [closed, ["first"]]] as const) {
      expect(await Promise.all([collect(stream.lines), stream.exited])).toEqual([lines, 0]);
    }
  }, 20_000);

  it("a line held after the seed reaches the child once it is due and once, and one whose time never comes is dropped", async () => {
    const factory = localExecStream({ root, runDir });
    let due: () => void = () => {};
    const kept = ended(factory("cat", { env: {}, input: ["seed"] }));
    kept.writeAfter!("late", new Promise<void>(resolve => (due = resolve)));
    const dropped = ended(factory("cat", { env: {}, input: ["seed"] }));
    dropped.writeAfter!("late", Promise.reject(new Error("stopped")));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(readFileSync(`${kept.run!}.in`, "utf8")).toBe("seed\n");
    due();
    await vi.waitUntil(() => readFileSync(`${kept.run!}.in`, "utf8") === "seed\nlate\n", { timeout: 5_000 });
    expect(existsSync(`${dropped.run!}.late`)).toBe(false);
    kept.closeInput();
    dropped.closeInput();
    expect(await Promise.all([collect(kept.lines), collect(dropped.lines)])).toEqual([["seed", "late"], ["seed"]]);
  }, 20_000);

  it("an attach hands over a late line held beside the run, and one the channel already took goes in no second time", async () => {
    const reading = new Set<() => void>();
    const factory = localExecStream({ root, runDir, reading });
    const held = ended(factory("cat", { env: {}, input: ["seed"] }));
    held.writeAfter!("late", new Promise(() => {}));
    const reached = ended(factory("cat", { env: {}, input: ["seed"] }));
    reached.writeAfter!("late", Promise.resolve());
    await vi.waitUntil(() => readFileSync(`${reached.run!}.in`, "utf8") === "seed\nlate\n", { timeout: 5_000 });
    // A host that went between handing the line over and dropping it: the line is in the channel and still held.
    writeFileSync(`${reached.run!}.late`, "late\n");
    for (const stop of [...reading]) stop();
    const next = localExecStream({ root, runDir, pollMs: 50 });
    for (const run of [held.run!, reached.run!]) {
      const attached = (await next.attach!(run, { input: true, startedAt: Date.now() })) as ExecStream;
      expect(attached.taken).toEqual(["seed", "late"]);
      ended(attached).closeInput();
      expect(await Promise.all([collect(attached.lines), attached.exited])).toEqual([["seed", "late"], 0]);
    }
  }, 20_000);

  it("a held seed whose time never comes kills the run, and the child never reads it", async () => {
    const stream = ended(localExecStream({ root, runDir })(`cat > ${join(root, "read")}`, { env: {}, input: ["hello"], inputAfter: Promise.reject(new Error("no snapshot")) }));
    expect(await stream.exited).toBe(null);
    expect(existsSync(`${stream.run!}.d`)).toBe(false);
    expect(existsSync(join(root, "read")) ? readFileSync(join(root, "read"), "utf8") : "").toBe("");
  }, 20_000);

  it("an attach to a run whose held seed never came due hands the seed over, and one whose seed already reached it writes it no second time", async () => {
    const reading = new Set<() => void>();
    const factory = localExecStream({ root, runDir, reading });
    const held = ended(factory("cat", { env: {}, input: ["hello"], inputAfter: new Promise(() => {}) }));
    const reached = ended(factory("cat", { env: {}, input: ["hello"], inputAfter: Promise.resolve() }));
    await vi.waitUntil(() => readFileSync(`${reached.run!}.in`, "utf8") !== "", { timeout: 5_000 });
    // A host that went between handing the seed over and dropping it: the seed is in the channel and still held.
    writeFileSync(`${reached.run!}.held`, "hello\n");
    for (const stop of [...reading]) stop();
    expect(readFileSync(`${held.run!}.in`, "utf8")).toBe("");
    const next = localExecStream({ root, runDir, pollMs: 50 });
    for (const run of [held.run!, reached.run!]) {
      const attached = await next.attach!(run, { input: true, startedAt: Date.now() });
      expect(attached).not.toBe("gone");
      ended(attached as ExecStream).closeInput();
      const [lines, code] = await Promise.all([collect((attached as ExecStream).lines), (attached as ExecStream).exited]);
      expect({ lines, code }).toEqual({ lines: ["hello"], code: 0 });
    }
  }, 20_000);

  it("an attach reading a long log from the first byte lets the loop turn between its chunks", async () => {
    // A host re-opening a turn reads its whole log, and read in one go 200 MB held the loop 3.7 s (measured
    // 2026-09-28), which is a host answering nothing to every window and every line at a terminal.
    const bytes = 200_000_000;
    const factory = localExecStream({ root, runDir });
    const launched = factory(`head -c ${bytes} /dev/zero | tr '\\0' x | fold -w 999; sleep 30`, { env: {} });
    const run = launched.run!;
    await vi.waitUntil(() => existsSync(`${run}.log`) && statSync(`${run}.log`).size > bytes, { timeout: 60_000, interval: 50 });
    const next = localExecStream({ root, runDir });
    const attached = (await next.attach!(run, { input: false, startedAt: Date.now() })) as ExecStream;
    let last = performance.now();
    let held = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      held = Math.max(held, now - last);
      last = now;
    }, 10);
    let read = 0;
    for await (const _ of attached.lines) if (++read === 200_000) break;
    held = Math.max(held, performance.now() - last);
    clearInterval(tick);
    expect(read).toBe(200_000);
    expect(held).toBeLessThan(500);
    launched.kill();
    await launched.exited;
  }, 90_000);

  it("a stop that lands while an attach replays a long log lets the loop turn between the chunks of its last read", async () => {
    const bytes = 200_000_000;
    const reading = new Set<() => void>();
    const launched = localExecStream({ root, runDir, reading })(`head -c ${bytes} /dev/zero | tr '\\0' x | fold -w 999; sleep 30`, { env: {} });
    for (const drop of [...reading]) drop();
    const run = launched.run!;
    // The whole log, fold's newlines included: the kill ends the writer, so a log still growing is read short.
    const whole = bytes + Math.floor(bytes / 999);
    await vi.waitUntil(() => existsSync(`${run}.log`) && statSync(`${run}.log`).size === whole, { timeout: 60_000, interval: 50 });
    const attached = (await localExecStream({ root, runDir }).attach!(run, { input: false, startedAt: Date.now() })) as ExecStream;
    // The poll has read its first chunk; the other 199 MB are the stop's to read.
    attached.kill();
    // Lines handed over between two turns of the loop: a counter rather than a clock, so a loaded computer moves nothing.
    let sinceTurn = 0;
    let mostInOneTurn = 0;
    let turning = true;
    const turn = (): void => {
      sinceTurn = 0;
      if (turning) setImmediate(turn);
    };
    setImmediate(turn);
    let read = 0;
    for await (const line of attached.lines) {
      if (line.startsWith("x")) read++;
      mostInOneTurn = Math.max(mostInOneTurn, ++sinceTurn);
    }
    turning = false;
    expect(read).toBe(Math.ceil(bytes / 999));
    // A chunk's lines and what the turn before it left: a read that held the loop hands over every line in one turn.
    expect(mostInOneTurn).toBeLessThanOrEqual(Math.ceil((3 * EXEC_CHUNK_BYTES) / 1000));
    expect(await attached.exited).toBeNull();
  }, 90_000);

  it("a character split across two chunks of the log comes back whole", async () => {
    const reading = new Set<() => void>();
    const launched = localExecStream({ root, runDir, reading })(`head -c ${EXEC_CHUNK_BYTES - 1} /dev/zero | tr '\\0' x; printf '\\303\\251\\n'`, { env: {} });
    for (const drop of [...reading]) drop();
    const run = launched.run!;
    // Read from its first byte once it is whole, so the first chunk ends inside the é.
    await vi.waitUntil(() => existsSync(`${run}.exit`) && readFileSync(`${run}.exit`, "utf8").trim() === "0", { timeout: 10_000, interval: 20 });
    const attached = (await localExecStream({ root, runDir }).attach!(run, { input: false, startedAt: Date.now() })) as ExecStream;
    const lines = await collect(attached.lines);
    expect(lines).toEqual([`${"x".repeat(EXEC_CHUNK_BYTES - 1)}é`]);
  }, 15_000);

  it("a stop reads the log to the size it had at the KILL and ends, while a writer outside the group goes on printing", async () => {
    const marker = join(root, "writer");
    const stream = localExecStream({ root, runDir })(
      `${LINUX_SHELL_PRELUDE}setsid sh -c 'end=$(($(date +%s) + 60)); while [ $(date +%s) -lt $end ]; do head -c 65536 /dev/zero | tr "\\0" y; echo; sleep 0.03; done' & echo $! > ${shellQuote(marker)}; echo ready; sleep 30`,
      { env: {} },
    );
    let writer: number | undefined;
    try {
      const reading = collect(stream.lines);
      await vi.waitFor(() => expect(readFileSync(marker, "utf8").trim()).not.toBe(""), { timeout: 5_000 });
      writer = Number(readFileSync(marker, "utf8").trim());
      await new Promise(resolve => setTimeout(resolve, 1_000));
      stream.kill();
      await reading;
      await stream.exited;
      // The stop ended while the writer still prints: a read to the end of the log ends only once the writer does.
      expect(groupExists(writer)).toBe(true);
    } finally {
      if (writer !== undefined && groupExists(writer)) process.kill(-writer, "SIGKILL");
    }
  }, 30_000);

  it("an attach answers gone for a run this computer no longer holds, and refuses a handle it could not have minted", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory("echo hi", { env: {} });
    const run = stream.run!;
    expect(await collect(stream.lines)).toEqual(["hi"]);
    expect(await stream.exited).toBe(0);
    // The reap took the claim with the rest of the run when the stream ended.
    expect(await factory.attach!(run, { input: false, startedAt: Date.now() })).toBe("gone");
    await expect(factory.attach!(join(runDir, "../elsewhere"), { input: false, startedAt: Date.now() })).rejects.toThrow("not a run this host could have launched");
    await expect(factory.attach!(join(runDir, "not-a-run-id"), { input: false, startedAt: Date.now() })).rejects.toThrow("not a run this host could have launched");
  }, 15_000);

  it("the sweep ends every run this computer holds that the caller did not name, and leaves the named one running", async () => {
    const factory = localExecStream({ root, runDir });
    const kept = factory(`sleep 300 & echo $! > ${join(root, "child")}; sleep 300`, { env: {} });
    const keptPid = await leftRunning();
    const swept = factory(`sleep 300 & echo $! > ${join(root, "orphan")}; sleep 300`, { env: {} });
    const sweptPid = await grandchild(join(root, "orphan"));

    const ended = await factory.sweep!([kept.run!]);

    expect(ended).toEqual([swept.run!]);
    await gone(sweptPid);
    expect(alive(keptPid)).toBe(true);
    // The run that was named is still there to attach to; the one the sweep took is gone.
    expect(await factory.attach!(swept.run!, { input: false, startedAt: Date.now() })).toBe("gone");
    expect(await factory.attach!(kept.run!, { input: false, startedAt: Date.now() })).not.toBe("gone");
    kept.kill();
    await kept.exited;
    await gone(keptPid);
  }, 20_000);

  it("lets go of a run it is reading when the wiring that made it closes: the poll stops, the turn goes on and nothing about it is written", async () => {
    const gate = join(root, "gate");
    const reading = new Set<() => void>();
    const factory = localExecStream({ root, runDir, reading });
    const launched = factory(`sleep 300 & echo $! > ${join(root, "child")}; echo first; ${gateLoop(gate)}; echo second; sleep 300`, { env: {} });
    const pid = await leftRunning();
    const reader = launched.lines[Symbol.asyncIterator]();
    expect(await reader.next()).toEqual({ value: "first", done: false });
    // The one run this factory is reading, as the call that lets go of it.
    expect(reading.size).toBe(1);

    for (const stop of [...reading]) stop();
    expect(reading.size).toBe(0);

    writeFileSync(gate, "go\n");
    const quiet = <T>(work: Promise<T>): Promise<T | "quiet"> => Promise.race([work, new Promise<"quiet">(resolve => setTimeout(() => resolve("quiet"), 500))]);
    // The line landed in the log on disk and reaches nobody here: this process stopped reading, and the timer that
    // read it is what would have held the loop open after the last line of whatever asked.
    expect(await quiet(reader.next())).toBe("quiet");
    expect(readFileSync(`${launched.run!}.log`, "utf8")).toContain("second");
    // The stream never settles and the run is left exactly as it stands: ending it here would write the turn off
    // for the process that owns it.
    expect(await quiet(launched.exited)).toBe("quiet");
    expect(existsSync(`${launched.run!}.exit`)).toBe(false);
    expect(existsSync(`${launched.run!}.d`)).toBe(true);
    expect(alive(pid)).toBe(true);

    launched.kill();
    await gone(pid);
  }, 20_000);

  it("a run that ended on its own is no longer one to let go of", async () => {
    const reading = new Set<() => void>();
    const factory = localExecStream({ root, runDir, reading });
    const stream = factory("echo hi", { env: {} });
    expect(await collect(stream.lines)).toEqual(["hi"]);
    expect(await stream.exited).toBe(0);
    expect(reading.size).toBe(0);
  }, 15_000);

  it("teardown reaches what the turn started, not the shell alone", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory(`sleep 300 & echo $! > ${join(root, "child")}; sleep 300`, { env: {} });
    const pid = await leftRunning();
    stream.teardown();
    expect(await stream.exited).not.toBe(0);
    await gone(pid);
  }, 15_000);
});
