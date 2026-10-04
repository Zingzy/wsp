// SPDX-License-Identifier: AGPL-3.0-only
// The one rule for what stands where (the owner's V3 with his picks, 2026-10-05): a section, and the page around the
// sections, lay out their children as rows. Rows a person acts on and the slate's figures take one soft card; every
// other row stands bare on hairlines, as Usage's By agent. Pieces that are not rows stand bare between: a head, a
// chart, a meta line, a button under its card, a toolbar of controls, a table with its header over its own card or bare,
// bar lists in their switch, and a section of its own.
import { cn } from "../../lib/utils.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import type { SlateEngine } from "../engine.js";
import { PieceHost } from "../SlateView.js";
import { isNoteText } from "./look.js";
import { isStatCell, isStrip, riddenBy } from "./riders.js";
import { BarSwitch } from "./barswitch.js";

/** Pieces a person acts with, which make a row of their own a toolbar when it holds nothing else. */
const CONTROLS: ReadonlySet<string> = new Set(["button", "select", "toggle", "input"]);

/** Whether a group lays its children out in cards: a section, the slate's root column, and a column standing in such
 * a group. A column in a card's row is layout alone. */
export function isGroup(slate: SlateEngine, id: string): boolean {
  const type = slate.piece(id)?.type;
  if (type === "section") return true;
  if (type !== "column" || isStrip(slate, id)) return false;
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

/** Rows a person acts on, or the slate's figures: these take the soft card. Every other row stands bare on hairlines. */
const CARDED: ReadonlySet<string> = new Set(["number", "choices", "input", "select", "toggle", "checklist"]);

export function isCarded(slate: SlateEngine, id: string): boolean {
  const piece = slate.piece(id);
  if (piece === undefined) return false;
  if (CARDED.has(piece.type)) return true;
  if (isStrip(slate, id) || isStatCell(slate, id)) return true;
  // A row or cell holding a control is a control line.
  return (piece.type === "row" || piece.type === "column") && (piece.children ?? []).some(child => isCarded(slate, child));
}

/** A grid or row holding bar lists and nothing else. */
export function isBarHolder(slate: SlateEngine, id: string): boolean {
  const piece = slate.piece(id);
  const children = piece?.children ?? [];
  return (piece?.type === "grid" || piece?.type === "row") && children.length > 0 && children.every(child => slate.piece(child)?.type === "bars");
}

/** Bar lists switched in one card under a segmented control: two or more written one after another, or any held in a
 * grid or row of nothing else. */
export function inBarSwitch(slate: SlateEngine, id: string): boolean {
  if (slate.piece(id)?.type !== "bars") return false;
  const parent = slate.parentId(id);
  if (parent !== undefined && isBarHolder(slate, parent)) return true;
  const siblings = parent === undefined ? [] : (slate.piece(parent)?.children ?? []);
  const at = siblings.indexOf(id);
  return [siblings[at - 1], siblings[at + 1]].some(other => other !== undefined && slate.piece(other)?.type === "bars");
}

const ROWS = cn(
  "flex min-w-0 flex-col empty:hidden [&>:empty]:!hidden [&>*+*]:border-t [&>*+*]:border-border/50",
  "[&>:not([data-slate-rows])]:flex [&>:not([data-slate-rows])]:min-h-11 [&>:not([data-slate-rows])]:flex-col [&>:not([data-slate-rows])]:justify-center",
  "[&>:not([data-slate-rows])]:px-(--settings-inset,20px) [&>:not([data-slate-rows])]:py-3",
);
/** A card of rows: each row at the card's inset, 12 px above and below, unless it draws its own rows edge to edge. */
const CARD = cn(CARD_SURFACE, ROWS);
/** Bare rows, as Usage's By agent: no card, a hairline over and under the list and between its rows, on the one edge. */
const BARE = cn(ROWS, "border-y border-border/50 [--settings-inset:0px]");

type Run = { key: string; kind?: "card" | "bare" | "bars"; ids: string[] };

/** A group's children: rows of a kind gathered into a card or a bare list, bar lists into their switch, the rest bare
 * between. A rider, a meta line or a plain text joins the rows before it. */
export function Runs({ slate, ids }: { slate: SlateEngine; ids: readonly string[] }) {
  const runs: Run[] = [];
  for (const id of ids) {
    const last = runs.at(-1);
    const joins = last?.kind === "card" || last?.kind === "bare";
    if (joins && (riddenBy(slate, id) !== undefined || isNoteText(slate, id) || slate.piece(id)?.type === "text")) last!.ids.push(id);
    else if (inBarSwitch(slate, id) || isBarHolder(slate, id)) {
      // A holder of bar lists gives the switch its lists; holders and lists one after another share one switch.
      const lists = isBarHolder(slate, id) ? (slate.piece(id)?.children ?? []) : [id];
      if (last?.kind === "bars") last.ids.push(...lists);
      else runs.push({ key: id, kind: "bars", ids: [...lists] });
    } else if (!isCardRow(slate, id)) runs.push({ key: id, ids: [id] });
    else {
      const kind = isCarded(slate, id) ? "card" : "bare";
      if (last?.kind === kind) last.ids.push(id);
      else runs.push({ key: id, kind, ids: [id] });
    }
  }
  return (
    <>
      {runs.map(run =>
        run.kind === undefined ? (
          <PieceHost key={run.key} id={run.key} />
        ) : run.kind === "bars" ? (
          <BarSwitch key={run.key} slate={slate} ids={run.ids} />
        ) : (
          <div key={run.key} {...(run.kind === "card" ? { "data-slate-card": "" } : { "data-slate-bare": "" })} className={run.kind === "card" ? CARD : BARE}>
            {run.ids.map(id => (
              <PieceHost key={id} id={id} />
            ))}
          </div>
        ),
      )}
    </>
  );
}
