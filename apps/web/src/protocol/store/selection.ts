// SPDX-License-Identifier: AGPL-3.0-only
import type { AppAddress, SessionView, WorkspaceView } from "@wsp/protocol";
import { noSuchThreadLine } from "../../actions/format.js";
import { sidebarWorkspaceOrder } from "../../adapt/workspaces.js";
import { lastOpen, type LastOpen } from "../lastWorkspace.js";
import type { State } from "./types.js";

/** Every listed workspace keyed, one with no rows at an empty list: a key that is absent means its rows are unread. */
export function groupSessions(rows: SessionView[], listed: readonly string[]): Record<string, SessionView[]> {
  const out: Record<string, SessionView[]> = Object.fromEntries(listed.map(id => [id, []]));
  for (const r of rows) (out[r.workspaceId] ??= []).push(r);
  return out;
}

/** A workspace's rows as read again, each row the host answered unchanged kept as the object already held, and the
 * held list itself where none changed: the host answers every read with fresh objects, and a fresh object is a thread
 * every derivation and every row reads as changed. */
export function keptRows(held: SessionView[] | undefined, read: SessionView[]): SessionView[] {
  if (held === undefined) return read;
  const byId = new Map(held.map(row => [row.id, row]));
  let same = held.length === read.length;
  const rows = read.map((row, i) => {
    const was = byId.get(row.id);
    // Only a copy can be compared: the very object held may have been changed in place since it was drawn.
    const kept = was !== undefined && was !== row && JSON.stringify(was) === JSON.stringify(row) ? was : row;
    if (kept === row || kept !== held[i]) same = false;
    return kept;
  });
  return same ? held : rows;
}

/** The workspace the page's address opens on, when the list still has it: wsp init writes it after its first fork.
 * An id that is gone falls through to the first row, as an address with no workspace in it does. */
export function addressed(address: AppAddress | undefined, workspaces: readonly WorkspaceView[]): string | undefined {
  return address !== undefined && workspaces.some(w => w.id === address.workspaceId) ? address.workspaceId : undefined;
}

/** What the centre opens on after a refresh, the address being the one record of it: the thread it names while the
 * rows still carry it, with the subagent it names of that thread, else the pick standing, which every road wrote the
 * address with. A thread the rows do not carry opens the workspace and says so. The screen a next thread is written
 * on keeps its own address and no thread. */
export function openThreadOf(
  address: AppAddress | undefined,
  workspaceId: string | null,
  pinned: string | null,
  rows: readonly SessionView[],
): { threadId: string | null; subagent: string | null; fresh: boolean; toast?: string } {
  const own = address?.workspaceId === workspaceId ? address : undefined;
  if (own?.fresh === true) return { threadId: null, subagent: null, fresh: true };
  if (own?.threadId === undefined) return { threadId: pinned, subagent: null, fresh: false };
  const subagent = own.subagent ?? null;
  if (rows.some(r => r.workspaceId === workspaceId && r.threadId === own.threadId)) return { threadId: own.threadId, subagent, fresh: false };
  // A session list is best-effort: the one a refused call leaves behind carries no rows at all, and reading that as
  // the thread being gone would move the person off the pick they are holding and write the loss into the address.
  // Only a list that answered can say a thread is not there, which is what a pick nobody is holding meets.
  if (pinned === own.threadId) return { threadId: pinned, subagent, fresh: false };
  return { threadId: null, subagent: null, fresh: false, toast: noSuchThreadLine() };
}

/** The workspace and thread the person had open last, when the list still has the workspace. */
export function remembered(workspaces: readonly WorkspaceView[]): LastOpen | undefined {
  const last = lastOpen();
  return last !== undefined && workspaces.some(w => w.id === last.workspaceId) ? last : undefined;
}

/** The remembered thread as an address, for a load with none of its own, while the rows still carry it: one deleted
 * since is nothing to say a word about, as a link the person followed would be. */
export function keptThread(last: LastOpen | undefined, rows: readonly SessionView[]): AppAddress | undefined {
  if (last?.threadId === undefined || !rows.some(r => r.workspaceId === last.workspaceId && r.threadId === last.threadId)) return undefined;
  return { workspaceId: last.workspaceId, threadId: last.threadId };
}

/** The sidebar's top row: the one fallback for a selection with nothing to go on. */
export function firstRow(s: Pick<State, "workspaces" | "statuses" | "sessions">): string | null {
  return sidebarWorkspaceOrder(s)[0] ?? null;
}
