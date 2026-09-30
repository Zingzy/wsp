// SPDX-License-Identifier: AGPL-3.0-only
// The teardown every case that starts a daemon runs: it stops a process still
// running and signals none that has gone, whatever its pid names by then.
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { spawnedDaemons } from "./spawned-daemons.js";

const gone = (child: ChildProcess): Promise<void> => new Promise(done => (child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done())));

describe("the daemons a case recorded", () => {
  it("stops one still running through its own process", async () => {
    const daemons = spawnedDaemons();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    daemons.record(child);
    await daemons.stop();
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("signals none that has already exited, so a pid another process took since is never touched", async () => {
    const daemons = spawnedDaemons();
    const child = spawn("true", [], { stdio: "ignore" });
    await gone(child);
    const kill = vi.spyOn(child, "kill");
    const signal = vi.spyOn(process, "kill");
    daemons.record(child);
    await daemons.stop();
    expect(kill).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    signal.mockRestore();
  });
});
