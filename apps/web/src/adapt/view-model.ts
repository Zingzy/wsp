// SPDX-License-Identifier: AGPL-3.0-only
// The view models the transplanted chat, sidebar, browser and terminal
// components accept, hand-written in plain TypeScript from t3code's
// session-logic.ts, MessagesTimeline.logic.ts, sidebarProjectGrouping.ts,
// useDiscoveredLocalServers.ts and contracts (commit 57a66608). Fields the
// wsp wire cannot fill today are kept when a copied component reads them and
// dropped when nothing does. Everything here is data: no React, no schemas.
import type { ImageRecord, MachineState, PermissionOption, PermissionOutcome, ReachState, SessionOrigin, SessionStatus, WorkspacePhase, WorkspaceState, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";

// --- chat -------------------------------------------------------------------

export type ChatMessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatMessageRole;
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
  /** A user message sent into the turn while it ran, not the one that opened it. */
  readonly steered?: boolean;
  /** The images the person's message carried, as the runtime kept them: their type, weight and name, never their
   * pixels. Present on the message that opened the turn and only when it carried one. */
  readonly attachments?: ReadonlyArray<ImageRecord>;
  /** The id the client minted for the send this message opened, echoed by the runtime; the client that made the send
   * still holds those images and draws them from it. */
  readonly requestId?: string;
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

/** A row's tone picks its glyph and colours from one table; notice is a fact the runtime states (a cut, a line told), never an outcome. */
export type WorkLogTone = "thinking" | "tool" | "notice" | "error";

/** Which wire event produced a work row; the copied rows key chrome on it. */
export type WorkLogSourceKind = "tool.started" | "tool.completed" | "reasoning" | "runtime.error" | "runtime.notify" | "runtime.resume";

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
  /** The Bash tool's description: the harness's own sentence for the call, shown in place of the command and its state word. */
  readonly description?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly tone: WorkLogTone;
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

/** One permission prompt the harness relayed into the chat, as its row reads it: the tool it wants to run, the
 * options a person may pick, and, once it is closed, how it closed. The turn is blocked while outcome is null, so an
 * open row is what the thread is waiting on. */
export interface PermissionPrompt {
  readonly askId: string;
  readonly turnId: string | null;
  /** The runtime's session id, what sessions.answer takes. */
  readonly sessionId: string;
  readonly toolName: string;
  /** The tool's input as the harness sent it, JSON. */
  readonly input: string;
  readonly detail?: string;
  readonly options: ReadonlyArray<PermissionOption>;
  readonly createdAt: string;
  /** Null while nobody has answered; the outcome the wire recorded once one is closed. */
  readonly outcome: PermissionOutcome | null;
  /** The option that closed it, where one did. */
  readonly optionId: string | null;
}

export type TimelineEntry =
  | { readonly id: string; readonly kind: "message"; readonly createdAt: string; readonly message: ChatMessage }
  | { readonly id: string; readonly kind: "permission"; readonly createdAt: string; readonly permission: PermissionPrompt }
  | { readonly id: string; readonly kind: "proposed-plan"; readonly createdAt: string; readonly proposedPlan: ProposedPlan }
  | { readonly id: string; readonly kind: "work"; readonly createdAt: string; readonly entry: WorkLogEntry };

export type TurnState = "running" | "completed" | "interrupted" | "error";

/** One wsp session run is one turn; the chat's footer and folds read this. */
export interface TurnSummary {
  readonly turnId: string;
  readonly sessionId: string;
  readonly state: TurnState;
  /** The turn's reply is in (session.done) while its state is still running: the agent process lives past its reply. */
  readonly replied: boolean;
  readonly prompt: string | null;
  readonly model: string | null;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export type ToolGroupAction = "read" | "edit" | "command" | "code-search" | "search" | "other" | "update";
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
  | { readonly kind: "permission"; readonly id: string; readonly createdAt: string; readonly permission: PermissionPrompt }
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
  /** The latest turn's runtime session id, what a stop interrupts. */
  readonly sessionId: string;
  readonly workspaceId: string;
  /** The user's prompt when the runtime recorded one, else the Claude session id, else the row id. */
  readonly title: string;
  readonly status: SessionStatus;
  /** Whether a turn of this thread ever did work, as the protocol's fold reads the rows. */
  readonly ran: boolean;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly indicator: StatusIndicator | null;
  /** The agent running inside the thread, by its harness id. */
  readonly harness: string;
  /** Who opened the thread, as the protocol's fold answers it. */
  readonly startedBy: SessionOrigin;
  /** The name of the workspace's project the thread's folder sits in; null outside every project or before a turn named one. */
  readonly project: string | null;
  /** The thread whose own agent opened this one; null on every thread a person or the command line opened. The row
   * is drawn one step in under it. */
  readonly parentThreadId: string | null;
  /** The lead of the permission prompt the thread is stopped on, as the protocol's fold reads it; null while it is
   * waiting on nobody. */
  readonly asking: string | null;
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
  /** The one state word's key: phase, machine state and reach folded by the protocol. */
  readonly state: WorkspaceState;
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
