// SPDX-License-Identifier: AGPL-3.0-only
// One road for every move of a root tree: a drop between two trees, Move up,
// Move down and Move to top on a tile's menu and in the palette, and the keys on
// a focused tile all write the marks moveMarks() reads off the section as the
// sidebar draws it, and the polite live region says where the tree went.
import type { ThreadMarks } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";
import { dropMarks, type TileNode, type TileSection } from "./threadTree.js";
import { moveMarks, type OrderedSection } from "./treeOrder.js";
import { TREE_WORDS } from "./words.js";

export type MoveStep = "up" | "down" | "top";

/** Where a root stands in Pinned or the list: its place among the trees there that move, and how many those are. */
export interface RootPlace {
  readonly section: OrderedSection;
  readonly index: number;
  readonly count: number;
}

const ordered = (section: TileSection): section is TileSection & { id: OrderedSection } => section.id === "pinned" || section.id === "threads";

/** The roots of a section a move lands among: a snoozed tree at the foot of the list stands apart from the order. */
const movable = (roots: ReadonlyArray<TileNode>): TileNode[] => roots.filter(root => root.thread.snoozedWorking === undefined);

/** Where every root that moves stands, by its id, read in one pass: a draw asks for each of its roots. */
export function rootPlaces(sections: ReadonlyArray<TileSection>): ReadonlyMap<string, RootPlace> {
  const places = new Map<string, RootPlace>();
  for (const section of sections.filter(ordered)) {
    const roots = movable(section.roots);
    roots.forEach((root, index) => places.set(root.thread.id, { section: section.id, index, count: roots.length }));
  }
  return places;
}

/** Where a root stands, by its id; null for one in neither section, or one that does not move. */
export const rootPlace = (sections: ReadonlyArray<TileSection>, rootId: string): RootPlace | null => rootPlaces(sections).get(rootId) ?? null;

let liveRegion: HTMLElement | null = null;
/** The sidebar hands its polite live region here as it mounts, and takes it back as it goes. */
export const holdLiveRegion = (el: HTMLElement | null): void => {
  liveRegion = el;
};
const say = (words: string): void => {
  if (liveRegion === null) return;
  // Emptied first, so the same words said twice are heard twice.
  liveRegion.textContent = "";
  liveRegion.textContent = words;
};

/** What a tree carries into the list besides its key: a placement where its state would file it in Needs you, and a
 * placement taken off where it has one. */
function leavingFor(node: TileNode): ThreadMarks | null {
  const marks = dropMarks(node, "threads");
  if (marks === null || marks.section !== null || node.thread.thread?.section != null) return marks;
  const { section: _none, ...rest } = marks;
  return rest;
}

const titleOf = (node: TileNode): string => node.thread.groupTitle ?? node.thread.thread?.title ?? "";

/** Moves a root to a place in a section, or a step in its own, as `sections` draws them: writes the marks through the
 * store, which holds the keys until the host's rows carry them, and says the move. False where it changes nothing. */
export function moveRoot(sections: ReadonlyArray<TileSection>, node: TileNode, to: MoveStep | { section: OrderedSection; at: number }): boolean {
  const from = rootPlace(sections, node.thread.id);
  const section = typeof to === "string" ? from?.section : to.section;
  if (section === undefined) return false;
  const at = typeof to !== "string" ? to.at : to === "top" ? 0 : to === "up" ? from!.index - 1 : from!.index + 1;
  const others = movable(sections.find(s => s.id === section)?.roots ?? []).filter(root => root.thread.id !== node.thread.id);
  if (at < 0 || at > others.length || (from?.section === section && from.index === at)) return false;
  const { markThreads } = useStore.getState();
  for (const move of moveMarks(node, section, others, at, leavingFor(node))) void markThreads(move.threadIds, move.marks);
  say(TREE_WORDS.moved(titleOf(node), at + 1, others.length + 1, section === "pinned"));
  return true;
}
