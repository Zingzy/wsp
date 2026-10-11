// SPDX-License-Identifier: AGPL-3.0-only
// Workspaces into sidebar projects: a wsp workspace (a machine) is the first
// level, its sessions are the threads. Shape from t3code
// sidebarProjectGrouping.ts SidebarProjectSnapshot and Sidebar.logic.ts
// resolveThreadStatusPill (commit 57a66608). Phase is the product word and
// leads; machine state and reach only add when they diverge from it.
import { bareFolder, foldThreads, threadKeyOf, threadNeedsYou, threadState, threadUnread, threadWordOf, waitingLine, workspaceStateOf, workspaceWord, type PauseMode, type SessionView, type ThreadView, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot, StatusIndicator } from "./view-model.js";

export interface SidebarInput {
  readonly workspaces: ReadonlyArray<WorkspaceView>;
  readonly statuses?: Readonly<Record<string, WorkspaceStatus>>;
  readonly sessions?: Readonly<Record<string, ReadonlyArray<SessionView>>>;
  /** How the computer each workspace's project lands on pauses a machine, by the project's id: the state word is
   * Paused on a computer that keeps the machine's memory and Stopped on every other. A project the host has not
   * answered a landing for reads the stopping words, as every caller holding no mode does. */
  readonly pauseModes?: Readonly<Record<string, PauseMode | undefined>>;
}

const NO_ROWS: ReadonlyArray<SessionView> = [];

/** The snapshot last built for each workspace record and what it was built from, and the threads last folded from
 * each list of rows: a frame about one workspace builds that one again, and every other row and thread keeps its
 * identity. */
const built = new WeakMap<WorkspaceView, { status: WorkspaceStatus | null; rows: ReadonlyArray<SessionView>; pauseMode: PauseMode | undefined; snapshot: SidebarProjectSnapshot }>();
const folded = new WeakMap<ReadonlyArray<SessionView>, { project: string; threads: SidebarThreadSnapshot[] }>();

function threadsOf(rows: ReadonlyArray<SessionView>, workspace: WorkspaceView): SidebarThreadSnapshot[] {
  const held = folded.get(rows);
  if (held !== undefined && held.project === workspace.project.name) return held.threads;
  const views = foldThreads(rows);
  const byId = new Map(views.map(thread => [thread.id, thread] as const));
  const threads = views.map(thread => deriveThread(thread, workspace, rows.find(row => threadKeyOf(row) === thread.id)?.model, thread.replaces === undefined ? undefined : byId.get(thread.replaces)));
  folded.set(rows, { project: workspace.project.name, threads });
  return threads;
}

/** The list last answered, so every surface reading it in one change gets the same array, and gets it again while no
 * workspace in it changed. */
let last: { snapshots: SidebarProjectSnapshot[]; sorted: SidebarProjectSnapshot[] } | null = null;

export function deriveSidebarProjects(input: SidebarInput): SidebarProjectSnapshot[] {
  const snapshots = input.workspaces
    .filter(workspace => !bareFolder(workspace, (input.sessions?.[workspace.id]?.length ?? 0) > 0))
    .map(workspace => {
      const status = input.statuses?.[workspace.id] ?? null;
      const rows = input.sessions?.[workspace.id] ?? NO_ROWS;
      const pauseMode = input.pauseModes?.[workspace.project.id];
      const held = built.get(workspace);
      if (held !== undefined && held.status === status && held.rows === rows && held.pauseMode === pauseMode) return held.snapshot;
      const phase = status?.phase ?? workspace.phase;
      const state = workspaceStateOf({ phase }, status);
      const snapshot: SidebarProjectSnapshot = {
        id: workspace.id,
        projectKey: workspace.id,
        displayName: workspace.name,
        groupedProjectCount: 1,
        environmentPresence: "remote-only",
        allRemoteMembersAreDesktopLocal: false,
        remoteEnvironmentLabels: [status?.machineId ?? workspace.machineId],
        workspace,
        status,
        phase,
        machineState: status?.machineState ?? null,
        reach: status?.reach.state ?? null,
        state,
        indicator: indicatorFor(state, pauseMode),
        threads: threadsOf(rows, workspace),
      };
      built.set(workspace, { status, rows, pauseMode, snapshot });
      return snapshot;
    });
  if (last !== null && last.snapshots.length === snapshots.length && last.snapshots.every((snapshot, i) => snapshot === snapshots[i])) return last.sorted;
  last = { snapshots, sorted: snapshots.toSorted(byCreation) };
  return last.sorted;
}

const created = new WeakMap<WorkspaceView, number>();
const createdMs = (workspace: WorkspaceView): number => {
  const held = created.get(workspace);
  if (held !== undefined) return held;
  const ms = Date.parse(workspace.createdAt);
  created.set(workspace, ms);
  return ms;
};

/** A list a person picks rows out of by position may not reshuffle while they reach for one, so nothing about what
 * a machine is doing sorts it and recency lives in the palette's Recent list instead. Two workspaces stamped the
 * same millisecond fall to their ids, since the record they arrive in is a map with no order of its own. */
const byCreation = (a: SidebarProjectSnapshot, b: SidebarProjectSnapshot): number =>
  createdMs(a.workspace) - createdMs(b.workspace) || a.id.localeCompare(b.id);

/** The workspace ids as the sidebar draws them, top to bottom: the one order every "first" or "next" workspace reads. */
export function sidebarWorkspaceOrder(input: SidebarInput): string[] {
  return deriveSidebarProjects(input).map(project => project.id);
}

/** The workspace a surface holding no pick of its own is about: the selected one, or the sidebar's first row while
 * what is selected is not a workspace, which is what a creation in flight leaves behind. One rule, so the chords
 * that walk the list and the palette's rows cannot land on two different workspaces.  */
export function currentWorkspaceId(orderedIds: ReadonlyArray<string>, selectedId: string | null): string | null {
  return selectedId !== null && orderedIds.includes(selectedId) ? selectedId : orderedIds[0] ?? null;
}

export function workspaceIndicator(workspace: Pick<WorkspaceView, "phase">, status: WorkspaceStatus | null, pauseMode?: PauseMode): StatusIndicator {
  return indicatorFor(workspaceStateOf(workspace, status), pauseMode);
}

function indicatorFor(state: WorkspaceState, pauseMode?: PauseMode): StatusIndicator {
  return { label: workspaceWord(state, pauseMode), tone: indicatorTone(state), pulse: state === "pausing" || state === "waking" };
}

function indicatorTone(state: WorkspaceState): StatusIndicator["tone"] {
  switch (state) {
    case "running":
      return "running";
    case "pausing":
    case "paused":
      return "paused";
    case "waking":
    case "unreachable":
    case "gone":
      return "neutral";
    default: {
      const _exhaustive: never = state;
      return "neutral";
    }
  }
}

/** What the timeline's line says in place of "Working" while the thread's workspace cannot run the turn, and
 * whether to offer the wake beside it; null while the workspace runs. Every line names the workspace, and the
 * waking one names where it runs too, since that is the send's whole answer: the turn starts there in a moment.
 * The elapsed rides beside the words on the row, not in them, because it ticks. */
export function turnWait(state: WorkspaceState, workspace: { readonly name: string; readonly where: string }): { readonly label: string; readonly wake: boolean; readonly elapsed: boolean } | null {
  switch (state) {
    case "running":
      return null;
    case "pausing":
    case "paused":
      return { label: `waiting for ${workspace.name} to wake`, wake: true, elapsed: false };
    case "waking":
      return { label: `waking ${workspace.name} on ${workspace.where}`, wake: false, elapsed: true };
    case "unreachable":
      return { label: `waiting for ${workspace.name} to answer`, wake: false, elapsed: false };
    case "gone":
      return { label: `${workspace.name} is gone`, wake: false, elapsed: false };
    default: {
      const _exhaustive: never = state;
      return null;
    }
  }
}

function deriveThread(thread: ThreadView, workspace: Pick<WorkspaceView, "project">, model: string | undefined, replaced: ThreadView | undefined): SidebarThreadSnapshot {
  return {
    id: thread.id,
    threadId: thread.threadId ?? null,
    sessionId: thread.sessionId,
    workspaceId: thread.workspaceId,
    title: thread.title,
    status: thread.status,
    ran: thread.ran,
    ...(thread.rewoundAt !== undefined ? { rewound: true } : {}),
    ...(thread.claudeSessionId !== undefined && thread.cwd !== undefined ? { harnessSession: { id: thread.claudeSessionId, folder: thread.cwd } } : {}),
    startedAt: thread.startedAt !== undefined ? new Date(thread.startedAt).toISOString() : null,
    endedAt: thread.endedAt !== undefined ? new Date(thread.endedAt).toISOString() : null,
    indicator: threadIndicator(thread),
    harness: thread.harness,
    startedBy: thread.startedBy,
    project: workspace.project.name,
    parentThreadId: thread.parentThreadId ?? null,
    attempt: thread.attempt ?? null,
    model: model ?? null,
    asking: waitingLine(thread) ?? null,
    ...(thread.setupRefusal !== undefined ? { setupRefusal: thread.setupRefusal } : {}),
    ...(thread.capped !== undefined ? { capped: thread.capped } : {}),
    limit: thread.limit ?? null,
    resumeAt: thread.resumeAt ?? null,
    costUsd: thread.costUsd ?? null,
    unread: threadUnread(thread),
    readAt: thread.readAt !== undefined ? new Date(thread.readAt).toISOString() : null,
    settledAt: thread.settledAt !== undefined ? new Date(thread.settledAt).toISOString() : null,
    needsYou: threadNeedsYou(thread),
    pinnedAt: thread.pinnedAt !== undefined ? new Date(thread.pinnedAt).toISOString() : null,
    snoozedUntil: thread.snoozedUntil !== undefined ? new Date(thread.snoozedUntil).toISOString() : null,
    section: thread.section ?? null,
    subagents: thread.subagents ?? [],
    lastLine: thread.lastLine ?? null,
    failure: thread.failure ?? null,
    foldedAt: thread.foldedAt !== undefined ? new Date(thread.foldedAt).toISOString() : null,
    replaces:
      thread.replaces === undefined
        ? null
        : { threadId: thread.replaces, failed: replaced?.status === "failed", endedAt: replaced?.endedAt !== undefined ? new Date(replaced.endedAt).toISOString() : null },
    replacedBy: thread.replacedBy ?? null,
    ...(thread.forkedFrom !== undefined ? { forkedFrom: { threadId: thread.forkedFrom.threadId, title: thread.forkedFrom.title } } : {}),
  };
}

/** The thread's word, from the protocol's one table, and whether it pulses: a running turn does, and a turn stopped
 * on a question does not, since nothing is moving until the person answers. */
export function threadIndicator(session: Pick<ThreadView, "status" | "asking" | "waitingOn">): StatusIndicator {
  return { label: threadWordOf(session), tone: "neutral", pulse: threadState(session) === "running" };
}
