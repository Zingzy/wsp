// SPDX-License-Identifier: AGPL-3.0-only
// The Usage page's chart: one line per split value over the range's steps, all
// on the scale of the largest single line so a small one is not flattened by a
// sum, and under the leading line a dither in its own ink. The dither is a 4 by
// 4 Bayer pattern that only changes the ink's alpha, so one fill reads on the
// light theme and the dark; it is painted when the data, the size or the theme
// changes and never on a timer.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { fmtTokens } from "@wsp/protocol";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { DigitRoll } from "../components/ui/digit-roll.js";

export interface ChartLine {
  readonly key: string;
  readonly label: string;
  readonly points: readonly number[];
  /** The line's ink: a colour utility, with the custom properties it reads where the ink is the agent's own. */
  readonly ink: { readonly className: string; readonly style?: CSSProperties };
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(n => (n + 0.5) / 16);
const CELL = 2;
export const CHART_HEIGHT = 300;
const PAD = 6;

/** The dither under each line, biggest first: the lead at full density and each line after it lighter, each on its
 * own phase of the pattern so two lines never take the same cell and an overlap reads as both inks. */
function paintDither(canvas: HTMLCanvasElement, fills: ReadonlyArray<{ points: readonly number[]; ink: string }>, top: number): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (ctx === null || w === 0 || top === 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const y = (v: number): number => h - PAD - (v / top) * (h - PAD * 2);
  const floor = h - PAD;
  fills.forEach(({ points, ink }, rank) => {
    const n = points.length;
    if (n < 2) return;
    const at = (px: number): number => {
      const t = (px / w) * (n - 1);
      const i = Math.min(n - 2, Math.floor(t));
      const f = t - i;
      return points[i]! * (1 - f) + points[i + 1]! * f;
    };
    const density = rank === 0 ? 0.55 : 0.32;
    const phase = rank * 5;
    ctx.fillStyle = ink;
    ctx.globalAlpha = rank === 0 ? 0.5 : 0.45;
    for (let px = 0; px < w; px += CELL) {
      const line = y(at(px));
      for (let py = Math.ceil(line); py < floor; py += CELL) {
        const depth = 1 - (py - line) / (floor - line + 1);
        if (depth * density > BAYER[((((py / CELL) & 3) * 4 + ((px / CELL) & 3)) + phase) % 16]!) ctx.fillRect(px, py, CELL - 0.6, CELL - 0.6);
      }
    }
  });
}

/** The axis's top: the smallest round figure at or over the largest point, so the four gridlines read as round
 * numbers. */
function niceTop(max: number): number {
  if (max <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(m => m * magnitude >= max) ?? 10;
  return step * magnitude;
}

const TWEEN_MS = 520;
const reducedMotion = (): boolean => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

interface Frame {
  readonly points: ReadonlyMap<string, readonly number[]>;
  readonly top: number;
}

/** The lines and the scale as drawn this frame: each change eases from wherever the last one stood, a line new to
 * the chart rising from the baseline, a range of another length read off the old one at the same share of its way. */
function useTween(lines: readonly ChartLine[], top: number, dataKey: string): Frame {
  const target = (): Frame => ({ points: new Map(lines.map(line => [line.key, line.points])), top });
  const [frame, setFrame] = useState<Frame>(() => ({ points: new Map(lines.map(line => [line.key, line.points.map(() => 0)])), top }));
  const drawn = useRef(frame);
  drawn.current = frame;
  useEffect(() => {
    const to = target();
    if (reducedMotion()) return setFrame(to);
    const from = drawn.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number): void => {
      const k = Math.min(1, (now - start) / TWEEN_MS);
      const e = 1 - (1 - k) ** 3;
      const points = new Map<string, number[]>();
      for (const [key, end] of to.points) {
        const old = from.points.get(key);
        points.set(
          key,
          end.map((v, i) => {
            const o = old === undefined || old.length === 0 ? 0 : (old[Math.round((i * (old.length - 1)) / Math.max(1, end.length - 1))] ?? 0);
            return o + (v - o) * e;
          }),
        );
      }
      setFrame({ points, top: from.top === 0 ? to.top : from.top + (to.top - from.top) * e });
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // dataKey names the lines' values; the target is rebuilt from them inside.
  }, [dataKey, top]);
  return frame;
}

/** Repaints when the root's theme class flips, since the ink is read off the computed style. */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const seen = new MutationObserver(() => setTick(t => t + 1));
    seen.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => seen.disconnect();
  }, []);
  return tick;
}

export function UsageChart({ steps, lines: given, stepWord, ticks, height: HEIGHT = CHART_HEIGHT, figure = fmtTokens, axisFigure = figure, label = "Tokens over the range", axis, small = false }: {
  steps: readonly number[];
  lines: readonly ChartLine[];
  stepWord: (t: number) => string;
  ticks: ReadonlyArray<{ at: number; word: string }>;
  height?: number;
  /** The words for a figure on the axis and in the tooltip. */
  figure?: (v: number) => string;
  /** The axis's own words where they differ: a unit the legend already names is not said again on every tick. */
  axisFigure?: (v: number) => string;
  label?: string;
  /** A fixed axis from the caller, its figures drawn as plain text, split in four unless it names fewer parts; without
   * one it runs from 0 to a round top in four and the figures roll. */
  axis?: { readonly from: number; readonly to: number; readonly parts?: number };
  /** The panel's size: the axis figures and ticks at 11 px, the gutter as wide as the widest figure and 8 px off the
   * plot, so the widest figure starts on the section's left edge and the plot ends on its right. */
  small?: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const from = axis?.from ?? 0;
  const lines = from === 0 ? given : given.map(line => ({ ...line, points: line.points.map(v => v - from) }));
  const themeTick = useThemeTick();
  const n = steps.length;
  const top = axis === undefined ? niceTop(Math.max(0, ...lines.flatMap(line => line.points))) : axis.to - axis.from;
  const total = (line: ChartLine): number => line.points.reduce((a, b) => a + b, 0);
  const parts = axis?.parts ?? 4;
  const marks = Array.from({ length: parts + 1 }, (_, g) => g);
  const lead = [...lines].sort((a, b) => total(b) - total(a))[0];
  const x = (i: number): number => (n > 1 ? (i / (n - 1)) * 100 : 0);
  const dataKey = lines.map(line => `${line.key}:${line.points.join(",")}`).join("|");
  const frame = useTween(lines, top, dataKey);
  const pointsOf = (line: ChartLine): readonly number[] => frame.points.get(line.key) ?? line.points;
  const scale = frame.top;
  const y = (v: number): number => HEIGHT - PAD - (scale === 0 ? 0 : (v / scale) * (HEIGHT - PAD * 2));

  const inks = useRef(new Map<string, SVGGElement>());
  const byTotal = [...lines].sort((a, b) => total(b) - total(a));
  // The resize observer is set up once, so it reads the latest frame through this ref rather than the first render's.
  const painted = useRef({ fills: byTotal, scale, points: frame.points });
  painted.current = { fills: byTotal, scale, points: frame.points };
  const paint = (): void => {
    const el = canvas.current;
    if (el === null) return;
    const fills = painted.current.fills.map(line => {
      const g = inks.current.get(line.key);
      return { points: painted.current.points.get(line.key) ?? line.points, ink: g === undefined ? "currentColor" : getComputedStyle(g).color };
    });
    paintDither(el, fills, painted.current.scale);
  };
  useEffect(paint, [frame, themeTick]);
  useEffect(() => {
    const el = canvas.current;
    if (el === null) return;
    const sized = new ResizeObserver(paint);
    sized.observe(el);
    return () => sized.disconnect();
  }, []);

  return (
    <div data-usage-chart="tokens" className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-y-3", small ? "gap-x-2" : "gap-x-3")}>
      <div data-k="y-axis" aria-hidden className={cn("relative font-mono leading-none whitespace-nowrap text-muted-foreground tabular-nums", small ? "text-[11px]" : "text-xs")} style={{ height: HEIGHT }}>
        {marks.map(g => (
          <span key={g} data-k="y-tick" className="invisible block h-0 text-right">
            {axisFigure(from + (top * g) / parts)}
          </span>
        ))}
        {marks.map(g => (
          <span key={g} className="absolute right-0 -translate-y-1/2" style={{ top: HEIGHT - PAD - (g / parts) * (HEIGHT - PAD * 2) }}>
            {axis === undefined ? <DigitRoll rollIn value={axisFigure(from + (top * g) / parts)} /> : axisFigure(from + (top * g) / parts)}
          </span>
        ))}
      </div>
      <div className="relative" style={{ height: HEIGHT }}>
        <svg aria-hidden className="absolute inset-0 size-full overflow-visible text-border" viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none">
          {marks.slice(1).map(g => {
            const gy = HEIGHT - PAD - (g / parts) * (HEIGHT - PAD * 2);
            return <line key={g} x1={0} x2={100} y1={gy} y2={gy} stroke="currentColor" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />;
          })}
          <line x1={0} x2={100} y1={HEIGHT - PAD} y2={HEIGHT - PAD} stroke="currentColor" vectorEffect="non-scaling-stroke" />
        </svg>
        <canvas ref={canvas} aria-hidden className="absolute inset-0 size-full" />
        <svg role="img" aria-label={label} className="absolute inset-0 size-full overflow-visible" viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none">
          {[...lines].reverse().map(line => (
            <g
              key={line.key}
              ref={el => {
                if (el === null) inks.current.delete(line.key);
                else inks.current.set(line.key, el);
              }}
              data-line={line.key} className={line.ink.className} style={line.ink.style}>
              <polyline points={pointsOf(line).map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={line === lead ? 1.75 : 1.4} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          {hovered === null ? null : <line x1={x(hovered)} x2={x(hovered)} y1={0} y2={HEIGHT} className="text-foreground/30" stroke="currentColor" vectorEffect="non-scaling-stroke" />}
        </svg>
        {lead === undefined || n === 0 ? null : (
          <span aria-hidden className={cn("absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current", lead.ink.className)} style={{ ...lead.ink.style, left: `${x(hovered ?? n - 1)}%`, top: y(pointsOf(lead)[hovered ?? n - 1] ?? 0) }} />
        )}
        <div className="absolute inset-0 flex">
          {steps.map((t, i) => (
            <Tooltip key={t}>
              <TooltipTrigger
                delay={0}
                render={<span data-k="point" className="h-full flex-1" style={n > 1 && (i === 0 || i === n - 1) ? { flexGrow: 0.5 } : undefined} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(current => (current === i ? null : current))} />}
              />
              {/* In the panel the hover opens beside its line at the plot's top, flipping at the far edge, so it never
                  rises over the legend and the section head, nor runs past the panel's left edge. */}
              <TooltipPopup {...(small ? { side: "right", align: "start", sideOffset: 8 } : { side: "top", sideOffset: 6 })}>
                <span className="flex flex-col gap-1">
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{stepWord(t)}</span>
                  {given
                    .filter(line => (line.points[i] ?? 0) > 0)
                    .map(line => (
                      <span key={line.key} data-k="point-figure" className="flex items-center justify-between gap-4 text-xs">
                        <span className="flex items-center gap-2">
                          <span aria-hidden className={cn("h-0.5 w-3 rounded-full bg-current", line.ink.className)} style={line.ink.style} />
                          {line.label}
                        </span>
                        <span className="font-mono tabular-nums">{figure(line.points[i] ?? 0)}</span>
                      </span>
                    ))}
                </span>
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>
      </div>
      <span aria-hidden />
      <div className={cn("relative h-4 font-mono leading-4 text-muted-foreground tabular-nums", small ? "text-[11px]" : "text-xs")}>
        {ticks.map(tick => (
          <span key={tick.at} data-k="tick" className={cn("absolute top-0", tick.at === 0 ? "" : tick.at === 1 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${tick.at * 100}%` }}>
            {tick.word}
          </span>
        ))}
      </div>
    </div>
  );
}
