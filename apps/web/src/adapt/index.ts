// SPDX-License-Identifier: AGPL-3.0-only
// The adapter: pure functions from @wsp/protocol types to the view models the
// transplanted components accept. apps/web imports @wsp/protocol only; nothing
// here touches React, the store or a socket.
export * from "./view-model.js";
export { deriveSession, summarizeOutput, commandFirstLine, type SessionModel, type DeriveSessionOptions } from "./session.js";
export {
  deriveMessagesTimelineRows,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  workEntryKind,
  isToolLike,
  indicatesFailure,
  indicatesSuccess,
  indicatesNeutral,
  type DeriveRowsInput,
} from "./timeline-rows.js";
export {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PromptEvent,
  type ApprovalRequestedEvent,
  type ApprovalResolvedEvent,
  type UserInputRequestedEvent,
  type UserInputResolvedEvent,
  type PromptRespondFailedEvent,
} from "./prompts.js";
export {
  applyPortsSnapshot,
  applyPortEvent,
  applyStoppedEvent,
  MOVED_WINDOW_MS,
  stoppedSentence,
  toPreviewableServers,
  type KnownPort,
  type PortsSnapshot,
  type PreviewableServersInput,
  type StoppedPort,
} from "./ports.js";
export { deriveSidebarProjects, sidebarWorkspaceOrder, workspaceIndicator, threadIndicator, pausedLine, turnWait, type SidebarInput } from "./workspaces.js";
export { terminalPaneState, terminalPaneTitle, terminalPaneHints, terminalEmptyLine, terminalInputRefusal, SHELL_ENDED_LINE, type TerminalPaneState, type TerminalPaneInput } from "./terminal-pane.js";
export { toTerminalAttachEvent, isPtyEvent } from "./terminal.js";
export { catalogFor, catalogFromHarness } from "./catalog.js";
export { repoAbsence } from "./git.js";
export { HARNESS_CLIENTS, glyphOf, harnessClient, type HarnessClient, type HarnessGlyph } from "./harnesses.js";
