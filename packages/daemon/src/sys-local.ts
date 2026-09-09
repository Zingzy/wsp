// SPDX-License-Identifier: AGPL-3.0-only
// This computer's own utilisation, the metrics module of the local kind: cpu
// and load from node's os module, disk from one df on the folder turns write
// in, memory from the road the platform answers honestly on. os and df read
// the same on macOS and on Linux, so this kind reads one way wherever the
// person is; memory is the exception and has a road per platform below.
import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { promisify } from "node:util";
import { cLocale } from "./host-command.js";
import type { SysReadings, SysSource } from "./sys.js";

const run = promisify(execFile);

/** df's numbers are in 1024-byte blocks under -k. */
const BLOCK = 1024;

/** The three counts and the capacity df -kP prints for one filesystem: blocks, used, available, then a percentage.
 * Read from the percentage backwards, since a device name or a mount point may hold spaces and the numbers may not. */
export function parseDf(text: string): { used: number; total: number } {
  const m = /(\d+)\s+(\d+)\s+(\d+)\s+\d+%/.exec(text);
  if (m === null) throw new Error("df printed no filesystem line");
  return { used: Number(m[2]) * BLOCK, total: Number(m[1]) * BLOCK };
}

/** Busy and idle time across every core as os.cpus reports it, in milliseconds: the same two counters /proc/stat's
 * jiffies give, so one cpuPercent rule serves both kinds. */
export function cpuTimesOf(cores: ReturnType<typeof cpus>): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const core of cores) {
    idle += core.times.idle;
    total += core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq;
  }
  return { idle, total };
}

/** What a Mac can hand out without taking it from something running, out of vm_stat: pages that are free, pages
 * read ahead on speculation, and the inactive list, which the kernel reclaims without asking. Purgeable pages are
 * already counted inside those lists and are not added again. This is the reading MemAvailable is on Linux; the
 * kernel's free count alone reads a Mac at rest as nearly full, because it holds everything else for reuse. */
export function availableFromVmStat(text: string): number {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 0);
  if (!(pageSize > 0)) throw new Error("vm_stat printed no page size");
  const pages = (label: string): number => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m").exec(text);
    if (m === null) throw new Error(`vm_stat printed no ${label} pages`);
    return Number(m[1]);
  };
  return (pages("free") + pages("speculative") + pages("inactive")) * pageSize;
}

export type MemorySource = () => Promise<{ used: number; total: number }>;

/** Memory the way the platform answers it honestly. On Linux node reads MemAvailable, which is the whole question;
 * on darwin it reads free pages only, so vm_stat is asked instead. A platform with no road here falls back to the
 * os module, which is a reading rather than nothing. Adding a platform is a row here and its source. */
const MEMORY_SOURCES: Partial<Record<NodeJS.Platform, MemorySource>> = {
  darwin: async () => {
    const total = totalmem();
    const { stdout } = await run("vm_stat", [], cLocale());
    return { used: Math.max(0, total - availableFromVmStat(stdout)), total };
  },
};

export function memorySourceFor(host: NodeJS.Platform): MemorySource {
  return (
    MEMORY_SOURCES[host] ??
    (async () => {
      const total = totalmem();
      return { used: total - freemem(), total };
    })
  );
}

/** This computer as its own workspace reads it. The disk is the volume the work folder is on, which is where turns
 * write; the person's home may be another. */
export function hostSysSource(workFolder: string, host: NodeJS.Platform = platform()): SysSource {
  const memory = memorySourceFor(host);
  return async (): Promise<SysReadings> => {
    const [df, mem] = await Promise.all([run("df", ["-kP", workFolder], cLocale()), memory()]);
    return {
      cpu: cpuTimesOf(cpus()),
      load1: loadavg()[0] ?? 0,
      mem,
      disk: parseDf(df.stdout),
    };
  };
}
