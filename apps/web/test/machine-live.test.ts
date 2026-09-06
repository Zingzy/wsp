// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { SysSample } from "@wsp/protocol";
import { bytesOfLabel, diskTier, percentLabel } from "../src/components/machine/format.js";
import { getLive, LIVE_WINDOW, resetLive } from "../src/machine/live.js";

const sample = (i: number): SysSample => ({ type: "sys.sample", cpu: i, load1: 0.5, mem: { used: i, total: 100 }, disk: { used: i, total: 100 }, at: 1_000 + i });

describe("disk tier", () => {
  it("turns at 50, 65 and 75 percent of the disk, on the number only", () => {
    expect(diskTier(0)).toBe("plain");
    expect(diskTier(49.99)).toBe("plain");
    expect(diskTier(50)).toBe("yellow");
    expect(diskTier(64.99)).toBe("yellow");
    expect(diskTier(65)).toBe("orange");
    expect(diskTier(74.99)).toBe("orange");
    expect(diskTier(75)).toBe("red");
    expect(diskTier(100)).toBe("red");
  });
});

describe("live labels", () => {
  it("percent is a whole number with its sign", () => {
    expect(percentLabel(33.333)).toBe("33%");
    expect(percentLabel(0.4)).toBe("0%");
    expect(percentLabel(100)).toBe("100%");
  });

  it("used of total shares one unit chosen by the total", () => {
    const GiB = 1024 ** 3;
    expect(bytesOfLabel(3.14 * GiB, 7.75 * GiB)).toBe("3.1 of 7.8 GB");
    expect(bytesOfLabel(12.4 * GiB, 40 * GiB)).toBe("12.4 of 40.0 GB");
    expect(bytesOfLabel(200 * 1024 ** 2, 900 * 1024 ** 2)).toBe("200 of 900 MB");
  });
});

describe("WorkspaceLive", () => {
  it("keeps the last sixty samples and reports the link's reach", () => {
    resetLive();
    const live = getLive("ws_a");
    expect(live.snapshot()).toEqual({ samples: [], reach: "unreachable", unavailable: null });
    const before = live.snapshot();
    for (let i = 0; i < LIVE_WINDOW + 10; i++) live.feedSample(sample(i));
    const after = live.snapshot();
    expect(after).not.toBe(before);
    expect(after.samples).toHaveLength(LIVE_WINDOW);
    expect(after.samples[0]!.cpu).toBe(10);
    expect(after.samples[LIVE_WINDOW - 1]!.cpu).toBe(LIVE_WINDOW + 9);
    // The same snapshot object until something changes, so React can compare by identity.
    expect(live.snapshot()).toBe(after);
    live.feedStatus("live");
    expect(live.snapshot().reach).toBe("live");
    expect(live.snapshot().samples).toBe(after.samples);
    live.feedStatus("connecting");
    expect(live.snapshot().reach).toBe("unreachable");
    // A dropped link keeps the values it had: the rows show them dim under the word.
    expect(live.snapshot().samples).toHaveLength(LIVE_WINDOW);
  });

  it("keeps the daemon's refusal of the stream until the next answer clears it, one notification per change", () => {
    resetLive();
    const live = getLive("ws_c");
    let n = 0;
    live.onChange(() => n++);
    live.feedStatus("live");
    live.feedUnavailable("unknown op: sys.watch");
    expect(live.snapshot()).toEqual({ samples: [], reach: "live", unavailable: "unknown op: sys.watch" });
    const same = live.snapshot();
    live.feedUnavailable("unknown op: sys.watch");
    expect(live.snapshot()).toBe(same);
    // The link dropping keeps the reason; a redeployed daemon that answers the watch is what clears it.
    live.feedStatus("connecting");
    expect(live.snapshot().unavailable).toBe("unknown op: sys.watch");
    live.feedStatus("live");
    live.feedUnavailable(null);
    expect(live.snapshot()).toEqual({ samples: [], reach: "live", unavailable: null });
    expect(n).toBe(5);
  });

  it("notifies on every change and stops after unsubscribe", () => {
    resetLive();
    const live = getLive("ws_b");
    let n = 0;
    const off = live.onChange(() => n++);
    live.feedSample(sample(1));
    live.feedStatus("live");
    live.feedStatus("live");
    expect(n).toBe(2);
    off();
    live.feedSample(sample(2));
    expect(n).toBe(2);
  });
});
