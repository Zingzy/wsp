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
      const threads = deriveThreads(input.sessions?.[workspace.id] ?? []);
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

/** One row per turn from the wire, one thread per row here: turns sharing a threadId fold into one, in the order the first of each started. */
export function deriveThreads(sessions: ReadonlyArray<SessionView>): SidebarThreadSnapshot[] {
  const byThread = new Map<string, SessionView[]>();
  for (const session of sessions) {
    const key = session.threadId ?? session.id;
    const turns = byThread.get(key);
    if (turns === undefined) byThread.set(key, [session]);
    else turns.push(session);
  }
  return [...byThread].map(([id, turns]) => deriveThread(id, turns));
}

/** The thread reads as its opening prompt; its state and times are the latest turn's, since that is what is running or just settled. */
function deriveThread(id: string, turns: ReadonlyArray<SessionView>): SidebarThreadSnapshot {
  const first = turns[0]!;
  const latest = turns[turns.length - 1]!;
  return {
    id,
    threadId: first.threadId ?? null,
    workspaceId: first.workspaceId,
    title: first.prompt ?? first.claudeSessionId ?? first.id,
    status: latest.status,
    startedAt: latest.startedAt !== undefined ? new Date(latest.startedAt).toISOString() : null,
    endedAt: latest.endedAt !== undefined ? new Date(latest.endedAt).toISOString() : null,
    indicator: threadIndicator(latest),
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
