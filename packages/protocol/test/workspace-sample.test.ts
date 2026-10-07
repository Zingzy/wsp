// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { workspaceSample, type MachineReading } from "../src/index.js";

const MIB = 1024 * 1024;

const reading = (cpuUsageUsec: number | undefined, more: Partial<MachineReading> = {}): MachineReading => ({
  state: "running",
  cpu: 2,
  memMb: 1024,
  memBytes: 256 * MIB,
  ...(cpuUsageUsec === undefined ? {} : { cpuUsageUsec }),
  cgroup: "/sys/fs/cgroup/wsp/k1",
  upper: "/wsp/run/k1/upper",
  disk: { used: 40 * MIB, total: 100 * MIB },
  ...more,
});

describe("a workspace's Workspace tab sample off two readings of its cgroup", () => {
  it("reads memory against its cap, the disk its upper sits on, cpu against its cores and load as the cores it kept busy", () => {
    // 3 s of processor time over 2 s of wall time: one and a half cores busy, three quarters of the two it was given.
    expect(workspaceSample({ at: 10_000, reading: reading(1_000_000) }, { at: 12_000, reading: reading(4_000_000) })).toEqual({
      type: "sys.sample",
      cpu: 75,
      load1: 1.5,
      mem: { used: 256 * MIB, total: 1024 * MIB },
      disk: { used: 40 * MIB, total: 100 * MIB },
      at: 12_000,
    });
  });

  it("has nothing where a rate has nothing to run from or a figure is missing", () => {
    const now = { at: 12_000, reading: reading(4_000_000) };
    expect(workspaceSample(undefined, now)).toBeUndefined();
    expect(workspaceSample({ at: 12_000, reading: reading(1_000_000) }, now)).toBeUndefined();
    // A wake starts the cgroup's counter again, so a reading below the last one is no rate.
    expect(workspaceSample({ at: 10_000, reading: reading(9_000_000) }, now)).toBeUndefined();
    expect(workspaceSample({ at: 10_000, reading: reading(1_000_000) }, { at: 12_000, reading: { state: "paused", cgroup: "/c", upper: "/u" } })).toBeUndefined();
    const { disk: _disk, ...noDisk } = reading(4_000_000);
    expect(workspaceSample({ at: 10_000, reading: reading(1_000_000) }, { at: 12_000, reading: noDisk })).toBeUndefined();
  });

  it("reads a workspace whose cores are not named as one core", () => {
    const { cpu: _cpu, ...one } = reading(3_000_000);
    expect(workspaceSample({ at: 10_000, reading: reading(1_000_000) }, { at: 12_000, reading: one })?.cpu).toBe(100);
  });
});
