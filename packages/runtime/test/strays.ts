// SPDX-License-Identifier: AGPL-3.0-only
// The grandchildren a local turn's tests leave behind. Every one of them is a
// pid the command under test wrote to a file of its own, never a pid found by
// name or port, and the sweep runs after each test so a red run leaves nothing
// burning a core on this computer.
import { existsSync, readFileSync } from "node:fs";
import { expect, vi } from "vitest";

const strays: number[] = [];

/** The pid a command wrote to `file` once it is there, recorded for the sweep. */
export async function grandchild(file: string): Promise<number> {
  await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 5_000 });
  const pid = Number(readFileSync(file, "utf8").trim());
  expect(pid).toBeGreaterThan(0);
  strays.push(pid);
  return pid;
}

export function sweepStrays(): void {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
}
