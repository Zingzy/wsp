// SPDX-License-Identifier: AGPL-3.0-only
// A line over a list, drawn by the Usage page's own chart: x and value read per row, oldest first.
import { fmtClock, type SlateJson } from "@wsp/protocol";
import { UsageChart } from "../../settings/usageChart.js";
import type { PieceView } from "../SlateView.js";
import { figure, str, TONE_INK, toneOf } from "./look.js";

const HEIGHT: Record<string, number> = { small: 96, normal: 160, large: 240 };

/** An x that reads as a time in ms is shown as a clock; anything else as written. */
const word = (x: SlateJson | undefined): string => (typeof x === "number" && x > 1e12 ? fmtClock(x).slice(0, 5) : (str(x) ?? ""));

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
    const values = rows.map(r => r.v);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const from = values.length > 0 && lo > 0 && lo > hi - lo ? lo - (hi - lo || Math.abs(lo) * 0.01) : 0;
    const tone = props["tone"] === undefined ? "accent" : toneOf(props["tone"], slate, id);
    return (
      <figure data-slate-chart className="flex min-w-0 flex-col gap-2">
        <figcaption className="text-[13px] leading-5 text-foreground">{label}</figcaption>
        {rows.length < 2 ? (
          <span className="text-[11px] leading-4 text-muted-foreground">{rows.length === 0 ? "not read yet" : `${shown(rows[0]!.v)}, one point so far`}</span>
        ) : (
          <UsageChart
            steps={rows.map((_, i) => i)}
            lines={[{ key: "line", label, points: values, ink: { className: TONE_INK[tone] } }]}
            stepWord={i => word(rows[i]?.x)}
            ticks={[{ at: 0, word: word(rows[0]!.x) }, { at: 1, word: word(rows.at(-1)!.x) }]}
            height={HEIGHT[String(props["height"] ?? "normal")] ?? HEIGHT["normal"]}
            figure={shown}
            label={label}
            from={from}
          />
        )}
      </figure>
    );
  },
};
