// SPDX-License-Identifier: AGPL-3.0-only
// Children in equal columns 16 px apart. Numbers alone in a grid, row or column are the Usage page's stat strip: one card split into equal
// cells with hairlines between them, at most three across in the 400 px panel and more once widened, as many as
// their figures fit, wrapping to further rows with a hairline between rows.
import { cn } from "../../lib/utils.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import type { SlateEngine } from "../engine.js";
import { PieceHost, type PieceView } from "../SlateView.js";
import { figure, str } from "./look.js";
import { isStrip, stripCells } from "./riders.js";
import { placeOf } from "./runs.js";

/** Columns from 360 px of the grid's own width; under it, one column. Whole class names, so Tailwind finds them. */
const COLUMNS: Record<number, string> = { 2: "@min-[360px]:grid-cols-2", 3: "@min-[360px]:grid-cols-3", 4: "@min-[360px]:grid-cols-4" };
const PLACE: Record<string, string> = { start: "justify-items-start", center: "justify-items-center text-center", end: "justify-items-end text-right" };

/** The card's inner width a strip can count on: the 400 px panel's, and the least a widened panel's (34rem). */
const NARROW = 366;
const WIDE = 542;
/** One character of the 26 px mono figure, and a 12 px unit with its 4 px gap per character. */
const FIGURE_CH = 15.6;
const UNIT_CH = 7.2;

/** Cells per row: the most whose figures fit their cells (at most three in the narrow panel), then the count near it
 * that leaves the last row fullest, the larger on a tie. */
function across(count: number, widest: number, room: number, cap: number): number {
  const fits = (c: number) => c * (widest + (c >= 3 ? 24 : 32)) <= room;
  let most = Math.min(count, cap);
  while (most > 1 && !fits(most)) most--;
  let best = most;
  for (let c = most; c >= Math.max(1, Math.ceil(most / 2)); c--) if ((c - (count % c)) % c < (best - (count % best)) % best) best = c;
  return best;
}

/** A strip's cells, as whole class names so Tailwind finds them: per cells a row, equal columns, a hairline left of
 * every cell but a row's first and above every row but the first. Narrow under 34rem of the card, wide from it. */
const NARROW_CELLS: Record<number, string> = {
  1: "@max-[34rem]:grid-cols-1 @max-[34rem]:[&>*:nth-child(n+2)]:border-t",
  2: "@max-[34rem]:grid-cols-2 @max-[34rem]:[&>*:not(:nth-child(2n+1))]:border-l @max-[34rem]:[&>*:nth-child(n+3)]:border-t",
  3: "@max-[34rem]:grid-cols-3 @max-[34rem]:[&>*:not(:nth-child(3n+1))]:border-l @max-[34rem]:[&>*:nth-child(n+4)]:border-t",
};
const WIDE_CELLS: Record<number, string> = {
  1: "@min-[34rem]:grid-cols-1 @min-[34rem]:[&>*:nth-child(n+2)]:border-t",
  2: "@min-[34rem]:grid-cols-2 @min-[34rem]:[&>*:not(:nth-child(2n+1))]:border-l @min-[34rem]:[&>*:nth-child(n+3)]:border-t",
  3: "@min-[34rem]:grid-cols-3 @min-[34rem]:[&>*:not(:nth-child(3n+1))]:border-l @min-[34rem]:[&>*:nth-child(n+4)]:border-t",
  4: "@min-[34rem]:grid-cols-4 @min-[34rem]:[&>*:not(:nth-child(4n+1))]:border-l @min-[34rem]:[&>*:nth-child(n+5)]:border-t",
  5: "@min-[34rem]:grid-cols-5 @min-[34rem]:[&>*:not(:nth-child(5n+1))]:border-l @min-[34rem]:[&>*:nth-child(n+6)]:border-t",
  6: "@min-[34rem]:grid-cols-6 @min-[34rem]:[&>*:not(:nth-child(6n+1))]:border-l @min-[34rem]:[&>*:nth-child(n+7)]:border-t",
};
/** Cell padding by cells a row: the stat cell's 16 px, 12 px once three or more share the row. */
const NARROW_PAD: Record<number, string> = { 1: "@max-[34rem]:[&>*]:px-(--settings-inset,20px)", 2: "@max-[34rem]:[&>*]:px-(--settings-inset,20px)", 3: "@max-[34rem]:[&>*]:px-3" };
const WIDE_PAD = (c: number): string => (c >= 3 ? "@min-[34rem]:[&>*]:px-3" : "@min-[34rem]:[&>*]:px-(--settings-inset,20px)");

/** The stat strip: a number cell per number, the words riding their notes drawn by the numbers. */
export function Strip({ id, slate }: { id: string; slate: SlateEngine }) {
  // The panel decides how many cells stand across, never the agent's columns: at most three in the narrow panel.
  const cells = stripCells(slate, id) ?? [];
  const widest = Math.max(0, ...cells.map(child => {
    const p = slate.piece(child)?.props ?? {};
    const unit = str(slate.resolve(p["unit"]));
    return (figure(slate.resolve(p["value"]), slate.resolve(p["format"]))?.length ?? 0) * FIGURE_CH + (unit === undefined ? 0 : unit.length * UNIT_CH + 4);
  }));
  const narrow = across(cells.length, widest, NARROW, 3);
  const wide = across(cells.length, widest, WIDE, 6);
  return (
    <div data-slate-grid data-slate-strip data-across={`${narrow} ${wide}`} className={cn("@container min-w-0", placeOf(slate, id) === "page" && CARD_SURFACE)}>
      <div className={cn("grid min-w-0 [&>*]:border-border/50 [&>*]:pt-4 [&>*]:pb-3.5", NARROW_CELLS[narrow], NARROW_PAD[narrow], WIDE_CELLS[wide], WIDE_PAD(wide))}>
        {cells.map(cell => (
          <PieceHost key={cell} id={cell} />
        ))}
      </div>
    </div>
  );
}

export const grid: PieceView = {
  type: "grid",
  fills: isStrip,
  component: ({ id, props, slate, children }) =>
    isStrip(slate, id) ? (
      <Strip id={id} slate={slate} />
    ) : (
      <div data-slate-grid className="@container min-w-0">
        <div data-columns={props["columns"]} className={cn("grid min-w-0 grid-cols-1 gap-4", COLUMNS[Number(props["columns"])] ?? COLUMNS[2], PLACE[String(props["align"])])}>
          {children}
        </div>
      </div>
    ),
};
