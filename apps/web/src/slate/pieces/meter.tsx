// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { figure, num, str, TONE_FILL, toneOf } from "./look.js";

/** The figure right of the label, in the word the meter's format names. */
function meterFigure(value: number, max: number, format: string): string | undefined {
  switch (format) {
    case "none":
      return undefined;
    case "value":
      return figure(value, "plain");
    case "fraction":
      return `${figure(value, "plain")}/${figure(max, "plain")}`;
    case "tokens":
    case "bytes":
      return figure(value, format);
    default:
      return `${Math.round((value / max) * 100)}%`;
  }
}

export const meter: PieceView = {
  type: "meter",
  component: ({ id, props, slate }) => {
    const label = str(props["label"]) ?? "";
    const value = num(props["value"]);
    const max = num(props["max"]) ?? 100;
    const note = str(props["note"]);
    const share = value === undefined || max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
    const shown = value === undefined || max <= 0 ? undefined : meterFigure(value, max, String(props["format"] ?? "percent"));
    return (
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        {...(value !== undefined ? { "aria-valuenow": value } : {})}
        className="flex min-w-0 items-center justify-between gap-4"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm leading-5 font-medium text-foreground">{label}</span>
          {value !== undefined && note === undefined ? null : <span className="text-[13px] leading-[1.45] text-muted-foreground">{value === undefined ? "Not read yet" : note}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span aria-hidden className="block h-1 w-14 overflow-hidden rounded-full bg-foreground/10">
            <span
              data-slate-fill
              className={cn("block h-full rounded-full transition-[width,background-color] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none", TONE_FILL[toneOf(props["tone"], slate, id)])}
              style={{ width: `${Math.round(share * 1000) / 10}%` }}
            />
          </span>
          {shown === undefined ? null : <span className="font-mono text-xs tabular-nums text-foreground">{shown}</span>}
        </span>
      </div>
    );
  },
};
