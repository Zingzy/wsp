// SPDX-License-Identifier: AGPL-3.0-only
// The usage chart's arithmetic: the span a range names, the accrued total
// and rate at any instant of a folded cost series, the axis ticks and the
// smooth path through the points. No DOM here so the rules test in node.
import type { WorkspaceCostEvent } from "@wsp/protocol";

export type UsageRange = "hour" | "day" | "all";
export const USAGE_RANGES: readonly UsageRange[] = ["hour", "day", "all"];

const RANGE_MS: Record<Exclude<UsageRange, "all">, number> = { hour: 3_600_000, day: 86_400_000 };
/** A series younger than this still gets a readable axis instead of a span collapsed to a point. */
const MIN_SPAN_MS = 60_000;

export interface Span {
  start: number;
  end: number;
}

/** The span a range names, ending at the newest tick: the last hour or day, or the whole series. */
export function usageSpan(points: readonly WorkspaceCostEvent[], range: UsageRange): Span | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  const end = Date.parse(last.at);
  if (range !== "all") return { start: end - RANGE_MS[range], end };
  return { start: Math.min(Date.parse(first.at), end - MIN_SPAN_MS), end };
}

/** The tick at or before t and the one after it, when t falls inside the series. */
function around(points: readonly WorkspaceCostEvent[], t: number): { before: WorkspaceCostEvent; after: WorkspaceCostEvent | undefined } | null {
  const first = points[0];
  if (first === undefined || t < Date.parse(first.at)) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Date.parse(points[mid]!.at) <= t) lo = mid;
    else hi = mid - 1;
  }
  return { before: points[lo]!, after: points[lo + 1] };
}

/** The total accrued at t: linear between the ticks around it, flat past the newest, unknown before the first. */
export function accruedAt(points: readonly WorkspaceCostEvent[], t: number): number | null {
  const near = around(points, t);
  if (near === null) return null;
  const { before, after } = near;
  if (after === undefined) return before.accruedUsd;
  const t0 = Date.parse(before.at);
  const t1 = Date.parse(after.at);
  if (t1 <= t0) return after.accruedUsd;
  return before.accruedUsd + ((after.accruedUsd - before.accruedUsd) * (t - t0)) / (t1 - t0);
}

/** The burn rate at t: the rate of the tick at or before it, which holds until the next tick. */
export function rateAt(points: readonly WorkspaceCostEvent[], t: number): number | null {
  return around(points, t)?.before.rateUsdPerHour ?? null;
}

export interface PlotPoint {
  t: number;
  usd: number;
}

/** The ticks inside the span, entered where the series crosses its left edge when it began before it. */
export function plotPoints(points: readonly WorkspaceCostEvent[], span: Span): PlotPoint[] {
  const inside = points.map(p => ({ t: Date.parse(p.at), usd: p.accruedUsd })).filter(p => p.t >= span.start && p.t <= span.end);
  const entry = accruedAt(points, span.start);
  if (entry !== null && (inside[0] === undefined || inside[0].t > span.start)) inside.unshift({ t: span.start, usd: entry });
  return inside;
}

const NICE = [1, 2, 2.5, 5, 10];

/** The smallest of 1, 2, 2.5, 5 times a power of ten that is at least v. */
function niceStep(v: number): number {
  if (v <= 0) return 0.01;
  const pow = 10 ** Math.floor(Math.log10(v));
  return NICE.find(n => n * pow >= v - pow * 1e-9)! * pow;
}

export interface YAxis {
  /** Grid values from the top down to zero. */
  ticks: number[];
  top: number;
  /** Decimals that tell one tick from the next. */
  digits: number;
}

/** Three or four grid lines from zero to a round ceiling just above the highest total. */
export function yAxis(max: number): YAxis {
  const step = niceStep(max / 3);
  const count = Math.max(1, Math.ceil(max / step - 1e-9));
  const top = step * count;
  const ticks = Array.from({ length: count + 1 }, (_, i) => top - i * step);
  return { ticks, top, digits: Math.max(2, -Math.floor(Math.log10(step) + 1e-9)) };
}

/** Four ticks over a day or less, three when a date has to ride along. */
function tickCount(span: Span): number {
  return span.end - span.start > RANGE_MS.day ? 3 : 4;
}

/** Evenly spaced instants from the span's start to its end. */
export function xTicks(span: Span): number[] {
  const count = tickCount(span);
  return Array.from({ length: count }, (_, i) => span.start + ((span.end - span.start) * i) / (count - 1));
}

/** Ticks less than a minute apart would share a minute label, so the clock carries seconds until they are a minute apart. */
function toTheSecond(span: Span): boolean {
  return (span.end - span.start) / (tickCount(span) - 1) < 60_000;
}

/** An axis instant in the person's zone: the clock, with the day in front once the span is longer than a day. */
export function timeLabel(t: number, span: Span): string {
  const d = new Date(t);
  const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(toTheSecond(span) ? { second: "2-digit" } : {}) });
  return span.end - span.start > RANGE_MS.day ? `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}` : clock;
}

interface Xy {
  x: number;
  y: number;
}

/** A cubic path through the points whose slopes are limited so the curve never overshoots them: a rising total stays
 * rising between ticks. One point draws as a move, two as a line. */
export function smoothPath(pts: readonly Xy[]): string {
  const n = pts.length;
  if (n === 0) return "";
  const at = (p: Xy) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  if (n === 1) return `M${at(pts[0]!)}`;
  if (n === 2) return `M${at(pts[0]!)}L${at(pts[1]!)}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const w = pts[i + 1]!.x - pts[i]!.x;
    dx.push(w);
    slope.push(w === 0 ? 0 : (pts[i + 1]!.y - pts[i]!.y) / w);
  }
  const m: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    m.push(a * b <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b));
  }
  m.push(slope[n - 2]!);
  let d = `M${at(pts[0]!)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${at({ x: p0.x + h, y: p0.y + m[i]! * h })} ${at({ x: p1.x - h, y: p1.y - m[i + 1]! * h })} ${at(p1)}`;
  }
  return d;
}
