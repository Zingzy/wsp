// SPDX-License-Identifier: AGPL-3.0-only
// A line over a list, drawn by the Usage page's own chart: x and value read per row, oldest first.
import { fmtClock, type SlateJson } from "@wsp/protocol";
import { UsageChart } from "../../settings/usageChart.js";
import type { PieceView } from "../SlateView.js";
import { figure, str, TONE_INK, toneOf } from "./look.js";

const HEIGHT: Record<string, number> = { small: 96, normal: 160, large: 240 };

/** An x that reads as a time in ms is shown as a clock; anything else as written. */
const word = (x: SlateJson | undefined): string => (typeof x === "number" && x > 1e12 ? fmtClock(x).slice(0, 5) : (str(x) ?? ""));

const STEPS = [1, 2, 2.5, 5];

/** The axis in four round steps holding every value: from 0 when the values sit nearer 0 than their spread, and a
 * band of 2 percent of the value (or 1) around a flat line. */
export function chartAxis(values: readonly number[]): { from: number; to: number } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const band = hi > lo ? 0 : (Math.abs(lo) * 0.02 || 1) / 2;
  const low = lo >= 0 && lo <= hi - lo ? 0 : lo - band;
  const high = hi + band;
  const tidy = (v: number): number => Number(v.toPrecision(12));
  let magnitude = 10 ** Math.floor(Math.log10((high - low) / 4));
  for (let i = 0; ; i++) {
    if (i === STEPS.length) (i = 0), (magnitude *= 10);
    const step = STEPS[i]! * magnitude;
    if (step * 4 < high - low) continue;
    const from = tidy(Math.floor(tidy(low / step)) * step);
    if (from + step * 4 >= high) return { from, to: tidy(from + step * 4) };
  }
}

export const chart: PieceView = {
  type: "chart",
  rowScoped: ["x", "value"],
  component: ({ id, piece, props, slate }) => {
    const label = str(props["label"]) ?? "";
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const rows = items.map((item, index) => ({
      x: piece.props?.["x"] === undefined ? index : slate.resolve(piece.props["x"], { item, index }),
      v: slate.resolve(piece.props?.["value"], { item, index }),
    })).filter((r): r is { x: SlateJson | undefined; v: number } => typeof r.v === "number" && Number.isFinite(r.v));
    const unit = str(props["unit"]);
    const shown = (v: number): string => `${figure(v, props["format"]) ?? ""}${unit === undefined ? "" : ` ${unit}`}`;
    const values = rows.length === 1 ? [rows[0]!.v, rows[0]!.v] : rows.map(r => r.v);
    const tone = props["tone"] === undefined ? "accent" : toneOf(props["tone"], slate, id);
    return (
      <figure data-slate-chart className="flex min-w-0 flex-col gap-2">
        <figcaption className="text-[13px] leading-5 text-foreground">{label}</figcaption>
        {rows.length === 0 ? (
          <span className="text-[11px] leading-4 text-muted-foreground">not read yet</span>
        ) : (
          <UsageChart
            steps={values.map((_, i) => i)}
            lines={[{ key: "line", label, points: values, ink: { className: TONE_INK[tone] } }]}
            stepWord={i => word(rows[Math.min(i, rows.length - 1)]?.x)}
            ticks={rows.length === 1 ? [{ at: 1, word: word(rows[0]!.x) }] : [{ at: 0, word: word(rows[0]!.x) }, { at: 1, word: word(rows.at(-1)!.x) }]}
            height={HEIGHT[String(props["height"] ?? "normal")] ?? HEIGHT["normal"]}
            figure={shown}
            label={label}
            axis={chartAxis(values)}
          />
        )}
      </figure>
    );
  },
};
