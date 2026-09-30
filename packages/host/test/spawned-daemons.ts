// SPDX-License-Identifier: AGPL-3.0-only
// The daemons a case started, by the process each spawn handed over, and the
// teardown that stops every one still running. A case that times out while
// its start is still waiting on the binary never gets the handle it would
// close, and the daemon that start then finishes outlives the run: fifteen
// were found on one Mac a day later, each with parent pid 1. A stop goes
// through the process itself, never its pid: a pid the daemon left can be
// another process's by then, and a process that has exited takes no signal.
import type { ChildProcess } from "node:child_process";

/** How long a daemon gets to leave on SIGTERM before SIGKILL, as LocalDaemon.close gives it. */
const STOP_MS = 5_000;

export interface SpawnedDaemons {
  /** What a case hands LocalDaemonOptions.spawned. */
  readonly record: (child: ChildProcess) => void;
  /** Stops every recorded daemon still running and forgets them all. */
  readonly stop: () => Promise<void>;
}

const running = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

/** Resolves once the process has exited, or once the wait is over; true where it exited. */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (!running(child)) return Promise.resolve(true);
  return new Promise(done => {
    const timer = setTimeout(() => done(!running(child)), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

export function spawnedDaemons(): SpawnedDaemons {
  const children = new Set<ChildProcess>();
  return {
    record: child => void children.add(child),
    stop: async () => {
      const left = [...children].filter(running);
      children.clear();
      await Promise.all(
        left.map(async child => {
          child.kill("SIGTERM");
          if (!(await exited(child, STOP_MS))) child.kill("SIGKILL");
        }),
      );
    },
  };
}
