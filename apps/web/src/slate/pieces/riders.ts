// SPDX-License-Identifier: AGPL-3.0-only
// The words a number's stat cell carries in its note: a status and the text that follows it, written right after the
// number, or beside it in the same row or cell (alone, or stacked in a column of their own). The number draws them;
// the pieces themselves draw nothing.
import type { SlateEngine } from "../engine.js";
import { isNoteText } from "./look.js";

export interface Riders {
  /** The status whose word leads the note. */
  readonly state: string | undefined;
  /** The texts after it, in order. */
  readonly texts: readonly string[];
  /** Every piece that rides, the columns holding them included. */
  readonly all: readonly string[];
}

const NONE: Riders = { state: undefined, texts: [], all: [] };
const isWords = (type: string | undefined): boolean => type === "status" || type === "text";

/** The parent lays its children side by side or stacks them in one cell, rather than gathering them into cards. */
function holdsOneCell(slate: SlateEngine, id: string): boolean {
  const type = slate.piece(id)?.type;
  if (type === "row") return true;
  const parent = slate.parentId(id);
  return type === "column" && parent !== undefined && slate.piece(parent)?.type !== "section" && slate.piece(parent)?.type !== "column";
}

export function ridersOf(slate: SlateEngine, number: string): Riders {
  const parent = slate.parentId(number);
  if (parent === undefined) return NONE;
  const siblings = slate.piece(parent)?.children ?? [];
  if (holdsOneCell(slate, parent)) {
    // Beside the number: every other child is a status or a text, or a column of nothing else.
    const leaves: string[] = [];
    const all: string[] = [];
    for (const sibling of siblings) {
      if (sibling === number) continue;
      const piece = slate.piece(sibling);
      if (isWords(piece?.type)) {
        leaves.push(sibling);
        all.push(sibling);
      } else if (piece?.type === "column" && (piece.children ?? []).length > 0 && (piece.children ?? []).every(child => isWords(slate.piece(child)?.type))) {
        leaves.push(...(piece.children ?? []));
        all.push(sibling, ...(piece.children ?? []));
      } else return NONE;
    }
    const state = leaves.find(leaf => slate.piece(leaf)?.type === "status");
    if (state === undefined) return NONE;
    return { state, texts: leaves.filter(leaf => slate.piece(leaf)?.type === "text"), all };
  }
  // Among cards: the status written right after the number, and the meta line right after that.
  const at = siblings.indexOf(number);
  const state = siblings[at + 1];
  if (state === undefined || slate.piece(state)?.type !== "status") return NONE;
  const follow = siblings[at + 2];
  const texts = follow !== undefined && isNoteText(slate, follow) ? [follow] : [];
  return { state, texts, all: [state, ...texts] };
}

/** The number whose note a piece rides, if any. */
export function riddenBy(slate: SlateEngine, id: string): string | undefined {
  const parent = slate.parentId(id);
  if (parent === undefined) return undefined;
  const grand = slate.parentId(parent);
  const near = [...(slate.piece(parent)?.children ?? []), ...(grand === undefined ? [] : (slate.piece(grand)?.children ?? []))];
  return near.find(candidate => slate.piece(candidate)?.type === "number" && ridersOf(slate, candidate).all.includes(id));
}

/** A row or cell holding one number and only the words that ride it: the number's stat cell stands in its place. */
export function isStatCell(slate: SlateEngine, id: string): boolean {
  const children = slate.piece(id)?.children ?? [];
  const numbers = children.filter(child => slate.piece(child)?.type === "number");
  return numbers.length === 1 && holdsOneCell(slate, id) && ridersOf(slate, numbers[0]!).all.length > 0;
}
