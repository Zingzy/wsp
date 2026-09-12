// SPDX-License-Identifier: AGPL-3.0-only
// Workspaces into sidebar projects: a wsp workspace (a machine) is the first
// level, its sessions are the threads. Shape from t3code
// sidebarProjectGrouping.ts SidebarProjectSnapshot and Sidebar.logic.ts
// resolveThreadStatusPill (commit 57a66608). Phase is the product word and
// leads; machine state and reach only add when they diverge from it.
import { foldThreads, IDLE_REASON, projectAt, threadState, threadWordOf, workspaceProjects, workspaceStateOf, workspaceWord, type SessionView, type ThreadView, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot, StatusIndicator } from "./view-model.js";

export interface SidebarInput {
  readonly workspaces: ReadonlyArray<WorkspaceView>;
  readonly statuses?: Readonly<Record<string, WorkspaceStatus>>;
  readonly sessions?: Readonly<Record<string, ReadonlyArray<SessionView>>>;
}

/** Machines that are up (and billing) lead, then the paused, then the gone; inside a group the latest turn or creation is on top. */
const LIST_RANK: Record<WorkspaceState, number> = { running: 0, waking: 0, unreachable: 0, pausing: 1, paused: 1, gone: 2 };

export function deriveSidebarProjects(input: SidebarInput): SidebarProjectSnapshot[] {
  return input.workspaces
    .map(workspace => {
      const status = input.statuses?.[workspace.id] ?? null;
      const phase = status?.phase ?? workspace.phase;
      const state = workspaceStateOf({ phase }, status);
      const threads = foldThreads(input.sessions?.[workspace.id] ?? []);
      const project: SidebarProjectSnapshot = {
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
        indicator: indicatorFor(state),
        threads: threads.map(thread => deriveThread(thread, workspace)),
      };
      return { rank: LIST_RANK[state], activityMs: lastActivityMs(workspace, threads), project };
    })
    .sort((a, b) => a.rank - b.rank || b.activityMs - a.activityMs || a.project.id.localeCompare(b.project.id))
    .map(row => row.project);
}

/** The workspace ids as the sidebar draws them, top to bottom: the one order every "first" or "next" workspace reads. */
export function sidebarWorkspaceOrder(input: SidebarInput): string[] {
  return deriveSidebarProjects(input).map(project => project.id);
}

/** The latest turn start or end in the workspace, or its creation while it has none. */
function lastActivityMs(workspace: Pick<WorkspaceView, "createdAt">, threads: ReadonlyArray<ThreadView>): number {
  return Math.max(Date.parse(workspace.createdAt), ...threads.flatMap(t => [t.startedAt ?? 0, t.endedAt ?? 0]));
}

export function workspaceIndicator(workspace: Pick<WorkspaceView, "phase">, status: WorkspaceStatus | null): StatusIndicator {
  return indicatorFor(workspaceStateOf(workspace, status));
}

function indicatorFor(state: WorkspaceState): StatusIndicator {
  return { label: workspaceWord(state), tone: indicatorTone(state), pulse: state === "pausing" || state === "waking" };
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

/** The line a paused workspace puts under its last turn, where nothing is running and the next send is what wakes
 * it: the state, and what it napped after where the status that brought the nap said so. The window is read back
 * through the protocol's own marker, which the runtime writes the reason with, so neither side can reword it alone.
 * A window that was not open at the nap is told none of that and says the state alone rather than guessing. */
export function pausedLine(reason: string | undefined): string {
  const window = IDLE_REASON.windowIn(reason);
  return window === undefined ? "paused" : `paused after ${window} idle`;
}

function deriveThread(thread: ThreadView, workspace: Pick<WorkspaceView, "projects">): SidebarThreadSnapshot {
  return {
    id: thread.id,
    threadId: thread.threadId ?? null,
    sessionId: thread.sessionId,
    workspaceId: thread.workspaceId,
    title: thread.title,
    status: thread.status,
    ran: thread.ran,
    startedAt: thread.startedAt !== undefined ? new Date(thread.startedAt).toISOString() : null,
    endedAt: thread.endedAt !== undefined ? new Date(thread.endedAt).toISOString() : null,
    indicator: threadIndicator(thread),
    harness: thread.harness,
    startedBy: thread.startedBy,
    project: projectAt(workspaceProjects(workspace), thread.cwd)?.name ?? null,
    parentThreadId: thread.parentThreadId ?? null,
    asking: thread.asking ?? null,
    costUsd: thread.costUsd ?? null,
  };
}

/** The thread's word, from the protocol's one table, and whether it pulses: a running turn does, and a turn stopped
 * on a question does not, since nothing is moving until the person answers. */
export function threadIndicator(session: Pick<ThreadView, "status" | "asking">): StatusIndicator {
  return { label: threadWordOf(session), tone: "neutral", pulse: threadState(session) === "running" };
}
