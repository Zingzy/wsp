// Adapted from pingdotgg/t3code apps/web/src/components/Sidebar.logic.ts at 57a66608 (MIT).
// Pure sidebar logic over wsp thread snapshots. Kept: traversal, the row
// class, the thread status model, timestamps, sort, search and the idle shelf. Left out: context menus, pinned reorder,
// snooze, project scope menus, prewarm leases and the router-bound helpers,
// which model state wsp's wire does not carry. Contract types are hand-written
// against the wsp thread snapshot (startedAt and endedAt instead of createdAt,
// updatedAt and the turn projection).
import { THREAD_ARCHIVE_MS, type SessionStatus } from "@wsp/protocol";
import { cn } from "../lib/utils";
import { activeThreadAnchorTimestampMs, toSortableTimestamp } from "./threadSort";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";

export type ThreadTraversalDirection = "previous" | "next";

/** A thread's pill: the adapter's word, and whether it pulses (a running turn does). */
export interface ThreadStatusPill {
  label: string;
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-8 w-full translate-x-0 cursor-pointer justify-start rounded-md px-2 text-left text-sm select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  return cn(
    baseClassName,
    "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
  );
}

// ── Sidebar thread status model ─────────────────────────────────────
// Five visual states, three colors: color is reserved for "act now"
// (approval), "in motion" (working), and "broken" (failed). Ready is the
// unlabeled resting state — the agent stopped and is waiting on the user,
// whether it finished, asked a question, or proposed a plan.
export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "monitoring"
  | "failed"
  | "ready";

export interface SidebarThreadStatusInput {
  readonly status: SessionStatus;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.status === "running") {
    return "working";
  }
  // A failed session outranks lingering background liveness: the user must
  // see the failure, not a stale Working (review finding).
  if (thread.status === "failed") {
    return "failed";
  }
  return "ready";
}

/** The one reading of "this thread has a turn running". */
export function isThreadWorking(thread: SidebarThreadStatusInput): boolean {
  return resolveSidebarThreadStatus(thread) === "working";
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
export function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** First VALID timestamp wins: `a ?? b` falls through on null, but a present-
    yet-malformed string must also fall through to the next candidate rather
    than sink the row to the epoch. */
export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** String twin of firstValidTimestampMs for callers that need the ISO string
    (display labels, tick anchors) rather than epoch ms. */
export function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

interface ThreadTimestamps {
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

// Sidebar sort: static order, newest anchor on top. Activity NEVER reorders
// the list — a row holds its position between lifecycle transitions, so the
// screen only moves when a thread enters or leaves the active list. The
// anchor is the session's start until an un-settle re-anchors it (see
// activeThreadAnchorTimestampMs). Status is carried by each row's pill, not
// by position.
export function sortThreadsForSidebar<
  T extends {
    readonly id: string;
    readonly startedAt: string | null;
    readonly unsettledAt?: string | null | undefined;
  },
>(threads: readonly T[]): T[] {
  const anchor = (thread: T) =>
    activeThreadAnchorTimestampMs({ createdAt: thread.startedAt ?? "", unsettledAt: thread.unsettledAt });
  return [...threads].sort(
    (left, right) => anchor(right) - anchor(left) || left.id.localeCompare(right.id),
  );
}

/**
 * Search the already-ordered sidebar thread collection by title only.
 * Keeping the input order means lifecycle ordering (active, settled)
 * remains stable while the user narrows the list.
 */
export function searchSidebarThreadsByTitle<T extends { readonly title: string }>(
  threads: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return [];
  return threads.filter((thread) => thread.title.toLowerCase().includes(normalizedQuery));
}

/** The timestamp a settled row sorts and labels by: when the session ended
    when the runtime stamped it, otherwise when it started. */
export function resolveSettledTimestamp(thread: ThreadTimestamps): string | null {
  return firstValidTimestamp(thread.endedAt, thread.startedAt);
}

// Settled rows are history, so they order by when the work ENDED, not when
// the thread was created or last touched.
export function sortSettledThreadsForSidebar<T extends ThreadTimestamps & { readonly id: string }>(
  threads: readonly T[],
): T[] {
  const timestampMs = (thread: T) => toSortableTimestamp(resolveSettledTimestamp(thread) ?? undefined) ?? 0;
  return [...threads].sort(
    (left, right) => timestampMs(right) - timestampMs(left) || left.id.localeCompare(right.id),
  );
}

/** Whether an idle thread has gone quiet long enough to belong in the archive, against the protocol's one threshold.
    A thread whose timestamps are all missing or malformed has no idleness to read, so it stays on the shelf rather
    than falling into a group the shelf keeps shut. */
export function isThreadArchived(thread: ThreadTimestamps, nowMs: number): boolean {
  const lastActivityMs = toSortableTimestamp(resolveSettledTimestamp(thread) ?? undefined);
  return lastActivityMs !== null && nowMs - lastActivityMs >= THREAD_ARCHIVE_MS;
}

/** The idle shelf split into the rows it still shows and the ones that fold into Archived, each side keeping the
    order the shelf sorted them into. */
export function foldArchivedThreads<T extends ThreadTimestamps>(
  settled: readonly T[],
  nowMs: number,
): { settled: T[]; archived: T[] } {
  const shelf: T[] = [];
  const archived: T[] = [];
  for (const thread of settled) {
    (isThreadArchived(thread, nowMs) ? archived : shelf).push(thread);
  }
  return { settled: shelf, archived };
}

/** A thread as both sidebar sorts read it. */
type SidebarThreadRow = SidebarThreadStatusInput &
  ThreadTimestamps & { readonly id: string; readonly unsettledAt?: string | null | undefined };

/** A workspace's threads as the sidebar orders them: the working ones on top, then the settled shelf. The sidebar
    draws the two as its own sections and the switcher card takes the first row of them, so both name one thread. */
export function splitSidebarThreads<T extends SidebarThreadRow>(
  threads: readonly T[],
): { active: T[]; settled: T[] } {
  return {
    active: sortThreadsForSidebar(threads.filter(thread => isThreadWorking(thread))),
    settled: sortSettledThreadsForSidebar(threads.filter(thread => !isThreadWorking(thread))),
  };
}

/** The thread the sidebar draws at the top of a workspace, which is the one its centre opens; null with no threads. */
export function topSidebarThread<T extends SidebarThreadRow>(threads: readonly T[]): T | null {
  const { active, settled } = splitSidebarThreads(threads);
  return active[0] ?? settled[0] ?? null;
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
