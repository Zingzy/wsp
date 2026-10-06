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
import { createSlates, type Slates } from "./slates.js";
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

// import { rulesArea } from "./account/rules.js";

import { transcriptsArea } from "./threads/transcripts.js";

// import { slatesArea } from "./account/slates.js";

// import { channelsArea } from "./account/channels.js";

// import { recordsArea } from "./images/records.js";

import { reachArea } from "./machines/reach.js";

// import { pullRequestsArea } from "./account/pull-requests.js";

import { daemonArea } from "./machines/daemon.js";

import { machinesArea } from "./machines/machines.js";

import { bootArea } from "./machines/boot.js";

import { createArea } from "./machines/create.js";

// import { foldersArea } from "./projects/folders.js";

// import { startFromArea } from "./projects/start-from.js";

// import { workspacesArea } from "./projects/workspaces.js";

import { agentsArea } from "./threads/agents.js";

import { threadsArea } from "./threads/threads.js";

import { turnsArea } from "./threads/turns.js";

import { sessionsArea } from "./threads/sessions.js";

// import { buildersArea } from "./images/builders.js";

// import { goldenArea } from "./images/golden.js";

// import { imageArea } from "./images/image.js";

// import { projectsArea } from "./projects/projects.js";

// import { usageArea } from "./account/usage.js";

// import { statusArea } from "./account/status.js";

// import { preferencesArea } from "./account/preferences.js";

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


function rulesArea(ctx: RuntimeContext): RulesArea {
  const { opts, store, placeDoor, landing, live, projectsHeld, sessions } = ctx;
  /** What a start that opened a thread leaves on the preferences record: the project the thread landed in, by
   * workspace, the second branch of threadFolder for the next thread there, and the target, the workspace and project
   * a thread or an import asked for from nowhere goes to. Written only when it moves the record, so a second thread
   * on the same project pushes no record to any socket. */
  /** One project's record as it stands now, kept and pushed to every client: the one writer, so no road updates
   * the map without the store or the other way round. */
  const rememberProject = async (project: ProjectView): Promise<void> => {
    projectsHeld.set(project.id, project);
    await store.put(PROJECTS, project.id, project);
  };

  const rememberTarget = async (record: WorkspaceRecord): Promise<void> => {
    const current = await ctx.preferences.get();
    if (current.target?.workspace === record.id) return;
    const patch: PreferencesPatch = { target: { workspace: record.id } };
    await ctx.preferences.set(patch);
  };
  /** Why a verb this workspace's machine cannot take is refused, in the three sentences the three reasons have: a
   * machine wsp does not run has no meaning for a verb that moves a fork, a host with no provider forks nothing at
   * all and says how to get one, and a machine wsp does run is short of that verb's road at its provider. Written
   * once, so every gate below refuses in the words its own reason has. */
  const cannotLine = (record: WorkspaceRecord, action: string): string => {
    const kind = record.kind;
    if (!kindWords(kind).driven) return undrivenRefusal(record.name, machineWord(kind), action);
    if (forksNoMachines(ctx.backendFor(record).capabilities)) return opts.noMachinesLine ?? NO_PROVIDER_LINE;
    return providerCannotRefusal(record.name, machineWord(kind), action);
  };
  /** The one throw every gate below goes through, so every capability a verb reads refuses in the same sentence. */
  const refuseUnless = (entry: LiveWorkspace, able: boolean, action: string): void => {
    if (!able) throw new Error(cannotLine(entry.record, action));
  };
  /** The capability a verb reads before it runs: a machine whose capability is false refuses the verb. Each verb
   * names the capability its own move needs and never a neighbour's: a provider that copies a machine's disk but
   * whose forks boot cold takes a snapshot all the same. */
  const refuseCannot = (entry: LiveWorkspace, can: keyof Omit<Capabilities, "sizes" | "pauseMode">, action: string): void => {
    refuseUnless(entry, ctx.backendFor(entry.record).capabilities[can] === true, action);
  };
  /** Whether a kind's machines pause at all, which is all the runtime asks of the pause mode: the nap and the wake
   * refuse where no mode is declared, with the same sentence, and never read which mode it is. */
  const pauses = (record: WorkspaceRecord): boolean => ctx.backendFor(record).capabilities.pauseMode !== undefined;
  const refusePauseless = (entry: LiveWorkspace, action: string): void => {
    refuseUnless(entry, pauses(entry.record), action);
  };
  /** Whether a workspace holds one of the account's machine slots: only a kind whose machines the provider can nap
   * does, the same fact the pause and wake refusals read, so this computer is never counted against the cap nor
   * named beside the two moves that free a slot. Phase decides the rest off the record alone, since a refusal has
   * no time to ask the provider about every workspace. */
  const holdsSlot = (record: WorkspaceRecord): boolean => pauses(record) && phaseHoldsSlot(record);
  /** The one rule about where a request came from, read by every verb and every list that serves workspaces: a
   * request relayed from a machine drives and sees only the kinds whose module takes one, so this computer's own
   * workspace answers nothing relayed. Today no machine has a road into the host, so nothing relays yet; the rule
   * holds when one appears. */
  const drives = (record: { kind: WorkspaceKind; machineId?: string }, caller: Caller | undefined): boolean => roadOf(caller) !== "relayed" || ctx.moduleOf(record.kind).relayed(record.machineId);
  /** Which workspaces a thread's own token reaches: the one its turn runs on, and the ones its root thread forked.
   * A thread never sees or drives a workspace outside its own tree, whatever the verb, so this sits beside the
   * kind rule rather than in any one of them. A caller that is no thread reaches everything the kind rule allows. */
  const inTree = (record: { id?: string; rootThreadId?: string; worktree?: WorktreeFolder }, scope: ThreadScope | undefined): boolean =>
    // A record with no id is a workspace that does not exist yet, the shape a create is checked against: what a
    // thread may make is the guard's question, not this one's. A worktree on this computer made for the tree is in
    // it as a fork the tree made is.
    scope === undefined ||
    record.id === undefined ||
    record.id === scope.workspaceId ||
    record.rootThreadId === scope.rootThreadId ||
    (record.worktree?.madeFor !== undefined && record.worktree.madeFor === scope.rootThreadId);
  /** Where a thread may open a thread beyond its tree: the project folder of its own project, which every thread
   * of the project shares. Every other act there stays its tree's. */
  const opensIn = (record: WorkspaceRecord, scope: ThreadScope | undefined): boolean =>
    scope !== undefined && copiesFolder(record.kind) && record.worktree === undefined && record.project === projectOfScope(scope);
  /** Which project a thread works on: the one its own workspace holds. A thread whose workspace this host no longer
   * holds works on none, and the project rule then has nothing to compare and leaves the tree rule to refuse. */
  const projectOfScope = (scope: ThreadScope): string | undefined => live.get(scope.workspaceId)?.record.project;
  /** The rule as a sentence: what this request is refused with for that record, or nothing when it may drive it.
   * A record this host does not hold, which a port forward's target may be since the host forwards a builder's
   * ports too, is nobody's to refuse for. The project rule is read before the tree rule and answers first: a
   * workspace of another project is outside the tree as well, and the project is why. */
  const refusalFor = (record: WorkspaceLike | undefined, caller: Caller | undefined): string | undefined => {
    if (record === undefined) return undefined;
    if (!drives(record, caller)) return relayedRefusal(record.name);
    const scope = scopeOf(caller);
    if (scope === undefined) return undefined;
    const mine = projectOfScope(scope);
    if (mine !== undefined && record.project !== undefined && record.project !== mine) {
      return spawnProjectRefusal(scope.threadId, ctx.projectHeld(mine).name, ctx.projectHeld(record.project).name);
    }
    return !inTree(record, scope) ? spawnReachRefusal(scope.threadId, record.name) : undefined;
  };
  /** The rule as the caller reads it. A person is told which rule hid the workspace, since what this host holds is
   * theirs; a thread is told absence and nothing more, since a sentence naming a workspace or a project outside its
   * tree is how a thread learns what else stands here. No word rides the thread's: every verb that reaches this
   * found the workspace itself rather than being handed it. */
  const refuseRelayed = (record: WorkspaceLike | undefined, caller: Caller | undefined): void => {
    const line = refusalFor(record, caller);
    if (line === undefined) return;
    throw scopeOf(caller) === undefined ? new Error(line) : notFoundRefusal(noWorkspaceRefusal());
  };
  /** The rule for a workspace a caller named by id rather than one a verb found for itself: a thread reads one
   * sentence for an id this host does not hold and for one outside its tree alike, since telling the two apart is
   * how a thread walks what else stands here. A caller that is no thread reads what it always did, an id nobody
   * holds being nobody's to refuse for. */
  const refuseNamed = (workspaceId: string, caller: Caller | undefined): void => {
    const record = live.get(workspaceId)?.record;
    if (record === undefined && scopeOf(caller) !== undefined) throw notFoundRefusal(noWorkspaceRefusal());
    refuseRelayed(record, caller);
  };
  /** Every workspace this host holds, as any door serves them: one a create has not finished is not there yet. */
  const held = (): LiveWorkspace[] => [...live.values()].filter(e => !e.creating);
  /** The workspaces this caller is served, which is the one reading behind the listings and behind resolving a name.
   * Both lists a person meets are built here, so neither can drop a workspace the other keeps and no verb denies a
   * name the listing just showed. */
  const listedFor = (caller: Caller | undefined): LiveWorkspace[] => held().filter(e => refusalFor(e.record, caller) === undefined);
  /** Recording a machine that already exists is this computer's own act, whatever the kind takes once it is
   * recorded: the address and the key a record stands on are the person's to name, so a request relayed from a
   * machine is refused before anything is dialled and again where the record is written. */
  const refuseRecording = (named: string, caller: Caller | undefined): void => {
    if (roadOf(caller) === "relayed") throw new Error(relayedRecordRefusal(named));
  };
  /** The switch that governs a workspace, which is the one on the workspace the root thread of its tree runs on: a
   * fork carries the tree it belongs to and not a rule of its own, so turning a lead's switch off stops everything
   * its threads spawned rather than leaving a copy of the old answer standing on every machine under it. A root
   * whose workspace this host no longer holds governs nothing, so the tree under it spawns nothing more. A switch
   * nobody set on the workspace reads as its place's, and one set on neither as the default. */
  const agentsRecordOf = (record: WorkspaceRecord): WorkspaceRecord | undefined => {
    if (record.rootThreadId === undefined) return record;
    const at = ctx.rowsOn(record.rootThreadId)[0]?.workspaceId;
    return at === undefined ? undefined : live.get(at)?.record;
  };
  const agentsOf = (record: WorkspaceRecord): WorkspaceAgents | undefined => {
    const held = agentsRecordOf(record);
    return held === undefined ? undefined : ctx.agentsHeld(held);
  };
  /** Where the switch a record runs under is held, as the depth refusal names the setting to raise. */
  const agentsHeldAt = (record: WorkspaceRecord): { computer: string } | { workspace: string } => {
    const held = agentsRecordOf(record) ?? record;
    if (held.agents !== undefined) return { workspace: held.name };
    const placeId = ctx.placeIdOf(held) ?? HERE_PLACE_ID;
    return { computer: placeDoor?.nameOf(placeId) ?? placeId };
  };
  /** The tree a thread sits in, read off the rows: its parent, then its parent's, up to the thread a person opened.
   * The walk is bounded by the rows there are, since a chain that somehow looped would otherwise never end. */
  const parentOf = (threadId: string): string | undefined => ctx.rowsOn(threadId).find(v => v.parentThreadId !== undefined)?.parentThreadId;
  const depthUnderRoot = (threadId: string): number => {
    let depth = 0;
    let at = threadId;
    for (let steps = sessions.size + 1; steps > 0; steps--) {
      const parent = parentOf(at);
      if (parent === undefined) return depth;
      depth++;
      at = parent;
    }
    return depth;
  };
  /** The top of the tree a thread is in: the root its own rows carry, and itself when nothing spawned it. */
  const rootOf = (threadId: string): string => ctx.rowsOn(threadId).find(v => v.rootThreadId !== undefined)?.rootThreadId ?? threadId;
  /** How a turn on this workspace's machine reaches this host, and the wsp command it runs there: the kind's own
   * answer for its machines, and nothing where that kind reaches this host nowhere. */
  const agentsReach = (entry: LiveWorkspace): { url?: string; wsp?: McpServerSpec } | undefined => {
    const reach = ctx.moduleOf(entry.record.kind).turnReach(entry);
    if (reach === undefined) return undefined;
    const wsp = ctx.moduleOf(entry.record.kind).wspMcp(entry);
    return { ...reach, ...(wsp !== undefined ? { wsp } : {}) };
  };
  /** The one door every act a thread's own token asks for goes through: the switch on the workspace that thread
   * runs on, then the acts a thread may ask for at all, then how deep it already is, then how many machines its
   * root already holds. A caller that is not a thread passes straight through; nothing here is a second copy of a
   * rule any verb also keeps. */
  const spawnGuard = (act: SpawnAct, caller: Caller | undefined): (() => void) => {
    const free = (): void => {};
    const scope = scopeOf(caller);
    if (scope === undefined) return free;
    const own = live.get(scope.workspaceId)?.record;
    const policy = own === undefined ? undefined : agentsOf(own);
    // Read at the act and not at the mint: a person who turns the switch off while a turn runs has turned it off.
    if (own === undefined || policy?.spawn !== true) throw new Error(agentsOffRefusal(own?.name ?? scope.workspaceId, act));
    if (!SPAWN_ACTS_ALLOWED.includes(act)) throw new Error(spawnActRefusal(scope.threadId, act));
    // The depth cap counts what a thread starts under itself; a send and a bring back start nothing, so a thread
    // at the cap still talks to its tree and still gets its work out.
    if (act === "send" || act === "bring_back") return free;
    const depth = depthUnderRoot(scope.threadId);
    if (depth >= policy.maxDepth) throw new Error(spawnDepthRefusal(scope.threadId, depth, policy.maxDepth, agentsHeldAt(own)));
    if (act !== "fork") return free;
    // Counted off the records rather than kept as a number, so a machine deleted, forgotten or gone frees its place
    // without anything having to remember to give it back, plus the slots forks still landing hold. A record
    // enters the live map only after the provider has answered, so two forks asked for in one tick would both read
    // the same count and both pass; the place is taken here, in the same step the count is read, and handed back by
    // the caller's own finally, the way the name a fork is landing under already is.
    const standing = [...live.values()].filter(e => e.record.rootThreadId === scope.rootThreadId && workspaceState({ phase: e.record.phase }) !== "gone").length;
    const held = landing.get(scope.rootThreadId) ?? 0;
    if (standing + held >= policy.maxMachines) throw new Error(spawnCapRefusal(scope.rootThreadId, standing + held, policy.maxMachines));
    landing.set(scope.rootThreadId, held + 1);
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      const now = (landing.get(scope.rootThreadId) ?? 1) - 1;
      if (now <= 0) landing.delete(scope.rootThreadId);
      else landing.set(scope.rootThreadId, now);
    };
  };
  /** Where a thread's act lands in its tree: under the thread that asked and its root, which is what the thread
   * tree nests by and what the machine cap counts; nothing for a caller that is no thread. */
  const treeOf = (scope: ThreadScope | undefined): { parentThreadId?: string; rootThreadId?: string } =>
    scope === undefined ? {} : { parentThreadId: scope.threadId, rootThreadId: scope.rootThreadId };
  return {
    rememberProject, rememberTarget, refuseCannot, pauses, refusePauseless, holdsSlot, drives, opensIn, projectOfScope,
    refusalFor, refuseRelayed, refuseNamed, held, listedFor, refuseRecording, agentsOf, parentOf, rootOf, agentsReach,
    spawnGuard, treeOf,
  };
}


function slatesArea(ctx: RuntimeContext): SlatesArea {
  const { opts, store, local, bus, clock, live, threadRecords, sessions, transcripts } = ctx;
  const slates: Slates = createSlates({
    store,
    now: () => clock.now(),
    record: e => ctx.record(e),
    emit: e => bus.emit(e),
    thread: threadId => {
      const latest = ctx.latestOn(threadId);
      const workspaceId = latest?.workspaceId ?? threadRecords.get(threadId)?.workspaceId;
      if (workspaceId === undefined) return undefined;
      const running = [...sessions.values()].find(s => s.view.threadId === threadId && s.view.status === "running");
      const entry = live.get(workspaceId);
      // A run starts where the thread's next turn would: the folder its session ran in, a --cwd or a worktree, else
      // the folder the workspace's kind holds its project in, on that kind's computer.
      const ranIn = latest?.cwd ?? (latest?.claudeSessionId === undefined ? undefined : ctx.folderOf(workspaceId, latest.claudeSessionId));
      if (entry === undefined) return { workspaceId, rootThreadId: ctx.rootOf(threadId), sessionId: latest?.claudeSessionId ?? latest?.id ?? threadId, ...(running !== undefined ? { turnId: running.turnId } : {}) };
      const folder = ctx.runsIn(entry, ranIn, ctx.moduleOf(entry.record.kind).folder(entry.record) ?? ctx.checkoutOf(entry.record));
      // A run on the host from a thread on a box starts in the project's folder here, where the project is also here.
      const here = isLocalWorkspace(entry.record) ? folder : existsSync(ctx.checkoutOf(entry.record)) ? ctx.checkoutOf(entry.record) : homedir();
      return {
        workspaceId,
        rootThreadId: ctx.rootOf(threadId),
        sessionId: latest?.claudeSessionId ?? latest?.id ?? threadId,
        ...(running !== undefined ? { turnId: running.turnId } : {}),
        folder,
        hostFolder: here,
        computer: ctx.computerOf(entry),
      };
    },
    machineOf: threadId => {
      const entry = ctx.boxOf(threadId);
      return entry?.machine;
    },
    asleep: threadId => {
      const entry = ctx.boxOf(threadId);
      return entry !== undefined && entry.record.phase !== "running";
    },
    wake: async threadId => {
      const entry = ctx.boxOf(threadId);
      if (entry !== undefined) await ctx.workspaces.wake(entry.record.id);
    },
    loaded: () => ctx.ready(),
    settled: async threadId => {
      const latest = ctx.latestOn(threadId);
      if (latest === undefined) return false;
      const own = threadRecords.get(threadId);
      const prefs = await ctx.preferences.get();
      const facts = { working: latest.status === "running", asking: latest.waitingOn !== undefined, failed: latest.status === "failed", startedAt: latest.startedAt ?? null, endedAt: latest.endedAt ?? null, readAt: own?.readAt ?? null, settledAt: own?.settledAt ?? null };
      return threadSettled(facts, clock.now(), SETTLE_MS[prefs.settleAfter]);
    },
    under: lead => ctx.treeUnder(lead),
    threadOfToken: token => ctx.threadOfToken(token),
    mcpServer: async (threadId, name) => {
      const workspaceId = ctx.latestOn(threadId)?.workspaceId ?? threadRecords.get(threadId)?.workspaceId;
      const harness = ctx.latestOn(threadId)?.harness ?? threadRecords.get(threadId)?.harness;
      const entry = workspaceId === undefined ? undefined : live.get(workspaceId);
      if (entry === undefined || harness === undefined) throw new Error(`thread ${threadId} has no workspace this host holds`);
      if (!isLocalWorkspace(entry.record)) throw new Error("a slate's tool runs start their server on this computer, and this thread runs on another");
      const reader = opts.agentsReader;
      if (reader?.server === undefined) throw new Error("this host reads no agent's MCP config");
      return reader.server({ kind: "here", projects: [{ id: workspaceId!, name: "thread", path: ctx.checkoutOf(entry.record) }] }, { agent: harness, name });
    },
    sources: (threadId, workspaceId) => ({
      threadId,
      workspaceId,
      now: clock.now(),
      rows: () => ctx.rowsOn(threadId).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
      results: () => (transcripts.get(workspaceId) ?? []).flatMap(e => (e.type === "session.done" && e.threadId === threadId ? [e.result] : [])),
      account: async () => {
        const entry = live.get(workspaceId);
        const harness = ctx.latestOn(threadId)?.harness ?? threadRecords.get(threadId)?.harness;
        if (entry === undefined || harness === undefined) return undefined;
        const key = ctx.usageAccountOf(entry, harness).key;
        return (await ctx.usageAccounts()).accounts.find(a => a.key === key);
      },
      workspace: () => {
        const entry = live.get(workspaceId);
        if (entry === undefined) return undefined;
        const project = entry.record.project;
        return {
          computer: ctx.computerOf(entry),
          ...(project !== undefined ? { project: ctx.projectHeld(project).name } : {}),
          folder: ctx.checkoutOf(entry.record),
          ...(entry.checkout !== undefined ? { checkout: entry.checkout } : {}),
          ...(entry.pr !== undefined ? { pr: entry.pr } : {}),
          rateUsdPerHour: entry.record.size === undefined ? 0 : ctx.backendFor(entry.record).pricing.rateUsdPerHour(entry.record.size),
          accruedUsd: ctx.accrued.get(workspaceId) ?? 0,
        };
      },
    }),
    deliver: async ({ threadId, workspaceId, prompt, requestId }) => {
      let queuedNow: (() => void) | undefined;
      const queued = new Promise<{ outcome: "queued" }>(resolve => {
        queuedNow = () => resolve({ outcome: "queued" });
      });
      const off = bus.on("session.queued", e => {
        if (e.type === "session.queued" && e.requestId === requestId) queuedNow?.();
      });
      try {
        const started = ctx.sessionsApi.start(workspaceId, { prompt, thread: threadId, requestId, startedBy: "person", via: "slate" });
        const first = await Promise.race([started, queued]);
        if ("outcome" in first && !("turnId" in first)) {
          started.catch((e: unknown) => console.warn(`a press waiting in thread ${threadWord(threadId)} was not sent: ${e instanceof Error ? e.message : String(e)}`));
          return { outcome: "queued" };
        }
        return { outcome: first.outcome, turnId: first.turnId };
      } finally {
        off();
      }
    },
    watchPr: workspaceId => {
      const entry = live.get(workspaceId);
      if (entry !== undefined) ctx.pollPullRequest(entry);
    },
    runEnv: () => local?.env() ?? (process.env as Record<string, string>),
    ...(opts.statePath !== undefined ? { secretsFile: join(ctx.stateFolder(), "slates.secrets.json"), slatesDir: join(ctx.stateFolder(), "slates") } : {}),
  });
  return { slates };
}

function channelsArea(ctx: RuntimeContext): ChannelsArea {
  const { local, placeDoor, clock, projectsHeld, threadRecords, sessions, transcriptIndex, places } = ctx;
  /** The harness session a thread's newest start in the transcript announced: what a send resumes once the thread's
   * rows have fallen off the index cap. */
  const startedAs = (workspaceId: string, threadId: string): string | undefined => transcriptIndex.get(workspaceId)?.starts.get(threadId);

  /** Whether the thread's last turn ended with no exit code and no result: the runtime or its transport ended the
   * process (a deadline, a host restart, a nap), so the harness resumes a transcript it never finished writing. */
  const cutBefore = (workspaceId: string, threadId: string): boolean => transcriptIndex.get(workspaceId)?.cut.get(threadId) ?? false;

  /** What a resumed session's turns carry, read the one way for every such fact: its own rows newest first, then,
   * past the session index cap, the newest start event of that session. The index keeps SESSION_INDEX_CAP rows per
   * workspace and drops the oldest finished ones while the transcript keeps the thread, so the events are where a
   * long-lived thread's own facts survive. Nothing from before a fact was recorded, and the start then fills what
   * its catalog marks. */
  const resumedFact = (workspaceId: string, resume: string, fact: "cwd" | "permissionMode" | "model"): string | undefined => {
    const rows = [...sessions.values()];
    for (let i = rows.length - 1; i >= 0; i--) {
      const view = rows[i]!.view;
      if (view.workspaceId === workspaceId && view.claudeSessionId === resume && view[fact] !== undefined) return view[fact];
    }
    return transcriptIndex.get(workspaceId)?.facts.get(resume)?.[fact];
  };

  /** The folder a resumed session's harness ran in. The CLI keys a session to that folder, so a resume anywhere
   * else opens nothing. */
  const folderOf = (workspaceId: string, resume: string): string | undefined => resumedFact(workspaceId, resume, "cwd");

  /** The access a thread's turns run at: its own record, then what its latest turn recorded for a thread from
   * before the record. A send that names none keeps the thread's own rather than falling back to the adapter's
   * unnamed default, which is bypass on every harness here; without this a second turn on a thread the person
   * opened at its harness's prompts would quietly skip them. */
  const accessOf = (workspaceId: string, threadId: string, resume: string | undefined): string | undefined =>
    threadRecords.get(threadId)?.permissionMode ?? (resume === undefined ? undefined : resumedFact(workspaceId, resume, "permissionMode"));

  /** What the runtime is doing to a machine's daemon, by workspace: the line its row shows while an update runs and
   * the sentence left there when one failed. Held here rather than on the record because it says what this process
   * is doing, not what the workspace is. */
  const daemonNotes = new Map<string, string>();

  /** The machine's home for the view, where the kind knows it. */
  const homeOf = (r: WorkspaceRecord): { home?: string } => {
    const home = ctx.moduleOf(r.kind).homeDir(r);
    return home !== undefined ? { home } : {};
  };

  /** Which provider forked this workspace's machine, by the id a registry gives the module that did it. A record
   * that names the computer it was forked on reads that computer's own offer, since the machine was never at this
   * host's provider; every other driven kind reads the module this host wired, one at a time. A kind whose machine
   * the person owns is forked by nobody and carries none, and so does a place this host has not yet heard what it
   * forks with. The one reading of where a machine lives, so this and `place` on one view cannot disagree. */
  const providerOf = (r: WorkspaceRecord): string | undefined =>
    r.place !== undefined ? placeDoor?.offerOf(r.place) : kindWords(r.kind).driven ? places.wired : undefined;
  /** The row of the places list a workspace stands on: this computer for a folder here, else the computer its record
   * names, else the provider it forks at. */
  const placeIdOf = (r: WorkspaceRecord): string | undefined => (isLocalWorkspace(r) ? HERE_PLACE_ID : (r.place ?? providerOf(r)));
  /** What the person set on the place a workspace, or a workspace about to land, stands on. */
  const settingsAt = (placeId: string | undefined): PlaceSettings | undefined => (placeId === undefined ? undefined : placeDoor?.settingsAt(placeId));
  /** The wall a turn on a workspace runs under, off the row of the place it stands on, none being no limit. Nothing
   * where the door lists no row for it, which leaves the reader its own default. */
  const turnLimitOf = (r: WorkspaceRecord): MachineExecOptions | undefined => {
    const placeId = placeIdOf(r);
    const limit = placeId === undefined ? undefined : placeDoor?.turnLimitAt(placeId);
    return limit === undefined ? undefined : { deadlineMs: limit ?? Number.POSITIVE_INFINITY };
  };
  /** The switch a workspace runs under, read off its own record alone and never its tree's root. */
  const agentsHeld = (r: WorkspaceRecord): WorkspaceAgents => r.agents ?? spawnAt(placeIdOf(r));
  /** The switch a place gives its workspaces: the parts the person set there over the default as it reads now. */
  const spawnAt = (placeId: string | undefined): WorkspaceAgents => agentsFrom(undefined, settingsAt(placeId)?.spawn ?? {});

  /** The project a record names. A record whose project this host does not hold is the one shape the boot refuses,
   * so every read after the boot has one. */
  const projectHeld = (id: string): ProjectView => {
    const found = projectsHeld.get(id);
    if (found === undefined) throw new Error(noSuchProjectLine(id, [...projectsHeld.values()].map(p => p.name)));
    return found;
  };

  /** What a workspace's view carries about its project: the four facts a row and a thread need, joined rather than
   * stored a second time. */
  const refOf = (p: ProjectView): ProjectRef => ({ id: p.id, name: p.name, path: p.path, computer: p.computer });

  /** Where a record's threads work: the project's own path (the clone inside a fork, the folder on this computer),
   * or the same folder inside the worktree the record names. A worktree that is gone answers the project's path, so
   * its threads go on there. */
  const checkoutOf = (r: WorkspaceRecord): string => {
    const project = projectHeld(r.project);
    const tree = r.worktree;
    if (tree === undefined || tree.gone === true) return project.path;
    return join(tree.path, relative(project.git?.top ?? project.path, project.path));
  };
  /** What the computer holding a workspace is called, for the sentences about a workspace whose daemon is that
   * computer's own: the name the person gave that computer, or the word for its kind of machine. */
  const computerOf = (entry: LiveWorkspace): string =>
    entry.record.place !== undefined ? (placeDoor?.nameOf(entry.record.place) ?? entry.record.place) : machineWord(entry.record.kind);

  /** The computer a workspace's daemon is that computer's own: a workspace on a computer somebody owns runs no
   * daemon inside it, so its machine answers the daemon's frames itself, over the link the host already holds.
   * Read in one place, since it decides both which road the frames take and whether anything dials at all. */
  const servedByItsComputer = (entry: LiveWorkspace): ((frame: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined =>
    entry.machine.daemonFrame?.bind(entry.machine);

  /** One dial of a workspace's own daemon, for the frames this host sends itself and for a client of this host
   * driving that daemon one frame at a time: the road its kind answers, and the one sentence for a machine with no
   * daemon answering on it yet. The caller closes what it opened. */
  const ownDaemonChannel = async (entry: LiveWorkspace, onEvent: (event: Record<string, unknown>) => void): Promise<DaemonChannel> =>
    channelOver(await ctx.moduleOf(entry.record.kind).daemonRoad(entry), entry.record.name, onEvent);
  const channelOver = (reach: DaemonReachView, name: string, onEvent: (event: Record<string, unknown>) => void): Promise<DaemonChannel> => {
    if (reach.daemonToken === undefined) throw new Error(`${name} is not answering yet`);
    return ctx.openChannel({ url: reach.url, token: reach.daemonToken, onEvent });
  };

  /** The frames this host sends a workspace's daemon itself, on a channel closed however the work ends: the road
   * the app's panes take for git.status, taken here for the two a bring back is made of. A refusal comes back
   * with the code the daemon put on it, so a caller reads the reason rather than the sentence.
   *
   * Where the workspace's daemon is the computer's own, the frames go up that computer's link with the workspace
   * named on each one and nothing is dialled. A daemon too old to read that name cannot seal the link, so one that
   * is merely behind still answers here. */
  const withDaemon = async <T>(entry: LiveWorkspace, work: (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> => {
    const served = servedByItsComputer(entry);
    if (served !== undefined) return work(async frame => replyOf(frame, await served(frame)));
    return overChannel(await ownDaemonChannel(entry, () => {}), work);
  };
  /** A daemon's reply to one of this host's own frames, or its refusal thrown with the code the daemon put on it. */
  const replyOf = (frame: DaemonFrame, reply: Record<string, unknown>): Record<string, unknown> => {
    if (reply["ok"] === true) return reply;
    throw new DaemonRefusal(typeof reply["code"] === "string" ? reply["code"] : undefined, String(reply["error"] ?? `${frame.op} was refused`));
  };
  const overChannel = async <T>(channel: DaemonChannel, work: (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> => {
    try {
      return await work(async frame => replyOf(frame, (await channel.send(frame)) as Record<string, unknown>));
    } finally {
      channel.close();
    }
  };

  /** The frames this host sends the daemon of the computer it runs on, which runs the git host's own signed-in command
   * line as the person, in their home, with the repository named off the project's record: every read of a pull
   * request goes this road first, so no copy is woken for one. A host that wired no daemon here reads as a computer
   * with no command line for the host. */
  const onThisComputer = async <T>(work: (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>, home: string) => Promise<T>): Promise<T> => {
    if (local?.daemonRoad === undefined) throw new DaemonRefusal("no-host-cli", "this host runs no daemon on this computer");
    const home = local.homeDir;
    return overChannel(await channelOver(await ctx.localRoad(), THIS_COMPUTER, () => {}), ask => work(ask, home));
  };

  /** Refuses a new machine on a place whose spend today has reached its spend per day. Only a cloud has one, so a copy
   * on this computer or a fork on a box is never refused here, and the machines already running are not touched. */
  const placeGuard = async (placeId: string): Promise<void> => {
    if (placeDoor === undefined) return;
    const rows = await placeDoor.rows();
    const row = rows.find(r => r.id === placeId);
    const limit = row === undefined ? undefined : placeSpendLimit(row);
    if (row === undefined || limit === undefined) return;
    const todayUsd = (await ctx.status.spend(rows, clock.now())).find(s => s.place === placeId)?.todayUsd;
    if (todayUsd !== undefined && placeAtLimitLine(row, todayUsd) !== undefined) throw new Error(spendCapRefusal(row.name, todayUsd, limit));
  };

  /** Refuses whatever runs inside a copy (a create, a turn, a command, a port, a bring back) on a computer
   * whose doctor says it cannot run workspaces, in the sentence its row carries; a delete, a remove and an update
   * need no copy running and never ask. */
  const placeRefuses = async (placeId: string | undefined): Promise<void> => {
    const blocked = await blockedLine(placeId);
    if (blocked !== undefined) throw new Error(blocked);
  };
  const blockedLine = async (placeId: string | undefined): Promise<string | undefined> => {
    if (placeId === undefined || placeDoor === undefined) return undefined;
    const report = await placeDoor.reportOf(placeId);
    return report === undefined ? undefined : placeBlocked(placeDoor.nameOf(placeId), report);
  };
  const copyBlocked = (entry: LiveWorkspace): Promise<void> => placeRefuses(entry.record.place);

  /** The frames a place daemon stamps with the workspace they are of: a guest session's, by the listener it arrived
   * on and never anything the guest said, and a tunnel's, by the workspace it was opened inside. */
  const GUEST_EVENTS = ["guest.opened", "guest.message", "guest.closed", "tunnel.data", "tunnel.end"];
  /** What a pty pushes, each naming the pty it is of; a computer answering for many workspaces pushes every
   * workspace's up the one link. */
  const PTY_EVENTS = ["pty.data", "pty.exit", "pty.mode"];
  /** The two a pane opens every link with, and the two a workspace on a computer somebody owns has no answer of
   * its own for: the ports and the load that computer's daemon reads are the whole computer's. */
  const COMPUTER_WATCHES = ["ports.watch", "sys.watch"];
  /** That computer's daemon watches, reads and signals any pid on it and names no workspace on its answers, and the
   * one watch it holds is the link's, which the computer's own page shares. */
  const COMPUTER_PROCS = ["proc.watch", "proc.unwatch", "proc.inspect", "proc.kill"];
  /** The whole of what a client's channel into a served workspace carries, for the reason DEVICE_OPS is a list: that
   * computer's daemon runs every other op on the computer itself, so a deny list would let an op added later reach it.
   * Each of these names the workspace it is for, and the daemon answers it inside that workspace. */
  const WORKSPACE_FRAMES = ["pty.create", "pty.attach", "pty.detach", "pty.write", "pty.resize", "pty.kill", "pty.tab", "pty.list", "fs.list", "fs.files", "fs.read", "fs.write", "fs.search", "git.status", "git.diff", "git.snapshot", "git.range", "git.turn", "git.push", "git.pr", "git.prList", "ping"];
  /** And the host's own guest road, which answers the sessions that computer relays by the id it gave them, and
   * carries an editor's ssh to the server it starts inside the workspace. A client's channel carries neither: a
   * tunnel reaches any port inside the workspace, and only this host's relay listens for one. */
  const GUEST_ROAD_FRAMES = [...WORKSPACE_FRAMES, "guest.watch", "guest.reply", "guest.close", "ssh.start", "tunnel.open", "tunnel.write", "tunnel.close"];

  /** The ptys each local workspace's own channels opened, by pty, with the pid each leads. Every local workspace
   * dials the one daemon this host runs and its panes list every pty there, so the one a workspace opened is the
   * only record of whose it is. */
  const ownPtys = new Map<string, Map<string, number>>();
  /** Each local workspace's channels that watch ports, as the push that names that workspace's roots again. */
  const portWatchers = new Map<string, Set<() => void>>();
  /** The process group each local workspace's turns led, as the turn road launches them, kept past the turn for as
   * long as the group has members: a server the turn left in its group is still the workspace's, and the kernel
   * hands the number to nobody else while one is there. */
  const turnGroups = new Map<string, Set<number>>();
  /** How often the turns' groups are read again while any workspace holds one, so a group that emptied stops being a
   * root before the kernel can hand its number to a stranger's group, whether or not a channel watches. */
  const PORT_ROOTS_RECHECK_MS = 5_000;
  const armRootsRecheck = (): void => {
    if (ctx.state.rootsRecheck !== undefined) return;
    ctx.state.rootsRecheck = setInterval(() => {
      for (const id of [...turnGroups.keys()]) portRootsMoved(id);
      if (turnGroups.size > 0) return;
      clearInterval(ctx.state.rootsRecheck);
      ctx.state.rootsRecheck = undefined;
    }, PORT_ROOTS_RECHECK_MS);
    ctx.state.rootsRecheck.unref();
  };
  /** The processes whose listeners are a local workspace's: each of its turns' groups that still has members, and
   * each terminal its channels opened. Never the host, which every workspace here runs under. */
  const portRootsOf = (workspaceId: string): number[] => {
    const roots = new Set<number>();
    const groups = turnGroups.get(workspaceId);
    for (const pid of groups ?? []) {
      if (groupExists(pid)) roots.add(pid);
      else groups?.delete(pid);
    }
    if (groups?.size === 0) turnGroups.delete(workspaceId);
    for (const pid of ownPtys.get(workspaceId)?.values() ?? []) roots.add(pid);
    return [...roots].sort((a, b) => a - b);
  };
  /** Reads the workspace's roots now, which drops a turn's group that emptied, and names them again to every channel
   * that watches. */
  const portRootsMoved = (workspaceId: string): void => {
    portRootsOf(workspaceId);
    for (const push of portWatchers.get(workspaceId) ?? []) push();
  };
  /** A local workspace's channel with its ports.watch rooted at that workspace's processes and its folder, named
   * again on the same socket each time they move; the daemon answers a second watch with what the new roots opened
   * and closed. */
  const rootedPorts = (workspaceId: string, folder: string, ptys: Map<string, number>, channel: DaemonChannel): DaemonChannel => {
    /** The roots this channel last named, undefined until it watches. */
    let told: string | undefined;
    const fresh = (): number[] | undefined => {
      const roots = portRootsOf(workspaceId);
      if (roots.join(",") === told) return undefined;
      told = roots.join(",");
      return roots;
    };
    const push = (): void => {
      if (told === undefined) return;
      const roots = fresh();
      if (roots !== undefined) void channel.send({ id: null, op: "ports.watch", roots, folder } as DaemonFrame).catch(() => undefined);
    };
    const watchers = portWatchers.get(workspaceId) ?? new Set<() => void>();
    portWatchers.set(workspaceId, watchers);
    watchers.add(push);
    const stop = (): void => {
      watchers.delete(push);
    };
    void channel.closed.then(stop, stop);
    return {
      async send(frame) {
        if (frame.op === "ports.watch") {
          told = undefined;
          return channel.send({ ...frame, roots: fresh() ?? [], folder } as DaemonFrame);
        }
        const reply = await channel.send(frame);
        const said = reply as Record<string, unknown>;
        if (frame.op === "pty.create" && said["ok"] === true && typeof said["pid"] === "number") {
          ptys.set(String(said["ptyId"]), said["pid"]);
          portRootsMoved(workspaceId);
        }
        // A pty that exited while none of this workspace's channels listened sent it no pty.exit; the list the panes
        // ask for on every connect is what says it is gone, before its pid can be handed to a stranger.
        if (frame.op === "pty.list" && said["ok"] === true && Array.isArray(said["ptys"])) {
          const standing = new Set((said["ptys"] as Record<string, unknown>[]).filter(row => row["exited"] !== true).map(row => String(row["id"])));
          const gone = [...ptys.keys()].filter(id => !standing.has(id));
          for (const id of gone) ptys.delete(id);
          if (gone.length > 0) portRootsMoved(workspaceId);
        }
        return reply;
      },
      close: () => {
        stop();
        channel.close();
      },
      closed: channel.closed,
    };
  };

  /** The channel a client of this host drives a served workspace's daemon over: every frame it carries goes up that
   * computer's link with the workspace named on it, and the events that come back are the ones this workspace's,
   * read off the link every road on that computer shares. Nothing is dialled and no token is spent, since the
   * road is the link that computer opened.
   *
   * Its own hello opens it. The link's hello named the computer's home, and a client builds this workspace's
   * paths off the root it reads here. */
  const servedChannel = async (
    entry: LiveWorkspace,
    served: (frame: Record<string, unknown>) => Promise<Record<string, unknown>>,
    onEvent: (event: Record<string, unknown>) => void,
    carries: readonly string[],
  ): Promise<DaemonChannel> => {
    const placeId = entry.record.place;
    // A machine that answers its own daemon frames is one on a computer this host holds a link to.
    if (placeId === undefined || placeDoor === undefined) throw new Error(placeServesDaemonLine(entry.record.name, computerOf(entry)));
    const door = placeDoor;
    const version = (await door.reportOf(placeId))?.daemonVersion;
    const machineId = entry.machine.id;
    const checkout = checkoutOf(entry.record);
    /** The ptys on that computer this channel named, so an event of a pty another pane opened is not pushed at
     * this one; of those, the ones it is listening to, which it takes its listeners off when it goes. */
    const named = new Set<string>();
    const attached = new Set<string>();
    const link = door.channel(placeId, event => {
      const type = String(event["type"]);
      if (GUEST_EVENTS.includes(type)) {
        if (event["machineId"] === machineId) onEvent(event);
        return;
      }
      if (!PTY_EVENTS.includes(type) || !named.has(String(event["ptyId"]))) return;
      // A pty that exited holds no listener worth taking off, so the close below asks only for the ones that stand.
      if (type === "pty.exit") attached.delete(String(event["ptyId"]));
      onEvent(event);
    });
    if (link === undefined) throw new Error(absentComputer(door.nameOf(placeId), null).sentence);
    /** What this channel now holds on the far end, off a frame it sent and the answer to it. */
    const held = (op: string, frame: Record<string, unknown>, reply: Record<string, unknown>): void => {
      if (op === "pty.create") {
        named.add(String(reply["ptyId"]));
        return;
      }
      if (op === "pty.list") {
        for (const row of Array.isArray(reply["ptys"]) ? (reply["ptys"] as Record<string, unknown>[]) : []) named.add(String(row["id"]));
        return;
      }
      const ptyId = String(frame["ptyId"]);
      if (op === "pty.attach") {
        named.add(ptyId);
        attached.add(ptyId);
      }
      if (op === "pty.detach" || op === "pty.kill") attached.delete(ptyId);
    };
    onEvent({ type: "daemon.hello", root: checkout, ...(version !== undefined ? { version } : {}) });
    return {
      async send(frame) {
        const op = frame.op;
        if (COMPUTER_WATCHES.includes(op)) return { id: null, ok: false, code: "unsupported", error: placeWatchesItselfLine(door.nameOf(placeId)) };
        if (COMPUTER_PROCS.includes(op)) return { id: null, ok: false, code: "unsupported", error: forkProcsUnreadLine(entry.record.name, door.nameOf(placeId)) };
        if (!carries.includes(op)) return { id: null, ok: false, code: "unsupported", error: forkOpRefusedLine(op, entry.record.name, door.nameOf(placeId)) };
        // The pane's first tab names no folder, and the daemon answering for a workspace has no working directory
        // inside it: without one the shell would open in the home of the computer, which is bound in.
        const asked = op === "pty.create" && frame["cwd"] === undefined ? { ...frame, cwd: checkout } : frame;
        const reply = await served(asked);
        if (reply["ok"] === true) held(op, asked, reply);
        return { id: null, ...reply } as DaemonResponse;
      },
      close: () => {
        // Every channel on that computer rides the one socket its link is, so a pane that goes says which ptys it
        // is done with; the socket's own close would be the link's, and that is the whole computer going.
        for (const ptyId of attached) void served({ op: "pty.detach", ptyId }).catch(() => undefined);
        attached.clear();
        link.close();
      },
      closed: link.closed,
    };
  };

  /** All a channel into a copy on a computer that cannot run workspaces carries out: a stopped copy's git.status
   * reads its files, and ping is the beat a pane's link opens on. In comes only their answers and the open's hello,
   * which names the root git.status is asked under; a session or a pty the computer pushes never reaches a door. */
  const BLOCKED_READS: ReadonlySet<string> = new Set(["git.status", "ping"]);
  const copyChannel = async (entry: LiveWorkspace, onEvent: (event: Record<string, unknown>) => void, carries: readonly string[]): Promise<DaemonChannel> => {
    const said = await blockedLine(entry.record.place);
    const heard = (event: Record<string, unknown>): void => {
      if (said === undefined || event["type"] === "daemon.hello") onEvent(event);
    };
    const served = servedByItsComputer(entry);
    const channel = await (served === undefined ? ownDaemonChannel(entry, heard) : servedChannel(entry, served, heard, carries));
    if (said === undefined) return channel;
    return {
      send: frame => (BLOCKED_READS.has(frame.op) ? channel.send(frame) : Promise.resolve({ id: null, ok: false, code: "unsupported", error: said })),
      close: () => channel.close(),
      closed: channel.closed,
    };
  };


  /** Where a child starts: its lead's own work branch, read off the lead's copy now and pushed first where it holds
   * commits the remote lacks, so the child's copy can start on it wherever that copy is made. Never the branch the
   * lead's work started from, which is pushed by nothing here: a lead on it, or on a branch with nothing over it, has
   * its children start where it started. A copy that did not say which branch it is on refuses the fork, since a
   * child that quietly started elsewhere would land its work elsewhere; so does a push refused, in its own words.
   * Answers the child's base and the lines the lead reads: the push, and the changes it could not carry. */
  const leadStart = async (lead: LiveWorkspace, child: string): Promise<ChildStart> => {
    await copyBlocked(lead);
    const project = projectHeld(lead.record.project);
    const started = lead.record.base ?? project.base ?? project.defaultBranch;
    const cwd = checkoutOf(lead.record);
    const said = await withDaemon(lead, ask => ask({ op: "git.status", cwd })).catch((e: unknown) => {
      throw new Error(branchUnreadRefusal(lead.record.name, e instanceof Error ? e.message : String(e)));
    });
    const read = GitStatusReply.parse(said);
    const branch = read.branch.head;
    const changed = read.entries.filter(e => e.xy !== "!!").length;
    const stayed = changed > 0 ? [uncommittedStayed(changed, lead.record.name)] : [];
    if (branch === "" || branch === DETACHED_HEAD || branch === started) return { base: started, onLeads: false, lines: stayed };
    // Ahead counts against the upstream where the branch has one, and against the default branch where it has none. An
    // upstream of another name holds nothing under this branch's own, so the push is what puts it on the remote.
    // A branch cut from the base's own remote branch with nothing ahead of it holds nothing over the base either.
    const upstream = read.branch.upstream;
    const tracksItself = upstream !== undefined && upstream.endsWith(`/${branch}`);
    const tracksBase = upstream !== undefined && started !== undefined && upstream.endsWith(`/${started}`);
    const holdsNew = read.branch.ahead > 0 || read.countsUnknown === true || (upstream !== undefined && !tracksItself && !tracksBase);
    if (!holdsNew) return tracksItself ? { base: branch, onLeads: true, lines: stayed } : { base: started, onLeads: false, lines: stayed };
    const pushed = await withDaemon(lead, ask => ask({ op: "git.push", cwd, ...(started !== undefined ? { base: started } : {}) })).catch((e: unknown) => {
      throw new Error(forkNeedsPushLine(lead.record.name, e instanceof Error ? e.message : String(e)));
    });
    const push = GitPushReply.parse(pushed);
    void ctx.readCheckout(lead, true);
    return { base: push.branch, onLeads: true, lines: [pushedForChildLine(push.branch, child), ...stayed] };
  };

  /** A child's copy put on its lead's branch as pushed, through the child's own daemon: the copy was made where the
   * project starts, since no copier sees a branch only a remote holds. A copy that would not go there is deleted with
   * the create that made it and the fork is refused in its sentence. Answers the line the fork says. */
  const startChildOn = async (child: LiveWorkspace, branch: string, lead: string): Promise<string> => {
    try {
      const put = GitStartOnReply.parse(await withDaemon(child, ask => ask({ op: "git.startOn", cwd: checkoutOf(child.record), branch })));
      if (child.record.worktree !== undefined) child.record.worktree = { ...child.record.worktree, branch: put.branch };
      await ctx.persist(child.record);
      void ctx.readCheckout(child, true);
      return childStartedLine(child.record.name, put.branch);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await ctx.workspaces.delete(child.record.id).catch((d: unknown) => console.warn(`${child.record.name} was not put on ${branch} and was not deleted: ${d instanceof Error ? d.message : String(d)}`));
      throw new Error(forkNeedsPushLine(lead, why));
    }
  };

  /** Whether two projects are one repository: the same host and the same owner and name off their remotes. A project
   * with no remote a host names is one repository with nothing but itself. */
  const sameRepository = (a: ProjectView, b: ProjectView): boolean => {
    const host = remoteHost(a.remote);
    const repo = ownerRepoOf(a.remote)?.toLowerCase();
    return host !== undefined && repo !== undefined && host === remoteHost(b.remote) && repo === ownerRepoOf(b.remote)?.toLowerCase();
  };
  return {
    startedAs, cutBefore, resumedFact, folderOf, accessOf, daemonNotes, homeOf, providerOf, placeIdOf, settingsAt,
    turnLimitOf, agentsHeld, spawnAt, projectHeld, refOf, checkoutOf, computerOf, servedByItsComputer, channelOver,
    withDaemon, overChannel, onThisComputer, placeGuard, placeRefuses, copyBlocked, WORKSPACE_FRAMES, GUEST_ROAD_FRAMES,
    ownPtys, turnGroups, armRootsRecheck, portRootsMoved, rootedPorts, copyChannel, leadStart, startChildOn,
    sameRepository,
  };
}

function recordsArea(ctx: RuntimeContext): RecordsArea {
  const { backend, store, hostId, live, places } = ctx;
  const view = (r: WorkspaceRecord): WorkspaceView => ({
    ...((): { folder?: string } => {
      const folder = ctx.moduleOf(r.kind).folder(r);
      return folder !== undefined ? { folder } : {};
    })(),
    ...ctx.homeOf(r),
    id: r.id,
    name: r.name,
    machineId: r.machineId,
    phase: r.phase,
    kind: r.kind,
    golden: r.golden,
    createdAt: r.createdAt,
    project: ctx.refOf(ctx.projectHeld(r.project)),
    ...(r.worktree !== undefined ? { worktree: r.worktree } : {}),
    ...(r.from !== undefined ? { from: r.from } : {}),
    ...(r.review !== undefined ? { review: r.review } : {}),
    ...(r.claudeSessionId !== undefined ? { claudeSessionId: r.claudeSessionId } : {}),
    ...(r.screen !== undefined ? { screen: r.screen } : {}),
    ...(r.gone !== undefined ? { gone: r.gone } : {}),
    ...(r.theme !== undefined ? { theme: r.theme } : {}),
    ...(r.glyph !== undefined ? { glyph: r.glyph } : {}),
    ...(ctx.daemonNotes.has(r.id) ? { daemonNote: ctx.daemonNotes.get(r.id)! } : {}),
    ...(r.daemonRefusedAt !== undefined ? { daemonRefusedAt: r.daemonRefusedAt } : {}),
    ...(r.vaultedAt !== undefined ? { vaultedAt: r.vaultedAt } : {}),
    ...(r.vaultRefused !== undefined ? { vaultRefused: r.vaultRefused } : {}),
    ...(r.wakeRefused !== undefined ? { wakeRefused: r.wakeRefused } : {}),
    ...(ctx.agentsOf(r) !== undefined ? { agents: ctx.agentsOf(r)! } : {}),
    ...(r.parentThreadId !== undefined ? { parentThreadId: r.parentThreadId } : {}),
    ...(r.rootThreadId !== undefined ? { rootThreadId: r.rootThreadId } : {}),
    ...(r.parentWorkspaceId !== undefined ? { parentWorkspaceId: r.parentWorkspaceId } : {}),
    ...(r.place !== undefined ? { place: r.place } : {}),
    ...(ctx.providerOf(r) !== undefined ? { provider: ctx.providerOf(r)! } : {}),
  });

  /** One fact of a workspace's look: a value sets it, null clears it back to none, and undefined leaves what the
   * record holds, so a picker sends its own fact without reading the other's. */
  const putLook = <K extends "theme" | "glyph">(r: WorkspaceRecord, key: K, value: WorkspaceRecord[K] | null | undefined): void => {
    if (value === undefined) return;
    if (value === null) delete r[key];
    else r[key] = value;
  };

  const persist = async (r: WorkspaceRecord): Promise<void> => {
    const entry = live.get(r.id);
    if (entry !== undefined) entry.generation++;
    await store.put(WORKSPACES, r.id, r);
    // The two facts a machine's own labels cannot carry, written beside the record rather than only on a rename:
    // a sweep that finds the machine after this document is lost puts the record back under both.
    await store.put(WORKSPACE_NAMES, r.id, { workspaceId: r.id, name: r.name, project: r.project } satisfies NamedWorkspace);
  };

  const shapeOf = async (m: Machine): Promise<MachineShape | undefined> => {
    if (!m.describe) return undefined;
    return m.describe().catch(() => undefined);
  };

  /** The provider's word on what it built, falling back to the request where it has none. */
  const sizeBuilt = (shape: MachineShape | undefined, asked: WorkspaceSize): WorkspaceSize => ({
    cpu: shape?.cpu ?? asked.cpu,
    memMb: shape?.memMb ?? asked.memMb,
  });

  /** The guest's own count of its memory onto the row, since the provider's view echoes the memory asked for; true
   * where the count was read. A place's daemon already answers the size it applied and is never asked. */
  const readMemory = async (record: WorkspaceRecord, machine: Machine, sizes: MachineBackend["capabilities"]["sizes"]): Promise<boolean> => {
    const memMb = await machine.exec(MEM_READ, { timeoutMs: INLINE_EXEC_MS }).then(
      res => (res.exitCode === 0 ? memMbOf(readValues(res.stdout)) : `exit ${res.exitCode}${res.stderr.trim() === "" ? "" : `: ${res.stderr.trim().slice(-200)}`}`),
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    if (typeof memMb === "string") console.warn(`workspace ${record.id}: memory not read on ${machine.id} (${memMb}); the row keeps ${sizeWord(record.size)}`);
    if (typeof memMb !== "number") return false;
    // The kernel keeps a few percent back: 4032 MB read on a 4096 MB machine.
    const offered = sizes.find(s => Math.abs(s.memMb - memMb) <= s.memMb / 16);
    // The count is the guest's word, and a guest can print any figure: no row or rate goes past the largest offer.
    const largest = Math.max(0, ...sizes.map(s => s.memMb));
    record.size = { ...record.size, memMb: offered?.memMb ?? (largest > 0 ? Math.min(memMb, largest) : memMb) };
    return true;
  };

  /** The workspaces forked from this snapshot, whatever their phase: the lineage retention must not cut. */
  const forkedFrom = (snapshotId: string): string[] => [...live.values()].filter(e => e.record.golden === snapshotId).map(e => e.record.name);
  /** A place's copy of a golden. A state file the boot has not migrated yet carries the wired place's copy under
   * the bare name, so that key is read as a fallback for the wired place and for no other: a copy under the bare
   * key was built where this host forks, and reading it as another place's would say a place holds an image it has
   * never seen. */
  const bareFallback = (place: string): boolean => place === places.wired;
  const copyOf = async (place: string, name: string): Promise<GoldenManifest | undefined> =>
    ((await store.get(GOLDENS, copyKey(place, name))) ?? (bareFallback(place) ? await store.get(GOLDENS, name) : undefined)) as GoldenManifest | undefined;
  const putCopy = (place: string, name: string, manifest: GoldenManifest): Promise<void> => store.put(GOLDENS, copyKey(place, name), manifest);
  const copyRecipeOf = async (place: string, name: string, version: number): Promise<RecipeDigest | undefined> =>
    ((await store.get(GOLDEN_RECIPES, copyKey(place, recipeKey(name, version)))) ??
      (bareFallback(place) ? await store.get(GOLDEN_RECIPES, recipeKey(name, version)) : undefined)) as RecipeDigest | undefined;
  const putCopyRecipe = (place: string, name: string, version: number, digest: RecipeDigest): Promise<void> =>
    store.put(GOLDEN_RECIPES, copyKey(place, recipeKey(name, version)), digest);
  const dropCopyRecipe = async (place: string, name: string, version: number): Promise<void> => {
    await store.delete(GOLDEN_RECIPES, copyKey(place, recipeKey(name, version)));
    if (bareFallback(place)) await store.delete(GOLDEN_RECIPES, recipeKey(name, version));
  };

  /** A state file written before a golden was one place's copy holds its manifests and recipes under the bare name.
   * Each one moves under the wired place, and the old key goes only once the new one is there to be read: a put
   * that did not land leaves the copy where it was rather than taking it with the key.
   *
   * A host whose module forks nothing has no place to file a copy under: it is the module a host with no provider
   * key starts on, and the key it is given later swaps a different module in. Filing the golden under that module
   * would put it out of reach of every boot after the swap, so nothing moves until a boot knows what it forks on.
   * Runs once, at boot. */
  const migrateCopies = async (): Promise<void> => {
    if (forksNoMachines((places.backend(places.wired) ?? backend).capabilities)) return;
    for (const collection of [GOLDENS, GOLDEN_RECIPES]) {
      for (const key of await store.keys(collection)) {
        if (key.includes("/")) continue;
        const moved = copyKey(places.wired, key);
        if ((await store.get(collection, moved)) === undefined) {
          await store.put(collection, moved, await store.get(collection, key));
          // Read back before the old key goes: a put that did not land would take the copy with it.
          if ((await store.get(collection, moved)) === undefined) continue;
        }
        await store.delete(collection, key);
      }
    }
  };

  /** The image record this host owns for a golden: the one written at the seal, or, for a golden sealed before
   * records existed, what its wired copy's head already says. A backfilled record carries no small recipe and no
   * vault, so `wsp image` says the sign-ins are not held and a copy of it is refused until the next version. */
  const recordOf = async (name: string): Promise<SealedImage | undefined> => {
    const stored = (await store.get(IMAGES, name)) as SealedImage | undefined;
    if (stored !== undefined) return stored;
    const head = goldenHead(await copyOf(places.wired, name));
    if (head === undefined) return undefined;
    const digest = await copyRecipeOf(places.wired, name, head.version);
    const hash = digest === undefined ? "" : recipeHash(digest);
    return {
      name,
      version: head.version,
      hash: imageHash(hash, undefined, []),
      recipeHash: hash,
      logins: head.logins ?? [],
      sealedAt: head.createdAt,
      sealedFrom: hostId,
      ...(head.usedBytes !== undefined ? { usedBytes: head.usedBytes } : {}),
    };
  };

  /** Every snapshot and template id this state file stands on: each golden's versions and their templates, each
   * project golden, and the image every live workspace forks from. A row wsp made that is in none of them is an
   * orphan, whatever its name; a row in one of them is kept even when its name predates the owner mark. */
  const recordedImages = async (): Promise<Set<string>> => {
    const ids = new Set<string>();
    for (const raw of await store.list(GOLDENS)) {
      for (const v of (raw as GoldenManifest).versions) {
        ids.add(v.snapshotId);
        if (v.templateId !== undefined) ids.add(v.templateId);
      }
    }
    for (const raw of await store.list(PROJECT_GOLDENS)) ids.add((raw as ProjectGolden).snapshotId);
    for (const e of live.values()) ids.add(e.record.golden);
    return ids;
  };

  /** The manifest holding this snapshot as one of its versions, if any does. */
  const goldenManifestOf = async (snapshotId: string): Promise<GoldenManifest | undefined> => {
    for (const raw of await store.list(GOLDENS)) {
      const m = raw as GoldenManifest;
      if (m.versions.some(v => v.snapshotId === snapshotId)) return m;
    }
    return undefined;
  };

  /** The sealed version behind this snapshot, if any manifest knows it. */
  const goldenVersionOf = async (snapshotId: string): Promise<GoldenVersion | undefined> =>
    (await goldenManifestOf(snapshotId))?.versions.find(v => v.snapshotId === snapshotId);

  /** Whether the small recipe this version was sealed from asks for the engine socket on every fork: the sealed
   * record of the image whose wired copy holds this version says. A version no record names asks for none. */
  const recipeAsksEngine = async (version: GoldenVersion): Promise<boolean> => {
    for (const raw of await store.list(IMAGES)) {
      const image = raw as SealedImage;
      // A copy at any place carries the record's hash it was built from, whatever version number that place gave it.
      if (version.imageHash !== undefined && version.imageHash === image.hash) return image.recipe?.engine === true;
      if (image.version !== version.version) continue;
      const manifest = await copyOf(places.wired, image.name);
      if (manifest?.versions.some(v => v.snapshotId === version.snapshotId && v.version === version.version)) return image.recipe?.engine === true;
    }
    return false;
  };

  /** What stands behind a snapshot a workspace forks from: a golden version, or a project golden and the version at
   * the root of its lineage. `golden` is that root's snapshot id, the one a snapshot taken from the fork records. */
  const imageOf = async (snapshotId: string): Promise<{ golden: string; version?: GoldenVersion; projects?: WorkspaceProject[] }> => {
    const version = await goldenVersionOf(snapshotId);
    if (version !== undefined) return { golden: snapshotId, version };
    const stored = await store.get(PROJECT_GOLDENS, snapshotId);
    if (stored === undefined) return { golden: snapshotId };
    const project = projectGoldenOf(stored);
    const root = await goldenVersionOf(project.golden);
    return { golden: project.golden, ...(root !== undefined ? { version: root } : {}), projects: project.projects };
  };

  /** A project golden as stored, read as one of today: a manifest from before a snapshot carried every project on
   * the disk named the one it was taken for under `project`, and reads as a golden of that one. */
  const projectGoldenOf = (raw: unknown): ProjectGolden => {
    const { project: single, ...rest } = raw as Omit<ProjectGolden, "projects"> & { projects?: WorkspaceProject[]; project?: WorkspaceProject };
    return { ...rest, projects: rest.projects ?? (single !== undefined ? [single] : []) };
  };
  return {
    view, putLook, persist, shapeOf, sizeBuilt, readMemory, forkedFrom, copyOf, putCopy, copyRecipeOf, putCopyRecipe,
    dropCopyRecipe, migrateCopies, recordOf, recordedImages, goldenManifestOf, recipeAsksEngine, imageOf,
    projectGoldenOf,
  };
}


function pullRequestsArea(ctx: RuntimeContext): PullRequestsArea {
  const { clock, githubCache, live, sessions } = ctx;
  /** Whether a workspace's copy can read the git host itself where this computer cannot: one on a machine of its own,
   * running. A copy on this computer runs this computer's command line, and a stopped one is never woken for a read. */
  const copyReadsHost = (entry: LiveWorkspace): boolean => !isLocalWorkspace(entry.record) && entry.record.phase === "running";

  /** One read of the git host for a workspace: on this computer, then through the copy's own daemon where this computer
   * has no signed-in command line for the host and the copy can read it. The frame names the remote off the project's
   * record on either road, never the copy's own configuration, which the agent writes. The copy's gh is on a PATH its
   * agent can write, so a read through it is the agent's word: a forged merged there settles the tree and naps its
   * machine, and nothing past that, which is why a merge never takes this road. */
  const readHost = async <T>(entry: LiveWorkspace, frame: (cwd: string) => DaemonFrame, parse: (reply: Record<string, unknown>) => T): Promise<T> =>
    (await readHostOn(entry, frame, parse)).read;

  /** The same read, saying whether it was this computer's own command line that answered. What it answers is held
   * by remote and number alone, since this computer's command line answers it wherever one is signed in here. */
  const readHostOn = async <T>(entry: LiveWorkspace, frame: (cwd: string) => DaemonFrame, parse: (reply: Record<string, unknown>) => T): Promise<{ read: T; here: boolean }> => {
    try {
      return { read: await heldOff("here", () => ctx.onThisComputer(async (ask, home) => parse(await ask(frame(home))))), here: true };
    } catch (e) {
      if (!isNoHostCli(e) || !copyReadsHost(entry)) throw e;
    }
    return { read: await heldOff(entry.record.id, () => ctx.withDaemon(entry, async ask => parse(await ask(frame(ctx.checkoutOf(entry.record)))))), here: false };
  };

  /** The git host's rate limit refusal, by the road whose command line met it: this computer's, or a copy's. A road
   * that met one answers every read with it for RATE_LIMIT_HOLD_MS rather than running its command line against an
   * empty budget once per pane open. gh's refusal names no reset, so the hold does not end at one. */
  const rateLimited = new Map<string, { until: number; refusal: unknown }>();
  const heldOff = async <T>(road: string, read: () => Promise<T>): Promise<T> => {
    const held = rateLimited.get(road);
    if (held !== undefined && clock.now() < held.until) throw held.refusal;
    try {
      return await read();
    } catch (e) {
      if (e instanceof DaemonRefusal && e.code === "rate-limited") rateLimited.set(road, { until: clock.now() + RATE_LIMIT_HOLD_MS, refusal: e });
      throw e;
    }
  };

  /** The workspace with the pull request it has, by number, and its project's remote; refused where it has none. */
  const pullRequestOn = async (workspaceId: string, origin: Caller | undefined): Promise<{ entry: LiveWorkspace; remote: string; number: number }> => {
    const entry = await ctx.entryOf(workspaceId, origin);
    const number = entry.record.pr?.number;
    if (number === undefined) throw new Error(noPullRequestRefusal(entry.record.name));
    return { entry, remote: ctx.projectHeld(entry.record.project).remote, number };
  };

  const pageKey = (remote: string, number: number): string => `page:${remote}#${number}`;

  /** A pull request's page, held PR_PAGE_HOLD_MS per remote and number so a pane reopened or remounted within it reads
   * nothing; a refresh asks fresh, and every write as the person drops what is held. */
  const readPage = async (entry: LiveWorkspace, remote: string, number: number, fresh: boolean): Promise<{ page: GitPrViewReply; here: boolean }> => {
    const key = pageKey(remote, number);
    const held = fresh ? undefined : githubCache.get(key);
    if (held !== undefined && clock.now() - held.fetchedAt < PR_PAGE_HOLD_MS) return held.body as { page: GitPrViewReply; here: boolean };
    const fetchedAt = clock.now();
    const { read: page, here } = await readHostOn(entry, cwd => ({ op: "git.prView", cwd, remote, number }), r => GitPrViewReply.parse(r));
    githubCache.set(key, { body: { page, here }, fetchedAt });
    clock.schedule(() => githubCache.get(key)?.fetchedAt === fetchedAt && githubCache.delete(key), PR_PAGE_HOLD_MS, { unref: true });
    return { page, here };
  };

  /** A write on the git host as the person, through this computer's own signed-in command line alone, as a merge and
   * a review post are: a copy's gh sits on a PATH its agent can write, so nothing posts as the person through it. */
  const postAsPerson = async <T>(remote: string, number: number, frame: (cwd: string) => DaemonFrame, parse: (reply: Record<string, unknown>) => T): Promise<T> => {
    githubCache.delete(pageKey(remote, number));
    try {
      return await ctx.onThisComputer(async (ask, home) => parse(await ask(frame(home))));
    } catch (e) {
      if (isNoHostCli(e)) throw new Error(pullRequestPostLine(hostOfRemote(remote)));
      throw e;
    }
  };

  /** The host a project's remote lives on, as a sentence about its command line names it. */
  const hostOfRemote = (remote: string): string => gitHostOf(remote)?.sshHosts[0] ?? remoteHost(remote) ?? remote;

  /** How often an open pull request is read again: PR_POLL_MS while a window is open, PR_POLL_IDLE_MS while none is. */
  const prPollMs = (): number => (ctx.status.watched() ? PR_POLL_MS : PR_POLL_IDLE_MS);

  const prKey = (remote: string, number: number): string => `pr:${remote}#${number}`;

  /** The workspace's pull request read through the git host's command line, kept on the entry and pushed on its status:
   * on view, at a turn's end, after a bring back, a merge, a fix and an update, and on a timer while it is open. An
   * open one known by number is read by number with what its last read saw, so an unchanged one costs one REST read
   * and runs nothing else, unless the caller asks for the whole; otherwise it is read by the copy's branch, and a
   * branch that had none is not read again on view until its head moves. A merged or closed one is never read again. On view an open one read
   * within the poll interval answers as held, since its timer keeps it, and anything else within CHECKOUT_TTL_MS. A
   * read the host refused for any reason but a missing command line keeps the last fact, whose time says how old it is. */
  const readPullRequest = (entry: LiveWorkspace, force: boolean, whole = false): Promise<PullRequestSeen | undefined> => {
    const kept = entry.record.pr;
    if (kept !== undefined && kept.state !== "open") return Promise.resolve(entry.pr);
    const held = entry.pr;
    const hold = isPullRequestFact(held) ? prPollMs() : CHECKOUT_TTL_MS;
    if (!force && held !== undefined && clock.now() - held.readAt < hold) {
      // A window opened or closed since the timer was armed: it reads at the interval now in force, from the last read.
      if (isPullRequestFact(held) && entry.prPoll !== undefined && entry.prPollMs !== hold) pollPullRequest(entry, held.readAt);
      return Promise.resolve(held);
    }
    if (!force && kept === undefined && entry.prNoneAt !== undefined && entry.prNoneAt === entry.checkout?.head) return Promise.resolve(held);
    if (entry.prReading !== undefined && !whole) return entry.prReading;
    const reading = (async (): Promise<PullRequestSeen | undefined> => {
      const project = ctx.projectHeld(entry.record.project);
      if (project.remote === "") return entry.pr;
      const checkout = kept === undefined ? (entry.checkout ?? (await ctx.readCheckout(entry, false))) : undefined;
      const branch = checkout?.branch;
      const base = entry.record.base ?? project.base;
      if (kept === undefined && (branch === undefined || branch === base || branch.startsWith("("))) return entry.pr;
      const cached = kept !== undefined ? githubCache.get(prKey(project.remote, kept.number)) : undefined;
      const body = PullRequest.safeParse(cached?.body);
      // A check finishing moves nothing of what is seen, so one still running, or an ask for the whole, reads in full.
      const seen = !whole && body.success && cached?.tag !== undefined && !body.data.checks.some(c => c.state === "pending") ? cached.tag : undefined;
      const at = clock.now();
      try {
        const read = await readHost(
          entry,
          cwd => ({ op: "git.prRead", cwd, remote: project.remote, ...(kept !== undefined ? { number: kept.number } : { branch }), ...(seen !== undefined ? { seen } : {}) }),
          r => GitPrReadReply.parse(r),
        );
        if (read.unchanged === true && body.success) {
          await takePullRequest(entry, { ...body.data, readAt: at });
          return entry.pr;
        }
        const pr = read.pr;
        if (pr !== undefined && read.seen !== undefined) githubCache.set(prKey(project.remote, pr.number), { body: pr, tag: read.seen, fetchedAt: at });
        if (pr === undefined && kept === undefined) entry.prNoneAt = checkout?.head;
        else delete entry.prNoneAt;
        await takePullRequest(entry, pr === undefined ? undefined : { ...pr, readAt: at });
      } catch (e) {
        if (isNoHostCli(e)) {
          const host = hostOfRemote(project.remote);
          const stopped = !isLocalWorkspace(entry.record) && entry.record.phase !== "running";
          await takePullRequest(entry, { why: stopped ? pullRequestStoppedLine(host, entry.record.name) : pullRequestUnreadLine(host), readAt: at });
        } else pollPullRequest(entry);
      }
      return entry.pr;
    })().finally(() => {
      delete entry.prReading;
    });
    entry.prReading = reading;
    return reading;
  };

  /** A pull request just read, onto the entry and the status, the record following it where it moved, the timer set
   * for an open one, and the tree settled where it merged or closed. */
  const takePullRequest = async (entry: LiveWorkspace, seen: PullRequestSeen | undefined): Promise<void> => {
    entry.pr = seen;
    if (isPullRequestFact(seen)) {
      const was = entry.record.pr;
      if (was === undefined || was.state !== seen.state || was.number !== seen.number) {
        const settledAt = seen.state === "merged" ? { mergedAt: seen.readAt } : seen.state === "closed" ? { closedAt: seen.readAt } : {};
        // What was sent belongs to the pull request it was read off; another one starts with nothing sent.
        if (was !== undefined && was.number !== seen.number) delete entry.record.prSent;
        // A settled one is never read again, so the checks the read that saw it settle found are the ones it keeps.
        const checks = seen.state !== "open" ? { checks: seen.checks } : {};
        entry.record.pr = { number: seen.number, url: seen.url, state: seen.state, base: seen.base, ...settledAt, ...checks };
        await ctx.persist(entry.record);
      }
    }
    await ctx.statusNow(entry);
    pollPullRequest(entry);
    if (entry.record.pr !== undefined && entry.record.pr.state !== "open") await settleTree(entry);
  };

  /** The one timed read an open pull request waits on; nothing is armed for a merged or closed one, which is never
   * read again. */
  const pollPullRequest = (entry: LiveWorkspace, from = clock.now()): void => {
    entry.prPoll?.();
    delete entry.prPoll;
    const fact = entry.pr;
    if (!isPullRequestFact(fact) || fact.state !== "open" || live.get(entry.record.id) !== entry) return;
    // A slate bound to the checks reads a pending one every 30 s rather than at the idle or watched pace (06-sources).
    const pending = fact.checks.some(c => c.state === "pending") && ctx.slates.watchesPr(entry.record.id);
    const ms = pending ? SLATE_PR_POLL_MS : prPollMs();
    entry.prPollMs = ms;
    entry.prPoll = clock.schedule(
      () => {
        delete entry.prPoll;
        void readPullRequest(entry, true);
      },
      Math.max(0, from + ms - clock.now()),
      { unref: true },
    );
  };

  /** What a child's record keeps of the tree, written and read again on its lead's rows. */
  const keepTree = async (child: LiveWorkspace, kept: TreeRecord): Promise<void> => {
    if (Object.keys(kept).length === 0) delete child.record.tree;
    else child.record.tree = kept;
    await ctx.persist(child.record);
    ctx.readLeadOf(child);
  };

  /** A root workspace's tree once its pull request merged or closed: every thread of it, across every workspace it
   * spans, stamped read and settled where none of them is working, and its machine napped now rather than after its
   * quiet window. A workspace a thread opened settles nothing off its own pull request: only the root's counts. A tree
   * with a turn still running waits for that turn's end, which settles it then. Nothing is deleted. */
  const settleTree = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.parentThreadId !== undefined) return;
    const rows = [...sessions.values()].map(s => s.view);
    const roots = new Set(rows.filter(v => v.workspaceId === entry.record.id && v.rootThreadId === undefined).map(v => threadKeyOf(v)));
    if (roots.size === 0) return;
    const tree = rows.filter(v => roots.has(threadKeyOf(v)) || (v.rootThreadId !== undefined && roots.has(v.rootThreadId)));
    if (tree.some(v => v.status === "running")) return;
    const at = clock.now();
    await ctx.mark([...new Set(tree.map(v => threadKeyOf(v)))], { readAt: at, settledAt: at }, undefined).catch((e: unknown) =>
      console.warn(`the tree of ${entry.record.name} was not settled: ${e instanceof Error ? e.message : String(e)}`),
    );
    if (ctx.pauses(entry.record) && entry.record.phase === "running") {
      void ctx.napWith(entry.record.id).catch((e: unknown) => console.warn(`${entry.record.name} was not napped once its pull request settled: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

  /** The repository settings a merge reads, kept per remote for an hour: they change when a person edits the
   * repository, and a merge asks for them every time. */
  const repoSettings = new Map<string, { at: number; read: GitRepoReadReply }>();
  const REPO_SETTINGS_MS = 60 * 60_000;
  const mergeSettings = async (remote: string): Promise<GitRepoReadReply> => {
    const cached = repoSettings.get(remote);
    if (cached !== undefined && clock.now() - cached.at < REPO_SETTINGS_MS) return cached.read;
    const read = GitRepoReadReply.parse(await heldOff("here", () => ctx.onThisComputer((ask, home) => ask({ op: "git.repoRead", cwd: home, remote }))));
    repoSettings.set(remote, { at: clock.now(), read });
    return read;
  };

  /** The base's latest commits merged into the copy's branch through the copy's own daemon, the base read as a bring
   * back reads it; then the branch line read again, and the pull request, whose word a conflict or a count may move. */
  const updateCopy = async (entry: LiveWorkspace): Promise<GitUpdateReply> => {
    const base = entry.record.base ?? ctx.projectHeld(entry.record.project).base;
    const done = GitUpdateReply.parse(await ctx.queued(entry.record.id, () => ctx.withDaemon(entry, ask => ask({ op: "git.update", cwd: ctx.checkoutOf(entry.record), ...(base !== undefined ? { base } : {}) }))));
    await ctx.readCheckout(entry, true);
    void readPullRequest(entry, true);
    return done;
  };
  return {
    readHost, pullRequestOn, pageKey, readPage, postAsPerson, readPullRequest, takePullRequest, pollPullRequest,
    keepTree, settleTree, mergeSettings, updateCopy,
  };
}





function foldersArea(ctx: RuntimeContext): FoldersArea {
  const { local, bus, clock, live, projectsHeld, threadRecords, sessions } = ctx;
  /** A folder's record, written once: the machine is this computer, running, with auto-nap off, since a machine wsp
   * does not run neither naps nor wakes. Its name is the project's, or the project's with the branch for a worktree,
   * and nothing shows it to a person. */
  const recordFolder = async (project: ProjectView, worktree?: WorktreeFolder, parent?: string): Promise<LiveWorkspace> => {
    const mine = ctx.backendOfKind("local");
    const machine = await mine.get(LOCAL_MACHINE_ID);
    const id = `ws_${randomBytes(4).toString("hex")}`;
    const taken = new Set([...live.values()].map(e => e.record.name));
    const record: WorkspaceRecord = {
      id,
      name: takenNameAfter(worktree?.branch === undefined ? project.name : `${project.name}@${worktree.branch}`, taken),
      kind: "local",
      machineId: machine.id,
      phase: "running",
      golden: "",
      createdAt: new Date(clock.now()).toISOString(),
      project: project.id,
      ...(worktree !== undefined ? { worktree } : {}),
      ...(parent !== undefined ? { parentWorkspaceId: parent } : {}),
      spec: {},
      size: mine.pricing.defaultSize,
      firstLife: false,
      idleWindowMs: null,
    };
    ctx.attach(record, machine);
    await ctx.persist(record);
    // A project folder outside the person's home, or a worktree under the host's own folder, is outside the daemon's
    // home root, and the host's start lists only the records it found, so the file is written before a turn's snapshot.
    await ctx.writeDaemonRoots(live.get(id)!);
    if (worktree?.made === true) armSweep();
    bus.emit({ type: "workspace.created", workspace: ctx.view(record) });
    return live.get(id)!;
  };
  /** The project folder's record, made at its first thread. */
  const projectFolder = (project: ProjectView): Promise<LiveWorkspace> => {
    const held = ctx.foldersOf(project.id).find(e => e.record.worktree === undefined);
    if (held !== undefined) return Promise.resolve(held);
    return ctx.oneFolder(`${project.id}\0`, () => recordFolder(project));
  };
  /** The record of the worktree holding a branch of the project's repo: the one git already has the branch checked
   * out in, wherever it is, or one the daemon binary makes under this host's folder. The project folder itself
   * answers when it is the one holding the branch. */
  const worktreeFolder = (project: ProjectView, top: string, branch: string, parent?: string, madeFor?: string): Promise<LiveWorkspace> =>
    ctx.oneFolder(`${project.id}\0${branch}`, async () => {
      const copier = local?.copier;
      if (copier === undefined) throw Object.assign(new Error(NO_COPIER_HERE), { kind: "invalid" });
      // Before the binary is run at all: one older than this wsp answers a verb it never heard of with its usage text.
      const here = local?.hereDaemon;
      if (here !== undefined) {
        const version = await here.version();
        if (version < DAEMON_VERSION) throw new Error(hereDaemonBehindLine(version, DAEMON_VERSION, here.fix));
      }
      const made = await copier.worktree({ from: top, home: ctx.stateFolder(), project: project.id, branch, carry: [...CARRIED_DIR_NAMES] });
      if (made.path === top) return projectFolder(project);
      return worktreeRecordAt(project, { path: made.path, branch: made.branch, made: made.made, ...(madeFor !== undefined ? { madeFor } : {}) }, parent);
    });
  /** The record naming a worktree at this path, written again where one stands from before (a worktree removed and
   * made again comes back to its threads, and to the tree it was made for), else a new one, a child of the folder
   * whose thread asked for it so its branch merges back there. */
  const worktreeRecordAt = async (project: ProjectView, tree: WorktreeFolder, parent?: string): Promise<LiveWorkspace> => {
    const held = ctx.foldersOf(project.id).find(e => e.record.worktree?.path === tree.path);
    if (held === undefined) return recordFolder(project, tree, parent);
    const was = held.record.worktree!;
    const madeFor = was.madeFor;
    held.record.worktree = { path: tree.path, made: was.made || tree.made, ...(tree.branch !== undefined ? { branch: tree.branch } : {}), ...(madeFor !== undefined ? { madeFor } : {}) };
    await ctx.persist(held.record);
    armSweep();
    return held;
  };
  /** Where a thread asked for on this computer runs: the record of its folder and the folder itself where the start
   * named one. Nothing named runs in the project folder, or beside the thread asking; a branch runs in the worktree
   * holding it, the project folder when it is that folder's own branch; a cwd runs where it is, inside the project
   * folder or a worktree of its repo and nowhere else. */
  const folderFor = async (o: { project?: string; branch?: string; cwd?: string; picks?: StartPicksAsked }, origin: Caller | undefined): Promise<{ entry: LiveWorkspace; cwd?: string }> => {
    const scope = scopeOf(origin);
    const asking = scope === undefined ? undefined : live.get(scope.workspaceId);
    const project = o.project !== undefined ? await ctx.projectsDoor.resolve(o.project, origin) : asking !== undefined ? ctx.projectHeld(asking.record.project) : undefined;
    if (project === undefined) throw Object.assign(new Error(NAME_A_PROJECT_LINE), { kind: "usage" });
    if (!copiesFolder(kindForComputer(project.computer))) throw Object.assign(new Error(notOnThisComputerLine(project.name)), { kind: "usage" });
    if (o.picks !== undefined) await ctx.picksHold(project, o.picks);
    const beside = asking !== undefined && copiesFolder(asking.record.kind) && asking.record.project === project.id ? asking : undefined;
    if (o.branch !== undefined && o.cwd !== undefined) throw Object.assign(new Error(BRANCH_OR_CWD_LINE), { kind: "usage" });
    const top = project.git?.top;
    if (o.cwd !== undefined) {
      const cwd = folderNamed(o.cwd);
      if (under(cwd, project.path)) return { entry: beside !== undefined && beside.record.worktree === undefined ? beside : await projectFolder(project), cwd };
      const held = top === undefined ? undefined : (await worktreesOf(top)).find(w => under(cwd, w.path));
      if (held === undefined || top === undefined) throw Object.assign(new Error(cwdOutsideLine(homeShortened(cwd, homedir()), project.name)), { kind: "usage" });
      if (held.path === top) return { entry: await projectFolder(project), cwd };
      // A worktree wsp holds no record of, one made with plain git worktree add, is the asking thread's tree's from here.
      return { entry: await worktreeRecordAt(project, { path: held.path, ...(held.branch !== undefined ? { branch: held.branch } : {}), made: false, ...(scope !== undefined ? { madeFor: scope.rootThreadId } : {}) }), cwd };
    }
    if (o.branch === undefined) return { entry: beside ?? (await projectFolder(project)) };
    if (top === undefined) throw Object.assign(new Error(noBranchesLine(project.name)), { kind: "usage" });
    if ((await ctx.branchAt(beside !== undefined ? ctx.checkoutOf(beside.record) : project.path)) === o.branch) return { entry: beside ?? (await projectFolder(project)) };
    return { entry: await worktreeFolder(project, top, o.branch, beside?.record.id, scope?.rootThreadId) };
  };
  /** The host's own git writes on one folder, one at a time: two threads' commits, a discard and a removal never
   * interleave. The agents' own git is theirs, and git's index lock is the answer when theirs meets this. */
  const gitWrites = new Map<string, Promise<unknown>>();
  const queued = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const run = (gitWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    const tail = run.catch(() => {});
    gitWrites.set(id, tail);
    void tail.then(() => {
      if (gitWrites.get(id) === tail) gitWrites.delete(id);
    });
    return run;
  };
  /** Takes a worktree wsp made away with git, under the folder's queue: never while a turn runs there and never over
   * files no commit holds unless forced; the verb keeps a detached HEAD under refs/rescue first. The record stays,
   * gone, while threads name it, and goes with the last of them. */
  const removeWorktree = (entry: LiveWorkspace, force: boolean, o: { ending?: boolean } = {}): Promise<void> =>
    queued(entry.record.id, async () => {
      const tree = entry.record.worktree;
      const project = ctx.projectHeld(entry.record.project);
      const top = project.git?.top;
      if (tree === undefined || tree.made !== true || top === undefined) throw new Error(notMadeWorktreeLine(tree?.branch ?? ""));
      const copier = local?.copier;
      if (copier === undefined) throw Object.assign(new Error(NO_COPIER_HERE), { kind: "invalid" });
      if (o.ending !== true && ctx.turnRuns(entry.record.id)) throw Object.assign(new Error(WORKTREE_BUSY_LINE), { kind: "conflict" });
      if (existsSync(tree.path)) {
        if (!force) await refuseChanged(tree.path);
        await copier.worktreeRemove({ from: top, home: ctx.stateFolder(), path: tree.path, force });
      }
      if (o.ending !== true) await worktreeGone(entry, "removed");
    });
  /** Refuses over files no commit holds in a folder, naming how many: they would go with a removal. */
  const refuseChanged = async (path: string): Promise<void> => {
    const read = await ctx.gitHere(path, ["status", "--porcelain"]);
    if (read.exitCode !== 0) throw new Error(read.stderr.trim() || read.stdout.trim());
    const changed = read.stdout.split("\n").filter(l => l.trim() !== "").length;
    if (changed > 0) throw Object.assign(new Error(worktreeChangedLine(changed)), { kind: "conflict" });
  };
  /** Drops the checkpoint refs one thread holds in its folder's repo, best effort: a ref left behind pins files and
   * nothing else, and a delete is not refused for it. */
  const dropCheckpoints = async (entry: LiveWorkspace, threadId: string): Promise<void> => {
    await ctx.checkpointsLanding.get(threadId)?.catch(() => {});
    if (ctx.notARepo(entry.record)) return;
    await ctx.withDaemon(entry, ask => ask({ op: "git.checkpointDrop", cwd: ctx.checkoutOf(entry.record), scope: entry.record.id, thread: threadId })).catch((e: unknown) =>
      console.warn(`the checkpoints of thread ${threadWord(threadId)} were not dropped: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  /** Whether any thread names a record, by a row of its turns or by its own record. */
  const holdsThread = (workspaceId: string): boolean =>
    [...sessions.values()].some(s => s.view.workspaceId === workspaceId) || [...threadRecords.values()].some(t => t.workspaceId === workspaceId);
  /** A worktree no longer on disk: its threads go on in the project folder, and its record goes once no thread is
   * left on it. */
  const worktreeGone = async (entry: LiveWorkspace, why: WorktreeSettled["why"], o: { starting?: boolean } = {}): Promise<void> => {
    const tree = entry.record.worktree;
    if (tree === undefined) return;
    // A start found it gone, and its thread is about to name the record.
    if (o.starting !== true && !holdsThread(entry.record.id)) {
      await ctx.drop(entry.record.id);
      return;
    }
    entry.record.worktree = { path: tree.path, made: tree.made, ...(tree.branch !== undefined ? { branch: tree.branch } : {}), ...(tree.madeFor !== undefined ? { madeFor: tree.madeFor } : {}), settled: tree.settled ?? { at: clock.now(), why }, gone: true };
    await ctx.persist(entry.record);
  };
  /** The folder a thread's next turn runs in: where its session last ran, unless that was a worktree that is gone,
   * whose threads go on in the folder the record answers now. */
  const runsIn = (entry: LiveWorkspace, ranIn: string | undefined, folder: string): string => {
    const tree = entry.record.worktree;
    if (ranIn === undefined) return folder;
    return tree?.gone === true && under(ranIn, tree.path) ? folder : ranIn;
  };
  /** The one sweep of the worktrees wsp made: how often it runs, how long a settled one stands before it goes, and how
   * long one that could not go is tried before it is the person's to remove. */
  const SWEEP_MS = 10 * 60_000;
  const SETTLED_STANDS_MS = 6 * 3_600_000;
  const KEPT_FOR_MS = 7 * 24 * 3_600_000;
  /** Whether any worktree wsp made still stands, which is all the sweep has to look at. */
  const sweepHasWork = (): boolean => [...live.values()].some(e => e.record.worktree?.made === true && e.record.worktree.gone !== true);
  /** Armed only while a worktree wsp made stands: a host with none holds no timer for it. */
  const armSweep = (): void => {
    if (ctx.state.sweepTimer !== undefined || ctx.state.sweeping !== undefined) return;
    if (ctx.state.sweepStopped || !sweepHasWork()) return;
    ctx.state.sweepTimer = clock.schedule(
      () => {
        ctx.state.sweepTimer = undefined;
        ctx.state.sweeping = sweepWorktrees()
          .catch((e: unknown) => console.warn(`the sweep of worktrees stopped: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => {
            ctx.state.sweeping = undefined;
            armSweep();
          });
      },
      SWEEP_MS,
      { unref: true },
    );
  };
  /** Every worktree wsp made and still holds, one at a time, so a sweep is never more git than one folder's at once. */
  const sweepWorktrees = async (): Promise<void> => {
    for (const entry of [...live.values()]) {
      const tree = entry.record.worktree;
      if (tree?.made !== true || tree.gone === true || live.get(entry.record.id) !== entry) continue;
      await sweepOne(entry).catch((e: unknown) => console.warn(`the worktree at ${tree.path} was not swept: ${e instanceof Error ? e.message : String(e)}`));
    }
  };
  /** One worktree wsp made: settled when its pull request merged or closed, when the branch it pushed is gone at the
   * remote, or when the person removed it; once settled six hours with nothing uncommitted and no turn running it
   * goes, and otherwise says why it stays, until a week has passed and it is left to the person. */
  const sweepOne = async (entry: LiveWorkspace): Promise<void> => {
    const tree = entry.record.worktree!;
    if (!existsSync(tree.path)) return worktreeGone(entry, "removed");
    const settled = tree.settled ?? (await settledNow(entry));
    if (settled === undefined || tree.kept === KEPT_ABANDONED_LINE) return;
    const age = clock.now() - settled.at;
    if (age < SETTLED_STANDS_MS) return;
    const keep = async (said: { kept?: string; removeFailed?: string }): Promise<void> => {
      const now = entry.record.worktree!;
      const next: WorktreeFolder = { ...now, ...said, ...(age >= KEPT_FOR_MS ? { kept: KEPT_ABANDONED_LINE } : {}) };
      if (JSON.stringify(next) === JSON.stringify(now)) return;
      entry.record.worktree = next;
      await ctx.persist(entry.record);
      await ctx.statusNow(entry);
    };
    if (ctx.turnRuns(entry.record.id)) return keep({ kept: KEPT_RUNNING_LINE });
    const status = await ctx.gitHere(tree.path, ["status", "--porcelain"]);
    const changed = status.stdout.split("\n").filter(l => l.trim() !== "").length;
    if (status.exitCode === 0 && changed > 0) return keep({ kept: keptChangedLine(changed) });
    try {
      await removeWorktree(entry, false);
    } catch (e) {
      await keep({ removeFailed: lastLineOf(e instanceof Error ? e.message : String(e)) });
    }
  };
  /** Whether a worktree wsp made settled since the last sweep, stamped on its record when it did. Only a branch with an
   * upstream is asked of its remote, and only the remote saying it has no such branch counts; no remote, no upstream
   * or a remote that could not be read is no answer, so a branch never pushed keeps its worktree. */
  const settledNow = async (entry: LiveWorkspace): Promise<WorktreeSettled | undefined> => {
    const tree = entry.record.worktree!;
    if (ctx.projectHeld(entry.record.project).remote === "") return undefined;
    await ctx.readPullRequest(entry, true);
    const pr = entry.record.pr;
    let settled: WorktreeSettled | undefined =
      pr?.state === "merged" ? { at: pr.mergedAt ?? clock.now(), why: "merged" } : pr?.state === "closed" ? { at: pr.closedAt ?? clock.now(), why: "closed" } : undefined;
    if (settled === undefined && tree.branch !== undefined && (await branchGoneAtRemote(tree.path, tree.branch))) settled = { at: clock.now(), why: "deleted" };
    if (settled === undefined) return undefined;
    entry.record.worktree = { ...entry.record.worktree!, settled };
    await ctx.persist(entry.record);
    await ctx.statusNow(entry);
    return settled;
  };
  /** True only where the branch has an upstream and its remote answers that it holds no such branch (exit 2). */
  const branchGoneAtRemote = async (path: string, branch: string): Promise<boolean> => {
    const remote = (await ctx.gitHere(path, ["config", "--get", `branch.${branch}.remote`])).stdout.trim();
    const merge = (await ctx.gitHere(path, ["config", "--get", `branch.${branch}.merge`])).stdout.trim();
    if (remote === "" || merge === "" || remote === ".") return false;
    const machine = await ctx.moduleOf("local").backend({ kind: "local" } as WorkspaceRecord).get(LOCAL_MACHINE_ID);
    const asked = await machine.exec(`GIT_TERMINAL_PROMPT=0 ${shellLine(["git", "-C", path, "ls-remote", "--exit-code", "--heads", remote, merge])}`, { timeoutMs: INLINE_EXEC_MS });
    return asked.exitCode === 2;
  };
  /** What the move off copies leaves beside the state: each copy kept, with why. */
  const COPIES_KEPT_FILE = "copies-kept.txt";
  /** The move off copies, once, for every record a build before folder records wrote with a copy of the project.
   * Each copy is kept unless every commit it holds is safe in the project's repo: one with changes no commit holds
   * stays, a copy whose branches could not be fetched into the project stays, and only then is it removed by the
   * road that made it. The record goes either way; what stayed is listed in a file beside the state and said once. */
  const moveOldCopies = async (): Promise<void> => {
    const old = [...live.values()].filter(e => copiesFolder(e.record.kind) && (e.record as { copy?: unknown }).copy !== undefined);
    if (old.length === 0) return;
    const kept: string[] = [];
    for (const entry of old) {
      const copy = ProjectCopy.safeParse((entry.record as { copy?: unknown }).copy);
      ctx.endSessions(entry.record.id, OLD_COPY_WORDS.ended);
      const why = copy.success ? await moveOldCopy(entry, copy.data).catch((e: unknown) => OLD_COPY_WORDS.notRemoved(e instanceof Error ? e.message : String(e))) : undefined;
      if (why !== undefined && copy.success) {
        kept.push(`${copy.data.path}\t${why}`);
        console.warn(`old copy ${copy.data.path} kept: ${why}`);
      }
      await ctx.drop(entry.record.id);
    }
    if (kept.length === 0) return;
    const file = join(ctx.stateFolder(), COPIES_KEPT_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${kept.join("\n")}\n`);
    bus.emit({ type: "host.notice", message: OLD_COPY_WORDS.kept(kept.length, homeShortened(file, homedir())) });
  };
  /** One old copy: why it stays, or nothing once its commits are in the project's repo and it is gone. */
  const moveOldCopy = async (entry: LiveWorkspace, copy: ProjectCopy): Promise<string | undefined> => {
    if (!existsSync(copy.path)) return undefined;
    const project = projectsHeld.get(entry.record.project);
    if (project === undefined) return OLD_COPY_WORDS.noProject;
    const top = project.git?.top ?? project.path;
    const overlaps = (a: string, b: string): boolean => under(a, b) || under(b, a);
    if (overlaps(copy.path, project.path) || overlaps(copy.path, top) || overlaps(copy.path, copy.source)) return OLD_COPY_WORDS.isProject;
    const status = await ctx.gitHere(copy.path, ["status", "--porcelain"]);
    if (status.exitCode !== 0) return OLD_COPY_WORDS.unread(gitSaid(status));
    if (status.stdout.trim() !== "") return OLD_COPY_WORDS.changed;
    const name = refPart(folderName(copy.path));
    if (copy.road === "clonefile") {
      // A stash lives in the copy's own repo and rides no fetch of its branches; a worktree's is the project's own.
      const stash = await ctx.gitHere(copy.path, ["rev-parse", "--verify", "--quiet", "refs/stash"]);
      if (stash.exitCode === 0 && stash.stdout.trim() !== "") return OLD_COPY_WORDS.stashed;
      const failed = await rescueTips(top, copy.path, name);
      if (failed !== undefined) return OLD_COPY_WORDS.fetchFailed(failed);
    } else {
      const head = await ctx.gitHere(copy.path, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      if (head.stdout.trim() !== "") {
        const put = await ctx.gitHere(top, ["update-ref", `refs/rescue/${name}/HEAD`, head.stdout.trim()]);
        if (put.exitCode !== 0) return OLD_COPY_WORDS.fetchFailed(gitSaid(put));
      }
    }
    const copier = local?.copier;
    if (copier === undefined) return OLD_COPY_WORDS.noCopier;
    await copier.remove(copy.source, copy.path, copy.road);
    return undefined;
  };
  /** A clean copy's commits kept in the project's repo: its branches and its HEAD fetched beside the project's refs,
   * then only the tips no branch, remote, tag or earlier rescue of the project reaches kept under refs/rescue, one
   * ref per tip, a branch before HEAD; every fetched ref goes after. A copy shares nearly every branch with its
   * project, and a ref kept for each one slows every git command in that repo. What git said where it failed. */
  const rescueTips = async (top: string, from: string, name: string): Promise<string | undefined> => {
    const incoming = `refs/rescue-incoming/${name}`;
    try {
      // HEAD rides the same fetch, so a commit on no branch is carried too.
      const fetched = await ctx.gitHere(top, ["fetch", "--quiet", "--no-tags", from, `+refs/heads/*:${incoming}/heads/*`, `+HEAD:${incoming}/HEAD`], CLONE_MS);
      if (fetched.exitCode !== 0) return gitSaid(fetched);
      const unreached = await ctx.gitHere(top, ["rev-list", `--glob=${incoming}`, "--not", "--branches", "--remotes", "--tags", "--glob=refs/rescue"], CLONE_MS);
      if (unreached.exitCode !== 0) return gitSaid(unreached);
      const lacking = new Set(unreached.stdout.split("\n").filter(Boolean));
      if (lacking.size === 0) return undefined;
      const listed = await ctx.gitHere(top, ["for-each-ref", "--format=%(objectname) %(refname)", incoming]);
      if (listed.exitCode !== 0) return gitSaid(listed);
      const refs = listed.stdout.split("\n").filter(Boolean).map(line => ({ tip: line.slice(0, line.indexOf(" ")), ref: line.slice(line.indexOf(" ") + 1) }));
      const ordered = [...refs.filter(r => r.ref !== `${incoming}/HEAD`), ...refs.filter(r => r.ref === `${incoming}/HEAD`)];
      const kept = new Set<string>();
      const lines: string[] = [];
      for (const { tip, ref } of ordered) {
        if (!lacking.has(tip) || kept.has(tip)) continue;
        kept.add(tip);
        const rest = ref === `${incoming}/HEAD` ? "HEAD" : ref.slice(`${incoming}/heads/`.length);
        lines.push(`update refs/rescue/${name}/${rest} ${tip}`);
      }
      const put = await ctx.gitHere(top, ["update-ref", "--stdin"], INLINE_EXEC_MS, `${lines.join("\n")}\n`);
      return put.exitCode === 0 ? undefined : gitSaid(put);
    } finally {
      const left = await ctx.gitHere(top, ["for-each-ref", "--format=delete %(refname)", incoming]);
      if (left.stdout.trim() !== "") await ctx.gitHere(top, ["update-ref", "--stdin"], INLINE_EXEC_MS, left.stdout);
    }
  };
  /** A folder's name as one part of a ref: what git refuses in a ref name turned to a dash. */
  const refPart = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.\.+/g, "-").replace(/^[.-]+|\.lock$|\.$/g, "") || "copy";
  /** The last line git said, stderr first, for a sentence that quotes it. */
  const lastLine = (res: { stdout: string; stderr: string }): string => (res.stderr.trim() || res.stdout.trim()).split("\n").at(-1) ?? "";
  /** What git said went wrong: its first error or fatal line, not a hint printed under it, else its last line. */
  const gitSaid = (res: { stdout: string; stderr: string }): string => res.stderr.split("\n").find(l => /^(error|fatal): /.test(l))?.trim() ?? lastLine(res);
  /** Whether a path is the folder or inside it. */
  const under = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
  /** Every worktree of a repo as git lists it now, read each time: the person and their agents add and remove their
   * own, so nothing here is kept. */
  const worktreesOf = async (top: string): Promise<{ path: string; branch?: string }[]> => {
    const read = await ctx.gitHere(top, ["worktree", "list", "--porcelain"]);
    if (read.exitCode !== 0) return [];
    const trees: { path: string; branch?: string }[] = [];
    for (const line of read.stdout.split("\n")) {
      if (line.startsWith("worktree ")) trees.push({ path: line.slice("worktree ".length) });
      else if (line.startsWith("branch refs/heads/") && trees.length > 0) trees[trees.length - 1]!.branch = line.slice("branch refs/heads/".length);
    }
    return trees;
  };
  return {
    projectFolder, worktreeFolder, folderFor, queued, removeWorktree, refuseChanged, dropCheckpoints, holdsThread,
    worktreeGone, runsIn, armSweep, moveOldCopies, gitSaid, worktreesOf,
  };
}

function startFromArea(ctx: RuntimeContext): StartFromArea {
  const { bus, clock, live, projectsHeld } = ctx;
  /** The project a GitHub repository names: the one whose remote is that repository, this computer's where two
   * computers hold it, or the one named by name or id among them. A link is only ever matched to a project the
   * person added, and every later call names the repository off that project's record. */
  const projectByRepo = (repo: string, named: string | undefined): ProjectView => {
    const held = [...projectsHeld.values()];
    const picked = named === undefined ? projectForRepo(held, repo, HERE_PLACE_ID) : held.find(p => holdsRepo(p, repo) && (p.id === named || p.name === named));
    if (picked === undefined) throw Object.assign(new Error(START_WORDS.noProjectForRepo(repo)), { kind: "invalid" });
    return picked;
  };

  /** An issue, or a pull request read as the issue it also is, on this computer's own git host command line. */
  const issueOf = async (remote: string, number: number): Promise<IssueRead> =>
    GitIssueReadReply.parse(await ctx.onThisComputer((ask, home) => ask({ op: "git.issueRead", cwd: home, remote, number }))).issue;

  /** A pull request by number, read in full on this computer. */
  const pullRequestOf = async (remote: string, number: number): Promise<PullRequest> => {
    const read = GitPrReadReply.parse(await ctx.onThisComputer((ask, home) => ask({ op: "git.prRead", cwd: home, remote, number }))).pr;
    if (read === undefined) throw new Error(`#${number} is not a pull request`);
    return read;
  };

  /** Where the work came from, off the link's kind and what was read. */
  const fromOf = (kind: WorkspaceFrom["kind"], repo: string, read: IssueRead, fact: PullRequest | undefined): WorkspaceFrom => ({
    kind,
    repo,
    number: read.number,
    url: read.url,
    title: read.title,
    ...(fact !== undefined
      ? { base: fact.base, head: { branch: fact.branch, oid: fact.headOid, ...(fact.fork !== undefined ? { fork: fact.fork } : {}) } }
      : {}),
  });

  /** A workspace made for a start or a review: the copy made by the create road, where the work came from on its
   * record, and for a pull request its base, its pull request and its head, the copy put on the head branch through
   * its own daemon. A checkout that is refused takes the half-made workspace with it and answers its own sentence. */
  const workspaceFrom = async (project: ProjectView, from: WorkspaceFrom, fact: PullRequest | undefined, kind: "start" | "review", origin: Caller | undefined): Promise<LiveWorkspace> => {
    if (copiesFolder(kindForComputer(project.computer))) return folderFrom(project, from, fact);
    const taken = new Set([...live.values()].map(e => e.record.name));
    const name = takenNameAfter(startName(kind, from.number, from.title), taken);
    const made = await ctx.workspaces.create({ project: project.id, name }, origin);
    const entry = live.get(made.id);
    if (entry === undefined) throw new Error(`${name} was made and then not found`);
    entry.record.from = from;
    if (fact !== undefined) {
      entry.record.base = fact.base;
      entry.record.pr = { number: fact.number, url: fact.url, state: fact.state, base: fact.base };
      entry.pr = { ...fact, readAt: clock.now() };
    }
    await ctx.persist(entry.record);
    if (fact !== undefined) {
      try {
        await ctx.withDaemon(entry, ask => ask({ op: "git.prCheckout", cwd: ctx.checkoutOf(entry.record), number: fact.number }));
      } catch (e) {
        await ctx.workspaces.delete(entry.record.id, origin).catch((d: unknown) => console.warn(`${name} was not taken back after its checkout failed: ${d instanceof Error ? d.message : String(d)}`));
        throw e;
      }
    }
    return entry;
  };

  /** Where a start or a review on this computer runs: an issue in the project folder; a pull request in a worktree on
   * its head, fetched into the project's repo first as a branch of its own where none of that name stands, so
   * nothing moves the project folder's checkout. The pull request's facts go on the worktree's record alone. */
  const folderFrom = async (project: ProjectView, from: WorkspaceFrom, fact: PullRequest | undefined): Promise<LiveWorkspace> => {
    if (fact === undefined) return ctx.projectFolder(project);
    const top = project.git?.top;
    if (top === undefined) throw Object.assign(new Error(noBranchesLine(project.name)), { kind: "usage" });
    const branch = fact.fork === undefined ? fact.branch : `${fact.fork.owner}/${fact.branch}`;
    // A branch some worktree already holds runs there and is caught up below; any other is fetched first, made where
    // it is not here and only moved forward where it is, never forced.
    const holds = (await ctx.worktreesOf(top)).some(w => w.branch === branch);
    if (!holds) await fetchHead(project, top, fact, branch);
    const entry = await ctx.worktreeFolder(project, top, branch);
    if (holds) {
      const behind = await catchUp(entry, project, top, fact);
      if (behind !== undefined) behindOn.set(entry.record.id, behind);
    }
    if (entry.record.worktree === undefined) return entry;
    entry.record.from = from;
    entry.record.base = fact.base;
    entry.record.pr = { number: fact.number, url: fact.url, state: fact.state, base: fact.base };
    entry.pr = { ...fact, readAt: clock.now() };
    await ctx.persist(entry.record);
    return entry;
  };

  /** A start's picks read against the agent's lists before a folder is made or moved for it, by the rule the start
   * itself refuses them with, so a pick the agent does not take costs no git work. */
  const picksHold = async (project: ProjectView, o: StartPicksAsked): Promise<void> => {
    if (!copiesFolder(kindForComputer(project.computer))) return;
    const home = await ctx.projectFolder(project);
    const prefs = ctx.state.preferencesHeld ?? (await ctx.preferences.get());
    const harness = o.harness ?? ctx.defaultAgentOf(prefs, home);
    const table = harnessCatalog(harness);
    if (table === undefined) return;
    const { adapter } = await ctx.launchAdapterFor(home, harness);
    const resolved = ctx.defaultsOn(await ctx.catalogOn(table, home, adapter), prefs, prefs.projectDefaults[home.record.project]);
    // This road is the command line's and the tools', so it names the flag to drop; namedMode speaks for the app too.
    const refused = o.access === undefined ? null : accessWordRefusal(resolved.catalog, o.access);
    if (refused !== null) throw refused;
    const named = o.permissionMode ?? (o.access === undefined ? undefined : ctx.namedMode(resolved.catalog, harness, o.access));
    const model = o.model ?? resolved.open.model;
    const effort = o.effort ?? resolved.open.effort;
    try {
      startPicks(resolved.catalog, { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(named !== undefined ? { permissionMode: named } : {}), ...(o.fast === true ? { fast: true } : {}) }, true);
    } catch (e) {
      throw pickRefusal(e, resolved.catalog);
    }
  };

  /** The line a start on a pull request leaves for its thread, by the record of the folder that was left behind. */
  const behindOn = new Map<string, string>();
  /** The project folder's record with this computer's daemon told the folder is its to work in, so an ask naming a
   * project anywhere a project may live resolves. */
  const askingIn = async (entry: LiveWorkspace): Promise<LiveWorkspace> => {
    await ctx.writeDaemonRoots(entry);
    return entry;
  };
  /** A pull request's head into its local branch through the daemon: the branch by name where the remote still holds
   * it, else the pull request's own head, which outlives a branch deleted at the merge. GitHub serves a fork's head
   * on the base repository as pull/<n>/head, so no fork's URL is dialled. */
  const fetchHead = async (project: ProjectView, top: string, fact: PullRequest, branch: string): Promise<void> => {
    if (fact.fork === undefined) {
      const home = await askingIn(await ctx.projectFolder(project));
      try {
        GitStartOnReply.parse(await ctx.withDaemon(home, ask => ask({ op: "git.fetchBranch", cwd: project.path, remote: project.remote, branch: fact.branch, into: branch })));
        return;
      } catch (e) {
        if (await remoteHolds(top, project.remote, `refs/heads/${fact.branch}`)) throw e;
      }
    }
    const fetched = await ctx.gitHere(top, ["fetch", "--quiet", "--no-tags", project.remote, `pull/${fact.number}/head:refs/heads/${branch}`], CLONE_MS);
    if (fetched.exitCode !== 0) throw new Error(ctx.gitSaid(fetched));
  };
  /** Whether the remote holds a ref; exit 2 alone is its answer that it does not. */
  const remoteHolds = async (top: string, remote: string, ref: string): Promise<boolean> =>
    (await ctx.gitHere(top, ["ls-remote", "--exit-code", remote, ref], CLONE_MS)).exitCode !== 2;
  /** The folder holding a pull request's branch, caught up where it may be: a worktree wsp made that is clean and
   * only behind moves forward through the daemon; the project folder never moves, and any folder left as it stands
   * gets the line its thread is told. */
  const catchUp = async (entry: LiveWorkspace, project: ProjectView, top: string, fact: PullRequest): Promise<string | undefined> => {
    const path = entry.record.worktree?.path ?? top;
    const byName = fact.fork === undefined && (await remoteHolds(top, project.remote, `refs/heads/${fact.branch}`));
    const spec = byName ? `refs/heads/${fact.branch}` : `pull/${fact.number}/head`;
    const fetched = await ctx.gitHere(top, ["fetch", "--quiet", "--no-tags", project.remote, spec], CLONE_MS);
    if (fetched.exitCode !== 0) return PR_BEHIND_WORDS.unread(fact.number, ctx.gitSaid(fetched));
    const head = (await ctx.gitHere(top, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
    const at = (await ctx.gitHere(path, ["rev-parse", "HEAD"])).stdout.trim();
    if (head === at || (await ctx.gitHere(path, ["merge-base", "--is-ancestor", head, at])).exitCode === 0) return undefined;
    if ((await ctx.gitHere(path, ["merge-base", "--is-ancestor", at, head])).exitCode !== 0) return PR_BEHIND_WORDS.diverged(fact.number, path);
    if ((await ctx.gitHere(path, ["status", "--porcelain"])).stdout.trim() !== "") return PR_BEHIND_WORDS.changed(fact.number, path);
    if (entry.record.worktree === undefined) return PR_BEHIND_WORDS.folder(fact.number, path);
    if (entry.record.worktree.made !== true) return PR_BEHIND_WORDS.notMade(fact.number, path);
    if (!byName) return PR_BEHIND_WORDS.byHead(fact.number, path, project.remote);
    try {
      GitUpdateReply.parse(await ctx.withDaemon(await askingIn(entry), ask => ask({ op: "git.update", cwd: ctx.checkoutOf(entry.record), base: fact.branch })));
      return undefined;
    } catch (e) {
      return PR_BEHIND_WORDS.unread(fact.number, e instanceof Error ? e.message : String(e));
    }
  };

  /** The thread a start or a review opens, detached: the turn goes on without the caller. */
  const openWith = async (entry: LiveWorkspace, o: { prompt: string; harness?: string; model?: string; effort?: string; permissionMode?: string; access?: AccessChoice }, origin: Caller | undefined): Promise<StartResult> => {
    const behind = behindOn.get(entry.record.id);
    behindOn.delete(entry.record.id);
    const handle = await ctx.sessionsApi.start(
      entry.record.id,
      {
        ...(behind !== undefined ? { behind } : {}),
        prompt: o.prompt,
        ...(o.harness !== undefined ? { harness: o.harness } : {}),
        ...(o.model !== undefined ? { model: o.model } : {}),
        ...(o.effort !== undefined ? { effort: o.effort } : {}),
        ...(o.permissionMode !== undefined ? { permissionMode: o.permissionMode } : {}),
        ...(o.access !== undefined ? { access: o.access } : {}),
      },
      origin,
    );
    const v = handle.view();
    return { workspace: ctx.view(entry.record), threadId: v.threadId ?? v.id, sessionId: v.id };
  };

  /** The harnesses whose table names a mode that changes nothing, which are the ones that can review. */
  const readOnlyOf = (agent: string): string | undefined => HARNESS_CATALOGS.find(c => c.harness === agent)?.readOnlyMode;
  const reviewers = (): string[] => {
    const all = HARNESS_CATALOGS.filter(c => c.readOnlyMode !== undefined).map(c => c.harness);
    // Codex first: the owner's rule since 2026-09-26 is that Codex runs reviews.
    return [...all.filter(h => h === "codex"), ...all.filter(h => h !== "codex")];
  };

  /** A reviewer's reply read at its turn's end: the review its last fenced json block writes becomes the draft, each
   * comment on a line outside the diff marked for the summary; a reply with no block that reads is asked once more
   * in the same thread, and a second that does not read leaves the sentence. A reply with no block after a draft that
   * read leaves that draft as it was: the person may have asked the reviewer something else. */
  const takeReview = async (entry: LiveWorkspace, threadId: string, text: string): Promise<void> => {
    const from = entry.record.from;
    if (from?.kind !== "review") return;
    const read = reviewFromReply(text);
    const prior = entry.record.review;
    const at = clock.now();
    if (!read.ok) {
      if (isReviewRead(prior)) return;
      const reasked = prior !== undefined && "note" in prior && prior.reasked === true;
      entry.record.review = { note: read.why, at, reasked: true };
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.review", workspaceId: entry.record.id });
      if (!reasked) void ctx.sendDetached(entry.record.id, { prompt: reviewReaskPrompt(read.why), thread: threadId }, undefined).catch((e: unknown) => console.warn(`the reviewer of ${entry.record.name} was not asked again: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    const remote = ctx.projectHeld(entry.record.project).remote;
    const diff = await ctx.onThisComputer((ask, home) => ask({ op: "git.prDiff", cwd: home, remote, number: from.number })).then(
      r => GitPrDiffReply.parse(r).diff,
      () => undefined,
    );
    const comments = read.review.comments.map((c, n) => ({
      id: `c${n + 1}`,
      ...c,
      on: true,
      ...(diff !== undefined && lineInDiff(diff, c.path, c.line, c.side) === false ? { inSummary: true } : {}),
    }));
    const headOid = (isPullRequestFact(entry.pr) ? entry.pr.headOid : undefined) ?? from.head?.oid ?? "";
    entry.record.review = { verdict: read.review.verdict, summary: read.review.summary, comments, headOid, threadId, at };
    await ctx.persist(entry.record);
    bus.emit({ type: "workspace.review", workspaceId: entry.record.id });
  };
  return {
    projectByRepo, issueOf, pullRequestOf, fromOf, workspaceFrom, picksHold, openWith, readOnlyOf, reviewers,
    takeReview,
  };
}

function workspacesArea(ctx: RuntimeContext): WorkspacesArea {
  const {
    store, adapters, local, placeDoor, bus, clock, githubCache, readsState, tookTheResume, sleeps, imageMovePlan, live,
    threadRecords, sessions, execs, places,
  } = ctx;
  const workspaces: Runtime["workspaces"] = {
    async landing(o, origin) {
      await ctx.ready();
      const project = await ctx.projectsDoor.resolve(o.project, origin);
      const computer = project.computer;
      const kind = kindForComputer(computer);
      if (copiesFolder(kind)) return { name: ctx.placeName(HERE_PLACE_ID), capabilities: ctx.backendOfKind(kind).capabilities };
      const { placeId } = await ctx.landingPlace(computer);
      const at = await ctx.landingBackend(placeId);
      return { ...(placeId !== undefined ? { place: placeId } : {}), name: ctx.placeName(placeId ?? places.wired), capabilities: at.capabilities };
    },

    async create(opts, origin) {
      await ctx.ready();
      const asked = scopeOf(origin);
      // A thread forks the image its own workspace's project runs and names none.
      if (asked !== undefined && opts.golden !== undefined) throw Object.assign(new Error(spawnGoldenRefusal(asked.threadId)), { kind: "invalid" });
      // A create a thread asked for is a child of the workspace that thread runs on and of no other, named or not:
      // a thread's workspaces are its own tree, nothing it makes stands beside it as a sibling of the person's, and
      // a workspace it names is one whose branch it may not read.
      const bornOf = asked === undefined ? opts.parent : asked.workspaceId;
      const o = { ...opts, name: ctx.nameGiven(opts.name), ...(bornOf !== undefined ? { parent: bornOf } : {}) };
      const project = await ctx.projectsDoor.resolve(o.project, origin);
      // The project's computer decides which road this create takes, off the one table that says whether a kind
      // copies a folder on this computer or forks an image; the origin rule is then read on that kind.
      const kind = kindForComputer(project.computer);
      // The same rule and the same sentence the verb that sets the switch on a workspace that exists reads, so a
      // create on a computer whose agents could not drive this host is refused rather than given a dead switch.
      if (o.agents?.spawn === true && !agentsMayDrive(kind)) throw Object.assign(new Error(agentsKindRefusal(kind)), { kind: "invalid" });
      // Read before anything is asked of a machine: the project rule refuses a thread naming another project here,
      // as the same reading refuses it every workspace of one. A computer that copies its folders takes no relayed
      // request at all and says so in its own words below.
      const copies = copiesFolder(kind);
      // A project on this computer is its folder: a create there names the folder's record, the one every thread in
      // that folder shares, and makes nothing.
      if (copies) {
        ctx.refuseRecording(o.name, origin);
        // The folder is not forked, so the words a fork takes have nothing to act on: refused rather than ignored.
        const forkWords = [o.golden !== undefined ? "--from" : "", o.cpu !== undefined || o.memMb !== undefined ? "--size" : "", o.engine === true ? "--engine" : ""].filter(w => w !== "");
        if (forkWords.length > 0) throw Object.assign(new Error(copyTakesNone(project.name, forkWords)), { kind: "invalid" });
        if (asked !== undefined && o.agents !== undefined) throw new Error(spawnActRefusal(asked.threadId, "agents"));
        const folder = await ctx.projectFolder(project);
        if (o.agents !== undefined) {
          folder.record.agents = agentsFrom(ctx.spawnAt(HERE_PLACE_ID), o.agents);
          await ctx.persist(folder.record);
        }
        return ctx.view(folder.record);
      }
      ctx.refuseRelayed({ kind, name: o.name, project: project.id }, origin);
      // A child of another workspace starts where that workspace is now, not where the project starts. A parent
      // this host does not hold, and one whose own create has not finished, are refused rather than dropped, since
      // a create that dropped it would land as somebody's root; the branch itself is read off the parent's machine
      // below, once this create is allowed.
      const parent = o.parent === undefined ? undefined : live.get(o.parent);
      if (o.parent !== undefined && (parent === undefined || parent.creating === true)) throw Object.assign(new Error(noParentWorkspaceLine(o.parent)), { kind: "invalid" });
      // A child is a second checkout of its parent's repository on the branch that parent is on, so a parent holding
      // another repository has no branch this child could start from and land its work back in. The same repository
      // added on another computer is the same code, which is how a lead on this computer starts a child on a box.
      if (parent !== undefined && parent.record.project !== project.id && !ctx.sameRepository(ctx.projectHeld(parent.record.project), project)) {
        throw Object.assign(new Error(parentProjectRefusal(parent.record.name, ctx.projectHeld(parent.record.project).name, project.name)), { kind: "invalid" });
      }
      await ctx.placeGuard((await ctx.landingPlace(project.computer)).placeId ?? places.wired);
      // The place under the root is taken here, with no await between the count and the taking, and handed back in
      // the finally below however this create ends: the record it becomes is what holds it from then on. A copy on
      // this computer is a child in the tree as a fork is, so it takes the same place.
      const freePlace = ctx.spawnGuard("fork", origin);
      const spawned = scopeOf(origin);
      // A thread's fork carries the switch of the workspace it was asked from, and nothing the caller says: the
      // caps are the person's, and a fork naming its own would be the agents act by another road.
      if (spawned !== undefined && o.agents !== undefined) {
        freePlace();
        throw new Error(spawnActRefusal(spawned.threadId, "agents"));
      }
      const refusal = ctx.nameRefusal(o.name);
      if (refusal !== undefined) {
        freePlace();
        throw Object.assign(new Error(refusal), { kind: "conflict" });
      }
      ctx.forking.add(o.name);
      ctx.supersedeFailed(o.name);
      const id = `ws_${randomBytes(4).toString("hex")}`;
      const began = clock.now();
      const report = ctx.stageReporter(id, o.name, began, spawned);
      try {
        // Read inside the try, so a parent that did not answer gives the name and the slot back the way every
        // other end of this create does, and after the guard, so what a thread may do is decided before anything
        // is asked of a machine.
        const start = parent === undefined ? undefined : await ctx.leadStart(parent, o.name);
        const made = await ctx.createStaged(o, project, id, report, spawned, freePlace, start?.base);
        if (start === undefined) return made;
        const lines = [...start.lines, ...(start.onLeads && start.base !== undefined ? [await ctx.startChildOn(live.get(id)!, start.base, parent!.record.name)] : [])];
        return lines.length === 0 ? made : { ...made, notice: [made.notice, ...lines].filter(l => l !== undefined).join("\n") };
      } catch (e) {
        // A machine already forked goes with the failed create, so the retry forks a fresh one; one the provider
        // will not part with keeps its record instead, since a machine nobody records bills unseen.
        const entry = live.get(id);
        let kept: LiveWorkspace | undefined;
        if (entry !== undefined) {
          const gone = await ctx.unfork(entry).then(() => true, (k: unknown) => isMissing(k));
          if (gone) live.delete(id);
          else {
            kept = entry;
            delete entry.creating;
            await ctx.persist(entry.record).catch((p: unknown) => console.warn(`workspace ${id} not stored: ${p instanceof Error ? p.message : String(p)}`));
            console.warn(`workspace ${id} failed to create and its machine ${entry.machine.id} would not stop; the record stays for wsp delete`);
          }
        }
        // The id dies with a failed create, so nothing could ever retry under its key.
        await store.delete(CREATES, `workspace/${id}`);
        const said = e instanceof Error ? e.message : String(e);
        report("failed", said);
        if (kept !== undefined) bus.emit({ type: "workspace.created", workspace: ctx.view(kept.record) });
        else ctx.failedCreates.set(id, ctx.failedView(id, o.name, kind, o.golden ?? "", began, project, said));
        throw e;
      } finally {
        ctx.forking.delete(o.name);
        freePlace();
      }
    },

    async get(id, origin) {
      return ctx.view((await ctx.entryOf(id, origin)).record);
    },

    async agents(id, patch, origin) {
      ctx.spawnGuard("agents", origin);
      const entry = await ctx.entryOf(id, origin);
      // The same rule the create that names the switch reads, off the one table of what each kind's machines are:
      // a kind whose agents could not drive this host is refused the switch rather than given one that does nothing.
      if (patch.spawn === true && !agentsMayDrive(entry.record.kind)) throw new Error(agentsKindRefusal(entry.record.kind));
      const next = agentsFrom(ctx.agentsHeld(entry.record), patch);
      entry.record.agents = next;
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.agents", workspaceId: id, agents: next });
      return ctx.view(entry.record);
    },

    async list(origin) {
      await ctx.ready();
      return ctx.listedFor(origin).map(e => ctx.view(e.record));
    },

    async resolve(ref, origin) {
      await ctx.ready();
      const scope = scopeOf(origin);
      const rows = scope === undefined ? ctx.held() : ctx.listedFor(origin);
      // The whole of an id, then the whole of a name, as a thread's own reference does: a name names one workspace at
      // most, since the create and the rename both refuse a name another already holds, and a word that is one is
      // that workspace whatever else it starts. Only a word that is neither reaches the prefix, where enough of an
      // id is the way round quoting a name with spaces and a word that starts two is refused with both ids.
      const exact = rows.find(e => e.record.id === ref) ?? rows.find(e => e.record.name === ref);
      const started = exact === undefined && ref.length >= ID_PREFIX_MIN ? rows.filter(e => e.record.id.startsWith(ref)) : [];
      if (started.length > 1) throw new Error(idPrefixRefusal(ref, started.map(e => e.record.id)));
      const entry = exact ?? started[0];
      if (entry === undefined) {
        if (scope !== undefined) throw notFoundRefusal(noWorkspaceRefusal(ref));
        const failed = [...ctx.failedCreates.values()].find(v => v.id === ref || v.name === ref);
        if (failed !== undefined) return failed;
        // A computer somebody joined is a place, and a place is no workspace: the word is answered with the road to
        // one there rather than with absence, since the person typed the name of something this host does hold.
        const place = (await placeDoor?.find(ref)) ?? [];
        if (place.length > 0) throw notFoundRefusal(refusalLine(placeNotAWorkspaceLine(place[0]!.name), placeNotAWorkspaceFix(place[0]!.name)));
        throw notFoundRefusal(noWorkspaceRefusal(ref));
      }
      ctx.refuseRelayed(entry.record, origin);
      return ctx.view(entry.record);
    },

    async nap(id, origin) {
      ctx.spawnGuard("pause", origin);
      ctx.refusePauseless(await ctx.entryOf(id, origin), "be paused");
      return ctx.napWith(id);
    },

    async wake(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      await ctx.copyBlocked(entry);
      if (entry.waking) return entry.waking;
      if (entry.record.phase === "gone") {
        const left = await ctx.recoverGone(entry);
        if (left === undefined) throw new Error(goneRefusal(entry.record.name, "wake", entry.record.gone));
        // A record that left gone for napping is a machine the provider holds paused: the wake goes on and resumes it.
        if (left === "running") return ctx.view(entry.record);
      }
      if (entry.napping) await entry.napping.catch(() => {});
      // A wake nobody should need is the one sign the provider paused the machine on its own, or lost it, and a wake of
      // a machine the provider runs would be refused with its words: one read settles any, and the record follows the fact.
      if (entry.record.phase === "running") {
        let answer: string | undefined;
        const read = await entry.machine.state().catch((e: unknown) => {
          if (!isMissing(e)) return "running";
          answer = providerSaid(e);
          return "gone";
        });
        if (read === "gone" && settled(await ctx.settleGone(entry, goneWords(entry.record.machineId, { by: "wake", at: clock.now(), ...(answer !== undefined ? { answer } : {}) })))) {
          throw new Error(goneRefusal(entry.record.name, "wake", entry.record.gone));
        }
        if (read === "paused") await ctx.adoptPause(entry);
      } else if (await ctx.runsUnderNapping(entry)) await ctx.adoptRunning(entry);
      // A running workspace has nothing to wake, whatever its kind; only a real resume asks the machine for one.
      if (entry.record.phase === "running") return ctx.view(entry.record);
      ctx.refusePauseless(entry, "be woken");
      entry.waking = (async () => {
        // The stop the person pulls from the row. It aborts the provider call the ask is on rather than walking away
        // from one that keeps running: an abandoned resume would go on to run its cap out, write its line back onto
        // a row that reads Paused, and leave a second lifecycle wake beside the next one.
        const stop = new AbortController();
        entry.wakeStop = stop;
        const stopped = (): boolean => stop.signal.aborted;
        /** Resolves as its promise does, or at once when the stop is pulled; only the wait between two asks needs
         * this, since the abort ends an ask on its own. */
        const orStopped = <T>(p: Promise<T>): Promise<T | "stopped"> =>
          stopped()
            ? Promise.resolve("stopped" as const)
            : Promise.race([p, new Promise<"stopped">(resolve => stop.signal.addEventListener("abort", () => resolve("stopped"), { once: true }))]);
        const began = clock.now();
        // How the backend has the host ask again after a resume its provider did not take; none means once.
        const asks = ctx.lifecycleOf(entry).budgets.resumeAsks;
        const wakeAsks = asks === undefined ? 1 : wakeAsksIn(asks.forMs, asks.everyMs);
        try {
          delete entry.deleteSaid;
          entry.record.phase = "waking";
          await ctx.persist(entry.record);
          await ctx.emitStatus(entry, "napping");
          // Ask 1 is the person's wake; every ask after it is the host's own, once a cadence apart, so a provider
          // that comes back inside its own outage wakes the machine without the person having to try again. The
          // record stays waking between two asks: nothing about the machine changed, only who is asking.
          // Set when the read before an ask found the machine already up: that ask sends no second resume and the
          // engine's wake goes straight to the guest check, first life ending there as on any other road.
          let landed = false;
          for (let ask = 1; ; ask++) {
            try {
              const result = await entry.ws.wake({ landed });
              if (stopped()) throw new Error(WAKE_STOPPED);
              ctx.followMachine(entry);
              delete entry.record.wakeRefused;
              await ctx.persist(entry.record);
              bus.emit({ type: "workspace.woken", workspaceId: id, machineId: entry.record.machineId });
              if (result.reason !== undefined) console.warn(`wake of ${id}: ${result.reason}`);
              await ctx.emitStatus(entry, ctx.reachOf(entry), result.reason);
              return ctx.view(entry.record);
            } catch (e) {
              if (!stopped() && e instanceof ResumeUnansweredError && ask < wakeAsks) {
                entry.wakeAsk = { ask, of: wakeAsks };
                delete entry.wakeSaid;
                await ctx.emitStatus(entry, "napping");
                // The cadence is wall time from the wake's start, so the half hour of asking is half an hour: a
                // resume that sat on its cap for half the minute leaves half a minute to wait, and one that ran
                // longer than the cadence is asked again at once.
                if ((await orStopped(sleeps(Math.max(0, began + ask * asks!.everyMs - clock.now())))) !== "stopped") {
                  // The retry reads the machine before it asks: a call that hung at the provider can land in the
                  // minute since, and a resume is worth sending only while the machine still reads paused.
                  landed = tookTheResume(await readsState(entry.machine));
                  continue;
                }
              }
              // A resume the provider answered 404 for is a sighting like any other: the record settles gone only
              // where the reads agree, and the refusal says what went with the machine.
              if (!stopped() && isMissing(e) && settled(await ctx.settleGone(entry, goneWords(entry.record.machineId, { by: "wake", at: clock.now(), answer: providerSaid(e) })))) {
                throw new Error(goneRefusal(entry.record.name, "wake", entry.record.gone));
              }
              // The provider would not resume it for the whole of the asking: the record carries the road out until
              // something replaces the machine, since nothing about it changes on its own from here.
              const gaveUp = !stopped() && e instanceof ResumeUnansweredError ? wakeGaveUpLine(ask, clock.now() - began) : undefined;
              if (gaveUp !== undefined) entry.record.wakeRefused = gaveUp;
              // A stop leaves the machine where the abort found it: paused, until the late read says otherwise.
              if (stopped()) entry.ws.notePaused();
              entry.record.phase = entry.ws.currentPhase;
              await ctx.persist(entry.record);
              delete entry.wakeAsk;
              const words = stopped() ? WAKE_STOPPED : (gaveUp ?? (e instanceof Error ? e.message : String(e)));
              if (!stopped()) console.warn(`wake of ${id} failed: ${words}`);
              await ctx.emitStatus(entry, "napping", words);
              ctx.armLateRead(entry);
              throw stopped() ? new Error(WAKE_STOPPED) : gaveUp !== undefined ? new Error(gaveUp) : e;
            }
          }
        } finally {
          delete entry.wakeStop;
          delete entry.wakeSaid;
          delete entry.wakeAsk;
          delete entry.waking;
        }
      })();
      return entry.waking;
    },

    async stopWake(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      const waking = entry.waking;
      entry.wakeStop?.abort();
      await waking?.catch(() => {});
      return ctx.view(entry.record);
    },

    async upgrade(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      ctx.refuseCannot(entry, "replacesMachine", "have its machine replaced");
      await entry.ws.upgrade();
      ctx.followMachine(entry);
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      return ctx.view(entry.record);
    },

    async updateImage(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      ctx.refuseCannot(entry, "replacesMachine", "move to a newer image");
      const manifest = await ctx.goldenManifestOf(entry.record.golden);
      const head = goldenHead(manifest);
      const project = (await store.get(PROJECT_GOLDENS, entry.record.golden)) as ProjectGolden | undefined;
      const refusal = imageMoveRefusal(entry.record.name, workspaceState({ phase: entry.record.phase }), { knownVersion: head !== undefined, projectImage: project !== undefined });
      if (refusal !== null) throw Object.assign(new Error(refusal), { kind: "conflict" });
      // The refusal covers an image no manifest knows, so both are there by the time the move runs.
      const to = head!;
      const was = entry.record.golden;
      const from = manifest!.versions.find(v => v.snapshotId === was);
      if (to.snapshotId === was) return { workspace: ctx.view(entry.record), moved: false, kept: [] };
      // The archive is what lands and --recursive-unlink cannot merge, so which of the image's own files the fork
      // keeps is settled here, off the machine that is still running, before anything is replaced.
      const plan = await imageMovePlan(entry.machine, from, to);
      // The fork reads the record, so the new image is named before the machine is replaced; the vault carries the
      // work across. A move that throws puts the record back, so a retry forks what the
      // workspace is actually running.
      entry.record.golden = to.snapshotId;
      try {
        await entry.ws.upgrade(undefined, { drop: plan.drop.map(path => `${GUEST_HOME}/${path}`) });
      } catch (e) {
        entry.record.golden = was;
        throw e;
      }
      ctx.followMachine(entry);
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      await ctx.emitStatus(entry, ctx.reachOf(entry), `moved from image v${from?.version ?? "?"} to v${to.version}`);
      return { workspace: ctx.view(entry.record), moved: true, kept: plan.kept, ...(plan.fallback ? { fallback: true } : {}) };
    },

    async rebuild(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      ctx.refuseCannot(entry, "replacesMachine", "be rebuilt");
      if (entry.waking) await entry.waking.catch(() => {});
      if ((await ctx.recoverGone(entry)) !== undefined) return ctx.view(entry.record);
      const at = ctx.backendFor(entry.record);
      // Where the pause keeps the disk no nap stored a vault, so a rebuild takes one off the running machine before
      // the replacement, over the cap or unreadable going on with none. A napped one holds its home on its paused
      // disk, so it is woken first and the vault taken live, not the one a nap stored (this rule stores none); a wake
      // that cannot land refuses the rebuild rather than replacing with no backup. Where the pause does not keep the
      // disk, the rebuild reads the vault the nap stored.
      if (ctx.keepsImages(at) && ctx.pauseKeepsDisk(at) && entry.record.phase !== "running") {
        try {
          await workspaces.wake(id, origin);
        } catch (e) {
          throw Object.assign(new Error(`${entry.record.name} could not be woken to back up before the rebuild: ${e instanceof Error ? e.message : String(e)}`), { kind: "conflict" });
        }
      }
      const old = entry.record.machineId;
      const fromRunning = ctx.keepsImages(at) && ctx.pauseKeepsDisk(at) && entry.record.phase === "running";
      const napVault = fromRunning ? undefined : (await store.getBlob(VAULTS, id)) !== undefined;
      if (fromRunning) {
        try {
          await entry.ws.upgrade();
        } catch (e) {
          console.warn(`rebuild of ${id}: the running machine gave no vault (${e instanceof Error ? e.message : String(e)}); replacing with none`);
          await entry.ws.rebuild();
        }
      } else {
        await entry.ws.rebuild();
      }
      ctx.followMachine(entry);
      delete entry.record.wakeRefused;
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      const reason = fromRunning
        ? `rebuilt: ${old} replaced by ${entry.record.machineId}`
        : `rebuilt: ${old} replaced by ${entry.record.machineId}, ${napVault ? "nap-time vault imported" : "no vault to import"}`;
      console.warn(`rebuild of ${id}: ${reason}`);
      await ctx.emitStatus(entry, ctx.reachOf(entry), reason);
      return ctx.view(entry.record);
    },

    async rename(id, typed, origin) {
      const entry = await ctx.entryOf(id, origin);
      const name = ctx.nameGiven(typed);
      if (entry.record.name === name) return ctx.view(entry.record);
      const refusal = ctx.nameRefusal(name);
      if (refusal !== undefined) throw Object.assign(new Error(refusal), { kind: "conflict" });
      entry.record.name = name;
      await ctx.persist(entry.record);
      await store.put(WORKSPACE_NAMES, id, { workspaceId: id, name, project: entry.record.project } satisfies NamedWorkspace);
      bus.emit({ type: "workspace.renamed", workspaceId: id, name });
      return ctx.view(entry.record);
    },

    async look(id, look, origin) {
      const entry = await ctx.entryOf(id, origin);
      ctx.putLook(entry.record, "theme", look.theme);
      ctx.putLook(entry.record, "glyph", look.glyph);
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.look", workspaceId: id, theme: entry.record.theme ?? null, glyph: entry.record.glyph ?? null });
      return ctx.view(entry.record);
    },

    async snapshot(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      ctx.refuseCannot(entry, "diskSnapshots", "be snapshotted");
      const { name } = entry.record;
      // The snapshot is the whole disk and carries the project in it, which is the one the workspace was made for.
      const held = ctx.projectHeld(entry.record.project);
      const project: WorkspaceProject = { name: held.name, dest: held.path, importedAt: held.createdAt };
      const projects = [project];
      if (entry.record.phase !== "running") throw new Error(`${name} is ${entry.record.phase}; only a running machine can be snapshotted`);
      await syncDisk(entry.machine);
      const disk = await diskUse(entry.machine);
      const createdAt = new Date(clock.now()).toISOString();
      const snapshotId = await entry.ws.checkpoint(projectSnapshotName(ctx.imageMark(), project.name, createdAt.replace(/[:.]/g, "-"))).catch((e: unknown) => {
        if (e instanceof NotFirstLifeError) throw e;
        const said = snapshotRefusedLine(name, answerOf(e), disk);
        console.warn(said);
        const { kind, status } = e as { kind?: unknown; status?: unknown };
        throw Object.assign(new Error(said), kind !== undefined ? { kind } : {}, status !== undefined ? { status } : {});
      });
      const image = await ctx.imageOf(entry.record.golden);
      const golden: ProjectGolden = {
        snapshotId,
        projects,
        golden: image.golden,
        ...(image.version !== undefined ? { version: image.version.version } : {}),
        workspaceId: id,
        workspaceName: name,
        createdAt,
        ...(entry.record.place !== undefined ? { place: entry.record.place } : {}),
      };
      await store.put(PROJECT_GOLDENS, snapshotId, golden);
      return golden;
    },

    async updateDaemon(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      if (ctx.servedByItsComputer(entry) !== undefined) {
        throw new Error(placeServesDaemonLine(entry.record.name, ctx.computerOf(entry)));
      }
      const deploy = ctx.moduleOf(entry.record.kind).deployDaemon;
      if (deploy === undefined) throw new Error("this runtime cannot deploy a daemon; the host wires the bundle");
      if (entry.record.phase !== "running") throw new Error(`wake ${entry.record.name} before updating its daemon`);
      await ctx.deployDaemonOn(entry, deploy);
    },

    async delete(id, origin) {
      ctx.spawnGuard("delete", origin);
      if (scopeOf(origin) === undefined && !live.has(id) && ctx.failedCreates.delete(id)) {
        bus.emit({ type: "workspace.deleted", workspaceId: id });
        return;
      }
      const entry = await ctx.entryOf(id, origin);
      if (entry.deleting) return entry.deleting;
      // A worktree wsp made goes with its record, never over files no commit holds; the project folder, and a
      // worktree somebody else made, are never touched.
      const tree = entry.record.worktree;
      const takes = tree?.made === true && tree.gone !== true && existsSync(tree.path);
      if (takes) await ctx.refuseChanged(tree.path);
      entry.deleting = (async () => {
        try {
          delete entry.deleteSaid;
          ctx.endSessions(id, DELETED_REASON);
          const threads = new Set([...threadRecords].flatMap(([threadId, held]) => (held.workspaceId === id ? [threadId] : [])));
          for (const s of sessions.values()) if (s.view.workspaceId === id && s.view.threadId !== undefined) threads.add(s.view.threadId);
          if (copiesFolder(entry.record.kind)) for (const threadId of threads) await ctx.dropCheckpoints(entry, threadId);
          if (takes) await ctx.removeWorktree(entry, false, { ending: true });
          // Before the machine goes: on a computer somebody owns the folders the files landed in outlive the workspace.
          await ctx.dropThreadFiles(entry, [...threadRecords].flatMap(([threadId, held]) => (held.workspaceId === id ? [threadId] : [])));
          // A machine wsp never forked reads running whatever is asked of it, so only a forked one is read back.
          if (!kindWords(entry.record.kind).driven) {
            await entry.machine.kill().catch((e: unknown) => {
              if (!isMissing(e)) throw e;
            });
          } else {
            await ctx.unfork(entry).catch((e: unknown) => {
              if (!(e instanceof MachineAliveError)) throw e;
              const line = deleteRefusedLine(entry.record.name, e.machineId, e.state);
              entry.deleteSaid = { phase: entry.record.phase, line };
              console.warn(line);
              throw Object.assign(new Error(line), { kind: e.kind });
            });
          }
          await ctx.drop(id);
        } finally {
          delete entry.deleting;
        }
      })();
      return entry.deleting;
    },

    async forget(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      const kind = entry.record.kind;
      if (!kindWords(kind).driven) throw Object.assign(new Error(forgetUndrivenRefusal(entry.record.name, machineWord(kind))), { kind: "conflict" });
      const state = await readGone(ctx.backendFor(entry.record), entry.machine.id);
      if (state !== "gone") {
        throw Object.assign(new Error(`${entry.record.name}'s machine ${entry.machine.id} is still ${state}; pause it or delete it at the provider first`), { kind: "conflict" });
      }
      ctx.endSessions(id, DELETED_REASON);
      await ctx.drop(id);
    },

    async touch(id, origin) {
      await ctx.entryOf(id, origin);
      ctx.idle.touch(id);
    },

    async restartDaemon(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      const start = ctx.moduleOf(entry.record.kind).restartDaemon;
      if (start === undefined) throw new Error(`${entry.record.name}'s daemon runs on ${machineWord(entry.record.kind)}, which this host does not hold the process of`);
      await start(entry);
      // The poll's last measurement is of the daemon that is gone, and the next one is a poll away: the row would
      // go on saying no daemon for that long over a daemon this host has just watched start. Dropped rather than
      // replaced with a claim, so the row falls back to what this kind's road says and the next poll measures.
      ctx.polledReach.delete(entry.record.id);
      await ctx.pushStatus(entry);
    },

    async exec(id, cmd, o, origin) {
      const entry = await ctx.entryOf(id, origin);
      await ctx.copyBlocked(entry);
      return entry.machine.exec(cmd, o);
    },

    async execStream(id, argv, cwd, origin) {
      const entry = await ctx.entryOf(id, origin);
      await ctx.copyBlocked(entry);
      const { adapter } = await ctx.launchAdapterFor(entry);
      // Only the socket or the machine going away ends a command; a build may outlive the deadline a harness turn gets.
      const ranIn = await ctx.threadFolder(entry, { cwd });
      const inner = ctx.execFactoryFor(entry, { idleMs: Number.POSITIVE_INFINITY, deadlineMs: Number.POSITIVE_INFINITY })(inFolder(ranIn, argv.map(shellQuote).join(" ")), { env: { ...adapter.env } });
      let endWith: (reason: string) => void = () => {};
      const ended = new Promise<{ reason: string }>(resolve => {
        endWith = reason => resolve({ reason });
      });
      const running = {
        workspaceId: id,
        end: (reason: string): void => {
          endWith(reason);
          inner.kill();
        },
      };
      execs.add(running);
      // The inner poll loop notices the kill one poll late; the reason reaches the reader as soon as it is known.
      const lines = async function* (): AsyncGenerator<string> {
        const it = inner.lines[Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await Promise.race([it.next(), ended]);
            if ("reason" in next) throw new Error(next.reason);
            if (next.done) return;
            yield next.value;
          }
        } finally {
          execs.delete(running);
        }
      };
      return { ...inner, lines: lines(), exited: Promise.race([inner.exited, ended.then(() => null)]), ...(ranIn !== undefined ? { ranIn } : {}) };
    },

    async bringBack({ workspaceId, title, body: given }, origin) {
      let body = given;
      ctx.spawnGuard("bring_back", origin);
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      const cwd = ctx.checkoutOf(entry.record);
      // The branch this copy started from, off its own record: for a child that is the branch its parent was on at
      // the fork, which is the code it was cut from and so where its work goes back, and nothing is asked of the
      // parent's machine, so a child whose parent has gone to sleep brings its work back without a wake nobody
      // named. A record written before that fact was kept reads the branch its project starts from, as it did.
      const base = entry.record.base ?? ctx.projectHeld(entry.record.project).base;
      const against = base === undefined ? {} : { base };
      // A pull request off someone's fork takes a push only where its author allowed maintainers to push; refused
      // before anything is pushed.
      const fork = entry.record.from?.head?.fork;
      if (entry.record.from?.kind === "pull_request" && fork !== undefined && !fork.pushable) throw new Error(START_WORDS.forkNotPushable(fork.owner));
      // Work on an issue closes it once its pull request merges: the body says so, once, whoever wrote the rest of it.
      const issue = entry.record.from?.kind === "issue" ? entry.record.from.number : undefined;
      if (issue !== undefined) body = withCloses(body ?? "", issue);
      const brought = await ctx.queued(entry.record.id, () => ctx.withDaemon(entry, async (ask): Promise<BringBackResult> => {
        const push = GitPushReply.parse(
          await ask({ op: "git.push", cwd, ...against }).catch(async (e: unknown) => {
            const said = e instanceof Error ? e.message : String(e);
            if (entry.record.parentWorkspaceId !== undefined && isNoGitCredential(e)) await ctx.keepTree(entry, { ...entry.record.tree, pushRefused: said });
            throw e;
          }),
        );
        if (entry.record.tree?.pushRefused !== undefined) {
          const { pushRefused: _gone, ...rest } = entry.record.tree;
          await ctx.keepTree(entry, rest);
        }
        // A workspace a thread opened under a lead pushes its branch and opens nothing: the lead's own pull request is
        // where its work lands, which the lead merges its branch into.
        if (entry.record.parentThreadId !== undefined) {
          return { branch: push.branch, base: push.base, ahead: push.ahead, uncommitted: push.uncommitted, stat: push.stat, note: childPushedLine(push.branch) };
        }
        const asked = { op: "git.pr", cwd, ...against, ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) };
        // The push has landed by here, so nothing the pull request half says makes this a failed bring back: the
        // branch is on the remote either way and the two halves are answered apart. A machine with no signed-in
        // command line for the host is the note it always was; any other refusal rides beside the push as its own,
        // which the verb above prints under the push lines and then exits on.
        const opened = await ask(asked).catch((e: unknown) => {
          const said = e instanceof Error ? e.message : String(e);
          return isNoHostCli(e) ? { note: said } : { refused: said };
        });
        const half = opened as { note?: string; refused?: string };
        const apart = half.note !== undefined ? { note: half.note } : half.refused !== undefined ? { refused: half.refused } : { pr: GitPrReply.parse(opened).pr };
        return { branch: push.branch, base: push.base, ahead: push.ahead, uncommitted: push.uncommitted, stat: push.stat, ...apart };
      }));
      if (brought.pr !== undefined) await ctx.takePullRequest(entry, { ...brought.pr, readAt: clock.now() });
      ctx.readLeadOf(entry);
      return brought;
    },

    async folderFor(o, origin) {
      await ctx.ready();
      const at = await ctx.folderFor(o, origin);
      return { workspace: ctx.view(at.entry.record), ...(at.cwd !== undefined ? { cwd: at.cwd } : {}) };
    },

    async folder({ project: named }, origin) {
      await ctx.ready();
      const project = await ctx.projectsDoor.resolve(named, origin);
      if (!copiesFolder(kindForComputer(project.computer))) throw Object.assign(new Error(notOnThisComputerLine(project.name)), { kind: "usage" });
      ctx.refuseRecording(project.name, origin);
      return ctx.view((await ctx.projectFolder(project)).record);
    },

    async worktree({ project: named, branch }, origin) {
      await ctx.ready();
      const project = await ctx.projectsDoor.resolve(named, origin);
      const top = project.git?.top;
      if (!copiesFolder(kindForComputer(project.computer))) throw Object.assign(new Error(notOnThisComputerLine(project.name)), { kind: "usage" });
      if (top === undefined) throw Object.assign(new Error(noBranchesLine(project.name)), { kind: "usage" });
      const entry = await ctx.worktreeFolder(project, top, branch, undefined, scopeOf(origin)?.rootThreadId);
      const tree = entry.record.worktree;
      return { path: tree?.path ?? top, branch, made: tree?.made === true };
    },

    async worktreeRemove({ project: named, branch, force }, origin) {
      await ctx.ready();
      const project = await ctx.projectsDoor.resolve(named, origin);
      const top = project.git?.top;
      if (top === undefined) throw Object.assign(new Error(noBranchesLine(project.name)), { kind: "usage" });
      const holding = (await ctx.worktreesOf(top)).find(t => t.branch === branch)?.path;
      const entry = ctx.foldersOf(project.id).find(e => {
        const tree = e.record.worktree;
        return tree !== undefined && tree.gone !== true && (holding !== undefined ? tree.path === holding : tree.branch === branch);
      });
      if (entry !== undefined) ctx.refuseRelayed(entry.record, origin);
      if (entry?.record.worktree?.made !== true) throw Object.assign(new Error(notMadeWorktreeLine(branch)), { kind: "invalid" });
      if (force === true && scopeOf(origin) !== undefined) throw Object.assign(new Error(WORKTREE_FORCE_LINE), { kind: "usage" });
      await ctx.removeWorktree(entry, force === true);
    },

    async checkout(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      const checkout = await ctx.readCheckout(entry, false);
      // The tile asks as it mounts, and its word rides the status once the git host answers.
      void ctx.readPullRequest(entry, false);
      // A lead's thread opening reads its children again.
      if ([...live.values()].some(e => e.record.parentWorkspaceId === entry.record.id)) void ctx.readTree(entry);
      return checkout === undefined ? {} : { checkout };
    },

    async discard({ workspaceId, path }, origin) {
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      const put = GitDiscardReply.parse(await ctx.queued(entry.record.id, () => ctx.withDaemon(entry, ask => ask({ op: "git.discard", cwd: ctx.checkoutOf(entry.record), path }))));
      await ctx.readCheckout(entry, true);
      return put;
    },

    async commit({ workspaceId, message, paths }, origin) {
      ctx.spawnGuard("commit", origin);
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      const cwd = ctx.checkoutOf(entry.record);
      const made = GitCommitReply.parse(
        await ctx.queued(entry.record.id, () =>
          ctx.withDaemon(entry, async ask => {
            // Every changed file, each untracked one on its own, as the Changes pane lists them.
            const named = paths ?? GitDiffReply.parse(await ask({ op: "git.diff", cwd, scope: "head" })).files.map(f => f.path);
            if (paths === undefined && named.length === 0) throw new Error(cleanCheckoutLine(entry.record.name));
            return ask({ op: "git.commit", cwd, message, paths: named });
          }),
        ),
      );
      await ctx.readCheckout(entry, true);
      return made;
    },

    async commitDraft({ workspaceId, paths }, origin) {
      ctx.spawnGuard("commit", origin);
      if (paths !== undefined && paths.length === 0) return { message: null, note: DRAFT_NOTES.nothing };
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      // The workspace's newest thread drafts, on its own agent and from the task it was opened with; a workspace
      // with no thread yet drafts on the default agent from the diff alone.
      const rows = [...sessions.values()].map(s => s.view).filter(v => v.workspaceId === workspaceId).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      const newest = rows.at(-1);
      const opening = newest?.threadId === undefined ? undefined : rows.find(v => v.threadId === newest.threadId)?.prompt;
      const named = newest?.harness ?? ctx.defaultAgentOf(await ctx.preferences.get(), entry);
      if (adapters[named] === undefined || ctx.agentOff(entry, named)) return { message: null, note: DRAFT_NOTES.noAgent };
      const { harness, adapter } = await ctx.launchAdapterFor(entry, named);
      if (adapter.draftFor === undefined) return { message: null, note: DRAFT_NOTES.noAgent };
      const diff = GitDiffReply.parse(await ctx.withDaemon(entry, ask => ask({ op: "git.diff", cwd: ctx.checkoutOf(entry.record), scope: "head", ...(paths !== undefined ? { paths } : {}) })));
      const table = harnessCatalog(harness);
      const model = smallestModel(table === undefined ? undefined : await ctx.catalogOn(table, entry, adapter));
      // The question rides a file on the machine, since a diff is longer than one exec may carry, and only the
      // login that wrote it may read it; it goes once the answer is in, whatever the answer was.
      const promptFile = `/tmp/wsp-draft-${randomBytes(6).toString("hex")}.txt`;
      const question = draftPrompt(cutDiff(diff.files.map(f => f.patch).join("\n")), opening);
      const put = await putFiles(entry.machine, [{ path: promptFile, text: question }], { before: ["umask 077"] });
      if (put.exitCode !== 0) return { message: null, note: DRAFT_NOTES.noAnswer };
      try {
        const answer = await adapter.draftFor(
          { promptFile, ...(model !== undefined ? { model } : {}) },
          command => entry.machine.exec(command, { timeoutMs: TITLE_MAKE_TIMEOUT_MS }).then(res => res.stdout),
        );
        const message = answer === null ? null : commitMessage(answer);
        return message === null ? { message: null, note: DRAFT_NOTES.noAnswer } : { message };
      } finally {
        await entry.machine.exec(`rm -f ${shellQuote(promptFile)}`).catch(() => undefined);
      }
    },

    async viewed({ workspaceId, path, blob }, origin) {
      await ctx.entryOf(workspaceId, origin);
      const marks = { ...(ctx.viewedMarks.get(workspaceId) ?? {}) };
      if (path === undefined) return { viewed: marks };
      if (typeof blob === "string") marks[path] = blob;
      else delete marks[path];
      ctx.viewedMarks.set(workspaceId, marks);
      await ctx.persistSessions(workspaceId);
      bus.emit({ type: "workspace.viewed", workspaceId, viewed: marks });
      return { viewed: marks };
    },

    async pullRequestView({ workspaceId, fresh }, origin) {
      const { entry, remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      const { page, here } = await ctx.readPage(entry, remote, number, fresh === true);
      const merge = await ctx.mergeSettings(remote).catch(() => undefined);
      return { ...page, ...(merge !== undefined ? { merge } : {}), sent: entry.record.prSent ?? [], postsAsYou: here };
    },

    async pullRequestDiff({ workspaceId }, origin) {
      const { entry, remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      return ctx.readHost(entry, cwd => ({ op: "git.prDiff", cwd, remote, number, maxBytes: GIT_DIFF_CAP_BYTES }), r => GitPrDiffReply.parse(r));
    },

    async pullRequestReply({ workspaceId, replyTo, threadId, body }, origin) {
      if (body.trim() === "") throw Object.assign(new Error(REPLY_EMPTY_LINE), { kind: "invalid" });
      const { remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      const where = { ...(replyTo !== undefined ? { replyTo } : {}), ...(threadId !== undefined ? { threadId } : {}) };
      return ctx.postAsPerson(remote, number, cwd => ({ op: "git.prReply", cwd, remote, number, ...where, body }), r => GitPrReplyReply.parse(r));
    },

    async pullRequestResolve({ workspaceId, threadId, resolved }, origin) {
      const { remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      return ctx.postAsPerson(remote, number, cwd => ({ op: "git.prResolve", cwd, remote, number, threadId, resolved }), r => GitPrResolveReply.parse(r));
    },

    async pullRequestReact({ workspaceId, subject, content, on }, origin) {
      const { remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      return ctx.postAsPerson(remote, number, cwd => ({ op: "git.prReact", cwd, remote, number, subject, content, on }), r => GitPrReactReply.parse(r));
    },

    async pullRequestSend({ workspaceId, items }, origin) {
      const { entry, remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      await ctx.copyBlocked(entry);
      const { page } = await ctx.readPage(entry, remote, number, false);
      const same = (a: PullRequestItem, b: PullRequestItem): boolean => a.kind === b.kind && a.id === b.id;
      const asked = items.filter((item, n) => items.findIndex(other => same(item, other)) === n);
      const said = await ctx.toFirstThread(workspaceId, pullRequestSendPrompt(page, asked, number), origin);
      const at = clock.now();
      entry.record.prSent = [...(entry.record.prSent ?? []).filter(s => !asked.some(i => same(i, s))), ...asked.map(i => ({ kind: i.kind, id: i.id, at }))];
      await ctx.persist(entry.record);
      return { outcome: said.outcome, threadId: said.threadId, agent: said.harness, sent: entry.record.prSent };
    },

    async fix({ workspaceId, check, child }, origin) {
      ctx.spawnGuard("fix", origin);
      if (check !== undefined && child !== undefined) throw Object.assign(new Error(FIX_CHECK_OR_CHILD), { kind: "invalid" });
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      const project = ctx.projectHeld(entry.record.project);
      let prompt: string;
      let base: string;
      if (child !== undefined) {
        // A merge that stopped goes to the lead's agent as a message, and nothing is merged here.
        const kid = await ctx.childOf(entry, child, origin);
        const leadBranch = (await ctx.readCheckout(entry, false))?.branch ?? entry.record.base ?? project.base ?? project.defaultBranch;
        const childBranch = (await ctx.readCheckout(kid, false))?.branch ?? kid.record.worktree?.branch ?? "";
        // With no remote the child's branch is in its folder, which is where the merge took it from.
        const remote = remoteHost(project.remote) === undefined ? ctx.checkoutOf(kid.record) : "origin";
        prompt = mergeChildPrompt({ leadBranch, childBranch, remote, conflicts: kid.record.tree?.conflicts ?? [] });
        base = leadBranch;
      } else if (check === undefined) {
        const updated = await ctx.updateCopy(entry);
        base = updated.base;
        if (updated.merged) return { outcome: "updated", base };
        const branch = entry.checkout?.branch ?? (isPullRequestFact(entry.pr) ? entry.pr.branch : base);
        prompt = conflictsPrompt({ base, branch, files: updated.conflicts });
      } else {
        // Read whole: a check that failed since the last read moves nothing a lighter read compares.
        const fact = await ctx.readPullRequest(entry, true, true);
        if (!isPullRequestFact(fact)) throw new Error(noPullRequestRefusal(entry.record.name));
        const failed = fact.checks.find(c => c.name === check);
        if (failed === undefined) throw new Error(noSuchCheckRefusal(check, fact.checks.map(c => c.name)));
        if (failed.state !== "fail") throw new Error(checkNotFailedRefusal(check, failed.state));
        const run = failed.run;
        // A log the host no longer holds, or will not hand over, leaves the message with the check's link alone.
        const log =
          run === undefined
            ? undefined
            : await ctx.readHost(entry, cwd => ({ op: "git.runLog", cwd, remote: project.remote, runId: run.runId, jobId: run.jobId }), r => GitRunLogReply.parse(r)).catch(() => undefined);
        prompt = checkFailedPrompt({ check: failed, commit: { oid: fact.headOid, subject: fact.headSubject }, ...(log !== undefined ? { log } : {}) });
        base = fact.base;
      }
      const said = await ctx.toFirstThread(workspaceId, prompt, origin);
      return { outcome: said.outcome, threadId: said.threadId, ...(check !== undefined ? { check } : {}), ...(child !== undefined ? { child } : {}), base, agent: said.harness };
    },

    async merge({ workspaceId, method, whenChecksPass, head }, origin) {
      ctx.spawnGuard("merge", origin);
      const entry = await ctx.entryOf(workspaceId, origin);
      // The fact the host holds is the one every window drew, however old it is: a fresh read here would hand the
      // guard below whatever the agent pushed since the person looked. Read only where nothing was ever read.
      const fact = isPullRequestFact(entry.pr) ? entry.pr : await ctx.readPullRequest(entry, false);
      if (!isPullRequestFact(fact)) {
        const kept = entry.record.pr;
        throw new Error(kept !== undefined && kept.state !== "open" ? notOpenRefusal(kept.number, kept.state) : noPullRequestRefusal(entry.record.name));
      }
      if (fact.state !== "open") throw new Error(notOpenRefusal(fact.number, fact.state));
      const remote = ctx.projectHeld(entry.record.project).remote;
      const settings = await ctx.mergeSettings(remote);
      const by = method ?? settings.defaultMethod;
      if (!settings.methods.includes(by)) throw new Error(mergeMethodRefusal(by, settings.methods));
      if (whenChecksPass === true && !settings.autoMerge) throw new Error(AUTO_MERGE_OFF_LINE);
      // Merged on this computer as the person, and only while the head is the commit the person was shown, which the
      // window that drew it names: a push between the drawing and the press fails the merge in the host's own words
      // rather than landing unseen code.
      const done = GitPrMergeReply.parse(
        await ctx.onThisComputer((ask, home) => ask({ op: "git.prMerge", cwd: home, remote, number: fact.number, method: by, auto: whenChecksPass === true, headOid: head ?? fact.headOid })),
      );
      githubCache.delete(ctx.pageKey(remote, fact.number));
      await ctx.readPullRequest(entry, true);
      return { number: fact.number, method: by, merged: done.merged, autoArmed: done.autoArmed };
    },

    async update({ workspaceId }, origin) {
      ctx.spawnGuard("update", origin);
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      return ctx.updateCopy(entry);
    },

    async mergeIn({ workspaceId, child }, origin) {
      ctx.spawnGuard("merge_in", origin);
      const lead = await ctx.entryOf(workspaceId, origin);
      // A thread merges only into the workspace it runs on: a child merging into its lead is a merge nobody there asked.
      const asked = scopeOf(origin);
      if (asked !== undefined && asked.workspaceId !== lead.record.id) throw new Error(mergeIntoOwnRefusal(asked.threadId));
      const kid = await ctx.childOf(lead, child, origin);
      // The lead's copy is its agent's working tree, and a merge under a turn is one that agent was never asked about;
      // the asking thread's own turn is the one a tool call runs inside, so it is the one turn left out.
      const busy = [...sessions.values()]
        .map(s => s.view)
        .filter(v => v.workspaceId === lead.record.id && v.status === "running" && v.threadId !== undefined && v.threadId !== asked?.threadId);
      if (busy.length > 0) throw new Error(leadBusyRefusal(lead.record.name, busy.map(v => v.threadId!)));
      await ctx.copyBlocked(lead);
      const branch = (await ctx.readCheckout(kid, true))?.branch ?? kid.record.worktree?.branch ?? "";
      if (branch === "" || branch === DETACHED_HEAD) throw new Error(childOnNoBranchRefusal(kid.record.name));
      const project = ctx.projectHeld(lead.record.project);
      // Through the remote, the one place both copies always reach; with none, from the child's folder only where
      // both copies sit on this computer, since a copy on a box is visible to nothing but its own workspace.
      let from: string | undefined;
      if (remoteHost(project.remote) === undefined) {
        if (!isLocalWorkspace(lead.record) || !isLocalWorkspace(kid.record)) throw new Error(noRemoteForTreeLine(project.name));
        from = ctx.checkoutOf(kid.record);
      }
      const done = GitMergeInReply.parse(
        await ctx.queued(lead.record.id, () => ctx.withDaemon(lead, ask => ask({ op: "git.mergeIn", cwd: ctx.checkoutOf(lead.record), branch, ...(from !== undefined ? { from } : {}) }))),
      );
      const kept: TreeRecord = { ...kid.record.tree };
      if (done.merged) {
        delete kept.conflicts;
        if (done.commits > 0 && done.oid !== undefined) kept.merged = { oid: done.oid, at: clock.now(), ...(done.head !== undefined ? { head: done.head } : {}) };
      } else kept.conflicts = done.conflicts;
      await ctx.readCheckout(lead, true);
      await ctx.keepTree(kid, kept);
      return { lead: lead.record.name, child: kid.record.name, branch, merged: done.merged, commits: done.commits, conflicts: done.conflicts };
    },

    async start({ url, project: named, agent, model, effort, access }, origin) {
      ctx.spawnGuard("start", origin);
      await ctx.ready();
      const link = githubLinkOf(url);
      if (link === undefined) throw Object.assign(new Error(START_WORDS.notALink(url)), { kind: "invalid" });
      const project = ctx.projectByRepo(link.repo, named);
      const read = await ctx.issueOf(project.remote, link.number);
      const fact = link.kind === "pull_request" ? await ctx.pullRequestOf(project.remote, link.number) : undefined;
      const from = ctx.fromOf(link.kind, link.repo, read, fact);
      await ctx.picksHold(project, { ...(agent !== undefined ? { harness: agent } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(access !== undefined ? { access } : {}) });
      const entry = await ctx.workspaceFrom(project, from, fact, "start", origin);
      return ctx.openWith(entry, { prompt: fromTaskPrompt(from, read), ...(agent !== undefined ? { harness: agent } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(access !== undefined ? { access } : {}) }, origin);
    },

    async review({ url, workspaceId, agent, model, effort }, origin) {
      ctx.spawnGuard("review", origin);
      await ctx.ready();
      let repo: string;
      let number: number;
      let project: ProjectView;
      if (url !== undefined) {
        const link = githubLinkOf(url);
        if (link === undefined) throw Object.assign(new Error(START_WORDS.notALink(url)), { kind: "invalid" });
        if (link.kind !== "pull_request") throw Object.assign(new Error(START_WORDS.notAPullRequest), { kind: "invalid" });
        project = ctx.projectByRepo(link.repo, undefined);
        ({ repo, number } = link);
      } else {
        const entry = workspaceId === undefined ? undefined : await ctx.entryOf(workspaceId, origin);
        const kept = entry?.record.pr ?? (entry?.record.from?.kind !== "issue" ? entry?.record.from : undefined);
        if (entry === undefined || kept === undefined) throw Object.assign(new Error(START_WORDS.notAPullRequest), { kind: "invalid" });
        project = ctx.projectHeld(entry.record.project);
        repo = ownerRepoOf(project.remote) ?? project.remote;
        number = kept.number;
      }
      const reviewer = agent ?? "codex";
      const readOnly = ctx.readOnlyOf(reviewer);
      if (readOnly === undefined) throw Object.assign(new Error(START_WORDS.noReadOnly(reviewer, ctx.reviewers())), { kind: "invalid" });
      const fact = await ctx.pullRequestOf(project.remote, number);
      const read = await ctx.issueOf(project.remote, number);
      const diff = GitPrDiffReply.parse(await ctx.onThisComputer((ask, home) => ask({ op: "git.prDiff", cwd: home, remote: project.remote, number })));
      const from = ctx.fromOf("review", repo, read, fact);
      await ctx.picksHold(project, { harness: reviewer, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), permissionMode: readOnly });
      const entry = await ctx.workspaceFrom(project, from, fact, "review", origin);
      return ctx.openWith(entry, { prompt: reviewTaskPrompt(from, read, diff), harness: reviewer, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), permissionMode: readOnly }, origin);
    },

    async reviewDraft({ workspaceId, summary, verdict, on }, origin) {
      const entry = await ctx.entryOf(workspaceId, origin);
      const draft = entry.record.review;
      if (isReviewRead(draft) && (summary !== undefined || verdict !== undefined || on !== undefined)) {
        const ticks = new Map((on ?? []).map(t => [t.id, t.on]));
        entry.record.review = {
          ...draft,
          ...(summary !== undefined ? { summary } : {}),
          ...(verdict !== undefined ? { verdict } : {}),
          comments: draft.comments.map(c => (ticks.has(c.id) ? { ...c, on: ticks.get(c.id)! } : c)),
        };
        await ctx.persist(entry.record);
        bus.emit({ type: "workspace.review", workspaceId });
      }
      return entry.record.review === undefined ? {} : { review: entry.record.review };
    },

    async reviewPost({ workspaceId }, origin) {
      ctx.spawnGuard("review_post", origin);
      const entry = await ctx.entryOf(workspaceId, origin);
      const draft = entry.record.review;
      const from = entry.record.from;
      if (!isReviewRead(draft) || from === undefined) throw new Error(START_WORDS.noReviewYet(entry.record.name));
      const ticked = draft.comments.filter(c => c.on).map(({ id, path, line, side, body }) => ({ id, path, line, side, body }));
      const remote = ctx.projectHeld(entry.record.project).remote;
      // One call on this computer as the person, pinned to the head the review was written against, so a push since
      // is GitHub's to say and a half-made review is never seen.
      const done = GitPrReviewReply.parse(
        await ctx.onThisComputer((ask, home) => ask({ op: "git.prReview", cwd: home, remote, number: from.number, headOid: draft.headOid, event: draft.verdict, body: draft.summary, comments: ticked })),
      );
      entry.record.review = { ...draft, posted: { url: done.url, at: clock.now(), folded: done.folded } };
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.review", workspaceId });
      githubCache.delete(ctx.pageKey(remote, from.number));
      void ctx.readPullRequest(entry, true);
      return { url: done.url, number: from.number, comments: ticked.length - done.folded.length, folded: done.folded.length };
    },

    async daemonReach(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      return ctx.moduleOf(entry.record.kind).daemonRoad(entry);
    },

    async daemonChannel(id, onEvent, origin) {
      const entry = await ctx.entryOf(id, origin);
      if (!ctx.moduleOf(entry.record.kind).sharedDaemon) return ctx.copyChannel(entry, onEvent, ctx.WORKSPACE_FRAMES);
      const ptys = ctx.ownPtys.get(id) ?? new Map<string, number>();
      ctx.ownPtys.set(id, ptys);
      const heard = (event: Record<string, unknown>): void => {
        if (event["type"] === "pty.exit" && ptys.delete(String(event["ptyId"]))) ctx.portRootsMoved(id);
        onEvent(event);
      };
      return ctx.rootedPorts(id, ctx.checkoutOf(entry.record), ptys, await ctx.copyChannel(entry, heard, ctx.WORKSPACE_FRAMES));
    },

    async guestChannel(id, onEvent) {
      return ctx.copyChannel(await ctx.entryOf(id), onEvent, ctx.GUEST_ROAD_FRAMES);
    },

    async servedByItsComputer(id, origin) {
      return ctx.servedByItsComputer(await ctx.entryOf(id, origin)) !== undefined;
    },

    async watchSys(id, fn, origin) {
      const entry = await ctx.entryOf(id, origin);
      const kind = entry.record.kind;
      if (readingRoad(kind, "metrics") !== "host") throw new Error(`${machineWord(kind)} reads its own load over its daemon link, not from this host`);
      if (local?.sysSamples === undefined) throw new Error("this host reads nothing of the computer it runs on");
      return local.sysSamples(fn);
    },

    async portReach(id, port, origin) {
      const entry = await ctx.entryOf(id, origin);
      await ctx.copyBlocked(entry);
      const reach = await entry.ws.portReach(port);
      return { url: reach.url, expiresAt: reach.expiresAt };
    },

    async portProbe(id, port, origin) {
      const entry = await ctx.entryOf(id, origin);
      await ctx.copyBlocked(entry);
      const reach = await entry.ws.portReach(port);
      // A followed redirect would refetch without the token or the edge's cookies and report the edge's 401 for a page the frame loads fine.
      const res = await fetch(reach.url, { redirect: "manual", signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS) });
      const body = await readBodyUpTo(res, PORT_PROBE_BODY_CAP);
      if (res.status === 401) await entry.ws.remintPortReach(port);
      return { status: res.status, body };
    },

    async originRefusal(id, origin) {
      await ctx.ready();
      return ctx.refusalFor(live.get(id)?.record, origin);
    },

    creating() {
      return [...ctx.createStages.values()];
    },

    seenBy(event, origin) {
      const scope = scopeOf(origin);
      if (scope === undefined) return true;
      const asked = askerOf(event);
      if (asked !== undefined) return asked.threadId === scope.threadId || asked.rootThreadId === scope.rootThreadId;
      const id = workspaceIdOf(event);
      const record = id === undefined ? undefined : live.get(id)?.record;
      if (record === undefined) return false;
      // An event about a thread is that thread's tree's, whatever workspace it names: the stream shows exactly what
      // the listing and the transcript show, a lead's turn to the child on its copy included, and hides the rest,
      // so a row cannot be read going by. An event with no thread is about the workspace and reads its rule.
      const thread = (event as { threadId?: unknown }).threadId;
      if (typeof thread === "string") return ctx.reachesRow({ threadId: thread, workspaceId: record.id }, origin);
      return ctx.refusalFor(record, origin) === undefined;
    },
  };
  return { workspaces };
}


function buildersArea(ctx: RuntimeContext): BuildersArea {
  const { opts, backend, store, placeDoor, bus, clock, hostId, builders, gone, stageAt, places } = ctx;
  const builderView = (r: BuilderRecord, b: LiveBuilder): GoldenBuilderView => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    createdAt: r.createdAt,
    size: r.size,
    ...(r.streamUrl !== undefined ? { screen: { streamUrl: r.streamUrl } } : {}),
    sealable: b.sealable,
    ...(r.import !== undefined ? { recipeHash: r.import.recipeHash } : {}),
    ...(r.import?.recipe !== undefined ? { recipe: r.import.recipe } : {}),
    ...(b.life === "foreign" ? { foreignOwner: b.builder.machine.labels?.[OWNER_LABEL] ?? "" } : {}),
    ...(b.life === "held" && r.heldBy !== undefined ? { heldBy: r.heldBy } : {}),
    ...(r.building === true ? { building: true } : {}),
    ...(r.sealed !== undefined ? { sealed: r.sealed } : {}),
  });

  /** One timer per kept builder, so the grace ends on time inside a process; the sweep is the road across processes. */
  const graceTimers = new Map<string, () => void>();
  const armGrace = (id: string, sealedAt: string): void => {
    graceTimers.get(id)?.();
    const left = Math.max(0, GRACE_MS - (clock.now() - Date.parse(sealedAt)));
    graceTimers.set(id, clock.schedule(() => {
      graceTimers.delete(id);
      void expireGrace().catch((e: unknown) => console.warn(`grace sweep failed: ${e instanceof Error ? e.message : String(e)}`));
    }, left, { unref: true }));
  };
  /** True while a kept builder's window is still open by our clock. */
  const inWindow = (sealedAt: string): boolean => {
    const ageMs = clock.now() - Date.parse(sealedAt);
    return !Number.isNaN(ageMs) && ageMs < GRACE_MS;
  };
  let expiring: Promise<{ reaped: ReapedMachine[]; failed: ReapFailure[] }> | undefined;
  /** Stops every kept builder whose window is over, each on its own: a kill that fails is reported and the record
   * kept for the next sweep. A builder another process holds is that process's to stop. One pass at a time: two
   * timers falling due together, or a timer beside a sweep, must not both kill and forget the same builder. */
  const expireGrace = (): Promise<{ reaped: ReapedMachine[]; failed: ReapFailure[] }> => (expiring ??= expireGraceNow().finally(() => (expiring = undefined)));
  const expireGraceNow = async (): Promise<{ reaped: ReapedMachine[]; failed: ReapFailure[] }> => {
    await ctx.refreshBuilders();
    const reaped: ReapedMachine[] = [];
    const failed: ReapFailure[] = [];
    for (const b of [...builders.values()]) {
      if (b.record.sealed === undefined || !(b.life === "own" || b.life === "reusable") || inWindow(b.record.sealed.at)) continue;
      try {
        await gone.stop(backend, b.builder.machine);
      } catch (e) {
        failed.push({ id: b.record.id, message: `could not stop: ${e instanceof Error ? e.message : String(e)}; stays recorded, retried next sweep` });
        continue;
      }
      graceTimers.get(b.record.id)?.();
      graceTimers.delete(b.record.id);
      await forgetBuilder(b.record.id);
      reaped.push({ id: b.record.id, builder: true, reason: "grace", ageMs: clock.now() - Date.parse(b.record.sealed.at) });
    }
    return { reaped, failed };
  };
  const arm = (): void => {
    if (ctx.state.closed || ctx.state.beat !== undefined) return;
    ctx.state.beat = clock.schedule(
      () => {
        ctx.state.beat = undefined;
        ctx.state.ticking = tick();
      },
      HEARTBEAT_MS,
      { unref: true },
    );
  };
  // One failed write costs one beat, never the timer: the hold is what keeps other processes off the builder.
  const tick = async (): Promise<void> => {
    const own = [...builders.values()].filter(x => x.life === "own");
    for (const b of own) {
      await hold(b).catch((e: unknown) => console.warn(`heartbeat for builder ${b.record.id} not written: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (own.length > 0) arm();
  };
  // The record is written whatever the runtime's state, so a prepare that finishes after close() leaves a finished
  // record and not a placeholder; the hold stamp and its timer are this process's and stop with it. A caller that
  // closes while a prepare still runs leaves the placeholder unheld until its stages finish; none does today.
  const hold = async (b: LiveBuilder): Promise<void> => {
    // A record forgotten while a heartbeat was in flight must not come back: the write is skipped for a builder no longer live.
    if (builders.get(b.record.id) !== b) return;
    if (!ctx.state.closed) b.record.heldBy = { host: hostId, pid: process.pid, heartbeat: new Date().toISOString() };
    await store.put(BUILDERS, b.record.id, b.record);
    if (!ctx.state.closed) arm();
  };

  /** A record wearing another state file's label, or held by another live process, is listed and nothing else;
   * acting on it by id would touch a machine that is not this process's to touch. */
  const refuseUntouchable = (entry: LiveBuilder): void => {
    if (entry.life === "foreign") throw new Error(`${entry.record.id} wears another setup's owner label (${entry.builder.machine.labels?.[OWNER_LABEL]}); it is never sealed or reached from here`);
    if (entry.life === "held") throw new Error(`${entry.record.id} is in use by another wsp process (pid ${entry.record.heldBy?.pid}); it is never sealed or reached from here`);
    if (entry.record.building) throw new Error(`${entry.record.id} is still being prepared; it is never sealed or reached until its stages finish`);
  };

  const forgetBuilder = async (id: string): Promise<void> => {
    builders.delete(id);
    await store.delete(BUILDERS, id);
  };

  /** What a stopped build does with the record of the machine its rollback tried to take: only a machine the provider
   * answers gone for GONE_READS reads in a row loses its record. One that outlived the kill, or one the provider
   * could not be asked about, keeps it, since a machine still running that nothing points at bills until somebody
   * lists the account by hand; a kept record is what the next build attaches to and what the doctor sweeps. */
  const forgetIfGone = async (entry: LiveBuilder, at: MachineBackend): Promise<void> => {
    const gone = await readGone(at, entry.record.id).then(
      state => state === "gone",
      () => false,
    );
    if (gone) await forgetBuilder(entry.record.id);
  };

  /** The listener one build's stages ride out on. `on` is the computer the build runs on, which is what a gap in a
   * link is matched against; `named` is whether the frames carry it, since only a copy's build is a thing that
   * computer's row reports. */
  const stageOf =
    (name: string, on?: string, named = false) =>
    (stage: GoldenStage, detail?: string, step?: GoldenStep, left?: readonly string[]) => {
      const place = named ? on : undefined;
      const frame: StageFrame = { name, stage, ...(detail !== undefined ? { detail } : {}), ...(step !== undefined ? { step } : {}), ...(left !== undefined && left.length > 0 ? { left: [...left] } : {}) };
      // The three words a build's stages end on; past one of them nothing of this build is asking that computer
      // anything, so a gap in its link is no longer this build's to report.
      if (on !== undefined) {
        if (stage === "ready" || stage === "sealed" || stage === "failed") stageAt.delete(copyKey(on, name));
        else stageAt.set(copyKey(on, name), { place: on, name, named, frame });
      }
      bus.emit({ ...frame, type: "golden.stage", ...(place !== undefined ? { place } : {}) });
    };
  /** The backend a place id resolves to: a provider row, or a joined computer whose backend this host has heard. */
  const backendAt = (place: string): MachineBackend => {
    const at = places.backend(place) ?? placeDoor?.backendOf(place);
    if (at === undefined) throw Object.assign(new Error(noSuchPlaceRefusal(place, places.list())), { kind: "missing" });
    return at;
  };
  /** The place a word names, as the golden roads key it: a provider's id, or the id a joined computer's copies are
   * filed under, with the backend a builder there is made on. A joined computer's backend is asked of the computer
   * the first time and read off its record after. This computer is never built into, so its own name is refused
   * rather than read as the provider this host forks on, which a fork's road reads it as. */
  const placeAt = async (word: string): Promise<{ place: string; at: MachineBackend }> => {
    const own = places.backend(word);
    if (own !== undefined) return { place: word, at: own };
    if (placeDoor === undefined) return { place: word, at: backendAt(word) };
    let placeId: string | undefined;
    try {
      ({ placeId } = await placeDoor.placeFor(word));
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { kind: "missing" });
    }
    if (placeId === undefined) throw ctx.conflict(placeBuildsNoImageLine(word));
    return { place: placeId, at: await placeDoor.forkingBackend(placeId) };
  };
  /** The backend a fork lands on, gated before any machine is asked for: a joined computer that forks nowhere refuses
   * with its doctor's reason, and a place that forks nothing refuses with NO_PROVIDER_LINE when no place here runs
   * workspaces, else naming the places that do, so nobody is sent to a provider they do not need. */
  const landingBackend = async (placeId: string | undefined): Promise<MachineBackend> => {
    const at = await forkingAt(placeId);
    if (at !== undefined) return at;
    const running = (await buildPlaces()).map(r => r.name);
    throw ctx.conflict(running.length === 0 ? (opts.noMachinesLine ?? NO_PROVIDER_LINE) : placeForksNothingPickLine(placeName(placeId ?? places.wired), running));
  };
  /** The backend a fork on that place would land on, or nothing where it forks nothing, with no refusal worded: the
   * refusal lists the places, and a list read while the records load waits on that load. */
  const forkingAt = async (placeId: string | undefined): Promise<MachineBackend | undefined> => {
    // The first fork on a joined computer is where this host learns what that computer forks with; every road after
    // it reads the answer off the place's record.
    if (placeId !== undefined) await ctx.placeDoorOf().forkingBackend(placeId);
    const at = ctx.backendOfKind("cloud", placeId);
    return forksNoMachines(at.capabilities) ? undefined : at;
  };
  const placeName = (place: string): string => placeDoor?.nameOf(place) ?? place;
  /** Where the image's own seal stands: the place the record names, or the provider this host forks on for a record
   * sealed before places. The manifest there is the one wsp init built and updates. */
  const imagePlace = async (name: string): Promise<string> => (await ctx.recordOf(name))?.place ?? places.wired;
  /** Every place an image can be built at: the provider rows that fork, and the joined computers whose daemon runs
   * workspaces, this computer left out since it is never forked into. */
  const buildPlaces = async (): Promise<{ place: string; name: string; backend: MachineBackend }[]> => {
    const rows: { place: string; name: string; backend: MachineBackend }[] = [];
    for (const id of places.list()) {
      const at = places.backend(id);
      if (at !== undefined && !forksNoMachines(at.capabilities)) rows.push({ place: id, name: id, backend: at });
    }
    if (placeDoor === undefined) return rows;
    for (const view of await placeDoor.list(clock.now())) {
      if (!isJoinedComputer(view)) continue;
      const at = await placeDoor.forkingBackend(view.id).catch(() => undefined);
      if (at !== undefined) rows.push({ place: view.id, name: view.name, backend: at });
    }
    return rows;
  };

  /** How a copy of the image is planned off the record. The runtime writes no recipe of its own, so a host that
   * wired none builds no copy anywhere, and every road that needs one says so in the one sentence. */
  const copyRecipeOrThrow = (): ((image: SealedImage) => Promise<GoldenRecipe> | GoldenRecipe) => {
    const compose = opts.copyRecipe;
    if (compose === undefined) throw new Error(NO_COPY_RECIPE);
    return compose;
  };

  /** The recipe a golden road builds from: the one the call names, else the one the runtime was wired with. A host
   * serving the app names it per call, since the init job's recipe is answered while the runtime already serves. */
  const recipeOrThrow = (named?: GoldenRecipe): GoldenRecipe => {
    const recipe = named ?? opts.goldenRecipe;
    if (!recipe) throw new Error("this runtime has no golden recipe; the host wires one (setup + smoke) before the wizard can run");
    return recipe;
  };

  const builderLabels = (extra: Record<string, string> | undefined): Record<string, string> => ({ ...extra, [WSP_LABEL]: "1", [BUILDER_LABEL]: "1", [OWNER_LABEL]: ctx.state.owner, [CREATED_AT_LABEL]: new Date().toISOString() });

  /** The hold begins the moment the machine exists: a held placeholder is on the store before any stage runs, so
   * another process over it (a second host, wspx) never reads this machine as lost. */
  const recordingCreates = (
    b: MachineBackend,
    name: string,
    imp: Pick<GoldenImport, "recipeHash" | "recipe"> | undefined,
    made: (placeholder: LiveBuilder) => void,
    stop: { signal: AbortSignal | undefined; began: (creating: Promise<Machine>) => void } | undefined,
    place: string,
  ): MachineBackend => ({
    ...b,
    create: spec => {
      if (stop?.signal?.aborted) return Promise.reject(new PrepareStoppedError());
      // Handed out before the provider is called, so a stop that lands inside the call waits for the machine it returns.
      const creating = Promise.resolve().then(async () => {
        const machine = ctx.observed(await b.create(spec));
        const asked = { cpu: spec.cpu ?? backend.pricing.defaultSize.cpu, memMb: spec.memMb ?? backend.pricing.defaultSize.memMb };
        const record: BuilderRecord = {
          id: machine.id,
          name,
          kind: spec.kind,
          baseTemplate: spec.template ?? "",
          setupSha: "",
          // The keyed create restamps the label after this spec was built; the machine carries the stamp the provider got.
          createdAt: machine.labels?.[CREATED_AT_LABEL] ?? spec.labels?.[CREATED_AT_LABEL] ?? new Date().toISOString(),
          size: asked,
          firstLife: true,
          building: true,
          ...(machine.streamUrl !== undefined ? { streamUrl: machine.streamUrl } : {}),
          ...(imp !== undefined ? { import: { recipeHash: imp.recipeHash, ...(imp.recipe !== undefined ? { recipe: imp.recipe } : {}), applied: [], smoke: "true" } } : {}),
          place,
        };
        const placeholder: LiveBuilder = { record, builder: { machine, kind: spec.kind, baseTemplate: record.baseTemplate, setupSha: "", createdAt: record.createdAt, firstLife: true, size: asked }, sealable: true, life: "own" };
        builders.set(machine.id, placeholder);
        made(placeholder);
        await hold(placeholder);
        return machine;
      });
      stop?.began(creating);
      return creating;
    },
  });

  /** The finished builder replaces its placeholder on the record and stays this process's own. */
  const settleBuilder = async (name: string, builder: Builder, placeholder: LiveBuilder | undefined, place: string): Promise<LiveBuilder> => {
    const record: BuilderRecord = {
      id: builder.machine.id,
      name,
      kind: builder.kind,
      baseTemplate: builder.baseTemplate,
      setupSha: builder.setupSha,
      createdAt: placeholder?.record.createdAt ?? builder.createdAt,
      size: builder.size,
      firstLife: true,
      ...(builder.machine.streamUrl !== undefined ? { streamUrl: builder.machine.streamUrl } : {}),
      ...(builder.import !== undefined ? { import: builder.import } : {}),
      ...(builder.base !== undefined ? { base: builder.base } : {}),
      place,
    };
    const entry: LiveBuilder = placeholder ?? { record, builder, sealable: true, life: "own" };
    entry.record = record;
    entry.builder = builder;
    builders.set(record.id, entry);
    await hold(entry);
    return entry;
  };

  /** What the host owns after a seal. The image's own seal writes the record afresh, wherever it ran: the recipe hash
   * the builder carried, the small recipe it was planned from, the logins the seal stamped, the vault it took, their
   * one hash, and the place it stands at. A copy's seal moves nothing of the record; only the copy is recorded,
   * under the hash the record already has. Either way the version carries that hash, so a copy says for itself what
   * it was built from. */
  const recordSeal = async (place: string, name: string, entry: LiveBuilder, recipe: GoldenRecipe, result: SealResult, copy: SealedImage | undefined): Promise<SealResult> => {
    // A copy is stamped with the record it was composed from, never with the record as it stands now: a cut that
    // landed while the copy built leaves it stale, which is what makes the next build there happen.
    let hash = copy?.hash;
    if (copy === undefined) {
      const digest = entry.builder.import?.recipeHash ?? "";
      const vault: SealedVault | undefined =
        result.vault === undefined
          ? undefined
          : { sha256: result.vault.sha256, bytes: result.vault.tar.length, paths: result.vault.paths, held: result.vault.held, takenAt: result.version.createdAt };
      const pins = recipePins(entry.builder.import?.recipe ?? { ticks: [] }, id => catalogIdOfRow({ id }) ?? id);
      hash = imageHash(digest, vault?.sha256, pins);
      const image: SealedImage = {
        name,
        version: result.version.version,
        hash,
        recipeHash: digest,
        ...(recipe.source !== undefined ? { recipe: recipe.source } : {}),
        pins,
        logins: result.version.logins ?? [],
        sealedAt: result.version.createdAt,
        sealedFrom: hostId,
        ...(vault !== undefined ? { vault } : {}),
        ...(result.version.usedBytes !== undefined ? { usedBytes: result.version.usedBytes } : {}),
        place,
      };
      const replaced = (await store.get(IMAGES, name)) as SealedImage | undefined;
      if (result.vault !== undefined) await store.putBlob(IMAGE_VAULTS, vaultKey(name, result.version.version), result.vault.tar);
      await store.put(IMAGES, name, image);
      // No version's sign-ins in the clear outlive the record that named that version, whatever the cut did with
      // its snapshot: the record names one version, and the blob of the one it replaced goes with it.
      if (replaced !== undefined && replaced.version !== result.version.version) await store.deleteBlob(IMAGE_VAULTS, vaultKey(name, replaced.version));
    }
    if (hash === undefined) return result;
    const version: GoldenVersion = { ...result.version, imageHash: hash };
    return { ...result, version, manifest: { ...result.manifest, versions: result.manifest.versions.map(v => (v.version === version.version ? version : v)) } };
  };

  /** Snapshot, smoke fork, manifest. A kept builder stays recorded with the version it was saved as and its grace
   * armed; every other road drops the record, so a machine that outlived its kills is exactly what reap sweeps.
   * `copy` is the record a copy's build was composed from: the record stays as it is, the copy is stamped with that
   * record's hash and the frames name the place. */
  const sealEntry = async (entry: LiveBuilder, keep: boolean, logins?: GoldenLogin[], copy?: SealedImage): Promise<SealResult> => {
    const recipe = recipeOrThrow(entry.recipe);
    const name = entry.record.name;
    // The place this builder was made at, where its seal is filed.
    const place = entry.record.place ?? places.wired;
    const prior = await ctx.copyOf(place, name);
    const at = backendAt(place);
    try {
      const result = await ctx.claiming(`smoke/${entry.record.id}`, b =>
        sealGolden(entry.builder, {
          backend: ctx.observing(b),
          smoke: recipe.smoke,
          ...(recipe.cpu !== undefined ? { cpu: recipe.cpu } : {}),
          ...(recipe.memMb !== undefined ? { memMb: recipe.memMb } : {}),
          ...(recipe.envs !== undefined ? { envs: recipe.envs } : {}),
          labels: { ...recipe.labels, [WSP_LABEL]: "1", [SMOKE_LABEL]: "1", [OWNER_LABEL]: ctx.state.owner, [CREATED_AT_LABEL]: new Date().toISOString() },
          ...(prior !== undefined ? { manifest: prior } : {}),
          onStage: stageOf(name, place, copy !== undefined),
          ...(opts.killConfirm !== undefined ? { killConfirm: opts.killConfirm } : {}),
          ...(opts.snapshotRetryMs !== undefined ? { snapshotRetryMs: opts.snapshotRetryMs } : {}),
          ...(logins !== undefined ? { logins } : {}),
          // Only the image's own seal reads the vault off its builder: a copy's builder was given the record's
          // vault and re-exporting it there would record a second one for the same image.
          ...(copy === undefined && recipe.vaultPaths !== undefined ? { vaultPaths: recipe.vaultPaths } : {}),
          keepBuilder: keep,
          name,
          hostId: ctx.imageMark(),
        }),
        at,
      );
      const stamped = await recordSeal(place, name, entry, recipe, result, copy);
      await ctx.putCopy(place, name, stamped.manifest);
      const snapshot = entry.builder.import?.recipe;
      if (snapshot !== undefined) await ctx.putCopyRecipe(place, name, stamped.version.version, snapshot);
      // The seal stands whatever the mark does: a default that could not be written is a later fork's to ask about.
      if (copy === undefined && name === "default") await placeDoor?.markDefaultIfNone(place).catch((e: unknown) => console.warn(`the default place was not marked at the seal: ${e instanceof Error ? e.message : String(e)}`));
      if (result.builderKept) {
        entry.record.sealed = { at: new Date(clock.now()).toISOString(), version: result.version.version };
        entry.life = "own";
        await hold(entry);
        armGrace(entry.record.id, entry.record.sealed.at);
      } else {
        await forgetBuilder(entry.record.id);
      }
      return stamped;
    } catch (e) {
      // A builder the provider refused to snapshot and still has is untouched, so its record stays for the next attach.
      if (e instanceof SnapshotFailedError && e.builderState !== "gone") throw e;
      // sealGolden consumes the builder on every other road but a refusal; a refused
      // builder can never seal and under a two-machine cap must not outlive it.
      if (e instanceof NotFirstLifeError) await killUntilGone(at, entry.builder.machine, opts.killConfirm);
      await forgetIfGone(entry, at);
      throw e;
    }
  };

  /** Deletes what a version's forks boot from. The template goes first: the provider refuses to delete a snapshot
   * while a template stands on it, and a template already gone is no failure. The sealed vault is not this
   * function's: a manifest counts its own place's versions, and the record's blob is keyed by the record's, so
   * only the seal that replaces a version may take that version's blob. */
  const dropImage = async (v: GoldenVersion, at: MachineBackend = backend): Promise<void> => {
    if (v.templateId !== undefined) {
      await templatesOf(at)?.delete(v.templateId).catch((e: unknown) => {
        if (!isMissing(e)) throw e;
      });
    }
    await at.deleteSnapshot(v.snapshotId);
  };
  return {
    builderView, graceTimers, armGrace, inWindow, expireGrace, hold, refuseUntouchable, forgetBuilder, forgetIfGone,
    stageOf, backendAt, placeAt, landingBackend, forkingAt, placeName, imagePlace, buildPlaces, copyRecipeOrThrow,
    recipeOrThrow, builderLabels, recordingCreates, settleBuilder, sealEntry, dropImage,
  };
}

function goldenArea(ctx: RuntimeContext): GoldenArea {
  const { opts, backend, store, placeDoor, clock, builders, preparing, places } = ctx;
  const golden: Runtime["golden"] = {
    async build(o) {
      await ctx.ready();
      const { name, ...build } = o;
      const key = name ?? "default";
      const prior = await ctx.copyOf(places.wired, key);
      const result = await ctx.claiming(`golden/${key}`, b =>
        buildGolden({
          ...build,
          backend: b,
          name: key,
          hostId: ctx.imageMark(),
          labels: { ...build.labels, [WSP_LABEL]: "1", [OWNER_LABEL]: ctx.state.owner, [CREATED_AT_LABEL]: new Date().toISOString() },
          ...(prior !== undefined ? { manifest: prior } : {}),
        }),
      );
      await ctx.putCopy(places.wired, key, result.manifest);
      return { manifest: result.manifest, version: result.version };
    },
    async get(name) {
      await ctx.ready();
      const key = name ?? "default";
      return ctx.copyOf(await ctx.imagePlace(key), key);
    },

    async buildPlace(word) {
      await ctx.ready();
      const runs = (place: string, at: MachineBackend): { place: string; name: string; backend: MachineBackend } => {
        const name = ctx.placeName(place);
        if (forksNoMachines(at.capabilities)) throw Object.assign(new PlaceForksNowhereError(`${name} forks no machines, so your image cannot be built there`), { kind: "conflict" });
        return { place, name, backend: at };
      };
      // A rebuild seals over the record, so building it anywhere else would move the image's home.
      const target = (await ctx.recordOf("default")) !== undefined ? await ctx.imagePlace("default") : word;
      if (target !== undefined) {
        const { place, at } = await ctx.placeAt(target);
        return runs(place, at);
      }
      // The default place first, since it is where every fork that names none lands; where it runs no workspaces, the
      // one other place that does. None at all and more than one are each their own refusal: the run does not guess.
      const marked = (await placeDoor?.defaultPlace()) ?? {};
      try {
        return marked.placeId === undefined ? runs(places.wired, ctx.backendAt(places.wired)) : runs(marked.placeId, await placeDoor!.forkingBackend(marked.placeId));
      } catch (e) {
        // Only a place that runs no workspaces is passed over. A link down or a frame unanswered on the place the
        // person marked is theirs to read, with that place's name in it, never a build sent somewhere else.
        if (!(e instanceof PlaceForksNowhereError)) throw e;
      }
      const running = await ctx.buildPlaces();
      if (running.length === 0) throw ctx.conflict(NO_BUILD_PLACE_LINE);
      if (running.length > 1) throw ctx.conflict(buildPlaceAskLine(running.map(r => r.name)));
      return running[0]!;
    },

    async prepare(o) {
      await ctx.ready();
      const recipe = ctx.recipeOrThrow(o?.recipe);
      const name = o?.name ?? "default";
      const signal = o?.signal;
      const { deployDaemon, smoke, import: imp, ...size } = recipe;
      void smoke;
      // A seal over a standing record files it where the builder was made, so the image's own build goes to the
      // record's place whatever was asked, and only a copy is built anywhere else.
      const asked = o?.copy !== true && (await ctx.recordOf(name)) !== undefined ? await ctx.imagePlace(name) : o?.place;
      const { place, at } = asked === undefined ? { place: places.wired, at: ctx.backendAt(places.wired) } : await ctx.placeAt(asked);
      // Per place as well as per name: a copy building at one place and the image building at another are two
      // prepares of one golden, and neither is the other's to join.
      const preparingKey = copyKey(place, name);
      const active = preparing.get(preparingKey);
      if (active !== undefined) {
        if (active.hash === imp?.recipeHash) return active.promise;
        throw new Error(`a builder named ${name} is still being prepared for a different recipe; wait for it to finish, then run again`);
      }
      const stage = ctx.stageOf(name, place, o?.copy === true);
      const run = ctx.claiming(`builder/${preparingKey}`, async b => {
        await ctx.refreshBuilders();
        // A builder with a seal still in it carrying the same ticks is attached to instead of
        // booting a second one, whichever process made it; the stages skip on its
        // ledger. A stale, foreign or held record is never reused, and a recipe with no
        // import never attaches: nothing says which ticks the builder carries. The
        // building check is a second wall: the join above holds it in this process,
        // life does across processes.
        const same = imp === undefined ? undefined : [...builders.values()].find(x => (x.life === "own" || x.life === "reusable") && x.record.building !== true && x.record.sealed === undefined && x.record.name === name && (x.record.place ?? places.wired) === place && x.record.import?.recipeHash === imp.recipeHash);
        // The machine this prepare has, attached to or made. A stop kills a made one by its recorded id and drops the
        // record; an attached one still has a seal in it and maybe an earlier run's sign-ins, so its hold is released and
        // its record stays reusable.
        let mine: LiveBuilder | undefined;
        let creating: Promise<Machine> | undefined;
        let stopping: Promise<PrepareStoppedError> | undefined;
        const warn = (what: string) => (e: unknown) => console.warn(`${what}: ${e instanceof Error ? e.message : String(e)}`);
        const stop = async (): Promise<PrepareStoppedError> => {
          // A create still in flight lands first: a stop that gave up sooner would leak the machine it returns.
          await creating?.catch(() => {});
          if (mine === undefined) return new PrepareStoppedError();
          const id = mine.record.id;
          if (mine === same) {
            delete mine.record.heldBy;
            mine.life = "reusable";
            await store.put(BUILDERS, id, mine.record).catch(warn(`hold on builder ${id} not released; it ages out in ${HELD_TTL_MS / 60_000} minutes`));
            return new PrepareStoppedError(id, { kept: true });
          }
          try {
            await killUntilGone(at, mine.builder.machine, opts.killConfirm);
          } catch (e) {
            return new PrepareStoppedError(id, { left: e instanceof Error ? e.message : String(e) });
          }
          await ctx.forgetBuilder(id).catch(warn(`record of builder ${id} not dropped; the machine is gone and the next load drops it`));
          return new PrepareStoppedError(id);
        };
        let wake: () => void = () => {};
        const stopped = new Promise<void>(r => {
          wake = r;
        });
        const onAbort = (): void => {
          stopping ??= stop().finally(wake);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        // Once a stop has begun its word is the answer, whatever the work did meanwhile: the work runs on against a
        // machine that is going or released, and neither its result nor its rejection reaches the caller.
        const raced = async <T>(work: Promise<T>): Promise<T> => {
          await Promise.race([work.then(() => {}, () => {}), stopped]);
          if (stopping !== undefined) throw await stopping;
          return work;
        };
        const attach = async (same: LiveBuilder, ledger: GoldenImport): Promise<GoldenBuilderView> => {
          try {
            stage("creating", ALREADY_APPLIED);
            stage("deploying-daemon", ALREADY_APPLIED);
            const applied = await applyGoldenImport(same.builder.machine, { import: ledger, setup: recipe.setup, ...(same.record.import !== undefined ? { ledger: same.record.import } : {}), onStage: stage });
            // A complete ledger only re-imports the volatile files, and that never fails the apply, so this no-op is what
            // proves the machine outlived the earlier process.
            const alive = await same.builder.machine.exec("true");
            if (alive.exitCode !== 0) throw new Error(`the builder answered exit ${alive.exitCode} to a no-op; it is not serving`);
            // A stop that came while the apply ran released the hold; nothing here takes it back.
            if (stopping !== undefined) throw await stopping;
            same.record.import = applied.ledger;
            same.life = "own";
            same.recipe = recipe;
            await ctx.hold(same);
          } catch (e) {
            if (stopping !== undefined) throw e;
            // Same road as a fresh builder that fails its stages: the machine goes, the person starts over.
            let detail = e instanceof Error ? e.message : String(e);
            await killUntilGone(at, same.builder.machine, opts.killConfirm).catch((k: unknown) => {
              detail += `; ${k instanceof Error ? k.message : String(k)}`;
            });
            await ctx.forgetIfGone(same, at);
            stage("failed", detail);
            throw e;
          }
          stage("ready");
          return ctx.builderView(same.record, same);
        };
        const fresh = async (): Promise<GoldenBuilderView> => {
          let builder: Builder;
          try {
            builder = await prepareBuilder({
              backend: ctx.recordingCreates(b, name, imp, p => (mine = p), { signal, began: c => (creating = c) }, place),
              ...size,
              ...(o?.kind !== undefined ? { kind: o.kind } : {}),
              ...(deployDaemon !== undefined ? { deployDaemon } : {}),
              ...(imp !== undefined ? { import: imp } : {}),
              labels: ctx.builderLabels(recipe.labels),
              onStage: stage,
            });
          } catch (e) {
            // prepareBuilder tried to kill the machine on its way out; the placeholder goes only where it is gone. After a stop the record is the stop's.
            if (mine !== undefined && stopping === undefined) await ctx.forgetIfGone(mine, at);
            throw e;
          }
          // A last exec that outran the kill must not leave a finished record for a machine the stop is killing.
          if (stopping !== undefined) throw await stopping;
          const entry = await ctx.settleBuilder(name, builder, mine, place);
          entry.recipe = recipe;
          return ctx.builderView(entry.record, entry);
        };
        try {
          if (same && imp) {
            mine = same;
            return await raced(attach(same, imp));
          }
          return await raced(fresh());
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      }, at).finally(() => preparing.delete(preparingKey));
      preparing.set(preparingKey, { hash: imp?.recipeHash, promise: run });
      return run;
    },

    async seal(builderId, o) {
      await ctx.ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      ctx.refuseUntouchable(entry);
      // A builder built from a recipe is what an update can land on; a bare one has no recipe to diff.
      return ctx.sealEntry(entry, o?.keepBuilder !== false && entry.record.import?.recipe !== undefined, o?.logins);
    },

    async recipe(name) {
      await ctx.ready();
      const key = name ?? "default";
      const place = await ctx.imagePlace(key);
      const manifest = await ctx.copyOf(place, key);
      if (manifest === undefined) return undefined;
      return ctx.copyRecipeOf(place, key, manifest.head);
    },

    async upgrade(o) {
      await ctx.ready();
      const recipe = ctx.recipeOrThrow(o.recipe);
      const name = o.name ?? "default";
      // The update lands where the image's own seal stands, on that place's backend.
      const place = await ctx.imagePlace(name);
      const prior = await ctx.copyOf(place, name);
      const head = goldenHead(prior);
      if (head === undefined) throw new Error(`no golden named "${name}" to update; wsp init builds one`);
      const at = ctx.backendAt(place);
      const stage = ctx.stageOf(name, place);
      // The head's digest, whose pins the rows the delta leaves alone keep on the next version's record.
      const previousRecipe = await ctx.copyRecipeOf(place, name, head.version);
      // Past its window a kept builder is never used, running or not: it is stopped here and the update forks; one
      // the pass could not stop is named so the person knows it still bills. Inside the window, it is suspended for
      // the update's length: the record loses `sealed` and gains `building` before the first exec, so neither the
      // timer nor a sweep stops the machine mid-stage, and a process that dies here leaves a record the next one
      // stops as unfinished; the seal re-arms the window.
      const swept = await ctx.expireGrace();
      for (const f of swept.failed) stage("creating", `an earlier kept builder ${f.id}: ${f.message}`);
      await ctx.refreshBuilders();
      const kept = [...builders.values()].find(x => (x.life === "own" || x.life === "reusable") && x.record.name === name && (x.record.place ?? places.wired) === place && x.record.sealed?.version === head.version && ctx.inWindow(x.record.sealed.at));
      let entry: LiveBuilder | undefined;
      if (kept !== undefined) {
        ctx.graceTimers.get(kept.record.id)?.();
        ctx.graceTimers.delete(kept.record.id);
        delete kept.record.sealed;
        kept.record.building = true;
        await store.put(BUILDERS, kept.record.id, kept.record);
        const alive = await kept.builder.machine.exec("true").then(r => r.exitCode === 0, () => false);
        if (!alive) {
          // A machine that does not answer may still bill: it is killed until the provider says gone, then forgotten.
          await killUntilGone(at, kept.builder.machine, opts.killConfirm);
          await ctx.forgetBuilder(kept.record.id);
        } else {
          stage("creating", `your builder from v${head.version}, kept since the save`);
          try {
            const applied = await applyDelta(kept.builder.machine, o.delta, { setup: recipe.setup, previousSmoke: head.smoke.cmd, previousBase: head.base, ...(head.missingTools !== undefined ? { previousMissing: head.missingTools } : {}), ...(head.leftBehind !== undefined ? { previousLeftBehind: head.leftBehind } : {}), ...(previousRecipe !== undefined ? { previousRecipe } : {}), onStage: stage });
            const setupSha = nextSetupSha(head.setupSha, recipe.setup, o.delta.import);
            kept.record.import = applied.ledger;
            kept.record.setupSha = setupSha;
            delete kept.record.building;
            // The builder was sealed as the head, so the version it seals next descends from the head's snapshot.
            kept.builder = { ...kept.builder, import: applied.ledger, setupSha, parentSnapshotId: head.snapshotId, retired: o.delta.retiredOnImage };
            kept.life = "own";
            await ctx.hold(kept);
          } catch (e) {
            // Same road as a fresh builder that fails its stages: the machine goes, the golden stays as it was.
            let detail = e instanceof Error ? e.message : String(e);
            await killUntilGone(at, kept.builder.machine, opts.killConfirm).catch((k: unknown) => {
              detail += `; ${k instanceof Error ? k.message : String(k)}`;
            });
            await ctx.forgetIfGone(kept, at);
            stage("failed", detail);
            throw e;
          }
          stage("ready");
          entry = kept;
        }
      }
      const road = entry !== undefined ? "builder" : "fork";
      entry ??= await ctx.claiming(
        `builder/${name}`,
        async b => {
          let placeholder: LiveBuilder | undefined;
          let builder: Builder;
          try {
            builder = await upgradeBuilder({
              backend: ctx.recordingCreates(b, name, o.delta.import, p => (placeholder = p), undefined, place),
            head,
            delta: o.delta,
              setup: recipe.setup,
              ...(previousRecipe !== undefined ? { previousRecipe } : {}),
              ...(recipe.cpu !== undefined ? { cpu: recipe.cpu } : {}),
              ...(recipe.memMb !== undefined ? { memMb: recipe.memMb } : {}),
              ...(recipe.envs !== undefined ? { envs: recipe.envs } : {}),
              labels: ctx.builderLabels(recipe.labels),
              onStage: stage,
            });
          } catch (e) {
            // upgradeBuilder tried the kill on its way out; the placeholder goes only where the machine is gone.
            if (placeholder !== undefined) await ctx.forgetIfGone(placeholder, at);
            throw e;
          }
          return ctx.settleBuilder(name, builder, placeholder, place);
        },
        at,
      );
      entry.recipe = recipe;
      // The update keeps the golden's disk, so what was signed in stays signed in: the caller passes the previous
      // version's outcomes, with the rows it re-imported as copies rewritten.
      const sealed = await ctx.sealEntry(entry, true, o.logins);
      let manifest = sealed.manifest;
      let previousDropped = false;
      let builderKept = sealed.builderKept;
      // A version with workspaces still on it stays for them: a rebuild boots them from its image, which the provider
      // would delete under a template's forks (they hold no dependency on it).
      const standing = ctx.forkedFrom(head.snapshotId);
      if (o.keepPrevious === false) {
        if (standing.length > 0) {
          console.warn(`golden ${name} v${head.version} kept: ${standing.join(", ")} still on it`);
        } else {
          // A snapshot with live forks under it cannot be deleted (409 on Solari): the builder forked from it goes
          // first, window or not.
          if (road === "fork" && builderKept) {
            ctx.graceTimers.get(entry.record.id)?.();
            ctx.graceTimers.delete(entry.record.id);
            await killUntilGone(at, entry.builder.machine, opts.killConfirm);
            await ctx.forgetBuilder(entry.record.id);
            builderKept = false;
          }
          try {
            await ctx.dropImage(head, at);
            manifest = { ...manifest, versions: manifest.versions.filter(v => v.version !== head.version) };
            await ctx.putCopy(place, name, manifest);
            await ctx.dropCopyRecipe(place, name, head.version);
            previousDropped = true;
          } catch (e) {
            console.warn(`golden ${name} v${head.version} kept: its snapshot was not deleted (${e instanceof Error ? e.message : String(e)})`);
          }
        }
      }
      return { manifest, version: sealed.version, road, previousDropped, builderKept };
    },


    async builderReach(builderId) {
      await ctx.ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      ctx.refuseUntouchable(entry);
      const reach = await refreshPreviewToken(entry.builder.machine, DAEMON_PORT, entry.reach);
      entry.reach = reach;
      const daemonToken = await ctx.daemonTokenOf(entry.builder.machine);
      return { url: reach.url, expiresAt: reach.expiresAt, ...(daemonToken !== undefined ? { daemonToken } : {}) };
    },

    async builders() {
      await ctx.ready();
      return [...builders.values()].map(b => ctx.builderView(b.record, b));
    },

    async kill(builderId) {
      await ctx.ready();
      await ctx.refreshBuilders();
      const entry = builders.get(builderId);
      // A machine of this setup no builder record claims: a seal's smoke fork whose rollback could not reach the
      // provider. Only this state file's own builder or smoke fork is taken, by the labels the create stamped, so
      // neither another host's machine nor a workspace of this one is ever killed here; a provider that cannot be
      // read keeps its own reason, which is what a caller retrying reads.
      if (!entry) {
        const machine = await backend.get(builderId).catch((e: unknown) => {
          if (isMissing(e)) return undefined;
          throw e;
        });
        const labels = machine?.labels;
        const mine = labels?.[OWNER_LABEL] === ctx.state.owner && (labels[BUILDER_LABEL] === "1" || labels[SMOKE_LABEL] === "1");
        if (!mine || machine === undefined) throw new Error(`no such builder: ${builderId}`);
        await killUntilGone(backend, machine, opts.killConfirm);
        return;
      }
      // A record its dead holder left mid-setup is stopped here as the sweep would stop it; only seal and reach need finished stages.
      if (entry.life === "foreign" || entry.life === "held") ctx.refuseUntouchable(entry);
      await killUntilGone(backend, entry.builder.machine, opts.killConfirm);
      await ctx.forgetBuilder(builderId);
    },

    async storage() {
      await ctx.ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      return snapshotStorage(await backend.listSnapshots(), backend.pricing.snapshotStorage, { hostId: ctx.imageMark(), recorded: await ctx.recordedImages(), now: clock.now() });
    },

    async orphans() {
      await ctx.ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      const read = { hostId: ctx.imageMark(), recorded: await ctx.recordedImages(), now: clock.now() };
      const rows = await backend.listSnapshots();
      const snapshots = splitByOwner(rows, read);
      const templates = templatesOf(backend);
      const listed = templates === undefined ? [] : await templates.list();
      const promoted = splitByOwner(listed, read);
      const bytesOf = (part: readonly SnapshotRow[]): number => part.reduce((n, r) => n + r.sizeBytes, 0);
      const totalBytes = bytesOf(rows);
      const freedBytes = bytesOf(snapshots.orphans);
      const pricing = backend.pricing.snapshotStorage;
      return {
        snapshots: snapshots.orphans,
        templates: promoted.orphans,
        freedBytes,
        savesUsdPerMonth: snapshotMonthlyUsd(totalBytes, pricing) - snapshotMonthlyUsd(totalBytes - freedBytes, pricing),
        others: { snapshots: snapshots.foreign, templates: promoted.foreign },
      };
    },

    async deleteOrphans() {
      const plan = await golden.orphans();
      if (plan === undefined) return undefined;
      const deleted: OrphansDeleted = { snapshots: [], templates: [], failed: [] };
      // The plan names templates only on a backend that has them, so the road exists wherever the loop runs.
      const templates = templatesOf(backend);
      const named = (row: SnapshotRow | TemplateRow): { id: string; name?: string } => ({ id: row.id, ...(row.name !== undefined ? { name: row.name } : {}) });
      if (templates !== undefined) {
        for (const t of plan.templates) {
          try {
            await templates.delete(t.id);
            deleted.templates.push(t);
          } catch (e) {
            deleted.failed.push({ ...named(t), message: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      for (const row of plan.snapshots) {
        try {
          await backend.deleteSnapshot(row.id);
          deleted.snapshots.push(row);
        } catch (e) {
          // A snapshot the provider already lost is gone either way, which is what the caller asked for.
          if (isMissing(e)) {
            deleted.snapshots.push(row);
            continue;
          }
          deleted.failed.push({ ...named(row), message: e instanceof Error ? e.message : String(e) });
        }
      }
      return deleted;
    },

    async retention(name) {
      await ctx.ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      const manifest = await ctx.copyOf(places.wired, name ?? "default");
      if (manifest === undefined) return undefined;
      return retentionPlan(manifest, await backend.listSnapshots(), ctx.forkedFrom, backend.pricing.snapshotStorage);
    },

    async prune(name) {
      const key = name ?? "default";
      const plan = await golden.retention(key);
      const dropped: GoldenVersion[] = [];
      const failed: { version: number; message: string }[] = [];
      if (plan === undefined) return { dropped, failed };
      for (const v of plan.drop) {
        try {
          await ctx.dropImage(v);
        } catch (e) {
          // A snapshot the provider already lost is gone either way; its version goes with it.
          if (!isMissing(e)) {
            failed.push({ version: v.version, message: e instanceof Error ? e.message : String(e) });
            continue;
          }
        }
        const manifest = (await ctx.copyOf(places.wired, key))!;
        await ctx.putCopy(places.wired, key, { ...manifest, versions: manifest.versions.filter(x => x.version !== v.version) });
        await ctx.dropCopyRecipe(places.wired, key, v.version);
        dropped.push(v);
      }
      return { dropped, failed };
    },

    async rollback(version, name) {
      const key = name ?? "default";
      const missing = (message: string) => Object.assign(new Error(message), { kind: "missing" });
      const prior = await ctx.copyOf(places.wired, key);
      if (!prior) throw missing(`no golden named "${key}"`);
      let next: GoldenManifest;
      try {
        next = rollbackGolden(prior, version);
      } catch (e) {
        throw missing(e instanceof Error ? e.message : String(e));
      }
      await ctx.putCopy(places.wired, key, next);
      return next;
    },

    async promote(name) {
      await ctx.ready();
      const templates = templatesOf(backend);
      if (templates === undefined) return undefined;
      const key = name ?? "default";
      const manifest = await ctx.copyOf(places.wired, key);
      const rows: GoldenPromotion[] = [];
      for (const v of manifest?.versions ?? []) {
        if (v.templateId !== undefined) continue;
        try {
          const { templateId, sharing } = await promoteVersion(templates, v.snapshotId, goldenName(ctx.imageMark(), key, v.version));
          const current = await ctx.copyOf(places.wired, key);
          if (current === undefined) throw new Error(`golden ${key} was dropped while its versions were being promoted`);
          await ctx.putCopy(places.wired, key, { ...current, versions: current.versions.map(x => (x.version === v.version ? { ...x, templateId } : x)) });
          rows.push({ golden: key, version: v.version, templateId, ...(sharing !== undefined ? { sharing } : {}) });
        } catch (e) {
          rows.push({ golden: key, version: v.version, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return rows;
    },

    async projects() {
      await ctx.ready();
      return (await store.list(PROJECT_GOLDENS)).map(ctx.projectGoldenOf).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async removeProject(snapshotId) {
      await ctx.ready();
      const stored = await store.get(PROJECT_GOLDENS, snapshotId);
      if (stored === undefined) throw notFoundRefusal(noProjectImageLine(snapshotId));
      const projectGolden = ctx.projectGoldenOf(stored);
      const standing = ctx.forkedFrom(snapshotId);
      if (standing.length > 0) throw ctx.conflict(projectImageInUseRefusal(snapshotId, standing));
      const at = ctx.backendAt(projectGolden.place ?? places.wired);
      const read = await snapshotUntilGone(at, snapshotId, opts.killConfirm).catch((e: unknown) => {
        const { kind, status } = e as { kind?: unknown; status?: unknown };
        throw Object.assign(new Error(projectImageRefusedLine(snapshotId, answerOf(e))), kind !== undefined ? { kind } : {}, status !== undefined ? { status } : {});
      });
      if (read.verdict === "listed") throw new Error(projectImageStillListedLine(snapshotId, read.graceMs));
      await store.delete(PROJECT_GOLDENS, snapshotId);
      return { projectGolden, alreadyGone: read.verdict === "missing" };
    },

  };
  return { golden };
}

function imageArea(ctx: RuntimeContext): ImageArea {
  const {
    opts, store, placeDoor, builders, copyBuilds, copyRows, rowSaysFailure, placeAway, frameStopped, places,
  } = ctx;
  /** The sizes a place's provider reports the snapshots named restore to, keyed by id; empty where it has no listing
   * or would not answer, and none for a snapshot it reports only the stored size of, since a size nobody read is left
   * absent rather than guessed. */
  const snapshotSizes = async (at: MachineBackend, ids: readonly string[]): Promise<Map<string, number>> => {
    if (ids.length === 0 || !at.capabilities.snapshotListing || at.listSnapshots === undefined) return new Map();
    const rows = await at.listSnapshots().catch(() => []);
    return new Map(rows.flatMap(r => (ids.includes(r.id) && r.restoredBytes !== undefined ? [[r.id, r.restoredBytes] as const] : [])));
  };

  /** The copy each place holds of this golden, newest version per place, with the record's hash it was built at. */
  const copiesOf = async (name: string): Promise<SealedImageCopy[]> => {
    const rows: { place: string; head: GoldenVersion }[] = [];
    for (const key of await store.keys(GOLDENS)) {
      const parts = copyKeyParts(key);
      if (parts.name !== name) continue;
      const head = goldenHead((await store.get(GOLDENS, key)) as GoldenManifest | undefined);
      if (head !== undefined) rows.push({ place: parts.place ?? places.wired, head });
    }
    const copies: SealedImageCopy[] = [];
    for (const { place, head } of rows) {
      const at = places.backend(place) ?? placeDoor?.backendOf(place);
      const sizes = at === undefined ? new Map<string, number>() : await snapshotSizes(at, [head.snapshotId]);
      copies.push({
        place,
        version: head.version,
        ...(head.imageHash !== undefined ? { hash: head.imageHash } : {}),
        snapshotId: head.snapshotId,
        ...(head.templateId !== undefined ? { templateId: head.templateId } : {}),
        builtAt: head.createdAt,
        ...(sizes.has(head.snapshotId) ? { sizeBytes: sizes.get(head.snapshotId)! } : {}),
      });
    }
    return copies.sort((a, b) => (a.place === places.wired ? -1 : b.place === places.wired ? 1 : a.place.localeCompare(b.place)));
  };

  const conflict = (message: string): Error => Object.assign(new Error(message), { kind: "conflict" });

  /** Every project golden, oldest first, with its size off the listing of the place each record names: one listing
   * per place, and none for a place this host no longer holds. */
  const projectImagesSized = async (): Promise<SealedProjectImage[]> => {
    const projects = await ctx.golden.projects();
    const sizes = new Map<string, number>();
    for (const place of new Set(projects.map(p => p.place ?? places.wired))) {
      let at: MachineBackend;
      try {
        at = ctx.backendAt(place);
      } catch {
        continue;
      }
      for (const [id, bytes] of await snapshotSizes(at, projects.filter(p => (p.place ?? places.wired) === place).map(p => p.snapshotId))) sizes.set(id, bytes);
    }
    return projects.map(p => (sizes.has(p.snapshotId) ? { ...p, sizeBytes: sizes.get(p.snapshotId)! } : p));
  };

  const image: Runtime["image"] = {
    async get(name) {
      await ctx.ready();
      const key = name ?? "default";
      return {
        image: (await ctx.recordOf(key)) ?? null,
        copies: await copiesOf(key),
        projects: await projectImagesSized(),
      };
    },

    async vault(name) {
      await ctx.ready();
      const key = name ?? "default";
      const record = await ctx.recordOf(key);
      if (record === undefined) throw conflict(`this host owns no image named ${key} yet; wsp init seals one`);
      if (record.vault === undefined) throw conflict(`${key} v${record.version} was sealed before its sign-ins were held, so there is nothing to export; cut the next version to hold them`);
      const tar = await store.getBlob(IMAGE_VAULTS, vaultKey(key, record.version));
      if (tar === undefined) throw conflict(`the vault of ${key} v${record.version} is not on this computer any more; cut the next version to take it again`);
      return { image: record, tar };
    },

    async build(o) {
      await ctx.ready();
      const name = o.name ?? "default";
      const { place, at } = await ctx.placeAt(o.place);
      const where = ctx.placeName(place);
      if (!buildsImages(at.capabilities)) throw refusal(placeBuildsNoImageLine(where), COPY_BUILD_FIX.noCopy, "conflict");
      const record = await ctx.recordOf(name);
      if (record === undefined) throw refusal(`this host owns no image named ${name} yet`, COPY_BUILD_FIX.noImage, "conflict");
      if (record.recipe === undefined) throw refusal(`${name} v${record.version} was sealed before the image record kept the recipe it was built from, so no other place can build it`, COPY_BUILD_FIX.noRecipe, "conflict");
      if (copyAsksSignIns(record) && o.force !== true) {
        throw refusal(`${name} v${record.version} holds no sign-ins, so a copy at ${where} would ask for every one of them again`, COPY_BUILD_FIX.noVault, "conflict");
      }
      const held = goldenHead(await ctx.copyOf(place, name));
      // The same rule the line under Settings > Image reads, so a copy is never current in one place and stale in
      // the other. A place already standing on the record is answered with what it holds: a fork there asks this
      // before it builds, and a second ask must cost nothing.
      if (held !== undefined && copyIsCurrent(record, { hash: held.imageHash })) {
        const standing = (await copiesOf(name)).find(c => c.place === place);
        if (standing === undefined) throw new Error(`${where} holds ${name} v${held.version} and no copy of it was recorded there`);
        return { copy: standing, built: false };
      }
      // Every refusal above is this call's own, so a second caller is told the same thing about its own `force`
      // rather than inheriting a build it would have refused; what is joined is the build itself.
      const key = copyKey(place, name);
      const running = copyBuilds.get(key);
      o.starting?.();
      if (running !== undefined) return running;
      const run = buildCopy({ place, where, at, name, record, ...(o.signal !== undefined ? { signal: o.signal } : {}) })
        .catch((e: unknown) => {
          // Not every road out of a build frames its failure, and a building frame left standing reads building for
          // good on the row and the card and is put back by the computer's next link.
          if (copyRows.get(place)?.stopped === false) frameStopped(place, name, placeAway(place) || isPlaceAbsent(e) ? placeWentAwayLine(where) : e);
          throw e;
        })
        .finally(() => copyBuilds.delete(key));
      copyBuilds.set(key, run);
      return run;
    },

    async keepCurrent(place, name) {
      const key = name ?? "default";
      // A computer that is not connected owes nothing now: a fork there builds its copy. Read before anything is
      // composed or framed, so no row says a build stopped that never started, and read again on a failure, since
      // the link going mid-ask is a laptop sleeping.
      const before = copyRows.get(place);
      try {
        await ctx.ready();
        if ((await ctx.recordOf(key)) === undefined || placeAway(place)) return;
        // A place that builds no copy at all owes none: a provider that forks nothing, a computer that keeps no disk.
        const { at } = await ctx.placeAt(place);
        if (!buildsImages(at.capabilities)) return;
        // A build joined here may have been sealing an older record; the copy it leaves is stamped with the record
        // it was built from, so it reads stale against the record as it stands now and is built once more.
        for (;;) {
          const built = await image.build({ place, name: key });
          const record = await ctx.recordOf(key);
          if (record === undefined || copyIsCurrent(record, built.copy)) return;
        }
      } catch (e) {
        // A build that already framed its stop has said it; a refusal before any build is said here, and stands
        // until the next build there takes the row over.
        const now = copyRows.get(place);
        if (now !== before && now?.stopped === true) return;
        if (rowSaysFailure(place, e)) frameStopped(place, key, e);
      }
    },
  };

  /** One copy built at one place: the record's vault landed on a fresh builder there and sealed under the record's
   * hash. Called once every refusal has passed and only while no build for the same place and name is in flight. */
  const buildCopy = async (o: { place: string; where: string; at: MachineBackend; name: string; record: SealedImage; signal?: AbortSignal }): Promise<SealedImageBuilt> => {
    const { place, where, at, name, record } = o;
    // Read before the blob and before a builder is asked for: a record with no path list cannot have its archive
    // judged anywhere, and an archive carrying a member the seal never asked for boots nothing here.
    if (record.vault !== undefined && record.vault.held === undefined) throw conflict(vaultUnlistedRefusal(name, record.version));
    const tar = record.vault === undefined ? undefined : await store.getBlob(IMAGE_VAULTS, vaultKey(name, record.version));
    if (record.vault !== undefined && tar === undefined) throw conflict(`the vault of ${name} v${record.version} is not on this computer any more; cut the next version to take it again`);
    if (tar !== undefined && record.vault?.held !== undefined) {
      try {
        refuseForeignMembers("import", tar, record.vault.held);
      } catch (e) {
        throw conflict(e instanceof Error ? e.message : String(e));
      }
    }
    const recipe = await ctx.copyRecipeOrThrow()(record);
    const view = await ctx.golden.prepare({ name, place, copy: true, recipe, ...(o.signal !== undefined ? { signal: o.signal } : {}) });
    const entry = builders.get(view.id);
    if (entry === undefined) throw new Error(`the builder ${view.id} prepared at ${where} left no record here; nothing was sealed`);
    const stage = ctx.stageOf(name, place, true);
    try {
      // The person's sign-ins land before the seal and after everything the recipe installs, so the copy holds
      // what the builder at the wired place held and no sign-in is run here.
      if (tar !== undefined) {
        stage("uploading-files", `the image's sign-ins, ${fmtBytes(tar.length)}`);
        await importImageVault(entry.builder.machine, tar);
      }
    } catch (e) {
      await killUntilGone(at, entry.builder.machine, opts.killConfirm).catch(() => {});
      await ctx.forgetIfGone(entry, at);
      stage("failed", e instanceof Error ? e.message : String(e));
      throw e;
    }
    const sealed = await ctx.sealEntry(entry, false, record.logins, record);
    const copy = (await copiesOf(name)).find(c => c.place === place);
    if (copy === undefined) throw new Error(`${where} sealed ${name} v${sealed.version.version} and no copy of it was recorded there`);
    return { copy, built: true };
  };

  /** The image whose head, at the place its own seal stands, is this snapshot: the one a fork's copy is looked up by.
   * Nothing for a project golden or a version that is no longer the head. */
  const imageHeadNamed = async (snapshotId: string): Promise<string | undefined> => {
    for (const raw of await store.list(IMAGES)) {
      const image = raw as SealedImage;
      if (goldenHead(await ctx.copyOf(image.place ?? places.wired, image.name))?.snapshotId === snapshotId) return image.name;
    }
    return undefined;
  };

  /** The snapshot a fork names at the place it lands on. A place that is not the image's own forks its own copy: the
   * one a build running there seals, which the create waits for, or the one standing there on the record. A caller
   * that can say so before anything bills has a place holding no current copy build one first, through the same
   * build a press starts; everywhere else the snapshot asked for goes through as it is. */
  const copyForFork = async (golden: string, placeId: string | undefined, announce?: (where: string, rateUsdPerHour: number) => void): Promise<string> => {
    const place = placeId ?? places.wired;
    const name = await imageHeadNamed(golden);
    if (name === undefined || place === (await ctx.imagePlace(name))) return golden;
    if (announce === undefined) {
      const built = await copyBuilds.get(copyKey(place, name))?.catch(() => undefined);
      if (built !== undefined) return built.copy.snapshotId;
    }
    const record = await ctx.recordOf(name);
    if (record === undefined) return golden;
    const held = goldenHead(await ctx.copyOf(place, name));
    if (held !== undefined && copyIsCurrent(record, { hash: held.imageHash })) return held.snapshotId;
    if (announce === undefined) return golden;
    const { at } = await ctx.placeAt(place);
    if (!buildsImages(at.capabilities)) return golden;
    const starting = (): void => announce(ctx.placeName(place), at.pricing.rateUsdPerHour(at.pricing.defaultSize));
    return (await image.build({ place, name, starting })).copy.snapshotId;
  };
  return { conflict, image, copyForFork };
}

function projectsArea(ctx: RuntimeContext): ProjectsArea {
  const { opts, store, adapters, local, bus, clock, live, projectsHeld, gone } = ctx;
  /** The import road onto a fork: the plan, what was consented, the pack, the upload in parts, the landing at the
   * path and the agents' state keyed to it there. */
  const copyImport = async (entry: LiveWorkspace, o: ProjectImportOptions, report: ImportReport): Promise<ImportLanded> => {
    const plan = await o.bundler.plan();
    report("planned", `${plural(plan.files, "file")}, ${fmtBytes(plan.bytes)}${plan.repo ? " and the repository" : ""}; ${plural(plan.secrets.length, "secret-shaped file")}; ${plural(plan.excluded.length, "cache")} left behind.`);
    const carry = new Set(o.carry ?? []);
    const rewrite = new Set(o.rewrite ?? []);
    const rewriting = plan.secrets.flatMap(s => (s.rewrite !== undefined && rewrite.has(s.path) ? [{ path: s.path, ...s.rewrite }] : []));
    const rewritten = new Set(rewriting.map(r => r.path));
    const carried = plan.secrets.filter(s => carry.has(s.path) && !rewritten.has(s.path)).map(s => s.path);
    const cut = plan.secrets.filter(s => !carry.has(s.path) && !rewritten.has(s.path)).map(s => s.path);
    const clauses = [
      ...(carried.length > 0 ? [`carrying ${carried.join(", ")}`] : []),
      ...(rewriting.length > 0 ? [`rewriting ${rewriting.map(r => `${r.path}${r.urls.length > 0 ? ` to ${r.urls.join(", ")}` : ""}${r.drop.length > 0 ? ` without ${r.drop.join(", ")}` : ""}`).join(", ")}`] : []),
      ...(carried.length === 0 && rewriting.length === 0 ? ["no secret-shaped file travels"] : []),
      cut.length === 0 ? "nothing cut" : `cut ${cut.join(", ")}`,
    ].join("; ");
    const named = new Set(o.agents ?? []);
    const readable = plan.agents.filter(a => a.error === undefined);
    const unreadable = plan.agents.filter(a => a.error !== undefined);
    const travelling = readable.filter(a => named.has(a.agent));
    const staying = readable.filter(a => !named.has(a.agent));
    const withCount = (a: ProjectPlan["agents"][number]): string => `${a.name} (${plural(a.sessions, "session")})`;
    const notes = [
      ...(plan.agents.length === 0 ? [] : travelling.length === 0 ? ["No agent sessions travel"] : [`Sessions travel for ${travelling.map(withCount).join(", ")}`]),
      ...(travelling.length > 0 && staying.length > 0 ? [`${staying.map(a => a.name).join(", ")} ${staying.length === 1 ? "stays" : "stay"}`] : []),
      ...unreadable.map(a => `${a.name} could not be read (${a.error})`),
    ];
    const agentsLine = notes.length === 0 ? "" : ` ${notes.join("; ")}.`;
    report("consented", `${plan.secrets.length === 0 ? "No secret-shaped files." : `${clauses.charAt(0).toUpperCase()}${clauses.slice(1)}.`}${agentsLine}`);
    report("packing", `Packing ${plural(plan.files - cut.length, "file")}.`);
    const packed = await o.bundler.pack(carry, rewrite);
    let state: PackedState | undefined;
    if (travelling.length > 0) {
      const present = await agentsOnMachine(entry.machine, travelling.map(a => a.agent));
      const homes = guestAgentHomes();
      state = await o.bundler.packState({
        dest: o.dest,
        agents: travelling.map(a => {
          const home = homes[a.agent];
          if (home === undefined) throw new Error(`${a.agent} is not an agent the catalog knows`);
          return { agent: a.agent, home, present: present.has(a.agent) };
        }),
      });
    }
    report("uploading", `Uploading ${fmtBytes(packed.tar.length)}.`, { bytes: 0, total: packed.tar.length });
    const { parts } = await landBundle(entry.machine, packed.tar, o.dest, {
      ...(o.replace !== undefined ? { replace: o.replace } : {}),
      tmpDir: ctx.moduleOf(entry.record.kind).scratch(entry),
      timeoutMs: 600_000,
      onPart: p => report("uploading", `Part ${p.part} of ${p.parts}, ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}.`, { bytes: p.bytes, total: p.total }),
      onLanding: () => report("landing", `Landing at ${o.dest}.`),
    });
    const nameOf = (id: string): string => plan.agents.find(a => a.agent === id)?.name ?? id;
    const agents = [...(state?.agents ?? [])];
    const outcomes = (): string => agents.map(a => `${nameOf(a.agent)} ${outcomeWords(a)}`).join(", ");
    if (state !== undefined && (agents.some(a => a.files > 0) || state.merges.length > 0)) {
      const files = agents.reduce((n, a) => n + a.files, 0);
      const what = [...(files > 0 ? [plural(files, "session file")] : []), ...(state.merges.length > 0 ? ["the rows to merge"] : [])].join(" and ");
      report("uploading", `Uploading ${what}, ${fmtBytes(state.tar.length)}.`, { bytes: 0, total: state.tar.length });
      await importInto(entry.machine, state.tar, "/", {
        overlay: true,
        tmpDir: ctx.moduleOf(entry.record.kind).scratch(entry),
        timeoutMs: 600_000,
        onPart: p => report("uploading", `Part ${p.part} of ${p.parts}, ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}.`, { bytes: p.bytes, total: p.total }),
      });
      if (state.merges.length > 0) {
        report("landing", `Merging rows into ${state.merges.map(m => nameOf(m.agent)).join(", ")}.`);
        for (const m of state.merges) {
          const at = agents.findIndex(a => a.agent === m.agent);
          if (at >= 0) agents[at] = await mergeOnMachine(entry.machine, m.script, agents[at]!);
        }
      }
      report("landing", `Landing sessions: ${outcomes()}.`);
    }
    return {
      result: { dest: o.dest, files: packed.files, bytes: packed.bytes, parts, cut: packed.cut, rewritten: packed.rewritten, agents, project: ctx.projectOf(o.dest, packed.bytes) },
      done: `${plural(packed.files, "file")}, ${fmtBytes(packed.bytes)}, landed at ${o.dest}${parts > 1 ? ` in ${parts} parts` : ""}${agents.length > 0 ? `; sessions: ${outcomes()}` : ""}.`,
    };
  };

  /** The seed half of an add, which the host wires because it reads a folder of the person's: a runtime without it
   * records a folder as a project on this computer and clones a repo anywhere else, and a folder seeding another
   * computer is refused rather than sent unread. */
  const seedWiring = (): SeedWiring => {
    if (opts.seed === undefined) throw new Error(NO_SEED_WIRING);
    return opts.seed;
  };

  /** Which landing road a computer takes, off what the computer is rather than off its id: the computer the app
   * runs on copies the folder beside itself, a computer whose daemon says where it keeps checkouts clones onto
   * that disk, and everything else is a provider, where a project lives in an image. */
  const landingKind = (computer: string, at: MachineBackend | undefined): ProjectLanding["kind"] =>
    copiesFolder(kindForComputer(computer)) ? "mac" : at?.projects !== undefined ? "box" : "provider";

  /** What a landing road may ask of this runtime, for one computer: a short-lived machine of that computer's image
   * to clone, seed and install in, the road that puts the seed archive on it, the snapshot a project image is, and
   * where that computer and this Mac keep what a project needs. */
  const landingDeps = async (computer: string): Promise<{ deps: LandingDeps; at: MachineBackend | undefined; placeId: string | undefined }> => {
    const { placeId } = await ctx.landingPlace(computer);
    // A computer this host cannot read a backend for holds nothing of a project: the record still stands, as it
    // did before this road existed, and the road that would have to fork there says so itself when it is asked.
    const at = await ctx.forkingAt(placeId).catch(() => undefined);
    const deps: LandingDeps = {
      async worker(o) {
        const forking = await ctx.landingBackend(placeId);
        // A computer that keeps no image is worked in a copy of its own directories, the same machine a workspace
        // there is; only a provider names an image to fork, and the add read which one once.
        const golden = o.from === "" ? undefined : await ctx.copyForFork(o.from, placeId);
        const spec: MachineSpec = {
          kind: "sandbox",
          ...(golden !== undefined ? { fromSnapshot: golden } : {}),
          // On a computer somebody joined this machine clones and installs with that computer's shared home
          // bound in, as a workspace there does, so it reads the same order and the same knobs; this Mac and the
          // provider this host forks on answer no place and keep the order an image is sealed with.
          envs: { ...loginEnvOn(placeId) },
          // A machine whose disk becomes an image is a builder, which is what keeps the computer's own logins out
          // of it; one that only clones onto the computer is not, since the clone reads those logins.
          labels: { [WSP_LABEL]: "1", [OWNER_LABEL]: ctx.state.owner, [CREATED_AT_LABEL]: new Date().toISOString(), ...(o.image ? { [BUILDER_LABEL]: "1" } : {}) },
          ...(o.binds.length > 0 ? { binds: [...o.binds] } : {}),
          // Nothing waits on a person here: an add that died leaves no machine running for hours.
          onIdle: "kill",
        };
        return forking.create(spec);
      },
      stop: async machine => gone.stop(await ctx.landingBackend(placeId), machine),
      land: async (machine, path, bytes) => void (await landBytes(machine, path, bytes)),
      // A first-life fork of the image: the one snapshot road, the same the project goldens take.
      checkpoint: async (machine, name) => {
        await syncDisk(machine);
        return machine.snapshot(name, { firstLife: true });
      },
      scratch: () => GUEST_TMP,
      ...(at?.projects !== undefined ? { projectsDir: at.projects } : {}),
      // One command on the computer itself, where that computer runs any: how the folder wsp keeps for a project
      // there is taken away again. A provider answers none, and this Mac's own road runs nothing outside a
      // workspace, so both leave it absent and the roads there never ask.
      ...(at?.onComputer === undefined ? {} : { onComputer: at.onComputer.bind(at) }),
      imageHead: () => ctx.imageHeadOrNone(),
      cloneEnv: (): Record<string, string> => {
        const token = opts.vault?.()[GITHUB_TOKEN_ENV];
        return token === undefined ? {} : { [GITHUB_TOKEN_ENV]: token };
      },
      // Where Claude Code keeps its projects on this computer, which is the memory folder of a project worked in
      // place here; read the way every other road on this computer reads that store.
      macStateHome: local?.home("claude") ?? "",
      // The name this wsp holds for that computer, read the way a fork's own line reads it.
      computerName: ctx.placeName(computer),
      now: () => clock.now(),
    };
    return { deps, at, placeId };
  };

  /** A computer somebody joined that this host cannot reach right now holds nothing of a project: the sentence is
   * that computer's own absent one, said before anything is made or removed. Read apart from the deps above
   * because a computer with no backend at all is what this Mac looks like to a host with no provider key, and a
   * folder here is still a project. */
  const readableComputer = async (at: MachineBackend | undefined, placeId: string | undefined): Promise<void> => {
    if (at === undefined && placeId !== undefined) await ctx.landingBackend(placeId);
  };

  /** Recording, reading and dropping a project, the four acts that keep the projects map and the store together.
   * Named apart from the door below so the create and the landing can resolve a project without reaching through
   * the public object. */
  const projectsDoor = {
    /** What a seed of a folder on this computer would carry, with the ticks a choice remembered for that folder
     * leaves on it. Nothing is read whole and nothing leaves this computer: the menu is git's own listing of what
     * it ignores, one size pass and the agent's memory folder. */
    async seedPlan(source: string): Promise<SeedPlan> {
      await ctx.ready();
      const folder = folderNamed(source);
      const plan = await seedWiring().plan(folder, await ctx.homesHere());
      const remembered = (await store.get(SEED_CHOICES, folder)) as SeedChoice | undefined;
      if (remembered === undefined) return plan;
      return { ...plan, remembered: true, files: plan.files.map(f => ({ ...f, ticked: f.kind !== "never" && remembered.files.includes(f.path) })) };
    },

    async add(o: { source: string; on?: string; name?: string; base?: string; into?: string; seed?: SeedChoice }, origin?: Caller): Promise<ProjectView & { notice?: string }> {
      await ctx.ready();
      // A project is this computer's to record: the folder and the computer named are read here, and a machine
      // that asked would be naming paths on a computer it cannot see.
      ctx.refuseRecording(o.source, origin);
      const rows = await ctx.computerRows();
      const clones = rows.filter(r => r.id !== HERE_PLACE_ID && kindWords(kindForComputer(r.id)).projectSources.includes("git")).map(r => r.name);
      const kind = sourceKind(o.source);
      if (kind === "computer") throw new Error(ADD_IS_A_COMPUTER_LINE);
      if (kind === "folder" && o.into !== undefined) throw new Error(INTO_TAKES_A_REPO_LINE);
      const source: ProjectSource = projectSourceOf(o.source, kind, kind === "folder" ? folderNamed(o.source) : undefined);
      // No --on: a folder is worked here and so is a repo given a folder to clone into; a repo with neither is the
      // person's to place, here or on a computer that clones, which the kind table says are which.
      const computer = o.on === undefined ? (kind === "folder" || o.into !== undefined ? HERE_PLACE_ID : undefined) : (rows.find(r => r.id === o.on || r.name === o.on)?.id ?? undefined);
      if (computer === undefined) {
        if (o.on === undefined) throw new Error(noComputerForSourceLine(o.source, clones));
        throw new Error(noSuchPlaceRefusal(o.on, rows.map(r => r.name)));
      }
      if (o.into !== undefined && computer !== HERE_PLACE_ID) throw new Error(intoIsHereLine(ctx.nameOfComputer(HERE_PLACE_ID, rows)));
      const computerKind = kindForComputer(computer);
      const takes = kindWords(computerKind).projectSources;
      if (!takes.includes(source.kind)) throw new Error(source.kind === "folder" ? folderOnCopyRefusal(ctx.nameOfComputer(computer, rows)) : noComputerForSourceLine(o.source, clones));
      // A repo here is cloned into the folder the person named, and that folder is then the project: every road
      // after the clone is the one a folder of theirs already takes.
      if (source.kind !== "folder" && copiesFolder(computerKind)) {
        if (o.into === undefined) throw new Error(cloneIntoNeeded(o.source));
        const into = await ctx.cloneHere(o.source, source, o.into);
        const { into: _into, on: _on, ...rest } = o;
        return projectsDoor.add({ ...rest, source: into }, origin);
      }
      const held = [...projectsHeld.values()].find(p => p.computer === computer && sameSource(p.source, source));
      if (held !== undefined) throw Object.assign(new Error(sameSourceRefusal(held.name, ctx.nameOfComputer(computer, rows))), { kind: "conflict" });
      // A folder here is a project whether or not git holds it; the repo it sits in, its own or one above it, is
      // what its branches and worktrees are read off.
      const top = source.kind === "folder" && copiesFolder(computerKind) ? await ctx.gitTopOf(source.path) : undefined;
      const { deps, at, placeId } = await landingDeps(computer);
      await readableComputer(at, placeId);
      const road = projectLanding(landingKind(computer, at));
      // What the source resolves to on this computer: the remote whichever computer holds the project will clone,
      // and, for a folder here, the menu of what a seed of it would carry.
      const module = projectSource(source.kind);
      const resolved = await module.resolve(source, {
        // A folder is seeded only onto a computer that clones it; the computer the app runs on copies it beside
        // itself and reads nothing of it but its own remote.
        seeding: road.kind !== "mac",
        seedPlan: folder => projectsDoor.seedPlan(folder),
        folderRemote: folder => ctx.remoteHere(folder),
      });
      // Nothing of the person's folder leaves this computer unasked: a seed onto a computer that clones needs the
      // choice they made off the menu, and the road that copies the folder here seeds nothing at all.
      const seeding = resolved.seed !== undefined && road.kind !== "mac";
      if (seeding && o.seed === undefined) throw Object.assign(new Error(seedChoiceNeeded(source.kind === "folder" ? source.path : o.source)), { kind: "invalid" });
      const name = o.name ?? resolved.name;
      const id = `pr_${randomBytes(4).toString("hex")}`;
      const path = road.path({ name, source });
      // The key the agent's memory sits under, fixed here and never recomputed: the folder's own key where a folder
      // on this computer seeded the project, so the memory it already has is the memory it keeps, else the key of
      // the path on the computer holding it.
      const memoryKey = resolved.seed?.memory?.key ?? claudeProjectKey(source.kind === "folder" ? source.path : path);
      const places = road.places({ project: { id, name, path, source }, memoryKey, deps });
      const project: ProjectView = {
        id,
        name,
        computer,
        source,
        path,
        remote: resolved.remote,
        defaultBranch: resolved.defaultBranch,
        memoryKey,
        memoryDir: places.memoryDir,
        // The branch a workspace of this project starts on: the one they named, and otherwise none, which the
        // clone reads as the remote's own default. The branch a seed's unpushed commits were on is never this: a
        // branch the remote has never seen is nothing a clone can ask for, so those commits land on a branch of
        // their own after the clone and the record stays on the branch the remote has.
        ...(o.base !== undefined ? { base: o.base } : {}),
        ...(top !== undefined ? { git: { top } } : {}),
        createdAt: new Date(clock.now()).toISOString(),
      };
      const began = clock.now();
      const report = (stage: ProjectAddStage, message: string): void => {
        bus.emit({ type: "project.add", projectId: project.id, computer, stage, message, elapsedMs: clock.now() - began });
      };
      // Work runs on the computer when the add has something of the person's to put there, which is a seed: the
      // clone, the files they ticked, the install and, on a provider, the image every workspace of the project
      // forks. A repo the computer can clone by itself is recorded here and cloned by the workspace's own create,
      // which is what it did before this road existed.
      const keep = async (landed: Landed): Promise<ProjectView & { notice?: string }> => {
        // The notice is what the person is told about this add, not a field of the project: the record is written
        // once here with the schema's own fields, so it is taken off before anything is stored or emitted.
        const { notice: _said, ...fields } = landed;
        const recorded: ProjectView = { ...project, ...fields };
        await ctx.rememberProject(recorded);
        // Kept under the folder as this host resolved it, which is the word the next menu is looked up by.
        if (o.seed?.remember === true && source.kind === "folder") await store.put(SEED_CHOICES, source.path, o.seed);
        bus.emit({ type: "project.added", project: recorded });
        return recorded;
      };
      const seed = seeding && resolved.seed !== undefined && o.seed !== undefined ? { plan: resolved.seed, choice: o.seed } : undefined;
      if (!road.landsAtAdd({ seeding: seed !== undefined })) return keep({});
      report("planned", addingProjectLine(project.name, source, seed !== undefined));
      try {
        const packed = seed === undefined ? undefined : await seedWiring().pack({ ...seed, homes: await ctx.homesHere() });
        // A login inside a folder they ticked stays on this computer: said as the pack finds it, so the terminal
        // watching the add reads it there and the answer's notice is the tool door's copy of the same fact.
        if (packed !== undefined && packed.left.length > 0) report("seeding", leftBehindLine(packed.left));
        const landed = await road.land(
          {
            project,
            source: module,
            ...(seed !== undefined && packed !== undefined ? { seed: { tar: packed.tar, choice: seed.choice, plan: seed.plan } } : {}),
            report,
          },
          deps,
        );
        const recorded = await keep(landed);
        // The one sentence about where the project is, which every door reads from here: the terminal prints this
        // stage and says nothing of its own after it, so the fact is said once.
        report("done", addedProjectOn(recorded, ctx.nameOfComputer(computer, rows)));
        // What landed and is not what they asked for, each in its own sentence: the commits a computer's git
        // refused, and a login found inside a folder they ticked, which the pack leaves here. Both are theirs to
        // know about on an add that otherwise stands.
        const notices = [...(landed.notice !== undefined ? [landed.notice] : []), ...(packed !== undefined && packed.left.length > 0 ? [leftBehindLine(packed.left)] : [])];
        return notices.length === 0 ? recorded : { ...recorded, notice: notices.join("; ") };
      } catch (e) {
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },

    async list(): Promise<ProjectView[]> {
      await ctx.ready();
      return [...projectsHeld.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async computers(): Promise<{ id: string; name: string }[]> {
      await ctx.ready();
      return ctx.computerRows();
    },

    async resolve(ref: string, origin?: Caller): Promise<ProjectView> {
      await ctx.ready();
      const all = [...projectsHeld.values()];
      const found = all.find(p => p.id === ref) ?? all.find(p => p.name === ref);
      // A thread works on the project its own workspace holds: every other word reads as absent here, so a word
      // that names another project and one that names nothing are one sentence and neither says what else stands.
      // A thread whose workspace this host no longer holds works on none, so every word reads the same for it.
      const scope = scopeOf(origin);
      if (scope !== undefined) {
        const mine = ctx.projectOfScope(scope);
        if (found === undefined || mine === undefined || found.id !== mine) throw notFoundRefusal(bareNoSuchProjectLine(ref));
        return found;
      }
      if (found === undefined) throw notFoundRefusal(noSuchProjectLine(ref, all.map(p => p.name)));
      return found;
    },

    async remove(id: string, origin?: Caller): Promise<{ said: string }> {
      await ctx.ready();
      ctx.spawnGuard("delete", origin);
      const project = await projectsDoor.resolve(id);
      const held = [...live.values()].filter(e => e.record.project === project.id);
      const standing = held.filter(e => !bareFolder(e.record, ctx.holdsThread(e.record.id))).map(e => e.record.name);
      if (standing.length > 0) throw Object.assign(new Error(projectInUseRefusal(project.name, standing)), { kind: "conflict" });
      const { deps, at, placeId } = await landingDeps(project.computer);
      await readableComputer(at, placeId);
      for (const entry of held) await ctx.workspaces.delete(entry.record.id, origin);
      // What the add made on that computer goes before the record does, so a computer that cannot be reached
      // keeps both and the person can say it again when it is back. The sentence is the road's: it is true
      // differently on a computer of theirs, at a provider and here.
      const said = await projectLanding(landingKind(project.computer, at)).remove(project, deps);
      projectsHeld.delete(project.id);
      await store.delete(PROJECTS, project.id);
      bus.emit({ type: "project.removed", projectId: project.id });
      return { said };
    },
  };

  const projects: Runtime["projects"] = {
    add: projectsDoor.add,
    seedPlan: projectsDoor.seedPlan,
    list: projectsDoor.list,
    async defaults() {
      const prefs = await ctx.preferences.get();
      const runs = (id: string): boolean => adapters[id] !== undefined;
      const catalogOf = (id: string): HarnessCatalog | undefined => {
        const table = runs(id) ? harnessCatalog(id) : undefined;
        return table === undefined ? undefined : withCustomModels(table, prefs.agentDefaults[id]?.models);
      };
      const firstAgent = CATALOG_AGENTS.find(a => runs(a.id))?.id ?? DEFAULT_AGENT.id;
      const held = await projectsDoor.list();
      return Object.fromEntries(held.map(p => [p.id, resolveThreadDefaults({ firstAgent, catalogOf, runs, prefs, ...(prefs.projectDefaults[p.id] !== undefined ? { project: prefs.projectDefaults[p.id] } : {}) })]));
    },
    computers: projectsDoor.computers,
    resolve: projectsDoor.resolve,
    remove: projectsDoor.remove,
    async import(o, origin) {
      ctx.spawnGuard("import", origin);
      const entry = await ctx.entryOf(o.workspaceId, origin);
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "import", entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      await ctx.copyBlocked(entry);
      const began = clock.now();
      const report: ImportReport = (stage, message, progress) => {
        bus.emit({ type: "project.import", workspaceId: o.workspaceId, source: o.source, dest: o.dest, stage, message, elapsedMs: clock.now() - began, ...progress });
      };
      try {
        const kind = ctx.moduleOf(entry.record.kind);
        const landed = await kind.import(entry, o, report);
        // The workspace's own project is its record's; a folder landed beside it is browsable too, and neither is
        // written onto the record, which names one project and nothing else.
        await ctx.rootsWrite(entry.record.machineId, () => kind.roots(entry, [...new Set([ctx.projectHeld(entry.record.project).path, landed.result.dest])]));
        report("done", landed.done);
        return landed.result;
      } catch (e) {
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    async export(o, origin) {
      ctx.spawnGuard("export", origin);
      const entry = await ctx.entryOf(o.workspaceId, origin);
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "export", entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      await ctx.copyBlocked(entry);
      const began = clock.now();
      const report = (stage: ProjectExportStage, message: string, progress?: { bytes: number; total: number }): void => {
        bus.emit({ type: "project.export", workspaceId: o.workspaceId, source: o.source, dest: o.dest, stage, message, elapsedMs: clock.now() - began, ...progress });
      };
      const downloading = (what: string) => (p: { bytes: number; total: number }): void => report("downloading", `${what}: ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}.`, p);
      const scratch = mkdtempSync(join(tmpdir(), "wsp-exported-"));
      // Where the listing writes the filtered copy of a store an agent keeps for every project, mirroring the homes.
      const onMachine = guestTmpPath("wsp-state");
      let listed = false;
      try {
        const homes = guestAgentHomes();
        const listing = stateListing(homes, o.source, onMachine, o.agents);
        const at = await o.lander.probe(o.dest);
        if (at !== undefined && o.replace !== true) throw destExists(o.dest, at.files);
        report("packing", `Packing ${o.source} on the machine.`);
        const archive = join(scratch, "folder.tgz");
        const folder = await exportFolder(entry.machine, o.source, o.lander.caches, archive, { timeoutMs: 600_000, onProgress: downloading("The folder") });
        let found = { exitCode: 0, stdout: "", stderr: "" };
        if (listing !== "") {
          listed = true;
          found = await entry.machine.run(listing, { deadlineMs: LISTING_DEADLINE_MS });
        }
        if (found.exitCode !== 0) throw new Error(`could not look for agent state on the machine: ${found.stderr.slice(-200)}`);
        const { paths: present, unread } = parseStateListing(found.stdout);
        let state: LandRequest["state"];
        if (present.length > 0) {
          report("packing", `Packing the agents' state for it on the machine.`);
          const stateArchive = join(scratch, "state.tgz");
          // A copy travels at the path it mirrors under the scratch root, so the archive is the homes as the project alone left them.
          const groups = [
            { root: "/", paths: present.filter(p => !underProject(p, onMachine)) },
            { root: onMachine, paths: present.filter(p => underProject(p, onMachine)) },
          ].filter(g => g.paths.length > 0);
          await exportPathsInto(entry.machine, groups, stateArchive, { timeoutMs: 600_000, onProgress: downloading("Agent state") });
          state = { archive: stateArchive, homes, ...(o.agents !== undefined ? { agents: o.agents } : {}) };
        }
        report("landing", `Landing at ${o.dest}.`);
        const landed = await o.lander.land({ source: o.source, dest: o.dest, replace: o.replace === true, archive, ...(state !== undefined ? { state } : {}), ...(unread.length > 0 ? { unread } : {}) });
        const outcomes = landed.agents.map(homeOutcome);
        const caches = folder.excluded.length === 0 ? "" : `; ${plural(folder.excluded.length, "cache")} left behind`;
        report("done", `${plural(landed.files, "file")}, ${fmtBytes(landed.bytes)}, landed at ${o.dest}${caches}; ${outcomes.length === 0 ? "no agent sessions for it on the machine" : `sessions: ${outcomes.join(", ")}`}.`);
        return { dest: o.dest, files: landed.files, bytes: landed.bytes, excluded: folder.excluded, agents: landed.agents.map(({ name: _name, ...a }) => a) };
      } catch (e) {
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        if (listed) await entry.machine.exec(`rm -rf ${shellQuote(onMachine)}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
  return { copyImport, landingKind, landingDeps, projectsDoor, projects };
}

function usageArea(ctx: RuntimeContext): UsageArea {
  const { opts, store, local, placeDoor, bus, clock, projectsHeld, setups, placeAway, sessions } = ctx;
  /** Why a machine cannot be asked anything at all this tick: it stands on a computer that is not connected. Every
   * road to it, the provider read included, rides that computer's link, so the row says so rather than reading a
   * silence as a machine that died. */
  const awayLine = (record: WorkspaceRecord): string | undefined => {
    const at = workspacePlace(record);
    if (at === undefined || placeDoor === undefined || !placeAway(at)) return undefined;
    return absentComputer(placeDoor.nameOf(at), null).sentence;
  };

  /** A nap, a pause the poll adopts or a gone verdict moves the phase, and the sentence was about the phase it left. */
  const deleteLine = (e: LiveWorkspace): string | undefined => (e.deleteSaid?.phase === e.record.phase ? e.deleteSaid.line : undefined);
  /** The one sentence a row carries, the most pressing first: a delete the provider sat on, the wake's own line or the
   * words it left, a pause or a stop the provider refused, then a disk past the line a stop fails at. */
  const rowReason = (e: LiveWorkspace): string | undefined => deleteLine(e) ?? e.wakeSaid ?? e.record.wakeRefused ?? ctx.napRefusedReason(e) ?? ctx.stopRefusedReason(e) ?? ctx.diskReason(e);

  const prices = createPriceTable({ store, clock, fetch: opts.pricesFetch ?? (async () => ({})) });
  const ledger = createUsageLedger({ store, clock, prices: () => prices.get() });
  const alerts = planAlerts({ clock, emit: e => bus.emit(e), limits: () => ledger.limits() });
  void alerts.resume().catch((e: unknown) => console.warn(`the plan alerts were not armed: ${e instanceof Error ? e.message : String(e)}`));
  const burn = createBurn(clock);

  /** A usage split value as a person reads it: the agent's name, the account's label, the computer's, the project's. */
  const usageLabel = (places: readonly PlaceView[], accounts: ReadonlyMap<string, string>) => (split: UsageSplit, value: string): string => {
    switch (split) {
      case "agent":
        return harnessCatalog(value)?.label ?? value;
      case "project":
        return value === "" ? "No project" : (projectsHeld.get(value)?.name ?? value);
      case "computer":
        return usageComputerName(places, value);
      case "account":
        return accounts.get(value) ?? value;
      case "model":
        return modelLabel(value);
      default: {
        const _exhaustive: never = split;
        return value;
      }
    }
  };

  /** The logs of this computer's agents, filed into the ledger as outside wsp: a folder under one of this computer's
   * projects is that project's, the account is this computer's own login of that agent unless a turn here named it. */
  let logsReadAt: number | undefined;
  const readLogs = async (): Promise<void> => {
    if (opts.logUsage === undefined || !(await ctx.preferences.get()).usageLogs) return;
    if (logsReadAt !== undefined && clock.now() - logsReadAt < LOG_READ_EVERY_MS) return;
    logsReadAt = clock.now();
    const here = [...projectsHeld.values()].filter(p => p.computer === HERE_PLACE_ID);
    const limits = await ledger.limits();
    // A thread wsp ran here writes its transcript to the same logs, whether or not its turn filed a row.
    await ctx.ready();
    const threads = new Set([...sessions.values()].flatMap(s => (s.view.claudeSessionId !== undefined ? [s.view.claudeSessionId] : [])));
    const rows = (await opts.logUsage()).filter(r => !threads.has(r.session));
    const thisComputer = { id: HERE_PLACE_ID, name: usageComputerName((await placeDoor?.list(clock.now())) ?? [], HERE_PLACE_ID) };
    // Work in a terminal here runs on the account this computer's turns run on.
    const accountHere = (agent: string): { key: string; label: string } => accountOnComputer({ agent, agentName: harnessCatalog(agent)?.label ?? agent, computer: thisComputer, limits, vaulted: ctx.vaultedFor(agent) });
    await ledger.fileLogs(
      rows.map(r => ({
        at: r.at,
        agent: r.agent,
        account: accountHere(r.agent).key,
        accountLabel: accountHere(r.agent).label,
        computer: HERE_PLACE_ID,
        project: (r.folder !== undefined ? here.find(p => underProject(r.folder!, p.path))?.id : undefined) ?? "",
        model: r.model,
        tokens: r.tokens,
        ...(r.cost !== undefined ? { costUsd: r.cost } : {}),
        session: r.session,
        source: "log" as const,
      })),
    );
  };

  /** This computer's own sign-ins, read off its agents since no report carries them; a read that fails lists none. */
  const hereSignIns = (): Promise<Record<string, AgentSignInState>> =>
    (opts.agentsReader?.read({ kind: "here" }, { latest: false }) ?? Promise.resolve(undefined)).then(
      read => (read === undefined ? {} : Object.fromEntries(read.agents.flatMap(a => (a.signIn === "signed-in" || a.signIn === "vault-key" ? [[a.id, a.signIn]] : [])))),
      () => ({}),
    );

  const usageAccounts = async (): Promise<AccountsAnswer> => {
    const places = (await placeDoor?.list(clock.now())) ?? [];
    const here = await hereSignIns();
    const listed = places.map(p => ({ id: p.id, name: p.name, ...(p.signIns !== undefined ? { signIns: p.signIns } : {}) }));
    const row = listed.find(p => p.id === HERE_PLACE_ID);
    if (row !== undefined) row.signIns ??= here;
    else listed.push({ id: HERE_PLACE_ID, name: THIS_COMPUTER, signIns: here });
    return {
      accounts: accountRows({
        limits: await ledger.limits(),
        places: listed,
        nameOf: id => usageComputerName(places, id),
        agentName: agent => harnessCatalog(agent)?.label ?? agent,
        planBrand: agent => CATALOG_AGENTS.find(a => a.id === agent)?.planBrand,
        vaulted: agent => ctx.vaultedFor(agent),
        printsLimits: agent => CATALOG_AGENTS.find(a => a.id === agent)?.printsLimits === true,
        burn: burn.of,
      }),
    };
  };

  /** One reset script on one computer: this one as a child of this host, a joined one over its link. */
  const resetRun = async (place: ResetPlace, script: string): Promise<string> => {
    if (place.kind === "box") {
      if (placeDoor === undefined) throw new Error(NO_PLACE_DOOR);
      return (await placeDoor.exec(place.id, script, { timeoutMs: RESET_EXEC_MS })).stdout;
    }
    if (local === undefined) throw new Error(absentComputer(place.name, null).sentence);
    const stream = local.execStream({ idleMs: RESET_EXEC_MS, deadlineMs: RESET_EXEC_MS })(script, { env: { ...local.env() } });
    const lines: string[] = [];
    for await (const line of stream.lines) lines.push(line);
    await stream.exited;
    return lines.join("\n");
  };

  const spendReset = usageResets({
    store,
    limits: () => ledger.limits(),
    agentName: agent => harnessCatalog(agent)?.label ?? agent,
    resets: agent => PLAN_RESETS[agent as ThreadAgent],
    places: async () => {
      const views = (await placeDoor?.list(clock.now())) ?? [];
      const here = await hereSignIns();
      return id => {
        const name = usageComputerName(views, id);
        if (id === HERE_PLACE_ID) return { id, name, kind: "here", connected: local !== undefined, signedIn: agent => here[agent] === "signed-in" };
        const view = views.find(v => v.id === id);
        if (view === undefined || !isJoinedComputer(view)) return { id, name, kind: "provider", connected: false, signedIn: () => false };
        return { id, name, kind: "box", connected: placeDoor?.link(id) !== undefined, signedIn: agent => placeDoor?.signInsAt(id)?.[agent] === "signed-in" };
      };
    },
    road: async (agent, at) => {
      const setup = setups.launchOf(at.id, agent);
      const launch = setup.launch?.program !== undefined ? { launch: { program: setup.launch.program } } : {};
      if (at.kind === "here") {
        if (local === undefined) throw new Error(absentComputer(at.name, null).sentence);
        return { home: setup.configDir ?? local.home(agent), env: { PATH: local.env()["PATH"], ...setup.env }, ...launch };
      }
      const report = await placeDoor?.reportOf(at.id);
      const env = { PATH: report?.login["PATH"], ...setup.env };
      if (setup.configDir !== undefined) return { home: setup.configDir, env, ...launch };
      const logins = (await placeDoor?.list(clock.now()))?.find(v => v.id === at.id)?.logins;
      const shared = sharedOn(agent);
      if (logins === undefined || shared === undefined) throw new Error(resetNoLoginsLine(at.name, harnessCatalog(agent)?.label ?? agent));
      return { home: loginHomeIn(logins, shared), env, ...launch };
    },
    run: resetRun,
    file: async ({ agent, place: at, limit }) => {
      const account = accountOf({ agent, agentName: harnessCatalog(agent)?.label ?? agent, ...(limit.account !== undefined ? { named: limit.account } : {}), vaulted: undefined, computer: { id: at.id, name: at.name } });
      const { before, after } = await ledger.limit({ key: account.key, agent, label: account.label, road: account.road, computer: at.id, limit });
      await alerts.read(before, after);
      return account.key;
    },
    row: async key => (await usageAccounts()).accounts.find(a => a.key === key),
    uuid: () => randomUUID(),
  });

  /** A spend, the computer the person named read as a place first: a word, or this computer. */
  const reset = async (ask: { account: string; creditId?: string; on?: string }): Promise<ResetAnswer> => {
    const on = ask.on === undefined ? undefined : ((await placeDoor?.placeFor(ask.on))?.placeId ?? HERE_PLACE_ID);
    return spendReset({ account: ask.account, ...(ask.creditId !== undefined ? { creditId: ask.creditId } : {}), ...(on !== undefined ? { on } : {}) });
  };

  const usage: UsageDoor = {
    reset,
    used: async q => {
      const outside = q.outside === true && (await ctx.preferences.get()).usageLogs;
      if (outside) await readLogs().catch((e: unknown) => console.warn(`this computer's agent logs were not read for usage: ${e instanceof Error ? e.message : String(e)}`));
      const places = (await placeDoor?.list(clock.now())) ?? [];
      return ledger.used({ range: q.range, split: q.split, label: usageLabel(places, await ledger.accountLabels()), outside, logsOn: usageComputerName(places, HERE_PLACE_ID) });
    },
    readings: async (target, range, origin) => {
      const to = clock.now();
      const from = to - RANGE_DAYS[range] * 86_400_000;
      const stepMs = READINGS_STEP_MS[range];
      const frame = { op: "sys.history", from, to, stepMs } as DaemonFrame;
      const read = async (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>): Promise<ReadingsAnswer> => {
        const reply = SysHistoryReply.parse(await ask(frame));
        return { points: reply.points, stepMs: reply.stepMs, from, to };
      };
      if ("workspaceId" in target) return ctx.withDaemon(await ctx.entryOf(target.workspaceId, origin), read);
      if (target.placeId === HERE_PLACE_ID) return ctx.overChannel(await ctx.channelOver(await ctx.localRoad(), THIS_COMPUTER, () => {}), read);
      const onLink = placeDoor?.channel(target.placeId, () => {});
      if (onLink === undefined) throw new Error(absentComputer(placeDoor?.nameOf(target.placeId) ?? target.placeId, null).sentence);
      return ctx.overChannel(onLink, read);
    },
    accounts: usageAccounts,
  };
  return { awayLine, rowReason, ledger, alerts, burn, usageAccounts, usage };
}

function statusArea(ctx: RuntimeContext): StatusArea {
  const { opts, backend, store, bus, clock, live, projectsHeld } = ctx;
  const status = createStatusTracker({
    store,
    records: async () => {
      await ctx.ready();
      return ctx.held().map(e => ({
        ...ctx.view(e.record),
        size: e.record.size,
        // The rate follows the machine's kind: a local workspace's backend prices it at zero, so no cost line rides its row.
        rateUsdPerHour: ctx.backendFor(e.record).pricing.rateUsdPerHour(e.record.size),
        generation: e.generation,
        // The wake's own line while one is in flight, and the words it left behind once its asking ran out: the poll
        // builds every status from the record, so a row that carried only what was pushed would fall silent between
        // two asks and forget the rebuild road at the next tick. A delete the provider sat on outranks both.
        // A pause or a stop the provider refused stays on the row as long as it stands, for the same reason, and so
        // does a disk past the line, which is said before a stop can fail on it.
        ...(ctx.rowReason(e) !== undefined ? { reason: ctx.rowReason(e)! } : {}),
        ...(e.wakeAsk !== undefined ? { wakeAsk: e.wakeAsk } : {}),
        ...(e.checkout !== undefined ? { checkout: e.checkout } : {}),
        ...(e.pr !== undefined ? { pr: e.pr } : {}),
        ...(e.record.phase === "running" && ctx.idle.idleAt(e.record.id) !== undefined ? { idleAt: ctx.idle.idleAt(e.record.id)! } : {}),
        ...(ctx.awayLine(e.record) !== undefined ? { away: ctx.awayLine(e.record)! } : {}),
        ...(ctx.unreachedOf(e) !== undefined ? { unreached: ctx.unreachedOf(e)! } : {}),
        ...(ctx.moduleOf(e.record.kind).hasDaemon(e) ? { daemonReach: () => ctx.moduleOf(e.record.kind).daemonRoad(e) } : {}),
        ...(e.machine.daemonAnswers !== undefined ? { daemonAnswers: e.machine.daemonAnswers.bind(e.machine) } : {}),
        providerState: () => e.machine.state(),
        ...(e.machine.metrics !== undefined ? { metrics: e.machine.metrics.bind(e.machine) } : {}),
        // A machine the poll last found unreachable is not asked what it is: over ssh that read is a dial of its
        // own, so a box that is off would pay one every tick beside the dial the reach already makes.
        ...(e.machine.facts !== undefined && ctx.reachOf(e) !== "unreachable" ? { facts: e.machine.facts.bind(e.machine) } : {}),
        exec: (cmd, o) => e.machine.exec(cmd, o),
      }));
    },
    emit: e => bus.emit(e),
    on: (type, l) => bus.on(type, l),
    // Every tick, not every change: this is where the runtime learns what its machines' reach actually is, and a
    // machine parked in one state is the case both readers of it exist for.
    onPolled: statuses => {
      for (const s of statuses) {
        const entry = live.get(s.id);
        if (entry === undefined || s.machineId !== entry.machine.id) continue;
        if (s.phase === "running") ctx.polledReach.set(s.id, { machineId: s.machineId, reach: s.reach.state });
        else ctx.polledReach.delete(s.id);
        ctx.reviveDaemon(entry, s.reach.state);
        ctx.offerDaemonAgain(entry, s);
        ctx.readVersionAgain(entry, s);
      }
    },
    onGone: (id, machineId, reason) => {
      const entry = live.get(id);
      // A sighting of a machine since replaced says nothing about the one now under the record.
      if (entry !== undefined && entry.record.machineId === machineId) void ctx.adoptGone(entry, reason).catch((e: unknown) => console.warn(`${entry.record.id}'s gone reading was not confirmed: ${e instanceof Error ? e.message : String(e)}`));
    },
    ...(opts.status !== undefined ? { defaults: opts.status } : {}),
    clock,
  });

  /** A workspace machine of this setup's that no record claims is recorded again rather than killed: its record was
   * lost (a store the machine outlived), and it bills until a person can see and delete it. A running one whose
   * workspace was deleted here is left unclaimed, so the engine kills it. One this host cannot name is reported off
   * its listing row alone: a get() resets the provider's idle timer (measured), so a read every sweep would keep awake
   * the very machines it reports. A row about to be recorded is confirmed with one get(), so a row the listing lags on
   * after a kill is skipped; a create in flight elsewhere is left its minute. A row the provider would not confirm (a
   * failed read, a state that is neither running nor paused) is claimed in `known` all the same, so the engine spares
   * it this sweep and the next one records it: a kill never rides on one read. */
  const adoptLost = async (listing: ListedMachine[], known: Set<string>, failed: ReapFailure[]): Promise<AdoptedMachine[]> => {
    const adopted: AdoptedMachine[] = [];
    const now = Date.now();
    const dropped = new Set<string>();
    for (const d of (await store.list(DROPPED)) as DroppedMachine[]) {
      if (clock.now() - Date.parse(d.at) < DROPPED_WATCH_MS) dropped.add(d.machineId);
      else await store.delete(DROPPED, d.machineId);
    }
    for (const row of listing) {
      // The engine kills only a running row, so a paused one stays reported rather than silently left.
      if (known.has(row.id) || (dropped.has(row.id) && row.state === "running") || !lostWorkspace(row, ctx.state.owner, now)) continue;
      // A stamped id another machine now holds is a body a rebuild or an image move replaced and failed to stop: the engine kills it.
      const stamped = row.labels[WORKSPACE_LABEL];
      if (stamped !== undefined && live.has(stamped)) continue;
      const kept = stamped === undefined ? undefined : ((await store.get(WORKSPACE_NAMES, stamped)) as NamedWorkspace | undefined);
      // A workspace is one project's copy, so a machine whose project this host cannot name is not a workspace
      // here: it is reported rather than recorded, and the sweep's own --older-than is the road that ends it.
      if (stamped === undefined || kept?.project === undefined || !projectsHeld.has(kept.project)) {
        known.add(row.id);
        failed.push({ id: row.id, message: `not recorded: this host holds no project for it, and a workspace is one project's copy; it is a machine of yours still running` });
        continue;
      }
      let machine: Machine;
      try {
        machine = ctx.observed(await backend.get(row.id));
      } catch (e) {
        if (isMissing(e)) continue;
        known.add(row.id);
        failed.push({ id: row.id, message: `not recorded: ${e instanceof Error ? e.message : String(e)}; retried next sweep` });
        continue;
      }
      const state = machine.seen?.state ?? (await machine.state());
      if (state !== "running" && state !== "paused") {
        known.add(row.id);
        continue;
      }
      const bornAt = row.labels[CREATED_AT_LABEL];
      const record: WorkspaceRecord = {
        id: stamped,
        name: ctx.nameRefusal(kept.name) === undefined ? kept.name : row.id,
        kind: "cloud",
        project: kept.project,
        machineId: row.id,
        phase: state === "paused" ? "napping" : "running",
        golden: row.labels[GOLDEN_LABEL] ?? goldenHead(await ctx.golden.get())?.snapshotId ?? "",
        createdAt: bornAt !== undefined && !Number.isNaN(Date.parse(bornAt)) ? bornAt : new Date().toISOString(),
        spec: { labels: row.labels },
        size: ctx.sizeBuilt(await ctx.shapeOf(machine), backend.pricing.defaultSize),
        firstLife: false,
        ...(machine.streamUrl !== undefined ? { screen: { streamUrl: machine.streamUrl } } : {}),
      };
      const entry = ctx.attach(record, machine);
      await ctx.persist(record);
      if (record.phase === "running") void ctx.syncDaemon(entry);
      bus.emit({ type: "workspace.created", workspace: ctx.view(record) });
      await ctx.emitStatus(entry, record.phase === "running" ? ctx.reachOf(entry) : "napping", RECORD_RESTORED);
      adopted.push({ id: row.id, workspaceId: stamped, name: record.name, phase: record.phase });
    }
    return adopted;
  };
  return { status, adoptLost };
}

function preferencesArea(ctx: RuntimeContext): PreferencesArea {
  const { opts, backend, store, adapters, placeDoor, bus, clock, projectsHeld, setups } = ctx;
  // Sets run one after another: two clients patching different fields at once would otherwise each read the record
  // before the other's write and the later write would drop the earlier field.
  let preferenceWrites: Promise<unknown> = Promise.resolve();
  // Read once, here, and stamped on every read: a state file that holds an older labs cannot outvote the environment.
  const labs = labsFromEnv(opts.env ?? process.env);
  /** The record is kept whether or not the folder goes; a folder that stays is said on the reply. */
  const iconsForgotten = (): string | undefined => {
    const icons = opts.serverIcons;
    if (icons === undefined) return undefined;
    try {
      icons.forget();
      return undefined;
    } catch (e) {
      // Node's own words carry the code before and the call and path after: "EACCES: permission denied, rmdir '/x'".
      const said = e instanceof Error ? e.message.replace(/^[A-Z]+: /, "").replace(/, \w+ '[^']*'$/, "") : String(e);
      return serverIconsLeftLine(homeShortened(icons.folder, homedir()), said);
    }
  };
  /** Why a change to the defaults cannot stand: an agent this host runs no thread of, a project it does not hold, or
   * an access word the agent it lands on maps to none of its modes, which is refused here rather than run looser. */
  const defaultsRefusal = (patch: PreferencesPatch, next: Preferences): void => {
    const usage = (line: string): Error => Object.assign(new Error(line), { kind: "usage" });
    const agent = (id: string): void => {
      if (adapters[id] === undefined) throw usage(noAdapterLine(id, Object.keys(adapters)));
    };
    const word = (id: string, access: AccessChoice | null | undefined): void => {
      const table = harnessCatalog(id);
      const said = access == null ? null : accessRefusal(table ?? { label: ctx.agentLabel(id), permissionModes: [] }, access);
      if (said !== null) throw usage(said);
    };
    const model = (id: string): void => {
      const said = modelIdRefusal(id);
      if (said !== null) throw usage(said);
    };
    if (patch.defaultAgent != null) agent(patch.defaultAgent);
    for (const [id, set] of Object.entries(patch.agentDefaults ?? {})) {
      if (set === null) continue;
      agent(id);
      word(id, set.access);
      for (const named of [...(set.model == null ? [] : [set.model]), ...(set.models?.custom ?? [])]) model(named);
    }
    for (const [projectId, set] of Object.entries(patch.projectDefaults ?? {})) {
      if (set === null) continue;
      if (!projectsHeld.has(projectId)) throw usage(bareNoSuchProjectLine(projectId));
      if (set.agent != null) agent(set.agent);
      if (set.model != null) model(set.model);
      const kept = next.projectDefaults[projectId];
      word(kept?.agent ?? ctx.defaultAgentOf(next, undefined), set.access);
    }
  };
  const preferences: Runtime["preferences"] = {
    get: async () => (ctx.state.preferencesHeld ??= { ...preferencesFrom(await store.get(PREFERENCES, PREFERENCES_ID)), labs }),
    set: patch => {
      const write = preferenceWrites.then(async () => {
        await ctx.ready();
        const next = applyPreferencesPatch(await preferences.get(), patch);
        defaultsRefusal(patch, next);
        await store.put(PREFERENCES, PREFERENCES_ID, next);
        ctx.state.preferencesHeld = next;
        const notice = patch.serverIcons === false ? iconsForgotten() : undefined;
        bus.emit({ type: "preferences.changed", preferences: next });
        return notice === undefined ? { preferences: next } : { preferences: next, notice };
      });
      preferenceWrites = write.catch(() => undefined);
      return write;
    },
  };

  const iconsOn = async (): Promise<boolean> => (await preferences.get()).serverIcons;
  const agentsRead = agentsReads<Caller>({
    reader: opts.agentsReader,
    places: () => placeDoor,
    workspace: async (id, origin) => {
      const entry = await ctx.entryOf(id, origin);
      const project = ctx.projectHeld(entry.record.project);
      return { name: entry.record.name, phase: entry.record.phase, local: isLocalWorkspace(entry.record), machine: entry.machine, project: { id: project.id, name: project.name, path: ctx.checkoutOf(entry.record) } };
    },
    // A project's folder on the computer holding it: the checkout the add left there, else where it already sits.
    projects: async placeId => (await ctx.ready(), [...projectsHeld.values()].filter(p => p.computer === placeId).map(p => ({ id: p.id, name: p.name, path: p.checkout ?? p.path }))),
    ...(opts.agentsActs !== undefined ? { acts: opts.agentsActs } : {}),
    ...(opts.skillsActs !== undefined ? { skills: opts.skillsActs } : {}),
    ...(opts.serversActs !== undefined ? { servers: opts.serversActs } : {}),
    latestOn: async () => (await preferences.get()).agentVersions,
    // The person's switch is read at every ask, so turning it off stops the next one.
    ...(opts.serverIcons !== undefined ? { icons: { folder: opts.serverIcons.folder, icon: async (host, refresh) => ((await iconsOn()) ? opts.serverIcons!.icon(host, refresh, iconsOn) : null), forget: () => opts.serverIcons!.forget() } satisfies ServerIcons } : {}),
    // The target's own daemon: this computer's, a joined computer's over the link it holds, or a workspace's by the
    // road its kind answers, which is the one reading every pane takes.
    channel: async (target, onEvent, origin) => {
      if ("workspaceId" in target) return ctx.workspaces.daemonChannel(target.workspaceId, onEvent, origin);
      if (target.placeId === HERE_PLACE_ID) return ctx.channelOver(await ctx.localRoad(), THIS_COMPUTER, onEvent);
      const onLink = placeDoor?.channel(target.placeId, onEvent);
      if (onLink === undefined) throw new Error(absentComputer(placeDoor?.nameOf(target.placeId) ?? target.placeId, null).sentence);
      return onLink;
    },
    changed: target => bus.emit({ type: "agents.changed", ...(target !== undefined ? { target } : {}) }),
    setupOf: (placeId, agent) => (adapters[agent] === undefined ? undefined : setupView(setups.get(placeId, agent))),
    setupWrite: async (placeId, agent, change) => {
      if (adapters[agent] === undefined) throw Object.assign(new Error(noAdapterLine(agent, Object.keys(adapters))), { kind: "usage" });
      await setups.set(placeId, agent, change, { folder: path => ctx.configFolderOn(placeId, path), agentName: ctx.agentLabel(agent) });
      ctx.setupRefusals.delete(keyOf(placeId, agent));
    },
    relayed: () => backend.capabilities.callbackRelay,
    now: () => clock.now(),
  });
  bus.on("workspace.deleted", e => {
    if (e.type === "workspace.deleted") agentsRead.forget(e.workspaceId);
  });
  return { preferences, agentsRead };
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
