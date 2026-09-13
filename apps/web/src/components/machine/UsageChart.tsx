// SPDX-License-Identifier: AGPL-3.0-only
// The usage section's chart: the accrued total over the range picked in the
// header, one smooth line in the spend colour over a fill that fades to the
// background, dashed grid, mono ticks on both axes, the newest point dotted.
// Hovering reads one instant under the box.
import { useId, useState, type MouseEvent as ReactMouseEvent } from "react";
import { accruedAt, fmtCost, rateAt, type WorkspaceCostEvent } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import { money } from "./format.js";
import { plotPoints, rangeHeld, smoothPath, timeLabel, trackedLine, usageReadout, USAGE_RANGES, usageSpan, xTicks, yAxis, type UsageRange } from "./usage.js";

/** The drawing box the line is laid out in; the svg stretches it to the panel, and the stroke keeps its width. */
const BOX = 100;

/** The ranges, each held once it reaches back past the first tick this workspace has: a held one carries the
 * sentence that says how long it has been tracked, which is the same sentence the readout under the chart says. */
export function UsageRangeToggle({ series, range, onChange }: { series: WorkspaceCostEvent[]; range: UsageRange; onChange: (range: UsageRange) => void }) {
  const reason = trackedLine(series);
  return (
    <div role="group" aria-label="range" className="flex gap-2.5" data-k="usage-range">
      {USAGE_RANGES.map(r => {
        const held = rangeHeld(series, r) && r !== range;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={r === range}
            disabled={held}
            {...(held && reason !== null ? { title: reason } : {})}
            onClick={() => onChange(r)}
            className={cn("transition-colors duration-150", r === range ? "text-foreground" : held ? "text-muted-foreground/50" : "text-muted-foreground hover:text-foreground")}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}

export function UsageChart({ series, range }: { series: WorkspaceCostEvent[]; range: UsageRange }) {
  const [hover, setHover] = useState<number | null>(null);
  const fade = useId();
  const span = usageSpan(series, range);
  const first = series[0];

  if (span === null || first === undefined) {
    return (
      <div className="mt-2 mb-1" data-usage-chart>
        <div className="grid h-28 place-items-center text-[11px] text-muted-foreground" data-k="usage-empty">
          No cost yet
        </div>
        <p className="mt-1 h-4" data-k="usage-readout" />
      </div>
    );
  }

  const pts = plotPoints(series, span);
  const axis = yAxis(Math.max(0, ...pts.map(p => p.usd)));
  const x = (t: number): number => ((t - span.start) / (span.end - span.start)) * BOX;
  const y = (usd: number): number => BOX - (usd / axis.top) * BOX;
  const xy = pts.map(p => ({ x: x(p.t), y: y(p.usd) }));
  const line = smoothPath(xy);
  const end = xy[xy.length - 1];
  const area = end === undefined ? "" : `${line}L${end.x.toFixed(2)} ${BOX}L${xy[0]!.x.toFixed(2)} ${BOX}Z`;
  const overUsd = hover !== null ? accruedAt(series, hover) : null;
  const overRate = hover !== null ? rateAt(series, hover) : null;
  const readout = hover !== null && overUsd !== null && overRate !== null ? `${fmtCost(overUsd)} · ${money(overRate, 3)}/hr · ${timeLabel(hover, span)}` : usageReadout(series, range);
  const ticks = xTicks(span);

  const track = (e: ReactMouseEvent<SVGSVGElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    // Whole seconds: the ticks are five apart, and a hair under a minute boundary would read as the minute before.
    setHover(Math.round((span.start + f * (span.end - span.start)) / 1000) * 1000);
  };

  return (
    <div className="mt-2 mb-1" data-usage-chart>
      <div className="grid grid-cols-[2.75rem_minmax(0,1fr)] grid-rows-[6rem_1rem] gap-x-2">
        <div className="relative" data-usage-axis="y">
          {axis.ticks.map(v => (
            <span key={v} className="absolute right-0 -translate-y-1/2 font-mono text-[10px] leading-none tabular-nums text-muted-foreground" style={{ top: `${y(v)}%` }}>
              {money(v, axis.digits)}
            </span>
          ))}
        </div>
        <div className="relative text-caution-foreground">
          {axis.ticks.map(v => (
            <div key={v} aria-hidden className={cn("absolute inset-x-0 border-t border-border/70", v > 0 && "border-dashed")} style={{ top: `${y(v)}%` }} />
          ))}
          <svg
            className="absolute inset-0 size-full overflow-visible"
            viewBox={`0 0 ${BOX} ${BOX}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="cost accrued over the range, one line"
            onMouseMove={track}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${fade})`} stroke="none" data-usage-area />
            <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" data-usage-line />
            {hover !== null && (
              <line x1={x(hover)} x2={x(hover)} y1={0} y2={BOX} className="stroke-muted-foreground/50" strokeWidth={1} vectorEffect="non-scaling-stroke" data-usage-hover />
            )}
          </svg>
          {end !== undefined && <Dot x={end.x} y={end.y} k="usage-end" />}
          {hover !== null && overUsd !== null && <Dot x={x(hover)} y={y(overUsd)} k="usage-hover-dot" />}
        </div>
        <div />
        <div className="relative" data-usage-axis="x">
          {ticks.map((t, i) => (
            <span
              key={t}
              className={cn("absolute top-0 font-mono text-[10px] leading-4 tabular-nums text-muted-foreground", i === 0 ? "left-0" : i === ticks.length - 1 ? "right-0" : "-translate-x-1/2")}
              style={i > 0 && i < ticks.length - 1 ? { left: `${x(t)}%` } : undefined}
            >
              {timeLabel(t, span)}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-1 h-4 truncate text-right font-mono text-[11px] leading-4 tabular-nums text-muted-foreground" data-k="usage-readout">
        {readout}
      </p>
    </div>
  );
}

/** A dot on one point of the box, drawn outside the svg so the stretch does not squash it. */
function Dot({ x, y, k }: { x: number; y: number; k: string }) {
  return <span aria-hidden className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" style={{ left: `${x}%`, top: `${y}%` }} data-k={k} />;
}
