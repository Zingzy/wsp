// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SysSample } from "@wsp/protocol";
import { cpuPercent, parseLoadavg, parseMeminfo, parseProcStat, SysSampler, type SysReadings } from "../src/sys.js";

// Fixture provenance: hand-written in the proc(5) /proc/stat and /proc/meminfo
// layouts. The two stat snapshots differ by 900 jiffies in total, 600 of them
// idle or iowait, so the interval is one third busy.
const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const statA = fixture("proc-stat-a.txt");
const statB = fixture("proc-stat-b.txt");

describe("proc parsing", () => {
  it("reads the aggregate cpu line: idle counts iowait, total counts the eight time columns", () => {
    expect(parseProcStat(statA)).toEqual({ idle: 8200, total: 9800 });
    expect(parseProcStat(statB)).toEqual({ idle: 8800, total: 10700 });
  });

  it("cpu percent is busy jiffies over the interval, all cores, 0 to 100", () => {
    expect(cpuPercent(parseProcStat(statA), parseProcStat(statB))).toBeCloseTo(33.333, 2);
    expect(cpuPercent({ idle: 10, total: 10 }, { idle: 10, total: 10 })).toBe(0);
    expect(cpuPercent({ idle: 0, total: 0 }, { idle: 0, total: 100 })).toBe(100);
    // A counter that wrapped or a reboot reads as no information, never a negative.
    expect(cpuPercent({ idle: 50, total: 100 }, { idle: 10, total: 20 })).toBe(0);
  });

  it("meminfo gives total and available in bytes", () => {
    expect(parseMeminfo(fixture("proc-meminfo.txt"))).toEqual({ total: 4030000 * 1024, available: 2015000 * 1024 });
  });

  it("loadavg gives the one-minute figure", () => {
    expect(parseLoadavg("0.52 0.58 0.59 1/389 12345\n")).toBe(0.52);
  });
});

const readings = (cpu: { idle: number; total: number }): SysReadings => ({
  cpu,
  load1: 0.5,
  mem: { used: 1_000, total: 4_000 },
  disk: { used: 20_000, total: 100_000 },
});

describe("SysSampler", () => {
  afterEach(() => vi.useRealTimers());

  it("emits nothing on the first poll and a sample with the cpu delta on the next", async () => {
    const seq = [readings(parseProcStat(statA)), readings(parseProcStat(statB))];
    let i = 0;
    const sampler = new SysSampler(async () => seq[Math.min(i++, seq.length - 1)]!, { intervalMs: 60_000 });
    const got: SysSample[] = [];
    sampler.on("sys.sample", (s: SysSample) => got.push(s));
    await sampler.poll();
    expect(got).toEqual([]);
    const before = Date.now();
    await sampler.poll();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "sys.sample", load1: 0.5, mem: { used: 1_000, total: 4_000 }, disk: { used: 20_000, total: 100_000 } });
    expect(got[0]!.cpu).toBeCloseTo(33.333, 2);
    expect(got[0]!.at).toBeGreaterThanOrEqual(before);
  });

  it("one sampler serves every subscriber: it runs from the first and stops with the last, and a stale unsubscribe is a no-op", async () => {
    // Fake timers: under load a real 5 ms sleep can be armed after the 10 ms tick it has to beat.
    vi.useFakeTimers();
    let reads = 0;
    const sampler = new SysSampler(
      async () => {
        reads++;
        return readings({ idle: reads * 10, total: reads * 20 });
      },
      { intervalMs: 10 },
    );
    const a: SysSample[] = [];
    const b: SysSample[] = [];
    expect(sampler.running).toBe(false);
    const unA = sampler.subscribe(s => a.push(s));
    expect(sampler.running).toBe(true);
    const unB = sampler.subscribe(s => b.push(s));
    await vi.advanceTimersByTimeAsync(80);
    expect(a.length).toBeGreaterThan(1);
    expect(b.length).toBeGreaterThan(1);
    // Two subscribers, one stream: each sample reached both.
    expect(a.slice(0, b.length)).toEqual(b.slice(0, a.length));
    unA();
    unA();
    expect(sampler.running).toBe(true);
    unB();
    expect(sampler.running).toBe(false);
    const readsAtStop = reads;
    await vi.advanceTimersByTimeAsync(40);
    expect(reads).toBe(readsAtStop);
    // A restart begins with a fresh baseline: the first sample after it is not measured against the old counters.
    const c: SysSample[] = [];
    const unC = sampler.subscribe(s => c.push(s));
    await vi.advanceTimersByTimeAsync(5);
    expect(c).toEqual([]);
    await vi.advanceTimersByTimeAsync(5);
    expect(c).toHaveLength(1);
    unC();
  });

  it("a failed read drops that tick and the next one still samples", async () => {
    let n = 0;
    const sampler = new SysSampler(
      async () => {
        n++;
        if (n === 2) throw new Error("no /proc here");
        return readings({ idle: n * 10, total: n * 20 });
      },
      { intervalMs: 60_000 },
    );
    const got: SysSample[] = [];
    sampler.on("sys.sample", (s: SysSample) => got.push(s));
    await sampler.poll();
    await sampler.poll();
    expect(got).toEqual([]);
    await sampler.poll();
    expect(got).toHaveLength(1);
    expect(got[0]!.cpu).toBeCloseTo(50, 5);
  });
});
