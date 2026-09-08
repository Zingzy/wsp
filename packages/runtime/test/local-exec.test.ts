// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnCutLine } from "@wsp/protocol";
import { localExecStream } from "../src/local-exec.js";

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

/** The pid of a grandchild a test recorded from the child's own file: the tests assert these are gone, and killing
 * them here keeps a red run from leaving a core burning on this computer. */
const strays: number[] = [];

/** The pid a command wrote to `file` once it is there, recorded for the sweep. */
async function grandchild(file: string): Promise<number> {
  await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 5_000 });
  const pid = Number(readFileSync(file, "utf8").trim());
  expect(pid).toBeGreaterThan(0);
  strays.push(pid);
  return pid;
}

describe("local exec stream", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localexec-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        continue;
      }
    }
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
    const factory = localExecStream({ root, idleMs: 400, deadlineMs: 30_000, pollMs: 20 });
    const stream = factory(`( while :; do :; done ) & echo $! > ${marker}; sleep 1.6; echo still working; sleep 20`, { env: {} });
    const busy = await grandchild(marker);
    // The line lands four idle limits into a silent turn, so only the tree's work can have held the turn open.
    const first = stream.lines[Symbol.asyncIterator]().next();
    expect(await first).toEqual({ value: "still working", done: false });
    stream.kill();
    expect(await stream.exited).not.toBe(0);
    await vi.waitFor(() => expect(() => process.kill(busy, 0)).toThrow(), { timeout: 5_000 });
  }, 20_000);

  it("a child that prints nothing while the tree it started sleeps is cut at the idle limit, and the cut leaves no grandchild", async () => {
    const marker = join(root, "idle.pid");
    const factory = localExecStream({ root, idleMs: 400, deadlineMs: 30_000, pollMs: 20 });
    const stream = factory(`sleep 20 & echo $! > ${marker}; sleep 20`, { env: {} });
    const sleeping = await grandchild(marker);
    await expect(collect(stream.lines)).rejects.toThrow(/^stopped after \d+m \d\ds with no output for 0m$/);
    expect(await stream.exited).toBeNull();
    await vi.waitFor(() => expect(() => process.kill(sleeping, 0)).toThrow(), { timeout: 5_000 });
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
