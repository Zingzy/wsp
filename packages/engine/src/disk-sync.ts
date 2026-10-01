// SPDX-License-Identifier: AGPL-3.0-only
// The guest's disk made whole before the provider copies or pauses it. The
// provider copies the block device under a running kernel, so a file written
// seconds before is on the image with its size and mtime and only the bytes
// the kernel had already written back.

import { diskSyncFailedLine } from "@wsp/protocol";
import { INLINE_EXEC_MS, machineAnswer } from "./exec-detached.js";
import type { Machine } from "./machine.js";

/** Linux's sync returns once the dirty pages are on the device; the two counters after it are what a writer still
 * running dirtied since, read for the line and never waited on. */
export const DISK_SYNC_CMD = "sync && awk '/^(Dirty|Writeback):/ {print $1, $2}' /proc/meminfo";

/** What the guest's counters read once its sync returned, in kB as /proc/meminfo counts them. */
export interface DiskReading {
  dirtyKb: number;
  writebackKb: number;
}

/** A guest whose sync did not succeed: nothing was copied, and the message is the protocol's one sentence. */
export class DiskSyncError extends Error {
  constructor(readonly answer: string) {
    super(diskSyncFailedLine(answer));
    this.name = "DiskSyncError";
  }
}

/** Syncs the guest's disk and answers what its counters read after; undefined where the guest printed none. An exec
 * that throws passes as itself, so a typed refusal keeps its class. */
export async function syncDisk(machine: Machine): Promise<DiskReading | undefined> {
  const res = await machine.exec(DISK_SYNC_CMD, { timeoutMs: INLINE_EXEC_MS });
  if (res.exitCode !== 0) throw new DiskSyncError(machineAnswer(res));
  const kb = (name: string): number | undefined => {
    const n = Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(res.stdout)?.[1]);
    return Number.isFinite(n) ? n : undefined;
  };
  const dirtyKb = kb("Dirty");
  const writebackKb = kb("Writeback");
  return dirtyKb === undefined || writebackKb === undefined ? undefined : { dirtyKb, writebackKb };
}

/** The guest's root filesystem as df counts it, in kB: what is used and what is still free to its users. */
export const DISK_USE_CMD = "df -Pk / | awk 'NR==2 {print $3, $4}'";

/** How full that reading says the disk is, in percent and unrounded, so a line drawn at a figure is crossed only past
 * it; undefined for a reading that is not two counts. */
export function diskUsePct(stdout: string): number | undefined {
  const m = /^(\d+) (\d+)$/m.exec(stdout.trim());
  if (m === null) return undefined;
  const [used, free] = [Number(m[1]), Number(m[2])];
  return used + free === 0 ? undefined : (used * 100) / (used + free);
}

/** Whether a reading left anything unwritten. */
export const diskUnsettled = (r: DiskReading | undefined): r is DiskReading => r !== undefined && (r.dirtyKb > 0 || r.writebackKb > 0);
