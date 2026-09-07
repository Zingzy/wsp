// SPDX-License-Identifier: AGPL-3.0-only
// Workspaces into sidebar projects: a wsp workspace (a machine) is the first
// level, its sessions are the threads. Shape from t3code
// sidebarProjectGrouping.ts SidebarProjectSnapshot and Sidebar.logic.ts
// resolveThreadStatusPill (commit 57a66608). Phase is the product word and
// leads; machine state and reach only add when they diverge from it.
import { foldThreads, workspaceState, workspaceWord, type SessionView, type ThreadView, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
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
        threads: threads.map(deriveThread),
      };
      return { rank: LIST_RANK[state], activityMs: lastActivityMs(workspace, threads), project };
    })
    .sort((a, b) => a.rank - b.rank || b.activityMs - a.activityMs || a.project.id.localeCompare(b.project.id))
    .map(row => row.project);
}

/** The latest turn start or end in the workspace, or its creation while it has none. */
function lastActivityMs(workspace: Pick<WorkspaceView, "createdAt">, threads: ReadonlyArray<ThreadView>): number {
  return Math.max(Date.parse(workspace.createdAt), ...threads.flatMap(t => [t.startedAt ?? 0, t.endedAt ?? 0]));
}

/** The one state word's key for a workspace as the app knows it: its phase, and the machine state and reach of its status when one has arrived. */
export function workspaceStateOf(workspace: Pick<WorkspaceView, "phase">, status: WorkspaceStatus | null): WorkspaceState {
  return workspaceState({ phase: workspace.phase, machineState: status?.machineState, reach: status?.reach.state });
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

/** What the thread shows in place of "Working" while its workspace cannot run the turn; null while the machine runs. */
export function turnWait(state: WorkspaceState): { readonly label: string; readonly wake: boolean } | null {
  switch (state) {
    case "running":
      return null;
    case "pausing":
    case "paused":
      return { label: "Waiting for the machine to wake", wake: true };
    case "waking":
      return { label: "Waking the machine", wake: false };
    case "unreachable":
      return { label: "Waiting for the machine to answer", wake: false };
    case "gone":
      return { label: "The machine is gone", wake: false };
    default: {
      const _exhaustive: never = state;
      return null;
    }
  }
}

function deriveThread(thread: ThreadView): SidebarThreadSnapshot {
  return {
    id: thread.id,
    threadId: thread.threadId ?? null,
    sessionId: thread.sessionId,
    workspaceId: thread.workspaceId,
    title: thread.title,
    status: thread.status,
    startedAt: thread.startedAt !== undefined ? new Date(thread.startedAt).toISOString() : null,
    endedAt: thread.endedAt !== undefined ? new Date(thread.endedAt).toISOString() : null,
    indicator: threadIndicator(thread),
    harness: thread.harness,
    startedBy: thread.startedBy,
  };
}

/** The thread words: Working while a turn runs, Idle once it settled or was stopped, Ended when it did not get to settle. */
export function threadIndicator(session: Pick<SessionView, "status">): StatusIndicator {
  switch (session.status) {
    case "running":
      return { label: "Working", tone: "neutral", pulse: true };
    case "completed":
    case "interrupted":
      return { label: "Idle", tone: "neutral", pulse: false };
    case "failed":
      return { label: "Ended", tone: "neutral", pulse: false };
    default: {
      const _exhaustive: never = session.status;
      return { label: "Idle", tone: "neutral", pulse: false };
    }
  }
}
