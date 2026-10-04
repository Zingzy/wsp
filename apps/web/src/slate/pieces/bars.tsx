// SPDX-License-Identifier: AGPL-3.0-only
// Categories compared: rows of name, track and figure in the meter's grammar, no line between them.
import type { PieceView } from "../SlateView.js";
import { cn } from "../../lib/utils.js";
import { figure, num, str, TONE_FILL, toneOf } from "./look.js";

export const bars: PieceView = {
  type: "bars",
  rowScoped: ["name", "value", "tone", "key"],
  component: ({ id, piece, props, slate }) => {
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const rows = items.map((item, index) => ({
      name: str(slate.resolve(piece.props?.["name"], { item, index })) ?? "",
      value: num(slate.resolve(piece.props?.["value"], { item, index })),
      tone: piece.props?.["tone"] === undefined ? undefined : slate.resolve(piece.props["tone"], { item, index }),
    }));
    const max = num(props["max"]) ?? Math.max(0, ...rows.map(r => r.value ?? 0));
    const format = props["format"] ?? "value";
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[13px] leading-5 text-foreground">{str(props["label"])}</span>
        {rows.length === 0 ? <span className="text-[11px] leading-4 text-muted-foreground">Nothing here</span> : null}
        {rows.map((row, at) => {
          const share = row.value === undefined || max <= 0 ? 0 : Math.max(0, Math.min(1, row.value / max));
          return (
            <div key={at} data-slate-bar className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-3">
              <span className="truncate text-[13px] leading-5 text-muted-foreground">{row.name}</span>
              <span aria-hidden className="block h-1 w-full overflow-hidden rounded-full bg-foreground/10">
                <span className={cn("block h-full rounded-full", row.tone === undefined ? "bg-foreground/55" : TONE_FILL[toneOf(row.tone, slate, id)])} style={{ width: `${Math.round(share * 1000) / 10}%` }} />
              </span>
              <span className="font-mono text-xs tabular-nums text-foreground">{format === "none" ? null : format === "percent" ? `${Math.round(share * 100)}%` : figure(row.value, "plain")}</span>
            </div>
          );
        })}
      </div>
    );
  },
};
