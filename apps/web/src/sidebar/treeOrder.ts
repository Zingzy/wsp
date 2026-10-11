// SPDX-License-Identifier: AGPL-3.0-only
// Where a root tree stands in its section, and what a move writes to put it
// somewhere else. Pinned sorts by the pin's key and the list by the key a move
// wrote, else the tree's start, largest first and ties by id. One number per
// tree on the host, in the epoch-ms space of starts: a tree nobody moved needs
// no write, and a new thread, started after every key, lands on top.
import type { ThreadMarks } from "@wsp/protocol";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { toSortableTimestamp } from "./threadSort.js";
import type { SidebarSection, TileNode } from "./threadTree.js";

/** The two sections a person orders by hand; Needs you draws in the trees' order and takes no place of its own. */
export type OrderedSection = Extract<SidebarSection, "pinned" | "threads">;

/** A drop above the top tree takes its key plus this, and one below the last its key less the other. */
export const ABOVE_TOP_MS = 1;
export const BELOW_LAST_MS = 60_000;
/** The gap a re-key walks down to when two neighbours' keys have no number left between them. */
const REKEY_GAP_MS = 1;

/** The threads a root stands for: its own, or every thread of a group one send to several models opened. A
 * workspace tile with no thread stands for none, which is why it never moves. */
export function rootThreads(node: TileNode): SidebarThreadSnapshot[] {
  const { thread, groupTitle } = node.thread;
  if (groupTitle !== undefined) return node.children.flatMap(child => (child.thread.thread === null ? [] : [child.thread.thread]));
  return thread === null ? [] : [thread];
}

const startOf = (thread: Pick<SidebarThreadSnapshot, "startedAt">): number => toSortableTimestamp(thread.startedAt ?? undefined) ?? 0;

/** A root's key in the list: the key a move wrote, else its start. A group stands where its newest member does,
 * which is where the start order put it before anyone moved it. */
export function listKey(node: TileNode): number {
  const threads = rootThreads(node);
  if (threads.length === 0) return startOf(node.thread);
  return Math.max(...threads.map(thread => thread.order ?? startOf(thread)));
}

/** A root's key in Pinned, null for one nobody pinned. */
export function pinKey(node: TileNode): number | null {
  const keys = rootThreads(node).flatMap(thread => (thread.pinnedAt === null ? [] : [thread.pinnedAt]));
  return keys.length === 0 ? null : Math.max(...keys);
}

export const keyIn = (section: OrderedSection, node: TileNode): number => (section === "pinned" ? (pinKey(node) ?? 0) : listKey(node));

/** The order a section draws its roots in. */
export const bySectionKey =
  (section: OrderedSection) =>
  (a: TileNode, b: TileNode): number =>
    keyIn(section, b) - keyIn(section, a) || a.thread.id.localeCompare(b.thread.id);

/** A tree's key where it lands among a section's keys, drawn order with the moving tree left out, and the trees a
 * gap that ran out re-keys, each by its index there. Between two trees it is their midpoint. A double near 1.8e12
 * resolves about 0.00024 ms, so about twenty drops fill the gap between two trees started a second apart; then the
 * moved tree and the trees under it, down to the first gap of 1 ms, are spread evenly over that gap. */
export function keyAt(keys: readonly number[], at: number): { key: number; rekeyed: { index: number; key: number }[] } {
  if (keys.length === 0) return { key: Date.now(), rekeyed: [] };
  if (at <= 0) return { key: keys[0]! + ABOVE_TOP_MS, rekeyed: [] };
  if (at >= keys.length) return { key: keys.at(-1)! - BELOW_LAST_MS, rekeyed: [] };
  const above = keys[at - 1]!;
  const below = keys[at]!;
  const mid = above / 2 + below / 2;
  if (mid < above && mid > below) return { key: mid, rekeyed: [] };
  let end = at;
  while (end + 1 < keys.length && keys[end]! - keys[end + 1]! < REKEY_GAP_MS) end++;
  const floor = end + 1 < keys.length ? keys[end + 1]! : keys[end]! - BELOW_LAST_MS;
  const step = (above - floor) / (end - at + 3);
  return { key: above - step, rekeyed: Array.from({ length: end - at + 1 }, (_, i) => ({ index: at + i, key: above - step * (i + 2) })) };
}

/** One sessions.mark a move sends: the threads it names and what it writes on each. */
export interface MoveMark {
  readonly threadIds: string[];
  readonly marks: ThreadMarks;
}

/** What moving a root to a place in a section writes: one mark for the tree, every member of a group under the same
 * key, carrying the pin's change too where it crosses into or out of Pinned; then one mark per tree a gap that ran
 * out re-keys. `roots` is the section as drawn, the moving tree left out, and `at` where it lands among them. */
export function moveMarks(node: TileNode, to: OrderedSection, roots: ReadonlyArray<TileNode>, at: number, leaving: ThreadMarks | null): MoveMark[] {
  const { key, rekeyed } = keyAt(
    roots.map(root => keyIn(to, root)),
    at,
  );
  const ids = (root: TileNode): string[] => rootThreads(root).map(thread => thread.id);
  const own: ThreadMarks = to === "pinned" ? { pinned: key } : { ...leaving, ...(pinKey(node) !== null ? { pinned: false } : {}), order: key };
  return [{ threadIds: ids(node), marks: own }, ...rekeyed.map(({ index, key: next }) => ({ threadIds: ids(roots[index]!), marks: to === "pinned" ? { pinned: next } : { order: next } }))];
}
