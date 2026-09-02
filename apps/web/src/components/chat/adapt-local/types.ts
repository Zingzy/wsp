// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/session-logic.ts, apps/web/src/types.ts and
// packages/contracts/src/{orchestration,providerRuntime,settings,server}.ts at 57a66608 (MIT).
// Plain TypeScript view-model types the copied chat components render. The
// upstream Effect schemas are hand-written here as structural types.

export type MessageId = string;
export type TurnId = string;
export type ThreadId = string;
export type ApprovalRequestId = string;

export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;
export type ToolLifecycleItemType = (typeof TOOL_LIFECYCLE_ITEM_TYPES)[number];

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return (TOOL_LIFECYCLE_ITEM_TYPES as ReadonlyArray<string>).includes(value);
}

export type ProviderRequestKind = "command" | "file-read" | "file-change" | "mcp-elicitation";
export type ProviderApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
export interface ProviderApprovalOption {
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
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
  readonly multiSelect?: boolean;
}

export type TimestampFormat = "locale" | "12-hour" | "24-hour";
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export interface ChatImageAttachment {
  readonly type: "image";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly previewUrl?: string;
}
export interface ChatFileAttachment {
  readonly type: "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly previewUrl?: string;
  readonly downloadable?: boolean;
}
/** Attachment types this build does not know render as inert rows so a newer wire cannot crash the client. */
export interface ChatUnknownAttachment {
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}
export type ChatAttachment = ChatImageAttachment | ChatFileAttachment | ChatUnknownAttachment;

export function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  return attachment.type === "image";
}
export function isFileAttachment(attachment: ChatAttachment): attachment is ChatFileAttachment {
  return attachment.type === "file";
}
export function isVideoAttachment(attachment: ChatFileAttachment): boolean {
  return attachment.mimeType.toLowerCase().startsWith("video/");
}

export type ChatMessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  readonly id: MessageId;
  readonly role: ChatMessageRole;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly turnId: TurnId | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProposedPlan {
  readonly id: string;
  readonly turnId: TurnId | null;
  readonly planMarkdown: string;
  readonly implementedAt: string | null;
  readonly implementationThreadId: ThreadId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TurnDiffFileChange {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
}
export type TurnDiffStatus = "ready" | "missing" | "error";
export interface TurnDiffSummary {
  readonly turnId: TurnId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: string;
  readonly status: TurnDiffStatus;
  readonly files: ReadonlyArray<TurnDiffFileChange>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

export type LatestTurnState = "running" | "interrupted" | "completed" | "error";
export interface LatestTurn {
  readonly turnId: TurnId;
  readonly state: LatestTurnState;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: MessageId | null;
}

export type WorkLogToolLifecycleStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped";

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId?: TurnId | null;
  /** Stable provider identity across in-progress and completed lifecycle updates. */
  toolCallId?: string;
  label: string;
  detail?: string;
  viewedImagePath?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolData?: unknown;
  itemType?: ToolLifecycleItemType;
  requestKind?: ProviderRequestKind;
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  /** Originating activity kind (e.g. `user-input.requested`) for row chrome. */
  sourceActivityKind?: string;
  /** Grouping key for subagent lifecycle rows (one row per agent). */
  taskId?: string;
  agentRole?: string;
  agentSpawn?: {
    workflowId: string | null;
    agentTaskIds: ReadonlyArray<string>;
  };
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: ProviderRequestKind;
  createdAt: string;
  detail?: string;
  appName?: string;
  options?: ReadonlyArray<ProviderApprovalOption>;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export type TimelineEntry =
  | { id: string; kind: "message"; createdAt: string; message: ChatMessage }
  | { id: string; kind: "proposed-plan"; createdAt: string; proposedPlan: ProposedPlan }
  | { id: string; kind: "work"; createdAt: string; entry: WorkLogEntry };

/** The two fields of a harness skill the chat renders (inline `/skill` chips). */
export interface ProviderSkill {
  readonly name: string;
  readonly displayName?: string | undefined;
}
