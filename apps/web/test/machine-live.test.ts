// SPDX-License-Identifier: AGPL-3.0-only
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { kindWords, type SysSample } from "@wsp/protocol";
import { percentLabel, reachLabel } from "../src/components/machine/format.js";
import { getLive, LIVE_WINDOW, outOfMemoryReading, resetLive, useOutOfMemoryReading, useOutOfMemoryReadings } from "../src/machine/live.js";

const sample = (i: number): SysSample => ({ type: "sys.sample", cpu: i, load1: 0.5, mem: { used: i, total: 100 }, disk: { used: i, total: 100 }, at: 1_000 + i });

describe("the Reach row's word", () => {
  it("keeps the state word on every kind whose machines carry a daemon, and says what the machine is where none does", () => {
    // Every kind carries one today, each put there its own way, so a daemon missing is a fact about that machine
    // and the row says the state. The other branch reads the same table and is what the next kind without one gets.
    for (const kind of ["cloud", "local", "ssh"] as const) {
      expect(kindWords(kind).daemon).toBe(true);
      expect(reachLabel("unsupported", kind)).toBe("unsupported");
      expect(reachLabel("reachable", kind)).toBe("reachable");
      expect(reachLabel("no-daemon", kind)).toBe("no daemon");
    }
  });
});

describe("live labels", () => {
  it("percent is a whole number with its sign", () => {
    expect(percentLabel(33.333)).toBe("33%");
    expect(percentLabel(0.4)).toBe("0%");
    expect(percentLabel(100)).toBe("100%");
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

describe("out of memory reading", () => {
  const GiB = 1024 ** 3;
  const reading = (used: number, total: number, load1: number): SysSample => ({ type: "sys.sample", cpu: 99, load1, mem: { used, total }, disk: { used: 1, total: 10 }, at: 1 });

  it("a stream that read memory near full, then a dropped link, gives the last figures; room, a live link or no sample give nothing", () => {
    resetLive();
    const live = getLive("ws_m");
    live.feedStatus("live");
    live.feedSample(reading(1.2 * GiB, 3.94 * GiB, 0.8));
    live.feedSample(reading(3.59 * GiB, 3.94 * GiB, 6.4));
    // Still answering: the figures are the Live rows' business, not a reason.
    expect(outOfMemoryReading(live.snapshot(), "running")).toBeNull();
    live.feedStatus("connecting");
    expect(outOfMemoryReading(live.snapshot(), "running")).toEqual({ used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.4 });
    // A nap closes the link too; what the daemon read before it says nothing about now.
    expect(outOfMemoryReading(live.snapshot(), "napping")).toBeNull();
    expect(outOfMemoryReading(live.snapshot(), "waking")).toBeNull();
    live.feedStatus("live");
    expect(outOfMemoryReading(live.snapshot(), "running")).toBeNull();

    const roomy = getLive("ws_r");
    roomy.feedSample(reading(1.2 * GiB, 3.94 * GiB, 0.8));
    roomy.feedStatus("connecting");
    expect(outOfMemoryReading(roomy.snapshot(), "running")).toBeNull();
    expect(outOfMemoryReading(getLive("ws_none").snapshot(), "running")).toBeNull();
  });
});

describe("the reading as a hook", () => {
  const GiB = 1024 ** 3;
  const reading = (used: number, total: number, load1: number): SysSample => ({ type: "sys.sample", cpu: 99, load1, mem: { used, total }, disk: { used: 1, total: 10 }, at: 1 });

  it("ten samples that change nothing a pane says are no render of the pane; the reading object holds while its figures hold", () => {
    resetLive();
    const live = getLive("ws_h");
    live.feedStatus("live");
    let renders = 0;
    const hook = renderHook(() => {
      renders++;
      return useOutOfMemoryReading("ws_h", "running");
    });
    expect(hook.result.current).toBeNull();
    expect(renders).toBe(1);
    act(() => {
      for (let i = 0; i < 10; i++) live.feedSample(reading((1 + i * 0.1) * GiB, 3.94 * GiB, 0.8 + i));
    });
    expect(renders).toBe(1);
    expect(hook.result.current).toBeNull();
    act(() => {
      live.feedSample(reading(3.59 * GiB, 3.94 * GiB, 6.4));
      live.feedStatus("connecting");
    });
    expect(renders).toBe(2);
    const first = hook.result.current;
    expect(first).toEqual({ used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.4 });
    // The store changed (a refusal arrived) but the figures did not: same object, no render.
    act(() => live.feedUnavailable("sys.watch refused"));
    expect(renders).toBe(2);
    expect(hook.result.current).toBe(first);
    act(() => live.feedStatus("live"));
    expect(hook.result.current).toBeNull();
    expect(renders).toBe(3);
    hook.unmount();
  });

  it("the many-workspace form holds its object by value across every row's samples and reports only rows with a reading", () => {
    resetLive();
    const a = getLive("ws_a");
    const b = getLive("ws_b");
    a.feedStatus("live");
    b.feedStatus("live");
    const rows = [{ id: "ws_a", phase: "running" as const }, { id: "ws_b", phase: "running" as const }];
    let renders = 0;
    const hook = renderHook(() => {
      renders++;
      return useOutOfMemoryReadings(rows);
    });
    const empty = hook.result.current;
    expect(empty).toEqual({});
    act(() => {
      for (let i = 0; i < 10; i++) {
        a.feedSample(reading(1 * GiB, 3.94 * GiB, 1));
        b.feedSample(reading(3.59 * GiB, 3.94 * GiB, 6.4));
      }
    });
    expect(renders).toBe(1);
    expect(hook.result.current).toBe(empty);
    act(() => b.feedStatus("connecting"));
    expect(hook.result.current).toEqual({ ws_b: { used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.4 } });
    const withB = hook.result.current;
    act(() => a.feedUnavailable("refused"));
    expect(hook.result.current).toBe(withB);
    expect(renders).toBe(2);
    hook.unmount();
  });
});
