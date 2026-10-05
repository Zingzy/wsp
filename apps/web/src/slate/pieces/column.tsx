// SPDX-License-Identifier: AGPL-3.0-only
// The slate's root column, and a column standing among its cards, gathers its children into cards 12 px apart, each
// section 24 px clear of what is beside it. A column inside a card's row is layout alone.
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { gapOf } from "./look.js";
import { Strip } from "./grid.js";
import { isStrip, riddenBy } from "./riders.js";
import { isGroup, Runs } from "./runs.js";

/** Sections stand 32 px from what is beside them: the column's 12 px gap and 20 more. */
const SECTIONS_APART = "[&>[data-slate-type=section]:not(:first-child)]:mt-5 [&>[data-slate-type=section]+*]:mt-5";
const ALIGN: Record<string, string> = { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch" };

export const column: PieceView = {
  type: "column",
  // A column of a status and its text beside a number rides that number's note.
  fills: isStrip,
  component: ({ id, piece, props, slate, children }) =>
    riddenBy(slate, id) !== undefined ? null : isStrip(slate, id) ? (
      <Strip id={id} slate={slate} />
    ) : isGroup(slate, id) ? (
      <div data-slate-group className={cn("flex min-w-0 flex-col gap-3 [&>:empty]:!hidden", SECTIONS_APART)}>
        <Runs slate={slate} ids={piece.children ?? []} />
      </div>
    ) : (
      <div className={cn("flex min-w-0 flex-col", gapOf(props["gap"]), ALIGN[String(props["align"] ?? "stretch")] ?? ALIGN["stretch"])}>{children}</div>
    ),
};
