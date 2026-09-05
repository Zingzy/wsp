// SPDX-License-Identifier: AGPL-3.0-only
import type { ChildProcess } from "node:child_process";

// Vite's SIGTERM handler waits on a dependency prebundle it cancelled, so a
// plain kill can leave the server alive at ppid 1; only the recorded handle
// is ever signalled.
export async function stopVite(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(done => child.once("exit", () => done()));
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await exited;
  clearTimeout(timer);
}
