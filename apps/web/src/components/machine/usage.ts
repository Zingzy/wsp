// SPDX-License-Identifier: AGPL-3.0-only
// The usage chart's arithmetic: the span a range names, the axis ticks and the
// smooth path through the points. What a series says at one instant is the
// protocol's (accruedAt, rateAt, monthStart), read by the host's own month
// total too. No DOM here so the rules test in node.
import { accruedAt, monthStart, offlineFor, spentSince, spentThisMonth, type WorkspaceCostEvent } from "@wsp/protocol";

export type UsageRange = "hour" | "day" | "month" | "all";
export const USAGE_RANGES: readonly UsageRange[] = ["hour", "day", "month", "all"];

const RANGE_MS: Record<"hour" | "day", number> = { hour: 3_600_000, day: 86_400_000 };
/** A series younger than this still gets a readable axis instead of a span collapsed to a point. */
const MIN_SPAN_MS = 60_000;

export interface Span {
  start: number;
  end: number;
}

/** When a range asks the chart to begin, whatever the series has: a fixed stretch back from the newest tick, and
 * for the month the first of it, which is the instant the places list totals a month from. */
function rangeStart(range: Exclude<UsageRange, "all">, end: number): number {
  return range === "month" ? monthStart(end) : end - RANGE_MS[range];
}

/** The span a range draws, ending at the newest tick and never beginning before the first: a workspace tracked for
 * forty minutes draws forty minutes under every range rather than a day of nothing with a spike at its edge. The
 * minimum width keeps a series of one tick from collapsing to a point. */
export function usageSpan(points: readonly WorkspaceCostEvent[], range: UsageRange): Span | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  const end = Date.parse(last.at);
  const from = Date.parse(first.at);
  return { start: Math.min(Math.max(range === "all" ? from : rangeStart(range, end), from), end - MIN_SPAN_MS), end };
}

/** Whether a range reaches back past the first tick there is, which is a range the chart cannot fill: the picker
 * holds those rather than drawing an empty stretch as a measurement. */
export function rangeHeld(points: readonly WorkspaceCostEvent[], range: UsageRange): boolean {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || range === "all") return false;
  return rangeStart(range, Date.parse(last.at)) < Date.parse(first.at);
}

/** What the chart says under it about the series itself: when the first tick landed, and how long that is once a
 * range asks for more than this workspace has been tracked. The held ranges carry the same sentence as their
 * reason, so the readout and the picker say one thing. */
export function trackedLine(points: readonly WorkspaceCostEvent[]): string | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  const life = { start: Date.parse(first.at), end: Date.parse(last.at) };
  const tracked = `tracked since ${timeLabel(life.start, life)}`;
  return USAGE_RANGES.some(range => rangeHeld(points, range)) ? `${tracked} · ${offlineFor(life.end - life.start)}` : tracked;
}

/** What the readout under the chart says while nothing is hovered: on the month range, what this workspace has
 * cost since the first of the month, which is the figure the places list totals from the same instant and which
 * the running line the chart draws is not. Every other range says how long the workspace has been tracked, and so
 * does the month range where the workspace has not lived a month, since there is no month of it to name. */
export function usageReadout(points: readonly WorkspaceCostEvent[], range: UsageRange): string | null {
  const tracked = trackedLine(points);
  const last = points[points.length - 1];
  if (range !== "month" || last === undefined || USAGE_RANGES.some(r => rangeHeld(points, r))) return tracked;
  return spentThisMonth(spentSince(points, monthStart(Date.parse(last.at))));
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
