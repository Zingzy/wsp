// SPDX-License-Identifier: AGPL-3.0-only
// A line over a list, drawn by the Usage page's own chart: x and value read per row, oldest first.
import { slateAxisWord as word, slateChartAxis, type SlateJson } from "@wsp/protocol";
import { UsageChart } from "../../settings/usageChart.js";
import type { PieceView } from "../SlateView.js";
import { useCallback, useState } from "react";
import { cn } from "../../lib/utils.js";
import { LEGEND } from "../../settings/usage.js";
import { figure, NOTE, str, TONE_INK } from "./look.js";

/** The kit's axis, except that whole-number figures label only whole numbers: the axis spans whole numbers, split
 * into the most parts (four at most) that each step a whole number, so 0 to 1 reads 0 and 1, never 0, 0, 1, 1, 1. */
function axisFor(values: readonly number[], format: SlateJson | undefined): { from: number; to: number; parts: number } {
  const axis = slateChartAxis(values);
  if (format !== "integer") return { ...axis, parts: 4 };
  const from = Math.floor(axis.from);
  const to = Math.max(from + 1, Math.ceil(axis.to));
  const span = to - from;
  const parts = [4, 3, 2].find(n => span % n === 0) ?? 1;
  return { from, to, parts };
}

/** The panel decides a chart's height, not the agent: 160 px in the 400 px panel, 220 once it is widened. */
const heightFor = (width: number): number => (width >= 560 ? 220 : 160);

/** The figure's own width, read as it changes. */
function useWidth(): [(node: HTMLElement | null) => (() => void) | undefined, number] {
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
  rowScoped: ["x", "value"],
  component: function ChartPiece({ id, piece, props, slate }) {
    const [ref, width] = useWidth();
    const label = str(props["label"]) ?? "";
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const rows = items.map((item, index) => ({
      x: piece.props?.["x"] === undefined ? index : slate.resolve(piece.props["x"], { item, index }),
      v: slate.resolve(piece.props?.["value"], { item, index }),
    })).filter((r): r is { x: SlateJson | undefined; v: number } => typeof r.v === "number" && Number.isFinite(r.v));
    const unit = str(props["unit"]);
    const shown = (v: number): string => `${figure(v, props["format"]) ?? ""}${unit === undefined ? "" : ` ${unit}`}`;
    const values = rows.length === 1 ? [rows[0]!.v, rows[0]!.v] : rows.map(r => r.v);
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
          </span>
        </figcaption>
        {rows.length === 0 ? (
          <span className={NOTE}>Not read yet</span>
        ) : (
          <UsageChart
            steps={values.map((_, i) => i)}
            lines={[{ key: "line", label, points: values, ink: { className: TONE_INK[tone] } }]}
            stepWord={i => word(rows[Math.min(i, rows.length - 1)]?.x)}
            ticks={rows.length === 1 ? [{ at: 1, word: word(rows[0]!.x) }] : [{ at: 0, word: word(rows[0]!.x) }, { at: 1, word: word(rows.at(-1)!.x) }]}
            height={heightFor(width)}
            figure={shown}
            label={label}
            axis={axisFor(values, props["format"])}
            small
          />
        )}
      </figure>
    );
  },
};
