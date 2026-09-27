// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { datetimeLocalValue, resolveCustomSnooze, resolveSnoozePresets } from "./snooze.js";

const local = (y: number, m: number, d: number, h: number, min = 0): Date => new Date(y, m - 1, d, h, min);

describe("the times a snooze offers", () => {
  it("offers an hour, three hours, this evening while it is more than an hour off, tomorrow morning and next Monday morning", () => {
    const now = local(2026, 9, 23, 10);
    const presets = resolveSnoozePresets(now);
    expect(presets.map(p => p.id)).toEqual(["hour", "three-hours", "evening", "tomorrow", "next-week"]);
    expect(presets.map(p => p.snoozedUntil)).toEqual([local(2026, 9, 23, 11), local(2026, 9, 23, 13), local(2026, 9, 23, 18), local(2026, 9, 24, 9), local(2026, 9, 28, 9)].map(d => d.getTime()));
    expect(resolveSnoozePresets(local(2026, 9, 23, 17, 30)).map(p => p.id)).not.toContain("evening");
    // On a Sunday tomorrow is next week's Monday, offered once.
    expect(resolveSnoozePresets(local(2026, 9, 27, 10)).map(p => p.id)).toEqual(["hour", "three-hours", "evening", "tomorrow"]);
  });

  it("reads a typed time on this computer's clock and refuses one that names no moment or one already past", () => {
    const now = local(2026, 9, 23, 10);
    expect(resolveCustomSnooze("2026-09-23T15:30", now)).toBe(local(2026, 9, 23, 15, 30).getTime());
    expect(resolveCustomSnooze("2026-09-23T09:00", now)).toBeNull();
    expect(resolveCustomSnooze("", now)).toBeNull();
    expect(resolveCustomSnooze("tomorrow", now)).toBeNull();
    expect(datetimeLocalValue(local(2026, 9, 3, 7, 5).getTime())).toBe("2026-09-03T07:05");
  });
});
