import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve as resolvePathOn } from "node:path";
import { CARRIED_DIR_NAMES, CATALOG_AGENTS, DEFAULT_AGENT, GUEST_HOME, type ThreadAgent, TOOL_PREFIX, catalogIdOfRow, gitHostOf, remoteHost, serverValuesOf, guestEnv, installEnv, installHomes, loginHomeIn, sharedOn } from "@wsp/catalog";
import {
  BUILDER_IDLE_MS,
  DAEMON_PORT,
  INLINE_EXEC_MS,
  MachineUnreachableError,
  MoveUnansweredError,
  NotFirstLifeError,
  ResumeUnansweredError,
  SnapshotFailedError,
  BUILDER_LABEL,
  CREATED_AT_LABEL,
  GOLDEN_LABEL,
  NAME_LABEL,
  OWNER_LABEL,
  SMOKE_LABEL,
  WORKSPACE_LABEL,
  WSP_LABEL,
  lostWorkspace,
  Workspace,
  buildGolden,
  destExists,
  exportFolder,
  exportPaths,
  exportPathsInto,
  goldenHead,
  imageHash,
  importImageVault,
  refuseForeignMembers,
  importInto,
  isMissing,
  NapRefusedError,
  StopRefusedError,
  installScript,
  INSTALL_MS,
  landBundle,
  landBytes,
  tarOf,
  parseMergeOutput,
  plural,
  recipeHash,
  agentHomes,
  agentsOnMachine,
  guestAgentHomes,
  guestTmpPath,
  parseStateListing,
  projectInstalls,
  stateListing,
  killUntilGone,
  readGone,
  sightMachine,
  type Sighting,
  GoneWatch,
  snapshotUntilGone,
  MachineAliveError,
  answerOf,
  diskUse,
  prepareBuilder,
  reap,
  refreshPreviewToken,
  promoteVersion,
  sealGolden,
  goldenName,
  projectSnapshotName,
  splitByOwner,
  snapshotMonthlyUsd,
  templatesOf,
  applyDelta,
  applyGoldenImport,
  upgradeBuilder,
  nextSetupSha,
  readOwnedFiles,
  upgradePlan,
  type UpgradePlan,
  type Builder,
  type BuildGoldenOptions,
  type CacheRule,
  type GoldenDelta,
  type GoldenImport,
  type ImportLedger,
  type SealResult,
  type ExecResult,
  type GoldenManifest,
  type GoldenVersion,
  type KillConfirm,
  type ListedMachine,
  type Lifecycle,
  type Machine,
  type MachineBackend,
  type MachineKind,
  type MachineShape,
  type MachineSpec,
  type MachineState,
  type PreviewReach,
  type ReapFailure,
  type ReapResult,
  type ReapedMachine,
  type RunOptions,
  type RetentionPlan,
  type SnapshotRow,
  type TemplateRow,
  type UnreadStore,
  type VaultOptions,
  type WspError,
  type WorkspaceHooks,
  type WorkspacePhase as EnginePhase,
  retentionPlan,
  rollback as rollbackGolden,
  snapshotStorage,
  applyMachineContext,
  MEM_READ,
  memMbOf,
  readValues,
  GUEST_TMP,
  GUEST_USER_ENV,
  landsBytes,
  LOCAL_MACHINE_ID,
  TOOLS_PATH,
  DiskSyncError,
  syncDisk,
  DISK_USE_CMD,
  diskUsePct,
} from "@wsp/engine";
import { AGENT_KEEP_MS, AGENTS_KEPT, type KeptAgent } from "@wsp/protocol";
import type { AgentsReport, AgentsSignInEvent, AgentsTarget, DaemonFrame, DaemonResponse, EditorChoice, EditorId, RecipeFile, RecipeOptions, ServerAdd, ServerAsk, ServerToolsAnswer, SignInLine, SkillAdded, SkillHit, SkillPreview } from "@wsp/protocol";
import type {
  AdapterAttachOptions,
  AdapterEvent,
  AttachmentRoad,
  Capabilities,
  DaemonEvent,
  DaemonReachView,
  EventUnion,
  ExecStream,
  ExecStreamFactory,
  GoldenBaseTool,
  GoldenBuilderView,
  GoldenLogin,
  GoldenStage,
  GoldenStep,
  HarnessCatalog,
  HarnessCatalogAnswer,
  HostFolderListing,
  InitJob,
  InitJobEvent,
  InitNeedsYouEvent,
  InitRoad,
  InitScreenId,
  InitSetup,
  Preferences,
  PreferencesPatch,
  Recipe,
  RecipeDigest,
  SealedImage,
  SealedImageBuilt,
  SealedImageCopy,
  SealedImageView,
  SealedProjectImage,
  SealedVault,
  ScreenCommand,
  TerminalConfig,
  TerminalScheme,
  PortProbeView,
  PortReachView,
  ProjectAddStage,
  ProjectAgentOutcome,
  ProjectAgentResult,
  ProjectExportResult,
  ProjectExportStage,
  ProjectGolden,
  ProjectGoldenRemoved,
  ProjectImportResult,
  ProjectRef,
  ProjectSource,
  ProjectView,
  ProjectImportStage,
  ProjectPlan,
  MachineBind,
  SeedChoice,
  SeedPlan,
  WorkspaceCopy,
  PermissionAsk,
  PermissionOption,
  PermissionOutcome,
  ReachState,
  SessionEvent,
  SessionAccessResult,
  SessionAnswerResult,
  SessionInterruptOutcome,
  SessionInterruptResult,
  SessionRenameResult,
  SessionRenameWrite,
  SessionRenamer,
  SessionStartOutcome,
  SessionSteerResult,
  SessionOrigin,
  SessionAsker,
  SessionAsideResult,
  SessionRewindResult,
  SessionReverter,
  SessionTitleMaker,
  SessionTitleReader,
  SessionSearchResult,
  SessionView,
  StartPicks,
  ThreadMarks,
  TitleSource,
  SnapshotStorage,
  Attachment,
  AttachmentRecord,
  McpServerSpec,
  TurnImage,
  TurnResult,
  TurnStatus,
  SysSample,
  UpgradeResult,
  WorkspaceCostEvent,
  WorkspaceCreateStage,
  Caller,
  WorkspaceAgents,
  WorkspaceKind,
  PlaceSettings,
  WorkspaceLook,
  WorkspacePhase,
  WorkspaceProject,
  WorkspaceSize,
  WorkspaceStatus,
  WorkspaceView,
  WorkspaceCreatingEvent,
} from "@wsp/protocol";
import { cloneLines, PROJECT_LANDINGS, projectLanding, type Landed, type LandingDeps, type ProjectLanding } from "./project-landing.js";
import { projectRemote, projectSource } from "./project-sources.js";
import { vaultUnlistedRefusal, ThreadPlacement, ThreadScope, WorkspaceOrigin, branchUnreadRefusal, noParentWorkspaceLine, parentProjectRefusal, BringBackResult, GitPrReply, GitPushReply, GitCommitReply, GitDiscardReply, GitDiffReply, GitStatusReply, GitPrReadReply, GitPrViewReply, GitRunLogReply, GitPrMergeReply, GitRepoReadReply, GitUpdateReply, GitStartOnReply, GitBranchCompareReply, GitMergeInReply, DETACHED_HEAD, leadBusyRefusal, childStartedLine, forkNeedsPushLine, FIX_CHECK_OR_CHILD, childOnNoBranchRefusal, mergeChildPrompt, mergeIntoOwnRefusal, noRemoteForTreeLine, notTheLeadsChildRefusal, pushedForChildLine, uncommittedStayed, type MergeInResult, type TreeChild, type TreeFact, type TreeRecord, PR_POLL_MS, type PullRequestPage, GitPrReplyReply, GitPrResolveReply, GitPrReactReply, REPLY_EMPTY_LINE, pullRequestPostLine, type ReactionContent, type PullRequestItem, type PullRequestSendResult, type PullRequestSent, GIT_DIFF_CAP_BYTES, pullRequestSendPrompt, checkFailedPrompt, conflictsPrompt, checkNotFailedRefusal, childPushedLine, isPullRequestFact, mergeMethodRefusal, noPullRequestRefusal, noSuchCheckRefusal, notOpenRefusal, pullRequestStoppedLine, pullRequestUnreadLine, AUTO_MERGE_OFF_LINE, type FixResult, type MergeMethod, type MergeResult, type PullRequestFact, type PullRequestRecord, type PullRequestSeen, DRAFT_NOTES, cleanCheckoutLine, commitMessage, cutDiff, draftPrompt, type Checkout, type CheckoutReply, type CommitDraft, type CommitDrafter, type ViewedMarks, agentsFrom, foldThreads, NAP_AFTER_MS, settingFor, runningOn as runningOnPlace, phaseHoldsSlot, placeAtLimitLine, placeSpendLimit, spendCapRefusal, agentsKindRefusal, agentsMayDrive, askerOf, MCP_SERVER_NAME, threadForgetRefusal, threadKeyOf, threadRan, threadWord, threadsFollowed, SPAWN_ACTS_ALLOWED, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, SCOPED_MCP_ARG, agentsOffRefusal, roadOf, scopeOf, spawnActRefusal, spawnCapRefusal, spawnGoldenRefusal, spawnDepthRefusal, spawnProjectRefusal, spawnReachRefusal, workspaceIdOf, type SpawnAct, type ThreadWaitingOn, RUN_PERSONS_LINE, runOutputTail, type RunStep, type SessionRunEvent, NO_SLATE_MCP_ARG, PR_POLL_IDLE_MS } from "@wsp/protocol";
import { ASIDE_NO_SESSION_LINE, BLANK_ASIDE_LINE, asideUnsupportedLine, PLACE_WORKSPACE_PATH, THIS_COMPUTER, COPY_BUILD_FIX, copyAsksSignIns, refusal, copyFirstLine, isLocalWorkspace, imageCarriesCheckout, addedProjectOn, addingProjectLine, hereDaemonBehindLine, DAEMON_TOKEN_PATH, recipePins, mcpServersBlocked, actionRefusal, buildsImages, copyBuildOf, copyIsCurrent, type CopyBuild, forksNoMachines, IDLE_REASON, kindWords, readingRoad, namesSize, NO_PROVIDER_LINE, providerCannotRefusal, ALREADY_APPLIED, ALREADY_RUNNING, applyPreferencesPatch, serverIconsLeftLine, homeShortened, BLANK_NAME_REFUSAL, catalogRefused, CREATE_READY, DAEMON_INSTALL_FAILED, DAEMON_INSTALLING, DAEMON_RESTART_FAILED, DAEMON_RESTARTING, DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DAEMON_VERSION, EMPTY_TITLE_LINE, threadRunsOnLine, fmtBytes, fmtDuration, folderName, forgetUndrivenRefusal, goldenImage, goneRefusal, goneWords, HOSTNAME_KEPT, hostnameSetLine, imageMoveRefusal, imagePathIn, inFolder, labsFromEnv, leadAsk, listedPick, everyModel, effortsFor, modelOf, machineCapRefusal, machineLacksLine, machineNeverAnswered, machineWord, napRefusedLine, NO_IMAGE_YET, nameDeletingRefusal, nameTakenRefusal, deleteRefusedLine, snapshotRefusedLine, NO_SUCH_TURN, noAdapterLine, noKindLine, noWorkspaceRefusal, ID_PREFIX_MIN, idPrefixRefusal, notFoundRefusal, NOT_GONE, GONE_UNCHECKED, goneUnconfirmedLine, type GoneSeenBy, NOTIFY_ME, notifyLine, offeredSize, askingLine, permissionModeOptionLabel, pickedOptions, preferencesFrom, RECORD_RESTORED, RESUME_UNANSWERED, refusalLine, registeredLine, REGISTERING_LINE, claudeMemoryDir, claudeProjectKey, folderOnCopyRefusal, cloneFailedLine, cloneIntoNeeded, cloneIntoTakenLine, cloneUrlRefusal, intoIsHereLine, INTO_TAKES_A_REPO_LINE, noComputerForSourceLine, bareNoSuchProjectLine, noSuchProjectLine, NAME_A_PROJECT_LINE, BRANCH_OR_CWD_LINE, notOnThisComputerLine, cwdOutsideLine, noCwdLine, noBranchesLine, notMadeWorktreeLine, THREAD_WORKING_LINE, threadOnMachineLine, OLD_COPY_WORDS, ProjectCopy, WORKTREE_BUSY_LINE, WORKTREE_FORCE_LINE, PR_BEHIND_WORDS, worktreeChangedLine, keptChangedLine, KEPT_RUNNING_LINE, KEPT_ABANDONED_LINE, type WorktreeFolder, type WorktreeSettled, type WorktreeMade, leftBehindLine, projectInUseRefusal, projectNameOf, seedChoiceNeeded, sameSourceRefusal, sourceKind, projectSourceOf, bareFolder, copiesFolder, copyTakesNone, kindForComputer, DEVICE_OPS, relayedRecordRefusal, relayedRefusal, RUN_GONE_LINE, sendRefusal, shellLine, shellQuote, signInRefusalLine, SIZE_PICK_FIX, sizeGotLine, sizeRefusal, sizeWord, startingLine, startPicks, storedTitleSource, titleLine, TURN_TOKEN_ENV, turnImagesDir, underProject, undrivenRefusal, WAKE_STOPPED, wakeAskingAgainLine, wakeAsksIn, wakeGaveUpLine, workspaceState, absentComputer, buildPlaceAskLine, HERE_PLACE_ID, isJoinedComputer, NO_BUILD_PLACE_LINE, noSuchPlaceRefusal, noProjectImageLine, projectImageInUseRefusal, projectImageRefusedLine, projectImageStillListedLine, placeBuildsNoImageLine, placeForksNothingPickLine, placeForksNowhereLine, placeHoldsNoImageLine, placeBlocked, placeWatchesItselfLine, forkProcsUnreadLine, forkOpRefusedLine, placeDaemonPaths, placeDialBackLine, placeWentAwayLine, placeServesDaemonLine, placeNotAWorkspaceLine, placeNotAWorkspaceFix, workspacePlace, workFolderIn, workspaceLands, REWIND_LATEST_LINE, REWIND_NO_CHECKPOINT_LINE, REWIND_NO_UNDO_LINE, REWIND_SHARED_LINE, REWIND_WORKING_LINE, rewindBesideLine, rewindChildrenLine, rewindKeptLine, rewindNoAnchorLine, attachmentRecord, attachmentKey, type KeptAttachment, filesBlocked, isImage, sendFilesDir, filePathIn, landFilesLine, filesNotLandedLine, attachedFilesPrompt, dropFilesLine, PERMISSION_DENIED_LINE, deniedLine } from "@wsp/protocol";
import { agentsReads, type AgentsActs, type AgentsReader, type CallbackForwards, type ServerIcons, type ServersActs, type SignInAsk, type SkillAsk, type SkillsActs } from "./agents-read.js";
import { groupExists } from "./local-exec.js";
import { openDaemonChannel, type DaemonChannel, type DaemonChannelOptions } from "./daemon-channel.js";
import { templateHost } from "./host-id.js";
import { machineExecStream, type MachineExecOptions, type TurnWaiting } from "./machine-exec.js";
import { GITHUB_TOKEN_ENV, isNoProvider, isPlaceAbsent, projectStateKey, putFiles, type Copier } from "@wsp/engine";
import { baseModel, boxFullLine, DISK_FULL_PCT, diskFullLine, stopRefusedLine, threadMessages, threadSeed, workspaceMemMb } from "@wsp/protocol";
import { holdsRepo, ownerRepoOf, projectForRepo, seedChoiceFrom } from "@wsp/protocol";
import { taskStopRefusedLine, taskStopUnsupportedLine, type SubagentView, type TaskStop } from "@wsp/protocol";
import { accessMode, accessRefusal, accessWordRefusal, agentOffLine, configDirLaunchRefusal, configDirRefusal, markedFor, modelIdRefusal, openDefaults, resolveThreadDefaults, setupView, shapeModels, withCustomModels, type AccessChoice, type AgentLaunch, type AgentRow, type AgentSetupSet, type ProjectOverrides, pickRefusal, type ResolvedFolder, type ThreadDefaults } from "@wsp/protocol";
import { agentSetups, keyOf, realFolderHere, realFolderScript } from "./agent-setup.js";
import { realClock, type Clock } from "./clock.js";
import { writeDaemonRootsScript } from "./daemon-roots.js";
import { assertTokenShape, daemonTokenFor, daemonTokenPathOf, rotateDaemonToken } from "./daemon-token.js";
import { backstopMs, createIdlePolicy } from "./idle.js";
import { connectDaemon, type DaemonReach } from "./reach.js";
import { POLL_INTERVAL_MS, createStatusTracker, machineStateOf, phaseLeavingGone, providerSaid, type StatusApi, type StatusListOptions, type StatusWatchOptions } from "./status.js";
import { makeDevices, type DeviceDoor, type ScopedRoad } from "./devices.js";
import { makePlaceDoor, NO_PLACE_DOOR, PlaceForksNowhereError, PlaceProvisioningError, type PlaceDoor, type PlaceRecord, type PlaceWiring } from "./places.js";
import type { BlobMark, Store } from "./store.js";
import { memoryGitHubCache, type GitHubCache } from "./github-cache.js";
import { RANGE_DAYS, READINGS_STEP_MS, SysHistoryReply, resetNoLoginsLine, type ReadingsAnswer, type PlaceView, type AccountsAnswer, type AgentSignInState, type ResetAnswer, type UsageRange, type UsageSplit, type UsedAnswer } from "@wsp/protocol";
import { HARNESS_CATALOGS, catalogFromProbe, harnessCatalog, modelLabel, smallestModel } from "./harness-catalog.js";
import {
  GitIssueReadReply,
  GitPrDiffReply,
  GitPrReviewReply,
  START_WORDS,
  fromTaskPrompt,
  githubLinkOf,
  isReviewRead,
  lineInDiff,
  reviewFromReply,
  reviewReaskPrompt,
  reviewTaskPrompt,
  startName,
  takenNameAfter,
  withCloses,
  type IssueRead,
  PullRequest,
  type ReviewDraft,
  type ReviewPostResult,
  type ReviewVerdict,
  type StartResult,
  type WorkspaceFrom,
  SETTLE_MS,
  threadSettled,
} from "@wsp/protocol";
import { PLAN_RESETS, secretsOf } from "./adapters.js";
import { accountOf, accountOnComputer, accountRows, createBurn, createPriceTable, createUsageLedger, resetDetailsDue, usageComputerName, type Vaulted } from "./usage.js";
import { planAlerts } from "./plan-alerts.js";
import { HEAD_BYTES, HISTORY_PAGE_BYTES, HISTORY_PAGE_EVENTS, type HistoryPage, type ThreadFacts, type ThreadHead } from "@wsp/protocol";
import type { EventSize, TranscriptRows } from "./sqlite-transcripts.js";
import { eventBytes, headShape, numbered, pickNewest, readThread, type TranscriptReader } from "./transcript-reader.js";
import { usageResets, type ResetPlace } from "./usage-reset.js";
import { loginEnvOn, type HarnessSession, type HarnessAdapter, type StartPicksAsked } from "./types/harness.js";
import { SLATE_PR_POLL_MS, CATALOG_TTL_MS, CATALOG_PROBE_TIMEOUT_MS, SESSION_TITLE_TTL_MS, CHECKOUT_TTL_MS, PR_PAGE_HOLD_MS, RATE_LIMIT_HOLD_MS, SESSION_TITLE_TIMEOUT_MS, SESSION_TITLE_REFRESH_MAX, TITLE_MAKE_TIMEOUT_MS, eventBus } from "./types/events.js";
import { type WorkspaceSpec, type CreatedWorkspace, type CreateWorkspaceOptions, type PackedState, type LandRequest, type ProjectImportOptions, type WorkspaceRecord, type LiveWorkspace, type StageReport, type SessionHandle, type PlaceBackends, wiredPlace, type GoldenRecipe, type GoldenExec, type SeedWiring, type RuntimeOptions, PROVIDER_READ_MS, GONE_CONFIRM_MS, type GoneOutcome, type FoundMachine, settled, WAKE_LATE_READ_MS, DAEMON_HELLO_TIMEOUT_MS, PORT_PROBE_TIMEOUT_MS, CLONE_MS, ADD_IS_A_COMPUTER_LINE, folderNamed, sameSource, NO_COPIER_HERE, lastLineOf, outcomeWords, LISTING_DEADLINE_MS, mergeOnMachine, homeOutcome, PORT_PROBE_BODY_CAP, VAULT_CAP_BYTES, VAULTS, until, shapeFault, VAULT_SKIP, setHostname, type GoldenPromotion, GRACE_MS, DAEMON_REVIVE_AGAIN_MS, DAEMON_LACKS_AGAIN_MS, type AdoptedMachine, type SweepResult, LOG_READ_EVERY_MS, RESET_EXEC_MS, type UsageDoor } from "./types/wiring.js";
import type { Runtime, OrphansDeleted } from "./types/api.js";
import { WORKSPACES, PROJECTS, SEED_CHOICES, GOLDENS, GOLDEN_RECIPES, PROJECT_GOLDENS, IMAGES, NO_COPY_RECIPE, NO_SEED_WIRING, IMAGE_VAULTS, copyKey, copyKeyParts, recipeKey, vaultKey, TRANSCRIPTS, TRANSCRIPT_HEADS, TRANSCRIPT_INDEX, ATTACHMENTS, ATTACHMENT_KEYS, SESSIONS, WORKSPACE_NAMES, DROPPED, DROPPED_WATCH_MS, PREFERENCES, PREFERENCES_ID, READS, READS_ID, PAUSED_REASON, DELETED_REASON, RESTARTED_REASON, GONE_REASON, goneLogLine, sweptRunsLogLine, noTitleLogLine, noMadeTitleLogLine, noCheckpointLogLine, noNameWriteLogLine, restartCutLine, DAEMON_TOKEN_MISS_TTL_MS, TRANSCRIPT_CAP, TRANSCRIPT_BYTES, TOOL_RESULT_KEPT, TRANSCRIPTS_HELD, PENDING_FLUSH_BYTES, MAX_TIMER_MS, type TranscriptIndex, type Taken, transcriptUnreadLine, emptyIndex, forgetChild, foldEvent, indexOf, type TurnWritten, turnWritten, indexBytes, indexRead, snippetAround, SESSION_INDEX_CAP, TRANSCRIPT_FLUSH_MS, type NamedWorkspace, type DroppedMachine, type TranscriptRecord, type TurnLive, type TurnAsked, KEPT_CLOSE_WAIT_MS, type KeptProcess, type KeptLaunch, launchesAs, stampSessionFile, sameSessionFile, readAsked, readScope, readRoad, type ThreadRecord, type SessionIndexRecord, BUILDERS, OWNER, CREATES, KEY_PURPOSE_MAX, type PendingCreate, fingerprint, HELD_TTL_MS, HEARTBEAT_MS, isCapRefusal, pidAlive, type BuilderRecord, type LiveBuilder, PrepareStoppedError, deadMachine, isAbsentMachine, absentMachine, readBodyUpTo, forwardedCalls, DaemonRefusal, isNoHostCli, isNoGitCredential, type KindModule, type ImportReport, type ImportLanded, type WorkspaceLike, type StageFrame, type KeptImages, type ChildStart, type MachineMoment, type StoredBuilder, type LiveSession, type Reopened, type SessionEntry } from "./types/internal.js";
import type { RuntimeContext, RuntimeCore, KindsArea, RulesArea, TranscriptsArea, SlatesArea, ChannelsArea, RecordsArea, ReachArea, PullRequestsArea, DaemonArea, MachinesArea, BootArea, CreateArea, FoldersArea, StartFromArea, WorkspacesArea, AgentsArea, ThreadsArea, TurnsArea, SessionsArea, BuildersArea, GoldenArea, ImageArea, ProjectsArea, UsageArea, StatusArea, PreferencesArea } from "./context.js";

import { kindsArea } from "./machines/kinds.js";

import { rulesArea } from "./account/rules.js";

import { transcriptsArea } from "./threads/transcripts.js";

import { slatesArea } from "./account/slates.js";

import { channelsArea } from "./account/channels.js";

import { recordsArea } from "./images/records.js";

import { reachArea } from "./machines/reach.js";

import { pullRequestsArea } from "./account/pull-requests.js";

import { daemonArea } from "./machines/daemon.js";

import { machinesArea } from "./machines/machines.js";

import { bootArea } from "./machines/boot.js";

import { createArea } from "./machines/create.js";

import { foldersArea } from "./projects/folders.js";

import { startFromArea } from "./projects/start-from.js";

import { workspacesArea } from "./projects/workspaces.js";

import { agentsArea } from "./threads/agents.js";

import { threadsArea } from "./threads/threads.js";

import { turnsArea } from "./threads/turns.js";

import { sessionsArea } from "./threads/sessions.js";

import { buildersArea } from "./images/builders.js";

import { goldenArea } from "./images/golden.js";

import { imageArea } from "./images/image.js";

import { projectsArea } from "./projects/projects.js";

import { usageArea } from "./account/usage.js";

import { statusArea } from "./account/status.js";

import { preferencesArea } from "./account/preferences.js";

export * from "./types/harness.js";
export {
  type EventListener,
  type EventBus,
  CATALOG_TTL_MS,
  SESSION_TITLE_TTL_MS,
  CHECKOUT_TTL_MS,
  PR_PAGE_HOLD_MS,
  RATE_LIMIT_HOLD_MS,
  SESSION_TITLE_REFRESH_MAX,
  TITLE_MAKE_TIMEOUT_MS,
} from "./types/events.js";
export {
  type WorkspaceSpec,
  type CreatedWorkspace,
  type CreateWorkspaceOptions,
  type PackedProject,
  type StateRequest,
  type PackedState,
  type ProjectBundler,
  type LandRequest,
  type HostFolders,
  type HostTerminalConfig,
  type HostEditor,
  type EditorRemote,
  type HostSsh,
  type InitDoor,
  type RecipeShelf,
  type LandedAgent,
  type LandedProject,
  type ProjectLander,
  type ProjectExportOptions,
  type ProjectImportOptions,
  type SessionHandle,
  type PlaceBackends,
  wiredPlace,
  type GoldenRecipe,
  type GoldenExec,
  type RunningExec,
  type LocalWiring,
  type HereDaemon,
  type SeedWiring,
  type RuntimeOptions,
  type WakeOptions,
  ADD_IS_A_COMPUTER_LINE,
  NO_COPIER_HERE,
  PORT_PROBE_BODY_CAP,
  type GoldenBuildRequest,
  type GoldenPromotion,
  type GoldenUpgradeResult,
  GRACE_MS,
  DAEMON_REVIVE_AGAIN_MS,
  DAEMON_LACKS_AGAIN_MS,
  type AdoptedMachine,
  type SweepResult,
  type OriginStatusApi,
  type LogUsageRow,
  type UsageDoor,
} from "./types/wiring.js";
export * from "./types/api.js";
export {
  NO_COPY_RECIPE,
  NO_SEED_WIRING,
  copyKey,
  DROPPED_WATCH_MS,
  TRANSCRIPT_BYTES,
  TOOL_RESULT_KEPT,
  TRANSCRIPTS_HELD,
  TRANSCRIPT_FLUSH_MS,
  PrepareStoppedError,
} from "./types/internal.js";

export function createRuntime(opts: RuntimeOptions): Runtime {
  const ctx = {} as RuntimeContext;
  Object.assign(ctx, runtimeCore(ctx, opts));
  Object.assign(ctx, kindsArea(ctx));

  Object.assign(ctx, rulesArea(ctx));

  Object.assign(ctx, transcriptsArea(ctx));

  Object.assign(ctx, slatesArea(ctx));

  Object.assign(ctx, channelsArea(ctx));

  Object.assign(ctx, recordsArea(ctx));

  Object.assign(ctx, reachArea(ctx));

  Object.assign(ctx, pullRequestsArea(ctx));

  Object.assign(ctx, daemonArea(ctx));

  Object.assign(ctx, machinesArea(ctx));

  Object.assign(ctx, bootArea(ctx));

  Object.assign(ctx, createArea(ctx));

  Object.assign(ctx, foldersArea(ctx));

  Object.assign(ctx, startFromArea(ctx));

  Object.assign(ctx, workspacesArea(ctx));

  Object.assign(ctx, agentsArea(ctx));

  Object.assign(ctx, threadsArea(ctx));

  Object.assign(ctx, turnsArea(ctx));

  Object.assign(ctx, sessionsArea(ctx));

  Object.assign(ctx, buildersArea(ctx));

  Object.assign(ctx, goldenArea(ctx));

  Object.assign(ctx, imageArea(ctx));

  Object.assign(ctx, projectsArea(ctx));

  Object.assign(ctx, usageArea(ctx));

  Object.assign(ctx, statusArea(ctx));

  Object.assign(ctx, preferencesArea(ctx));
  return runtimeOf(ctx);
}

function runtimeCore(ctx: RuntimeContext, opts: RuntimeOptions): RuntimeCore {
  const { backend, store, adapters } = opts;
  const local = opts.local;
  /** The place door once the host wired one; the kind's refusal when it did not, which is what every road on a kind
   * this host does not serve answers. */
  let placeDoor: PlaceDoor | undefined;
  const bus = eventBus();
  const providerReadMs = opts.providerReadMs ?? PROVIDER_READ_MS;
  const goneConfirmMs = opts.goneConfirmMs ?? GONE_CONFIRM_MS;
  const lateReadMs = opts.wake?.lateReadMs ?? WAKE_LATE_READ_MS;
  const clock = opts.clock ?? realClock;
  const githubCache = opts.githubCache ?? memoryGitHubCache();
  /** What the provider says the machine is, bounded by its own read; undefined where the read could not be had. */
  const readsState = (machine: Machine): Promise<MachineState | undefined> =>
    until(machine.state(), clock.now() + providerReadMs, `state of ${machine.id}`, clock).catch(() => undefined);
  /** What a read of the machine before a wake asks again comes to: a resume the backend gave up on went through
   * after all, or as far as anything here can tell it did not. A read that could not be had leaves the resume
   * unsent, and a machine the read calls gone meets its 404 on the next ask and settles gone. */
  const tookTheResume = (reads: MachineState | undefined): boolean => reads === "running" || reads === "starting";
  /** Resolves after ms on the runtime's clock. Unref'd: a host asked to exit while a wake waits to ask again exits. */
  const sleeps = (ms: number): Promise<void> => new Promise<void>(resolve => clock.schedule(() => resolve(), ms, { unref: true }));
  const daemonHelloTimeoutMs = opts.daemonHelloTimeoutMs ?? DAEMON_HELLO_TIMEOUT_MS;
  const vaultCapBytes = opts.wake?.vaultCapBytes ?? VAULT_CAP_BYTES;
  const defaultIdleWindowMs = opts.idle?.defaultWindowMs ?? NAP_AFTER_MS;
  const hostId = opts.hostId ?? hostname();

  const vaultPathsOf = async (m: Machine): Promise<string[]> => {
    if (opts.vaultPaths) return opts.vaultPaths;
    // Breadcrumb doubles as the guarantee that the export list is never empty.
    await m.exec("date -u +%FT%TZ >> /root/.wsp-upgraded");
    const ls = await m.exec("ls -A /root");
    if (ls.exitCode !== 0) throw new Error(`vault enumeration failed: ${ls.stderr.slice(-200)}`);
    return ls.stdout
      .split("\n")
      .map(s => s.trim())
      .filter(s => s.length > 0 && !VAULT_SKIP.has(s))
      .map(s => `/root/${s}`);
  };
  const vaultExport = async (m: Machine, o: Pick<VaultOptions, "maxBytes" | "drop"> = {}): Promise<Buffer> =>
    exportPaths(m, await vaultPathsOf(m), { ...o, ...(opts.vaultCaches !== undefined ? { exclude: opts.vaultCaches } : {}) });
  /** What the fork's home owes a newer image, read while the machine still runs: the files the image it stands on
   * wrote and it never touched, which the archive leaves behind so the new image's copies stand, and the ones it
   * changed, which travel and are named on the result. A version that recorded none falls back to the old rule,
   * where the whole home lands over the new image. */
  const imageMovePlan = async (m: Machine, from: GoldenVersion | undefined, to: GoldenVersion): Promise<UpgradePlan> => {
    if (from?.owned === undefined) return upgradePlan(undefined, to.owned, []);
    const was = new Set(from.owned.map(f => f.path));
    // What the comparison actually judges by the fork's bytes: the version's own rows, less the volatile ones, whose
    // bytes never stand for an edit; and the volatile rows only the new image writes, where the comparison asks
    // whether the fork holds a live copy of its own to leave alone.
    const read = [
      ...from.owned.filter(f => f.volatile !== true).map(f => f.path),
      ...(to.owned ?? []).filter(f => f.volatile === true && !was.has(f.path)).map(f => f.path),
    ];
    return upgradePlan(from.owned, to.owned, await readOwnedFiles(m, read));
  };
  // One device door for this host: the ops the protocol server answers and the token every turn is launched with
  // come out of the same table, so a scoped token is listed, matched and revoked by the rules a paired computer's
  // token already lives under.
  const deviceDoor = makeDevices(store);
  /**
   * The token a launch of a thread's agent drives this host with, the address it dials and the wsp server it runs: a
   * device of this host's, scoped to the thread, which the caller takes back once the launch's process exits, so a
   * token read out of a machine after it opens nothing. Minted whatever the switch says, since a launch with none
   * reaches this host through the person's own wsp server and acts as them; the guard refuses what the switch
   * refuses. Only where the workspace has a road to this host, since a token with nowhere to go is one more secret
   * for nothing.
   */
  const threadLaunch = async (entry: LiveWorkspace, threadId: string, rootThreadId: string, o: { aside?: true } = {}): Promise<{ scoped?: Awaited<ReturnType<typeof deviceDoor.mint>>; env: Record<string, string>; wsp?: McpServerSpec }> => {
    const reach = ctx.agentsReach(entry);
    if (reach === undefined) return { env: {} };
    const scoped = await deviceDoor.mint(`thread ${threadWord(threadId)}`, { kind: "thread", threadId, workspaceId: entry.record.id, rootThreadId }, Date.now(), { road: ctx.moduleOf(entry.record.kind).turnRoad, ...o });
    return {
      scoped,
      env: {
        [HOST_TOKEN_ENV]: scoped.deviceToken,
        // The address and the key beside it only for a launch that dials one: its wsp pins the key before it sends
        // the token, so a directory answer naming another host is refused.
        ...(reach.url !== undefined ? { [HOST_URL_ENV]: reach.url, ...(placeDoor === undefined ? {} : { [HOST_KEY_ENV]: placeDoor.hostKey() }) } : {}),
      },
      ...(reach.wsp !== undefined ? { wsp: reach.wsp } : {}),
    };
  };
  // The places joined to this host, over the one code store every code is spent from: the door holds the records
  // and the links, and the two roads into the runtime it needs are the ordinary record and delete roads below.
  if (opts.placeLinks !== undefined) {
    const wiring = opts.placeLinks;
    placeDoor = makePlaceDoor({
      store,
      devices: deviceDoor,
      wiring,
      // A thunk: the provider table is built below this, and the door reads it only when a line asks where a fork
      // can land.
      providers: () => places,
      now: () => clock.now(),
      onStage: event => bus.emit(event),
      onSetup: event => bus.emit(event),
      copyBuild: placeId => copyRows.get(placeId),
      napMs: defaultIdleWindowMs,
      ...(opts.local?.hereDaemon !== undefined ? { hereDaemon: opts.local.hereDaemon } : {}),
      // Armed from now under the new window, on every workspace there whose window is its place's.
      napChanged: placeId => {
        for (const e of live.values()) if (e.record.phase === "running" && e.record.idleWindowMs === undefined && ctx.placeIdOf(e.record) === placeId) ctx.idle.touch(e.record.id);
      },
      // The same vault a turn is launched with: the word a computer's row says about an agent's sign-in and the
      // secrets that turn actually gets are one reading, so a row cannot say a key stands that no turn would use.
      ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
      ...(opts.recipes !== undefined ? { recipes: () => opts.recipes } : {}),
      ...(opts.placeJoinWaitMs !== undefined ? { joinWaitMs: opts.placeJoinWaitMs } : {}),
      ...(opts.placeUpdateWaitMs !== undefined ? { updateWaitMs: opts.placeUpdateWaitMs } : {}),
      ...(opts.placeDialWaitMs !== undefined ? { dialWaitMs: opts.placeDialWaitMs } : {}),
      ...(opts.placeFrameWaitMs !== undefined ? { frameWaitMs: opts.placeFrameWaitMs } : {}),
      ...(opts.placeRelinkWaitMs !== undefined ? { relinkWaitMs: opts.placeRelinkWaitMs } : {}),
      recording: {
        // Reads the live records, so it waits on the one hydration every other road waits on: a place that dials a
        // host nothing has asked a verb of yet would otherwise find no records at all.
        forksOn: async placeId => {
          await ctx.ready();
          return [...live.values()].filter(e => e.record.place === placeId).map(e => e.record.name);
        },
        projectsOn: async placeId => {
          await ctx.ready();
          return [...projectsHeld.values()].filter(p => p.computer === placeId).map(p => p.name);
        },
        runningOn: async (placeId, rows) => {
          await ctx.ready();
          const standing = [...live.values()].map(e => ({ ...e.record, provider: ctx.providerOf(e.record) }));
          return runningOnPlace(placeId, rows, standing, foldThreads([...sessions.values()].map(s => s.view)));
        },
        signInLine: (placeId, agent) => ctx.agentsRead.signInLine({ placeId }, { agent }),
        // The app's own sign-in road on that computer, read as a setup's row waiting on the person.
        signIn: async (placeId, agent, emit) => {
          const handle = await ctx.agentsRead.signIn({ placeId }, { agent }, emit);
          return {
            leave: () => handle.leave(),
            stop: () => {
              // A sign-in that already ended has nothing left to stop.
              try {
                ctx.agentsRead.signInStop(handle.signInId);
              } catch {
                return;
              }
            },
          };
        },
        // The add's own road for a folder seeding a project on that computer, with what the pick keeps.
        addFolder: async (placeId, key, folder) => {
          const source = folder.from.replace(/^~(?=\/|$)/, homedir());
          const plan = await ctx.projectsDoor.seedPlan(source);
          const seed = seedChoiceFrom(plan, folder.keep, []);
          const project = await ctx.projectsDoor.add({ source, on: placeId, ...(folder.name !== undefined ? { name: folder.name } : {}), seed });
          if (folder.icon !== undefined || folder.hue !== undefined) {
            await ctx.preferences.set({ projectLook: { [project.id]: { ...(folder.icon !== undefined ? { icon: folder.icon } : {}), ...(folder.hue !== undefined ? { hue: folder.hue } : {}) } } });
          }
          return { id: `folders/${key}`, label: project.name, outcome: "installed", ...(project.notice !== undefined ? { note: project.notice } : {}) };
        },
        folderRemote: async folder => (await ctx.remoteHere(folder.from.replace(/^~(?=\/|$)/, homedir()))).remote || undefined,
        // A folder the recipe took out leaves this host's list; its checkout there is the person's and stays.
        removeFolder: async (placeId, key, folder) => {
          const name = folder.name ?? key;
          const project = (await ctx.projectsDoor.list()).find(p => p.computer === placeId && p.name === name);
          if (project === undefined) return;
          const standing = [...live.values()].filter(e => e.record.project === project.id).map(e => e.record.name);
          if (standing.length > 0) throw new Error(projectInUseRefusal(project.name, standing));
          projectsHeld.delete(project.id);
          await store.delete(PROJECTS, project.id);
          bus.emit({ type: "project.removed", projectId: project.id });
        },
      },
    });
    // The door's four events ride the one stream every other event rides, so the app follows a computer joining
    // over the socket it already holds and no road subscribes to the door itself.
    placeDoor.on(e => bus.emit(e));
    placeDoor.on(e => {
      if (e.type === "place.removed") copyRows.delete(e.placeId);
    });
    // A copy is built only when somebody asks for one, and a computer's setup was asked for: its end is when the
    // image there can be read at all, which is the moment the tally beside it is written. A link builds nothing.
    bus.on("place.setup", e => {
      if (e.type !== "place.setup" || e.end === undefined) return;
      void ctx.image.keepCurrent(e.placeId);
    });
    // A build on that computer is making its requests over the link that just went: the ones that may be asked
    // again are waiting on it, so the stage they are in says what it is waiting for and says its own line again
    // once the computer opens a socket.
    placeDoor.on(e => {
      if (e.type !== "place.absent" && e.type !== "place.present") return;
      const gone = e.type === "place.absent";
      for (const at of stageAt.values()) {
        if (at.place !== e.placeId) continue;
        // The whole frame the stage last sent, with the wait standing in for its line while the gap lasts: the step
        // a reader clocks and the machines a failure left behind are facts of that stage and outlive a socket.
        const detail = gone ? placeDialBackLine(placeDoor!.nameOf(e.placeId)) : at.frame.detail;
        bus.emit({ ...at.frame, type: "golden.stage", ...(detail !== undefined ? { detail } : {}), ...(at.named ? { place: at.place } : {}) });
      }
    });
    // A computer that dials back in is the moment a record nothing could be asked about can be read at last: only
    // the ones this host is holding by a stand-in go through the hydration they would have had at host start, and
    // a fork that was live through the blip is left exactly as it is. A laptop that slept and dialled again is the
    // common case, so a wake, a nap or a delete in flight must not be thrown away by a presence beat.
    placeDoor.on(e => {
      if (e.type !== "place.present") return;
      void (async () => {
        await ctx.ready();
        for (const raw of await store.list(WORKSPACES)) {
          const stored = raw as WorkspaceRecord;
          if (stored.place !== e.placeId || !ctx.isHeldAway(stored.id)) continue;
          // This road runs after ready, so every session row is already in and the sync can wait out a running turn.
          const entry = await ctx.hydrateWorkspace(raw);
          if (entry !== undefined) void ctx.syncDaemon(entry);
          else await ctx.rereadHeld(stored.id, "record load");
        }
      })().catch((err: unknown) => console.warn(`the records on ${placeDoor!.nameOf(e.placeId)} were not read again: ${err instanceof Error ? err.message : String(err)}`));
    });
  }
  /** The machines a root thread's forks are landing but have no record for yet, by root: a slot is taken before
   * the first await of a fork and handed back when it lands or fails, so the cap counts what is on its way too. */
  const landing = new Map<string, number>();
  const live = new Map<string, LiveWorkspace>();
  /** Every project this host holds, by id, read from the store once at hydration and kept here: a workspace's view
   * joins its project off this map on every read, and the map is the one place a project's name, path and computer
   * are known without a store read. */
  const projectsHeld = new Map<string, ProjectView>();
  const setups = agentSetups(store);
  const builders = new Map<string, LiveBuilder>();
  /** Every machine a sweep, a landing or a replacement stops, read back behind the sweep and asked again while it stays. */
  const gone = new GoneWatch({ ...(opts.killConfirm !== undefined ? { confirm: opts.killConfirm } : {}), warn: line => (ctx.state.sayStops ?? console.warn)(line) });
  /** The prepare in flight per place and golden name; a second call for the same recipe joins it instead of running the stages twice on one machine. */
  const preparing = new Map<string, { hash: string | undefined; promise: Promise<GoldenBuilderView> }>();
  /** The copy build in flight per place and image name. A create landing there, a version cut and a person typing
   * the line all ask for the same copy: the second and every later ask joins the first and takes the copy it seals,
   * so one builder runs and this computer is read once. */
  const copyBuilds = new Map<string, Promise<SealedImageBuilt>>();
  /** The stage each build on a joined computer is in, by that computer and the image's name. A build there makes
   * its requests over that computer's link, and a gap in it holds every one of them: the stage says so while it
   * lasts and reads what it last read once the computer is back, rather than standing still under a line that is
   * no longer true. */
  const stageAt = new Map<string, { place: string; name: string; named: boolean; frame: StageFrame }>();
  /** What each place's row says about its copy: the stage while a build runs there, the reason after one stopped,
   * nothing once the copy stands. Written off the golden.stage frames naming the place, so a build reads the same on
   * the row whoever started it. */
  const copyRows = new Map<string, CopyBuild>();
  bus.on("golden.stage", e => {
    if (e.type !== "golden.stage" || e.place === undefined) return;
    const build = copyBuildOf(e);
    if (build === undefined) copyRows.delete(e.place);
    else copyRows.set(e.place, build);
  });
  /** Whether a refusal before any build at a place is that place's row to say. A place that runs no workspaces has no
   * copy to keep, a link that went is not a build to show, and a computer whose recipe is running is no build either:
   * nothing was asked of its image and the job's own end asks again. */
  const rowSaysFailure = (place: string, e: unknown): boolean =>
    !(e instanceof PlaceForksNowhereError || e instanceof PlaceProvisioningError || isPlaceAbsent(e) || placeAway(place));
  /** A computer this host holds no link to now: a laptop asleep, or one that went mid-ask. */
  const placeAway = (place: string): boolean => placeDoor !== undefined && places.backend(place) === undefined && placeDoor.link(place) === undefined;
  /** A failure said on the bus as the build's own failed frame, so the row, the app's store and the image card read
   * the same stop. */
  const frameStopped = (place: string, name: string, e: unknown): void => ctx.stageOf(name, place, true)("failed", e instanceof Error ? e.message : String(e));
  /** A row read back from the store has no handle: its process died with the runtime that started it. */
  /** The record of every thread this host holds, by thread id, persisted beside the workspace's rows. */
  const threadRecords = new Map<string, ThreadRecord & { workspaceId: string }>();
  /** The wake of each snooze still standing, by fold key, so every window re-reads the thread the moment it ends. */
  const snoozeTimers = new Map<string, () => void>();
  /** Arms the wake of a thread's snooze, over any it had; a moment past already has nothing to wake. A timer longer
   * than setTimeout holds is re-armed on the way, and a wake finding the snooze moved or gone says nothing. */
  const wakeAt = (threadId: string, until: number): void => {
    snoozeTimers.get(threadId)?.();
    snoozeTimers.delete(threadId);
    const wait = until - clock.now();
    if (wait <= 0) return;
    const cancel = clock.schedule(
      () => {
        snoozeTimers.delete(threadId);
        const record = threadRecords.get(threadId);
        if (record?.snoozedUntil !== until) return;
        if (clock.now() < until) wakeAt(threadId, until);
        else bus.emit({ type: "thread.marked", workspaceId: record.workspaceId, threadIds: [threadId] });
      },
      Math.min(wait, MAX_TIMER_MS),
      { unref: true },
    );
    snoozeTimers.set(threadId, cancel);
  };
  /** `launch` is carried only by a row the start road wrote before its turn reached the machine, and settles when the
   * turn's harness holds the row or the start gave it up: a send behind such a row waits on it, and the file never
   * takes the row, since a restart could re-open nothing from it. */
  const sessions = new Map<string, SessionEntry>();
  /** Every exec stream still running, so the machine going away ends it the way it ends a session. */
  const execs = new Set<{ workspaceId: string; end: (reason: string) => void }>();
  const indexFlushes = new Map<string, Promise<void>>();
  /** The transcripts held whole, the one opened last at the end: at most TRANSCRIPTS_HELD, read again from their files
   * once they fall out. A store that keeps them as rows holds none. */
  const transcripts = new Map<string, SessionEvent[]>();
  /** The state database's transcript rows. Where the store has none (the memory store, and the JSON store kept for one
   * release by WSP_STATE_STORE) each transcript is a blob, and every switch on `rows` is that road: they go with it. */
  const rows = store.transcripts;
  /** Workspaces whose index did not read off their rows at boot: their flushes write events and leave the kept index
   * alone, so the next boot reads it again. */
  const unreadIndexes = new Set<string>();
  /** Each workspace's events written since its transcript's last flush, which its file does not have yet. */
  const pendingEvents = new Map<string, SessionEvent[]>();
  const pendingBytes = new Map<string, number>();
  /** Every transcript's index, held whether or not the transcript is. */
  const transcriptIndex = new Map<string, TranscriptIndex>();
  const indexFor = (workspaceId: string): TranscriptIndex => {
    const held = transcriptIndex.get(workspaceId) ?? emptyIndex();
    transcriptIndex.set(workspaceId, held);
    return held;
  };
  /** The bytes each held transcript's events come to as JSON, kept beside it so a new event is not a walk of all of them. */
  const transcriptBytes = new Map<string, number>();
  /** Each event's size, measured once, for a transcript over its byte cap: one is walked whole at every event that
   * lands. Only those, so a transcript inside it holds nothing more. */
  const sizes = new WeakMap<SessionEvent, number>();
  const sizeOf = (e: SessionEvent): number => {
    const known = sizes.get(e);
    if (known !== undefined) return known;
    const size = eventBytes(e);
    sizes.set(e, size);
    return size;
  };

  /** Where this host can build a copy of its image, and which of them every road that names none means. */
  const places: PlaceBackends = opts.places ?? wiredPlace("default", backend);
  return {
    opts, backend, store, adapters, local, placeDoor, bus, goneConfirmMs, lateReadMs, clock, githubCache, readsState,
    tookTheResume, sleeps, daemonHelloTimeoutMs, vaultCapBytes, defaultIdleWindowMs, hostId, vaultExport, imageMovePlan,
    deviceDoor, threadLaunch, landing, live, projectsHeld, setups, builders, gone, preparing, copyBuilds, stageAt,
    copyRows, rowSaysFailure, placeAway, frameStopped, threadRecords, snoozeTimers, wakeAt, sessions, execs,
    indexFlushes, transcripts, rows, unreadIndexes, pendingEvents, pendingBytes, transcriptIndex, indexFor,
    transcriptBytes, sizeOf, places,
    state: {
      sayStops: undefined, readsSince: 0, rootsRecheck: undefined, owner: "", copiesMoving: undefined,
      sweepTimer: undefined, sweeping: undefined, sweepStopped: false, beat: undefined, closed: false, closing: false,
      ticking: undefined, preferencesHeld: undefined,
    },
  };
}
























function runtimeOf(ctx: RuntimeContext): Runtime {
  const {
    opts, backend, store, adapters, local, placeDoor, bus, clock, deviceDoor, live, builders, gone, snoozeTimers,
    indexFlushes, pendingEvents,
  } = ctx;
  return {
    events: bus,
    backend,
    workspaces: ctx.workspaces,
    projects: ctx.projects,
    sessions: ctx.sessionsApi,
    slates: ctx.slates,
    devices: deviceDoor,
    ...(placeDoor !== undefined ? { places: placeDoor } : {}),
    ...(opts.recipes !== undefined ? { recipes: opts.recipes } : {}),
    hereChannel: async onEvent => ctx.channelOver(await ctx.localRoad(), THIS_COMPUTER, onEvent),
    agents: { ...ctx.agentsRead, homesHere: ctx.homesHere },
    preferences: ctx.preferences,
    usage: ctx.usage,
    status: {
      ...ctx.status,
      // Which workspaces this caller is served is decided here, after the probes, off the same reading the other
      // listing and every verb take: a record dropped while the probes ran leaves both lists at once, so nothing a
      // person is shown is denied by the next line they type.
      list: async (o, origin) => {
        const rows = await ctx.status.list(o);
        const shown = new Set(ctx.listedFor(origin).map(e => e.record.id));
        return rows.filter(row => shown.has(row.id));
      },
      // A cost read answers for a workspace this host no longer holds, which is why the rule for a named id is read
      // here rather than through entryOf, which refuses an id it does not know.
      history: async (workspaceId, origin) => {
        ctx.refuseNamed(workspaceId, origin);
        return ctx.status.history(workspaceId);
      },
    },
    harnesses: {
      list: async (workspaceId, origin) => {
        const prefs = await ctx.preferences.get();
        const entry = workspaceId === undefined ? undefined : await ctx.entryOf(workspaceId, origin);
        // Only a harness with an adapter can run a turn, and one the person turned off on that computer runs none
        // there; the rest of the table waits.
        const table = HARNESS_CATALOGS.filter(c => c.harness in adapters && (entry === undefined || !ctx.agentOff(entry, c.harness)));
        // A record answers what its threads start at whether or not its machine is up; only the rest of the lists
        // waits on the binary, so a picker on a paused workspace still reads the access its next thread would run.
        // An agent whose kept config folder is refused, or cannot be read there, answers with why instead of its
        // lists; a link that dropped under the check says its computer is not answering, since that is not the agent's.
        const unchecked = (e: unknown, on: LiveWorkspace): string => {
          const place = ctx.setupPlace(on);
          if (isPlaceAbsent(e) && place !== undefined) return absentComputer(ctx.placeDoorOf().nameOf(place), null).said;
          return e instanceof Error ? e.message : String(e);
        };
        const listsOn = async (c: HarnessCatalog, on: LiveWorkspace): Promise<HarnessCatalog> => {
          const refusal = await ctx.setupRefusal(on, c.harness).catch((e: unknown) => unchecked(e, on));
          return refusal !== null ? { ...c, refusal } : ctx.catalogOn(c, on, ctx.adapterFor(on, c.harness).adapter);
        };
        const lists = entry === undefined || entry.record.phase !== "running" ? table : await Promise.all(table.map(c => listsOn(c, entry)));
        const project = entry === undefined ? undefined : prefs.projectDefaults[entry.record.project];
        const agent = ctx.defaultAgentOf(prefs, entry);
        return lists.map(c => {
          const picker = prefs.agentDefaults[c.harness]?.models;
          const unshaped = picker === undefined ? {} : { unshaped: { models: c.models, ...(c.legacyModels !== undefined ? { legacyModels: c.legacyModels } : {}) } };
          return { ...shapeModels(ctx.defaultsOn(c, prefs, project).catalog, picker), ...unshaped, ...(c.harness === agent ? { isDefault: true } : {}) };
        });
      },
    },
    golden: ctx.golden,
    image: ctx.image,
    owner: async () => {
      await ctx.ready();
      return ctx.state.owner;
    },
    reap: async (olderThanMs, say) => {
      if (say !== undefined) ctx.state.sayStops = say;
      await ctx.ready();
      await ctx.refreshBuilders();
      // A stale record can never seal; stopping it is the only thing that ends its bill. A reusable one no
      // process is using dies at six hours by our createdAt label, or at once when no age can be read: every
      // get(id) on it resets the provider's rolling idle timer (measured), so the kill it was created with
      // never fires while a host is up. Own builders get their heartbeat here, so other processes leave them be.
      const failed: ReapFailure[] = [];
      const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      const grace = await ctx.expireGrace().catch((e: unknown) => {
        failed.push({ message: `grace sweep: ${messageOf(e)}` });
        return { reaped: [], failed: [] };
      });
      const reaped: ReapedMachine[] = grace.reaped;
      failed.push(...grace.failed);
      const now = Date.now();
      for (const b of [...builders.values()]) {
        if (b.life === "own") await ctx.hold(b);
        const bornAt = Date.parse(b.builder.machine.labels?.[CREATED_AT_LABEL] ?? b.record.createdAt);
        const ageMs = Number.isNaN(bornAt) ? undefined : now - bornAt;
        const expired = b.life === "reusable" && (ageMs === undefined || ageMs >= BUILDER_IDLE_MS);
        if (b.life !== "stale" && !expired) continue;
        try {
          await gone.stop(backend, b.builder.machine);
        } catch (e) {
          failed.push({ id: b.record.id, message: `could not stop: ${messageOf(e)}; stays recorded, retried next sweep` });
          continue;
        }
        await ctx.forgetBuilder(b.record.id);
        reaped.push(
          b.life === "stale"
            ? { id: b.record.id, builder: true, reason: b.record.building === true ? "unfinished" : "recorded" }
            : { id: b.record.id, builder: true, reason: "expired", ...(ageMs !== undefined ? { ageMs } : {}) },
        );
      }
      const knownIds = (): string[] => [...live.values()].flatMap(e => [e.record.machineId, e.machine.id]).concat([...builders.keys()], [...ctx.inflight], reaped.map(r => r.id), gone.ids());
      const result = (swept: ReapResult, adopted: AdoptedMachine[]): SweepResult => {
        const allFailed = failed.concat(swept.failed ?? []);
        return { reaped: reaped.concat(swept.reaped), spared: swept.spared, ...(allFailed.length > 0 ? { failed: allFailed } : {}), ...(adopted.length > 0 ? { adopted } : {}) };
      };
      // One listing serves both halves of the sweep: the machines recorded again, then what the engine kills or spares.
      let listing: ListedMachine[];
      try {
        listing = await backend.list();
      } catch (e) {
        failed.push({ message: messageOf(e) });
        return result({ reaped: [], spared: [] }, []);
      }
      // A recorded machine the listing lacks is read once: the listing is best effort, so only the read decides, and a
      // read that finds the machine gone settles its record here rather than at the next poll or verb.
      const listed = new Set(listing.map(row => row.id));
      for (const entry of [...live.values()]) {
        if (entry.creating || entry.napping || entry.waking || entry.deleting) continue;
        if (isAbsentMachine(entry.machine)) {
          await ctx.rereadHeld(entry.record.id, "sweep").catch((e: unknown) => void failed.push({ message: messageOf(e) }));
          continue;
        }
        // A machine the listing still carries under a record marked gone is read once: the read is what decides,
        // and one that says running gives the record its machine back.
        if (listed.has(entry.record.machineId)) {
          if (entry.record.phase === "gone") await ctx.recoverGone(entry);
          continue;
        }
        if (entry.record.phase === "gone") continue;
        let answer: string | undefined;
        const read = await entry.machine.state().catch((e: unknown) => {
          if (!isMissing(e)) return undefined;
          answer = providerSaid(e);
          return "gone";
        });
        if (read === "gone") await ctx.adoptGone(entry, goneWords(entry.record.machineId, { by: "sweep", at: clock.now(), ...(answer !== undefined ? { answer } : {}) }));
      }
      const claimed = new Set(knownIds());
      const adopted = await ctx.adoptLost(listing, claimed, failed);
      try {
        return result(await reap({ backend, owner: ctx.state.owner, listing, stop: m => gone.stop(backend, m), knownIds: () => [...knownIds(), ...claimed], ...(olderThanMs !== undefined ? { olderThanMs } : {}) }), adopted);
      } catch (e) {
        failed.push({ message: messageOf(e) });
        return result({ reaped: [], spared: [] }, adopted);
      }
    },
    close: async () => {
      ctx.state.closing = true;
      clearInterval(ctx.state.rootsRecheck);
      await ctx.state.copiesMoving;
      ctx.state.sweepStopped = true;
      ctx.state.sweepTimer?.();
      await ctx.state.sweeping;
      ctx.idle.close();
      ctx.alerts.close();
      ctx.slates.close();
      // An agent's version or sign-in command that never answers would otherwise outlive this process.
      opts.agentsReader?.close?.();
      // What this host started on a machine finishes before it lets that machine go: the boot fires a daemon sync
      // at every running workspace without waiting for it, and a write landing after the close is this process
      // touching a computer it no longer holds. Each sync is a read and a write, so the wait is milliseconds.
      await Promise.allSettled([...ctx.daemonSyncs.values()]);
      await Promise.allSettled([...ctx.keptWrites.values()]);
      // The turns running on machines are not ended: each leads a process group on its own machine and its log is
      // there to be read again, so what this host lets go of is the reading of them, which is what holds this
      // process open after its last line.
      for (const stop of [...ctx.machineReading]) stop();
      ctx.machineReading.clear();
      // A kept agent is no turn: it is ended rather than left idle with nothing to send to it, its tree at once, since
      // an agent slow to exit on its EOF would outlast the reader that reaps its group (a tail pump was left behind
      // so); the wait for it is short, and the next host's sweep ends what is left.
      const keptGoing = [...ctx.keptAgents.keys()].map(threadId => {
        const exited = ctx.keptAgents.get(threadId)!.agent.exited;
        ctx.reapKept(threadId, { now: true });
        return exited;
      });
      if (keptGoing.length > 0) await Promise.race([Promise.allSettled(keptGoing), new Promise(resolve => setTimeout(resolve, KEPT_CLOSE_WAIT_MS).unref())]);
      await local?.close?.();
      await placeDoor?.close();
      ctx.state.closed = true;
      ctx.state.beat?.();
      ctx.state.beat = undefined;
      for (const cancel of ctx.graceTimers.values()) cancel();
      ctx.graceTimers.clear();
      for (const cancel of snoozeTimers.values()) cancel();
      snoozeTimers.clear();
      for (const entry of live.values()) entry.prPoll?.();
      gone.close();
      await ctx.state.ticking;
      // A clean exit frees its builders at once; a crash leaves the heartbeat to age and the pid to die.
      for (const b of [...builders.values()].filter(b => b.life === "own" && b.record.heldBy !== undefined)) {
        delete b.record.heldBy;
        await store.put(BUILDERS, b.record.id, b.record);
      }
      for (const id of new Set([...ctx.transcriptTimers.keys(), ...pendingEvents.keys()])) void ctx.flushTranscript(id);
      await Promise.all([...ctx.transcriptQueue.values(), ...indexFlushes.values()]);
    },
  };
}
