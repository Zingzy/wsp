// SPDX-License-Identifier: AGPL-3.0-only
// The settings grammar's one rule for what stands where: a section, and the page around the sections, lay their
// children out as soft cards whose rows are the children, with a hairline between rows. Pieces that are not rows
// stand bare between the cards: a head, a chart or diagram, prose (markdown or text), a button under its card, a
// toolbar of controls, a table with its header over its own card, and a section of its own.
import { cn } from "../../lib/utils.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import type { SlateEngine } from "../engine.js";
import { flagOf, PieceHost, useShown } from "../SlateView.js";
import { viewOf } from "./registry.js";
import { isNoteText } from "./look.js";
import { isStrip, riddenBy } from "./riders.js";
import { BarSwitch } from "./barswitch.js";

/** Whether a group lays its children out in cards: a section, the slate's root column, and a column standing in such
 * a group. A column in a card's row is layout alone. */
export function isGroup(slate: SlateEngine, id: string): boolean {
  return flagOf(viewOf(slate.piece(id)?.type)?.group, slate, id, false);
}

/** A row of controls and no words: the slate's toolbar, bare above the cards. */
export function isToolbar(slate: SlateEngine, id: string): boolean {
  const piece = slate.piece(id);
  if (piece?.type !== "row") return false;
  const children = piece.children ?? [];
  return children.length > 0 && children.every(child => viewOf(slate.piece(child)?.type)?.control === true);
}

/** Whether a piece in a group is a row of a card. */
export function isCardRow(slate: SlateEngine, id: string): boolean {
  const piece = slate.piece(id);
  return piece !== undefined && flagOf(viewOf(piece.type)?.card, slate, id, true);
}

/** Where a piece stands: a row of a card, inside such a row, or bare on the page between cards. */
export type Place = "row" | "inside" | "page";
export function placeOf(slate: SlateEngine, id: string): Place {
  const parent = slate.parentId(id);
  if (parent === undefined) return "page";
  if (isGroup(slate, parent)) return isCardRow(slate, id) ? "row" : "page";
  return "inside";
}

/** A grid or row holding bar lists and nothing else. */
export function isBarHolder(slate: SlateEngine, id: string): boolean {
  const piece = slate.piece(id);
  const children = piece?.children ?? [];
  return (piece?.type === "grid" || piece?.type === "row") && children.length > 0 && children.every(child => slate.piece(child)?.type === "bars");
}

/** Bar lists switched in one card under a segmented control: two or more written one
 * after another, or any held in a grid or row of nothing else. */
export function inBarSwitch(slate: SlateEngine, id: string): boolean {
  if (slate.piece(id)?.type !== "bars") return false;
  const parent = slate.parentId(id);
  if (parent !== undefined && isBarHolder(slate, parent)) return true;
  const siblings = parent === undefined ? [] : (slate.piece(parent)?.children ?? []);
  const at = siblings.indexOf(id);
  return [siblings[at - 1], siblings[at + 1]].some(other => other !== undefined && slate.piece(other)?.type === "bars");
}

/** A card of rows: each row at the card's inset, 12 px above and below, unless it draws its own rows edge to edge. */
const CARD = cn(
  CARD_SURFACE,
  "flex min-w-0 flex-col empty:hidden [&>:empty]:!hidden [&>*+*]:border-t [&>*+*]:border-border/50",
  "[&>:not([data-slate-rows])]:flex [&>:not([data-slate-rows])]:min-h-11 [&>:not([data-slate-rows])]:flex-col [&>:not([data-slate-rows])]:justify-center",
  "[&>:not([data-slate-rows])]:px-(--settings-inset,20px) [&>:not([data-slate-rows])]:py-3",
);

/** A group's children, the rows among them gathered into cards and the rest bare between. */
export function Runs({ slate, ids: all }: { slate: SlateEngine; ids: readonly string[] }) {
  // A hidden piece takes no place among its siblings: it neither starts a card nor joins one.
  const ids = useShown(slate, all);
  const runs: { key: string; card?: string[]; lists?: string[] }[] = [];
  for (const id of ids) {
    const last = runs.at(-1);
    // Bar lists, and grids or rows of nothing else, one after another share one switch.
    if (inBarSwitch(slate, id) || isBarHolder(slate, id)) {
      const lists = isBarHolder(slate, id) ? (slate.piece(id)?.children ?? []) : [id];
      if (last?.lists !== undefined) last.lists.push(...lists);
      else runs.push({ key: id, lists: [...lists] });
    }
    // A status and its text riding a number's note draw nothing, so they join the number's card, where they take no row.
    else if (riddenBy(slate, id) !== undefined && last?.card !== undefined) last.card.push(id);
    // A meta line among rows is a row of their card; after a chart or a list it stands bare as its foot, as prose does.
    else if (isNoteText(slate, id) && last?.card !== undefined) last.card.push(id);
    else if (!isCardRow(slate, id)) runs.push({ key: id });
    else if (last?.card !== undefined) last.card.push(id);
    else runs.push({ key: id, card: [id] });
  }
  return (
    <>
      {runs.map(run =>
        run.lists !== undefined ? (
          <BarSwitch key={run.key} slate={slate} ids={run.lists} />
        ) : run.card === undefined ? (
          <PieceHost key={run.key} id={run.key} />
        ) : (
          <div key={run.key} data-slate-card className={CARD}>
            {run.card.map(id => (
              <PieceHost key={id} id={id} />
            ))}
          </div>
        ),
      )}
    </>
  );
}
