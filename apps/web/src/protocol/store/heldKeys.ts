// SPDX-License-Identifier: AGPL-3.0-only
// The sort keys a move wrote in this window, laid over the threads the host's
// rows fold into until a row the host sends carries them. A reload that lands between the drop and the
// host's write still reads the old key, and without the hold the tree would jump
// back and then forward again.
import { threadKeyOf, type SessionView, type ThreadMarks } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../../adapt/view-model.js";

/** The keys one thread is held at: a number, or null for one taken off. */
export interface HeldKeys {
  readonly pinnedAt?: number | null;
  readonly order?: number | null;
  /** Which mark set the hold, so the host taking an earlier one leaves a later move's hold standing. */
  readonly mark?: number;
}

/** What a mark holds: the keys it names. A pin by true takes the host's clock, which this window cannot know, so it
 * holds nothing. */
export function heldFrom(marks: ThreadMarks): HeldKeys | null {
  const pinnedAt = typeof marks.pinned === "number" ? marks.pinned : marks.pinned === false ? null : undefined;
  const held = { ...(pinnedAt !== undefined ? { pinnedAt } : {}), ...(marks.order !== undefined ? { order: marks.order } : {}) };
  return Object.keys(held).length === 0 ? null : held;
}

const carries = (row: SessionView, held: HeldKeys): boolean =>
  (held.pinnedAt === undefined || (row.pinnedAt ?? null) === held.pinnedAt) && (held.order === undefined || (row.order ?? null) === held.order);

/** Every workspace's threads with the held keys laid over the held ones: the same array while none is held, and
 * every other thread and workspace keeping its identity, so a tile whose thread moved nothing compares in one step. */
export function withHeldThreads(projects: SidebarProjectSnapshot[], held: Readonly<Record<string, HeldKeys>>): SidebarProjectSnapshot[] {
  if (Object.keys(held).length === 0) return projects;
  return projects.map(project => {
    if (!project.threads.some(thread => held[thread.id] !== undefined)) return project;
    return {
      ...project,
      threads: project.threads.map(thread => {
        const at = held[thread.id];
        if (at === undefined) return thread;
        return { ...thread, ...(at.pinnedAt !== undefined ? { pinnedAt: at.pinnedAt } : {}), ...(at.order !== undefined ? { order: at.order } : {}) };
      }),
    };
  });
}

/** The marks the host took whose holds still stand: the next rows it sends are its word, carrying the key or a later
 * move's. Kept out of the store, since a hold the host took draws nothing new. */
const taken = new Set<number>();
export const markTaken = (mark: number): void => void taken.add(mark);

/** The threads whose holds the host's rows have answered: the latest row carries what this window holds, or the host
 * took the mark and `moved` says the rows changed since. */
export function landedHolds(sessions: Record<string, SessionView[]>, held: Readonly<Record<string, HeldKeys>>, moved: boolean): string[] {
  const latest = new Map<string, SessionView>();
  for (const rows of Object.values(sessions)) for (const row of rows) if (held[threadKeyOf(row)] !== undefined) latest.set(threadKeyOf(row), row);
  const landed = Object.keys(held).filter(threadId => {
    const row = latest.get(threadId);
    const at = held[threadId]!;
    return (row !== undefined && carries(row, at)) || (moved && at.mark !== undefined && taken.has(at.mark));
  });
  // A mark a later move's hold stands over, or one whose hold has gone, is waited on by nothing.
  const standing = new Set(Object.entries(held).flatMap(([threadId, at]) => (landed.includes(threadId) || at.mark === undefined ? [] : [at.mark])));
  for (const mark of taken) if (!standing.has(mark)) taken.delete(mark);
  return landed;
}
