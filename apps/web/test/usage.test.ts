// SPDX-License-Identifier: AGPL-3.0-only
// What the usage chart draws for a range the workspace has not lived through:
// the span it lays out, the ranges it holds and the line it says why in.
import { describe, expect, it } from "vitest";
import { monthStart, type WorkspaceCostEvent } from "@wsp/protocol";
import { rangeHeld, trackedLine, usageReadout, usageSpan, USAGE_RANGES, xTicks } from "../src/components/machine/usage.js";

const NOW = Date.parse("2026-09-12T19:36:50.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A series that began `ms` ago and has ticked since, folded as the runtime folds one. */
const series = (ms: number): WorkspaceCostEvent[] =>
  [NOW - ms, NOW].map(at => ({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.16, awakeMs: at - (NOW - ms), accruedUsd: ((at - (NOW - ms)) * 0.16) / HOUR, at: new Date(at).toISOString() }));

const width = (points: WorkspaceCostEvent[], range: (typeof USAGE_RANGES)[number]): number => {
  const span = usageSpan(points, range)!;
  return span.end - span.start;
};

describe("the span a range draws", () => {
  it("begins at the first tick when the range reaches back past it, so forty minutes of data is not drawn as a day", () => {
    // Aisha's chart: forty minutes metered, the day range, and a whole day of flat nothing with the spend in a
    // spike at the right edge.
    const forty = series(40 * MINUTE);
    expect(width(forty, "day")).toBe(40 * MINUTE);
    expect(width(forty, "hour")).toBe(40 * MINUTE);
    expect(width(forty, "month")).toBe(40 * MINUTE);
    expect(usageSpan(forty, "day")!.start).toBe(Date.parse(forty[0]!.at));
    // The axis then reads across the forty minutes rather than repeating a clock the data never reached.
    expect(xTicks(usageSpan(forty, "day")!).at(-1)).toBe(NOW);
  });

  it("keeps a range the workspace has lived through", () => {
    const threeHours = series(3 * HOUR);
    expect(width(threeHours, "hour")).toBe(HOUR);
    expect(width(threeHours, "all")).toBe(3 * HOUR);
    expect(width(threeHours, "day")).toBe(3 * HOUR);
  });

  it("begins the month range on the first of the month, which is where the places list totals a month from", () => {
    const long = series(60 * 24 * HOUR);
    expect(usageSpan(long, "month")!.start).toBe(monthStart(NOW));
  });

  it("keeps a readable width for a series of one tick, and answers nothing for one with none", () => {
    expect(width(series(0), "all")).toBe(MINUTE);
    expect(width(series(0), "hour")).toBe(MINUTE);
    expect(usageSpan([], "day")).toBeNull();
  });
});

describe("the ranges the picker holds", () => {
  it("holds every range longer than the workspace has been tracked, and never the whole of it", () => {
    const forty = series(40 * MINUTE);
    expect(USAGE_RANGES.filter(range => rangeHeld(forty, range))).toEqual(["hour", "day", "month"]);
    expect(rangeHeld(forty, "all")).toBe(false);
  });

  it("offers a range the workspace has lived through", () => {
    const threeDays = series(3 * 24 * HOUR);
    expect(USAGE_RANGES.filter(range => rangeHeld(threeDays, range))).toEqual(["month"]);
    expect(USAGE_RANGES.filter(range => rangeHeld(series(60 * 24 * HOUR), range))).toEqual([]);
    expect(rangeHeld(series(30 * MINUTE), "hour")).toBe(true);
    expect(rangeHeld(series(90 * MINUTE), "hour")).toBe(false);
  });

  it("holds nothing at all when there is nothing to draw", () => {
    expect(USAGE_RANGES.filter(range => rangeHeld([], range))).toEqual([]);
  });
});

describe("the line under the chart", () => {
  it("says how long the workspace has been tracked when a range asks for more than that", () => {
    // The clock is the app's own shape on every machine, so the pattern is exact rather than allowing a locale's.
    expect(trackedLine(series(40 * MINUTE))).toMatch(/^tracked since \d{2}:\d{2} [AP]M · 40 min$/);
    expect(trackedLine(series(3 * HOUR))).toMatch(/ · 3 h$/);
  });

  it("says when tracking began and no more, once every range fits inside it", () => {
    expect(trackedLine(series(60 * 24 * HOUR))).toMatch(/^tracked since [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} [AP]M$/);
  });

  it("says nothing about a workspace with no cost yet", () => {
    expect(trackedLine([])).toBeNull();
  });
});

describe("the readout on the month range", () => {
  /** A series that began before this month and ran at one rate since, so the month's share is less than the total. */
  const overTheMonth = (): WorkspaceCostEvent[] => {
    const began = monthStart(NOW) - 20 * 24 * HOUR;
    const rate = 0.16;
    const point = (at: number, accruedUsd: number): WorkspaceCostEvent => ({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: rate, awakeMs: at - began, accruedUsd, at: new Date(at).toISOString() });
    return [point(began, 0), point(NOW, ((NOW - began) * rate) / HOUR)];
  };

  it("says what the month cost, not the running total the line draws", () => {
    const points = overTheMonth();
    const sinceTheFirst = ((NOW - monthStart(NOW)) * 0.16) / HOUR;
    const whole = points.at(-1)!.accruedUsd;
    expect(sinceTheFirst).toBeLessThan(whole);
    expect(usageReadout(points, "month")).toBe(`$${sinceTheFirst.toFixed(2)} this month`);
    // The other ranges say how long the workspace has been tracked, as they did.
    expect(usageReadout(points, "all")).toBe(trackedLine(points));
    expect(usageReadout(points, "hour")).toBe(trackedLine(points));
  });

  it("keeps the tracked line where the workspace has not lived a month, since there is no month of it to name", () => {
    expect(usageReadout(series(40 * MINUTE), "month")).toBe(trackedLine(series(40 * MINUTE)));
    expect(usageReadout([], "month")).toBeNull();
  });
});
