// SPDX-License-Identifier: AGPL-3.0-only
// A command whose own child holds its output open: an installer wrapper whose
// download runs on under it. The run ends at its deadline with that child gone,
// and a command that exits on time answers then, whatever it left behind.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHILD_TIMED_OUT, runChild } from "../src/child-exec.js";
import { writeStub } from "../../protocol/test/stub-script.js";

let dir: string;

/** The sleep a case started, by the pid it wrote down, killed whether the case passed or not. */
afterEach(() => {
  const pidFile = join(dir, "sleep.pid");
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
    } catch {
      // Already gone, which is what the first case wants.
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const running = (pid: number): boolean => spawnSync("ps", ["-p", String(pid)]).status === 0;

/** A command that starts `child` in the background holding its stdout, writes that child's pid where the case and
 * the cleanup read it, says started, then runs `then`. */
function command(child: string, then: string): { at: string; pid: () => number } {
  dir = mkdtempSync(join(tmpdir(), "wsp-child-"));
  const pidFile = join(dir, "sleep.pid");
  const at = writeStub(join(dir, "holder"), `#!/bin/sh\n${child} &\necho $! > ${JSON.stringify(pidFile)}\necho started\n${then}\n`);
  return {
    at,
    pid: () => Number(readFileSync(pidFile, "utf8").trim()),
  };
}

/** A child that writes a line every 50 ms for 20 s, from one process: a loop that spawns a sleep per line goes quiet
 * on a loaded computer. */
const WRITER = `perl -e '$| = 1; for (1 .. 400) { print "tick\\n"; select(undef, undef, undef, 0.05) }'`;

/** A command that starts a sleep holding its stdout, then waits on it or exits. */
const holder = (wait: boolean): { at: string; pid: () => number } => command("sleep 30", wait ? "wait" : "exit 0");

describe("runChild", () => {
  it("returns at its deadline with the command's own children gone, the output so far kept", async () => {
    const { at, pid } = holder(true);
    const result = await runChild(at, [], { timeoutMs: 500 });
    expect(result.exitCode).toBe(CHILD_TIMED_OUT);
    expect(result.stdout).toBe("started\n");
    const sleep = pid();
    await new Promise(r => setTimeout(r, 200));
    expect(running(sleep), `sleep ${sleep} still runs`).toBe(false);
  }, 15_000);

  it("answers when the command exits, though a child it left behind still holds its output", async () => {
    const { at, pid } = holder(false);
    const result = await runChild(at, []);
    expect(result).toMatchObject({ exitCode: 0, stdout: "started\n" });
    expect(running(pid())).toBe(true);
  }, 15_000);

  it("answers a command that exited 0 before its deadline with 0, though what it left behind outlives the deadline", async () => {
    const { at } = command(WRITER, "exit 0");
    const result = await runChild(at, [], { timeoutMs: 2_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("started\n");
  }, 30_000);

  it("answers a command whose child keeps writing to its output within a second of the command's exit", async () => {
    const { at } = command(WRITER, "exit 0");
    const result = await runChild(at, []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("started\n");
    // The writer prints 400 ticks over 20 s; an answer that waited for it to end holds them all.
    expect(result.stdout.match(/^tick$/gm)?.length ?? 0, "the answer waited for the writer to end").toBeLessThan(400);
  }, 30_000);
});
