// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnCutLine } from "@wsp/protocol";
import { endLocalRuns, localExecStream } from "../src/local-exec.js";
import { gone, grandchild, sweepStrays } from "./strays.js";

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

describe("local exec stream", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localexec-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    sweepStrays();
  });

  it("streams stdout and stderr by line and answers with the exit code", async () => {
    const factory = localExecStream({ root });
    const stream = factory("printf 'a\\nb\\n'; printf 'e\\n' 1>&2; exit 5", { env: {} });
    const [lines, code] = await Promise.all([collect(stream.lines), stream.exited]);
    expect(lines.sort()).toEqual(["a", "b", "e"]);
    expect(code).toBe(5);
  });

  it("runs in the workspace folder", async () => {
    const factory = localExecStream({ root });
    const stream = factory("pwd", { env: {} });
    const lines = await collect(stream.lines);
    expect(lines.join("")).toContain(root.replace(/^\/private/, ""));
    expect(await stream.exited).toBe(0);
  });

  it("an input channel is the child's stdin: the seed lands, write appends, closeInput ends it", async () => {
    const factory = localExecStream({ root });
    const stream = factory(`cat > ${join(root, "in.txt")}`, { env: {}, input: ["first"] });
    expect(await stream.write("second")).toBe("written");
    stream.closeInput();
    expect(await stream.exited).toBe(0);
    expect(readFileSync(join(root, "in.txt"), "utf8")).toBe("first\nsecond\n");
  });

  it("a stream started without an input channel refuses a write", async () => {
    const factory = localExecStream({ root });
    const stream = factory("true", { env: {} });
    await expect(stream.write("x")).rejects.toThrow("no input channel");
    await stream.exited;
  });

  it("a child that never writes is cut at the idle limit with the same line a cloud turn gets, and exited reads null", async () => {
    const factory = localExecStream({ root, idleMs: 120, deadlineMs: 60_000, pollMs: 10 });
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
    // readings a rate takes.
    const factory = localExecStream({ root, idleMs: 600, deadlineMs: 30_000, pollMs: 20 });
    const stream = factory(`( while :; do :; done ) & echo $! > ${marker}; sleep 1.6; echo still working; sleep 20`, { env: {} });
    const busy = await grandchild(marker);
    // The line lands more than two idle limits into a silent turn, so only the tree's work can have held the turn
    // open. A cut turn never delivers it: its own words wait on the child's streams closing, which a grandchild
    // holding the inherited pipe never lets happen.
    const first = stream.lines[Symbol.asyncIterator]().next();
    const late = new Promise<string>(resolve => setTimeout(() => resolve("nothing reached the reader"), 5_000));
    expect(await Promise.race([first, late])).toEqual({ value: "still working", done: false });
    stream.kill();
    expect(await stream.exited).not.toBe(0);
    await gone(busy);
  }, 20_000);

  it("a child that prints nothing while the tree it started sleeps is cut at the idle limit, and the cut leaves no grandchild", async () => {
    const marker = join(root, "idle.pid");
    const factory = localExecStream({ root, idleMs: 400, deadlineMs: 30_000, pollMs: 20 });
    const stream = factory(`sleep 20 & echo $! > ${marker}; sleep 20`, { env: {} });
    const sleeping = await grandchild(marker);
    const reading = collect(stream.lines).then(() => undefined, (e: unknown) => e as Error);
    // The cut takes the group, so the grandchild is gone before the cut's own words reach the reader.
    await gone(sleeping);
    expect((await reading)?.message).toMatch(/^stopped after \d+m \d\ds with no output for 0m$/);
    expect(await stream.exited).toBeNull();
  }, 20_000);

  it("a child that keeps writing past the wall is cut at the cap", async () => {
    const factory = localExecStream({ root, idleMs: 60_000, deadlineMs: 150, pollMs: 10 });
    const stream = factory("while true; do echo tick; sleep 0.02; done", { env: {} });
    await expect(collect(stream.lines)).rejects.toThrow(/at the 0m cap on one turn$/);
    expect(await stream.exited).toBeNull();
  });

  it("the defaults are the turn's own limits, so a quick command is never cut", async () => {
    const stream = localExecStream({ root })("printf ok", { env: {} });
    expect(await collect(stream.lines)).toEqual(["ok"]);
    expect(await stream.exited).toBe(0);
  });

  it("kill ends the child", async () => {
    const factory = localExecStream({ root });
    const stream = factory("sleep 10", { env: {} });
    stream.kill();
    expect(await stream.exited).not.toBe(0);
  });
});

describe("a real turn's process group", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localexec-group-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    sweepStrays();
  });

  /** The pid the command wrote for what it left running, once it has. */
  const leftRunning = (): Promise<number> => grandchild(join(root, "child"));

  it("a child the command left running is gone when the turn ends, and the stream ends although that child held its stdout", async () => {
    const factory = localExecStream({ root });
    const stream = factory(`sleep 300 & echo $! > ${join(root, "child")}; echo hi`, { env: {} });
    // Read before the assertion that hangs while the bug is there, so a red run still records what to clean up.
    const pid = await leftRunning();
    expect(await collect(stream.lines)).toEqual(["hi"]);
    expect(await stream.exited).toBe(0);
    await gone(pid);
  }, 15_000);

  it("a turn the idle limit cut takes its whole group with it, and still ends on the cut's words", async () => {
    const factory = localExecStream({ root, idleMs: 120, deadlineMs: 60_000, pollMs: 10 });
    const stream = factory(`sleep 300 & echo $! > ${join(root, "child")}; sleep 300`, { env: {} });
    const pid = await leftRunning();
    await expect(collect(stream.lines)).rejects.toThrow(/with no output for 0m$/);
    expect(await stream.exited).toBeNull();
    await gone(pid);
  }, 15_000);

  it("a host that stops ends every turn on this computer and what those turns started", async () => {
    const factory = localExecStream({ root });
    const stream = factory(`sleep 300 & echo $! > ${join(root, "child")}; sleep 300`, { env: {} });
    const pid = await leftRunning();

    await endLocalRuns(20);

    expect(await stream.exited).not.toBe(0);
    await gone(pid);
  }, 15_000);

  it("a turn that already ended is not signalled again by a host stopping", async () => {
    const factory = localExecStream({ root });
    const stream = factory("echo hi", { env: {} });
    expect(await collect(stream.lines)).toEqual(["hi"]);
    expect(await stream.exited).toBe(0);
    // Nothing is left to signal, so no group of a pid this computer has since given to something else is.
    await expect(endLocalRuns(20)).resolves.toEqual([]);
  });

  it("a turn that goes down on the stop's TERM is not killed by the pid it used to be; only one still running is", async () => {
    const factory = localExecStream({ root });
    // The first goes on the TERM and its group id is the kernel's again; the second ignores it, and its children
    // inherit that, so it is still there when the grace passes.
    const trapped = join(root, "trapped");
    const goes = factory("sleep 300", { env: {} });
    const stays = factory(`trap '' TERM; echo ready > ${trapped}; sleep 300 & wait`, { env: {} });
    await vi.waitFor(() => expect(existsSync(trapped)).toBe(true), { timeout: 5_000 });

    const killed = await endLocalRuns(400);

    expect(killed).toHaveLength(1);
    expect(await goes.exited).not.toBe(0);
    expect(await stays.exited).not.toBe(0);
  }, 15_000);

  it("teardown reaches what the turn started, not the shell alone", async () => {
    const factory = localExecStream({ root });
    const stream = factory(`sleep 300 & echo $! > ${join(root, "child")}; sleep 300`, { env: {} });
    const pid = await leftRunning();
    stream.teardown();
    expect(await stream.exited).not.toBe(0);
    await gone(pid);
  }, 15_000);
});
