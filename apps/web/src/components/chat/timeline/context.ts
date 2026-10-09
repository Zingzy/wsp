// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/chat/MessagesTimeline.tsx at 57a66608 (MIT).
// Differs from upstream: store hooks are props (threadKey replaces the route and thread refs, expansion state is local, checkpoint data and callbacks arrive as optional props); rows come from the adapter; attachments, subagent rows, citations, user-message decorations, artifact templates, editor menus and the load-earlier header are removed.
import { type MessageId, type MessagesTimelineRow, type ProviderSkill, type TimestampFormat, type TurnDiffSummary, type TurnId } from "../adapt";
import { createContext } from "react";
import { type SessionRunEvent } from "@wsp/protocol";
import type { ExpandedImagePreview } from "../ExpandedImagePreview";
import type { AnswerPrompt } from "../answerPrompt";
import { type WorkGroupScrollAnchor } from "../MessagesTimeline.logic";

// ---------------------------------------------------------------------------
// Context: shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded: self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

export interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  threadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<ProviderSkill>;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  /** The replies Rewind to here stands on: the last reply of each earlier turn that kept something to rewind to. */
  rewindableMessageIds: ReadonlySet<MessageId>;
  /** The last replies of the turns the agent wrote the slate in. */
  slatedMessageIds: ReadonlySet<MessageId>;
  onRewind: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenFile: ((path: string, line?: number) => void) | undefined;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onToggleTurnFold: (turnId: TurnId) => void;
  onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
  onToggleWorkEntry: (anchorKey: string) => void;
  onAnswerPermission: AnswerPrompt;
  dockedAskId: string | null;
  workGroupViewState: WorkGroupViewState;
  replyRuns: ReplyRuns | null;
  /** The thread whose children the transcript's spawn rows draw, by its key; null where it holds none. */
  leadKey: string | null;
}

/** What a reply's shell blocks need to run where they stand: the thread they belong to, its folder and its runs. */
export interface ReplyRuns {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly runs: ReadonlyMap<string, SessionRunEvent>;
}

/** The turn cannot run right now, its workspace asleep or its computer running as many threads as it takes: what the
 * working row says instead, the one act that ends the wait where one applies, and whether the line counts the
 * seconds beside it. */
export interface MachineWait {
  readonly label: string;
  readonly act: { readonly label: string; readonly run: () => void } | null;
  readonly elapsed: boolean;
}

export interface TimelineRowActivityState {
  isWorking: boolean;
  isPreparingWorktree: boolean;
  machineWait: MachineWait | null;
}

export const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
export const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);

export interface WorkGroupViewState {
  scrollPositions: Map<string, WorkGroupScrollAnchor>;
  expandedEntries: Set<string>;
}

export const WorkGroupViewCtx = createContext<{
  state: WorkGroupViewState;
  onToggleEntry: () => void;
} | null>(null);

export type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
export type TimelineRow = MessagesTimelineRow;
