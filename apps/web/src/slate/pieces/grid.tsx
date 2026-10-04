// SPDX-License-Identifier: AGPL-3.0-only
// Children in equal columns 16 px apart. A grid of numbers is the Usage page's stat strip: one card split into cells
// by hairlines, side by side once the strip is wide enough for its figures, stacked under that.
import { cn } from "../../lib/utils.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import type { PieceView } from "../SlateView.js";
import { figure, str } from "./look.js";
import { isStrip } from "./number.js";
import { placeOf } from "./runs.js";

/** Columns from 360 px of the grid's own width; under it, one column. Whole class names, so Tailwind finds them. */
const COLUMNS: Record<number, string> = { 2: "@min-[360px]:grid-cols-2", 3: "@min-[360px]:grid-cols-3", 4: "@min-[360px]:grid-cols-4" };
/** A strip's columns once two 26 px figures fit side by side at the card's inset. */
const STRIP_COLUMNS: Record<number, string> = { 2: "@min-[34rem]:grid-cols-2", 3: "@min-[34rem]:grid-cols-3", 4: "@min-[34rem]:grid-cols-4" };
/** A strip whose figures fit the 400 px panel's 336 px of content stands across from the start. */
const ACROSS: Record<number, string> = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" };
const ACROSS_CELLS = "[&>*]:border-border/50 [&>*]:px-(--settings-inset,20px) [&>*]:pt-4 [&>*]:pb-3.5 [&>*+*]:border-l";
const PANEL_CONTENT = 336;
/** One character of the 26 px mono figure. */
const FIGURE_CH = 15.6;
const PLACE: Record<string, string> = { start: "justify-items-start", center: "justify-items-center text-center", end: "justify-items-end text-right" };
/** A strip's cells: the card's inset, 16 px above and 14 below, a hairline between side by side or stacked. */
const CELLS =
  "[&>*]:border-border/50 [&>*]:px-(--settings-inset,20px) [&>*]:pt-4 [&>*]:pb-3.5 [&>*+*]:border-t @min-[34rem]:[&>*+*]:border-t-0 @min-[34rem]:[&>*+*]:border-l";

export const grid: PieceView = {
  type: "grid",
  fills: isStrip,
  component: ({ id, props, slate, children }) => {
    if (isStrip(slate, id)) {
      const count = Number(props["columns"]) || 2;
      // Side by side in the 400 px panel only when every 26 px figure fits its cell; else stacked until the panel widens.
      const widest = Math.max(0, ...(slate.piece(id)?.children ?? []).map(child => {
        const p = slate.piece(child)?.props ?? {};
        return (figure(slate.resolve(p["value"]), slate.resolve(p["format"]))?.length ?? 0) + (str(slate.resolve(p["unit"]))?.length ?? 0);
      }));
      const across = count * (widest * FIGURE_CH + (count >= 3 ? 24 : 32)) <= PANEL_CONTENT;
      return (
        <div data-slate-grid data-slate-strip className={cn("@container min-w-0", placeOf(slate, id) === "page" && CARD_SURFACE)}>
          <div data-columns={props["columns"]} className={cn("grid min-w-0 grid-cols-1", across ? ACROSS[count] : (STRIP_COLUMNS[count] ?? STRIP_COLUMNS[2]), across ? ACROSS_CELLS : CELLS, count >= 3 && "[&>*]:p-3")}>
            {children}
          </div>
        </div>
      );
    }
    return (
      <div data-slate-grid className="@container min-w-0">
        <div data-columns={props["columns"]} className={cn("grid min-w-0 grid-cols-1 gap-4", COLUMNS[Number(props["columns"])] ?? COLUMNS[2], PLACE[String(props["align"])])}>
          {children}
        </div>
      </div>
    );
  },
};
