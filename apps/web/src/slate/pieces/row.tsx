// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { gapOf } from "./look.js";
import { Strip } from "./grid.js";
import { isStatCell, isStrip } from "./riders.js";
import { BarSwitch } from "./barswitch.js";
import { isBarHolder } from "./runs.js";

const ALIGN: Record<string, string> = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between" };
/** With no align set, the buttons, the state word and a list of facts after the row's text sit at its end, and a
 * filter beside a picker at the toolbar's. */
const ENDS =
  "[&>:not([data-slate-type=button])+[data-slate-type=button]]:ml-auto [&>[data-slate-type=select]+[data-slate-type=toggle]]:ml-auto [&>:not([data-slate-type=status])+[data-slate-type=status]]:ml-auto [&>:not([data-slate-type=facts])+[data-slate-type=facts]]:ml-auto";

export const row: PieceView = {
  type: "row",
  // A row of one number and the words that ride its note is that number's stat cell, padded as one; a row of numbers is
  // the stat strip.
  fills: (slate, id) => isStatCell(slate, id) || isStrip(slate, id),
  component: ({ id, piece, props, slate, children }) =>
    isBarHolder(slate, id) ? (
      <BarSwitch slate={slate} ids={slate.piece(id)?.children ?? []} />
    ) : isStrip(slate, id) ? (
      <Strip id={id} slate={slate} />
    ) : (
    <div
      className={cn(
        // Beside a number, the rest stands on the figure's line, not halfway between its label and its figure.
        "flex min-w-0 flex-row [&>:empty]:!hidden",
        (piece.children ?? []).some(child => slate.piece(child)?.type === "number") ? "items-baseline-last" : "items-center",
        gapOf(props["gap"]),
        ALIGN[String(props["align"] ?? "start")] ?? ALIGN["start"],
        props["align"] === undefined && ENDS,
        props["wrap"] === false ? "flex-nowrap *:min-w-0 *:shrink" : "flex-wrap",
      )}
    >
      {children}
    </div>
    ),
};
