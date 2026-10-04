// SPDX-License-Identifier: AGPL-3.0-only
import type { SlateJson } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { str, TONE_INK, toneOf, type Tone } from "./look.js";

const W = 64;
const H = 16;

export const numbersOf = (value: SlateJson | undefined): number[] =>
  Array.isArray(value) ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : [];

/** A 64 by 16 line over its own range; under two points there is no line to draw. */
export function Sparkline({ values, tone = "accent", ink, label }: { values: readonly number[]; tone?: Tone; ink?: string; label?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const points = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(2)},${(H - 1 - ((v - lo) / span) * (H - 2)).toFixed(2)}`).join(" ");
  return (
    <svg data-slate-sparkline role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} className={cn("h-4 w-16 shrink-0 overflow-visible", ink ?? TONE_INK[tone])}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export const sparkline: PieceView = {
  type: "sparkline",
  component: ({ id, props, slate }) => {
    const label = str(props["label"]) ?? "";
    const values = numbersOf(props["values"]);
    // The line takes the meter's ink, so a chart stays the slate's one coloured thing; a tone the agent named still holds.
    const tone = props["tone"] === undefined ? undefined : toneOf(props["tone"], slate, id);
    const last = values.at(-1);
    return (
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm leading-5 text-foreground">{label}</span>
        {values.length === 0 ? (
          <span className="text-xs leading-4 text-muted-foreground">Not read yet</span>
        ) : (
          <span className="flex shrink-0 items-center gap-3">
            <Sparkline values={values} {...(tone === undefined ? { ink: "text-foreground/55" } : { tone })} label={label} />
            {last === undefined ? null : <span className="font-mono text-xs leading-5 tabular-nums text-foreground">{last.toLocaleString("en-US")}</span>}
          </span>
        )}
      </div>
    );
  },
};
