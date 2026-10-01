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

export interface ChartLine {
  readonly key: string;
  readonly label: string;
  readonly points: readonly number[];
  /** The line's ink: a colour utility, with the custom properties it reads where the ink is the agent's own. */
  readonly ink: { readonly className: string; readonly style?: CSSProperties };
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(n => (n + 0.5) / 16);
const CELL = 2;
const HEIGHT = 240;
const PAD = 6;

function paintDither(canvas: HTMLCanvasElement, points: readonly number[], top: number, ink: string): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (ctx === null || w === 0 || points.length < 2 || top === 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const n = points.length;
  const y = (v: number): number => h - PAD - (v / top) * (h - PAD * 2);
  const at = (px: number): number => {
    const t = (px / w) * (n - 1);
    const i = Math.min(n - 2, Math.floor(t));
    const f = t - i;
    return points[i]! * (1 - f) + points[i + 1]! * f;
  };
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.5;
  for (let px = 0; px < w; px += CELL) {
    const line = y(at(px));
    const floor = h - PAD;
    for (let py = Math.ceil(line); py < floor; py += CELL) {
      const depth = 1 - (py - line) / (floor - line + 1);
      if (depth * 0.55 > BAYER[((py / CELL) & 3) * 4 + ((px / CELL) & 3)]!) ctx.fillRect(px, py, CELL - 0.6, CELL - 0.6);
    }
  }
}

/** The axis's top: the smallest round figure at or over the largest point, so the four gridlines read as round
 * numbers. */
function niceTop(max: number): number {
  if (max <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(m => m * magnitude >= max) ?? 10;
  return step * magnitude;
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

export function UsageChart({ steps, lines, stepWord, ticks }: { steps: readonly number[]; lines: readonly ChartLine[]; stepWord: (t: number) => string; ticks: ReadonlyArray<{ at: number; word: string }> }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const leadInk = useRef<SVGGElement>(null);
  const themeTick = useThemeTick();
  const n = steps.length;
  const top = niceTop(Math.max(0, ...lines.flatMap(line => line.points)));
  const total = (line: ChartLine): number => line.points.reduce((a, b) => a + b, 0);
  const lead = [...lines].sort((a, b) => total(b) - total(a))[0];
  const x = (i: number): number => (n > 1 ? (i / (n - 1)) * 100 : 0);
  const y = (v: number): number => HEIGHT - PAD - (top === 0 ? 0 : (v / top) * (HEIGHT - PAD * 2));
  const dataKey = lines.map(line => `${line.key}:${line.points.join(",")}`).join("|");

  const drawn = useRef({ lead, top });
  drawn.current = { lead, top };
  useEffect(() => {
    const el = canvas.current;
    if (el === null) return;
    const paint = (): void => {
      const { lead: line, top: scale } = drawn.current;
      if (line !== undefined) paintDither(el, line.points, scale, leadInk.current === null ? "currentColor" : getComputedStyle(leadInk.current).color);
    };
    paint();
    const sized = new ResizeObserver(paint);
    sized.observe(el);
    return () => sized.disconnect();
  }, [dataKey, themeTick]);

  return (
    <div data-usage-chart="tokens" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3">
      <div data-k="y-axis" aria-hidden className="relative font-mono text-[11px] leading-none text-muted-foreground tabular-nums" style={{ height: HEIGHT }}>
        {[0, 1, 2, 3, 4].map(g => (
          <span key={g} data-k="y-tick" className="invisible block h-0 text-right">
            {fmtTokens((top * g) / 4)}
          </span>
        ))}
        {[0, 1, 2, 3, 4].map(g => (
          <span key={g} className="absolute right-0 -translate-y-1/2" style={{ top: HEIGHT - PAD - (g / 4) * (HEIGHT - PAD * 2) }}>
            {fmtTokens((top * g) / 4)}
          </span>
        ))}
      </div>
      <div className="relative" style={{ height: HEIGHT }}>
        <svg aria-hidden className="absolute inset-0 size-full overflow-visible text-border" viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none">
          {[1, 2, 3, 4].map(g => {
            const gy = HEIGHT - PAD - (g / 4) * (HEIGHT - PAD * 2);
            return <line key={g} x1={0} x2={100} y1={gy} y2={gy} stroke="currentColor" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />;
          })}
          <line x1={0} x2={100} y1={HEIGHT - PAD} y2={HEIGHT - PAD} stroke="currentColor" vectorEffect="non-scaling-stroke" />
        </svg>
        <canvas ref={canvas} aria-hidden className="absolute inset-0 size-full" />
        <svg role="img" aria-label="Tokens over the range" className="absolute inset-0 size-full overflow-visible" viewBox={`0 0 100 ${HEIGHT}`} preserveAspectRatio="none">
          {[...lines].reverse().map(line => (
            <g key={line.key} ref={line === lead ? leadInk : undefined} data-line={line.key} className={line.ink.className} style={line.ink.style}>
              <polyline points={line.points.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={line === lead ? 1.75 : 1.4} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          {hovered === null ? null : <line x1={x(hovered)} x2={x(hovered)} y1={0} y2={HEIGHT} className="text-foreground/30" stroke="currentColor" vectorEffect="non-scaling-stroke" />}
        </svg>
        {lead === undefined || n === 0 ? null : (
          <span aria-hidden className={cn("absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current", lead.ink.className)} style={{ ...lead.ink.style, left: `${x(hovered ?? n - 1)}%`, top: y(lead.points[hovered ?? n - 1] ?? 0) }} />
        )}
        <div className="absolute inset-0 flex">
          {steps.map((t, i) => (
            <Tooltip key={t}>
              <TooltipTrigger
                delay={0}
                render={<span data-k="point" className="h-full flex-1" style={n > 1 && (i === 0 || i === n - 1) ? { flexGrow: 0.5 } : undefined} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(current => (current === i ? null : current))} />}
              />
              <TooltipPopup side="top" sideOffset={6}>
                <span className="flex flex-col gap-1">
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{stepWord(t)}</span>
                  {lines
                    .filter(line => (line.points[i] ?? 0) > 0)
                    .map(line => (
                      <span key={line.key} data-k="point-figure" className="flex items-center justify-between gap-4 text-xs">
                        <span className="flex items-center gap-2">
                          <span aria-hidden className={cn("h-0.5 w-3 rounded-full bg-current", line.ink.className)} style={line.ink.style} />
                          {line.label}
                        </span>
                        <span className="font-mono tabular-nums">{fmtTokens(line.points[i] ?? 0)}</span>
                      </span>
                    ))}
                </span>
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>
      </div>
      <span aria-hidden />
      <div className="relative h-4 font-mono text-[11px] leading-4 text-muted-foreground tabular-nums">
        {ticks.map(tick => (
          <span key={tick.at} data-k="tick" className={cn("absolute top-0", tick.at === 0 ? "" : tick.at === 1 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${tick.at * 100}%` }}>
            {tick.word}
          </span>
        ))}
      </div>
    </div>
  );
}
