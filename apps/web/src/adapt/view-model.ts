// SPDX-License-Identifier: AGPL-3.0-only
// The view models the transplanted chat, sidebar, browser and terminal
// components accept, hand-written in plain TypeScript from t3code's
// session-logic.ts, MessagesTimeline.logic.ts, sidebarProjectGrouping.ts,
// useDiscoveredLocalServers.ts and contracts (commit 57a66608). Fields the
// wsp wire cannot fill today are kept when a copied component reads them and
// dropped when nothing does. Everything here is data: no React, no schemas.
import type { MachineState, ReachState, SessionOrigin, SessionStatus, WorkspacePhase, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";

// --- chat -------------------------------------------------------------------

export type ChatMessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatMessageRole;
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
  /** ISO time, or "" when the wire carried none (session events are unstamped). */
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkLogToolLifecycleStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped";

export type ToolLifecycleItemType =
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view";

export type ProviderRequestKind = "command" | "file-read" | "file-change" | "mcp-elicitation";

/** Which wire event produced a work row; the copied rows key chrome on it. */
export type WorkLogSourceKind = "tool.started" | "tool.completed" | "reasoning" | "runtime.error";

export interface WorkLogEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly turnId: string | null;
  /** Stable across the in-progress and completed states of one tool call. */
  readonly toolCallId?: string;
  readonly label: string;
  readonly detail?: string;
  /** The one collapsed line for a row whose detail is prose (reasoning): its first line, cut like a tool preview. */
  readonly preview?: string;
  readonly command?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly toolTitle?: string;
  readonly itemType?: ToolLifecycleItemType;
  readonly requestKind?: ProviderRequestKind;
  readonly toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  readonly sourceActivityKind: WorkLogSourceKind;
}

export interface ProposedPlan {
  readonly id: string;
  readonly turnId: string | null;
  readonly planMarkdown: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly implementedAt: string | null;
}

export type TimelineEntry =
  | { readonly id: string; readonly kind: "message"; readonly createdAt: string; readonly message: ChatMessage }
  | { readonly id: string; readonly kind: "proposed-plan"; readonly createdAt: string; readonly proposedPlan: ProposedPlan }
  | { readonly id: string; readonly kind: "work"; readonly createdAt: string; readonly entry: WorkLogEntry };

export type TurnState = "running" | "completed" | "interrupted" | "error";

/** One wsp session run is one turn; the chat's footer and folds read this. */
export interface TurnSummary {
  readonly turnId: string;
  readonly sessionId: string;
  readonly state: TurnState;
  readonly prompt: string | null;
  readonly model: string | null;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export type ToolGroupAction = "read" | "edit" | "command" | "browser" | "code-search" | "search" | "other" | "update";
export type ToolGroupSummaryKind = ToolGroupAction | "dynamic-tool" | "agent-tool" | "tone-tool" | "mixed";

export type MessagesTimelineRow =
  | {
      readonly kind: "work";
      readonly id: string;
      readonly createdAt: string;
      readonly groupedEntries: ReadonlyArray<WorkLogEntry>;
      readonly isExpandedToolGroup: boolean;
    }
  | {
      readonly kind: "work-live";
      readonly id: string;
      readonly createdAt: string;
      readonly entry: WorkLogEntry;
      readonly groupedEntries: ReadonlyArray<WorkLogEntry>;
      readonly groupId: string;
      readonly expanded: boolean;
      readonly active: boolean;
    }
  | {
      readonly kind: "work-toggle";
      readonly id: string;
      readonly createdAt: string;
      readonly groupId: string;
      readonly hiddenCount: number;
      readonly expanded: boolean;
      readonly summary: string;
      readonly summaryKind: ToolGroupSummaryKind;
      readonly hasFailure: boolean;
    }
  | {
      readonly kind: "turn-fold";
      readonly id: string;
      readonly createdAt: string;
      readonly turnId: string;
      readonly label: string;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: ChatMessage;
      readonly durationStart: string;
      readonly showAssistantMeta: boolean;
      readonly showAssistantCopyButton: boolean;
      readonly assistantCopyStreaming: boolean;
    }
  | { readonly kind: "proposed-plan"; readonly id: string; readonly createdAt: string; readonly proposedPlan: ProposedPlan }
  | { readonly kind: "working"; readonly id: string; readonly createdAt: string | null }
  | { readonly kind: "thinking"; readonly id: string; readonly createdAt: string | null };

// --- composer prompts ---------------------------------------------------------

export type ProviderApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

export interface ProviderApprovalOption {
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
}

export interface PendingApproval {
  readonly requestId: string;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
}

export interface UserInputQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface UserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<UserInputQuestionOption>;
  readonly multiSelect: boolean;
}

export interface PendingUserInput {
  readonly requestId: string;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

// --- browser pane -----------------------------------------------------------

export interface PreviewableServer {
  readonly host: string;
  readonly port: number;
  /** Navigation target: the minted preview route when one exists, else the loopback url. */
  readonly url: string;
  readonly processName: string | null;
  readonly pid: number | null;
  readonly terminal: { readonly threadId: string; readonly terminalId: string } | null;
  readonly source: "scanner" | "configured";
  /** Loopback form of the same server; history keys off this, never the volatile url. */
  readonly requestedUrl: string;
}

// --- sidebar ----------------------------------------------------------------

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

/** Green is running only; paused draws hollow; everything else is zinc (the colour law). */
export type StatusIndicatorTone = "running" | "paused" | "neutral";

/** Colour is the component's job (tokens); the adapter names the state and whether it pulses. */
export interface StatusIndicator {
  readonly label: string;
  readonly tone: StatusIndicatorTone;
  readonly pulse: boolean;
}

export interface SidebarThreadSnapshot {
  readonly id: string;
  /** The runtime's thread id, what a click pins; null for a row the runtime stamped none on, which selects the workspace only. */
  readonly threadId: string | null;
  readonly workspaceId: string;
  /** The user's prompt when the runtime recorded one, else the Claude session id, else the row id. */
  readonly title: string;
  readonly status: SessionStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly indicator: StatusIndicator | null;
  /** The agent running inside the thread, by its harness id. */
  readonly harness: string;
  /** Who opened the thread; null on rows the runtime wrote before it recorded this. */
  readonly startedBy: SessionOrigin | null;
}

/** One wsp workspace (a machine) as a sidebar project; its sessions are the threads. */
export interface SidebarProjectSnapshot {
  readonly id: string;
  readonly projectKey: string;
  readonly displayName: string;
  readonly groupedProjectCount: number;
  readonly environmentPresence: EnvironmentPresence;
  readonly allRemoteMembersAreDesktopLocal: boolean;
  readonly remoteEnvironmentLabels: ReadonlyArray<string>;
  readonly workspace: WorkspaceView;
  readonly status: WorkspaceStatus | null;
  readonly phase: WorkspacePhase;
  readonly machineState: MachineState | null;
  readonly reach: ReachState | null;
  readonly indicator: StatusIndicator;
  readonly threads: ReadonlyArray<SidebarThreadSnapshot>;
}

// --- terminal ---------------------------------------------------------------

export type TerminalSessionStatus = "starting" | "running" | "exited" | "error";

interface TerminalEventBase {
  readonly threadId: string;
  readonly terminalId: string;
  readonly sequence?: number;
}

export type TerminalAttachStreamEvent =
  | (TerminalEventBase & { readonly type: "output"; readonly data: string })
  | (TerminalEventBase & { readonly type: "exited"; readonly exitCode: number | null; readonly exitSignal: number | null })
  | (TerminalEventBase & { readonly type: "activity"; readonly hasRunningSubprocess: boolean; readonly label: string });

// --- composer catalog -------------------------------------------------------------

export interface ProviderSlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly input?: { readonly hint: string };
}

export interface HarnessCatalog {
  readonly harness: string;
  readonly slashCommands: ReadonlyArray<ProviderSlashCommand>;
}
