// SPDX-License-Identifier: AGPL-3.0-only
// How a chart labels its axes, read by the window that draws it and the sketch that tells the agent what it drew.
import { fmtClock } from "../format.js";
import type { SlateJson } from "./types.js";

const STEPS = [1, 2, 2.5, 5];

/** The y axis in four or five round steps holding every value, whichever reaches less far past the top: from 0 when
 * the values sit nearer 0 than their spread, and a band of 2 percent of the value (or 1) around a flat line. */
export function slateChartAxis(values: readonly number[]): { from: number; to: number; parts: number } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const band = hi > lo ? 0 : (Math.abs(lo) * 0.02 || 1) / 2;
  const low = lo >= 0 && lo <= hi - lo ? 0 : lo - band;
  const high = hi + band;
  const tidy = (v: number): number => Number(v.toPrecision(12));
  const span = (parts: number): { from: number; to: number; parts: number } => {
    let magnitude = 10 ** Math.floor(Math.log10((high - low) / parts));
    for (let i = 0; ; i++) {
      if (i === STEPS.length) (i = 0), (magnitude *= 10);
      const step = STEPS[i]! * magnitude;
      if (step * parts < high - low) continue;
      const from = tidy(Math.floor(tidy(low / step)) * step);
      if (from + step * parts >= high) return { from, to: tidy(from + step * parts), parts };
    }
  };
  const four = span(4);
  const five = span(5);
  return five.to - five.from < four.to - four.from ? five : four;
}

/** An x as the axis labels it: a time in ms or an ISO time by the clock, anything else as written. */
export function slateAxisWord(x: SlateJson | undefined): string {
  if (typeof x === "number" && x > 1e12) return fmtClock(x).slice(0, 5);
  if (typeof x === "string" && /^\d{4}-\d{2}-\d{2}T/.test(x) && Number.isFinite(Date.parse(x))) return fmtClock(Date.parse(x)).slice(0, 5);
  return x === undefined || x === null ? "" : typeof x === "string" ? x : JSON.stringify(x);
}
