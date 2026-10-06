// The typed contract every client speaks: workspace/session views, the event
// union fanned out by the runtime, and the wire types for both servers (the
// runtime's serveRuntime and the in-VM daemon). The daemon is a binary that
// imports nothing of node's, so these schemas are the one home of the shapes
// it answers in and the suite in packages/daemon holds it to them. A few
// readings of a machine are parsed here too (ps-time.ts): the runtime and the
// daemon both read them and neither may import the other, so this package is
// the only home a second copy cannot grow beside.

import { z } from "zod";
import { AgentSignInState, AgentsChangedEvent, AgentsTarget, ServerAdd, ServerAsk } from "./agents-report.js";
import { DEFAULT_PLACE_PORT } from "./app-ports.js";
import { CLOUD_ENV, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, LABS_ENV, TURN_TOKEN_ENV } from "./env.js";
import { Attachment, AttachmentRecord } from "./attachments.js";
import { fmtBytes, fmtBytesOfTotal, isoSeconds, KNOWN_HOSTS, nameList, openingTitle, PLACE_INSTALL, PLACE_LEAVE_LINE, plural, thisComputer, THIS_COMPUTER, threadWord, titleLine } from "./format.js";
import { InitJob, InitJobEvent, InitAgent, InitKeys, InitNeedsYou, InitNeedsYouEvent, InitRoad, InitScreenId, LoginChoice, LoginState, SIGN_IN_CODE_MAX } from "./init-job.js";
import { UsageAccountEvent, UsageRange, UsageSplit, UsageTokens } from "./usage.js";
import { effortsFor, everyModel, markedDefault, modelOf } from "./harness-picks.js";
import { AccessChoice, AgentDefaults, AgentDefaultsPatch, ProjectOverrides, ProjectOverridesPatch, AgentSetupSet, patchedFields } from "./thread-defaults.js";
import { GENERAL_DEFAULTS, GENERAL_FIELDS, patchedGeneral } from "./general-prefs.js";
import { UsageAlertEvent } from "./plan-alerts.js";
import { SessionSlateEvent, SLATE_OPS, SlateRunEvent, SlateValuesEvent } from "./slate/wire.js";
import { RecipeFile } from "./recipe-file.js";
import { ProjectHue, ProjectIcon } from "./project-look.js";
import type { OutsideLine } from "./outside-line.js";
import type { FsListReply as WireFsListReply } from "./generated/FsListReply.js";
import type { FsFilesReply as WireFsFilesReply } from "./generated/FsFilesReply.js";
import type { GitPrListReply as WireGitPrListReply } from "./generated/GitPrListReply.js";
import type { GitCheckpointReply as WireGitCheckpointReply } from "./generated/GitCheckpointReply.js";
import type { GitRestoreReply as WireGitRestoreReply } from "./generated/GitRestoreReply.js";
import type { FsSearchReply as WireFsSearchReply } from "./generated/FsSearchReply.js";
import type { GitCommitReply as WireGitCommitReply } from "./generated/GitCommitReply.js";
import type { GitDiscardReply as WireGitDiscardReply } from "./generated/GitDiscardReply.js";
import type { GitDiffFile as WireGitDiffFile } from "./generated/GitDiffFile.js";
import type { FsWriteReply as WireFsWriteReply } from "./generated/FsWriteReply.js";
import type { PullRequest as WirePullRequest } from "./generated/PullRequest.js";
import type { GitPrReadReply as WireGitPrReadReply } from "./generated/GitPrReadReply.js";
import type { GitIssueReadReply as WireGitIssueReadReply } from "./generated/GitIssueReadReply.js";
import type { GitPrCheckoutReply as WireGitPrCheckoutReply } from "./generated/GitPrCheckoutReply.js";
import type { GitPrDiffReply as WireGitPrDiffReply } from "./generated/GitPrDiffReply.js";
import type { GitPrReviewReply as WireGitPrReviewReply } from "./generated/GitPrReviewReply.js";
import type { GitPrViewReply as WireGitPrViewReply } from "./generated/GitPrViewReply.js";
import type { GitPrReplyReply as WireGitPrReplyReply } from "./generated/GitPrReplyReply.js";
import type { GitPrResolveReply as WireGitPrResolveReply } from "./generated/GitPrResolveReply.js";
import type { GitPrReactReply as WireGitPrReactReply } from "./generated/GitPrReactReply.js";
import type { GitRunLogReply as WireGitRunLogReply } from "./generated/GitRunLogReply.js";
import type { GitPrMergeReply as WireGitPrMergeReply } from "./generated/GitPrMergeReply.js";
import type { GitRepoReadReply as WireGitRepoReadReply } from "./generated/GitRepoReadReply.js";
import type { GitUpdateReply as WireGitUpdateReply } from "./generated/GitUpdateReply.js";
import type { SshStartReply as WireSshStartReply } from "./generated/SshStartReply.js";
import type { GitStartOnReply as WireGitStartOnReply } from "./generated/GitStartOnReply.js";
import type { GitBranchCompareReply as WireGitBranchCompareReply } from "./generated/GitBranchCompareReply.js";
import type { GitMergeInReply as WireGitMergeInReply } from "./generated/GitMergeInReply.js";
import type { SysHistoryReply as WireSysHistoryReply } from "./generated/SysHistoryReply.js";
import type { SysPoint as WireSysPoint } from "./generated/SysPoint.js";
import type { GitCheckpointDropReply as WireGitCheckpointDropReply } from "./generated/GitCheckpointDropReply.js";
import type { GitWorktreesReply as WireGitWorktreesReply } from "./generated/GitWorktreesReply.js";
import type { GitBranchesReply as WireGitBranchesReply } from "./generated/GitBranchesReply.js";
import type { WorktreeReport as WireWorktreeReport } from "./generated/WorktreeReport.js";
import type { WorktreeRemoval as WireWorktreeRemoval } from "./generated/WorktreeRemoval.js";
import { HERE_PLACE_ID, namesPlace } from "./place-word.js";
import { threadNeedsYou } from "./thread-state.js";
import { Checkout } from "./changes.js";
import { GitBranchCompareReply, GitMergeInReply, GitStartOnReply, TreeFact } from "./tree.js";
import { GitPrReadReply, GitPrViewReply, GitPrMergeReply, GitPrReactReply, GitPrReplyReply, GitPrResolveReply, GitRepoReadReply, GitRunLogReply, GitUpdateReply, MergeMethod, PullRequest, PullRequestItem, PullRequestSeen, PR_REPLY_BODY_MAX, ReactionContent } from "./pull-request.js";
import { GitIssueReadReply, GitPrCheckoutReply, GitPrDiffReply, GitPrReviewReply, ReviewDraft, WorkspaceFrom } from "./start.js";
import { AGENTS_ON, NAP_AFTER_MAX_MS, placeAtLimitLine, placeFullLine, TURN_LIMIT_MAX_MS } from "./place-state.js";
import type { AbsentComputer } from "./workspace-state.js";
import type { LinkTarget } from "./app-address.js";
import { rootsPathIn } from "./project-path.js";
import { SSH_KEY_MAX } from "./daemon-contract.js";
import { ReleaseChangedEvent } from "./release.js";
import { shellQuote } from "./shell-quote.js";
import { WorkspaceGlyph, WorkspaceLook, WorkspaceTheme } from "./workspace-look.js";
import { base64, type Held, portCloseDetail, reqId, type Same, sequenced } from "./wire/helpers.js";
import { EXEC_BODY_MAX, GUEST_ARGV_MAX, GUEST_CWD_MAX, GUEST_TOKEN_MAX, isHttpUrl, isPlainPath, isUnderPath, RelayPort } from "./wire/limits.js";
import { Capabilities, PlaceCapacity, WorkspaceSize } from "./wire/capabilities.js";
import { type EventAsker, MachineFacts, MachineState, SeedChoice, ThreadScope, WorkspaceAgents, WorkspaceOrigin } from "./views/workspace.js";
import { SessionOrigin, SessionView, ThreadMarks } from "./views/session.js";
import { RunStep, SessionBehindEvent, SessionChangesEvent, SessionCheckpointEvent, SessionDeltaEvent, SessionDoneEvent, SessionEndEvent, SessionHeldEvent, SessionMovedEvent, SessionNotifyEvent, SessionPermissionClosedEvent, SessionPermissionEvent, SessionPlanEvent, SessionQueuedEvent, SessionRunEvent, SessionStartEvent, SessionSteerEvent, SessionSubagentEvent } from "./views/session-events.js";
import { InboxFileEvent, PortCloseEvent, PortOpenEvent, WorkspaceAgentsEvent, WorkspaceCostEvent, WorkspaceCreatedEvent, WorkspaceCreatingEvent, WorkspaceDeletedEvent, WorkspaceGoneEvent, WorkspaceLookEvent, WorkspaceNappedEvent, WorkspaceRenamedEvent, WorkspaceReviewEvent, WorkspaceStatusEvent, WorkspaceUpgradedEvent, WorkspaceViewedEvent, WorkspaceWokenEvent } from "./views/workspace-events.js";
import { ProjectExportEvent, ProjectImportEvent, TerminalScheme } from "./views/project-bundle.js";
import { EditorId, HISTORY_PAGE_MAX, PreferencesChangedEvent, PreferencesPatch, ThreadHeadEvent, ThreadMarkedEvent, ThreadRewoundEvent } from "./views/preferences.js";
import { GoldenStageEvent, IMAGE_PASSPHRASE_MIN, MachineKind } from "./views/golden-image.js";
import { CopyWord, ForwardCloseEvent, ForwardOpenEvent, HostNoticeEvent, MachineBind, MachineShare, type PendingComputer, type PendingStep, PlaceAbsentEvent, type PlaceApplied, PlaceChangedEvent, PlaceJoinedEvent, PlacePendingEvent, PlacePresentEvent, type PlaceProvisionRow, PlaceRemovedEvent, PlaceSettingsAsk, PlaceSettingWord, type PlaceSetup, PlaceSetupEvent, PlaceSetupStep, PlaceStageEvent, type PlaceSync, PlaceSyncEvent, type PlaceView, type PlaceWait, ProjectAddedEvent, ProjectAddEvent, ProjectRemovedEvent, provisionCounts, provisionCountWord, RecipesChangedEvent, SETUP_STEP_CLASS, SETUP_STEP_WORDS, SudoPassword, WorkspaceCopy } from "./views/place.js";

export * from "./wire/limits.js";
export * from "./wire/capabilities.js";
export * from "./views/workspace.js";
export * from "./views/session.js";
export * from "./views/harness.js";
export { base64Length, PermissionEffect, PermissionOption } from "./wire/helpers.js";
export * from "./views/session-events.js";
export * from "./views/workspace-events.js";
export * from "./views/project-bundle.js";
export * from "./views/preferences.js";
export * from "./views/desktop-bridge.js";
export * from "./views/golden-image.js";
export * from "./views/place.js";
export * from "./views/snapshot-lineage.js";

export const EventUnion = z.discriminatedUnion("type", [
  WorkspaceCreatingEvent.extend(sequenced),
  WorkspaceCreatedEvent.extend(sequenced),
  WorkspaceNappedEvent.extend(sequenced),
  WorkspaceWokenEvent.extend(sequenced),
  WorkspaceUpgradedEvent.extend(sequenced),
  WorkspaceRenamedEvent.extend(sequenced),
  WorkspaceLookEvent.extend(sequenced),
  WorkspaceAgentsEvent.extend(sequenced),
  WorkspaceDeletedEvent.extend(sequenced),
  WorkspaceGoneEvent.extend(sequenced),
  WorkspaceStatusEvent.extend(sequenced),
  WorkspaceReviewEvent.extend(sequenced),
  WorkspaceViewedEvent.extend(sequenced),
  WorkspaceCostEvent.extend(sequenced),
  SessionStartEvent.extend(sequenced),
  SessionDeltaEvent.extend(sequenced),
  SessionDoneEvent.extend(sequenced),
  SessionEndEvent.extend(sequenced),
  SessionSteerEvent.extend(sequenced),
  SessionNotifyEvent.extend(sequenced),
  SessionPermissionEvent.extend(sequenced),
  SessionPermissionClosedEvent.extend(sequenced),
  SessionCheckpointEvent.extend(sequenced),
  SessionChangesEvent.extend(sequenced),
  SessionPlanEvent.extend(sequenced),
  SessionRunEvent.extend(sequenced),
  SessionMovedEvent.extend(sequenced),
  SessionBehindEvent.extend(sequenced),
  SessionSubagentEvent.extend(sequenced),
  SessionSlateEvent.extend(sequenced),
  SlateValuesEvent.extend(sequenced),
  SlateRunEvent.extend(sequenced),
  UsageAccountEvent.extend(sequenced),
  SessionQueuedEvent.extend(sequenced),
  SessionHeldEvent.extend(sequenced),
  ThreadMarkedEvent.extend(sequenced),
  ThreadHeadEvent.extend(sequenced),
  ThreadRewoundEvent.extend(sequenced),
  PortOpenEvent.extend(sequenced),
  PortCloseEvent.extend(sequenced),
  InboxFileEvent.extend(sequenced),
  GoldenStageEvent.extend(sequenced),
  ForwardOpenEvent.extend(sequenced),
  ForwardCloseEvent.extend(sequenced),
  ProjectAddedEvent.extend(sequenced),
  ProjectAddEvent.extend(sequenced),
  ProjectRemovedEvent.extend(sequenced),
  ProjectImportEvent.extend(sequenced),
  ProjectExportEvent.extend(sequenced),
  PreferencesChangedEvent.extend(sequenced),
  ReleaseChangedEvent.extend(sequenced),
  InitJobEvent.extend(sequenced),
  InitNeedsYouEvent.extend(sequenced),
  PlaceStageEvent.extend(sequenced),
  PlaceSetupEvent.extend(sequenced),
  PlaceSyncEvent.extend(sequenced),
  RecipesChangedEvent.extend(sequenced),
  PlacePendingEvent.extend(sequenced),
  PlaceJoinedEvent.extend(sequenced),
  PlacePresentEvent.extend(sequenced),
  PlaceAbsentEvent.extend(sequenced),
  PlaceRemovedEvent.extend(sequenced),
  PlaceChangedEvent.extend(sequenced),
  AgentsChangedEvent.extend(sequenced),
  UsageAlertEvent.extend(sequenced),
  HostNoticeEvent.extend(sequenced),
]);
export type EventUnion = z.infer<typeof EventUnion>;

/** What events.subscribe answers before it pushes anything. seq is the newest sequence the runtime has issued (0
 * before its first event): the cursor a client that has seen no event yet resubscribes from. stream names the
 * runtime process that issued it; sequences from two streams never compare, so a client that stored one and sees
 * another treats the reply as a gap whatever else it says. gap: the `after` sent is not a cursor into this stream
 * (the runtime no longer retains it, or it came with another stream id), nothing was replayed, and a client that
 * folds events must refetch sessions.history. */
export const EventsSubscribeReply = z.object({
  seq: z.number().int().nonnegative(),
  stream: z.string().optional(),
  gap: z.literal(true).optional(),
});
export type EventsSubscribeReply = z.infer<typeof EventsSubscribeReply>;

// --- daemon wire protocol (ws://0.0.0.0:7070, auth frame first, 4401 on anything else) ---

/** Client-side health of a daemon link. opening: a link that has never been open is being dialled, so nothing is
 * coming back yet and nothing may be promised back. connecting: a link that was open once is being dialled again.
 * unanswered: a link that has never been open and whose first-answer bound has passed, so what it dials is not
 * answering and the person is owed what to do instead of a wait. reauth-needed: the daemon refused the token the
 * host sent. A browser link holds no token of its own, so it opens a channel again and the host dials with the one
 * it holds now; the host's own link stops there. refused: the door answered the upgrade with a status, so no retry
 * at the usual pace opens anything; the link holds this until a dial gets past the door, and retries at the ceiling.
 * dead is terminal. The host's own link reports neither opening nor unanswered, as it reports no refusal: no person
 * reads its words. */
export const DaemonLinkStatus = z.enum(["opening", "connecting", "live", "reauth-needed", "refused", "unanswered", "dead"]);
export type DaemonLinkStatus = z.infer<typeof DaemonLinkStatus>;

/** The first frame on every daemon socket, the URL carries no token: answered {id, ok} then daemon.hello, or
 * the socket closes 4401 with one sentence of reason. Anything else first, or nothing, closes the same way.
 * A peer that sends more than a few KiB before this frame passes is closed 4401 too, so a client sends nothing
 * more until it is answered. port scopes the socket to one guest port: only tunnel ops on that port and ping are
 * answered, everything else is refused with code forbidden. */
export const DaemonAuthRequest = z.object({
  id: reqId,
  op: z.literal("auth"),
  token: z.string(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type DaemonAuthRequest = z.infer<typeof DaemonAuthRequest>;

// Replies carry no op, so each files/diff op has its own reply schema here
// instead of a discriminated union; DaemonOkResponse stays the loose envelope.

export const FsEntryType = z.enum(["file", "dir", "symlink"]);
export type FsEntryType = z.infer<typeof FsEntryType>;
/** name is the entry's own name in the listed directory; size is 0 for
 * anything but a file; mtime is epoch milliseconds. */
export const FsEntry = z.object({ name: z.string(), type: FsEntryType, size: z.number(), mtime: z.number() });
export type FsEntry = z.infer<typeof FsEntry>;
/** total counts the directory's entries after filtering; truncated means
 * entries holds only the first cap of them. */
export const FsListReply = z.object({ entries: z.array(FsEntry), truncated: z.boolean(), total: z.number() });
export type FsListReply = WireFsListReply;
type FsListReplyHeld = Held<Same<z.infer<typeof FsListReply>, FsListReply>>;

/** The checkout's files under the folder asked about, relative to it; truncated means files holds only the first
 * FS_FILES_CAP_ENTRIES of them. */
export const FsFilesReply = z.object({ files: z.array(z.string()), truncated: z.boolean() });
export type FsFilesReply = WireFsFilesReply;
type FsFilesReplyHeld = Held<Same<z.infer<typeof FsFilesReply>, FsFilesReply>>;

/** Which of a git host's two open lists an item came off. */
export const HostItemKind = z.enum(["pull-request", "issue"]);
export type HostItemKind = z.infer<typeof HostItemKind>;
/** One open pull request or issue, its body cut at GIT_PR_LIST_BODY_CAP characters. */
export const HostItem = z.object({ kind: HostItemKind, number: z.number().int(), title: z.string(), body: z.string(), url: z.string() });
export type HostItem = z.infer<typeof HostItem>;
/** The repository's open pull requests, then its open issues; empty with the note where nothing can be listed. */
export const GitPrListReply = z.object({ items: z.array(HostItem), note: z.string().optional(), noCliFor: z.string().optional() });
export type GitPrListReply = WireGitPrListReply;
type GitPrListReplyHeld = Held<Same<z.infer<typeof GitPrListReply>, GitPrListReply>>;

/** A checkpoint's ref, the commit it names, and whether its tree differs from the one that ref named before. */
export const GitCheckpointReply = z.object({ ref: z.string(), commit: z.string(), changed: z.boolean() });
export type GitCheckpointReply = WireGitCheckpointReply;
type GitCheckpointReplyHeld = Held<Same<z.infer<typeof GitCheckpointReply>, GitCheckpointReply>>;
/** The checkpoint of the tree as it stood before a restore, which restores it again, and how many files moved. */
export const GitRestoreReply = z.object({ before: z.string(), files: z.number().int() });
export type GitRestoreReply = WireGitRestoreReply;
type GitRestoreReplyHeld = Held<Same<z.infer<typeof GitRestoreReply>, GitRestoreReply>>;
/** How many of one thread's checkpoint refs a git.checkpointDrop took away. */
export const GitCheckpointDropReply = z.object({ dropped: z.number().int().nonnegative() });
export type GitCheckpointDropReply = WireGitCheckpointDropReply;
type GitCheckpointDropReplyHeld = Held<Same<z.infer<typeof GitCheckpointDropReply>, GitCheckpointDropReply>>;
/** One worktree as git lists it: where, the branch it holds (absent when detached), its commit (absent on a bare
 * repository), and whether its folder is gone while git still holds its record. */
export const GitWorktree = z.object({ path: z.string(), branch: z.string().optional(), head: z.string().optional(), prunable: z.boolean().optional() });
/** Every worktree of the repository a checkout belongs to, the repository's own folder first. */
export const GitWorktreesReply = z.object({ worktrees: z.array(GitWorktree) });
export type GitWorktreesReply = WireGitWorktreesReply;
type GitWorktreesReplyHeld = Held<Same<z.infer<typeof GitWorktreesReply>, GitWorktreesReply>>;
/** One local branch: its commit, when that commit was made in epoch seconds, its upstream and the worktree holding it. */
export const GitLocalBranch = z.object({
  name: z.string(),
  oid: z.string(),
  committed: z.number().int().nonnegative(),
  upstream: z.string().optional(),
  worktree: z.string().optional(),
});
/** A checkout's local branches, newest commit first and at most 500, and the one it is on, absent when detached. */
export const GitBranchesReply = z.object({ current: z.string().optional(), branches: z.array(GitLocalBranch), truncated: z.boolean().optional() });
export type GitBranchesReply = WireGitBranchesReply;
type GitBranchesReplyHeld = Held<Same<z.infer<typeof GitBranchesReply>, GitBranchesReply>>;

export const FsReadEncoding = z.enum(["utf8", "base64"]);
export type FsReadEncoding = z.infer<typeof FsReadEncoding>;
/** How many bytes an fs.write left in the file. */
export const FsWriteReply = z.object({ bytes: z.number().int() });
export type FsWriteReply = WireFsWriteReply;
type FsWriteReplyHeld = Held<Same<z.infer<typeof FsWriteReply>, FsWriteReply>>;
/** size is the whole file's byte length; content holds at most the first 2 MiB. */
export const FsReadReply = z.object({ content: z.string(), size: z.number(), truncated: z.boolean() });
export type FsReadReply = z.infer<typeof FsReadReply>;

export const FsSearchMode = z.enum(["files", "text"]);
export type FsSearchMode = z.infer<typeof FsSearchMode>;
/** path is relative to the folder searched; a text hit adds its line, from 1, and that line's text. truncated means
 * the walk stopped at FS_SEARCH_CAP_FILES or FS_SEARCH_CAP_HITS, or at its time or byte budget, before it had looked
 * everywhere. */
export const FsSearchReply = z.object({
  hits: z.array(z.object({ path: z.string(), line: z.number().int().positive().optional(), text: z.string().optional() })),
  truncated: z.boolean(),
});
export type FsSearchReply = WireFsSearchReply;
type FsSearchReplyHeld = Held<Same<z.infer<typeof FsSearchReply>, FsSearchReply>>;

/** The word git's branch header, and the checkout read off it, carry as the branch of a head on none. */
export const DETACHED_HEAD = "(detached)";

/** Porcelain v2 branch header: head is "(detached)" off a branch, oid
 * "(initial)" before the first commit; without an upstream, or with one whose
 * tracking ref is gone, upstream is absent and ahead/behind count against the
 * default branch. */
export const GitBranch = z.object({
  oid: z.string(),
  head: z.string(),
  upstream: z.string().optional(),
  ahead: z.number(),
  behind: z.number(),
});
export type GitBranch = z.infer<typeof GitBranch>;
/** xy is the two-letter porcelain code ("??" untracked, "!!" ignored, "." for
 * an unchanged side); origPath is set for renames and copies. */
export const GitStatusEntry = z.object({ xy: z.string(), path: z.string(), origPath: z.string().optional() });
export type GitStatusEntry = z.infer<typeof GitStatusEntry>;
/** root is the working tree's top-level directory, absolute on the guest.
 * editsUnread: a stopped workspace's branch was read and its entries were not,
 * so an empty list says nothing about edits never committed. countsUnknown:
 * its history was too long or too slow to walk, so ahead and behind say nothing. */
export const GitStatusReply = z.object({
  branch: GitBranch,
  entries: z.array(GitStatusEntry),
  root: z.string(),
  editsUnread: z.boolean().optional(),
  countsUnknown: z.boolean().optional(),
  /** How many stashes the repository holds; absent where there are none. */
  stashes: z.number().int().positive().optional(),
});
export type GitStatusReply = z.infer<typeof GitStatusReply>;

/** branch: working tree against the merge-base with the default branch;
 * unstaged: working tree against the index; staged: index against HEAD;
 * head: working tree against HEAD with every untracked file as a new one, what a commit could take. */
export const GitDiffScope = z.enum(["branch", "unstaged", "staged", "head"]);
export type GitDiffScope = z.infer<typeof GitDiffScope>;
/** kind is added, modified, deleted, renamed or copied; additions and deletions count lines, none for a binary. blob is
 * the id git gives the file's worktree contents now, absent for a file that is gone: a viewed mark is kept against it,
 * so a file that changes again reads unviewed with nothing compared anywhere. */
export const GitDiffFile = z.object({ path: z.string(), kind: z.string(), additions: z.number(), deletions: z.number(), patch: z.string(), blob: z.string().optional() });
export type GitDiffFile = WireGitDiffFile;
type GitDiffFileHeld = Held<Same<z.infer<typeof GitDiffFile>, GitDiffFile>>;
/** The file a git.discard put back as HEAD has it. */
export const GitDiscardReply = z.object({ path: z.string() });
export type GitDiscardReply = WireGitDiscardReply;
type GitDiscardReplyHeld = Held<Same<z.infer<typeof GitDiscardReply>, GitDiscardReply>>;
/** The commit a git.commit made: its id, its subject, and what it changed as git's short stat counts it. */
export const GitCommitReply = z.object({ oid: z.string(), subject: z.string(), filesChanged: z.number().int(), insertions: z.number().int(), deletions: z.number().int() });
export type GitCommitReply = WireGitCommitReply;
type GitCommitReplyHeld = Held<Same<z.infer<typeof GitCommitReply>, GitCommitReply>>;
// The pull request's shapes live beside its words; each is held to the type the daemon's crate writes.
type PullRequestHeld = Held<Same<PullRequest, WirePullRequest>>;
type GitPrReadReplyHeld = Held<Same<GitPrReadReply, WireGitPrReadReply>>;
type GitIssueReadReplyHeld = Held<Same<GitIssueReadReply, WireGitIssueReadReply>>;
type GitPrCheckoutReplyHeld = Held<Same<GitPrCheckoutReply, WireGitPrCheckoutReply>>;
type GitPrDiffReplyHeld = Held<Same<GitPrDiffReply, WireGitPrDiffReply>>;
type GitPrReviewReplyHeld = Held<Same<GitPrReviewReply, WireGitPrReviewReply>>;
type GitPrViewReplyHeld = Held<Same<GitPrViewReply, WireGitPrViewReply>>;
type GitPrReplyReplyHeld = Held<Same<GitPrReplyReply, WireGitPrReplyReply>>;
type GitPrResolveReplyHeld = Held<Same<GitPrResolveReply, WireGitPrResolveReply>>;
type GitPrReactReplyHeld = Held<Same<GitPrReactReply, WireGitPrReactReply>>;
type GitRunLogReplyHeld = Held<Same<GitRunLogReply, WireGitRunLogReply>>;
type GitPrMergeReplyHeld = Held<Same<GitPrMergeReply, WireGitPrMergeReply>>;
type GitRepoReadReplyHeld = Held<Same<GitRepoReadReply, WireGitRepoReadReply>>;
type GitUpdateReplyHeld = Held<Same<GitUpdateReply, WireGitUpdateReply>>;
/** A workspace's ssh host key as this computer pins it: one `ssh-ed25519 <base64> [comment]` line and nothing
 * more. The key is the daemon's word, and a root inside the workspace can answer in its place, so a second line or
 * a marker (`@cert-authority`) would be a key this computer's ssh trusts for every wsp- alias. */
export const SSH_HOST_KEY_LINE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [!-~]+)?$/;
/** Where a machine's own ssh server listens on its loopback, and its host key as one OpenSSH public key line. */
export const SshStartReply = z.object({ port: z.number().int().min(1).max(65535), hostKey: z.string().min(1).max(SSH_KEY_MAX).regex(SSH_HOST_KEY_LINE) });
export type SshStartReply = WireSshStartReply;
type SshStartReplyHeld = Held<Same<z.infer<typeof SshStartReply>, SshStartReply>>;
// The tree's three replies live beside its words; each is held to the type the daemon's crate writes.
type GitStartOnReplyHeld = Held<Same<GitStartOnReply, WireGitStartOnReply>>;
type GitBranchCompareReplyHeld = Held<Same<GitBranchCompareReply, WireGitBranchCompareReply>>;
type GitMergeInReplyHeld = Held<Same<GitMergeInReply, WireGitMergeInReply>>;
/** base is the ref the branch scope diffed against (null for other scopes);
 * truncated means the 2 MiB patch budget cut files or a patch short. */
export const GitDiffReply = z.object({ base: z.string().nullable(), files: z.array(GitDiffFile), truncated: z.boolean(), moved: z.array(z.string()).default([]) });
export type GitDiffReply = z.infer<typeof GitDiffReply>;
/** The commit a git.snapshot recorded, by its full sha. */
export const GitSnapshotReply = z.object({ commit: z.string() });
export type GitSnapshotReply = z.infer<typeof GitSnapshotReply>;

/** One live or exited pty the daemon still holds; exited ones stay until pty.kill. */
export const PtyListEntry = z.object({
  id: z.string(),
  pid: z.number(),
  cols: z.number(),
  rows: z.number(),
  exited: z.boolean(),
  /** Set on a pty that runs a reply's command and still belongs to that reply: no pane adopts it until pty.tab. */
  reply: z.boolean().optional(),
});
export type PtyListEntry = z.infer<typeof PtyListEntry>;
export const PtyListReply = z.object({ ptys: z.array(PtyListEntry) });
export type PtyListReply = z.infer<typeof PtyListReply>;

export const ProcSignal = z.enum(["TERM", "KILL"]);
export type ProcSignal = z.infer<typeof ProcSignal>;

/** One process as /proc/[pid] shows it. cpu is its busy share of one core
 * over the interval (a threaded process can pass 100); rss in bytes;
 * startedAt epoch milliseconds; cmdline the first 200 bytes with the NULs as
 * spaces, empty for a kernel thread; pty names the daemon pty whose shell
 * this is. The environment never travels: it holds tokens. */
export const ProcEntry = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  user: z.string(),
  state: z.string(),
  comm: z.string(),
  cmdline: z.string(),
  cpu: z.number(),
  rss: z.number(),
  startedAt: z.number(),
  pty: z.string().optional(),
});
export type ProcEntry = z.infer<typeof ProcEntry>;

/** Which column a list of processes is ordered by: what is spending the cpu, or what is holding the memory. */
export type ProcSort = "cpu" | "mem";

/** Processes heaviest first on that column, ties broken by pid so one snapshot always lays out the same way. The
 * app's pane sorts each set of siblings by this and the command line's own list reads it flat; a second copy of the
 * rule is how the two would come to disagree about which process is the busiest. */
export const byProcColumn =
  (sort: ProcSort) =>
  (a: ProcEntry, b: ProcEntry): number => {
    const d = sort === "cpu" ? b.cpu - a.cpu : b.rss - a.rss;
    return d !== 0 ? d : a.pid - b.pid;
  };

/** cwd is null when unreadable; ports are the TCP ports this pid listens on;
 * children are the pids whose parent it is, as of the last snapshot. */
export const ProcInspectReply = z.object({
  pid: z.number().int(),
  cwd: z.string().nullable(),
  ports: z.array(z.number().int()),
  /** Absent where the machine's own processes module cannot count them: this computer reads its processes with ps,
   * which has no thread column on macOS. */
  threads: z.number().int().optional(),
  children: z.array(z.number().int()),
});
export type ProcInspectReply = z.infer<typeof ProcInspectReply>;

/** How much of a command's output one exec op carries back, stdout and stderr together. Past it the reply says
 * truncated and the rest is dropped: the road is a WebSocket frame and a turn that cats a log would otherwise put
 * the machine's whole disk through it. */
export const EXEC_OUTPUT_MAX = 2 * 1024 * 1024;

/** How long an exec frame that named no deadline of its own gets. Every caller on the host's side names one; this
 * is what bounds a frame that did not, so nothing runs without end on a computer somebody owns. */
export const EXEC_TIMEOUT_DEFAULT_MS = 20_000;

/** The longest an exec frame may ask for, which is the cap the daemon holds its own timer to. A caller with a
 * command that can run longer launches it detached and polls it instead. */
export const EXEC_TIMEOUT_MAX_MS = 600_000;

/** The exit code a command killed at its deadline answers with, on every road wsp runs one: the shell's own word
 * for it, so a caller reads one number whether the command was launched detached on a guest or run by an exec op
 * on a place. One home, since the two roads' guards are compared against each other in tests. */
export const EXEC_DEADLINE_EXIT = 124;

/** One command on this machine, for a host driving it over a link it did not open: `bash -c`, in the daemon's own
 * root and environment, with the bytes for its stdin where the caller has any. The byte road a daemon token, a
 * roots file and a project part take on a machine whose backend mints no signed URL. */
export const DaemonExecRequest = z.object({
  id: reqId,
  op: z.literal("exec"),
  cmd: z.string().max(EXEC_BODY_MAX),
  timeoutMs: z.number().int().positive().max(EXEC_TIMEOUT_MAX_MS).optional(),
  /** Bytes for the command's stdin, base64; absent closes stdin at once. */
  stdin: z.string().optional(),
});
export type DaemonExecRequest = z.infer<typeof DaemonExecRequest>;

export const DaemonExecReply = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string(), truncated: z.boolean() });
export type DaemonExecReply = z.infer<typeof DaemonExecReply>;

/** What a guest session carries: the tool server's JSON-RPC messages, or one command line and its streams. */
export const GuestKind = z.enum(["mcp", "cli"]);
export type GuestKind = z.infer<typeof GuestKind>;

export const DaemonRequest = z.discriminatedUnion("op", [
  /** machineId, on these seven and on no other op of this road: the workspace the pty belongs to, on a daemon
   * that runs workspaces. A workspace on a computer somebody owns runs no daemon of its own, so the daemon of
   * the computer holding it opens the shell inside that workspace's namespaces, in the folder the frame names,
   * which is absolute and is asked for, since that daemon has no working directory inside a workspace. Without
   * one the pty is the daemon's own computer's, which is every machine wsp forked; every later op on that pty
   * names the same workspace, and one that names another, or none, is answered no such pty. */
  z.object({
    id: reqId,
    op: z.literal("pty.create"),
    cols: z.number().optional(),
    rows: z.number().optional(),
    shell: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    /** A command line the pty runs through the person's own shell and exits with: a reply's block run where it
     * stands. Such a pty is that reply's, which pty.list marks, until pty.tab hands it to the panes. */
    run: z.string().optional(),
    machineId: z.string().optional(),
  }),
  z.object({ id: reqId, op: z.literal("pty.attach"), ptyId: z.string(), machineId: z.string().optional() }),
  /** This socket's listeners off that pty, the mirror of pty.attach: a pane that closed stops the bytes of its
   * own pty on a socket that many panes share. */
  z.object({ id: reqId, op: z.literal("pty.detach"), ptyId: z.string(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("pty.write"), ptyId: z.string(), data: z.string(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("pty.resize"), ptyId: z.string(), cols: z.number(), rows: z.number(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("pty.kill"), ptyId: z.string(), machineId: z.string().optional() }),
  /** With a workspace named, that workspace's ptys alone; without one, this daemon's own alone. */
  z.object({ id: reqId, op: z.literal("pty.list"), machineId: z.string().optional() }),
  /** With roots, the listeners of the processes they hold: each root's process group and every process under it,
   * and with a folder, every process running in it. A watch that names no roots sees every listener on the machine,
   * which is what the host's own watchers ask for. A second watch on the socket names its roots again. */
  z.object({ id: reqId, op: z.literal("ports.watch"), roots: z.array(z.number().int().nonnegative()).optional(), folder: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("manifest.get") }),
  z.object({
    id: reqId,
    op: z.literal("manifest.record"),
    cmd: z.string(),
    cwd: z.string(),
    port: z.number().optional(),
  }),
  z.object({ id: reqId, op: z.literal("manifest.restartScript") }),
  z.object({ id: reqId, op: z.literal("inbox.watch") }),
  z.object({ id: reqId, op: z.literal("inbox.rescan") }),
  /** Streams sys.sample events to this socket every two seconds until it
   * closes. One sampler serves every subscriber and stops with the last one;
   * the first sample lands one interval after the reply, since cpu is a delta. */
  z.object({ id: reqId, op: z.literal("sys.watch") }),
  // The computer's readings the daemon kept a minute apart, between two instants, folded into steps of stepMs.
  z.object({ id: reqId, op: z.literal("sys.history"), from: z.number().int(), to: z.number().int(), stepMs: z.number().int().nonnegative() }),
  /** Streams the processes to this socket until proc.unwatch or the socket
   * closes: one whole proc.snapshot first, two seconds after the reply since
   * cpu is a delta (at once where the sampler is already running), then a
   * proc.changes every five seconds naming the frame it follows. A socket
   * already watching that watches again is sent a whole snapshot next. The
   * daemon reads /proc only while some socket watches. */
  z.object({ id: reqId, op: z.literal("proc.watch") }),
  z.object({ id: reqId, op: z.literal("proc.unwatch") }),
  /** One process in depth, replied as a ProcInspectReply; this is the only op
   * that scans /proc/net, and only for that pid's sockets. */
  z.object({ id: reqId, op: z.literal("proc.inspect"), pid: z.number().int().positive() }),
  /** Sends the signal. pid 1, the daemon and the daemon's parent are refused
   * with code forbidden; a pid that is gone answers not-found. */
  z.object({ id: reqId, op: z.literal("proc.kill"), pid: z.number().int().positive(), signal: ProcSignal }),
  z.object({ id: reqId, op: z.literal("ping") }),
  /** Lists one directory's direct children, each request under its own entry
   * cap. Paths are relative to the daemon's home root (HOME unless started
   * with --root) or absolute inside it or an imported project folder named in
   * DAEMON_ROOTS_PATH; anything resolving outside every root, through .. or a
   * symlink, is refused with code outside-root. gitignore hides .git and the
   * entries git would ignore.
   *
   * machineId, on these ten and on no other op of this road: the workspace the frame is for, on a daemon that
   * runs workspaces. A workspace on a computer somebody owns runs no daemon of its own, so the daemon of the
   * computer holding it answers for it: the path then names the folder as that workspace sees it, a file is read
   * through the workspace's own rootfs and a git operation runs inside the workspace, in its namespaces and its
   * cgroup. Without one the path is resolved under the daemon's own roots, which is every other machine. A daemon
   * that runs no workspace answers the missing refusal for any machineId. */
  z.object({
    id: reqId,
    op: z.literal("fs.list"),
    path: z.string(),
    gitignore: z.boolean().optional(),
    machineId: z.string().optional(),
  }),
  /** Every file of the checkout under cwd that git would show, tracked or untracked and never ignored, relative
   * to cwd, answered from `git ls-files` and kept until a folder holding one of them changes. */
  z.object({ id: reqId, op: z.literal("fs.files"), cwd: z.string(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("fs.read"), path: z.string(), encoding: FsReadEncoding.optional(), machineId: z.string().optional() }),
  /** Replaces an existing regular file's contents whole and answers an FsWriteReply: written beside it and renamed
   * over, its mode and owner kept, never through a link standing where the file should be, and refused over
   * FS_WRITE_CAP_BYTES. The folder resolves inside a root as fs.read's path does. */
  z.object({ id: reqId, op: z.literal("fs.write"), path: z.string(), contents: z.string(), machineId: z.string().optional() }),
  /** A reply's pty handed to the panes, still running: pty.list stops marking it, so every pane adopts it as a tab. */
  z.object({ id: reqId, op: z.literal("pty.tab"), ptyId: z.string(), machineId: z.string().optional() }),
  /** Searches under one folder, resolved as fs.list resolves its path: files answers every file whose path below the
   * folder holds the query's letters in order, text every line of a text file there that holds the query, both
   * case-insensitive. The walk reads the folder's .gitignore and .ignore files, leaves hidden names out, never
   * follows a symlink, and skips a file over FS_READ_CAP_BYTES or holding a NUL byte; it answers what it found when a
   * cap or its time budget stops it, with truncated set. */
  z.object({ id: reqId, op: z.literal("fs.search"), path: z.string(), query: z.string(), mode: FsSearchMode, machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("git.status"), cwd: z.string(), machineId: z.string().optional() }),
  /** paths names files from the checkout's top, each read as a letter-for-letter name; whole gives each patch its
   * whole file in one hunk, which an editor over the new side needs. */
  z.object({
    id: reqId,
    op: z.literal("git.diff"),
    cwd: z.string(),
    scope: GitDiffScope,
    path: z.string().optional(),
    paths: z.array(z.string()).optional(),
    whole: z.boolean().optional(),
    machineId: z.string().optional(),
  }),
  /** Puts one changed file back as HEAD has it, or removes it where HEAD has none, and answers a GitDiscardReply;
   * a file with no change is refused by name. */
  z.object({ id: reqId, op: z.literal("git.discard"), cwd: z.string(), path: z.string(), machineId: z.string().optional() }),
  /** Commits the named files and no others, untracked ones added first, with the message on git's stdin, hooks
   * and all, and answers a GitCommitReply. A held index is waited on once; git knowing no author, and a hook that
   * says no, are refused in one sentence each. */
  z.object({ id: reqId, op: z.literal("git.commit"), cwd: z.string(), message: z.string(), paths: z.array(z.string()), machineId: z.string().optional() }),
  /** Records the checkout as it stands, new files in and ignored ones out, as one commit on top of HEAD through an
   * index of its own, so the checkout's own index is never written; answers a GitSnapshotReply. No ref names it. */
  z.object({ id: reqId, op: z.literal("git.snapshot"), cwd: z.string(), machineId: z.string().optional() }),
  /** The diff between two commits, each its full 40 character sha or the frame is refused before git runs; answers
   * a GitDiffReply. */
  z.object({ id: reqId, op: z.literal("git.range"), cwd: z.string(), from: z.string(), to: z.string(), path: z.string().optional(), machineId: z.string().optional() }),
  /** What a turn changed between two of its snapshots, the agent's own work alone, each snapshot its full sha; answers
   * a GitDiffReply with the moves it did not write on `moved`. git.range stays the pure diff of the two trees. */
  z.object({ id: reqId, op: z.literal("git.turn"), cwd: z.string(), from: z.string(), to: z.string(), path: z.string().optional(), machineId: z.string().optional() }),
  /** Pushes the branch the checkout is on to its remote and answers a GitPushReply. The base branch itself is
   * refused: wsp makes no branch and pushes none of the branch the work started from. Without a base the
   * checkout's own default branch is read, which is what a project recorded without one was cloned at. */
  z.object({ id: reqId, op: z.literal("git.push"), cwd: z.string(), base: z.string().optional(), machineId: z.string().optional() }),
  /** Opens the branch's pull request against the base through the git host's own signed-in command line, or
   * answers with the one already open. Refused with code no-host-cli where that command line is not there. */
  z.object({ id: reqId, op: z.literal("git.pr"), cwd: z.string(), base: z.string().optional(), title: z.string().optional(), body: z.string().optional(), machineId: z.string().optional() }),
  /** A pull request by branch or by number through that same command line, the repository named off the remote the
   * frame carries and never off the folder, where nothing is read and no git runs; answered as a GitPrReadReply, with
   * no pull request where the host knows none. The host takes the remote off the project's own record. */
  z.object({
    id: reqId,
    op: z.literal("git.prRead"),
    cwd: z.string(),
    remote: z.string(),
    branch: z.string().optional(),
    number: z.number().int().nonnegative().optional(),
    seen: z.string().optional(),
    machineId: z.string().optional(),
  }),
  /** One pull request's page through that same command line, answered as a GitPrViewReply. */
  z.object({ id: reqId, op: z.literal("git.prView"), cwd: z.string(), remote: z.string(), number: z.number().int().nonnegative(), machineId: z.string().optional() }),
  /** The failed steps of one job of one run, its last CHECK_LOG_LINES lines, answered as a GitRunLogReply. */
  z.object({
    id: reqId,
    op: z.literal("git.runLog"),
    cwd: z.string(),
    remote: z.string(),
    runId: z.number().int().nonnegative(),
    jobId: z.number().int().nonnegative(),
    machineId: z.string().optional(),
  }),
  /** Merges a pull request by the method named, or arms it to merge once its checks pass, only while its head is the
   * commit named, and answers a GitPrMergeReply; a refusal is the command line's own last line. */
  z.object({
    id: reqId,
    op: z.literal("git.prMerge"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    method: MergeMethod,
    auto: z.boolean(),
    headOid: z.string(),
    machineId: z.string().optional(),
  }),
  /** An issue, or a pull request read as the issue it also is, by number in the repository the remote names, answered
   * as a GitIssueReadReply with each body cut as a list cuts it. */
  z.object({ id: reqId, op: z.literal("git.issueRead"), cwd: z.string(), remote: z.string(), number: z.number().int().nonnegative(), machineId: z.string().optional() }),
  /** Puts the copy on a pull request's head branch through the git host's own command line, run inside the copy, the
   * host read off the copy's own remote; answered as a GitPrCheckoutReply naming the branch, which tracks where the
   * head lives. */
  z.object({ id: reqId, op: z.literal("git.prCheckout"), cwd: z.string(), number: z.number().int().nonnegative(), machineId: z.string().optional() }),
  /** A pull request's diff against its base, cut on a file's boundary at maxBytes, never past GIT_DIFF_CAP_BYTES and
   * REVIEW_DIFF_MAX_BYTES where absent, answered as a GitPrDiffReply naming every file the cut left out. */
  z.object({
    id: reqId,
    op: z.literal("git.prDiff"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    maxBytes: z.number().int().positive().optional(),
    machineId: z.string().optional(),
  }),
  /** Posts one review in one call pinned to the head named: the verdict, the body and every comment on a line, a comment
   * whose line falls outside the diff put into the body; answered as a GitPrReviewReply. A refusal is the command
   * line's own last line. */
  z.object({
    id: reqId,
    op: z.literal("git.prReview"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    headOid: z.string(),
    event: z.enum(["comment", "approve", "request_changes"]),
    body: z.string(),
    comments: z.array(z.object({ id: z.string(), path: z.string(), line: z.number().int().nonnegative(), side: z.enum(["LEFT", "RIGHT"]), body: z.string() })),
    machineId: z.string().optional(),
  }),
  /** Posts a reply as the signed-in person: under the comment on a line replyTo names, or, with none, as a new comment
   * in the conversation, the body sent as typed on stdin; answered as a GitPrReplyReply, a line reply carrying the
   * threadId the frame names. */
  z.object({
    id: reqId,
    op: z.literal("git.prReply"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    replyTo: z.number().int().nonnegative().optional(),
    threadId: z.string().optional(),
    body: z.string().max(PR_REPLY_BODY_MAX),
    machineId: z.string().optional(),
  }),
  /** Resolves or unresolves a review thread, named by its node id, as the signed-in person; answered as a
   * GitPrResolveReply. A thread id that is not a node id's shape, or names a thread of any pull request but the
   * repository's number given, is refused before the mutation runs. */
  z.object({
    id: reqId,
    op: z.literal("git.prResolve"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    threadId: z.string(),
    resolved: z.boolean(),
    machineId: z.string().optional(),
  }),
  /** Adds or takes off one reaction on the item a node id names, as the signed-in person; answered as a GitPrReactReply
   * with every reaction on it now. A subject that is not a node id's shape, or is not a comment or a review on the
   * repository's pull request numbered, is refused before the mutation runs. */
  z.object({
    id: reqId,
    op: z.literal("git.prReact"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    subject: z.string(),
    content: ReactionContent,
    on: z.boolean(),
    machineId: z.string().optional(),
  }),
  /** How the repository lets a pull request land, answered as a GitRepoReadReply. */
  z.object({ id: reqId, op: z.literal("git.repoRead"), cwd: z.string(), remote: z.string(), machineId: z.string().optional() }),
  /** Merges the base's latest commits from the remote into the checkout's branch and answers a GitUpdateReply. A
   * checkout with changes no commit holds is refused with the files named; a merge that conflicts is taken back at
   * once and answered with the files, the checkout left as it was. */
  z.object({ id: reqId, op: z.literal("git.update"), cwd: z.string(), base: z.string().optional(), machineId: z.string().optional() }),
  /** Puts the checkout on a branch as the remote holds it, fetched and reset with every untracked file dropped, and
   * answers a GitStartOnReply: what a child's copy starts on, the branch its lead pushed. */
  z.object({ id: reqId, op: z.literal("git.startOn"), cwd: z.string(), branch: z.string(), machineId: z.string().optional() }),
  /** How far one branch is from a base, a branch or a commit, on the git host, through this computer's own command
   * line with the repository named off the remote given, answered as a GitBranchCompareReply; a head the host lacks
   * is not pushed. */
  z.object({ id: reqId, op: z.literal("git.branchCompare"), cwd: z.string(), remote: z.string(), base: z.string(), head: z.string() }),
  /** Merges another branch into the checkout's with a merge commit, from the remote or from a copy's folder on this
   * computer, and answers a GitMergeInReply; refused over changes no commit holds, and a merge that conflicts is
   * taken back and answered with the files. A folder is refused on any daemon but this computer's own. */
  z.object({ id: reqId, op: z.literal("git.mergeIn"), cwd: z.string(), branch: z.string(), from: z.string().optional(), machineId: z.string().optional() }),
  /** The repository's open pull requests and issues through that same command line, answered as a GitPrListReply.
   * No command line for the host, or one nobody signed in, is an empty list with the note saying so. */
  z.object({ id: reqId, op: z.literal("git.prList"), cwd: z.string(), machineId: z.string().optional() }),
  /** Records the checkout's whole tree at a turn's end as a commit outside every branch, under the ref the daemon
   * names from the scope (else the copy's folder), the thread and the turn, and answers a GitCheckpointReply. A
   * thread keeps its newest hundred refs, the `-before-` refs counted. HEAD, the index and the branch never move. */
  z.object({ id: reqId, op: z.literal("git.checkpoint"), cwd: z.string(), thread: z.string(), turn: z.string(), scope: z.string().optional(), machineId: z.string().optional() }),
  /** Puts the tree back to one of the scope's checkpoints (else this copy's), recording the tree as it stood first,
   * and answers a GitRestoreReply whose before restores it again. */
  z.object({ id: reqId, op: z.literal("git.restore"), cwd: z.string(), checkpoint: z.string(), scope: z.string().optional(), machineId: z.string().optional() }),
  /** Takes away one thread's checkpoint refs under the scope and no other thread's; answers a GitCheckpointDropReply. */
  z.object({ id: reqId, op: z.literal("git.checkpointDrop"), cwd: z.string(), scope: z.string().optional(), thread: z.string(), machineId: z.string().optional() }),
  /** Every worktree of the checkout's repository, its own folder first, read off git each time; a GitWorktreesReply. */
  z.object({ id: reqId, op: z.literal("git.worktrees"), cwd: z.string(), machineId: z.string().optional() }),
  /** The checkout's local branches, newest commit first, and the one it is on; a GitBranchesReply. */
  z.object({ id: reqId, op: z.literal("git.branches"), cwd: z.string(), machineId: z.string().optional() }),
  /** Puts the checkout on a new branch at its HEAD with every change carried along and nothing reset; answers a
   * GitStartOnReply. */
  z.object({ id: reqId, op: z.literal("git.switchNew"), cwd: z.string(), branch: z.string(), machineId: z.string().optional() }),
  /** Fetches one branch of a remote, by name or URL, into a local branch (`into`, else the same name): made where it is
   * not there, moved only forward where it is, never forced; answers a GitStartOnReply naming the local branch. */
  z.object({ id: reqId, op: z.literal("git.fetchBranch"), cwd: z.string(), remote: z.string(), branch: z.string(), into: z.string().optional(), machineId: z.string().optional() }),
  /** Replies with a HostFolderListing: one level of folders on the computer this daemon runs on, for the folder
   * picker of a computer somebody owns. The roots are the home of the login the daemon runs as and each of
   * `projects` the home does not hold; `dir` absent lists the home, and so does a folder inside the roots that is
   * gone. A path outside the roots, a relative one, or one through a symlink that leaves them is refused with code
   * outside-root. Folders only, one level, `repo` where the folder holds .git; the dot-named ones are counted and
   * listed only when `hidden`. `repos` answers every repo under the roots instead, as this computer's repos listing
   * does: REPO_DEPTH folders deep and REPO_CAP of them at most, walking into no repo, no link, no dot-named folder and
   * nothing in CACHE_DIRS, each with its branch and when git last wrote there, most recent first. No file is read
   * but a repo's HEAD. */
  z.object({ id: reqId, op: z.literal("fs.folders"), dir: z.string().optional(), hidden: z.boolean().optional(), repos: z.boolean().optional(), projects: z.array(z.string()).optional() }),
  /** One laptop-side connection to a guest loopback port, for the sign-in
   * callback forward. The daemon dials 127.0.0.1 then ::1 (a Node 22 tool
   * binds [::1] only). data is base64; the reply to tunnel.open comes after
   * the guest accepted. */
  /** machineId dials the port inside that workspace's own network namespace, on a daemon that runs workspaces. */
  z.object({ id: reqId, op: z.literal("tunnel.open"), tunnelId: z.string(), port: z.number().int().min(1).max(65535), machineId: z.string().optional() }),
  /** Starts the machine's own ssh server, or the named workspace's, on its loopback where none runs, with the one
   * ed25519 public key given as all it lets in, and answers an SshStartReply. Refused in one sentence where the image
   * has no /usr/sbin/sshd. The server and everything its sessions started are ended once its last session has been
   * closed for SSH_IDLE_MS. */
  z.object({ id: reqId, op: z.literal("ssh.start"), authorizedKey: z.string().min(1).max(SSH_KEY_MAX), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("tunnel.write"), tunnelId: z.string(), data: z.string() }),
  z.object({ id: reqId, op: z.literal("tunnel.close"), tunnelId: z.string() }),
  DaemonExecRequest,
  /** Sweeps wsp off this computer and answers what it took, then the agent exits: the one op whose handler belongs
   * to the link a place opened and not to the daemon's own switch. */
  z.object({ id: reqId, op: z.literal("place.leave") }),
  /** A process inside this machine opens a guest session: the tool server, or one command line. The daemon relays
   * it up the socket the host holds and reads nothing of what rides here; the token is the thread's, and the host
   * is what reads it. Sent on the inbound road alone, since no guest runs on a computer somebody owns. */
  z.object({
    id: reqId,
    op: z.literal("guest.open"),
    kind: GuestKind,
    /** The thread's token off WSP_HOST_TOKEN, "" when the launch carried none; the host reads it, the daemon never does. */
    token: z.string().max(GUEST_TOKEN_MAX),
    turnToken: z.string().max(GUEST_TOKEN_MAX).optional(),
    argv: z.array(z.string()).max(GUEST_ARGV_MAX),
    cwd: z.string().max(GUEST_CWD_MAX),
  }),
  /** One message from the guest process on the session its socket opened. */
  z.object({ id: reqId, op: z.literal("guest.send"), message: z.unknown() }),
  /** The host asks to be handed every guest session this daemon opens; the last socket to ask is where they go. */
  z.object({ id: reqId, op: z.literal("guest.watch") }),
  /** The host's answer on a session, and the host ending one; both are refused on a socket that never watched. */
  z.object({ id: reqId, op: z.literal("guest.reply"), session: z.string(), message: z.unknown() }),
  z.object({ id: reqId, op: z.literal("guest.close"), session: z.string(), error: z.string().optional() }),
  /** The daemon this host deploys, landed on the computer the link runs on and started in place of the one running
   * there. The parts arrive as machine.putBytes's do, in seq order under one upload id on one socket; the part
   * marked last is checked against sha256, moved over the binary the unit starts and answered, and then the agent
   * ends so whatever supervises it starts the new one. Nothing on that computer is swept: the workspaces' records
   * stay on its disk and the daemon that comes up reads them again.
   *
   * The other link op, and for the same reason: a binary is bytes and never a command line, since a command sits in
   * a world readable /proc/<pid>/cmdline while it runs. */
  z.object({
    id: reqId,
    op: z.literal("place.update"),
    uploadId: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9]+$/),
    seq: z.number().int().min(0),
    last: z.boolean(),
    data: z.string(),
    /** Lowercase hex sha256 of the whole binary, carried on every part and read on the last: a binary that landed
     * short would otherwise be moved over the one the unit starts, and Restart=always would loop on it. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

/** The reply to guest.open: the id both sides name the session by. Every other guest op answers the empty ok. */
export const GuestOpenReply = z.object({ session: z.string() });
export type GuestOpenReply = z.infer<typeof GuestOpenReply>;

/** What a cli session's messages carry: text for one of the two streams, then the code the line ended with. A tool
 * server session carries the harness's own JSON-RPC, which has no shape of ours. */
export const GuestCliMessage = z.union([
  z.object({ stream: z.enum(["out", "err"]), text: z.string() }),
  z.object({ exit: z.number().int() }),
]);
export type GuestCliMessage = z.infer<typeof GuestCliMessage>;

// --- machines over a place link -------------------------------------------
//
// One computer drives another computer's machines: every call the engine's
// MachineBackend and Machine interfaces carry, as a frame on the link the
// place opened. The data shapes live here rather than in the engine because
// they are the wire and the interface at once, and two copies of a spec would
// drift the day a field is added on one side.

/** What keeps the daemon running on a machine: the guest's own service manager, or the machine's boot itself on a
 * guest that has none (a container, whose PID 1 is the only thing that outlives an exec). */
export const DaemonSupervisor = z.enum(["systemd", "entrypoint"]);
export type DaemonSupervisor = z.infer<typeof DaemonSupervisor>;

export const MachineSpec = z.object({
  kind: MachineKind,
  template: z.string().optional(),
  fromSnapshot: z.string().optional(),
  cpu: z.number().optional(),
  memMb: z.number().optional(),
  /** Root disk in GiB; the provider default applies when absent (Solari: 4, and 20 is its cap). */
  diskGb: z.number().optional(),
  envs: z.record(z.string()).optional(),
  labels: z.record(z.string()).optional(),
  /** What the provider does when the machine sits idle past its window; the provider default (Solari: pause)
   * applies when absent. */
  onIdle: z.enum(["pause", "kill"]).optional(),
  /** Rolling idle window before onIdle fires; the provider default (Solari: 30 min documented) applies when absent. */
  idleTimeoutMs: z.number().optional(),
  /** One per create attempt: the provider answers a repeat of the same request under it with the machine it already
   * booted. Minted fresh after a kill, since a replay names the dead machine (measured 2026-09-04). */
  idempotencyKey: z.string().optional(),
  /** The machine gets the place's container engine through its daemon's fenced socket, so a project's own docker
   * compose runs inside it and sees its own containers alone; a place with no engine refuses the create. Absent is
   * no socket. */
  engine: z.boolean().optional(),
  /** The project this workspace is made with, on a computer the person owns. */
  copy: WorkspaceCopy.optional(),
  /** The logins that computer holds for every workspace on it, mounted into this one. Absent shares none. */
  shares: z.array(MachineShare).optional(),
  /** Folders on the computer bound into the workspace at create, read-write unless the bind says otherwise: a
   * project's memory folder rides this, so every workspace of one project reads and writes the same memory on the
   * computer holding it. A bind whose source is not a directory the computer holds is refused there. */
  binds: z.array(MachineBind).optional(),
});
export type MachineSpec = z.infer<typeof MachineSpec>;

export const ExecResult = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() });
export type ExecResult = z.infer<typeof ExecResult>;

/** The provider's own view of a machine's size and birth. Solari's resume can rebuild a VM on a fresh host at
 * default size while keeping the id, so a wake compares the size against what was created. createdAt moves to the
 * resume time on every Solari resume (measured), healthy or not: record it, never judge by it. */
export const MachineShape = z.object({
  cpu: z.number().optional(),
  memMb: z.number().optional(),
  /** The root disk the provider granted, in GiB; a dropped or misspelled disk field boots the default and says
   * nothing else. */
  diskGb: z.number().optional(),
  createdAt: z.string().optional(),
  /** What the machine has written since it booted, where the backend can read that off the disk itself rather than
   * through df inside, which on a container reads the box's whole disk. */
  usedBytes: z.number().int().nonnegative().optional(),
});
export type MachineShape = z.infer<typeof MachineShape>;

/** The history the runtime hands a snapshot: whether this machine was ever resumed. The fact is the record's; the
 * rule about it, if the provider has one, is the backend's. */
export const MachineLife = z.object({ firstLife: z.boolean() });
export type MachineLife = z.infer<typeof MachineLife>;

/** The route this host takes to one guest port. On a backend whose capabilities say previewUrls it is a public URL
 * with the provider's token embedded, the token standalone, and its expiry in epoch ms as the provider sets it; on
 * one that says otherwise it is a route only the computer holding the backend can take, with no token and an expiry
 * at the end of the machine's life. */
export const PreviewReach = z.object({ url: z.string(), token: z.string(), expiresAt: z.number() });
export type PreviewReach = z.infer<typeof PreviewReach>;

/** One snapshot as the provider lists it; sizeBytes is what storage is billed on. */
export const SnapshotRow = z.object({
  id: z.string(),
  /** The name the snapshot was taken under, which is where wsp's owner mark rides; absent on a backend whose
   * listing carries none. */
  name: z.string().optional(),
  sizeBytes: z.number(),
  /** The size the snapshot restores to, which is an image's size, where the provider reports one. A provider that
   * stores a snapshot as what changed since another bills on that change, so sizeBytes is not this; absent, the
   * image's size is unknown and nothing stands in for it. */
  restoredBytes: z.number().optional(),
  createdAt: z.string().optional(),
  /** The snapshot this one was taken under, as the provider chains them; null at a root. */
  parent: z.string().nullable().optional(),
});
export type SnapshotRow = z.infer<typeof SnapshotRow>;

/** One template as the provider reports it: a promoted snapshot reads ready at once, a built one moves from
 * building to ready or failed, with the provider's reason only on failed. */
export const TemplateRow = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["building", "ready", "failed"]),
  error: z.string().optional(),
  /** When the provider says it was promoted or built; absent on a built-in and on a backend that reports none. It
   * is what gives a template the same grace a snapshot gets before anything may call it an orphan. */
  createdAt: z.string().optional(),
});
export type TemplateRow = z.infer<typeof TemplateRow>;

/** How the provider bills snapshot storage: the free GB shared by every snapshot on the account, the price of each
 * GB-month past them, and the day billing starts. */
export const SnapshotStoragePricing = z.object({ freeGb: z.number(), usdPerGbMonth: z.number(), billedFrom: z.string() });
export type SnapshotStoragePricing = z.infer<typeof SnapshotStoragePricing>;

export const LifecycleBudgets = z.object({
  /** How many times a wake may resume the machine and check it before the wake fails. Each attempt after
   * the first is a pause and a resume; a provider that bills starts declares 1. */
  wakeAttempts: z.number().int().min(1),
  /** How long the guest's daemon gets to answer once the machine reads running, after a fork and after a resume
   * alike, before the runtime says it did not. */
  daemonAnswersMs: z.number().positive(),
  /** How the host keeps asking after a resume the provider did not take: once every everyMs of wall time from the
   * first ask, for forMs. Absent, the host asks once and stops. */
  resumeAsks: z.object({ everyMs: z.number(), forMs: z.number() }).optional(),
});
export type LifecycleBudgets = z.infer<typeof LifecycleBudgets>;

/** One machine as a backend lists it; size comes off the listing itself, since a per-machine read would reset that
 * machine's idle timer. */
export const MachineListRow = z.object({ id: z.string(), state: MachineState, labels: z.record(z.string()), size: WorkspaceSize.optional() });
export type MachineListRow = z.infer<typeof MachineListRow>;

/** The engine's own error kinds, carried on a refused frame so a container the place's daemon lost reads missing on
 * the host exactly as it reads on this computer. `absent` is the link's own: the place is not connected. */
export const MachineErrorKind = z.enum(["concurrency", "plan", "missing", "conflict", "snapshotUnavailable", "transient", "auth", "unknown", "absent"]);
export type MachineErrorKind = z.infer<typeof MachineErrorKind>;

/** What a backend says about itself once, when a link opens. Pricing carries its numbers and not its function: the
 * client answers rateUsdPerHour from the matching offer in capabilities.sizes, and 0 where none matches, which is
 * every size on a computer the person owns. Lifecycle carries budgets alone; a provider whose backstop is pushed
 * cannot be served over a link yet, and none that can be is. */
export const BackendFacts = z.object({
  /** The id of the row this computer serves, off the one table of what a joined computer can offer. What a fork
   * standing there was forked by: the computer says it, since which kinds there are is the computer's own to know
   * and the host that drives it reads a backend and never a kind. */
  offer: z.string(),
  capabilities: Capabilities,
  pricing: z.object({ defaultSize: WorkspaceSize, snapshotStorage: SnapshotStoragePricing, builderDiskGb: z.number().optional() }),
  lifecycle: z.object({ budgets: LifecycleBudgets }).optional(),
  baseTemplates: z.object({ sandbox: z.string(), desktop: z.string() }).optional(),
  /** Where this computer keeps the logins every workspace on it shares, absolute; absent from a backend that
   * shares none, which is every provider, since a machine somebody else runs holds no file of this person's. */
  logins: z.string().min(1).refine(isPlainPath, "an absolute path on the computer").optional(),
  /** Where this computer keeps the project checkouts it holds and each project's own memory, absolute; absent from
   * a backend that keeps none, which is every provider, where a project lives in an image instead. */
  projects: z.string().min(1).refine(isPlainPath, "an absolute path on the computer").optional(),
});
export type BackendFacts = z.infer<typeof BackendFacts>;

/** One machine as the place hands it over: the handle's fields, and which optional roads the handle carries, so the
 * client builds a machine whose optional methods are present exactly where the place's are. Where a fork dials the
 * host is not among them: the place's answer names the place, and a fork on it dials the address the host
 * advertises. */
export const MachineHandle = z.object({
  id: z.string(),
  kind: MachineKind,
  streamUrl: z.string().optional(),
  labels: z.record(z.string()).optional(),
  seen: z.object({ state: MachineState, createdAt: z.string().optional() }).optional(),
  replayed: z.boolean().optional(),
  daemonSupervisor: DaemonSupervisor.optional(),
  /** One sentence on a create whose size the computer would not give as asked, naming what it gave instead. The
   * handle carries the size itself nowhere, so this is the whole of what the person is told, said once. */
  notice: z.string().optional(),
  roads: z.object({ previewUrl: z.boolean(), daemonAnswers: z.boolean(), putBytes: z.boolean(), describe: z.boolean(), facts: z.boolean(), metrics: z.boolean() }),
});
export type MachineHandle = z.infer<typeof MachineHandle>;

/** Raw bytes per putBytes frame: 4 MiB is 5.4 MiB of base64 in one JSON frame, small enough that a pty stream on
 * the same link is not held behind it for long, large enough that a daemon bundle goes in one or two. */
export const MACHINE_PUT_PART_BYTES = 4 * 1024 * 1024;

export const MachineLinkRequest = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("machine.backend") }),
  z.object({ id: reqId, op: z.literal("machine.capacity") }),
  z.object({ id: reqId, op: z.literal("machine.checkKey") }),
  z.object({ id: reqId, op: z.literal("machine.create"), spec: MachineSpec }),
  z.object({ id: reqId, op: z.literal("machine.get"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.list"), labels: z.record(z.string()).optional() }),
  z.object({ id: reqId, op: z.literal("machine.exec"), machineId: z.string(), cmd: z.string().max(EXEC_BODY_MAX), timeoutMs: z.number().int().positive().optional(), stdin: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("machine.pause"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.resume"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.kill"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.state"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.describe"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.facts"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.metrics"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.daemonAnswers"), machineId: z.string(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ id: reqId, op: z.literal("machine.previewUrl"), machineId: z.string(), port: z.number().int().min(1).max(65535) }),
  z.object({ id: reqId, op: z.literal("machine.downloadUrl"), machineId: z.string(), path: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.uploadUrl"), machineId: z.string(), path: z.string() }),
  /** One part of a file. data is base64 of at most MACHINE_PUT_PART_BYTES raw bytes; parts of one uploadId arrive in
   * seq order on one socket; the part marked last lands the whole file through the backend's own byte road. The
   * upload id is a name, never a path: the far side keeps a file under it while the parts arrive, so anything that
   * could climb out of that folder is refused here, where the shape is read. */
  z.object({
    id: reqId,
    op: z.literal("machine.putBytes"),
    machineId: z.string(),
    path: z.string(),
    uploadId: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9]+$/),
    seq: z.number().int().min(0),
    last: z.boolean(),
    data: z.string(),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);
export type MachineLinkRequest = z.infer<typeof MachineLinkRequest>;

// One reply schema per reply, as the files and diff ops have; an op not listed answers the bare ok envelope.
export const MachineBackendReply = BackendFacts;
export const MachineCapacityReply = PlaceCapacity;
export const MachineHandleReply = z.object({ machine: MachineHandle });
export const MachineListReply = z.object({ machines: z.array(MachineListRow) });
export const MachineExecReply = z.object({ result: ExecResult });
export const MachineStateReply = z.object({ state: MachineState });
export const MachineShapeReply = z.object({ shape: MachineShape });
/** One workspace as the computer running it reads it, in one frame: the sizes its cgroup was written with, what it
 * holds of them now, and where its processes, its files and its address are. Every figure is read at the moment of
 * the ask rather than sampled, so a row drawn from it is true of that moment and of no moment since; a workspace
 * that is not running carries the sizes and the paths and none of the live figures. cpuUsageUsec is the processor
 * time the workspace has spent since it booted, so a rate is the difference between two readings. */
export const MachineReading = z.object({
  state: MachineState,
  cpu: z.number().optional(),
  memMb: z.number().optional(),
  memBytes: z.number().int().nonnegative().optional(),
  cpuUsageUsec: z.number().int().nonnegative().optional(),
  uptimeMs: z.number().int().nonnegative().optional(),
  procs: z.number().int().nonnegative().optional(),
  /** How long the computer running it has seen it do nothing on its own: no byte through a published port and no
   * command run in it. Counted from its boot, so one nothing has asked anything of reads its whole life. Absent
   * from a workspace that is not running, and from a computer that cannot say. */
  quietForMs: z.number().int().nonnegative().optional(),
  address: z.string().optional(),
  cgroup: z.string(),
  upper: z.string(),
});
export type MachineReading = z.infer<typeof MachineReading>;
export const MachineReadingReply = z.object({ reading: MachineReading });
export const MachineFactsReply = z.object({ facts: MachineFacts });
export const MachineAnswersReply = z.object({ answers: z.boolean() });
/** The route on the place's own loopback; the host turns it into a route of its own with a forward. */
export const MachineReachReply = z.object({ reach: PreviewReach });
export const MachineUrlReply = z.object({ url: z.string() });

/** What an op meant for the link a computer opened to its host answers on any other socket: the leave op, which
 * takes this computer out of a wsp, and every machine op, which drives the Docker daemon behind it. One sentence,
 * since it is one rule: a client holding this daemon's token is a client on this machine, and a client on this
 * machine neither un-joins it nor forks on it. */
export const NOT_ON_THIS_ROAD = "not on this road";

/** What a create naming a template or a snapshot is refused with on a computer somebody joined, and what a road
 * above answers for a saved image there without asking: a workspace on such a computer is made from that
 * computer's own directories and a copy of a checkout on it, so there is nothing to pull and nothing to build. */
export const NO_IMAGES_HERE = "this computer keeps no images: a workspace here is a copy of the computer itself";

/** What a fork is refused with when the place it lands on answers that it holds no copy of the snapshot named. A
 * fork builds the copy it needs only of the image's current version, so this is an older version or a project's
 * image named at a place it was never built at. */
export const placeHoldsNoImageLine = (place: string, image: string): string =>
  `${place} holds no copy of ${image}; a fork there builds a copy first only of your image's current version`;

/** What a remove of a place that still holds forks is refused with: the machines are the person's to delete, and a
 * place taken out from under them would leave containers nothing here can name. */
export const placeHoldsForksRefusal = (place: string, names: readonly string[]): string =>
  `${place} still holds ${names.length === 1 ? "a fork" : `${names.length} forks`} (${names.join(", ")}); delete them first, then wsp remove ${place}`;

/** What a remove of a place that still holds projects is refused with: a project is one computer's, so taking the
 * computer out would leave records standing on a place nothing here can name again. The forks go first, since a
 * workspace of a project is a machine on that computer, and the projects themselves after. */
export const placeHoldsProjectsRefusal = (place: string, names: readonly string[]): string =>
  `${place} still holds ${names.length === 1 ? "a project" : `${names.length} projects`} (${names.join(", ")}); wsp projects remove each of them first, then wsp remove ${place}`;

/** What a fork aimed at a place this host no longer holds a record for is refused with. Every computer on the
 * list forks, so the only way to reach this is a record that went between the word being read and the fork being
 * asked for: a remove, or a store another process wrote. */
export const placeForksNowhereLine = (place: string): string => `${place} is no longer a place in this wsp, so nothing forks there`;

/** What a verb aimed at the bare computer a place is, rather than at a workspace forked on it, is refused with. A
 * place holds its facts and its forks; the forks are the workspaces, so the refusal names the computer and the one
 * road to a workspace there. */
export const placeNotAWorkspaceLine = (place: string): string => `${place} is a computer you joined, not a workspace; its forks are the workspaces`;
export const placeNotAWorkspaceFix = (place: string): string => `Name a machine on it: wsp threads lists what runs on ${place}.`;

/** What a caller asking for the road to a workspace's own daemon is told, where that workspace runs none: a
 * workspace on a computer somebody owns is that computer's directories under the computer's own daemon, and that
 * daemon answers its files and its git through the host. Said rather than a route minted to a port nothing listens
 * on, which is what the panes and the relay read before. */
export const placeServesDaemonLine = (workspace: string, computer: string): string =>
  `${workspace} has no daemon of its own: ${computer} answers its files and git through this host`;

/** What a watch of the ports or of the load is refused with on a workspace whose computer answers its daemon
 * frames: both readings are that whole computer's, and one workspace reading them would read another workspace's
 * listeners and load as its own. A pane asks for both on every link it opens and takes a refusal of either. */
export const placeWatchesItselfLine = (computer: string): string =>
  `${computer} watches its own ports and load, which are that computer's rather than one workspace's`;

/** What a watch, read or signal of processes is refused with on a workspace whose computer answers its daemon
 * frames: that daemon acts on any pid on the computer, the computer's own and every other workspace's, so none of
 * them goes up its link from one workspace's channel. The Processes pane shows it in place of the table. */
export const forkProcsUnreadLine = (workspace: string, computer: string): string =>
  `${workspace}'s processes on ${computer} are not readable from here yet`;

/** What every other op is refused with on that workspace's channel: the frames that computer's daemon answers
 * inside the workspace they name are its shells, its files and its git, and every other op there runs on the
 * computer itself. */
export const forkOpRefusedLine = (op: string, workspace: string, computer: string): string =>
  `${computer} answers ${workspace}'s shells, files and git from here, not ${op}`;

/** What a person asking for a second workspace on the computer the app itself runs on is told. Its local mode is
 * one workspace, the one it already has; every other workspace is forked at a place. */
export const localRunsOneLine = (workspace: string): string => `${THIS_COMPUTER} is already a workspace, ${workspace}, the only one it can be`;
export const localRunsOneFix = (workspace: string): string => `Use ${workspace}, or name a place that forks: wsp places.`;

/** What a computer's kernel must have before wsp runs workspaces on it, asked in this order so the reason a person
 * reads is the first thing missing rather than the last. `read` answers a file's text or nothing when it is not
 * there; `euid` is the effective user the check runs as. Nothing here touches a disk: the two sides that ask (the
 * daemon on the box, and the join typed at it) each read their own files and share this one rule, so what the
 * doctor says and what a create does cannot part ways. */
export function workspacesBlockedBy(at: { platform: string; read: (path: string) => string | undefined; euid?: number }): string | undefined {
  if (at.platform !== "linux") return "wsp runs workspaces on a Linux computer";
  const controllers = at.read(CGROUP_CONTROLLERS_PATH);
  if (controllers === undefined) {
    return "this computer mounts cgroup v1 at /sys/fs/cgroup, and wsp runs workspaces on cgroup v2 alone: boot it with systemd.unified_cgroup_hierarchy=1";
  }
  const has = new Set(controllers.split(/\s+/));
  for (const wanted of ["memory", "cpu"]) if (!has.has(wanted)) return `this computer's cgroup root offers no ${wanted} controller, which wsp needs to run workspaces here`;
  const filesystems = at.read(PROC_FILESYSTEMS_PATH);
  if (filesystems === undefined || !filesystems.split(/\s+/).includes("overlay")) {
    return "this computer's kernel has no overlay filesystem, which a workspace here reads this computer's own directories through";
  }
  if (at.euid !== 0) return "wsp runs workspaces on this computer as root, and this daemon is not root";
  return undefined;
}

/** The two files that check reads, named once so the daemon and the host ask the same kernel the same question. */
export const CGROUP_CONTROLLERS_PATH = "/sys/fs/cgroup/cgroup.controllers";
export const PROC_FILESYSTEMS_PATH = "/proc/filesystems";

/** What a join of a computer whose kernel cannot boot the image is refused with, in the one sentence the daemon's
 * own doctor named the reason in. A computer that cannot boot your image is not a place, so the join stops here
 * and nothing is written on it. */
export const placeCannotBootLine = (place: string, reason?: string): string =>
  reason === undefined ? `${place} cannot run wsp workspaces, so it cannot be a place` : `${place} cannot run wsp workspaces: ${reason.replace("this computer", "it")}`;

/** The same sentence off a computer's own report, or nothing while it runs workspaces: one reading for the join's
 * refusal, the row, and every act that runs inside a copy there. */
export const placeBlocked = (place: string, report: Pick<PlaceReport, "runsWorkspaces" | "workspacesBlocked">): string | undefined =>
  report.runsWorkspaces ? undefined : placeCannotBootLine(place, report.workspacesBlocked);

/** The word a computer's row carries while its doctor says it cannot run workspaces. */
export const PLACE_BLOCKED_WORD = "can't run threads";

/** The one sentence a login that is not root reads when it tries to join a Linux computer. The daemon there is a
 * system service under /etc/systemd/system, so a plain account cannot install it and nothing is written before
 * this is said. */
export const PLACE_NEEDS_ROOT_LINE = "joining a Linux computer needs root, since wsp installs its daemon as a system service; log in as root or use sudo";

/** What a word that names no place this host holds is refused with, naming the ones it does. */
export const noSuchPlaceRefusal = (word: string, held: readonly string[]): string => `no place named ${word}; you have ${held.join(", ")}`;

/** Whether a row is a computer somebody joined to this wsp: a computer, and not the one the host runs on, whose
 * files and threads are that host's own. The one reading, so the road that runs on the link, the road at the
 * terminal and the list of places a fork could stand on cannot disagree about which rows are those computers. */
export const isJoinedComputer = (place: { id: string; kind: string }): boolean => place.kind === "computer" && place.id !== HERE_PLACE_ID;

/** What a build of the image at a place that cannot take one is refused with: a copy needs a builder forked there
 * and that builder's disk copied, and a computer somebody joined does neither. */
export const placeBuildsNoImageLine = (place: string): string =>
  `${place} takes no copy of your image: a copy is built by forking a machine there and copying its disk, and ${place} does neither`;

/** The two rooms the member rule is read in: the seal that takes the archive off a builder on the person's own
 * place, and the import that lands it on a copy somewhere else. */
export type VaultRoad = "seal" | "import";

/** What a vault archive is refused with: where the reading stopped, why, and what that refusal did, which is not
 * the same on the two roads. The archive is refused whole, since a builder that wrote one member nobody asked for
 * wrote every other member too. */
export const vaultMemberRefusal = (road: VaultRoad, member: string, why: string): string =>
  `the image's sign-in archive is refused at ${member}: ${why}; ${road === "seal" ? "the seal is refused and no version is recorded" : "nothing of it was imported"}`;

/** What a copy is refused with for a record whose vault kept no path list: sealed before the record held which
 * paths its sign-ins live at, so no other place can tell a member the seal asked for from one it did not. */
export const vaultUnlistedRefusal = (name: string, version: number): string =>
  `${name} v${version} was sealed before its record kept which paths its sign-ins live at, so no other place can check its archive against them; cut the next version`;

export const DaemonErrorCode = z.enum([
  "unsupported",
  "outside-root",
  "not-found",
  "not-a-directory",
  "not-a-file",
  "not-a-git-repo",
  "bad-request",
  "forbidden",
  /** No command line for the git host the remote names is on the machine, so the pull request waits; the push
   * itself landed, which is why a client reads this one as a note beside the push and not as a failure. */
  "no-host-cli",
  /** Git refused a fetch or a push for want of a credential on the computer it ran on, so nothing moved. */
  "no-git-credential",
  /** The git host's command line refused a read for the account's rate limit. */
  "rate-limited",
]);
export type DaemonErrorCode = z.infer<typeof DaemonErrorCode>;

export const DaemonOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
/** code is set by the files and diff ops so clients can branch on the refusal
 * without matching message text; older ops send the message alone. */
export const DaemonErrorResponse = z.object({
  id: reqId.nullable(),
  ok: z.literal(false),
  error: z.string(),
  code: DaemonErrorCode.optional(),
  /** Set by the machine ops alone, so a backend's own error keeps its meaning across the link: a container the
   * place's daemon lost reads missing on the host exactly as it reads on the computer holding it. */
  kind: MachineErrorKind.optional(),
  status: z.number().int().optional(),
});
export const DaemonResponse = z.union([DaemonOkResponse, DaemonErrorResponse]);
export type DaemonResponse = z.infer<typeof DaemonResponse>;

/** One reading of the guest: cpu is busy time over the interval across all
 * cores (0 to 100), load1 the one-minute load average, mem and disk in bytes
 * (mem used is total minus available; disk is the filesystem under the
 * daemon's root), at epoch milliseconds. */
export const SysSample = z.object({
  type: z.literal("sys.sample"),
  cpu: z.number(),
  load1: z.number(),
  mem: z.object({ used: z.number(), total: z.number() }),
  disk: z.object({ used: z.number(), total: z.number() }),
  at: z.number(),
});
export type SysSample = z.infer<typeof SysSample>;

/** One step of a computer's kept readings: the mean cpu and load over it, the last memory and disk in it. */
export const SysPoint = z.object({ at: z.number(), cpu: z.number(), load1: z.number(), mem: z.object({ used: z.number(), total: z.number() }), disk: z.object({ used: z.number(), total: z.number() }) });
export type SysPoint = WireSysPoint;
type SysPointHeld = Held<Same<z.infer<typeof SysPoint>, SysPoint>>;
/** What a sys.history answered: the steps with a reading in them, oldest first, and whether the range held more. */
export const SysHistoryReply = z.object({ points: z.array(SysPoint), stepMs: z.number(), truncated: z.boolean() });
export type SysHistoryReply = WireSysHistoryReply;
type SysHistoryReplyHeld = Held<Same<z.infer<typeof SysHistoryReply>, SysHistoryReply>>;

/** A computer's readings over a range as the Usage page draws them: the kept steps and the span they are drawn over. */
export const ReadingsAnswer = z.object({ points: z.array(SysPoint), stepMs: z.number(), from: z.number(), to: z.number() });
export type ReadingsAnswer = z.infer<typeof ReadingsAnswer>;

/** One reading of the computer the host runs on, pushed on a client's own socket rather than through the event
 * stream: it is a tick of a live figure, not a thing that happened, so nothing replays it to a socket that comes
 * back. Named apart from the daemon's own sys.sample because these two arrive on different sockets and a client
 * that reads both must not mistake one for the other. */
export const WorkspaceSysEvent = z.object({ type: z.literal("workspace.sys"), workspaceId: z.string(), sample: SysSample });
export type WorkspaceSysEvent = z.infer<typeof WorkspaceSysEvent>;

/** Every process the daemon read this tick. daemon is its own pid, so a
 * client can name it; total counts /proc entries, procs holds at most the
 * first thousand of them by pid. */
export const ProcSnapshot = z.object({
  type: z.literal("proc.snapshot"),
  at: z.number(),
  daemon: z.number().int(),
  total: z.number().int(),
  procs: z.array(ProcEntry),
  /** Counts the daemon's process frames, so the changes after this one name it as their base. A daemon a version
   * behind names none and sends no changes, so its snapshot is a whole list held with no gap to track. */
  seq: z.number().int().optional(),
});
export type ProcSnapshot = z.infer<typeof ProcSnapshot>;

/** What moved since frame `base`: the rows that are new or differ, whole, and the pids no longer listed. */
export const ProcChanges = z.object({
  type: z.literal("proc.changes"),
  at: z.number(),
  daemon: z.number().int(),
  total: z.number().int(),
  procs: z.array(ProcEntry),
  gone: z.array(z.number().int()),
  seq: z.number().int(),
  base: z.number().int(),
});
export type ProcChanges = z.infer<typeof ProcChanges>;

/** The snapshot a proc.changes frame leaves, rows by pid as the daemon lists them; undefined where the frame does not
 * follow the snapshot held, which a client answers by watching again for a whole one. */
export function applyProcChanges(snapshot: ProcSnapshot, changes: ProcChanges): ProcSnapshot | undefined {
  if (changes.base !== snapshot.seq) return undefined;
  const rows = new Map(snapshot.procs.map(p => [p.pid, p]));
  for (const pid of changes.gone) rows.delete(pid);
  for (const p of changes.procs) rows.set(p.pid, p);
  return { type: "proc.snapshot", at: changes.at, daemon: changes.daemon, total: changes.total, procs: [...rows.values()].sort((a, b) => a.pid - b.pid), seq: changes.seq };
}

/** The content of every daemon this project has deployed, oldest first, one entry per version: the last one is
 * what a deploy installs today. No branch writes it: the landing runs scripts/cut-daemon-version.mjs, which appends
 * the sha of the tree it lands where the daemon changed, with the version and its note. An entry with no sha to
 * name is UNRECORDED: the three cut before the record existed, and the versions branches held before the cut. */
const UNRECORDED = "";
const DAEMON_CONTENTS = [
  UNRECORDED,
  UNRECORDED,
  UNRECORDED,
  "b749121a659b9c45b07285ee0f4e95f15aae26ddbc1bcba75745e83c2ae032c6",
  "b0b88a03c649769e0676ca38eaa5035825b71302c97a2858dcf8eb57131288be",
  "cae44a68bd72d81717b52a71c3890da918025cbd0d071db884102936e5cf4345",
  "c5c3b15cad1b45ed110b072a18d0d895f661c489f73828de78a3b9f3589f05c6",
  "f90fd16f8e5d15707cda18e58524da66fb6ed6b890632fff90d396792dc5604d",
  "9ebea6a49390fd5b1af911f413e77c3e46db091812b55b41515e881e93433292",
  "da0d618fd27965a77c8c15e389fea39c8f3ae691326af0212a8f1c62b9c8499f",
  "cbfe733de05765b706c3ff4d08aa62ee188258771dd3b02011633716fad62a48",
  "12eac7cd2f4b90f9064279a1ea3b3169d24e34c30279f5c19d046252e2d5ec66",
  "877eda4200afad3842bedad0e49d6efc942ef1ef3ea7181af22f9e726d72b669",
  "206d96d53b9734c3dce0e84bf11d5455e210b2419b6c9572748ebf69861afca5",
  "6875c912371aadfb9947191e4d887b9fb6576ed57d0268de91811a6d3ac4f4cd",
  "4c81908db0c4d29e74f00ddd5513e94137f01afeb39b9afbed242368be6097c6",
  "0ad3a1c3e98d5b75bf94d610b9e166a7ad1bb5e79ee7ab4905d6b738fb5eded9",
  "01030623497a43f044916ca27731dbfa4c92c6b82765a9e9dbd6426d69b1ee4e",
  "a6ae68d8af502a8a5ecf9795ca11ca0b9b12cda2792e45eee3376c7e4d57917b",
  "055dcf11b2a17e8959ab3a6246c2d17f89eb3837c59b31d3a8138c6dc7b6c322",
  "09e441a435678290871e210158d5f8fef3b43b307c5ec917086a201583c037a5",
  "386b54104e2a8abf8f45f9a35fe767971b72d5d00da68c4d8ae0aa9630b7cc6d",
  "9ff538bbfca0ac4e03ca8c822afd47b630dd21cec17ec929192ddc6ae6f10ce6",
  "14b4b9c0ccad20d544fa123841592c6438f735405f97a88957dafe4c39f47e8b",
  "ad9341f55ebc6a724a35b9febb11f7ca5cf5133a90d7a631bf39cf9a496657ac",
  "cebb929363226a20c057702cfe24235fa2f24749c70355539f5bab4b3bcfd3da",
  "bbdd3b1dc7fb73b04d5986128d099e11a723d777bd1a3c7cddd14819f1ee8cfc",
  "35236ee3220f12db35f3307812b2d2ea8c8762f8910e656d9d57a44bb599b0e3",
  "372241b199d0b23db89c2618409d8edf611bc5f29811fdaffca813ec2b283295",
  "5bb58cbade0b5be39242aa419feaa7e24d82a291271d6d83a2488799005fd5a0",
  "fdfbebe6ae5c0ff581df732222b76b6540a2e4d226c5381878e125499f55180c",
  "87e30b445d1e815a4dc336b35924ed061bc30374ad7f490ec3fefb4f194b6c0f",
  "e527369ddf63dcc38642a26caca0cd2f72f50e9be8b06f76d7cb7c93c349d826",
  "352699bc2434f5b1dc84d46026499662abf3bbcc4bc701736150a90042f79368",
  "0bec2f8329f6e46772d072acb082a83a943fe87ed31f2a83df3295069d1f6243",
  "5ef12ef8bf31cdb5ebbdd7ef56113fc447876b63dbabd073752a802491db5fab",
  "e0134bee72be55ed8349d11a9e656b61ee20ba55472be25546f0809763f99d9c",
  "9a92c0f6248b0182e5f5f7ad02c2d6e54b0809513171a390927d63bc3ee00e70",
  "46fe3b809d1bcc82d0dc644d8f300672cb72ae63c99668f6c1be1c75aa71a3f4",
  "87a461ca21eb894d129e0d692bcbdf56f1134d6160a0e84fe52692ed36f317cd",
  "8308517d14718d8b82e1e129f1e48a8a511aa9fdaae26b60c900b6280fa85051",
  "a51cf26e554a02935fda02942869ddd7251b41e84625e500336c7ce171a4d667",
  "c2f00944a79a850450b11b4610b93ac4894b7da39282755a9bfef55776a11dff",
  "c1fba7f2f77da32e75e8099b3ffd8bb36c0dbddfe88b0f018a2e59ac0e3b6905",
  "b9025a75a5b7f55164be73f60b2fd9f64510f74ad17d8fb24b18af168587899f",
  "022f1786d1aca054624bb042955dbbde64ecb4c974e918bbe95cf53e5d29cf0b",
  "e84a3a735fac175e251581fc61e29cd446e38142fb4579cae50cdaf30d63b858",
  "ed2fb414194ec877f031cb6a09e7869b4727132e25768eca2da581c8b902a0d1",
  "4453f856251c047172490b84c8502f74b6a1d25744f6878a382ac32fe45f2c46",
  "4605e734f4735405ddefd0478583032757ca8ad0b2dc8ce9a14e92789c2800a0",
  "52dc451ba47d583759687b0d9c8b5f3dc1d9f820ca25dc1e030e1268cc2b5157",
  "eb6eb2701b4edafd3f62e17ab032313660bafbfe80ce973bd56a56c86662aff8",
  "2b992e451cd69dbf08eac12f8c1208a1b01cf1a5a36319bc4875a08e387ae05f",
  "7deddf539fb438f49cc68e299e5d3e08413202f7325a73d7d815a532ac1e96c7",
  "1e3ca55474038b943e69a5a91ddf720df24e9f8a5fff8aa05028527cbb0605f2",
  "863d552bfaeeff40212778a4f175bf821f8ff5cdd7829e6922866bf70dcdbe5e",
  "376bdbce753a06ef57dfdda1e50f1cb761a728538dd85851db285168e4d1e568",
  "c1d414a8d13ee7070d1df56f82b7230bb53bed51b8b2d43c4bc39a864c5b5489",
  "cec7af13cc254d8325bf77409aedc4daeb072d5dc0413b58aaf45f8428698721",
  "b1c827b22fbdade28b749f72899b610723d5f312e339e9546552da14840013c1",
  "7324cbd1f27eb8983b8ea302c3cd32a629a4eedae7e0d46458acca37440baf88",
  "b83b671323ccc59fe9daa43da46dede2d640451c5b4f0c8e64ae2eef149ba694",
  "5b5db8f843457bfac71002bb4741d98f0f98bfe11579e7891c1a0955c39eed0f",
  "e10ddc035c5a0fb57b8b591da1fa220023e836e7c7598022c19d852e747bab46",
  "e6eb64e2466dfa2eca9448ea2aabfe82223c2897276663698a1184a16774145d",
  "361aa8997cc132755f0835ada745b05c7eee7faf20e67d14fa606971c5157441",
  "2c9896b832aebaccaf1b4f2c69ffba662e0a8b7f5748fc359313f8aff46a3b2a",
  "673d1f56aa3159a41d1b55b3b17c306628912a793cabc7d0208d2a4b937f07af",
  "311811170de5296b4e25d8b3bc6e46035a9c5fc13f6430d8ae9314be8d9815f9",
  "4202fe729182d82873c035271bb091be1fce798422a5349d9430e773567246a9",
  "dacb3a6c014686cff3aa977b424725f7270d200c3d42239b8467e94487593eb2",
  "4faf16035d8608562f0cfa8d463a7dc8b38830944b43002b9544697bb9c1dcd9",
  "83b228f3e824311abc08d0ff81538122bc5a0028655198ef6abba17f7daeaf0c",
  "ba2f7c6846cfc3d7ce66ff15f554d8b87dc20f5683931777d244e142709815dc",
  "de414be04f6f1b5142c2e5e718f4acd0a0526558dc96bed3a02b31f7acd924ba",
  "15f43fcf51b6d460b6e1acfa2ed0ce279a6645647834a10174bd9d249c2b2e6e",
  "7a1d4e70b470d3f404c987c4300756615bfca9f904f0ef12e74f26497775d72d",
  "c76e7e2a3b9a767beaa281b973a409e1bc8869969255fa6c9fdeb6211b38ce3d",
  "be3d9077764035f8bf2b96ab6b50c018017046ec74a30827404f64752ef19bdf",
  "837e923920b718c42e372f7d84dd08d4d51add8e7b86de1ab4afb4a156afb8ae",
  "69559f24eb63363f130e96d07548df1e6cffed939d08d5df760e5ac9948f240e",
  "4693a00a74c923f64a9062a65cac539d5ac7621da08fc623c63089a87b8231d7",
  "6064295b774d39defb1ba58ef099812ee1e4662bac2a1525c6d0061128450f2f",
  "12dc3a3741a25239969103531def3c28df0874e9233825d16f7063a84df345c6",
  "ca0a7c835985a42469446d3efd1e622568ef0772725ddf4700efc631038f6c1f",
  "11da9462eb0cc7aa26e3f05feed71e2e27774769026dfa6d7a4f3a08f6511ebb",
  "16e43173fadb40a741a588b14470f652528a4202fd434c2b9dc2702c7d78fc7c",
  "7e3fcbd460f842ff7343389c09ddbf43de751d83abea5cf82580d929811656e7",
  "e927a6944459d21c2598ce6ff7511bd6bb22eed9ac962aaedcce620e92b3d321",
  "1796fa8ef2dcd4c907e1314205bdca852b06c8fb807c5580b517c7ee389a188a",
  "fcbf00c4e8075aea8eec9513751ad6412db3feae36f2a1e78d2465eca51b86a4",
  "9468bfd7e5cd26a8458b328ef1f01634bbd12954c7b2d4dc13711adb7f19ae95",
  "17dc947dabc1776d901352d4d681af228e620309b8b4d8b8043ac9d904788bb4",
  "eb62eb296316d8c81da569e60be2c5db173b00f00a2ef7f562db39265db49423",
  "4d9cc489a1a3cbd2b502fa2f899bfddd5bf206ae00f1a2a76b9fa8dd7aef5f60",
  "5bc5f0d1888a8f254ffffa1bee6b77a302bf5c1164f520e5255b2f6c4a83a252",
  "db97f7d2dba5d48e19188ea89555803e76332015c7c2daf27a3a6c42d7f49cce",
  "297d0addb6e4b758e1f50a38516edc1eb32aa22da6894e5be52323d6b998c4fa",
  // 99 to 101 are held by daemon changes still in review, whose entries land with them.
  UNRECORDED,
  UNRECORDED,
  UNRECORDED,
  "fdfe7e8214a09e7c6e73ddea88aa9c167869ef0e02436b4c1ce7df85c7fdaa72",
  "4b81b5dc48a8d5472532d2c900a0247233533c19da9516bbb8ee2c17cfe4c9c1",
  "f2efbe27af183ea59d6f6875831f6263b013d6a179d94ba977075c5478172e5a",
  "66a2d192c8d56348d567f6cae3120df03a0022011f42b426be17d94238c8870f",
  "3cfade0dea7b54831d65ec361226fb95958f457ad08a3aa6003e67da5581ada8",
  "9a59b1daa92807a07d52f8d1ee0a3b3d3d5680202be1da20498b093b5b1daa71",
  "29eeb80d015c5099f6991b2acc3a0457f26aa1636b66f8751d6734cdb1a0639d",
  "ad16ee01ba69b4bd8339c8aa4753c2f3e46aa80c8d9f1ceeab9ca1038482f062",
  "409fce58696aaa20c7803f7a963841e4aacc0702a153ca6f916fba64f941bd16",
  "89e10a249a0e59670fc8fefec015f640d8f021d0b24bb34665412360cf6b999b",
  "ffcede69616fafe56cf56a3ec668d56516c22b7c9f53fc5176621c902ad7e639",
  "019c206265a45a72e87e3e436643cc96399b6ed44d5ae07de967b502e5742abc",
  "b423faeb3b4ae38a7456d11b877ab8720adaaa62650c5b33209ee24e02fb37b9",
  "4076321ab3d83fb3893ad81b9222fc36b92dccec81e8e9bc4566cc64a412b299",
  "81b16217319586241e368d7cb84fa0383a11b8d056a03053c700140422ff5e71",
  "2d3c09680f6c9dca01d8915f8d7be7306ba0db7fc6e1734353a86bf5afaa4e4e",
  "1557c21f49fe3ec9248ca8c405e450b0f201e9bc4fd3f552bfd0f36132272b17",
  "1ee653af3b44dc450246290cc7bb7617da6ec8f062d9e859452472019e52e51e",
  "1fb569928a97d7ba40fd54d251dc4202f267133344e7da3153f3f4aa723e180e",
  "c92b490e1481821bfdc26584e0f8b19e73e28fefeefeae6fb61c189ad098d88e",
  "a89600e669b83780c19582d096ed9c9a274446a75da14d185bc0afee9d299ba9",
  "9dc9610fb0581804589fcf952e0f5df34b029bbae2034ea135f420867b5b4c5c",
  "089d2b84fb314ca0fb7361046e327978a243aee796789f72cd5e2e8f8a71c191",
  "f9b9aedecc0b89b12571cea110ff89f317df4472af13de32ef2f5681334f46a7",
  "a9a90585446c8bd453c888fc716b3097631dbd87d7116d7f65a8a9a436df7352",
  "b704e47c6fcf966b5148ddb7d9e19ed17cddce96c9d70011e9367616d1226649",
  "31a6bcca711ff0e60f8953d4b8e5544bab64c3143c956122fc2a781a3a653a64",
];

/** The daemon's protocol version, carried in its hello, so a client can tell what a machine's daemon answers
 * before asking, and a host can tell that a machine's daemon is behind the one it would deploy. It moves whenever
 * an op is added or widened and whenever anything a deploy installs changes, because a live machine keeps the
 * daemon it has until the version it announces is behind this one. A hello without one is version 1: every daemon
 * deployed before the field existed, which has the pty, ports, manifest, inbox, fs, git and tunnel ops and no sys
 * or proc ops. Version 3 browses the imported project folders named in DAEMON_ROOTS_PATH beside its home.
 * Version 4 starts from a script that sets the guest PATH itself. Version 5 fetches its Node through the catalog's
 * curl function. Version 6 puts itself last for the kernel's memory killer and starts every shell it opens at the
 * work score instead. Version 7 picks the road to the listening ports by platform, so the same daemon serves them
 * on a Linux guest and on the person's own Mac. Version 8 runs under a systemd unit that restarts it, so a
 * daemon the kernel kills comes back on its own. Version 9 reads the utilisation and the processes it serves
 * through a module per kind of machine, and answers a watch only once that module has read the machine, so a
 * pane is refused where it would otherwise wait for a stream that never comes. Version 10 keeps a DISPLAY the
 * caller names on a pty it opens, so a sign-in whose page must return to the machine can be handed a browser to
 * find there. Version 11 serves a machine reached over ssh, which reads the load and the processes of the machine
 * it runs on the way a fork does; the same daemon under the person's own login there, with every path it keeps
 * under their home. Version 12 asks the prefix it would compile against for the headers themselves, so a machine
 * where an installer symlinked a foreign node into that prefix builds node-pty instead of failing on it. Version
 * 13 asks those headers which major they are and compiles against them only when the node that will load the
 * result agrees, so an older Node's headers left in the prefix send node-gyp after the right ones instead of
 * building against the API another Node declared. Version 14 reads the environment a provider could not hand a
 * fork at create off a file under /etc the unit may lack, so a backend that lands it there hands the daemon its
 * keys without touching anything else on the machine. Version 15 is deployed by a script whose guards end it
 * themselves, so a machine with no service manager and an npm install that failed stop at the line that found
 * them instead of leaving the rest to run. Version 16 starts by the node the deploy compiled its native modules
 * under, kept in the daemon's own folder, rather than by whatever a PATH the machine owns names at the moment of
 * the start: a machine restored onto another one names a different node there, or none, and none is a start that
 * fails every second for the life of the machine. Version 17 answers an exec op and can dial a host of its own: a
 * computer somebody joined as a place opens the socket outward, proves itself on the ed25519 key that host learned
 * at the join, and then serves that socket exactly as it serves an inbound one, so every command the host already
 * sends a machine rides one frame on the link and no runtime road learns a second transport. It also loads its
 * native pty module at the first terminal rather than at its own import, so a machine where nothing built that
 * module serves every other op instead of refusing to start. Version 18 finds that native module where a packaged
 * command carries it: the command bundles node-pty rather than requiring it, and a bundled CommonJS module arrives
 * with a default export and no named one, so a daemon running inside the packaged command opened no terminal at
 * all until this. Version 20 takes every option as a flag,
 * one per option, reads its ports, load, processes and pty modes off one /proc root, logs its samplers' starts and
 * stops, and builds a place's report and sweep off the home it is pointed at, so a test suite drives it as a binary
 * and the words and numbers it answers with are the protocol's, held in one fixture set. Version 21 takes
 * --runtime-root, where a place's daemon keeps the layers and the workspaces it runs itself. Version 22 is one
 * static binary, built from the Rust sources under daemon/ for each chip a machine can be: the deploy lands the two
 * Linux builds and keeps the one uname names, the unit and the supervisor start it by its path with one set of
 * flags, a computer joined as a place runs the same binary under its login's own manager, this computer's
 * workspace spawns it, and the guest keeps no node, no npm install and no native module for the daemon; the wsp
 * command beside it still runs on the node the machine carries. The binary also answers a plain HTTP request 426,
 * as the host's status probe reads a daemon by. Version 23 commits a workspace's upper directory to the layer store
 * as a snapshot, names a snapshot's chain as a template, and naps a workspace by stopping it: the processes go,
 * the upper directory stays as the saved layer, and the wake boots it again on the same address and forwards.
 * Version 24 makes the daemon the workspace manager on a joined computer: its report says whether it runs
 * workspaces here rather than whether it holds a Docker, and the install writes the wsp-workspace AppArmor profile
 * where the box takes it, so what a deploy leaves for a workspace to isolate under changed. Version 25 serves a
 * fenced engine socket into a workspace that asked for one: a proxy over the box's own Docker or podman socket that
 * labels every create with the workspace, filters every listing by it, refuses what would reach the box, and joins
 * a container's published port to the workspace's loopback; a create names the socket with the new engine field.
 * Version 26 stops a build whose libseccomp is not linked statically, so the Linux daemon is one static binary that
 * names no shared library; a binary that did was installed once and its container init called address zero.
 * Version 27 answers machine.snapshot with a job and machine.snapshotJob with how far it has got, so a layer that
 * takes minutes to write waits on no one frame; the layer is a plain tar, the shape carries the bytes the workspace
 * wrote, and a snapshot's failure is the job's own refusal. Version 28 runs every exec behind the workspace's
 * seccomp filter: a process an exec started ran with none while the init ran behind one, and now loads the same
 * filter before its command, or the exec is refused. Version 29 keeps one form per layer on a box: the unpacked
 * tree forks mount, with the blob dropped once its unpack is whole, so an image costs its size once; a layer's
 * bytes in a snapshot row, an image row and the swept count are what the tree's files hold, and the sweep at the
 * daemon's start drops any blob it finds beside its tree. Version 30 asks a machine for the service manager its
 * daemon would be held up by before a byte lands on it, rather than inside the install: the deploy script carries
 * that check no longer, and a machine wsp did not build is turned away with nothing written on it. Version 31 lets a
 * place say which life a copy may be taken from: a provider whose snapshot is the disk as it stands answers
 * snapshotsAnyLife and a builder that woke there is sealed, where one that answers only its first life still refuses
 * after a restart. Version 32 holds every workspace on a computer somebody keeps to a size that leaves that
 * computer a core and the smaller of half its memory and a gigabyte, a spec that names no size included: the
 * create answers the size it gave and one sentence saying so, the record holds that size, and the capacity says
 * what the workspaces there hold of the computer. Version 33 answers a client on the computer itself the listing of
 * the workspaces it holds and one reading of any of them, both read-only and both on the road that dials in; the
 * reading carries the sizes as applied, the memory and processor time off the cgroup, the uptime, the process
 * count, the address and the two paths, where the metrics op before it read two of those and replied with none.
 * Version 34 takes the daemon its host deploys over the link it already holds, where a computer once kept whatever
 * daemon it joined on: the parts of the binary arrive under one upload id with the sha256 of the whole, the last is
 * checked against it, moved over the file the unit starts with the old one kept beside it, and answered, and the
 * agent then ends so its supervisor starts what landed. Nothing is swept, so the workspaces' records stay on the
 * box and the daemon that comes up reads them again. Version 35 carries the daemon binary in the bundle where the
 * wsp command riding beside it reads one, under that command's own assets and one folder per chip, and writes the
 * unit, the supervisor script and the AppArmor profile inside the arm for the chip the machine says it is: the
 * binary a machine runs and the one a computer's own join looks for are one file, at one path, under one rule.
 * Version 36 relays a guest session: a process inside the machine opens one on the daemon over loopback with the
 * daemon's own token, and the daemon carries it up the socket the host already holds, so the wsp an agent runs
 * there needs no address of this host, no TLS and no node. The binary answers that word itself, and the deploy
 * writes a two-line shim onto the machine's PATH, in the same arm as the unit, that hands it the line.
 * Version 37 answers no op differently: the contract fixture a reply is held to no longer names a provider nothing
 * can serve, and a fixture's bytes are in the sha whatever they say. Version 38 answers nothing new either: this
 * record holds every Rust source under crates, test code included, so two cases added beside the place link's
 * agent parsing and the pty's cwd move it while the binary a guest runs is the one version 37 named.
 * Version 39 holds a joined computer out of idle sleep no longer: the hold that watched the place file is gone and
 * the file carries no field for it, so a computer sleeps on its own schedule while it is joined.
 * Version 40 dials a host at an https address: the link turns one into wss as the protocol does and speaks TLS
 * through rustls with the root certificates baked into the binary, since a box may carry no certificate store of
 * its own. It is the one road to a host that sits on a laptop behind a home router, which is the first address
 * such a host writes into every place file, and until now the link refused it and the box never dialled back.
 * Version 41 is the same binary as version 40: what this record hashes changed, not what a deploy installs. A
 * crate's tests/ folder is out of the sha, so test-only work stops cutting a version and no machine reads itself
 * as behind over cases it would never run.
 * Version 42 holds a guest session open across a host that went: the daemon keeps the frame each session opened
 * with and names every session it holds to whatever socket asks to watch next, so a host that restarted picks them
 * back up instead of closing the first message it cannot place, and a session nobody has watched for ten minutes
 * ends to its guest with one sentence, so the process inside the machine prints it and exits rather than waiting
 * for the life of the workspace.
 * Version 43 names the run of the daemon that opened a guest session: every opened frame carries a marker minted
 * once per start, so the host tells a session it still holds from a session of the same name on a machine that
 * was rebuilt under it, whose names count from the start again. Without it a guest carrying no turn token, running
 * the same line from the same folder under the same token, was glued to the earlier session's output.
 * Version 44 gives a workspace on a computer you own its project as a copy made once for it: a btrfs snapshot where
 * the checkout is a subvolume, a reflink copy where the disk shares blocks, a plain copy everywhere else with its
 * time said in the create's notice, chosen by asking the disk and never by a filesystem's name or id, bound into the
 * workspace at the project's own path before the runtime starts and unmounted deepest first at stop. The place report
 * carries the word for what the computer's disk can do, so the computers row says it. Before this a workspace shared
 * its project through an overlay whose lower directory the box could change under it, which the kernel leaves
 * undefined.
 * Version 45 lets a machine specification name shares: files the computer keeps outside every workspace under the
 * daemon's logins directory and binds into each workspace at a target path, so a login signed in once on the computer
 * is the same file in every workspace there and a refresh in one is the computer's refresh; a share whose source sits
 * outside that directory is refused at create.
 * Version 46 makes a workspace on a computer you own out of the computer itself: its system directories under overlays
 * with an upper per workspace, its home shared read-write with the daemon's own files hidden, the engine's data
 * hidden, the project bound at its path; a box pulls no image and keeps no layer store, and the snapshot and template
 * operations leave its wire. The root moves to /wsp so no upper sits under a lower the kernel would refuse.
 * Version 47 adds the copy verb the Mac host runs as a child: a directory clone of a project folder at a sibling path
 * in one call, a git worktree where a clone cannot work, then the two rules that make the copy a clean checkout with
 * its ignored files kept; the capabilities say whether a computer copies and whether a copy gets its own network,
 * which is how the row knows this Mac shares ports.
 * Version 48 lets a machine specification name binds: folders on the computer bound into a workspace at create,
 * read-write or read-only, refused where the source is not a directory on the computer; the runtime binds a project's
 * memory folder this way so every workspace of the project on that computer reads and writes the one memory, keyed on
 * the project and not on a path.
 * Version 49 makes a workspace on a box awake or stopped and nothing else: pause stops it with SIGTERM to its cgroup
 * after a real quiet window read off its published ports and its commands, and the reading carries how long it has
 * been quiet; a service bound to loopback inside answers through the published port; a create the box has no room for
 * is refused in one sentence naming the quietest workspace; root inside drops the standard capability list and sees
 * empty files over the box's secrets, its ssh keys and the engine's paths; the compose project is named per workspace.
 * Version 50 adds the git road out of a workspace: a push of the branch the copy is on with a refusal to push the
 * base, the pull request opened or found through the signed-in host command line on the computer and its state read
 * back, three operations behind one trait with one module per host.
 * Version 51 gives a workspace on a box the box's tools and a daemon that answers for it: the box's Homebrew prefix and
 * every install root the recipe lands outside the overlaid trees are bound read-only into the workspace's rootfs, and the
 * place daemon serves a workspace's git, file and exec operations with the workspace's checkout as the working directory,
 * so nothing runs a daemon inside a workspace and the init's supervisor lookup is gone.
 * Version 52 refuses a bind whose destination is one of the trees the rootfs takes from the computer, the box's /root
 * and every shared tool root whether present on the computer yet or not, or sits under one, at the create, so a
 * workspace's copy or folder bind can never leave its mount point on the computer's own home.
 * Version 53 puts the provision folder and wsp's own folder whole on the list a leave sweeps, in the daemon and in the
 * protocol with a fixture that holds the two equal, and reads the landed list before the folder goes so wsp's own landed
 * files leave with it and the folders they emptied are pruned; a bring back reports its push half first, the branch, the
 * ahead count and the diffstat, and a gh that is present but not signed in reads as the note beside the landed push,
 * while a push refused for want of a credential says so in the person's words with the command only the person can run.
 * Version 54 adds two optional fields to the place report: each agent's version as the daemon read it, and the relative paths of the files under the logins directory. A host on 53 reads a 54 report as before; a 53 daemon's report reads on a 54 host as today, with no version and no sign-in word.
 * Version 55 reads the agents it reports, and their versions, on the tools PATH the workspaces and the presence read use
 * before the unit's own, so an agent installed by Homebrew or by its own installer is on the report; and the boot records
 * the computer's own paths of the mount points it made for file shares under the computer's trees, so the stop and the
 * remove take them off when no other running workspace shares the target and nothing of a workspace's mounts stays on
 * the computer's own home.
 * Version 56 writes the mount points a boot makes into the create's own claim before anything is mounted, and the record
 * carries them at the end, so a create that fails between the point and its record leaves the points to the open's sweep
 * of unfinished claims and nothing of a workspace's mounts stays on the computer's own home.
 * Version 57 reads the mount points a neighbouring boot has claimed and not yet recorded, so two workspaces sharing one
 * login that boot at the same moment both own its point and the last one to go takes it off, and writes every record,
 * claim and network file to a sibling and renames it into place, so a daemon that dies inside a write leaves no torn
 * file for the next open to refuse, which takes a dead create's torn claim away instead.
 * Version 58 writes the process manifest to a sibling and renames it into place through the same writer every file the
 * runtime crate writes takes, so a daemon that dies inside the write leaves the manifest it had or none, never a torn
 * one the next start refuses.
 * Version 59 binds a socket in each running workspace's own wsp folder that answers a guest's ping, open and send and no
 * other op, so a process inside a box workspace reaches the host's guest door without a token of the box's, writes the
 * wsp word into the workspace's own upper, and opens a shell inside a workspace's namespaces for the terminal pane, held
 * beside the daemon's own ptys and answered to no other workspace.
 * Version 60 links only to a host it has proven, taking the second frame after the first is verified and its own prove
 * sent, seals every frame of the link at both ends so whoever carries it reads and writes nothing, resolves no command
 * through a folder a workspace can write, and holds a token of its own machine's rather than one every machine shares.
 * Version 61 bounds the guest bytes in flight per workspace on a place and per daemon inside a fork, queued and unsent
 * alike, and refuses a frame past the cap with a sentence of its own while the session stays open.
 * Version 62 prints its two kernel knob lines only on Linux and nothing on a Mac start, closes the guest door of a
 * workspace whose init died on its own by watching the init's pidfd and running the stop road, and stops redialling
 * a host that refused its place under a signature over the pinned key.
 * Version 63 counts the bytes a client buffers behind the WebSocket upgrade against the same pre-auth cap as the
 * bytes after it, so nothing rides the upgrade past the door unweighed.
 * Version 64 opens every path under a workspace's rootfs beneath it by descriptor with no link followed, covers the box
 * root's startup files with the workspace's own copies, lets a workspace read under /etc, /var and /srv only what an
 * allowlist names, and skips a linked row at the copy's exclude rather than removing outside the copy.
 * Version 65 fences the engine socket byte by byte: the client-to-engine copy is bounded to the framed body, a volume
 * names no box path, a volume attaches only to the workspace that made it, the bind allowlist lives where a workspace
 * cannot write and every source resolves beneath the rootfs, an engine container joins a per-workspace network, and
 * the daemon's and the engine's ports are closed at the gateway.
 * Version 66 makes every bind under a workspace's rootfs receive-only through a descriptor reopened after the bind,
 * so a workspace on a box boots again: versions 64 and 65 refused every create with EINVAL at the shared home's bind.
 * Version 67 gives a workspace's pty and exec on a box the recipe's knobs and a PATH with the prefix's bin ahead of
 * the home's, so a thread runs the tools the recipe put under the prefix rather than the old copies under the home.
 * Version 68 names, in a pane's create reply, the process its pid is, so a reader of the workspace's pty knows which
 * environment that pid carries; the pane's shell starts from the workspace's own environment as before.
 * Version 69 keeps the fence's connection to the engine open until the engine answers, so a forwarded request is
 * never cancelled into a bodiless 499, and lets a workspace on a box with a refusing input chain dial its own box.
 * Version 70 counts a workspace's sessions and connections at its socket and measures a frame before parsing it, so
 * one workspace cannot run its box daemon out of memory, and the leave removes its owned files by directory handle.
 * Version 72 drops a copied folder's worktree records before the copy's checkout, so a copy of a repo whose base
 * branch one of its own worktrees holds lands on that branch.
 * Version 73 answers fs.folders, one level of a box's folders or every repo on it, for a project added from a box.
 * Version 74 removes a directory clone by renaming it to a hidden sibling and removing that in a process of its own,
 * so a delete answers at once, sweeps any such sibling a stop cut short at start and on the next copy made or
 * removed beside that project, and refuses to remove a path that is not a copy of the project it names.
 * Version 75 takes back what a failed ssh add put on a box: before the add lands anything it asks which of its paths already exist, and after a failed deploy it removes only what this add wrote, stops a unit this add started, and leaves the box as it found it when another add took it meanwhile.
 * Version 76 answers as 75 does: a directory clone's removal takes the copy's own path off the shape check, and a test pins that a path with a trailing slash sets aside the link it names.
 * Version 77 forwards a guest's `wsp mcp` to the running host over the daemon's link, so a thread's MCP server needs no host process of its own on the machine.
 * Version 78 changes no behaviour: the pty broker's cases moved to a test binary of their own, and the file they left is hashed.
 * Version 79 changes no behaviour: every wire type in the protocol crate derives the TypeScript the protocol package re-exports, which moves the crate's sources and the lock.
 * Version 80 answers git.status on a stopped workspace with the branch alone, read off its copy's git directory with no program run, and says the edits were not read; running or stopped, a branch with no upstream counts ahead and behind against the default branch; a stopped copy's history too long or slow to walk answers countsUnknown.
 * Version 81 reads no record another daemon wrote: a workspace record carries every field and a points file that does
 * not parse is refused by its path; the hello always names the version; the copy verb has no in-place road and the
 * daemon no ssh kind; exec and pty take the compose project off the workspace's own boot environment.
 * Version 82 changes nothing a guest runs: the binary gains the mcp verb behind a feature the guest build leaves off.
 * Version 83 answers fs.search: the files under a folder whose path holds a query's letters in order, or the lines of text there that hold it, walked with the folder's ignore rules and never through a link, under a cap and a time budget.
 * Version 84 adds fs.files, every file of a checkout git would show, from git ls-files and kept until a folder holding one
 * of them changes, and git.prList, the repository's open pull requests and issues through the host's command line, an
 * empty list with a note where that command line is not there or nobody signed it in.
 * Version 85 adds git.checkpoint, a turn's whole tree recorded as a commit outside every branch under
 * refs/wsp/checkpoints/<copy>/<thread>/<turn>, and git.restore, which puts the tree back to one of the copy's own
 * checkpoints after recording the tree as it stood; a worktree copy's removal deletes its checkpoint refs.
 * Version 86 writes into a copy: git.commit commits the files named with the message on stdin, git.discard puts one
 * file back as HEAD has it, and fs.write replaces a file's contents whole; git.diff gains the head scope with untracked
 * files as new, paths, whole files in one hunk, and each file's blob id; a discard takes the folders it left empty, and
 * the binary's version verb prints this number.
 * Version 87 changes no behaviour: the place link's seal moved into a crate of its own, which the tool server's dial
 * to a host somewhere else links too, so the crate's sources and the lock moved.
 * Version 88 lists untracked files in git.diff's branch scope as well as its head scope, over the whole repository
 * from any folder, and an untracked link with no patch and no blob rather than a diff read through it; a repository
 * whose top sits above the daemon's root answers git.diff for the files under that root alone.
 * Version 89 changes nothing a guest runs: the forwarder on the host's computer no longer asks the wsp where the host
 * is, a wsp mcp line that names its state is served by the binary's own tool server, and the guest's tool server
 * session drops the reopening only that forwarder did.
 * Version 90 reads a pull request with the repository named off the remote the frame carries: git.prRead answers one by
 * branch or number with its checks, review, mergeability, counts and how far its base has moved on, and a read by
 * number that gh refused is an error rather than none; git.prView its page with the comments on its lines, git.runLog
 * a failed job's last lines, git.repoRead a repository's merge methods, and git.prMerge merges only the head it names;
 * git.update merges the base's latest commits into a clean checkout and takes a conflicting merge back; git.pr answers
 * the whole fact, and git.prState is gone.
 * Version 91 adds git.snapshot, the checkout as it stands as one commit on HEAD taken through an index of its own,
 * and git.range, the diff between two such commits by their full shas, held to the daemon's root as git.diff is;
 * every git.diff file gains its kind and its line counts, and a checkpoint starts no fsmonitor.
 * Version 92 opens a new listener on the reading that finds it and asks it once, beside the reading, whether it is a
 * browser's DevTools port; one that answers as one closes on the next reading and is left out of every one after.
 * Version 93 starts an ssh server for an editor: ssh.start writes the one key it is handed as the only authorized key,
 * starts the image's own sshd on a free loopback port inside the workspace (inside the fork where it names a
 * machine) and answers that port and the server's host key; tunnel.open names the machine it dials inside, and
 * tunnel.data and tunnel.end carry it back. The server and every process it started are stopped five minutes after
 * its last tunnel closes, and when the daemon ends; one an ended daemon left behind goes before another starts. A
 * daemon answering for a computer somebody owns starts none on that computer itself, and inside a workspace the
 * server's files are written with no link of the workspace's followed.
 * Version 94 asks the DevTools question on the person's own computer only of a listener wsp's own processes hold, the
 * daemon and everything under the host that started it, so no other server of theirs gets a request from wsp.
 * Version 95 is the deploy landing each file of the bundle by a rename over the one it replaces, so a daemon that is
 * running is replaced rather than refused as a busy file.
 * Version 96 reads every worktree file git.diff answers for itself, from the folder the caller may read down with no
 * link followed: an untracked file's patch and every file's blob id come from that read, and a tracked file's hunk is
 * diffed from the base object and the blob hashed off that read, so no content byte comes from a path a link could
 * have redirected after git listed it.
 * Version 97 changes nothing a guest runs: where this computer's binary carries the tool server, the host runs it for
 * each guest session as the thread's scoped server under --guest, which refuses a file or an unnamed workspace and
 * leaves the tools that read this computer off its list.
 * Version 98 runs the command pty.create names through the person's own shell, as interactive and login as their
 * terminal opens it, and the pty exits with it; such a pty is a reply's, which pty.list marks and no pane adopts, until
 * pty.tab hands it to the panes still running.
 * Version 102 hashes an untracked file's blob id in this daemon's own process, in the repository's object format,
 * from the bytes it read, so a checkout of tens of thousands of untracked files spawns no git and writes no object;
 * git hash-object is run, with -w, only for the tracked hunks git.diff rebuilds from the object.
 * Version 103 asks the DevTools question only of a listener whose holder goes by a browser's or Electron's name
 * (Chrome and its helpers, Chromium, headless_shell, Edge, Brave, Arc, Electron and its helpers), so a node server a
 * thread's tests start gets no request. It reverses the rule of version 92, which asked every listener by what it
 * answers, on the owner's ruling.
 * Version 104: git.startOn puts a checkout on a branch as the remote holds it, git.branchCompare counts a branch
 * against a base branch or commit through the git host's command line on this computer, and git.mergeIn merges a
 * child's branch in with a merge commit and answers with the child's commit it took, fetched from the remote or from a
 * copy's folder on this computer under overrides that stop a served repository's configured commands. A fetch or a push
 * refused for want of a credential carries the code no-git-credential.
 * Version 105: Reads a pull request's author and last-updated time and each commit's author from the one gh page read,
 * so the pane's header names who opened it and when it last moved and each commit names who wrote it.
 * Version 106: Changes nothing a guest runs: a leave run as root takes the workspace profile the daemon's options name,
 * the one a root install writes unless a test names a file under its own home.
 * Version 107: Starts and reviews from a link: git.issueRead reads an issue, git.prCheckout puts a copy on a pull
 * request's head through the host's command line, git.prDiff reads a diff cut on a file's boundary, and git.prReview
 * posts one review whole with a comment outside the diff put into its body. A pull request read names its author and
 * its fork, a bring back pushes where the branch's own configuration points, and git.pr fills under a title or a body
 * given.
 * Version 108: the daemon keeps its computer's readings, one point a minute folded from its samples, in a file a day
 * beside its token or in the folder --readings-dir names, 14 days under 8 MiB with the oldest day dropped first, and
 * sys.history answers them folded into the step asked for.
 * Version 109: A turn's changed-files range is now what the agent itself changed: each commit it wrote contributes its
 * own files, collected one by one over the turn's reflog window whatever moved HEAD after them, together with the edits
 * standing in its end worktree and the files it resolved by hand in a merge, while a HEAD move it did not write (a
 * checkout, pull, merge, rebase or reset) is named on a line with no files of its own. A rebase is one such line plus
 * the edits standing at the end; the commits it replayed and any conflict it resolved mid-rebase are not listed.
 * Version 110: A joined Mac reports which Mac it is: its place report carries the product name its registry gives, else
 * its model identifier, so the computer's row draws that Mac rather than a server. git.status counts the stashes a
 * repository holds, running or stopped, so a delete names them.
 * Version 111: the room check's refusal is a contract word, so the Mac's copy road says the same sentence.
 * Version 112: A pull request's page reads when it opened and settled, who merged it into which commit, its labels, the
 * reviews asked for, each reviewer's latest verdict and its assignees; each commit's message body and, off one GraphQL
 * read over gh's own first 100 commits, its parents, line counts and rolled-up checks, the newest 100 reviews' ids and
 * whether each of the newest 100 threads is resolved, with a mark for each part read only in part; every page of its
 * conversation and its line comments off the REST API, with each author's association with the repository, whether a
 * bot wrote each comment and the face it shows, and each line comment's hunk, the comment it answers and its review. No
 * body on the page is cut, and every host line's answer is read to 16 MB and refused past it. A check reads when it
 * started and finished, a pull request the merge armed on it, and git.prDiff cuts at the bytes asked for, up to the cap
 * a git.diff has, reading at most four times that before it stops gh and names the files it saw.
 * Version 113: Writes on a pull request as the person signed in to gh: git.prReply posts a reply under a comment on a
 * line or a new comment in the conversation, its body as typed on stdin and at most 65,536 characters, a line reply
 * carrying back the thread it names; git.prResolve resolves or unresolves a review thread; and git.prReact adds or
 * takes off a reaction. A resolve and a reaction name their thread or item by a node id, refused before anything runs
 * where it is not one's shape, and refused before the mutation where a read finds it on any pull request but the
 * repository's one numbered. A pull request's page reads each comment's, review's and line comment's node id and
 * reactions, with whether the signed-in person left each, and each line comment's review thread by id.
 * Version 114: The binary makes and removes the worktree a thread on another branch works in: copy worktree answers the
 * worktree already holding the branch, else makes one under the host's folder (or the project volume's own .wsp) on the
 * branch as its tip stands, a new branch at the folder's HEAD and never a reset, with the folder's config files and
 * each named dependency directory carried in by one clonefile per directory; copy worktree-remove takes away only a
 * worktree wsp made, refuses one holding uncommitted files unless forced, and saves a detached worktree's commit to a
 * refs/rescue ref first. git.checkpoint and git.restore take a scope that names the refs in place of the folder, and a
 * thread keeps its newest hundred checkpoint refs, the before refs a restore writes counted; git.checkpointDrop takes
 * one thread's refs away; git.worktrees and git.branches read a repository's worktrees and its local branches;
 * git.switchNew puts a folder on a new branch with its changes carried along; git.fetchBranch fetches one branch of a
 * remote into a local branch, moving it only forward.
 * Version 115: Daemon port-file test times out on Linux CI about half the time.
 * Version 116: recipes and the add-a-computer setup job.
 * Version 117: A leave run as root takes wsp's install folder, /opt/wsp, off the computer with every link in
 * /usr/local/bin pointing under it, and nothing else of either; a prefix that is itself a link stays and is said.
 * Version 118: A leave run as root first takes what the setup wrote under /usr/local and /opt, read off the list in
 * /opt/wsp: each path still as wsp left it, hashed in one pass, a folder once empty, and nothing the computer had
 * before wsp; the list goes last, and while it still holds lines /opt/wsp stays and the leave says so.
 * Version 119: setup sign-ins, cut syncs and the size check survive their edges.
 * Version 120: git.prRead asks a pull request named by number with what its last read saw (its last update, head commit
 * and state): one REST read compares them, and where none moved it answers unchanged with nothing else run and none of
 * the GraphQL budget spent; a read with nothing seen makes no such read. A read the git host refused for its rate limit
 * carries the code rate-limited, and a branch so refused never reads as having no pull request. git.prView reads the
 * page on one GraphQL call in place of four, the newest 100 conversation comments with the rest marked cut.
 * Version 121: leave tests take a temp install root, never /opt/wsp.
 * Version 122: A turn's HEAD move lines name the branch HEAD was on: git.snapshot stamps the branch it stands on, or a
 * detached HEAD, beside the reflog length, and git.turn reads the turn's window back from that stamp, so a merge reads
 * "Merged origin/main into fix/x", a reset "Reset fix/x to origin/main", a pull "Pulled into fix/x" and a rebase
 * "Rebased fix/x onto main", one that was detached says "a detached HEAD", and a pull that rebases is one line.
 * Version 123: an agent-owned live panel per thread.
 * Version 124: restore three landings a later squash took back out.
 * Version 125: ports.watch takes roots and a folder and reads every five seconds, only while a socket watches. A socket
 * that names roots sees the listeners of their process groups, every process under them and every process running in
 * the folder; a watch that names none, the host's own, sees the whole machine. Each socket is told what moved against
 * what it was last sent, a port another holder took as a close and an open, a port that left the view while it still
 * listens as a close marked left, and a second watch names its roots again. A browser.open with no port hurries the
 * watch to a read a second through the spotter's window. proc.watch sends one whole proc.snapshot two seconds after the
 * watch and then a proc.changes every five seconds; every frame carries a seq and each proc.changes the base it applies
 * to, and a socket that watches again is sent a whole snapshot next.
 * Version 126: six small host and test faults.
 * Version 127: The daemon's ssh start picks a free port, lets it go, and races another process for it.
 * Version 128: remove takes back only what the add made outside the home. */
export const DAEMON_VERSION = DAEMON_CONTENTS.length;

/** sha256 of what a deploy installs on a guest and this record can hold: the Rust sources and manifests the binary
 * is built from, the lock that pins its dependencies, the C library the Linux builds link and its pinned release,
 * the contract fixtures its words and numbers are held to (the version itself left out of them, since it is this
 * record), the scripts the host writes beside it, DAEMON_ROOTS_PATH and the work-score line. The host's
 * daemon-content test recomputes it and fails when that content moved and this record did not, so changed content
 * cannot reach nobody: a start script gained a PATH line under an unchanged version once and every machine already
 * running kept the old one. Left out: every file under a crate's tests/ folder, which is built for a test run
 * and no deploy installs, so test-only work cuts no version for a binary nobody's machine would read as new; an
 * inline #[cfg(test)] module stays hashed, since the file carrying it ships. Left out too: crates/wsp-mcp, the tool
 * server a feature links into the host's own build and the guest build never does; the rest of this file,
 * which the binary reads only through the fixtures; hashing the protocol whole would turn every edit to it into a
 * redeploy of every machine. */
export const DAEMON_CONTENT_SHA = DAEMON_CONTENTS[DAEMON_CONTENTS.length - 1]!;

/** The file on the guest naming the imported project folders, one absolute path per line: the runtime writes it
 * when a project lands, the daemon reads it on every files and diff op and browses those folders beside its home.
 * The guest's home is /root, so this is rootsPathIn answered there; the value is hashed into DAEMON_CONTENT_SHA. */
export const DAEMON_ROOTS_PATH = rootsPathIn("/root");

/** The shape the records in a state file are written in. Any change to the schema of a stored record cuts this
 * number, and a host refuses a file in any other shape rather than reading a record in a form it does not know.
 * 2 since a project's seeded row changed whole: one word for what its memory did where it held two flags, the
 * memory folder's own file count beside it, and `bytes` now the sum the menu showed for the ticked files where it
 * was the size of the archive they travelled in, which is bigger, so the two numbers do not compare. */
export const STATE_SHAPE = 2;

/** What a save records about the wsp that wrote the file, apart from the records themselves: the shape those
 * records are in, the build that wrote them and when. A file with none was written before this record existed. */
export const StateShape = z.object({
  shape: z.number().int(),
  /** What the build calls itself: the version a released wsp prints, or the program's own name where it has none,
   * which is what a person would have to run again. */
  wsp: z.string(),
  /** The daemon that wsp deploys, which is the other half of what a build is. */
  daemon: z.number().int(),
  /** The binary it ran from, which is the one thing that says which of the builds on this computer wrote the file. */
  bin: z.string(),
  at: z.string(),
});
export type StateShape = z.infer<typeof StateShape>;

/** How a sentence names the build that wrote a state file. */
export const stateWriterWords = (wrote: StateShape): string => `${wrote.bin} (wsp ${wrote.wsp}, daemon ${wrote.daemon})`;

/** The one word a place's row says while this wsp deploys a newer daemon than that computer runs, and nothing
 * while it is level or ahead or has never reported. Both sides of the figure are already on the wire: the place
 * sends its own version in every report and this host's is the record above, so nothing is asked for it. Read by
 * `wsp places`, by the places table and by the doctor, so the three cannot word it three ways. */
export function placeDaemonBehind(place: { daemonVersion?: number }): string | undefined {
  const version = place.daemonVersion;
  return version === undefined || version >= DAEMON_VERSION ? undefined : `daemon ${version}, host ${DAEMON_VERSION}`;
}

/** The first daemon that answers fs.folders. */
export const FS_FOLDERS_DAEMON_VERSION = 73;

/** The line that moves a place onto this wsp's daemon, which is the fix half of every sentence about a place that
 * is behind. */
export const placeUpdateLine = (name: string): string => `wsp add ${name} --update`;

/** What the doctor says about one place that is behind: the word above and the line that answers it. */
export const placeBehindLine = (name: string, word: string): string => `${name} is behind: ${word}; ${placeUpdateLine(name)} puts this wsp's daemon on it`;

/** The refusal an update gets on a place already running the daemon this wsp deploys. */
export const placeCurrentLine = (name: string, version: number): string => `${name} already runs daemon ${version}, which is the one this wsp deploys`;

/** What a computer whose recipe is still being put on says to whoever asked for a workspace there, or for a second
 * run of the job: the row under way where the job has reached one, and the two roads to the rest of the answer. */
/** The refusal a setup gets on a computer while a sync to its recipe runs there: the two would install over each other. */
export const placeSyncingLine = (name: string): string => `${name} is syncing to its recipe; set it up again once that ends`;

export const placeProvisioningLine = (name: string, step?: PlaceSetupStep): string =>
  `${name} is still being set up${step === undefined ? "" : ` (${SETUP_STEP_WORDS[step]})`}; wsp computers shows it, and a workspace there can be made once it is done`;

/** What a join or an update says about a computer that carries no picks: nothing goes on it until it has some. */
export const placeNoPicksLine = (name: string): string =>
  `${name} has nothing picked to go on it: choose in the app's Add a computer, or run wsp add ${name} --resume --recipe <name>`;

/** What a computer that reported no home folder for its login gets instead of the recipe: every path the job would
 * build comes off that home, so there is nothing to build one from. Said where the no-recipe line is said. */
export const placeNoHomeLine = (name: string): string =>
  `${name} got no agents or tools: it reported no home folder for its login, so nothing on it could be reached`;

/** The rows of a setup whose failure reads Needs you: a folder that did not move, the GitHub sign-in. */
export const importantFailures = (applied: PlaceApplied | undefined): PlaceProvisionRow[] =>
  (applied?.rows ?? []).filter(r => r.outcome === "failed" && r.step !== undefined && SETUP_STEP_CLASS[r.step] === "important");

/** The setup on a computer as the TOOLS column says it: the step under way, where it stopped, or what stands.
 * Empty for a computer nothing has set up, which is every provider and this computer itself. */
export function setupWord(setup: PlaceSetup | undefined, applied?: PlaceApplied): string {
  if (setup === undefined) return "";
  const under = setup.steps.find(l => l.state === "running");
  if (setup.state === "running") return under === undefined ? "setting up" : `setting up ${SETUP_STEP_WORDS[under.step]}`;
  if (setup.state === "failed") return `stopped: ${setup.said ?? "no reason recorded"}`;
  const rows = applied?.rows ?? [];
  const failed = rows.filter(r => r.outcome === "failed");
  // What the rows put there, not the word row: a row is the recipe's own word and nobody reading this screen has
  // seen a recipe.
  return failed.length === 0 ? `${provisionCountWord(provisionCounts(rows))} ready` : `${failed.length} of ${rows.length} failed: ${nameList(failed.map(r => r.label))}`;
}

/** The words a computer's setup reads as, in the order they win. */
export const SETUP_WORDS = { failed: "Setup failed", needsYou: "Needs you", pending: "Pending", settingUp: "Setting up", behind: "Behind", ready: "Ready" } as const;

/** What a computer out of step with its recipe says: the rows on their way, or under way. */
export const syncLine = (sync: PlaceSync): string =>
  `${sync.state === "running" ? "putting on" : "waiting to put on"} the recipe's ${plural(sync.changes.length, "change")}: ${nameList(sync.changes)}`;

/** What a sign-in waiting on the person says, and the same once its page ran out. */
export const waitLine = (w: PlaceWait): string => (w.state === "expired" ? `${w.label}'s sign-in ran out; a retry asks for a fresh code` : `${w.label} waits on you to sign in${w.url === undefined ? "" : ` at ${w.url}`}${w.code === undefined ? "" : ` with code ${w.code}`}`);

/** One computer's word for its setup, the one rule the STATE column and the app's rows read: Setup failed, then
 * Needs you (a sign-in waits on the person, or a folder or the GitHub sign-in failed), then Pending (it joined and
 * waits on its picks, `pending` its add), then Offline (no link), then Setting up, then Behind (a change to its recipe on
 * its way, then its daemon behind this host's), then Ready. An add that never joined is a row of its own, read by pendingWord. */
export function placeWord(place: Pick<PlaceView, "setup" | "applied" | "daemonVersion" | "sync">, absent: AbsentComputer | null, pending?: PendingComputer): PlaceState {
  const setup = place.setup;
  if (setup?.state === "failed") return { word: SETUP_WORDS.failed, ...(setup.said !== undefined ? { sentence: setup.said } : {}) };
  if (pending?.failed !== undefined) return pendingWord(pending);
  const wait = setup?.waiting[0];
  if (wait !== undefined) return { word: SETUP_WORDS.needsYou, sentence: waitLine(wait) };
  const important = importantFailures(place.applied);
  if (important.length > 0) return { word: SETUP_WORDS.needsYou, sentence: important.map(r => `${r.label}: ${r.note ?? "failed"}`).join("; ") };
  if (pending !== undefined) return pendingWord(pending);
  if (absent !== null) return { word: absent.away, sentence: absent.sentence };
  if (setup?.state === "running") return { word: SETUP_WORDS.settingUp, sentence: setupWord(setup) };
  if (place.sync !== undefined) return { word: SETUP_WORDS.behind, sentence: syncLine(place.sync) };
  const behind = placeDaemonBehind(place);
  return behind === undefined ? { word: SETUP_WORDS.ready } : { word: behind };
}

/** A pending add's word: Setup failed where a step stopped it, else Pending with how far it got. */
export function pendingWord(p: PendingComputer): PlaceState {
  if (p.failed !== undefined) return { word: SETUP_WORDS.failed, sentence: p.failed.said };
  return { word: SETUP_WORDS.pending, sentence: PENDING_STEP_WORDS[p.step] };
}

/** How far a pending add got, as its row says it. */
export const PENDING_STEP_WORDS: Record<PendingStep, string> = {
  connect: "connecting over ssh",
  check: "checking it can run wsp",
  wsp: "installing wsp",
  floor: "joined; the base tools are going on while you choose",
  choosing: "joined; waiting on what goes on it",
};

/** What a place's row reads as: the word beside its name, the tone the two cap words take, and the sentence that
 * says why. Blocked first, since only a person fixes it; then the setup's own words that need the person; then not
 * answering, since nothing reaches a computer that is off; then the day's spend and the cap, which stop new work;
 * then the setup running, a daemon behind and Ready. `spentTodayUsd` is the cloud's spend since this computer's
 * midnight, and At limit is never read without it. The command line's STATE column and the app's row both read
 * this, so the two cannot word one place two ways. */
export interface PlaceState {
  word: string;
  tone?: "warning";
  sentence?: string;
}

export function placeStateOf(place: PlaceView, absent: AbsentComputer | null, spentTodayUsd?: number, pending?: PendingComputer): PlaceState {
  if (place.blocked !== undefined) return { word: PLACE_BLOCKED_WORD, sentence: place.blocked };
  const setup = placeWord(place, absent, pending);
  if (setup.word === SETUP_WORDS.failed || setup.word === SETUP_WORDS.needsYou || setup.word === SETUP_WORDS.pending || absent !== null) return setup;
  const limit = placeAtLimitLine(place, spentTodayUsd);
  if (limit !== undefined) return { word: "At limit", tone: "warning", sentence: limit };
  const full = placeFullLine(place);
  if (full !== undefined) return { word: "Full", tone: "warning", sentence: full };
  return setup;
}

/** The lines a terminal prints once a setup is over: what installed by name, how many rows were already there,
 * then every row that failed or was set aside with its reason, every sign-in still waiting, and what stopped the
 * job where one did. */
export function setupLines(name: string, setup: PlaceSetup, applied: PlaceApplied | undefined): string[] {
  const rows = applied?.rows ?? [];
  const of = (outcome: PlaceProvisionRow["outcome"]): PlaceProvisionRow[] => rows.filter(r => r.outcome === outcome);
  const installed = of("installed");
  const present = of("present");
  const tally = [
    installed.length === 0 ? "nothing installed" : `${installed.length} installed: ${nameList(installed.map(r => r.label))}`,
    ...(present.length > 0 ? [`${present.length} already there`] : []),
  ];
  return [
    `${name}: ${tally.join(", ")}`,
    ...of("failed").map(r => `  x ${r.label}: ${r.note ?? "no reason recorded"}`),
    ...of("skipped").map(r => `  - ${r.label}: ${r.note ?? "set aside"}`),
    ...setup.waiting.map(w => `  ? ${waitLine(w)}`),
    ...(setup.said === undefined ? [] : [`${name}: ${setup.said}`]),
  ];
}

/** The refusal a second add to an address gets while the first stands, and what to do instead. */
export const pendingHeldLine = (address: string, step: PendingStep): string => `${address} is already being added (${PENDING_STEP_WORDS[step]})`;
export const pendingHeldFix = (name: string): string => `Finish it with wsp add ${name} --resume --recipe <name>, or in the app.`;
/** The refusal picks kept for a word no pending add answers to get. */
export const noPendingRefusal = (ref: string): string => `no add of ${ref} is pending`;
/** The refusal a resume of an add that never joined gets: there is no computer to set up yet. */
export const pendingNotJoinedLine = (name: string): string => `${name} never joined, so there is nothing to set up`;
export const pendingNotJoinedFix = (address: string): string => `Add it again with wsp add ${address}.`;
/** The fix half of a resume that names nothing to set up with. */
export const CHOOSE_FIX = "Choose what goes on it in the app's Add a computer, or name a saved recipe with --recipe <name>.";

/** How long a sign-in run on a computer you own waits on the person: a page opened and a code typed there is
 * minutes, and the codes the tools print run out in about fifteen. */
export const SIGN_IN_WAIT_MS = 10 * 60_000;

/** What a setup's rows say about where a sign-in came from. */
export const FROM_THE_VAULT = "from this computer's vault, handed to every run there";
export const SIGNED_IN_THERE = "signed in on that computer";
export const NO_SIGN_IN_ROAD = "this host runs no sign-in on a computer; sign in from the app or with wsp add <computer> --sign-in <agent>";
export const NO_FOLDER_ROAD = "this host moves no folder to a computer; add it with wsp add <folder> --on <computer>";
export const NO_GITHUB_TOKEN_LINE = "this computer's vault holds no GitHub token: gh auth login here, then retry";
export const noVaultTokenLine = (agent: string): string => `this computer's vault holds no token or key for ${agent}: wsp agents key ${agent}, then retry`;
/** What a row the recipe took out says where a file of it stays, since the person has written it there since, and
 * where its files could not be taken off at all. */
export const editedThereLine = (name: string, kept: readonly string[]): string => `${nameList(kept)} ${kept.length === 1 ? "was" : "were"} edited on ${name}, so ${kept.length === 1 ? "it stays" : "they stay"} and wsp no longer manages ${kept.length === 1 ? "it" : "them"}`;
export const UNLAND_FAILED_LINE = "its files could not be taken off there; wsp remove takes them";
/** What a row the recipe took out says where the box had it before wsp: it stays. */
export const wasThereLine = (name: string): string => `${name} had it before wsp, so it stays`;

/** What a computer's picks weigh against the room it has, before Set up: the bytes the picks need, the bytes a setup
 * keeps free there past them, the bytes free there as it last said, and how many picked rows nobody measured. */
export const PlaceEstimate = z.object({ neededBytes: z.number().int().nonnegative(), keptBytes: z.number().int().nonnegative(), freeBytes: z.number().int().nonnegative().optional(), unmeasured: z.number().int().nonnegative() });
export type PlaceEstimate = z.infer<typeof PlaceEstimate>;

/** How much of the end of a computer's setup log one read takes: a step's output for the running view, never the
 * whole log of a long job. */
export const SETUP_LOG_TAIL_BYTES = 64 * 1024;

/** What a row the person set aside with Skip for now says: nothing of it waits, and Settings finishes it. */
export const SKIPPED_FOR_NOW = "skipped for now; finish it from the computer's page in Settings";
/** The refusal a skip naming no row that waits or failed gets. */
export const nothingToSkipLine = (row: string, name: string): string => `nothing waits or failed under ${row} on ${name}`;

/** What the GitHub row says where the person skipped it, and a folder whose repository needs it to clone. */
export const GITHUB_SKIPPED_LINE = "skipped; gh is not signed in there";
export const NEEDS_GITHUB_LINE = "private; needs GitHub to clone";
export const WAITS_ON_GITHUB_LINE = "private; waits on the GitHub sign-in to clone";

/** What to do about a row of the setup that did not land, beside what happened: the reason's own fix where the
 * reason is one wsp knows, else its step's. `box` is the computer's name. */
export function setupRowFix(row: Pick<PlaceProvisionRow, "step" | "note">, box: string): string | undefined {
  if (row.note === NEEDS_GITHUB_LINE) return `Sign GitHub in on ${box}, then retry.`;
  if (row.step === undefined) return undefined;
  const fixes: Record<PlaceSetupStep, string> = {
    floor: `Check that ${box} can reach its package mirrors, then retry.`,
    agents: `Retry, or install it on ${box} yourself and skip it here.`,
    signins: "Retry for a fresh code, or sign in later in Settings.",
    clis: `Retry, or install it on ${box} yourself and skip it here.`,
    skills: "Check the skill's folder here, then retry.",
    mcp: "Check the server's entry in the agent's settings here, then retry.",
    plugins: `Retry, or add it on ${box} yourself and skip it here.`,
    configs: "Check the file here, then retry.",
    folders: "Check that the folder is still where it was, then retry.",
    github: "Retry for a fresh sign-in, or sign in later in Settings.",
    context: "Retry; nothing else waits on it.",
  };
  return fixes[row.step];
}

/** How many of the setup's steps after the base tools run at once on a computer of this much memory: one per 2 GB,
 * at least one and at most four, so a small box never runs two installs into each other's memory. */
export const SETUP_MB_PER_STEP = 2048;
export const setupWidth = (memMb: number): number => Math.max(1, Math.min(4, Math.floor(memMb / SETUP_MB_PER_STEP)));

/** Why a setup stopped at the floor, naming the base tools that did not install. */
export const floorFailedLine = (rows: readonly Pick<PlaceProvisionRow, "label">[]): string => `the base tools did not install: ${nameList(rows.map(r => r.label))}`;
/** Why a setup stopped at the agents: every one picked failed. */
export const noAgentLine = (rows: readonly Pick<PlaceProvisionRow, "label" | "note">[]): string =>
  `no agent installed: ${rows.map(r => `${r.label}${r.note === undefined ? "" : ` (${r.note})`}`).join("; ")}`;

/** One line of the job's own log on a computer you own: the time it was written, in UTC to the second, then the
 * line. Every line that log takes carries one, so what each part of a run took is read off the computer's own log
 * afterwards rather than timed while it happens. */
export const provisionLogLine = (at: number, line: string): string => `${isoSeconds(at)} ${line}`;

/** What the round that lands the person's agent files packed on this computer: the paths the recipe planned, then
 * what the pack counted where it asked that computer first, the files already standing there at the same bytes and
 * the files the archive holds, and what that archive weighs. A pack that asked nothing says its bytes alone. */
export const provisionPackedLine = (paths: number, p: { bytes: number; files?: number; stood?: number }): string => {
  const counted = p.files === undefined || p.stood === undefined ? "" : `${plural(p.stood, "file")} ${p.stood === 1 ? "stands" : "stand"} there already, ${plural(p.files, "file")} packed, `;
  return `packed on this computer: ${plural(paths, "path")}, ${counted}${fmtBytes(p.bytes)}`;
};

/** What one part of that archive came to on the way over: the bytes it carried, and the pieces the road cut it
 * into where the bytes travel on one exec frame each, which is how a computer you own is reached. */
export const provisionShippedLine = (p: { part: number; parts: number; bytes: number; total: number; pieces?: number }): string => {
  const took = p.pieces === undefined ? "" : ` in ${plural(p.pieces, "piece")}`;
  return p.parts === 1 ? `shipped: ${fmtBytes(p.total)}${took}` : `shipped part ${p.part} of ${p.parts}: ${fmtBytesOfTotal(p.bytes, p.total)}${took}`;
};

/** What the run on that computer walked once the archive was there: every file of the person's copy, each read
 * against what stands at its path. */
export const provisionLandedLine = (files: number): string => `landed: ${plural(files, "file")} walked on that computer`;

/** What the list beside the job holds for the servers round: one key per server wsp wrote into an agent's own
 * file there. */
export const provisionListReadLine = (keys: number): string => `list read: ${plural(keys, "server key")}`;

/** What the servers round wrote into the agents' own files on that computer, of the servers the recipe names. */
export const provisionServersLine = (written: number, servers: number): string =>
  `servers merged: ${written} of ${plural(servers, "server")} written into the agents' own files`;

/** The refusal an update gets where this wsp holds no daemon built for the chip that computer said it is. */
export const placeNoChipLine = (name: string, platform: string, arch: string): string =>
  `${name} says it is ${platform} ${arch}, and this wsp carries no daemon built for it`;

export const DaemonEvent = z.discriminatedUnion("type", [
  /** The first frame after the auth reply: root is the
   * absolute directory every fs.* and git.* path must resolve inside, so a
   * client can build absolute paths for pickers, pins and session starts.
   * version is DAEMON_VERSION as the daemon was built. */
  z.object({ type: z.literal("daemon.hello"), root: z.string(), version: z.number().int() }),
  z.object({ type: z.literal("pty.data"), ptyId: z.string(), data: z.string() }),
  z.object({
    type: z.literal("pty.exit"),
    ptyId: z.string(),
    exitCode: z.number(),
    signal: z.number().optional(),
  }),
  /** loopback: bound to 127.0.0.1 or ::1 only, so the preview edge (which dials eth0) cannot reach it. */
  z.object({
    type: z.literal("port.open"),
    port: z.number(),
    pid: z.number().optional(),
    process: z.string().optional(),
    loopback: z.boolean().optional(),
  }),
  z.object({ type: z.literal("port.close"), port: z.number(), ...portCloseDetail }),
  z.object({ type: z.literal("inbox.file"), path: z.string(), bytes: z.number() }),
  /** Broadcast on pty.attach (current state) and afterwards only on change.
   * mode mirrors the slave termios ICANON bit ("line" when set), echo mirrors
   * ECHO; foreground is the comm of the foreground process group leader, ""
   * when unreadable. There is no request op: clients only listen. */
  z.object({
    type: z.literal("pty.mode"),
    ptyId: z.string(),
    mode: z.enum(["line", "raw"]),
    echo: z.boolean(),
    foreground: z.string(),
  }),
  /** A guest tool asked for a browser (through the BROWSER or xdg-open shim).
   * Pushed to every authed socket; clients show it and open it on a click.
   * http(s) only: the machine is the untrusted side. port is the localhost
   * port in the URL's redirect_uri when it carries one. */
  z.object({ type: z.literal("browser.open"), url: z.string().refine(isHttpUrl, "http or https URL"), port: RelayPort.optional() }),
  /** A loopback listener appeared around a browser.open whose URL named no
   * port: the flow's callback, for the host to forward. */
  z.object({ type: z.literal("callback.port"), port: RelayPort }),
  z.object({ type: z.literal("tunnel.data"), tunnelId: z.string(), data: z.string(), machineId: z.string().optional() }),
  /** The guest side closed; the laptop connection ends after any data before it. */
  z.object({ type: z.literal("tunnel.end"), tunnelId: z.string(), machineId: z.string().optional() }),
  /** A pty printed, or a tool asked to open, a plain http URL on a local host
   * with an explicit port (http://localhost:8123/, 127.0.0.1:8123): the port a
   * person would click. Only the port travels; the host forwards it here. */
  z.object({ type: z.literal("localhost.url"), port: RelayPort }),
  SysSample,
  ProcSnapshot,
  ProcChanges,
  /** A process inside the machine opened a guest session. Pushed to the socket that sent guest.watch alone, never
   * broadcast: the host is the only reader of the token it carries. */
  z.object({
    type: z.literal("guest.opened"),
    session: z.string(),
    /** The run of the machine's daemon that named this session. Session names count from the start on every run,
     * so a machine rebuilt under this host hands it a name it may still hold; this and the name together are what
     * a session already open here is told from a new one of the same name. */
    life: z.string(),
    kind: GuestKind,
    token: z.string(),
    turnToken: z.string().optional(),
    argv: z.array(z.string()),
    cwd: z.string(),
    /** The workspace the session was opened inside, on a daemon that runs workspaces: the listener the session
     * arrived on is what names it, never anything the guest said, so a session of one workspace can never read as
     * another's. Absent on a daemon inside a machine, where the machine is the one this host dialled. */
    machineId: z.string().optional(),
  }),
  /** One message on a session, travelling either way: a guest's up to the watcher, the host's answer back down.
   * The workspace is the opened frame's, as on every frame a place daemon relays for a session. */
  z.object({ type: z.literal("guest.message"), session: z.string(), message: z.unknown(), machineId: z.string().optional() }),
  /** The session ended; this reaches whichever side did not end it. */
  z.object({ type: z.literal("guest.closed"), session: z.string(), error: z.string().optional(), machineId: z.string().optional() }),
]);
export type DaemonEvent = z.infer<typeof DaemonEvent>;

// --- runtime wire protocol (serveRuntime) ------------------------------------

/** What a single-use ticket opens the next socket for: `connect`, another client of the person's own, or `relay`,
 * the road a machine's requests reach this host by. The purpose is what a socket's origin is read off, so a relayed
 * socket is one this host minted a relay ticket for and nothing a client says on the wire can make one. */
export const TicketPurpose = z.enum(["connect", "relay"]);
export type TicketPurpose = z.infer<typeof TicketPurpose>;

/** Where a socket redeeming a ticket of each purpose reached the host from, named for every purpose there is. The
 * host stamps this over whatever the client's own frames say, so a purpose that names none would be a socket whose
 * origin its holder decides: the door refuses one rather than falling back to the wire, and a purpose added later
 * has to say what it is here before any socket may redeem it. */
export const TICKET_ORIGIN: Record<TicketPurpose, WorkspaceOrigin> = { connect: "here", relay: "relayed" };

/** How a device this host admitted through the account got in: the computer it is on the relay, the key it proved
 * and the key that signed its admission. The public key is kept because a device admitted here may itself sign the
 * admission of the next one, and the fingerprint because a revoke is remembered by the key rather than by the id a
 * relay mints afresh at every sign-in. Nothing secret: a public key and two fingerprints. */
export const DeviceVia = z.object({
  kind: z.literal("account"),
  /** The id that device has on the relay, which is what a listing of the account's computers names it by. */
  relayDeviceId: z.string(),
  fingerprint: z.string(),
  publicKey: z.string(),
  /** The fingerprint of the key whose admission let it in. */
  admittedBy: z.string(),
});
export type DeviceVia = z.infer<typeof DeviceVia>;

/** A computer that redeemed a pairing code and holds a token of its own, as devices.list answers and wsp host devices
 * prints it. The token is never here: the host keeps only its hash, so a listing can leak nothing that opens a
 * socket. */
export const DeviceView = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** When this device last authed. Set by the redeem that minted it and moved by every later auth frame, never by
   * a JSON route reading the same token, so a listing says when the computer last dialled rather than last asked. */
  lastSeenAt: z.string(),
  /** What this device may do, when it is not a computer of the person's: a token the host minted into one turn's
   * environment, which drives only the tree that turn's thread is in. Absent is a paired computer, which drives
   * everything this host holds. */
  scope: ThreadScope.optional(),
  /** Set on the browser wsp init opened on the computer the host runs on: its code was minted by init itself, so
   * the device is read as the owner on the socket and the JSON routes alike, and is still listed and revoked like
   * every other. Absent is a computer or a browser that took a code from wsp host pair. */
  here: z.literal(true).optional(),
  /** How this device got in, where it did not redeem a pairing code: the account both computers are signed in to.
   * Absent is a code, so one record, one listing and one revoke answer for both roads. */
  via: DeviceVia.optional(),
});
export type DeviceView = z.infer<typeof DeviceView>;

/** How long a pairing code stands before the host forgets it: long enough to read off one screen and type into
 * another, short enough that a code left in a terminal buffer is worth nothing by the time anyone reads it. */
export const PAIR_CODE_TTL_MS = 10 * 60_000;

/** How many characters a pairing code is, out of the 32 the alphabet holds: 40 bits, single use and ten minutes
 * long, which no reachable host answers enough guesses of. */
export const PAIR_CODE_LENGTH = 8;

/** A pairing code as every screen shows it: the alphabet's letters in two halves, which is how a person reads one
 * across a room. The one grouping, so the sheet that shows a code and the field that takes one agree. */
export function shownPairCode(code: string): string {
  const letters = code.replace(/-/g, "").toUpperCase().slice(0, PAIR_CODE_LENGTH);
  const half = Math.ceil(PAIR_CODE_LENGTH / 2);
  return letters.length <= half ? letters : `${letters.slice(0, half)}-${letters.slice(half)}`;
}

/** A pairing code as the host takes it, whichever screen it was copied off: the letters alone, upper case. A
 * person copies the code they can read, so the dash the screens put in it is one this reading takes back out. */
export const sentPairCode = (shown: string): string => shown.replace(/-/g, "").toUpperCase();

/** The symbols a pairing code is written in: the digits and the letters, less the four that a person reading one
 * screen and typing into another confuses (I, L, O, U). Thirty-two of them, so each character is five bits and a
 * random byte masked to five bits is uniform. */
export const PAIR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Whether a code as the host takes it could be one a host is holding: the alphabet's characters at the length a code
 * is. What tells a code from a paste that caught a label, a space for the dash or a character too many. */
export const isPairCode = (code: string): boolean => code.length === PAIR_CODE_LENGTH && [...code].every(c => PAIR_CODE_ALPHABET.includes(c));

/** What a field that takes a pairing code says for a paste that is none, before any host is asked. */
export const PAIR_CODE_SHAPE_REFUSAL = `that is not a pairing code, which is ${PAIR_CODE_LENGTH} letters and digits like ABCD-EFGH; paste only the code wsp host pair printed`;

/** What this wsp knows about the account it is on, read off this computer's own records alone: the relay is never
 * asked for it, so the row draws at once and draws the same whether or not the relay is up. Signed in is a record
 * on disk; the name beside it is the one the relay gave when the sign-in was approved, which a relay that names
 * none leaves absent, and then the state word alone is the answer. */
export const AccountView = z.object({
  signedIn: z.boolean(),
  login: z.string().optional(),
});
export type AccountView = z.infer<typeof AccountView>;

/** The refusal a socket let in on a ticket gets for reading the account: who this wsp is signed in to is read at
 * the terminal of the computer it runs on, as the devices and the places are. */
export const ACCOUNT_TICKET_REFUSAL = "a socket let in on a ticket cannot see the account this host is signed in to; run wsp login on the computer the host runs on";

/** The relay wsp signs in to when a person names none: the one this project runs, opt in as every account road is,
 * and the only address the lines carry by default. Another relay is named on the line that signs in. */
export const DEFAULT_RELAY = "https://relay.singhi.me";

/** What one computer already on the account signs for another: the key it admits, its own key, and the moment.
 * The relay stores these bytes and can make none of them, since it holds no device's private key; every host
 * verifies the signature itself against the keys it already trusts. `issuedAt` travels and is stored as the
 * string it was signed with, byte for byte, since the transcript is built from that spelling. */
export const Admission = z.object({
  device: z.string(),
  by: z.string(),
  issuedAt: z.string(),
  signature: z.string(),
});
export type Admission = z.infer<typeof Admission>;

/** One computer on the account as a host reads it off its heartbeat's reply: which key it proves and which
 * admissions were signed for it. The signature rides along; the fingerprints alone would prove nothing. */
export const AccountDevice = z.object({
  id: z.string(),
  name: z.string(),
  fingerprint: z.string(),
  admissions: z.array(Admission.omit({ device: true })),
});
export type AccountDevice = z.infer<typeof AccountDevice>;

/** What the account's devices are as the last heartbeat listed them, and nothing when this host has heard no list
 * at all: an absent list is unknown and never empty, so a relay that is down, one that answers an older shape and
 * a beat that was refused admit nobody new and revoke nobody. */
export const AccountDevices = z.object({ devices: z.array(AccountDevice) });

/** What a device signs to prove it may come in through the account: the key admitted, the key that signed for it
 * and the moment, built by one function so the wsp that signs and the host that verifies cannot drift. The host
 * is not inside it: one admission stands at every host on the account whose trust the signer already has, which
 * is what saves a person a code per host. */
export function deviceAdmissionTranscript(device: string, by: string, issuedAt: string): Uint8Array {
  return new TextEncoder().encode(`wsp device admission v1\n${device}\n${by}\n${issuedAt}\n`);
}

/** The refusal a device.auth gets that this host will not admit: a key the account's listing does not hold, an
 * admission signed by nobody it trusts, or a signature that does not stand. One sentence for all of them, since a
 * caller that cannot come in learns nothing from which check caught it, and it names the road in: a computer
 * already on the account signs this one's key. */
export const DEVICE_AUTH_REFUSAL =
  "this host admits a computer on the account only on an admission signed by a key it already trusts; run wsp login to read this computer's id on a computer that is already in, then wsp login <id> there, and dial again";

/** The refusal a device this host revoked gets when it dials again through the account: the key is remembered, so
 * an admission it still holds admits it nowhere here. A code from the host's own terminal is the way back. */
export const DEVICE_REVOKED_REFUSAL = "this host took this computer's token away; it is admitted through the account no longer, and wsp host pair on the host is the way back in";

/** The refusal a device.auth gets from a host that is on no account: nothing there names the keys it would trust,
 * so pairing with a code is the whole road to it. */
export const DEVICE_ACCOUNT_UNSERVED = "this host is on no account, so it admits no computer through one; run wsp host link on the computer it runs on to put it on yours";

/** What a computer reads when the host it dialled answered device.auth with its own request schema's refusal: a
 * host of an older wsp, whose door knows no road in for a computer on the account. Told apart from a refusal of this build by
 * the kind on the frame, which an older host's schema refusal carries none of, so a token this computer never sent
 * is never read as one that was taken away. */
export const deviceAuthOldHostLine = (where: string): string =>
  `the host at ${where} runs an older wsp, whose door does not know how a computer on the account comes in; update wsp on that computer and run wsp up there again`;

/** The refusal wsp login gives a word that carries no key: every word wsp login prints carries the fingerprint of
 * the key being admitted, so a word without one was written by hand or cut in half, and nothing is posted. */
export const LOGIN_NO_KEY_REFUSAL = "that word names no key for the computer signing in, so nothing here could say which key it would be admitting; run wsp login there again and copy the whole word it prints";

/** The refusal for a host that keeps no records of its own to read an account from, which a bare runtime does not. */
export const ACCOUNT_UNSERVED = "this host keeps no account records; wsp up serves them";

/** The refusal a socket that is not the host's own gets for asking to mint a pairing code: a code lets a stranger
 * in, so only the process holding the host token, on this computer, may hand one out. */
export const PAIR_ISSUE_REFUSAL = "only a socket holding this host's own token may mint a pairing code; run wsp host pair on the computer the host runs on";

/** The refusal a redeemed code that this host is not holding gets: spent, expired, or never minted read the same,
 * so guessing tells a caller nothing about which. */
export const PAIR_CODE_REFUSAL = "that pairing code is not one this host is waiting for; run wsp host pair on the host for a fresh one";

/** The refusal a socket that was let in on a single-use ticket gets for reaching the device ops, whether the ticket
 * was the road a machine's requests arrive by or another client's. Who may drive this host is handed out at the
 * terminal of the computer it runs on, and read and taken away there or from a computer paired with it. */
export const DEVICES_TICKET_REFUSAL = "a socket let in on a ticket cannot see or change the devices paired with this host; run wsp host devices on the computer the host runs on";

/** The refusal the JSON routes answer with when a request carries no token this host takes: reaching the port,
 * the loopback one included, names nobody, since another login on the same computer reaches it too. */
export const API_UNAUTHORIZED = "this route needs a token in an Authorization header, the host's own from the token file beside its state or a paired device's; run wsp host pair on the computer the host runs on for one";

/** The refusal a write route and a browser's upgrade answer with when the page that sent them was loaded at
 * another name than the one this host was reached at. A page may only drive the host it was served by, and the
 * hostname is the whole of the reading: a page on the app's port dialling the runtime's is the same page. */
export function crossOriginRefusal(origin: string, host: string): string {
  return `this request came from ${origin} and this host was reached at ${host}; the page and its socket open from the address the host answers at`;
}

/** A frame the page sends a daemon through the host: the daemon's own op and params, no id. The host numbers
 * frames on its socket to the daemon and hands the daemon's answer back under the request that carried the frame,
 * so a page's ids never reach a machine. auth is refused: the host sent the auth frame when it opened the channel. */
export const DaemonFrame = z.object({ op: z.string().refine(op => op !== "auth", "the host authenticates the channel") }).passthrough();
export type DaemonFrame = z.infer<typeof DaemonFrame>;

export const DaemonOpenReply = z.object({ channel: z.string() });
export type DaemonOpenReply = z.infer<typeof DaemonOpenReply>;
/** The daemon's reply as it sent it; id is the host's number on its own socket and means nothing to the page. */
export const DaemonSendReply = z.object({ reply: DaemonResponse });
export type DaemonSendReply = z.infer<typeof DaemonSendReply>;

/** What the host pushes to the one socket that opened a channel. Never on the event bus, never sequenced, never
 * replayed: a pty chunk is not history. event is the daemon's frame untouched; the page validates it against
 * DaemonEvent as it always did, since a daemon of another version may push a type this host does not know and
 * the host acts on none of them. daemon.closed says the daemon socket ended without the page asking: code and
 * reason are the WebSocket close the host saw, 4401 with the daemon's sentence when it refused the token. */
export const DaemonChannelEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daemon.event"), channel: z.string(), event: z.object({ type: z.string() }).passthrough() }),
  z.object({ type: z.literal("daemon.closed"), channel: z.string(), code: z.number().int(), reason: z.string() }),
]);
export type DaemonChannelEvent = z.infer<typeof DaemonChannelEvent>;

// --- places: a computer you own, joined by dialling this host ---------------

/** How many bytes each side's challenge is. Thirty-two: a nonce is what keeps a signature from being replayed, and
 * a birthday collision on it has to be out of reach for the life of a key, not for the life of one link. */
export const PLACE_LINK_NONCE_BYTES = 32;

export const PlaceNonce = base64(PLACE_LINK_NONCE_BYTES);
/** An ed25519 public key as SPKI DER, base64: 44 bytes. */
export const PlacePublicKey = base64(44);
/** An ed25519 signature, base64: 64 bytes. */
export const PlaceSignature = base64(64);
/** An X25519 public key as its raw 32 bytes, base64: what each end of a link sends to agree the key every frame
 * after the handshake is sealed under. Fresh per attempt and never held past the socket. */
export const PlaceEphemeral = base64(32);

/** The engine a project's own containers would run on: Docker first, then podman, else none. The one rule both
 * the host's own-machine report and the node agent's read off their own PATH check. */
export type PlaceEngine = "none" | "docker" | "podman";
export const engineWord = (hasDocker: boolean, hasPodman: boolean): PlaceEngine => (hasDocker ? "docker" : hasPodman ? "podman" : "none");

/** How many agents one computer may report: the list and the version map keyed by it are held to one number, and
 * the daemon's own deserialiser holds them to the same one. */
const AGENTS_REPORTED_MAX = 32;

/** What a place says about itself on every link, and once at join. Read by the host into the place record and the
 * workspace recorded on it; nothing here is trusted for paths until isPlainPath has read it. */
export const PlaceReport = z.object({
  name: z.string().min(1).max(200),
  platform: z.enum(["darwin", "linux"]),
  arch: z.string().max(32),
  os: z.string().max(200),
  shape: WorkspaceSize,
  /** What is free on the volume a setup installs onto: wsp's install folder's, or the nearest folder above it that is there. */
  diskFreeBytes: z.number().int().nonnegative().optional(),
  /** The size of that same disk, off the same read: what a setup keeps free there is a share of it. */
  diskSizeBytes: z.number().int().nonnegative().optional(),
  /** Which Mac this is, as its registry names the product, else its model identifier; absent off a Mac. */
  model: z.string().max(200).optional(),
  /** HOME, USER, PATH and each harness's store variable, as the ssh read records them. */
  login: z.record(z.string()),
  /** Whether this computer's own daemon runs workspaces here: cgroup v2 with the controllers a cap needs, an
   * overlay, and root. What decides whether the place forks at all, where the docker field once did. */
  runsWorkspaces: z.boolean(),
  /** When it does not, the one kernel reason, in the daemon's own words. */
  workspacesBlocked: z.string().optional(),
  /** The engine a project's own containers would run on here; "none" until the person installs one. */
  engine: z.enum(["none", "docker", "podman"]),
  /** How this computer makes a workspace's copy of a checkout. Absent where the computer runs no workspaces. */
  copies: CopyWord.optional(),
  /** How long that computer had been up when it wrote this report. Kept on the record so a row can say what the
   * computer last was rather than nothing while it is not answering. */
  uptimeMs: z.number().int().nonnegative().optional(),
  daemonVersion: z.number().int().nonnegative(),
  /** The loopback port the place's own daemon bound, for the forward the panes ride. */
  daemonPort: z.number().int().min(1).max(65535).optional(),
  /** The line that runs wsp on this place, word by word, for the tools a turn's agent is given later. */
  wsp: z.array(z.string()).min(1),
  /** The catalog ids of the agents found on that computer's own login PATH, for the line the person reads as it
   * joins. Capped because it lands in a sentence, not in a list a person scrolls. */
  agents: z.array(z.string().max(32)).max(AGENTS_REPORTED_MAX),
  /** What each of those agents answered its own version flag with, by the same catalog id: the first line of
   * `<bin> --version`, as the computer said it. Absent on a computer whose agents have not been read yet. Under
   * the same cap as the list it is keyed by, since zod counts an object's keys nowhere else. */
  agentVersions: z
    .record(z.string().max(64))
    .refine(said => Object.keys(said).length <= AGENTS_REPORTED_MAX, `at most ${AGENTS_REPORTED_MAX} agents`)
    .optional(),
  /** The files under that computer's logins directory, each named under it: what a sign-in there wrote and every
   * workspace on it shares. Absent from a report a daemon older than this field sent, which is unknown and not
   * none; a name that walks out of that folder is refused, since the host joins it onto a folder of its own. */
  logins: z.array(z.string().max(200).refine(isUnderPath, "a name under a folder")).max(64).optional(),
  /** Which of the host's addresses this link reached; the address a turn on the place is told to dial back. */
  dialed: z.string().refine(isHttpUrl, "http or https URL"),
});
export type PlaceReport = z.infer<typeof PlaceReport>;

/** The first frame of a joining place: the key it will prove and the two public values that agree the seal.
 * Nothing of the person's rides it, since nothing has proved who is on the other end yet: the code it spends and
 * the report it carries go in the prove, inside the seal. Answered with PlaceJoinReply; the socket then continues
 * with place.prove as an auth would. */
export const PlaceJoinRequest = z.object({
  id: reqId,
  op: z.literal("place.join"),
  publicKey: PlacePublicKey,
  nonce: PlaceNonce,
  /** Absent from a computer running a wsp older than the seal, which the host refuses in its own sentence rather
   * than reading a frame it cannot answer. */
  ephemeral: PlaceEphemeral.optional(),
});
export type PlaceJoinRequest = z.infer<typeof PlaceJoinRequest>;
export const PlaceJoinReply = z.object({
  placeId: z.string(),
  hostPublicKey: PlacePublicKey,
  nonce: PlaceNonce,
  signature: PlaceSignature,
  ephemeral: PlaceEphemeral,
  /** What the primary computer calls itself, which is what the joined computer shows a person from then on. */
  hostName: z.string().min(1).max(200),
});
export type PlaceJoinReply = z.infer<typeof PlaceJoinReply>;

/** The token a join's own window was given, on the reply to its prove: the one thing of the person's a join
 * takes back, and it rides inside the seal now that the reply to frame one no longer carries it. */
export const PlaceJoinDevice = z.object({ deviceId: z.string(), deviceToken: z.string().min(1) });
export type PlaceJoinDevice = z.infer<typeof PlaceJoinDevice>;

/** The first frame of a place that already joined: names itself and challenges the host. */
export const PlaceAuthRequest = z.object({ id: reqId, op: z.literal("place.auth"), placeId: z.string().max(64), nonce: PlaceNonce, ephemeral: PlaceEphemeral.optional() });
export type PlaceAuthRequest = z.infer<typeof PlaceAuthRequest>;
export const PlaceAuthReply = z.object({ nonce: PlaceNonce, hostPublicKey: PlacePublicKey, signature: PlaceSignature, ephemeral: PlaceEphemeral });
export type PlaceAuthReply = z.infer<typeof PlaceAuthReply>;

/** What a host puts on its refusal of that frame when it holds no place by the id it named: its own key and a
 * signature over the refusal transcript. A place verifies it against the key it pinned at join and takes the long
 * wait on it, since nothing changes until a person acts; a refusal carrying neither, or one the pinned key did not
 * make, is a frame anybody who answers at the address can send and costs that computer no wait of its own. */
export const PlaceAuthRefusal = z.object({ hostPublicKey: PlacePublicKey, signature: PlaceSignature });
export type PlaceAuthRefusal = z.infer<typeof PlaceAuthRefusal>;

/** The second frame, and the first one sealed: the place's answer to the host's nonce and its report as it stands
 * now. A join's prove carries the code it spends and the window it wants too, which is where they cross now that
 * the host has proved itself and nothing of the person's may travel before it. After this the socket is the place
 * link and carries daemon frames only. */
export const PlaceProveRequest = z.object({
  id: reqId,
  op: z.literal("place.prove"),
  signature: PlaceSignature,
  report: PlaceReport,
  /** A join's own: the code this computer spends, and the window it also wants a token for. Absent on a relink,
   * which spends nothing, and on a join typed in a terminal, which wants no window. */
  code: z.string().max(64).optional(),
  client: z.object({ name: z.string().min(1).max(200) }).optional(),
});
export type PlaceProveRequest = z.infer<typeof PlaceProveRequest>;

/** What both sides sign, built by one function so they cannot drift: the role of the signer, the place id, the two
 * nonces and the two ephemerals, the challenged party's first in each pair. The host signs the transcript the
 * place challenged it with and the place signs the host's, so neither side's signature can be replayed back at it
 * as the other's; the ephemerals are inside it, so the key the two ends agree is one both signatures cover and a
 * carrier that swapped either of them has signed nothing. */
export function placeLinkTranscript(role: "host" | "place", placeId: string, challenge: string, answer: string, ephemerals: { challenger: string; answerer: string }): Uint8Array {
  return new TextEncoder().encode(`wsp place link v2\n${role}\n${placeId}\n${challenge}\n${answer}\n${ephemerals.challenger}\n${ephemerals.answerer}\n`);
}

/** What a host signs to refuse a place at its first frame, built by one function so the two sides cannot drift:
 * the place id it named, the nonce it challenged with and the sentence it is refused by. The nonce is inside, so
 * one dial's refusal cannot be replayed at the next; the sentence is inside, so it cannot be bent to another. */
export function placeRefusalTranscript(placeId: string, placeNonce: string, sentence: string): Uint8Array {
  return new TextEncoder().encode(`wsp place refusal v1\n${placeId}\n${placeNonce}\n${sentence}\n`);
}

/** What stands where a place id stands for a client's seal: a client is no place and holds no record here, so the
 * word is the same on both ends and rides the transcript and the key derivation exactly as a place id does. */
export const SEAL_CLIENT = "client";

/** The first frame of a client that holds the fingerprint of this host's key: its nonce and its half of the key
 * agreement, before the code or the token it came to send. Answered with SealOpenReply, after which every frame
 * this socket carries either way is sealed under the key both ends agreed. */
export const SealOpenRequest = z.object({ id: reqId, op: z.literal("seal.open"), nonce: PlaceNonce, ephemeral: PlaceEphemeral });
export type SealOpenRequest = z.infer<typeof SealOpenRequest>;

/** The host's answer: the key it proves, its nonce, its half of the agreement and its signature over the same
 * transcript a place challenges it with, the client's word in the place id's slot. The client refuses before it
 * sends anything of the person's unless the fingerprint is the one it pinned and the signature stands. */
export const SealOpenReply = z.object({ nonce: PlaceNonce, hostPublicKey: PlacePublicKey, signature: PlaceSignature, ephemeral: PlaceEphemeral });
export type SealOpenReply = z.infer<typeof SealOpenReply>;

/** The first frame of a computer coming in through the account, inside the seal the frame above agreed: the key it
 * proves, what to call it in the listing, and its signature over the bytes the host challenged it with, which are
 * the same bytes a joined computer signs at place.prove. Answered with `{ deviceId, deviceToken }`, as a redeem is,
 * and the socket is that device from then on. */
export const DeviceAuthRequest = z.object({
  id: reqId,
  op: z.literal("device.auth"),
  publicKey: PlacePublicKey,
  name: z.string().min(1).max(200),
  signature: PlaceSignature,
});
export type DeviceAuthRequest = z.infer<typeof DeviceAuthRequest>;

/** The refusal a client gets from a host that holds no key of its own to prove: a runtime served without the
 * place wiring, which is a runtime in a test rather than any host a person starts. */
export const SEAL_UNSERVED = "this host holds no key to prove itself with; the host that serves the app wires one";

/** What separates the two halves of the one token a join line carries. Neither half can hold it: a code is
 * written in PAIR_CODE_ALPHABET with the dash the screens group it with, and a fingerprint is base64. */
export const JOIN_TOKEN_MARK = ".";

/** The one word a person copies off a join line: the single-use code and the fingerprint of the key the host will
 * prove, as one string, so a join stays two things to copy and the screens keep the fields they have. */
export const joinToken = (code: string, hostKey: string): string => `${shownPairCode(code)}${JOIN_TOKEN_MARK}${hostKey}`;

/** The same token read back on the computer being joined, whichever road it came by: a person's paste, the flag,
 * or the file an install over ssh landed. The code is taken as any screen's code is taken; the fingerprint is left
 * exactly as it was written, since its own alphabet is case sensitive. A token that carries no fingerprint answers
 * none, and the caller refuses rather than dialling. */
export function readJoinToken(typed: string): { code: string; hostKey?: string } {
  const trimmed = typed.trim();
  const at = trimmed.indexOf(JOIN_TOKEN_MARK);
  if (at === -1) return { code: sentPairCode(trimmed) };
  const hostKey = trimmed.slice(at + 1).trim();
  const code = sentPairCode(trimmed.slice(0, at));
  return hostKey === "" ? { code } : { code, hostKey };
}

/** The refusal a join gets for a line that named no key: every line wsp add prints carries one, so a line without
 * one was written by hand or cut in half on its way over. Nothing is dialled. */
export const JOIN_NO_KEY_REFUSAL = "that join line names no key for the host, so this computer cannot tell which host it is joining; run wsp add on the host again and copy the whole code it prints";

/** The refusal a join gets when the host at that address proved a key that is not the one the join line named:
 * something answered where the host was expected. Nothing of this computer's went to it. */
export const joinKeyRefusal = (url: string): string => `the host at ${url} proved a key the join line did not name, so it is not the host that printed that line; nothing was sent to it`;

/** The one word a person copies off wsp host pair, which is the join line's token under the name the pairing road
 * reads it by: the code and the fingerprint of the key the host will prove, so a client pins that key before it
 * spends the code. `readJoinToken` reads both roads' tokens, since they are one shape. */
export const pairToken = joinToken;

/** The refusal a dial gets when whatever answered at that address did not prove the key this computer holds that
 * host to, whether it proved another one or signed nothing this computer could verify: it is not that host,
 * whichever check caught it, and no token of this computer's went to it. */
export const pairKeyRefusal = (url: string): string => `the host at ${url} did not prove the key this computer holds for it, so it is not that host; nothing was sent to it`;

/** The refusal a line gets for aiming at a host it holds no key for: a record somebody edited by hand, or a turn
 * launched by a host older than this one. `where` names which. */
export const hostNoKeyLine = (where: string): string =>
  `${where} names a host and no key for it, so this computer cannot tell which host it would be sending its token to; run wsp hosts to read the account's hosts again`;

/** What `hostNoKeyLine` names when the aim came out of the environment a turn was launched with rather than out of
 * a record a person named. */
export const LAUNCHED_WITH = "the launch this turn started with";

/** The refusal a join whose code this host is not holding gets. Spent, expired and never minted read the same, so
 * guessing tells a caller nothing about which; the words differ from a pairing code's only in naming the verb that
 * mints this one, since a person joining a computer never typed wsp host pair. */
export const PLACE_CODE_REFUSAL = "that join code is not one this host is waiting for; run wsp add on the host for a fresh one";

/** The refusal for a word two computers on this host answer to: ids tell them apart, and the person picks one.
 * `typed` is the word that was written, since more than one word names a computer and each says its own back. A
 * relink cannot take another computer's name, so two by one name are two a person joined under one word, and
 * every road that resolves a word reads this one sentence. */
export const twoPlacesRefusal = (typed: string, ids: readonly string[]): string =>
  `${typed}: this host holds ${ids.length} places by that name; name one by its id (${ids.join(", ")}).`;

/** The refusal a join from a computer whose wsp seals no link gets: every frame of a link after the handshake
 * travels inside a key the two ends agree, and a computer that cannot agree one would send its code and its
 * report where the carrier reads them. */
export const PLACE_UNSEALED_JOIN_REFUSAL = "that computer's wsp is older than this host and seals no link; update wsp there and join again";

/** The refusal a place gets for proving itself with a key the host does not hold for it. A key that moved is a
 * computer re-joined somewhere else or a place file copied off it, and neither is this place. */
export const PLACE_KEY_REFUSAL = "that place's key does not match the one this host learned at join; wsp remove it here and join it again";

/** The refusal a place that names an id this host holds none of gets: removed here, or a state file that is not
 * the one it joined. */
export const PLACE_UNKNOWN_REFUSAL = "this host holds no place by that id; join it with a code from wsp add";

/** The refusal a joining computer prints when the host at that address could not prove the key this computer
 * learned at join, so nothing of this computer's went to it. */
export const hostKeyRefusal = (url: string): string => `the host at ${url} did not prove the key this computer learned at join; nothing was sent to it`;

/** What a remove says about a place that was not linked when it ran: the records here are gone and the agent on
 * that computer is not, since nothing could reach it to sweep. */
export const placeStillInstalledLine = (name: string): string => `${name} is off this host, but the agent on it is still installed; run ${PLACE_LEAVE_LINE} on that computer when it is back`;

/** What a remove took off that computer by its agent's own command: a plugin the setup put on there. */
export const pluginOffLine = (name: string): string => `plugin ${name}`;

/** What a remove says of the plugins the setup put on that computer and could not take off: they stay there. */
export const pluginsKeptLine = (name: string, plugins: readonly string[]): string =>
  `${plugins.join(", ")} ${plugins.length === 1 ? "is" : "are"} still on ${name}: wsp could not take ${plugins.length === 1 ? "it" : "them"} off`;

/** What a remove took off this host's list with that computer: a project the recipe's folders step made there. The
 * checkout on that computer is the person's and stays. */
export const projectLeftLine = (name: string): string => `project ${name}, its folder there left as it is`;

/** What a place that is connected but has never said which port its daemon bound is refused with: a pane needs
 * that port to carry to, and only that computer knows it. */
export const placeNoDaemonPortLine = (name: string): string => `${name} is connected but has not said which port its daemon is on, so nothing can carry a pane to it yet; it says so on its next link`;

/** What an install is refused with when the computer took the agent and never dialled back: the join landed, so
 * the computer belongs to this wsp, and what is missing is a road from it to here. */
export const placeNoLinkLine = (name: string): string => `${name} took the agent and has not dialled this host yet; check that it can reach this computer on the address it was given, and wsp places shows it the moment it does`;

/** What a stage reads while the computer it is running on has no link: the requests behind it are held until that
 * computer opens a socket again, and a stage with no line of its own reads as one that stopped. */
export const placeDialBackLine = (name: string): string => `waiting for ${name} to dial back`;

/** Why a build on a joined computer stopped when that computer's link went and it never dialled back in time. */
export const placeWentAwayLine = (name: string): string => `${name} went away before the build finished`;

/** The refusal wsp add over ssh gets on a host that wired no installer: the road that puts the agent on a computer
 * is the host command's, so a runtime served without one holds no way onto a machine it has never met. */
export const NO_PLACE_INSTALLER = "this host cannot install the agent on a computer over ssh; run wsp add with no argument for the line to type on that computer";

/** The refusal a socket that was let in on a single-use ticket gets for reaching the place ops: which computers a
 * person's wsp runs on, and taking one back out, is handed out and taken away at the terminal of the computer the
 * host runs on and nowhere else. */
export const PLACES_TICKET_REFUSAL = "a socket let in on a ticket cannot see or change the places this host holds; run wsp places on the computer the host runs on";

/** The refusal for a daemon channel that named both a workspace and a computer, or neither: a channel is one
 * daemon's, and which one is the caller's to say. */
export const DAEMON_OPEN_ONE_OF = "daemon.open opens a channel to one daemon: name the workspace or the place, not both";

/** Where a computer you own dials this wsp: the port the door answers on and every address it can be reached at.
 * A host that already binds beyond this computer answers its own port and opens nothing. */
export const PlaceDoorView = z.object({
  port: z.number().int().min(1).max(65535),
  /** `http://<address>:<port>` for every address this computer answers on that leaves it, loopback left out. */
  addresses: z.array(z.string().url()).min(1),
  /** The fingerprint of the key this host proves at a join, for the token the join line carries: what tells the
   * computer being joined that the host answering at one of those addresses is the one that printed the line. */
  hostKey: z.string().min(1).max(200),
  /** The relay hostname as an https address, when the host is linked to a relay. */
  relay: z.string().url().optional(),
});
export type PlaceDoorView = z.infer<typeof PlaceDoorView>;

/** One line a computer you own joins this host by, as joinRoads writes it: the address it dials, the whole command
 * typed there, and the note for the relay's address, which answers only while the host is linked. */
export const JoinRoad = z.object({ url: z.string().url(), line: z.string().min(1), note: z.string().optional() });
export type JoinRoad = z.infer<typeof JoinRoad>;

/** What places.mint answers: a fresh code, written into every line this host can be joined by, and when it stops
 * working. The code is the one wsp add prints, off the same mint and the same expiry. */
export const JoinMint = z.object({ joins: z.array(JoinRoad).min(1), expiresAt: z.string().datetime() });
export type JoinMint = z.infer<typeof JoinMint>;

/** A computer the person's own ssh already knows, offered where a computer is added over ssh: a Host block of their
 * ssh config, or a name their known_hosts holds. Only host, hostname, user and port words are taken from what those
 * files name, so a key file an Include reaches yields nothing. */
export const SshHostSuggestion = z.object({
  alias: z.string().min(1).max(300),
  hostName: z.string().max(300).optional(),
  user: z.string().max(300).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  from: z.enum(["config", "known_hosts"]),
});
export type SshHostSuggestion = z.infer<typeof SshHostSuggestion>;

/** The git hosts a person's ssh knows for pushing, never a computer to add: hidden from the ssh hosts offered, with
 * every subdomain of each. */
export const GIT_FORGE_HOSTS: readonly string[] = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "sr.ht", "ssh.dev.azure.com", "vs-ssh.visualstudio.com"];

/** A url's host as a name: lowercase, without its port or a trailing root dot. */
export const bareHost = (host: string): string => host.replace(/:\d*$/, "").toLowerCase().replace(/\.$/, "");

/** Whether a host is the domain or a host under it, in any case, with a port or a root dot or neither. */
export function hostUnder(host: string, domain: string): boolean {
  const name = bareHost(host);
  return name === domain || name.endsWith(`.${domain}`);
}

/** Whether a host name is one of GIT_FORGE_HOSTS or under one. */
export function isGitForge(host: string): boolean {
  return GIT_FORGE_HOSTS.some(forge => hostUnder(host, forge));
}

/** The refusal a socket that is not the host's own gets for minting a join code: the code lets a computer in, so
 * only this computer's own window may ask, as wsp add on its terminal does. */
export const MINT_JOIN_REFUSAL = "only a socket holding this host's own token may mint a join code; run wsp add on the computer the host runs on";

/** The refusal for reading the person's ssh hosts on any socket but this computer's own window: which computers
 * they reach is theirs, and a paired device, a relayed socket or a thread learns none of it. */
export const SSH_HOSTS_REFUSAL = "only a socket holding this host's own token may read the ssh hosts on this computer; open wsp on the computer the host runs on";

/** The refusal a socket let in on a ticket gets for opening the door computers you own dial: the same rule the
 * device and place ops read, since the door is who may reach this wsp. */
export const PLACE_DOOR_REFUSAL = "a socket let in on a ticket cannot open the door computers you own dial; run wsp add on the computer the host runs on";

/** The refusal for a host that serves no such door at all: wsp up serves one, a bare runtime does not. */
export const PLACE_DOOR_UNSERVED = "this host opens no door for computers you own; wsp up serves one";

/** A refusal in two halves: what happened, which the app draws in the destructive ink, and what to do about it,
 * which it draws in the foreground ink. One shape, so every screen that refuses reads the same way. */
export const TwoPartRefusal = z.object({ what: z.string(), fix: z.string() });
export type TwoPartRefusal = z.infer<typeof TwoPartRefusal>;

export const JOIN_ADDRESS_LINE: TwoPartRefusal = {
  what: "That is not an address.",
  fix: `Type it as the other screen shows it, like 192.168.1.20:${DEFAULT_PLACE_PORT}.`,
};

/** How long the code on the Add a computer sheet is good for, said in the words beside it. */
export const CODE_GOOD_LINE = "the code is good for 10 minutes";
export const CODE_EXPIRED_LINE = "the code expired; press New code";

/** What the sheet says when somebody else already holds the door's port: a fixed port, since the place file on the
 * other computer names it for good, so a fallback port would be a computer that can never dial back. */
export const doorPortHeldLine = (port: number): string =>
  `port ${port} is held by another program on this computer, so no computer you own can reach this wsp; free it and open Add a computer again`;

/** What a computer joined as a place keeps about the wsp it belongs to, in the file the join writes and the agent
 * reads on every attempt: the id its host knows it by, the addresses to dial in order, the host's public key pinned
 * at that join, and where its own private key is. The shape and the two readings of it live here because the join
 * writes it on one side of the wire and the agent reads it on the other. */
export interface PlaceFile {
  placeId: string;
  name: string;
  /** What the wsp this computer joined calls itself, learned at the join: the one word the joined computer shows. */
  hostName: string;
  /** LAN address first, the host's tunnel hostname after it; dialled in this order on every attempt. */
  hostUrls: string[];
  hostPublicKey: string;
  keyPath: string;
  joinedAt: string;
}

/** The mode the place file and the private key beside it are kept at: the person's own and nobody else's. A key any
 * account on that computer could read is a key that joins their wsp for them. */
export const PLACE_FILE_MODE = 0o600;

/** The place file a text holds, or nothing when that text is not one. A file that is there and is not one reads the
 * same as none: the one road that writes it is wsp join, and anything else there is not a place to dial with. */
export function parsePlaceFile(text: string): PlaceFile | undefined {
  let held: unknown;
  try {
    held = JSON.parse(text);
  } catch {
    return undefined;
  }
  const f = held as PlaceFile | undefined;
  const ok =
    typeof f === "object" &&
    f !== null &&
    typeof f.placeId === "string" &&
    typeof f.name === "string" &&
    typeof f.hostName === "string" &&
    Array.isArray(f.hostUrls) &&
    f.hostUrls.every(u => typeof u === "string") &&
    typeof f.hostPublicKey === "string" &&
    typeof f.keyPath === "string";
  return ok ? f : undefined;
}

/** The text the file holds, which parsePlaceFile reads back. */
export const placeFileText = (file: PlaceFile): string => `${JSON.stringify(file, null, 2)}\n`;

/** The refusal a second join on one computer gets: a place file is the one wsp this computer belongs to. */
export const ALREADY_JOINED_LINE = `this computer is already a place in a wsp; ${PLACE_LEAVE_LINE} first`;

/** Each slate op as a request of this table: the envelope's id and op beside the params wire.ts declares. */
function slateOps() {
  const op = <N extends keyof typeof SLATE_OPS>(name: N) => z.object({ id: reqId, op: z.literal(name) }).extend(SLATE_OPS[name].shape as (typeof SLATE_OPS)[N]["shape"]);
  return [
    op("slates.get"),
    op("slates.write"),
    op("slates.state"),
    op("slates.read"),
    op("slates.catalog"),
    op("slates.event"),
    op("slates.approve"),
    op("slates.cancel"),
    op("slates.revoke"),
    op("slates.shown"),
    op("slates.subscribe"),
    op("slates.unsubscribe"),
    op("slates.resolve"),
  ] as const;
}

const RuntimeOp = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("auth"), token: z.string() }),
  z.object({ id: reqId, op: z.literal("ticket.issue"), purpose: TicketPurpose }),
  /** Mints a one time code another computer redeems for a device token of its own. Answers `{ code, expiresAt }`.
   * Only on a socket holding the host's own token, and never on one let in by a ticket. `here` marks the code wsp
   * init mints for the browser it opens on this computer, whose device is then read as the owner. */
  z.object({ id: reqId, op: z.literal("pair.issue"), here: z.literal(true).optional() }),
  /** Spends a code for this computer's own token, as the first frame of a socket nothing has authed. Answers
   * `{ deviceId, deviceToken }` once, and the socket is authed as that device from then on. */
  z.object({ id: reqId, op: z.literal("pair.redeem"), code: z.string().max(64), name: z.string().max(200) }),
  /** Agrees the key this socket is sealed under, as its first frame and before the code or the token it came to
   * send. Answered with a SealOpenReply; it is a door frame read before auth, as a redeem is, and no token names
   * anybody who may send it. */
  SealOpenRequest,
  /** The other first frame a computer with no code sends, inside the seal: it proves a key the account admitted
   * rather than spending a code. A door frame read before auth, as a redeem is. */
  DeviceAuthRequest,
  /** What this wsp knows about the account it is signed in to, off this computer's own records. Answers
   * `{ account }`. Only on the person's own road, never on one let in by a ticket. */
  z.object({ id: reqId, op: z.literal("account.get") }),
  /** Every paired device, for the host token and for a device's own socket alike. */
  z.object({ id: reqId, op: z.literal("devices.list") }),
  /** Takes a device's token away and cuts the sockets holding it, for the host token and for a paired device's
   * own socket alike, whichever device is named. */
  z.object({ id: reqId, op: z.literal("devices.revoke"), deviceId: z.string() }),
  /** The first frame of a computer joining as a place: spends a join code for a record holding its key. Answered
   * with a PlaceJoinReply, and the socket then sends place.prove as an authed one would. */
  PlaceJoinRequest,
  /** The first frame of a place that already joined, answered with a PlaceAuthReply. */
  PlaceAuthRequest,
  /** The second frame of either road: once it verifies, this socket stops being a client's and is the place link. */
  PlaceProveRequest,
  /** Every place this host holds: this computer, the computers joined to it, and the provider it forks on, beside
   * every add over ssh still running and the last that finished. Answers `{ places: PlaceView[], adds: PlaceAddJob[] }`. */
  z.object({ id: reqId, op: z.literal("places.list") }),
  /** Puts the daemon this host deploys on one place where it is behind, over the link it holds or over the ssh road
   * the install used, and waits for that computer to dial back running it. The workspaces on it and what it was set
   * up with are kept. Answers a PlaceUpdateReply. */
  z.object({ id: reqId, op: z.literal("places.update"), placeId: z.string(), sudoPassword: SudoPassword.optional() }),
  /** Takes a place back out: sweeps wsp off that computer over its link, drops the workspaces standing on it and
   * the place record. Answers `{ removed, swept, note? }`. */
  z.object({ id: reqId, op: z.literal("places.remove"), placeId: z.string(), sudoPassword: SudoPassword.optional() }),
  /** Runs the doctor's computer road here, for a computer this host holds the link to: the six steps against that
   * link, and every line of them pushed as a doctor.line event under `doctorId` to the sockets subscribed to
   * events. The id is the caller's own, minted before the request, since the first line is said before the reply
   * lands. Answers `{ code }` once the road printed its last line. The person's own road only, as every other
   * place op is. */
  z.object({ id: reqId, op: z.literal("places.doctor"), placeId: z.string(), doctorId: z.string().max(64), project: z.string().max(200).optional() }),
  /** Dials one computer once, now: a frame over the link it holds, or a login over the road it was added on when
   * it holds none. Answers a PlaceDial: what came back, the sentence to say it in, and the row with the answer
   * written on it, so a window opened later reads the same thing. Nothing is installed and nothing is left
   * running either way. */
  z.object({ id: reqId, op: z.literal("places.dial"), placeId: z.string() }),
  /** Sets what a person may set on one place: threads at once on a computer, machines at once and spend per day on
   * a cloud, the nap after on any place that forks, and the agents switch its workspaces inherit. A key left out
   * keeps what stands, a word under `reset` takes that setting back to its default, and a key the place's kind does
   * not take is refused. Answers `{ place: PlaceView }`, the row as it now reads. The person's own road only, as
   * every other place op is. */
  z.object({ id: reqId, op: z.literal("places.set"), placeId: z.string(), reset: z.array(PlaceSettingWord).optional() }).merge(PlaceSettingsAsk),
  /** The saved recipe one computer follows from now, by its name or slug, or `none`: one it follows syncs to it, and
   * one that follows none keeps what it has. Answers `{ place: PlaceView }`. The person's own road only. */
  z.object({ id: reqId, op: z.literal("places.follow"), placeId: z.string(), recipe: z.string().min(1).max(200) }),
  /** Skip for now on one row of a computer's setup: a sign-in that waits stops and the row reads skipped, and a row
   * that failed is set aside the same way; Settings finishes either later. Answers `{ place: PlaceView }`. */
  z.object({ id: reqId, op: z.literal("places.skip"), placeId: z.string(), row: z.string().min(1).max(300) }),
  /** The end of a computer's setup log, read off that computer: its last SETUP_LOG_TAIL_BYTES, a step's own lines
   * where one is named. Answers `{ lines: string[] }`. */
  z.object({ id: reqId, op: z.literal("places.setupLog"), placeId: z.string(), step: PlaceSetupStep.optional() }),
  /** What some picks weigh against a computer's room before Set up: `ref` a computer or a pending add, as setup takes
   * it. Answers `{ estimate: PlaceEstimate }`. */
  z.object({ id: reqId, op: z.literal("places.estimate"), ref: z.string().max(200), choices: z.lazy(() => RecipeFile) }),
  /** A sign-in run at a terminal on one computer landed, as the tool's own status there said: the host notes the
   * file that agent's shared login writes, as the app's own sign-in does, so the listing says signed in before
   * that computer next reports. Answers `{}`. The person's own road only, as every other place op is. */
  z.object({ id: reqId, op: z.literal("places.loginLanded"), placeId: z.string(), agent: z.string() }),
  /** Opens the door computers you own dial, when this host binds loopback alone, and answers where it is; a host
   * already bound beyond loopback answers its own port and opens nothing. Answers a PlaceDoorView. The person's
   * own road only, as every other place op is. */
  z.object({ id: reqId, op: z.literal("places.door") }),
  /** Mints a join code and answers a JoinMint: every line a computer you own can join this host by, off the door's
   * addresses and the relay's, and when the code expires. The code lets a stranger in, so only a socket holding the
   * host's own token may ask, as for pair.issue. */
  z.object({ id: reqId, op: z.literal("places.mint") }),
  /** Answers `{ hosts: SshHostSuggestion[] }`: the ssh config's hosts first, then known_hosts, less the computers
   * already added over ssh. Only a socket holding the host's own token may ask. */
  z.object({ id: reqId, op: z.literal("places.sshHosts") }),
  /** Puts the agent on a Linux computer over ssh and joins it, `address` naming it as user@host or as an alias
   * from the person's ssh config, which is dialled through that block: the host logs in as the person's own ssh would,
   * installs node and wsp there, starts the agent under that login's own service manager and waits for it to dial
   * back. Answers `{ addId, place: PlaceView }` once it has dialled; the steps ride place.stage events carrying the
   * same addId. */
  z.object({
    id: reqId,
    op: z.literal("places.add"),
    /** The stream the steps of this install ride, minted by whoever asked: the steps start before the reply names
     * the place, so a caller that wants to draw them has to know which are its own before it asks. */
    addId: z.string().max(64).optional(),
    address: z.string().max(200),
    name: z.string().max(200).optional(),
    sshPort: z.number().int().min(1).max(65535).optional(),
    keyPath: z.string().max(1024).optional(),
    /** The host key the person confirmed or pinned for a computer this one has never dialled. The install refuses
     * before a byte of wsp's leaves this computer where it is absent and the client holds no key of its own, so a
     * caller that sends none meets the same wall as one that sends a wrong one. */
    hostKey: z.string().max(200).optional(),
    /** The password the login's sudo asks for, typed by the person for this add alone: fed to sudo over the ssh
     * connection's input, never written down, never logged and gone when the add ends. One line, as sudo reads it. */
    sudoPassword: SudoPassword.optional(),
    /** The saved recipe the computer is set up from once it joins, by its name or slug. Absent, it joins and waits
     * as a pending add for the person's picks, with the base tools going on meanwhile. */
    recipe: z.string().max(200).optional(),
  }),
  /** Sets a computer up from picks: a pending add that joined and waits on its choices, or a computer already set
   * up, run again for whatever is missing. `ref` names the computer or the pending add; `recipe` names the saved
   * recipe to set it up from, `choices` the picks themselves, else the choices it holds. Answers `{ addId, place: PlaceView, setup?, said? }`; the
   * frames ride place.setup events carrying `addId`. */
  z.object({ id: reqId, op: z.literal("places.setup"), ref: z.string().max(200), recipe: z.string().max(200).optional(), choices: z.lazy(() => RecipeFile).optional(), addId: z.string().max(64).optional() }),
  /** Keeps the person's picks so far on a pending add, and the saved recipe they started from, so the add resumes
   * where it was left. Answers `{ pending: PendingComputer }`. Refused for a ref no pending add answers to. */
  z.object({ id: reqId, op: z.literal("places.choose"), ref: z.string().max(200), choices: z.lazy(() => RecipeFile), recipe: z.string().max(200).optional() }),
  /** Every recipe this host keeps, each with the line of what it holds and the computers that follow it. Answers
   * `{ recipes: RecipeView[] }`. The person's own road only, as every place op is. */
  z.object({ id: reqId, op: z.literal("recipes.list") }),
  /** One recipe by its name or slug, with the hash it resolves to on this computer now. Answers `{ recipe:
   * RecipeView, hash }`. */
  z.object({ id: reqId, op: z.literal("recipes.get"), name: z.string().max(200) }),
  /** Writes a recipe whole: `file` as given, or with `from` a computer's own picks under `name`, after which that
   * computer follows it. Refused for a name that makes no file name and for anything shaped like a secret. Answers
   * `{ recipe: RecipeView }`. */
  z.object({ id: reqId, op: z.literal("recipes.save"), name: z.string().max(200), file: z.unknown().optional(), from: z.string().max(200).optional() }),
  /** Takes a recipe's file away; the computers that followed it follow none. Answers `{ recipe: RecipeView }` as it
   * stood. */
  z.object({ id: reqId, op: z.literal("recipes.remove"), name: z.string().max(200) }),
  /** What a recipe can pick from on this computer, read now. Answers `{ options: RecipeOptions }`. */
  z.object({ id: reqId, op: z.literal("recipes.options") }),
  /** Replies with an EventsSubscribeReply, then pushes events on this socket. With `after`, the seq of the last event
   * this client saw, every retained event past it is pushed first, oldest first, before anything live; `stream` is
   * the id that came with that seq, so a runtime that is not the one that issued it answers gap instead. */
  z.object({
    id: reqId,
    op: z.literal("events.subscribe"),
    after: z.number().int().nonnegative().optional(),
    stream: z.string().optional(),
    /** Also sends, after the replay, the last workspace.creating frame of every create the host is making and of
     * every refused one it still holds: a window that connected after a create began hears of it, and a create it
     * hears nothing of is one this host is not making. */
    creates: z.boolean().optional(),
  }),
  /** Replies with a WorkspaceStatus[] snapshot and keeps the runtime's status
   * poller + cost ticker running while this socket lives; the events ride the
   * events.subscribe channel. */
  z.object({ id: reqId, op: z.literal("status.subscribe") }),
  /** Replies with a WorkspaceListing[] snapshot and keeps nothing running: the one shot a command line or a tool
   * takes to read a state, since a WorkspaceView carries neither the provider's word for the machine nor the daemon
   * reach and the state word turns on both. The listing is the status without the minted route, which only the app's
   * own socket needs, and the snapshot costs one reach probe per machine and no exec probe. */
  z.object({ id: reqId, op: z.literal("status.list") }),
  z.object({
    id: reqId,
    op: z.literal("workspaces.create"),
    /** A project image by snapshot id; absent takes the head of the project's computer's own image. A create a
     * thread asked for names none and is refused where it does: it takes the image its own workspace's project
     * runs, which is the only image a thread reaches. */
    golden: z.string().optional(),
    /** The project this workspace is made for, by id or by name. Its computer is where the workspace lands. */
    project: z.string(),
    name: z.string(),
    cpu: z.number().optional(),
    memMb: z.number().optional(),
    envs: z.record(z.string()).optional(),
    labels: z.record(z.string()).optional(),
    /** What the agents on the new workspace may ask of this host; absent, or a key left out, takes the default. */
    agents: WorkspaceAgents.partial().optional(),
    /** Auto-nap window for this workspace; absent takes the runtime default (20 min), null turns it off. */
    idleWindowMs: z.number().nullable().optional(),
    /** The workspace this one is forked out of, by id: a child of it, holding the same project and starting on the
     * branch that workspace is on right now where the remote has that branch. A workspace of another project is
     * refused, since a child starts on its parent's branch. A create a thread asked for is a child of the thread's
     * own workspace whether or not this names one, and a workspace it names here is not read. */
    parent: z.string().optional(),
    /** The workspace gets the place's container engine through the fenced socket; absent takes the image's recipe. */
    engine: z.boolean().optional(),
  }),
  /** Where a workspace of this project would land and what that computer offers. Replies with
   * { place?, name, capabilities }, `place` absent where the landing is the provider this host forks on. Refused
   * before any machine is asked for where that computer forks nothing: with NO_PROVIDER_LINE when no place here runs
   * workspaces, else naming the places that do. The one gate a create runs, read ahead so the refusal comes in one
   * sentence before any stage is streamed. */
  z.object({ id: reqId, op: z.literal("workspaces.landing"), project: z.string() }),
  /** Every workspace this caller may drive. Replies with { workspaces }. */
  z.object({ id: reqId, op: z.literal("workspaces.list") }),
  /** The workspace a person's word names, by id or by name, off the same reading workspaces.list serves: a name no
   * workspace here carries is refused as absent, and one this caller may not drive by the rule that hides it, so a
   * verb never denies a workspace the listing just showed. Replies with { workspace }. */
  z.object({ id: reqId, op: z.literal("workspaces.resolve"), ref: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.get"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.nap"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.wake"), workspaceId: z.string() }),
  /** Starts another daemon for a workspace whose daemon this host owns as a child of its own process, replacing
   * one that is not running. The one kind that has such a daemon is the workspace that is this computer; every
   * other kind's daemon lives on a machine this host does not hold the process of, and is refused here. Replies
   * `{}` once the new daemon has listened. */
  z.object({ id: reqId, op: z.literal("workspaces.restartDaemon"), workspaceId: z.string() }),
  /** Stops a wake that is asking the provider again on its own and replies with the record it leaves behind. */
  z.object({ id: reqId, op: z.literal("workspaces.stopWake"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.upgrade"), workspaceId: z.string() }),
  /** Moves a workspace onto the golden's head version: a fresh fork of the newer image carrying this workspace's
   * files across. The person asks for it; nothing moves a machine they are working on.
   * Refused (kind "conflict") for a workspace forked from a project golden, whose disk the move would throw away. */
  z.object({ id: reqId, op: z.literal("workspaces.updateImage"), workspaceId: z.string() }),
  /** Names the workspace and replies with its fresh { workspace }. The name is unique on this host, so one another
   * workspace holds, one a fork is landing under and a blank one are refused (kind "conflict"); a name the workspace
   * already carries comes back untouched. Threads running on the machine are untouched. */
  z.object({ id: reqId, op: z.literal("workspaces.rename"), workspaceId: z.string(), name: z.string() }),
  /** Sets the workspace's look and replies with its fresh { workspace }. A key left out keeps that fact as it is and
   * null clears it, so the colour picker and the icon picker each send their own without reading the other's. The
   * record alone changes: nothing on the machine is touched. */
  z.object({ id: reqId, op: z.literal("workspaces.look"), workspaceId: z.string() }).extend(WorkspaceLook.shape),
  /** Pushes the branch the workspace's copy is on and opens or finds its pull request, and replies with a
   * BringBackResult. The base is the branch its parent was on at the fork for a child, whatever that parent does
   * after, and the project's own base otherwise; the base branch itself is refused, since work leaves a workspace
   * as a branch of its own. */
  z.object({ id: reqId, op: z.literal("workspaces.bringBack"), workspaceId: z.string(), title: z.string().optional(), body: z.string().optional() }),
  /** A wsp worktree for a branch of a project's repo, or the worktree that already holds the branch, answered as a
   * WorktreeMade. A new branch starts from the project folder's current commit. */
  z.object({ id: reqId, op: z.literal("worktree.make"), project: z.string(), branch: z.string() }),
  /** The record of a project's folder on this computer, the one its threads share, made where no thread has made it
   * yet, and replied as { workspace }. */
  z.object({ id: reqId, op: z.literal("folder.make"), project: z.string() }),
  /** Takes a wsp worktree away with git, refused while a turn runs in it and, without force, while it holds files
   * no commit has. A worktree wsp did not make is never removed. */
  z.object({ id: reqId, op: z.literal("worktree.remove"), project: z.string(), branch: z.string(), force: z.boolean().optional() }),
  /** The copy's checkout, read again unless the host read it moments ago, and answered as a CheckoutReply. */
  z.object({ id: reqId, op: z.literal("workspaces.checkout"), workspaceId: z.string() }),
  /** Puts one changed file of the copy back as HEAD has it and answers a GitDiscardReply. */
  z.object({ id: reqId, op: z.literal("workspaces.discard"), workspaceId: z.string(), path: z.string() }),
  /** Commits the files named in the copy with the message given, hooks and all, and answers a GitCommitReply; paths
   * absent is every changed file, and an empty list is refused as nothing to commit. */
  z.object({ id: reqId, op: z.literal("workspaces.commit"), workspaceId: z.string(), message: z.string(), paths: z.array(z.string()).optional() }),
  /** A commit message for those files, or every changed file where paths is absent, drafted by the workspace's own
   * agent with no thread and no tool, answered as a CommitDraft. */
  z.object({ id: reqId, op: z.literal("workspaces.commitDraft"), workspaceId: z.string(), paths: z.array(z.string()).optional() }),
  /** The workspace's viewed marks, answered as ViewedMarks; with a path, the mark on that file is set against the
   * blob given, or taken off where the blob is null. */
  z.object({ id: reqId, op: z.literal("workspaces.viewed"), workspaceId: z.string(), path: z.string().optional(), blob: z.string().nullable().optional() }),
  /** The workspace's pull request page, read through the git host's command line on this computer, or the running
   * copy's where this computer has none, and answered as a GitPrViewReply; the host holds a read a minute, and an ask
   * with fresh reads it anew. */
  z.object({ id: reqId, op: z.literal("workspaces.pullRequestView"), workspaceId: z.string(), fresh: z.boolean().optional() }),
  /** The workspace's pull request's diff against its base, read as the page is and cut on a file's boundary at
   * GIT_DIFF_CAP_BYTES, answered as a GitPrDiffReply naming every file the cut left out. */
  z.object({ id: reqId, op: z.literal("workspaces.pullRequestDiff"), workspaceId: z.string() }),
  /** Sends items of the workspace's pull request page to its agent as one message, each with its author, its words
   * and, for a comment on a line, its file, line and the diff's lines above it, numbered where there are several;
   * the message joins the workspace's first thread as a fix's does. The host keeps what was sent, with when, and the
   * page answers it. Answered as a PullRequestSendResult. */
  z.object({ id: reqId, op: z.literal("workspaces.pullRequestSend"), workspaceId: z.string(), items: z.array(PullRequestItem).min(1) }),
  /** Posts a reply as the person through this computer's signed-in command line, never a copy's: under the comment on
   * a line replyTo names, in the thread threadId names, or a new comment in the conversation where it names none.
   * Answered as a GitPrReplyReply with the new comment. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.pullRequestReply"),
    workspaceId: z.string(),
    replyTo: z.number().int().nonnegative().optional(),
    threadId: z.string().optional(),
    body: z.string().max(PR_REPLY_BODY_MAX),
  }),
  /** Resolves or unresolves a review thread by its node id as the person, through this computer's command line alone,
   * answered as a GitPrResolveReply. */
  z.object({ id: reqId, op: z.literal("workspaces.pullRequestResolve"), workspaceId: z.string(), threadId: z.string(), resolved: z.boolean() }),
  /** Adds a reaction to the item a node id names, or takes it off where on is false, as the person through this
   * computer's command line alone; answered as a GitPrReactReply with every reaction on the item now. */
  z.object({ id: reqId, op: z.literal("workspaces.pullRequestReact"), workspaceId: z.string(), subject: z.string(), content: ReactionContent, on: z.boolean() }),
  /** Asks the workspace's agent to fix a failed check, named, with its log's failed steps; with no check, updates the
   * copy from its base first and asks it to fix the conflicts where the merge had any. Answered as a FixResult at
   * once, the turn going on without the caller. */
  z.object({ id: reqId, op: z.literal("workspaces.fix"), workspaceId: z.string(), check: z.string().optional(), child: z.string().optional() }),
  /** Merges the workspace's pull request by the method named, or the repository's default, only while its head is
   * the commit named in head, which a window sends as the one it drew; absent is the head the host holds, never a
   * fresh read. whenChecksPass arms it to merge once they do. Answered as a MergeResult. */
  z.object({ id: reqId, op: z.literal("workspaces.merge"), workspaceId: z.string(), method: MergeMethod.optional(), whenChecksPass: z.boolean().optional(), head: z.string().min(1).optional() }),
  /** A workspace started off a GitHub issue or pull request link: the link matched to a project here by its remote
   * (project names one where two match), the text read on this computer, the copy made and, for a pull request, put
   * on its head branch, and a thread opened with the composed task at the agent, model, effort and access given or
   * the workspace's defaults. Answered as a StartResult. The person's act alone: no thread's token and no paired
   * computer reaches it. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.start"),
    url: z.string(),
    project: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    access: AccessChoice.optional(),
  }),
  /** A reviewer thread on a pull request, off its link or off a workspace's own pull request: a fresh copy at its
   * head, the agent at its harness's read-only word (Codex where none is named), and the diff in its task. Answered
   * as a StartResult. The person's act alone. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.review"),
    url: z.string().optional(),
    workspaceId: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
  }),
  /** A review workspace's draft, read, or edited first: its summary, its verdict and which comments stay ticked.
   * Answered as { review? }. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.reviewDraft"),
    workspaceId: z.string(),
    summary: z.string().optional(),
    verdict: z.enum(["comment", "approve", "request_changes"]).optional(),
    on: z.array(z.object({ id: z.string(), on: z.boolean() })).optional(),
  }),
  /** Posts the draft on the pull request in one call as the person, pinned to the head it was written against, the
   * ticked comments alone. Answered as a ReviewPostResult. The person's act alone. */
  z.object({ id: reqId, op: z.literal("workspaces.reviewPost"), workspaceId: z.string() }),
  /** Merges the base's latest commits into the copy's branch, answered as a GitUpdateReply: the files that conflict
   * where it could not, the copy left as it was. */
  z.object({ id: reqId, op: z.literal("workspaces.update"), workspaceId: z.string() }),
  /** Merges a child's branch into the lead's copy with a merge commit through the lead's own daemon, answered as a
   * MergeInResult: merged with the commits it brought, merged nothing, or the files it stopped on with the copy left as
   * it was. Refused for a workspace that is not the lead's child and while a turn runs on the lead. */
  z.object({ id: reqId, op: z.literal("workspaces.mergeIn"), workspaceId: z.string(), child: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.delete"), workspaceId: z.string() }),
  /** Turns the workspace's agents switch on or off and names its caps. Every key left out keeps what the record
   * holds, so the two flags a person gives on one line never clear the third. */
  z.object({ id: reqId, op: z.literal("workspaces.agents"), workspaceId: z.string() }).extend(WorkspaceAgents.partial().shape),
  /** Drops a workspace whose machine the provider no longer has: the record, its transcripts and its sessions leave the
   * store and workspace.deleted follows, once twelve reads in a row find the machine gone; nothing is asked of the
   * machine. Refused with the reason (kind "conflict") while any read still finds it: pause it or delete it at the provider first. */
  z.object({ id: reqId, op: z.literal("workspaces.forget"), workspaceId: z.string() }),
  /** Snapshots the workspace's disk as a project golden and replies with { projectGolden }. Refused when the workspace
   * is not running, holds no project, or its machine is not first-life (kind "notFirstLife"). The guest freezes for
   * about three seconds and keeps its first life. */
  z.object({ id: reqId, op: z.literal("workspaces.snapshot"), workspaceId: z.string() }),
  /** Replies with { projectGoldens: ProjectGolden[] }, every project golden this runtime took, newest last. */
  z.object({ id: reqId, op: z.literal("projectGoldens.list") }),
  /** Deletes a project golden's snapshot at the provider of the place its record names and replies with a
   * ProjectGoldenRemoved once the listing no longer holds it; the record leaves last. Refused while any workspace
   * stands on it, whatever its phase (kind "conflict"), and for an id no project golden holds (kind "not-found"). */
  z.object({ id: reqId, op: z.literal("projectGoldens.remove"), snapshotId: z.string() }),
  /** A person acted in the workspace through a road the runtime cannot see (typed into
   * a terminal over the browser's daemon link); the idle countdown starts over. */
  z.object({ id: reqId, op: z.literal("workspaces.touch"), workspaceId: z.string() }),
  /** Opens a channel to the workspace's daemon and replies with a DaemonOpenReply. The host dials the road the
   * workspace's kind answers with and sends its own token as the first frame. Refused with kind "refused" when the
   * door answered the upgrade with anything but 101 (the sentence carries the status and the body's first line),
   * with kind "reauth" when the daemon took the upgrade and closed 4401 on the token, and with the runtime's own
   * sentence and no kind when the machine has no road or no daemon yet, or the dial failed or timed out.
   *
   * With `placeId` in place of `workspaceId` the channel is to the daemon on a computer the person owns, over the
   * link that computer is holding: nothing is dialled, and it is refused where that computer is not connected.
   * HERE_PLACE_ID names the computer the host runs on, whose own daemon is dialled. One of the two, never both. */
  z.object({ id: reqId, op: z.literal("daemon.open"), workspaceId: z.string().optional(), placeId: z.string().optional() }),
  /** Pushes WorkspaceSysEvent frames for this workspace on this socket, one per poll tick, until sys.unsubscribe or
   * the socket goes. The one road for a workspace whose kind reads its Live rows in the host rather than off a daemon;
   * refused for every other kind, which reads them over its own daemon link with sys.watch. Replies `{}`. */
  z.object({ id: reqId, op: z.literal("sys.subscribe"), workspaceId: z.string() }),
  /** Stops this socket's sys.subscribe for the workspace; replies `{}` whether or not it held one. */
  z.object({ id: reqId, op: z.literal("sys.unsubscribe"), workspaceId: z.string() }),
  /** Sends one frame down a channel this socket opened and replies with a DaemonSendReply carrying the daemon's own
   * answer, ok or not. Refused (ok false, no kind) when the channel is not this socket's or died before the daemon
   * answered. */
  z.object({ id: reqId, op: z.literal("daemon.send"), channel: z.string(), frame: DaemonFrame }),
  /** Closes a channel this socket opened; no daemon.closed follows a close the page asked for. */
  z.object({ id: reqId, op: z.literal("daemon.close"), channel: z.string() }),
  /** Starts a turn and replies with a SessionStartResult. On a thread whose turn is still running the runtime never
   * starts a second one on the session: the message joins the running turn when the harness steers (the reply names
   * that turn), and otherwise waits for it to end before starting. */
  z.object({
    id: reqId,
    op: z.literal("sessions.start"),
    /** The record the thread runs on: a box's workspace, or the folder record of an existing thread. Absent on this
     * computer, where project, branch and cwd say where the thread runs; absent with none of them, a start out of a
     * thread runs beside that thread. */
    workspaceId: z.string().optional(),
    /** The project the thread runs in, by name or id: its folder, or the worktree branch names. */
    project: z.string().optional(),
    /** A branch other than the folder's: the thread runs in the worktree of the project's repo holding it, made
     * under the host's folder when none does. Refused on a folder that is not a git repo. */
    branch: z.string().optional(),
    prompt: z.string(),
    harness: z.string().optional(),
    /** The thread the message goes to, by its runtime id: its latest turn is resumed, and a thread whose harness never
     * announced a session takes the message as a first turn on that same thread. Refused when the workspace has no
     * thread with that id. Absent opens a thread. */
    thread: z.string().optional(),
    /** The folder the thread starts in, absolute; it wins over project and the rule. Absent leaves the runtime's
     * default folder rule (projectFor, then the kind's own folder) to say. */
    cwd: z.string().optional(),
    /** Values from the harness's catalog for the workspace (harnesses.list), refused with that list on a miss. A
     * start that opens a thread without a model runs the one the catalog marks default, so the app, the command line
     * and the MCP server run the same model; an absent effort or mode leaves the CLI's own. */
    model: z.string().optional(),
    effort: z.string().optional(),
    permissionMode: z.string().optional(),
    /** The access in wsp's own word, which the harness's catalog row turns into its mode; refused where the row maps
     * the word to none. A permissionMode beside it wins. */
    access: AccessChoice.optional(),
    contextWindow: z.string().optional(),
    /** The model's faster output for this turn; refused naming the model where its catalog row offers none. */
    fast: z.boolean().optional(),
    /** Absent reads as person: the app never sends it, the command line sends cli, the MCP server sends agent. */
    startedBy: SessionOrigin.optional(),
    /** Minted by the client per send and echoed on the turn's session.start, so the client knows which start is its own. */
    requestId: z.string().optional(),
    /** Minted by the client once for a send that opens the same message on several models, one copy each, and stamped
     * on each thread's row as SessionView.attempt. */
    attempt: z.string().optional(),
    /** Who the end of every turn on the thread this start opens is told, each a thread id or NOTIFY_ME: registered on
     * the thread, and each target gets one line (a session.notify event per target in this thread's transcript).
     * Refused when a target names no thread, and refused when one names the thread this start opens. */
    notify: z.array(z.string()).min(1).optional(),
    /** The TURN_TOKEN_ENV of the turn this request came out of, when it came out of one: what NOTIFY_ME is resolved
     * against. Refused when no turn on this host carries it, since a token nothing carries names a turn the caller
     * is not. */
    turnToken: z.string().optional(),
    /** The name the thread is opened under, as a person's: it stands in every client at once, the harness is told it
     * too so its own UI says the same, and no generated title ever replaces it. Refused when it is blank. */
    title: z.string().optional(),
    /** The files the message carries, in the order the person added them; refused with filesRefusal's line over the
     * caps, and refused naming the agent before the machine is asked when an image goes to an agent that reads none.
     * An image rides its harness's road; any other file lands in the thread's folder and the prompt names it. */
    attachments: z.array(Attachment).optional(),
  }),
  /** Replies with { harnesses: HarnessCatalog[] }, one per harness the runtime knows. With a workspace, the lists come
   * from the binaries on its machine where they answer; without one, from the runtime's table. */
  z.object({ id: reqId, op: z.literal("harnesses.list"), workspaceId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("sessions.list"), workspaceId: z.string().optional() }),
  /** Replies with the workspace's persisted SessionEvent[] (oldest first, capped by the runtime). With threadId,
   * replies with a HistoryPage of that thread instead: its newest events under `before` (every one when absent), at
   * most `limit` of them (HISTORY_PAGE_EVENTS when absent) and no more than HISTORY_PAGE_BYTES of them past the first,
   * so a client pages back by passing the pos of the oldest event it holds. Refused as usage when before or limit
   * comes without a thread. */
  z.object({
    id: reqId,
    op: z.literal("sessions.history"),
    workspaceId: z.string(),
    threadId: z.string().optional(),
    before: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(HISTORY_PAGE_MAX).optional(),
  }),
  /** Replies with the thread's ThreadHead, by its fold key as sessions.read takes it; refused as not found where the
   * caller reaches no such thread. */
  z.object({ id: reqId, op: z.literal("sessions.head"), threadId: z.string() }),
  /** Replies with { attachment: KeptAttachment }: one image a person's message carried, by the thread, the request id
   * its start carries and its place in the message, which the host keeps until the thread or its workspace goes. */
  z.object({ id: reqId, op: z.literal("sessions.attachment"), workspaceId: z.string(), threadId: z.string(), requestId: z.string(), index: z.number().int().nonnegative() }),
  /** Asks the harness to stop the session's running turn, or with task the one subagent of it the agent calls by that
   * id and nothing else; replies with a SessionInterruptResult. */
  z.object({ id: reqId, op: z.literal("sessions.interrupt"), sessionId: z.string(), task: z.string().optional() }),
  /** Sends a message into the session's running turn; replies with a SessionSteerResult. Takes the runtime's session
   * id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.steer"), sessionId: z.string(), prompt: z.string(), requestId: z.string().optional() }),
  /** Answers a permission prompt the session's running turn relayed into the chat, by the prompt's id and one of its
   * options; replies with a SessionAnswerResult. Takes the runtime's session id, as sessions.interrupt does. A deny
   * may carry the person's reason, what the agent should do instead. */
  z.object({ id: reqId, op: z.literal("sessions.answer"), sessionId: z.string(), askId: z.string(), optionId: z.string(), reason: z.string().optional() }),
  /** Puts the session's running turn into another access mode from its next tool call on; replies with a
   * SessionAccessResult. Takes the runtime's session id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.access"), sessionId: z.string(), permissionMode: z.string() }),
  /** Names the session's harness session in the harness's own store and keeps the name on the thread's rows; replies
   * with a SessionRenameResult. Takes the runtime's session id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.rename"), sessionId: z.string(), title: z.string() }),
  /** Drops a thread no turn ever ran on: its rows and its transcript rows go and nothing is asked of the machine.
   * Takes the runtime's thread id, the one the rows carry, not a session id; refused with threadForgetRefusal's
   * sentence once a turn reached the agent. */
  z.object({ id: reqId, op: z.literal("sessions.forget"), threadId: z.string() }),
  /** Takes a thread away on this computer, its turns and its checkpoints with it: a thread in the project folder goes
   * alone and the folder is never touched; a thread in a worktree wsp made takes that worktree and every thread in it,
   * refused over files no commit holds. A thread on a box goes with its machine. */
  z.object({ id: reqId, op: z.literal("sessions.delete"), threadId: z.string() }),
  /** A window showed the thread, or `wsp thread read` read it: its read stamp moves to now, and every window hears
   * thread.marked. Takes the thread's fold key, as ThreadView.id carries it. */
  z.object({ id: reqId, op: z.literal("sessions.read"), threadId: z.string() }),
  /** The person settled these threads by hand, a root and every thread under it: each takes a settled stamp and a
   * read stamp of now, and every window hears thread.marked. Takes fold keys. */
  z.object({ id: reqId, op: z.literal("sessions.settle"), threadIds: z.array(z.string()).min(1) }),
  /** The person pinned, snoozed or placed these threads, or took one of those back with false or null: each moves on
   * the thread's record and every window hears thread.marked. A snooze stamps the thread read as well, since putting
   * a finish away is looking at it. Takes fold keys. */
  z.object({ id: reqId, op: z.literal("sessions.mark"), threadIds: z.array(z.string()).min(1), marks: ThreadMarks }),
  /** The person took settled threads back out of the fold: the settled stamp goes and the read stamp moves to now, so
   * the quiet the fold reads counts from the restore. Takes fold keys. */
  z.object({ id: reqId, op: z.literal("sessions.restore"), threadIds: z.array(z.string()).min(1) }),
  /** The words of every thread the caller reaches, the person's messages and the agent's replies, searched on the
   * host for the query, case aside: one hit per thread with a snippet around the words. Reads only what the host
   * still holds of each transcript. */
  z.object({ id: reqId, op: z.literal("sessions.search"), query: z.string() }),
  /** A question asked beside a thread, answered by the thread's harness on a copy of its session with no tools, off the
   * thread's latest row: its folder, its model and its agent. Replies with a SessionAsideResult. Nothing is recorded:
   * the transcript, the rows and the harness's own session are as they were. Takes any of the thread's session ids. */
  z.object({ id: reqId, op: z.literal("sessions.aside"), sessionId: z.string(), question: z.string() }),
  /** Rewinds a thread to the end of one of its turns: the turns after it leave the transcript and, where the harness
   * cuts its own history, the conversation, and with files the copy's tree goes back to that turn's checkpoint after
   * the tree as it stands is checkpointed. undo instead puts back the files the thread's last rewind replaced. */
  /** Records one step of a reply's block run on its thread and replies { run } with the step the thread now holds:
   * the one asked for, or the ending a run already had. The window runs the command in the workspace's own pty; the
   * host keeps what every window draws. */
  z.object({ id: reqId, op: z.literal("sessions.run") }).extend(RunStep.shape),
  z.object({ id: reqId, op: z.literal("sessions.rewind"), threadId: z.string(), turnId: z.string().optional(), files: z.boolean().optional(), undo: z.boolean().optional() }),
  z.object({ id: reqId, op: z.literal("golden.get"), name: z.string() }),
  /** Replies with the backend's Capabilities; the UI gates features on these. */
  z.object({ id: reqId, op: z.literal("capabilities.get") }),
  /** Boots a fresh builder for golden `name`; replies with a GoldenBuilderView.
   * Progress rides golden.stage events on the events channel. */
  z.object({ id: reqId, op: z.literal("golden.prepare"), name: z.string(), kind: MachineKind.optional() }),
  /** Snapshots the builder, smoke-tests a fork, appends a manifest version;
   * replies with { manifest, version }. The builder is consumed either way. */
  z.object({ id: reqId, op: z.literal("golden.seal"), builderId: z.string() }),
  /** Replies with { lineage: SnapshotLineage } for golden `name` (default "default"). */
  z.object({ id: reqId, op: z.literal("snapshots.list"), name: z.string().optional() }),
  /** Replies with { storage: SnapshotStorage | null }: every snapshot on the account by count, size and monthly
   * cost; null on a backend whose capabilities lack snapshotListing. */
  z.object({ id: reqId, op: z.literal("snapshots.storage") }),
  /** Replies with { points: WorkspaceCostEvent[] }: the workspace's cost ticks since metering began, across host
   * restarts, folded to the ticks where the rate changed plus the newest (appendCostPoint); empty before the first tick. */
  z.object({ id: reqId, op: z.literal("cost.history"), workspaceId: z.string() }),
  /** Replies with { places: PlaceSpend[] }: one row per place this host holds anything metered for, with what it
   * has taken since the first of the month and what it burns now. Refused on a socket let in on a ticket, as the
   * places list itself is: what a person's computers cost is that person's computer's to answer. */
  z.object({ id: reqId, op: z.literal("cost.spend") }),
  // What was used over a range split one way, and what each account signed in anywhere may still use: two answers,
  // never one figure.
  /** outside: the rows read from this computer's agent logs, which only the person's own page asks for. */
  z.object({ id: reqId, op: z.literal("usage.used"), range: UsageRange, split: UsageSplit, outside: z.boolean().optional() }),
  z.object({ id: reqId, op: z.literal("usage.accounts") }),
  /** Replies with a ResetAnswer: spends one of the account's banked resets on a computer of the person's that holds
   * its login, the one named where it is one, after reading the account there. The person's own road alone. */
  z.object({ id: reqId, op: z.literal("usage.reset"), account: z.string(), creditId: z.string().optional(), on: z.string().optional() }),
  // A computer's readings over a range, off its daemon: this computer, a joined one, or a workspace's own machine.
  z.object({ id: reqId, op: z.literal("places.readings"), placeId: z.string().optional(), workspaceId: z.string().optional(), range: UsageRange }),
  /** Moves the golden's head to a version already in its manifest; replies with a
   * SnapshotRollbackResult. A version outside the manifest fails with kind "missing". */
  z.object({ id: reqId, op: z.literal("snapshots.rollback"), version: z.number(), name: z.string().optional() }),
  /** Replies with { reach: PortReachView } for one guest port, cached per port
   * while fresh. A port outside the daemon's listening set still mints: the
   * user may have typed it. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.portReach"),
    workspaceId: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  /** Replies with { probe: PortProbeView }: one fetch of the port's minted route
   * from the host, redirects unfollowed, the body read up to a cap. A 401 remints
   * the port's route before the reply, so the next portReach carries a fresh
   * token. Refused when the route cannot be fetched at all; the frame is the
   * only truth then. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.portProbe"),
    workspaceId: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  /** Replaces the workspace's machine with a fresh golden fork, imports the
   * nap-time vault if one exists, and kills the old machine whatever it
   * reports. Replies with the WorkspaceView on its new machine; id and name
   * are kept. The way out of a zombie reach state. */
  z.object({ id: reqId, op: z.literal("workspaces.rebuild"), workspaceId: z.string() }),
  /** Replies with { forwards: PortForward[] }, the host's open forwards; empty when no host holds any. */
  z.object({ id: reqId, op: z.literal("forwards.list") }),
  /** Closes one forward; refused when none is open on that workspace and port. */
  z.object({ id: reqId, op: z.literal("forwards.stop"), workspaceId: z.string(), port: RelayPort }),
  /** Runs one command on the workspace's machine the way a harness turn is launched: detached, as the same user,
   * with the environment the harness adapter exports for a turn. argv is the command word by word; the runtime
   * quotes each for the machine's shell, so a word stays one word. Replies { execId } once launched, then pushes
   * ExecEvent frames to this socket only: exec.output per line, exec.exit last. The socket closing ends the
   * command, and so does the machine going away under it (deleted, paused, or unanswering: exec.exit then carries
   * the reason as its error); nothing else does, there is no deadline. cwd is the folder the command runs in, absolute;
   * absent, the folder the workspace's kind names, as a harness turn's is. The reply carries that folder back as its
   * own cwd, absent only where the kind names none and the machine's own home is where the shell landed. */
  z.object({ id: reqId, op: z.literal("workspaces.exec"), workspaceId: z.string(), argv: z.array(z.string()).min(1), cwd: z.string().optional() }),
  /** Replies with { listing: HostFolderListing }: one level of this computer's own folders, for the picker a browser
   * tab has instead of the desktop shell's dialog. `dir` absent lists the first root and a folder inside the roots
   * that is gone does the same; a path outside them is refused. `hidden` lists the hidden folders too, which are
   * otherwise only counted. `repos` answers every git repo under the roots instead of one level, most recent
   * first. `on` is the id of the computer whose folders are listed, off places.list: absent or this computer's is
   * this computer's; a computer you joined answers through its own daemon over its link, with its login's home and
   * its projects' folders as the roots; a provider keeps no computer and is refused. */
  z.object({ id: reqId, op: z.literal("host.folders"), dir: z.string().optional(), hidden: z.boolean().optional(), repos: z.boolean().optional(), on: z.string().optional() }),
  /** Replies with { config: TerminalConfig }: the person's Ghostty config on the computer running the host, read
   * again on every ask so a saved change reaches the next terminal opened; `scheme` picks the theme of a
   * light:...,dark:... value and is dark when absent. */
  z.object({ id: reqId, op: z.literal("host.terminalConfig"), scheme: TerminalScheme.optional() }),
  /** Replies with { editors: EditorChoice[] }: the editors installed on the computer running the host, in the
   * table's order. None where the host runs on a computer it keeps no table for. Only this computer's own window may
   * ask, as with editor.open below. */
  z.object({ id: reqId, op: z.literal("editor.list") }),
  /** Opens a file or a folder of one workspace in the person's editor on the computer running the host and replies
   * with { editor }, the one it opened in: `editor` where the window names one, else the preference's, else the
   * first installed. The path must resolve inside
   * that workspace's copy or its project folder on this computer, a link included. A workspace whose files are on
   * another computer opens over ssh, by its alias, once its ssh road is ready: refused with kind sshInclude and
   * sshIncludeLine until the person's ssh config reads wsp's, and with editorOpensHereLine by an editor with no
   * remote road or a host that carries no ssh. `line`, from 1, lands the editor on that line where it takes one. The
   * command is the host's own table's, run with the path as one argument and never through a shell. Only this
   * computer's own window may ask. */
  z.object({ id: reqId, op: z.literal("editor.open"), workspaceId: z.string(), path: z.string(), line: z.number().int().positive().optional(), editor: EditorId.optional() }),
  /** Replies with { port }: a port on this computer's loopback that carries to the workspace's own ssh server,
   * started there first with this computer's key allowed and its host key pinned under the workspace's alias before
   * the answer. A copy on this computer has none, since its folder opens here; a napping workspace is woken first.
   * What `wsp ssh` pipes an editor's ssh through. Only this computer's own window and the wsp command may ask. */
  z.object({ id: reqId, op: z.literal("ssh.port"), workspaceId: z.string() }),
  /** Puts the one Include line for wsp's own ssh config at the top of the person's ~/.ssh/config, or takes it out,
   * or with `on` absent only reads it, and replies with { sshInclude }, whether it stands. Only this computer's own
   * window may ask. */
  z.object({ id: reqId, op: z.literal("ssh.include"), on: z.boolean().optional() }),
  /** Replies with { report: AgentsReport }: the agents, skills and MCP servers standing on one computer or workspace,
   * read as the login the computer was added with and never as root. Nothing is started: no server is spawned and no
   * login file is read, only whether one is there. A napping workspace is not woken; it answers the last report read
   * while it ran, marked stale, or refuses where there is none. A cloud account's row is refused, since nothing stands
   * there between forks. */
  z.object({ id: reqId, op: z.literal("agents.read"), target: AgentsTarget }),
  /** Replies with { answer: ServerToolsAnswer }: one MCP server of one agent's config there, started once as that
   * login with its own command and variables, or asked once over its address, for its tools and its sign-in. Only on
   * the person's ask, under a deadline, the answer kept for an hour unless `refresh`. A server whose sign-in the
   * harness holds brings no list, only the harness's word where its words were measured; no login file is read. */
  z.object({ id: reqId, op: z.literal("servers.tools"), target: AgentsTarget, agent: z.string(), name: z.string(), refresh: z.boolean().optional() }),
  /** Replies with { icon: string | null }: a remote MCP server's icon by its host (the report's `transport.host`) as a
   * data url, asked of Google's favicon service by this host alone and kept 30 days, `refresh` asking again. Null
   * where there is none, where the host is an address or a private name, and always while the person's
   * `serverIcons` preference is off, when nothing is asked. */
  z.object({ id: reqId, op: z.literal("servers.icon"), host: z.string().min(1).max(260), refresh: z.boolean().optional() }),
  /** Replies with { signInId } once the agent's own sign-in runs in a pty there, as that computer's login, or joins
   * the one already running for that agent there, one per agent per target; its progress is pushed as agents.signIn
   * events to the sockets following it alone, which is what a page and its code are for, and the sign-in stops when
   * the last of them goes. Refused for a row that asks the person to pick, which runs in their terminal, for a row
   * whose login is a token or key this host keeps, and for a name holding a control character. */
  z.object({ id: reqId, op: z.literal("agents.signIn"), target: AgentsTarget, agent: z.string() }),
  /** The same for one MCP server of that agent's config, by the harness's own command for it. */
  z.object({ id: reqId, op: z.literal("servers.signIn"), target: AgentsTarget, agent: z.string(), name: z.string() }),
  /** Types what a sign-in's page handed back into that sign-in's own pty, with the Enter the person would press. */
  z.object({ id: reqId, op: z.literal("agents.signInCode"), signInId: z.string(), code: z.string().min(1) }),
  /** Stops a sign-in this socket started or joined, killing its pty for everyone following it. */
  z.object({ id: reqId, op: z.literal("agents.signInStop"), signInId: z.string() }),
  /** Replies with { line: SignInLine }: the sign-in, or one server's with `name`, as the line the person's own
   * terminal runs there over its daemon channel. */
  z.object({ id: reqId, op: z.literal("agents.signInLine"), target: AgentsTarget, agent: z.string(), name: z.string().optional() }),
  /** Writes the agent's token or key into this host's vault, the variable its row names, checked against the shape
   * the row says the tool prints; only on the host's own socket. Replies with nothing of it. */
  z.object({ id: reqId, op: z.literal("agents.key"), agent: z.string(), key: z.string().min(1) }),
  /** Replies with { file }: the wsp server written into that agent's own config on this computer, the entry an
   * install writes, with the wsp skill beside it. Refused on any other computer. */
  z.object({ id: reqId, op: z.literal("agents.addTools"), target: AgentsTarget, agent: z.string() }),
  /** Sets how one agent runs on one computer, by the place id places.list gives it: on or off, the program, its config
   * folder, launch arguments and environment. Replies with { agent: AgentRow }, the row as a read of that computer
   * would give it, names only. The person's own road only; a variable's value only on the host's own socket. */
  z.object({ id: reqId, op: z.literal("agents.setup"), placeId: z.string(), agent: z.string() }).merge(AgentSetupSet),
  /** Replies with { skills: SkillHit[] }: skills.sh searched by this host, the one caller of it; an empty query is
   * refused, since skills.sh refuses it. */
  z.object({ id: reqId, op: z.literal("skills.search"), q: z.string(), limit: z.number().int().min(1).max(50).optional() }),
  /** Replies with { preview: SkillPreview }: a skill's SKILL.md off skills.sh by its `<owner>/<repo>/<skill>`, read
   * by this host and nothing installed. */
  z.object({ id: reqId, op: z.literal("skills.get"), skill: z.string() }),
  /** Replies with { preview: SkillPreview }: the SKILL.md of one skill there, by its name, the project's skill of that
   * name with `project`. */
  z.object({ id: reqId, op: z.literal("skills.preview"), target: AgentsTarget, name: z.string(), project: z.boolean().optional() }),
  /** Replies with { added: SkillAdded }: a skill off skills.sh put into the shared skills folder there, the project's
   * with `project`, with a link or a copy in the folder of each agent named that does not read that folder. Every
   * path in the download is checked first, the files land 0644 as that computer's login, and nothing in them runs. */
  z.object({ id: reqId, op: z.literal("skills.add"), target: AgentsTarget, skill: z.string(), agents: z.array(z.string()).optional(), project: z.boolean().optional() }),
  /** Replies with { removed: string[] }: every folder of that skill there and every link to it, gone. The skill wsp
   * writes and a plugin's are refused. */
  z.object({ id: reqId, op: z.literal("skills.remove"), target: AgentsTarget, name: z.string(), project: z.boolean().optional() }),
  /** Replies with { paths: string[] }: that skill turned off or on there, its SKILL.md renamed SKILL.md.off or back
   * in each of its folders. The skill wsp writes, a plugin's and a project's are refused. */
  z.object({ id: reqId, op: z.literal("skills.toggle"), target: AgentsTarget, name: z.string(), project: z.boolean().optional(), on: z.boolean() }),
  /** Replies with { file }: one MCP server written into that agent's own config there, the project's with `project`,
   * as that computer's login: a command with its arguments and variables, or an address with its headers. The values
   * go into that file and nowhere else; a name already there is refused rather than written over. */
  z.object({ id: reqId, op: z.literal("servers.add"), target: AgentsTarget, ...ServerAdd.shape }),
  /** Replies with { file }: that one server's entry taken out of that agent's config there, in the scope it was read
   * from, every other line of the file as it was. */
  z.object({ id: reqId, op: z.literal("servers.remove"), target: AgentsTarget, ...ServerAsk.shape }),
  /** Replies with { file }: that one server turned off or on in that agent's config there, by the switch the agent
   * itself reads; refused for an agent that keeps no such switch per server. */
  z.object({ id: reqId, op: z.literal("servers.toggle"), target: AgentsTarget, ...ServerAsk.shape, on: z.boolean() }),
  /** Replies with { setup: InitSetup }: the cloud setup as the modal opens on it, the init job included when one runs.
   * `on` prices the build at that place instead of the default one, by the name or id wsp places lists; once the
   * image stands, every build is priced at the image's own place whatever `on` says. */
  z.object({ id: reqId, op: z.literal("init.get"), on: z.string().optional() }),
  /** Saves keys into the wsp home's .env on the computer running the host: the provider key, put to that provider
   * before anything is written and saved under the variable its own module reads, and an agent's API key by the
   * sign-in row it answers, saved under the variable that agent's sign-in declares. `provider` is the word
   * WSP_PROVIDER holds for the provider the key belongs to, and naming one picks it; absent, the key goes to the
   * provider this host already forks on. Replies with { setup: InitSetup }, which says a key is held and never says
   * what it is. */
  z.object({ id: reqId, op: z.literal("init.keys"), provider: z.string().max(64).optional(), key: z.string().optional(), rows: z.record(z.string()).optional() }),
  /** Starts the init job on the road named, an agent's harness on the agent road; replies with { job: InitJob } and
   * every change after rides init.job events. One job runs at a time; a second start while one runs is refused. The
   * terminal road takes its answers from the recipe beside the state, which wsp init wrote from its own screens, and
   * is refused when there is none there. */
  z.object({ id: reqId, op: z.literal("init.start"), road: InitRoad, harness: z.string().optional(), on: z.string().optional() }),
  /** Answers one screen: the rows ticked, the answers chosen; replies with { job: InitJob }, its screens recomputed
   * and its step moved to the next. */
  z.object({ id: reqId, op: z.literal("init.answer"), screen: InitScreenId, ticks: z.array(z.string()).optional(), answers: z.record(z.string()).optional() }),
  /** Moves the job to a screen the person went back to, so a setup shut there reopens there; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.step"), at: z.number().int().nonnegative() }),
  /** Keeps what a step has ticked, picked or typed and not sent, so a setup shut mid-step reopens on it; replies
   * with { job: InitJob }. `at` is a screen's id or the build question's own step; a step the job does not have is
   * refused. An empty draft is an answer of its own: a step whose every tick was taken off comes back with none on. */
  z.object({ id: reqId, op: z.literal("init.draft"), at: z.string().min(1).max(64), ticks: z.array(z.string()).optional(), answers: z.record(z.string()).optional() }),
  /** Runs a sign-in that ran out or failed again on the machine while the build goes on; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.retry"), tool: z.string() }),
  /** Writes the recipe as answered and starts the build; replies with { job: InitJob } at once, the build riding on.
   * `yes` skips the sign-ins on the machine, as wsp init --yes does: a caller that asked for no waiting gets none.
   * `on` is the place the image is built on, by the name or id wsp places lists; absent takes the default place.
   * `on` is read for the first build alone: once the image stands, every build goes to the image's own place, so
   * no caller can move it.
   * `rebuild` seals the next version from a fresh machine rather than from the image plus the changes, which is the
   * question a run at a terminal is asked; absent takes whichever road the changes call for. */
  z.object({ id: reqId, op: z.literal("init.build"), firstWorkspace: z.string().optional(), importFolder: z.string().optional(), yes: z.boolean().optional(), on: z.string().optional(), rebuild: z.boolean().optional() }),
  /** Types the code a sign-in's page handed back into the tool waiting for it on the machine, as the person would at
   * that terminal; replies with { job: InitJob }. The code is never logged, kept or carried on the view. Refused when
   * no sign-in for that tool is waiting for one. */
  z.object({ id: reqId, op: z.literal("init.signInCode"), tool: z.string(), code: z.string().min(1).max(SIGN_IN_CODE_MAX) }),
  /** Stops the job where it is: a thread interrupted, a builder killed; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.cancel") }),
  /** Replies with { preferences: Preferences }: the record on this host's state, the defaults until a client set something. */
  z.object({ id: reqId, op: z.literal("preferences.get") }),
  /** Lands the patch on the record, keeps it, pushes preferences.changed to every socket and replies with
   * { preferences: Preferences, notice? }, the notice a sentence on what the set kept but could not finish. */
  z.object({ id: reqId, op: z.literal("preferences.set"), patch: PreferencesPatch }),
  /** Replies with { release: ReleaseView }: the newest release as this host last read it, asking nobody. */
  z.object({ id: reqId, op: z.literal("release.get") }),
  /** Asks GitHub again unless the last ask was under ten minutes ago and replies with { release: ReleaseView }; a
   * changed view is pushed to every socket as release.changed. */
  z.object({ id: reqId, op: z.literal("release.check") }),
  /** Replies { ok } and then restarts this host on the files it was installed from, by the road it came up on;
   * refused where that road would not bring it back. The socket closes on the host's stopping code. */
  z.object({ id: reqId, op: z.literal("host.restart") }),
  /** Records a project: one word, which is a folder on this computer or a repo url a computer clones, and the
   * computer it lives on. Replies with { project, notice? }; refused with the three forms when the word names
   * none of them, and refused naming the project when that source is already recorded on that computer. */
  z.object({
    id: reqId,
    op: z.literal("projects.add"),
    source: z.string(),
    on: z.string().optional(),
    name: z.string().optional(),
    base: z.string().optional(),
    /** The folder on this computer a repo is cloned into, absent or empty; the project is then that folder. */
    into: z.string().optional(),
    /** What the person chose off the seed menu; required where the source is a folder on this computer and that
     * folder is seeding a computer that clones, since nothing of theirs leaves this computer unasked. */
    seed: SeedChoice.optional(),
  }),
  /** Replies with { plan: SeedPlan } for a folder on this computer: what a seed of it would carry, read off git's
   * own ignore listing and one size pass. No file's content is read and nothing leaves this computer. */
  z.object({ id: reqId, op: z.literal("project.seed.plan"), source: z.string() }),
  /** Every project this host holds. Replies with { projects }. */
  z.object({ id: reqId, op: z.literal("projects.list") }),
  /** What a new thread on each of those projects starts on, by project id, each value with where it came from, read
   * off the runtime's table rather than any machine. Replies with { defaults }. */
  z.object({ id: reqId, op: z.literal("projects.defaults") }),
  /** The project a word names, by id or by name. Replies with { project }. */
  z.object({ id: reqId, op: z.literal("projects.resolve"), ref: z.string() }),
  /** Drops a project's record; refused while a workspace of it stands, naming the workspaces. Replies with {}. */
  z.object({ id: reqId, op: z.literal("projects.remove"), projectId: z.string() }),
  /** Replies with { plan: ProjectPlan } for a folder on this computer; nothing is read into memory or uploaded. */
  z.object({ id: reqId, op: z.literal("project.plan"), source: z.string() }),
  /** Packs the folder and lands it at `dest` on the workspace's machine; progress rides project.import events and the
   * reply is { imported: ProjectImportResult }. `carry` names the secret-shaped paths from the plan that may travel as
   * they are; `rewrite` names the ones the plan offered a rewrite for, which land rewritten as offered and win over
   * carry; every other secret-shaped file is cut and named. `agents` names the plan's agents whose state for the
   * folder travels; nothing of an agent not named is read. An existing `dest` is refused (kind "exists") unless `replace`. */
  z.object({
    id: reqId,
    op: z.literal("project.import"),
    workspaceId: z.string(),
    source: z.string(),
    dest: z.string(),
    replace: z.boolean().optional(),
    carry: z.array(z.string()).optional(),
    rewrite: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
  }),
  /** The bundle's trip home: tars `source` on the workspace's machine with the bundle's cache exclusions and the
   * agent state keyed to it, lands the folder at `dest` on this computer and the state in the agents' homes here,
   * keyed to `dest`; progress rides project.export events and the reply is { exported: ProjectExportResult }.
   * `agents` narrows whose state comes home, by catalog id; absent, every agent with sessions for the folder does.
   * An existing `dest` is refused (kind "exists", the message naming it and how many files it holds) unless
   * `replace`; nothing is read from the machine before that check. */
  z.object({
    id: reqId,
    op: z.literal("project.export"),
    workspaceId: z.string(),
    source: z.string(),
    dest: z.string(),
    replace: z.boolean().optional(),
    agents: z.array(z.string()).optional(),
  }),
  /** Replies with { view: SealedImageView }. */
  z.object({ id: reqId, op: z.literal("image.get"), name: z.string().optional() }),
  /** Builds this host's image at `place` from the record: prepare there, import the vault, seal. Replies with
   * { build: SealedImageBuilt }; progress rides golden.stage frames carrying `place`. A place that already holds a
   * copy built from this record is answered with that copy and `built: false`, so asking twice costs nothing.
   * Refused (kind "missing") when no place of that name is held, and (kind "conflict") when the place is the one
   * this host forks on, when the place builds no copy at all, when no record exists, when the record was sealed
   * without the recipe it was built from, and when the record holds no vault and `force` is not set. */
  z.object({ id: reqId, op: z.literal("image.build"), place: z.string().min(1), name: z.string().optional(), force: z.boolean().optional() }),
  /** Writes the record and the vault, sealed to the passphrase, to `dest` on this computer. Replies with
   * { exported: SealedImageExport }. The passphrase is never logged and never kept. */
  z.object({ id: reqId, op: z.literal("image.export"), dest: z.string().min(1), passphrase: z.string().min(IMAGE_PASSPHRASE_MIN).max(256), name: z.string().optional() }),
  // A thread's slate: the window's ops and the slate verbs' (packages/protocol/src/slate/wire.ts).
  ...slateOps(),
]);

/** Every request carries where it reached the host from: here, this computer's own app, CLI or MCP, or relayed from
 * a machine. It rides the envelope beside the id rather than each op, so a verb added later carries it without
 * saying so. Absent reads here, and today every client on this computer is here in practice. */
export const RuntimeRequest = z.intersection(RuntimeOp, z.object({ origin: WorkspaceOrigin.optional() }));

/** Every op this host answers, read off the table itself rather than written out beside it, so an op added later
 * cannot be missing from the reading that decides which of them a thread may send. */
export const RUNTIME_OPS: readonly string[] = RuntimeOp.options.map(o => o.shape.op.value);

/** The request fields above that carry a secret: a key, a token, a code, a passphrase, or a record of logins or
 * environment values a person puts keys into. A new field that carries one is added here, beside its schema. */
export const SECRET_REQUEST_FIELDS: readonly string[] = ["token", "key", "rows", "code", "passphrase", "env", "envs", "headers", "sudoPassword"];

/** The secret values a request frame carries, read one level into a record and no deeper: a record of logins is as
 * deep as a secret field goes, and the frame may be a stranger's. */
export function requestSecrets(frame: unknown): string[] {
  if (typeof frame !== "object" || frame === null) return [];
  return SECRET_REQUEST_FIELDS.flatMap(field => {
    const v = (frame as Record<string, unknown>)[field];
    return typeof v === "string" ? [v] : typeof v === "object" && v !== null ? Object.values(v).filter((x): x is string => typeof x === "string") : [];
  });
}

/** The ops a socket holding a thread's own token may send, and the whole of them: the door is shut and these are
 * the openings, so an op added later reaches no thread until somebody puts it here on purpose. A thread opens
 * threads and forks machines under its own root and reads the tree it is in; every reach into a workspace is
 * refused again by the tree rule, and every act by the guard, so this list is the outer door and not the only one.
 * What is deliberately not here: the image, whose manifest holds every version's snapshot and every sign-in sealed
 * into it, since a fork takes the image its own workspace's project runs and names none; sealing that image and
 * rolling its snapshots, the project goldens, the person's keys and their init, their preferences, their folders,
 * importing and exporting a folder, every road that hands out or takes away access to this host, the two roads that
 * move a running turn's access mode or answer a permission prompt, which are the person's guard on an agent and not
 * an agent's to lift, and the daemon channel, which carries the panes a person types into while a thread drives its
 * workspace through workspaces.exec and the session ops. */
export const THREAD_OPS: readonly string[] = [
  "auth",
  "events.subscribe",
  "status.list",
  "status.subscribe",
  // Read ahead of every fork for whether this host forks at all and at which sizes, so the refusal for a host that
  // mints nothing comes in one sentence before any stage is streamed; the wsp command asks it under any token.
  "capabilities.get",
  "workspaces.landing",
  "workspaces.create",
  "workspaces.list",
  // Every verb a thread runs names its workspace as a person does, so the door that reads a name is open to the
  // same tokens the list is: the tree rule refuses the names outside it here exactly as it hides them there.
  "workspaces.resolve",
  "workspaces.get",
  "workspaces.touch",
  "workspaces.wake",
  "workspaces.exec",
  // A thread asks for a worktree of its own project's repo, and takes one wsp made away again.
  "worktree.make",
  "worktree.remove",
  // The checkout a thread's own copy is on, and a commit of its files with a message drafted or its own, under the
  // same tree rule and the same guard; a discard is not here, since an agent has git in its copy.
  "workspaces.checkout",
  "workspaces.commit",
  "workspaces.commitDraft",
  // A thread reads its own pull request's page, asks the agent of a workspace in its tree to fix a check or a
  // conflict, and updates such a copy from its base, under the tree rule and the guard; a merge is not here, since
  // merging is the person's act.
  "workspaces.pullRequestView",
  "workspaces.fix",
  "workspaces.update",
  // A lead merges a child's branch into its own copy under the tree rule and the guard, and only into its own
  // workspace: a child may not merge into its lead.
  "workspaces.mergeIn",
  "harnesses.list",
  "sessions.start",
  "sessions.list",
  "sessions.history",
  "sessions.head",
  "sessions.attachment",
  "sessions.interrupt",
  "sessions.steer",
  "sessions.rename",
  "sessions.read",
  "sessions.search",
  // A thread writes and reads its own slate, and a lead reads a child's; the window's own slate ops are not here.
  "slates.write",
  "slates.state",
  "slates.read",
  "slates.catalog",
];

/** The ops a computer the person paired may send with no role of its own, and the whole of them, for the reason
 * THREAD_OPS is a list: a deny list would let every op added later through by having been forgotten. Read at both
 * doors, the socket and the JSON routes, so a route added later is held by the op it stands for, and a route that
 * names none is held outright. What is here is listing, reading, watching and the management of wsp's own machines
 * and records, which touch no process and no computer of the person's and write this disk only where wsp's own
 * copies land: workspaces.create on a project here runs the copy verb and puts the copy beside the person's
 * folder, open by the owner's ruling. What is not: every op that starts or puts a hand on a process (a start, a
 * steer, a stop, an answer, an access change, a command, a bring back, a pane, and a thread's rename, which runs a
 * shell on the workspace's machine and writes the person's agent session file), every op that adds, changes,
 * dials, sweeps or lands a binary on a computer of the person's or clones onto one, every op that writes keys,
 * builds or seals an image, runs the sign-ins or costs money, and every op that reads or writes this computer's
 * disk outside wsp's own folders. The daemon channel's send and close ride a channel a refused open never gave
 * this socket. A role of the person's is where this list widens, per device. */
export const DEVICE_OPS: readonly string[] = [
  "auth",
  "events.subscribe",
  "status.subscribe",
  "status.list",
  "capabilities.get",
  "ticket.issue",
  "places.list",
  "account.get",
  "devices.list",
  "devices.revoke",
  "workspaces.landing",
  "workspaces.create",
  "folder.make",
  "workspaces.list",
  "workspaces.resolve",
  "workspaces.get",
  "workspaces.nap",
  "workspaces.wake",
  "workspaces.stopWake",
  "workspaces.restartDaemon",
  "workspaces.upgrade",
  "workspaces.updateImage",
  "workspaces.rename",
  "workspaces.look",
  "workspaces.agents",
  "workspaces.delete",
  "workspaces.forget",
  "workspaces.snapshot",
  "workspaces.touch",
  "workspaces.portReach",
  "workspaces.portProbe",
  "workspaces.rebuild",
  "workspaces.checkout",
  "workspaces.viewed",
  "workspaces.pullRequestView",
  "workspaces.pullRequestDiff",
  // A review draft's ticks, verdict and summary are a record on this computer, as a viewed mark is; its post is not
  // here, since posting under the person's name is the person's act.
  "workspaces.reviewDraft",
  "projects.list",
  "projects.defaults",
  "projects.resolve",
  "projects.remove",
  "projectGoldens.list",
  "projectGoldens.remove",
  "sys.subscribe",
  "sys.unsubscribe",
  "harnesses.list",
  "sessions.list",
  "sessions.history",
  "sessions.head",
  "sessions.attachment",
  "sessions.forget",
  "sessions.read",
  "sessions.settle",
  "sessions.mark",
  "sessions.restore",
  "sessions.search",
  "golden.get",
  "image.get",
  "snapshots.list",
  "snapshots.storage",
  "snapshots.rollback",
  "cost.history",
  "cost.spend",
  // The person's own usage and accounts: read on a paired device, never by a thread, which reads no one's accounts.
  "usage.used",
  "usage.accounts",
  "places.readings",
  "forwards.list",
  "forwards.stop",
  "preferences.get",
  "preferences.set",
  "release.get",
  "release.check",
  "host.terminalConfig",
  "init.get",
  // A window on a paired computer draws a slate and writes its values, which start no run and fire no reaction; a
  // press, an approval and a cancel act on the person's computer, so they are not here.
  "slates.get",
  "slates.state",
  "slates.catalog",
  "slates.shown",
  "slates.subscribe",
  "slates.unsubscribe",
  "slates.resolve",
];

/** The one sentence a thread's own token is refused an op with. It names the op rather than guessing why a caller
 * wanted it: the reasons are on the acts, and this is the door saying the op is not a thread's at all. */
export function threadOpRefusal(op: string, threadId: string): string {
  return `${op} is not a thread's to ask for; the token this request came in on is thread ${threadWord(threadId)} on a machine, which opens threads and forks machines under its own root and reads that tree`;
}

/** The workspace an event is about, for the one reading every door that hides a workspace from a caller shares: the
 * id on the event itself, else the id of the record or the status it carries. An event that names none is about
 * this host rather than about any workspace, which is why a caller that may see only its own tree is sent none. */
export function workspaceIdOf(event: unknown): string | undefined {
  const e = event as { workspaceId?: unknown; workspace?: { id?: unknown }; status?: { id?: unknown }; forward?: { workspaceId?: unknown } };
  for (const found of [e.workspaceId, e.workspace?.id, e.status?.id, e.forward?.workspaceId]) if (typeof found === "string") return found;
  return undefined;
}

/** The thread an event is on behalf of, beside the reading above and for the same door: an event about a workspace
 * that has no record yet is nobody's by the reading above, so the caller it was asked for by is named on it. */
export function askerOf(event: unknown): EventAsker | undefined {
  const asked = (event as { askedBy?: { threadId?: unknown; rootThreadId?: unknown } }).askedBy;
  if (typeof asked?.threadId !== "string" || typeof asked.rootThreadId !== "string") return undefined;
  return { threadId: asked.threadId, rootThreadId: asked.rootThreadId };
}
export type RuntimeRequest = z.infer<typeof RuntimeRequest>;

/** What a workspaces.exec pushes to the socket that asked. exitCode is null when the command was ended without
 * one (the socket closed or the launch failed); error says which. */
export const ExecEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exec.output"), execId: z.string(), text: z.string() }),
  z.object({ type: z.literal("exec.exit"), execId: z.string(), exitCode: z.number().int().nullable(), error: z.string().optional() }),
]);
export type ExecEvent = z.infer<typeof ExecEvent>;

export const RuntimeOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
/** `kind` carries a typed failure when the runtime has one (engine WspError
 * kinds such as "concurrency", or "notFirstLife" from a refused seal). */
export const RuntimeErrorResponse = z.object({
  id: reqId.nullable(),
  ok: z.literal(false),
  error: z.string(),
  kind: z.string().optional(),
  /** What to do about it, when the refusal was made with one; `error` already ends with it. */
  fix: z.string().optional(),
});
export const RuntimeResponse = z.union([RuntimeOkResponse, RuntimeErrorResponse]);
export type RuntimeResponse = z.infer<typeof RuntimeResponse>;

// --- session interrupt (what a stop button gets back) -------------------------

/** accepted: the harness was told to stop and the turn ends with status interrupted; for a subagent, the agent took
 * the stop and the child reads stopped once it says so.
 * not-running: the turn, or the subagent, had already ended, so there was nothing to stop.
 * not-found: this runtime holds no such session (sessions live in memory; a restart forgets them).
 * refused and unsupported answer a subagent's stop alone: the agent would not stop that one, or offers no stop of one
 * subagent at all, and `error` says which in words.
 * None of these is an error reply: a stop button has nothing to recover from. */
export const SessionInterruptOutcome = z.enum(["accepted", "not-running", "not-found", "refused", "unsupported"]);
export type SessionInterruptOutcome = z.infer<typeof SessionInterruptOutcome>;
export const SessionInterruptResult = z.object({
  outcome: SessionInterruptOutcome,
  /** The threads under this one that were running and were stopped with it, by id: a root thread and the tree its
   * agents spawned stop as one, since a lead left standing while its builders are cut is neither state. Absent
   * where the thread spawned none that were running. */
  under: z.array(z.string()).optional(),
  /** The words for a refused or unsupported stop of a subagent. */
  error: z.string().optional(),
});
export type SessionInterruptResult = z.infer<typeof SessionInterruptResult>;

/** What a stop of one subagent the agent refused says, in the agent's own words; the line it stands in names the task. */
export const taskStopRefusedLine = (agent: string, why: string): string => `${agent} would not stop it: ${why}`;
/** What a stop of one subagent says where the agent offers none. */
export const taskStopUnsupportedLine = (agent: string): string => `Stop is not available for ${agent} subagents; stop the thread to stop them all`;

// --- session steer (what send-now on a queued row gets back) -------------------

/** accepted: the harness took the message into the running turn and a session.steer event carries it.
 * not-running: the turn had ended, or had not started, when the message was offered; the caller starts a turn instead.
 * unsupported: the session's harness takes no message mid-turn (its catalog says steers: false).
 * not-found: this runtime holds no such session. None is an error reply. */
export const SessionSteerOutcome = z.enum(["accepted", "not-running", "unsupported", "not-found"]);
export type SessionSteerOutcome = z.infer<typeof SessionSteerOutcome>;
export const SessionSteerResult = z.object({ outcome: SessionSteerOutcome });
export type SessionSteerResult = z.infer<typeof SessionSteerResult>;

// --- session access (what a pick made while a turn runs gets back) ---------------------

/** The thread's record takes the mode on every answer but not-found, so its next turn runs at it whichever comes
 * back. set: the thread is at the mode now; on a running turn from its next tool call and on the prompt it was
 * stopped on where that mode answers one, a harness whose CLI takes the change only at launch set too by its
 * adapter answering that turn's prompts itself; on a thread between turns, from its next turn. unsupported: the
 * turn running now takes no access change and nothing could stand in for it, so it keeps the mode it started at
 * and the next turn runs at the pick. not-running: the running turn's process is gone before the pick reached it.
 * not-found: this runtime holds no such session. None is an error reply, as a mode the harness's own list does not
 * carry is. */
export const SessionAccessOutcome = z.enum(["set", "not-running", "unsupported", "not-found"]);
export type SessionAccessOutcome = z.infer<typeof SessionAccessOutcome>;
export const SessionAccessResult = z.object({ outcome: SessionAccessOutcome });
export type SessionAccessResult = z.infer<typeof SessionAccessResult>;

// --- session answer (what picking an option on a relayed permission prompt gets back) --

/** answered: the harness took the answer and the tool call it blocks ran or was refused as the option says, and a
 * session.permission.closed event carries it. gone: no such prompt is open on that session, so it was answered
 * already, withdrawn by the harness, or its turn is over; the row closes on that event, not on this reply.
 * unsupported: the session's harness raises no prompt this host can answer. not-found: this runtime holds no such
 * session. no-option: the prompt is open and carries no option by that id. None is an error reply. */
export const SessionAnswerOutcome = z.enum(["answered", "gone", "unsupported", "not-found", "no-option"]);
export type SessionAnswerOutcome = z.infer<typeof SessionAnswerOutcome>;
export const SessionAnswerResult = z.object({ outcome: SessionAnswerOutcome });
export type SessionAnswerResult = z.infer<typeof SessionAnswerResult>;

// --- session rename (what a name a person typed came to in the harness's store) -

/** renamed: the harness's store took the name, in the field the harness itself writes, and the thread's rows carry
 * it. unsupported: the session's harness keeps no name of a person's, so nothing was written and nothing would have
 * survived its next turn. no-session: the store answered and holds no such session, or the harness never announced
 * one for this thread. failed: the store was there and refused the write, and `error` is the line the machine gave
 * for it. not-found: this runtime holds no such session. None is an error reply. */
export const SessionRenameOutcome = z.enum(["renamed", "unsupported", "no-session", "failed", "not-found"]);
export type SessionRenameOutcome = z.infer<typeof SessionRenameOutcome>;
export const SessionRenameResult = z.object({ outcome: SessionRenameOutcome, error: z.string().optional() });
export type SessionRenameResult = z.infer<typeof SessionRenameResult>;

/** One thread whose words hold the query: the thread by the runtime's id and the workspace it runs on, and the words
 * around the first place they hold it, on one line. */
export const SessionSearchHit = z.object({ workspaceId: z.string(), threadId: z.string(), snippet: z.string() });
export type SessionSearchHit = z.infer<typeof SessionSearchHit>;
export const SessionSearchResult = z.object({ hits: z.array(SessionSearchHit) });
export type SessionSearchResult = z.infer<typeof SessionSearchResult>;

/** The harness's answer to a side question, which the host keeps nowhere. */
export const SessionAsideResult = z.object({ text: z.string() });
export type SessionAsideResult = z.infer<typeof SessionAsideResult>;
/** What a rewind did: how many turns left the conversation, and how many files the copy's tree wrote or removed
 * where the files went back too. */
/** What a rewind did: the turns it cut, the files it put back, and why it left the files where they stood. */
export const SessionRewindResult = z.object({ turns: z.number().int(), files: z.number().int().optional(), kept: z.string().optional() });
export type SessionRewindResult = z.infer<typeof SessionRewindResult>;

// --- session start (how the turn the caller asked for came to be) --------------

/** started: a turn of its own began. steered: the thread's turn was running and took the message mid-way, so
 * session is that turn and a session.steer event carries the message. queued: the thread's turn was running and could
 * not take a message, so this start waited for it to end and then began. The reply comes back once the turn began.
 * turnId is the turn's, as its events carry it: a follower keys on it, since the thread's earlier turns share the
 * session row. */
export const SessionStartOutcome = z.enum(["started", "steered", "queued"]);
export type SessionStartOutcome = z.infer<typeof SessionStartOutcome>;
export const SessionStartResult = z.object({ session: SessionView, outcome: SessionStartOutcome, turnId: z.string() });
export type SessionStartResult = z.infer<typeof SessionStartResult>;

export { hereName, isHere, isProviderPlace, placeName, placeOf, workspaceComputerName } from "./place-name.js";
export { needsYouLine, subagentStateWord, threadNeedsYou, threadSeen, threadSettled, threadState, threadStateWord, threadUnread, threadUnseenAt, threadWordOf, waitingLine, type SettleFacts, type ThreadState } from "./thread-state.js";
export { AGENTS_ON, CLOUD_CAP_DEFAULT, NAP_AFTER_MAX_MS, NAP_AFTER_MS, phaseHoldsSlot, placeAtLimitLine, placeCapOf, placeFullLine, placeSetRefusal, placeSettingDropped, placeSettingNamed, placeSettingsLine, placeTakes, settingFor, napMsOf, placeRoom, placeSpendLimit, runningOn, THREAD_MEM_MB, threadsAtOnce, workspacePlace, workspacePlaceId, type PlacedThread, type PlacedWorkspace, placeTurnLimit, TURN_LIMIT_MAX_MS, TURN_WALL_MS, turnLimitMsOf } from "./place-state.js";
export { launchHasSlate, MCP_SERVER_NAME, SLATE_BRIEF, SLATE_SERVER_NAME, SLATE_TOOLS, threadsFollowed, WSP_TOOL_TIMEOUT_SEC } from "./wsp-tools.js";
export { type AbsentComputer, type AwayWord, absentComputer, actionRefusal, daemonSilent, ownDaemonDown, START_DAEMON_WORD, agentsKindRefusal, agentsMayDrive, awayMsOf, composerHeldLine, type CopyToDelete, deleteCopiesNotice, deleteNotice, unpushedLine, onDeleteOf, type StandsOn, UNNAMED_COMPUTER, goneRefusal, COMPUTER_LEFT, pausedOrPausing, notAnsweringYet, screenCommandLine, type ImageMoveInput, imageMoveRefusal, isBilling, isLocalWorkspace, turnSpendWord, type KindReading, kindWords, readingRoad, type ReadingRoad, type MachineOnDelete, machineWord, needsRebuild, FORGET_NEEDS_GONE, goneRoadRefusal, reachShown, SEND_BLOCK_WORDS, type SendBlock, sendRefusal, signInRefusalLine, signInRoad, type SendRefusalKind, servesReading, WORKSPACE_KIND_WORDS, workspaceKind, type WorkspaceKindWords, workspaceState, type WorkspaceState, type WorkspaceStateInput, whereWord, workspaceStateLine, workspaceStateOf, workspaceWord, type AbsentRoad, type AbsentRoadInput, absentRoad, BACK_OVER_SSH, backUrl, dialsBackWord, linkedOver, lastKnown, REPORTED_WORD, placeDialLine, placeNoDialLine, placeDialRoad, sshRoadOf, type PlaceDialRoad } from "./workspace-state.js";
export * from "./agents-report.js";
export * from "./project-look.js";
export { contextWindowsFor, effortsFor, everyModel, listedPick, markedDefault, modelOf } from "./harness-picks.js";
export * from "./thread-defaults.js";
export * from "./exit.js";
export * from "./format.js";
export { psCpuSeconds } from "./ps-time.js";
export { compareVersions } from "./semver.mjs";
export { attachedFilesPrompt, Attachment, attachmentBytes, attachmentKey, attachmentLine, AttachmentRecord, attachmentRecord, KeptAttachment, FILE_MAX_BYTES, FILE_MAX_WORDS, FILES_AFTER_TURN, FILES_DIR, FILES_MAX, filePathIn, filesBlocked, filesNotLandedLine, filesRefusal, IMAGE_MAX_BYTES, IMAGE_MAX_WORDS, IMAGE_TYPES, IMAGE_TYPE_WORDS, imagePathIn, imageTypeOf, isImage, dropFilesLine, landFilesLine, noImagesLine, notAFileLine, safeFileName, sendFilesDir, threadFilesDir, turnImagesDir, UNTYPED_FILE } from "./attachments.js";
export * from "./oom.js";
export { accruedAt, accruedPast, appendCostPoint, COST_HISTORY_CAP, dayStart, monthStart, rateAt, spentSince } from "./cost-history.js";
export { leadAsk, openAsk, THREAD_SEED_CHARS, ThreadMessage, threadMarkdown, threadMessages, threadReplyRows, threadResult, threadSeed, ThreadVoice } from "./thread-read.js";
export { escapeRegExp } from "./regexp.js";
export { inFolder, shellLine, shellQuote } from "./shell-quote.js";
export {
  DEFAULT_THEME,
  INK_FLOOR,
  LOOK_PARTS,
  SIDE_INK,
  THEME_GRAIN_STEPS,
  THEME_HARMONIES,
  THEME_MAX_DOTS,
  THEME_MIN_OPACITY,
  THEME_PRESETS,
  WORD_FLOOR,
  ThemeDot,
  ThemeHarmony,
  ThemeMode,
  WORKSPACE_GLYPHS,
  WorkspaceGlyph,
  WorkspaceLook,
  WorkspaceTheme,
  applyPreset,
  contrastRatio,
  cycleHarmony,
  dotColour,
  effectiveOpacity,
  harmoniesOf,
  harmonyDots,
  harmonySize,
  hslToRgb,
  isPreset,
  moveFirstDot,
  opacityCap,
  resizeDots,
  rgbToHsl,
  snapGrain,
  themeInk,
  themeScheme,
  type LookPart,
  type Rgb,
  type ThemePreset,
} from "./workspace-look.js";
export { claudeMemoryDir, claudeProjectKey, folderName, folderSlug, hiddenFolder, parentFolderName, placeDaemonPaths, placeOwnedPaths, placeProvisionPaths, probePath, rootsPathIn, SSH_ALIAS_PREFIX, sshAlias, standInMachinePath, standInRecordsPath, underProject, workFolderIn, type FolderMachine } from "./project-path.js";
export * from "./bring-back.js";
export * from "./changes.js";
export * from "./usage.js";
export * from "./general-prefs.js";
export * from "./plan-alerts.js";
export * from "./outside-line.js";
export * from "./pull-request.js";
export * from "./run-block.js";
export * from "./tree.js";
export * from "./start.js";
export * from "./daemon-contract.js";
export * from "./projects.js";
export * from "./recipe-file.js";
export { defaultSeedChoice, leftBehindLine, neverTravelsLine, noRemoteLine, notInTheMenuLine, SEED_DIR, SEED_MEMORY_DIR, SEED_PATCH, seedBytes, seedChoiceFrom, seedCommitsLandedLine, seedCommitsLostLine, seedConsentLines, seedingLine, seedMenuRows, seedRowWords, seedSummaryLines } from "./project-seed.js";
export { agentsRequest, canTravel, consentRequest, defaultAgents, defaultConsent, importConsented, importRequest, secretOffer, type ImportAnswers, type ProjectImportRequest } from "./project-import.js";
export { addressFromHash, addressFromLink, appHash, linkFromHash, linkHash, openingHash, pairingCodeOf, workspaceHash, LINK_KINDS, type AppAddress, type LinkKind, type LinkTarget } from "./app-address.js";
export * from "./app-ports.js";
export * from "./release.js";
export * from "./init-job.js";
export { catalogRefused, endAfterResult, endRun, launchWords, PERMISSION_ALLOW, PERMISSION_DENY, programWord } from "./adapter-port.js";
export { keepRun } from "./kept-run.js";
export type { KeptAgent, KeptRun, KeptTurn } from "./kept-run.js";
export { ANALYTICS_ENV, CLOUD_ENV, LAUNCH_ENV, NO_SLATE_MCP_ARG, SCOPED_MCP_ARG, FAKE_AS_ENV, FAKE_RECORDS_ENV, FAKE_ROOT_ENV, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, LABS_ENV, PERSON_HOME_ENV, RELEASE_API_ENV, TURN_TOKEN_ENV, UPDATE_CHECK_ENV, WEB_DIR_ENV, STATE_STORE_ENV } from "./env.js";
export type { AdapterAttachOptions, AdapterEvent, AgentLaunch, AsideAnswer, AsideQuestion, AttachmentRoad, CommitDrafter, DraftAsk, ExecStream, ExecStreamFactory, HarnessCatalogAnswer, HarnessCatalogModelProbe, HarnessCatalogProbe, HarnessCatalogRefusal, PermissionAsk, PlanResets, ResetReading, ResetRoad, ResetSpend, SessionAsker, SessionRenameWrite, SessionRenamer, SessionTitleMaker, SessionTitleReader, TaskStop, TitleTurn, TurnImage, SessionReverter } from "./adapter-port.js";
export * from "./slate/index.js";
export * from "./slate/wire.js";
