// SPDX-License-Identifier: AGPL-3.0-only
// Workspaces into sidebar projects: a wsp workspace (a machine) is the first
// level, its sessions are the threads. Shape from t3code
// sidebarProjectGrouping.ts SidebarProjectSnapshot and Sidebar.logic.ts
// resolveThreadStatusPill (commit 57a66608). Phase is the product word and
// leads; machine state and reach only add when they diverge from it.
import type { SessionView, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
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
  const machine = status?.machineState ?? null;
  const reach = status?.reach.state ?? null;
  if (machine === "gone") return { label: "Gone", tone: "error", pulse: false };
  // The provider says running and the guest answers nothing: not Running, not Unreachable.
  if (reach === "zombie") return { label: "Zombie", tone: "error", pulse: false };
  switch (workspace.phase) {
    case "waking":
      return { label: "Waking", tone: "connecting", pulse: true };
    case "napping":
      return { label: "Paused", tone: "paused", pulse: false };
    case "running": {
      if (machine === "starting") return { label: "Starting", tone: "connecting", pulse: true };
      if (machine === "paused") return { label: "Paused", tone: "paused", pulse: false };
      if (reach === "unreachable" || reach === "no-daemon") return { label: "Unreachable", tone: "error", pulse: false };
      return { label: "Running", tone: "running", pulse: false };
    }
    default: {
      const _exhaustive: never = workspace.phase;
      return { label: "Unknown", tone: "neutral", pulse: false };
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

/** t3code's pill vocabulary: Working while a session runs, Completed when it settled, nothing for the rest. */
export function threadIndicator(session: Pick<SessionView, "status">): StatusIndicator | null {
  switch (session.status) {
    case "running":
      return { label: "Working", tone: "running", pulse: true };
    case "completed":
      return { label: "Completed", tone: "neutral", pulse: false };
    case "failed":
      return { label: "Failed", tone: "error", pulse: false };
    case "interrupted":
      return null;
    default: {
      const _exhaustive: never = session.status;
      return null;
    }
  }
}
