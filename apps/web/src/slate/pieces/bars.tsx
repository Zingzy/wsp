// SPDX-License-Identifier: AGPL-3.0-only
// Categories compared, as the Computers page's load cell: the label as the list's head over a card, each row the name
// at 14 px and at the right the 56 by 4 meter with its figure, a hairline between rows.
import type { PieceView } from "../SlateView.js";
import { cn } from "../../lib/utils.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import { SECTION_HEAD } from "../../settings/layout.js";
import { figure, num, str, TONE_FILL, toneOf } from "./look.js";
import { placeOf } from "./runs.js";

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
    const place = placeOf(slate, id);
    const inset = place === "inside" ? "" : "px-(--settings-inset,20px)";
    return (
      <div className="flex min-w-0 flex-col gap-2.5">
        <span className={SECTION_HEAD}>{str(props["label"])}</span>
        <div className={cn("flex min-w-0 flex-col [&>*+*]:border-t [&>*+*]:border-border/50", place !== "inside" && CARD_SURFACE)}>
          {rows.length === 0 ? <span className={cn("flex min-h-11 items-center py-3 text-[13px] leading-5 text-muted-foreground", inset)}>Nothing here</span> : null}
          {rows.map((row, at) => {
            const share = row.value === undefined || max <= 0 ? 0 : Math.max(0, Math.min(1, row.value / max));
            return (
              <div key={at} data-slate-bar className={cn("flex min-h-11 min-w-0 items-center gap-3 py-3", inset)}>
                <span className="min-w-0 flex-1 truncate text-sm leading-5 text-foreground">{row.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span aria-hidden className="block h-1 w-14 overflow-hidden rounded-full bg-foreground/10">
                    <span className={cn("block h-full rounded-full", row.tone === undefined ? "bg-foreground/55" : TONE_FILL[toneOf(row.tone, slate, id)])} style={{ width: `${Math.round(share * 1000) / 10}%` }} />
                  </span>
                  <span className="min-w-12 text-right font-mono text-xs leading-5 tabular-nums text-foreground">{format === "none" ? null : format === "percent" ? `${Math.round(share * 100)}%` : figure(row.value, "integer")}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
};
