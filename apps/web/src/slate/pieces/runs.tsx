// SPDX-License-Identifier: AGPL-3.0-only
// The settings grammar's one rule for what stands where: a section, and the page around the sections, lay their
// children out as soft cards whose rows are the children, with a hairline between rows. Pieces that are not rows
// stand bare between the cards: a head, a chart, a meta line, a button under its card, a toolbar of controls, a
// table with its header over its own card, and a section of its own.
import { cn } from "../../lib/utils.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import type { SlateEngine } from "../engine.js";
import { PieceHost } from "../SlateView.js";
import { isNoteText } from "./look.js";
import { riddenBy } from "./riders.js";

/** Pieces a person acts with, which make a row of their own a toolbar when it holds nothing else. */
const CONTROLS: ReadonlySet<string> = new Set(["button", "select", "toggle", "input"]);

/** Whether a group lays its children out in cards: a section, the slate's root column, and a column standing in such
 * a group. A column in a card's row is layout alone. */
export function isGroup(slate: SlateEngine, id: string): boolean {
  const type = slate.piece(id)?.type;
  if (type === "section") return true;
  if (type !== "column") return false;
  const parent = slate.parentId(id);
  return parent === undefined || isGroup(slate, parent);
}

/** A row of controls and no words: the slate's toolbar, bare above the cards. */
export function isToolbar(slate: SlateEngine, id: string): boolean {
  const piece = slate.piece(id);
  if (piece?.type !== "row") return false;
  const types = (piece.children ?? []).map(child => slate.piece(child)?.type ?? "");
  return types.length > 0 && types.every(type => CONTROLS.has(type));
}

/** Whether a piece in a group is a row of a card. */
export function isCardRow(slate: SlateEngine, id: string): boolean {
  const piece = slate.piece(id);
  if (piece === undefined) return false;
  switch (piece.type) {
    case "section":
    case "heading":
    case "chart":
    case "button":
    case "table":
    case "bars":
      return false;
    case "column":
      return !isGroup(slate, id);
    case "row":
      return !isToolbar(slate, id) && !(piece.children ?? []).some(child => slate.piece(child)?.type === "heading");
    case "text":
      return !isNoteText(slate, id);
    default:
      return true;
  }
}

/** Where a piece stands: a row of a card, inside such a row, or bare on the page between cards. */
export type Place = "row" | "inside" | "page";
export function placeOf(slate: SlateEngine, id: string): Place {
  const parent = slate.parentId(id);
  if (parent === undefined) return "page";
  if (isGroup(slate, parent)) return isCardRow(slate, id) ? "row" : "page";
  return "inside";
}

/** A card of rows: each row at the card's inset, 12 px above and below, unless it draws its own rows edge to edge. */
const CARD = cn(
  CARD_SURFACE,
  "flex min-w-0 flex-col empty:hidden [&>:empty]:hidden [&>*+*]:border-t [&>*+*]:border-border/50",
  "[&>:not([data-slate-rows])]:flex [&>:not([data-slate-rows])]:min-h-11 [&>:not([data-slate-rows])]:flex-col [&>:not([data-slate-rows])]:justify-center",
  "[&>:not([data-slate-rows])]:px-(--settings-inset,20px) [&>:not([data-slate-rows])]:py-3",
);

/** A group's children, the rows among them gathered into cards and the rest bare between. */
export function Runs({ slate, ids }: { slate: SlateEngine; ids: readonly string[] }) {
  const runs: { key: string; card?: string[] }[] = [];
  for (const id of ids) {
    const last = runs.at(-1);
    // A status and its text riding a number's note draw nothing, so they join the number's card, where they take no row.
    if (riddenBy(slate, id) !== undefined && last?.card !== undefined) last.card.push(id);
    // A meta line among rows is a row of their card; after a chart or a list it stands bare as its foot.
    else if (isNoteText(slate, id) && last?.card !== undefined) last.card.push(id);
    else if (!isCardRow(slate, id)) runs.push({ key: id });
    else if (last?.card !== undefined) last.card.push(id);
    else runs.push({ key: id, card: [id] });
  }
  return (
    <>
      {runs.map(run =>
        run.card === undefined ? (
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
