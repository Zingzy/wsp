// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { figure, num, str, TONE_INK, toneOf } from "./look.js";

const R = 15;
const ROUND = 2 * Math.PI * R;

function ringFigure(value: number, max: number, format: string): string | undefined {
  if (format === "value") return figure(value, "plain");
  if (format === "fraction") return `${figure(value, "plain")}/${figure(max, "plain")}`;
  return `${Math.round((value / max) * 100)}%`;
}

export const ring: PieceView = {
  type: "ring",
  component: ({ id, props, slate }) => {
    const label = str(props["label"]) ?? "";
    const value = num(props["value"]);
    const max = num(props["max"]) ?? 100;
    const share = value === undefined || max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
    const tone = toneOf(props["tone"], slate, id);
    const note = str(props["note"]);
    return (
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} {...(value !== undefined ? { "aria-valuenow": value } : {})} className="flex min-w-0 items-center gap-3">
        <span className="relative grid size-11 shrink-0 place-items-center">
          <svg aria-hidden viewBox="0 0 36 36" className="absolute inset-0 size-full -rotate-90">
            <circle cx={18} cy={18} r={R} fill="none" strokeWidth={3} className="stroke-foreground/10" />
            <circle
              data-slate-fill
              cx={18} cy={18} r={R} fill="none" strokeWidth={3} strokeLinecap="round" stroke="currentColor"
              strokeDasharray={ROUND} strokeDashoffset={ROUND * (1 - share)}
              className={cn("transition-[stroke-dashoffset] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none", tone === "default" ? "text-foreground/55" : TONE_INK[tone])}
            />
          </svg>
          <span className="font-mono text-[11px] leading-4 tabular-nums text-foreground">{value === undefined || max <= 0 ? null : ringFigure(value, max, String(props["format"] ?? "percent"))}</span>
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] leading-5 text-foreground">{label}</span>
          <span className="text-xs leading-4 text-muted-foreground">{value === undefined ? "Not read yet" : note}</span>
        </span>
      </div>
    );
  },
};
