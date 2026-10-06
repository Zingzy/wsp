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

import { recordsArea } from "./images/records.js";

import { reachArea } from "./machines/reach.js";

// import { pullRequestsArea } from "./account/pull-requests.js";

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
