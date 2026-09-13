// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnCutLine, type ExecStream } from "@wsp/protocol";
import { localExecStream } from "../src/local-exec.js";
import { alive, gone, grandchild, sweepStrays } from "./strays.js";

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
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

  it("a child that prints nothing while the tree it started burns a core is not cut at the idle limit", async () => {
    const marker = join(root, "busy.pid");
    // The tree is read once the stream has been quiet for half the limit, so the limit leaves room for the pair of
    // readings a rate takes. Linux's ps prints whole seconds of CPU where this Mac's prints hundredths, so the pair
    // only differs once the tree has burned a whole second: the limit is long enough for that on either computer.
    const factory = localExecStream({ root, runDir, idleMs: 4_000, deadlineMs: 30_000, pollMs: 100 });
    const stream = factory(`( while :; do :; done ) & echo $! > ${marker}; sleep 8.5; echo still working; sleep 20`, { env: {} });
    const busy = await grandchild(marker);
    // The line lands more than two idle limits into a silent turn, so only the tree's work can have held the turn
    // open. A cut turn never delivers it: its own words wait on the child's streams closing, which a grandchild
    // holding the inherited pipe never lets happen.
    const first = stream.lines[Symbol.asyncIterator]().next();
    const late = new Promise<string>(resolve => setTimeout(() => resolve("nothing reached the reader"), 12_000));
    expect(await Promise.race([first, late])).toEqual({ value: "still working", done: false });
    stream.kill();
    expect(await stream.exited).not.toBe(0);
    await gone(busy);
  }, 20_000);

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
    const stream = factory("while true; do echo tick; sleep 0.02; done", { env: {} });
    await expect(collect(stream.lines)).rejects.toThrow(/at the 0m cap on one turn$/);
    expect(await stream.exited).toBeNull();
  });

  it("the defaults are the turn's own limits, so a quick command is never cut", async () => {
    const stream = localExecStream({ root, runDir })("printf ok", { env: {} });
    expect(await collect(stream.lines)).toEqual(["ok"]);
    expect(await stream.exited).toBe(0);
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
    // The script carries the whole launch environment as export lines; the input channel carries what a person
    // sends into the turn; the log carries everything the agent prints.
    for (const suffix of ["sh", "in", "log", "fifo"]) expect([suffix, modeOf(`${base}.${suffix}`)]).toEqual([suffix, "600"]);

    // The key really is in there, and no file holding anything of the person's is open to another login: the run's
    // own bookkeeping (a pid, a tail's pid, an exit code) is written by the shell at its own umask, and the folder
    // at 700 is what keeps that out of anyone else's reach.
    expect(readFileSync(`${base}.sh`, "utf8")).toContain("sk-ant-x-not-a-key");
    const carries = new Set(["sh", "in", "log", "fifo"]);
    const readable = readdirSync(runDir).filter(name => carries.has(name.split(".").at(-1)!) && (statSync(join(runDir, name)).mode & 0o077) !== 0);
    expect(readable).toEqual([]);

    stream.kill();
    await stream.exited;
    await gone(child);
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

describe("a real turn's process group", () => {
  let root: string;
  let runDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localexec-group-"));
    runDir = join(root, "runs");
  });
  afterEach(() => {
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
    const launched = factory(`echo first; while [ ! -f ${gate} ]; do sleep 0.05; done; echo second; sleep 30`, { env: {} });
    const run = launched.run!;
    expect(run.startsWith(`${runDir}/`)).toBe(true);
    // The run has printed its first line to the log on disk before anything attaches to it.
    expect(await launched.lines[Symbol.asyncIterator]().next()).toEqual({ value: "first", done: false });

    // A second factory, standing for the host that comes next: it never launched this run and re-opens it by handle.
    const next = localExecStream({ root, runDir });
    const attached = await next.attach!(run, { input: false });
    expect(attached).not.toBe("gone");
    const reader = (attached as ExecStream).lines[Symbol.asyncIterator]();
    // The line printed before this reader existed reaches it, which is what reading the log from byte zero is for.
    expect(await reader.next()).toEqual({ value: "first", done: false });
    writeFileSync(gate, "go\n");
    expect(await reader.next()).toEqual({ value: "second", done: false });
    launched.kill();
    await launched.exited;
  }, 20_000);

  it("an attach answers gone for a run this computer no longer holds, and refuses a handle it could not have minted", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory("echo hi", { env: {} });
    const run = stream.run!;
    expect(await collect(stream.lines)).toEqual(["hi"]);
    expect(await stream.exited).toBe(0);
    // The reap took the claim with the rest of the run when the stream ended.
    expect(await factory.attach!(run, { input: false })).toBe("gone");
    await expect(factory.attach!(join(runDir, "../elsewhere"), { input: false })).rejects.toThrow("not a run this host could have launched");
    await expect(factory.attach!(join(runDir, "not-a-run-id"), { input: false })).rejects.toThrow("not a run this host could have launched");
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
    expect(await factory.attach!(swept.run!, { input: false })).toBe("gone");
    expect(await factory.attach!(kept.run!, { input: false })).not.toBe("gone");
    kept.kill();
    await kept.exited;
    await gone(keptPid);
  }, 20_000);

  it("teardown reaches what the turn started, not the shell alone", async () => {
    const factory = localExecStream({ root, runDir });
    const stream = factory(`sleep 300 & echo $! > ${join(root, "child")}; sleep 300`, { env: {} });
    const pid = await leftRunning();
    stream.teardown();
    expect(await stream.exited).not.toBe(0);
    await gone(pid);
  }, 15_000);
});
