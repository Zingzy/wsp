// SPDX-License-Identifier: AGPL-3.0-only
// Workspaces into sidebar projects: a wsp workspace (a machine) is the first
// level, its sessions are the threads. Shape from t3code
// sidebarProjectGrouping.ts SidebarProjectSnapshot and Sidebar.logic.ts
// resolveThreadStatusPill (commit 57a66608). Phase is the product word and
// leads; machine state and reach only add when they diverge from it.
import { workspaceState, workspaceWord, type SessionView, type WorkspaceState, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot, StatusIndicator } from "./view-model.js";

export interface SidebarInput {
  readonly workspaces: ReadonlyArray<WorkspaceView>;
  readonly statuses?: Readonly<Record<string, WorkspaceStatus>>;
  readonly sessions?: Readonly<Record<string, ReadonlyArray<SessionView>>>;
}

export function deriveSidebarProjects(input: SidebarInput): SidebarProjectSnapshot[] {
  return [...input.workspaces]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(workspace => {
      const status = input.statuses?.[workspace.id] ?? null;
      const phase = status?.phase ?? workspace.phase;
      const threads = (input.sessions?.[workspace.id] ?? []).map(deriveThread);
      return {
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
        indicator: workspaceIndicator({ ...workspace, phase }, status),
        threads,
      };
    });
}

export function workspaceIndicator(workspace: Pick<WorkspaceView, "phase">, status: WorkspaceStatus | null): StatusIndicator {
  const state = workspaceState({ phase: workspace.phase, machineState: status?.machineState, reach: status?.reach.state });
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

export function deriveThread(session: SessionView): SidebarThreadSnapshot {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    title: session.prompt ?? session.claudeSessionId ?? session.id,
    status: session.status,
    startedAt: session.startedAt !== undefined ? new Date(session.startedAt).toISOString() : null,
    endedAt: session.endedAt !== undefined ? new Date(session.endedAt).toISOString() : null,
    indicator: threadIndicator(session),
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
