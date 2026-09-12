// SPDX-License-Identifier: AGPL-3.0-only
// The machine's utilisation as sys.sample events. The sampler holds the clock
// and the subscribers; what one kind's machine is read with is its own module
// behind SysSource, registered in readings.ts. The module here is the guest's:
// cpu from two /proc/stat readings, load from /proc/loadavg, memory from
// /proc/meminfo, disk from statfs on the workspace root. One sampler per
// daemon; the first subscriber starts it and the last one leaving stops it.
import { EventEmitter } from "node:events";
import { readFile, statfs } from "node:fs/promises";
import { SYS_SAMPLER_STARTED, SYS_SAMPLER_STOPPED, type SysSample } from "@wsp/protocol";

/** Jiffies from the aggregate cpu line: idle includes iowait, total the eight time columns (guest time is already inside user and nice). */
export interface CpuTimes {
  idle: number;
  total: number;
}

export function parseProcStat(text: string): CpuTimes {
  const line = text.split("\n").find(l => /^cpu\s/.test(l));
  if (!line) throw new Error("/proc/stat has no cpu line");
  const cols = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (cols.length < 4 || cols.some(n => !Number.isFinite(n))) throw new Error("/proc/stat cpu line is malformed");
  const idle = (cols[3] ?? 0) + (cols[4] ?? 0);
  return { idle, total: cols.reduce((a, b) => a + b, 0) };
}

/** Busy share of the interval between two readings, 0 to 100; no interval, or counters that went backwards, read as 0. */
export function cpuPercent(prev: CpuTimes, next: CpuTimes): number {
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, ((total - idle) / total) * 100));
}

export function parseMeminfo(text: string): { total: number; available: number } {
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(text);
    if (!m) throw new Error(`/proc/meminfo has no ${key}`);
    return Number(m[1]) * 1024;
  };
  return { total: kb("MemTotal"), available: kb("MemAvailable") };
}

export function parseLoadavg(text: string): number {
  const n = Number(text.trim().split(/\s+/)[0]);
  if (!Number.isFinite(n)) throw new Error("/proc/loadavg is malformed");
  return n;
}

export interface SysReadings {
  cpu: CpuTimes;
  load1: number;
  mem: { used: number; total: number };
  disk: { used: number; total: number };
}

export type SysSource = () => Promise<SysReadings>;

/** The guest's own readings, from /proc and a statfs: the module every machine wsp forks is served by. Never called
 * in tests; darwin feeds fixtures instead. */
export function procSysSource(root: string, procRoot = "/proc"): SysSource {
  return async () => {
    const [stat, meminfo, loadavg, fs] = await Promise.all([
      readFile(`${procRoot}/stat`, "utf8"),
      readFile(`${procRoot}/meminfo`, "utf8"),
      readFile(`${procRoot}/loadavg`, "utf8"),
      statfs(root),
    ]);
    const mem = parseMeminfo(meminfo);
    return {
      cpu: parseProcStat(stat),
      load1: parseLoadavg(loadavg),
      mem: { used: mem.total - mem.available, total: mem.total },
      disk: { used: (fs.blocks - fs.bfree) * fs.bsize, total: fs.blocks * fs.bsize },
    };
  };
}

export class SysSampler extends EventEmitter {
  private source: SysSource;
  private intervalMs: number;
  private log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private prev: CpuTimes | undefined;
  private subscribers = 0;
  /** What the last poll said, so a watch that arrives mid-stream inherits it; undefined until one has finished. */
  private last: { error?: unknown } | undefined;

  constructor(source: SysSource, opts: { intervalMs?: number; log?: (line: string) => void } = {}) {
    super();
    this.source = source;
    this.intervalMs = opts.intervalMs ?? 2000;
    this.log = opts.log ?? (() => {});
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Starts sampling with the first subscriber; the returned function detaches once, and the last detach stops it. */
  subscribe(fn: (s: SysSample) => void): () => void {
    this.on("sys.sample", fn);
    this.subscribers++;
    if (this.subscribers === 1) this.start();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.off("sys.sample", fn);
      this.subscribers--;
      if (this.subscribers === 0) this.stop();
    };
  }

  /** One read before a watch is taken, so a module that cannot read this machine refuses the op instead of leaving
   * the pane at pending for a stream that never comes. Its reading is thrown away: cpu is a delta, so the first
   * sample still lands one interval after the reply. A sampler already polling reads the machine every interval
   * anyway, so a second watcher inherits what the last poll said rather than paying for a read of its own; that way
   * a machine that stopped answering refuses the new watch too, instead of leaving it at pending. */
  async probe(): Promise<void> {
    const last = this.last;
    if (this.timer !== null && last !== undefined) {
      if (last.error !== undefined) throw last.error;
      return;
    }
    await this.source();
  }

  /** The first poll after a start is the cpu baseline and emits nothing; a failed read is skipped and the baseline kept. */
  async poll(): Promise<void> {
    let r: SysReadings;
    try {
      r = await this.source();
    } catch (e) {
      this.last = { error: e };
      return;
    }
    this.last = {};
    const prev = this.prev;
    this.prev = r.cpu;
    if (prev === undefined) return;
    const sample: SysSample = { type: "sys.sample", cpu: cpuPercent(prev, r.cpu), load1: r.load1, mem: r.mem, disk: r.disk, at: Date.now() };
    this.emit("sys.sample", sample);
  }

  start(): void {
    if (this.timer) return;
    this.prev = undefined;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
    this.log(SYS_SAMPLER_STARTED);
    void this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.log(SYS_SAMPLER_STOPPED);
    }
    this.timer = null;
    this.prev = undefined;
    this.last = undefined;
  }
}
