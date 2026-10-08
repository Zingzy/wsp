// SPDX-License-Identifier: AGPL-3.0-only
// A line over a list, drawn by the Usage page's own chart: x and value read per row, oldest first.
import { slateAxisWord as word, slateChartAxis, type SlateJson, type SlatePropValue } from "@wsp/protocol/slate";
import { UsageChart } from "../../settings/usageChart.js";
import type { PieceView, PieceViewProps } from "../SlateView.js";
import { useCallback, useState } from "react";
import { cn } from "../../lib/utils.js";
import { LEGEND } from "../../settings/usage.js";
import { figure, NOTE, present, str, TONE_INK, toneOf, type Tone } from "./look.js";

/** Lines and bands the agent gave no tone each take a theme ink of their own, apart at a glance; the first is the
 * slate's accent where the chart holds it, else the page's ink. */
const SERIES_INK = ["var(--slate-accent,var(--primary))", "var(--warning)", "var(--status-working)", "var(--success)"];

type Series = { label: string; tone: SlateJson | undefined; value: SlatePropValue | undefined };
/** The series whose when holds, in the order given. */
function seriesOf(slate: PieceViewProps["slate"], raw: SlatePropValue | undefined): Series[] {
  const entries = Array.isArray(raw) ? raw.filter((entry): entry is Record<string, SlatePropValue> => entry !== null && typeof entry === "object" && !Array.isArray(entry)) : [];
  return present(slate, raw, entries).map(entry => ({ label: str(entry["label"] as SlateJson) ?? "", tone: entry["tone"] as SlateJson | undefined, value: entry["value"] }));
}

/** The kit's axis, except that whole-number figures label only whole numbers: the axis spans whole numbers, split
 * into the kit's parts when each steps a whole number, else the most that do, so 0 to 1 reads 0 and 1, never 0, 0, 1, 1, 1. */
function axisFor(values: readonly number[], format: SlateJson | undefined): { from: number; to: number; parts: number } {
  const axis = slateChartAxis(values);
  if (format !== "integer") return axis;
  const from = Math.floor(axis.from);
  const to = Math.max(from + 1, Math.ceil(axis.to));
  const span = to - from;
  const parts = [axis.parts, 4, 3, 2].find(n => span % n === 0) ?? 1;
  return { from, to, parts };
}

/** The panel decides a chart's height, not the agent: 200 px in the 400 px panel, 260 once it is widened. */
const heightFor = (width: number): number => (width >= 560 ? 260 : 200);

/** The figure's own width, read as it changes. */
export function useWidth(): [(node: HTMLElement | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((node: HTMLElement | null) => {
    if (node === null || typeof ResizeObserver === "undefined") return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export const chart: PieceView = {
  type: "chart",
  card: false,
  accent: true,
  rowScoped: ["x", "value", "series"],
  component: function ChartPiece({ id, piece, props, slate }) {
    const [ref, width] = useWidth();
    const label = str(props["label"]) ?? "";
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const series = seriesOf(slate, piece.props?.["series"]);
    if (series.length > 0) return <SeriesChart label={label} items={items} series={series} x={piece.props?.["x"]} props={props} id={id} slate={slate} />;
    const rows = items.map((item, index) => ({
      x: piece.props?.["x"] === undefined ? index : slate.resolve(piece.props["x"], { item, index }),
      v: slate.resolve(piece.props?.["value"], { item, index }),
    })).filter((r): r is { x: SlateJson | undefined; v: number } => typeof r.v === "number" && Number.isFinite(r.v));
    const unit = str(props["unit"]);
    const shown = (v: number): string => `${figure(v, props["format"]) ?? ""}${unit === undefined ? "" : ` ${unit}`}`;
    const values = rows.length === 1 ? [rows[0]!.v, rows[0]!.v] : rows.map(r => r.v);
    // A series that holds one value the whole window says so on the legend's line; the plot comes back once it moves.
    // One sample is not yet a series: it draws its plot, the axis and its point, from the first read on.
    const flat = rows.length > 1 && rows.every(r => r.v === rows[0]!.v);
    // One chart per slate carries the accent; any other draws its line in the muted ink.
    const tone = slate.isLoud("accent", id) ? "accent" : "muted";
    const comma = label.indexOf(", ");
    const name = comma < 0 ? label : label.slice(0, comma);
    const what = [comma < 0 ? undefined : label.slice(comma + 2), unit].filter(Boolean).join(", ");
    return (
      <figure ref={ref} data-slate-chart className="flex min-w-0 flex-col gap-2.5">
        {/* The label is the line's legend, as the Usage page names its lines, not a caption floating over the plot. */}
        <figcaption className={cn(LEGEND.row, "text-[13px] leading-5 text-foreground")}>
          <span className={LEGEND.item}>
            <span aria-hidden className={cn(LEGEND.swatch, "w-4", TONE_INK[tone])} />
            {name}
            {what === "" ? null : <span className="text-xs leading-4 text-muted-foreground">{what}</span>}
            {flat ? (
              <span data-slate-chart-flat className="text-xs leading-4 text-muted-foreground">
                steady at <span className="font-mono tabular-nums text-foreground">{shown(rows[0]!.v)}</span>
              </span>
            ) : null}
          </span>
        </figcaption>
        {rows.length === 0 ? (
          <span className={NOTE}>Not read yet</span>
        ) : flat ? null : (
          <UsageChart
            steps={values.map((_, i) => i)}
            lines={[{ key: "line", label, points: values, ink: { className: TONE_INK[tone] } }]}
            stepWord={i => word(rows[Math.min(i, rows.length - 1)]?.x)}
            ticks={rows.length === 1 ? [{ at: 1, word: word(rows[0]!.x) }] : [{ at: 0, word: word(rows[0]!.x) }, { at: 1, word: word(rows.at(-1)!.x) }]}
            height={heightFor(width)}
            figure={shown}
            axisFigure={v => figure(v, props["format"]) ?? ""}
            label={label}
            axis={axisFor(values, props["format"])}
            small
            everyFigure
          />
        )}
      </figure>
    );
  },
};

/** Two to four series over one x: lines that cross, or with stack a total split into bands, the first at the bottom. */
function SeriesChart({ label, items, series, x, props, id, slate }: { label: string; items: readonly SlateJson[]; series: Series[]; x: SlatePropValue | undefined; props: PieceViewProps["props"]; id: string; slate: PieceViewProps["slate"] }) {
  const [ref, width] = useWidth();
  const stacked = props["stack"] === true;
  const xs = items.map((item, index) => (x === undefined ? index : slate.resolve(x, { item, index })));
  const own = series.map(s => items.map((item, index) => { const v = slate.resolve(s.value, { item, index }); return typeof v === "number" && Number.isFinite(v) ? v : 0; }));
  const drawn = stacked ? own.map((_, k) => own[0]!.map((__, i) => own.slice(0, k + 1).reduce((sum, line) => sum + line[i]!, 0))) : own;
  const chartTone: Tone = slate.isLoud("accent", id) ? "accent" : "default";
  let untoned = 0;
  const inks = series.map(s => {
    if (s.tone !== undefined) return { className: TONE_INK[toneOf(s.tone, slate, id)] };
    const step = untoned++;
    return { className: "", style: { color: chartTone === "accent" || step > 0 ? SERIES_INK[step]! : "var(--foreground)" } };
  });
  const unit = str(props["unit"]);
  const shown = (v: number): string => `${figure(v, props["format"]) ?? ""}${unit === undefined ? "" : ` ${unit}`}`;
  const all = drawn.flat();
  const axis = stacked ? axisFor([0, ...all], props["format"]) : axisFor(all, props["format"]);
  const comma = label.indexOf(", ");
  const name = comma < 0 ? label : label.slice(0, comma);
  const what = [comma < 0 ? undefined : label.slice(comma + 2), unit].filter(Boolean).join(", ");
  const legend = stacked ? series.map((s, k) => ({ s, k })).reverse() : series.map((s, k) => ({ s, k }));
  return (
    <figure ref={ref} data-slate-chart className="flex min-w-0 flex-col gap-2.5">
      <figcaption className="flex flex-col gap-1.5">
        <span className="flex flex-wrap items-baseline gap-x-2 text-note leading-5 text-foreground">
          {name}
          {what === "" ? null : <span className="text-xs leading-4 text-muted-foreground">{what}</span>}
        </span>
        <span className={cn(LEGEND.row, "gap-x-4 text-xs leading-4")}>
          {legend.map(({ s, k }) => (
            <span key={k} className={LEGEND.item}>
              <span aria-hidden className={cn(stacked ? "size-2 rounded-xs bg-current opacity-80" : LEGEND.swatch, inks[k]!.className)} style={inks[k]!.style} />
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>
      {items.length === 0 ? (
        <span className={NOTE}>Not read yet</span>
      ) : (
        <UsageChart
          steps={items.map((_, i) => i)}
          lines={series.map((s, k) => ({ key: `s${k}`, label: s.label, points: drawn[k]!, ink: inks[k]! }))}
          stepWord={i => word(xs[Math.min(i, xs.length - 1)])}
          ticks={[{ at: 0, word: word(xs[0]) }, { at: 1, word: word(xs.at(-1)) }]}
          height={heightFor(width)}
          figure={shown}
          axisFigure={v => figure(v, props["format"]) ?? ""}
          label={label}
          axis={axis}
          small
          everyFigure
          stacked={stacked}
          fill={stacked}
        />
      )}
    </figure>
  );
}
