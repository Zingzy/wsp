// SPDX-License-Identifier: AGPL-3.0-only
// The guest's utilisation as sys.sample events: cpu from two /proc/stat
// readings, load from /proc/loadavg, memory from /proc/meminfo, disk from
// statfs on the workspace root. One sampler per daemon; the first subscriber
// starts it and the last one leaving stops it.
import { EventEmitter } from "node:events";
import { readFile, statfs } from "node:fs/promises";
import type { SysSample } from "@wsp/protocol";

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

/** Linux-only default source. Never called in tests; darwin feeds fixtures instead. */
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
  private timer: NodeJS.Timeout | null = null;
  private prev: CpuTimes | undefined;
  private subscribers = 0;

  constructor(source: SysSource, opts: { intervalMs?: number } = {}) {
    super();
    this.source = source;
    this.intervalMs = opts.intervalMs ?? 2000;
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

  /** The first poll after a start is the cpu baseline and emits nothing; a failed read is skipped and the baseline kept. */
  async poll(): Promise<void> {
    let r: SysReadings;
    try {
      r = await this.source();
    } catch {
      return;
    }
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
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.prev = undefined;
  }
}
