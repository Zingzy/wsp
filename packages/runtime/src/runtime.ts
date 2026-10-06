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

// import { kindsArea } from "./machines/kinds.js";

import { rulesArea } from "./account/rules.js";

// import { transcriptsArea } from "./threads/transcripts.js";

import { slatesArea } from "./account/slates.js";

import { channelsArea } from "./account/channels.js";

// import { recordsArea } from "./images/records.js";

// import { reachArea } from "./machines/reach.js";

import { pullRequestsArea } from "./account/pull-requests.js";

// import { daemonArea } from "./machines/daemon.js";

// import { machinesArea } from "./machines/machines.js";

// import { bootArea } from "./machines/boot.js";

// import { createArea } from "./machines/create.js";

// import { foldersArea } from "./projects/folders.js";

// import { startFromArea } from "./projects/start-from.js";

// import { workspacesArea } from "./projects/workspaces.js";

// import { agentsArea } from "./threads/agents.js";

// import { threadsArea } from "./threads/threads.js";

// import { turnsArea } from "./threads/turns.js";

// import { sessionsArea } from "./threads/sessions.js";

// import { buildersArea } from "./images/builders.js";

// import { goldenArea } from "./images/golden.js";

// import { imageArea } from "./images/image.js";

// import { projectsArea } from "./projects/projects.js";

import { usageArea } from "./account/usage.js";

import { statusArea } from "./account/status.js";

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

function kindsArea(ctx: RuntimeContext): KindsArea {
  const { opts, backend, local, placeDoor, clock, places } = ctx;
  const projectOf = (dest: string, size: number): WorkspaceProject => ({ name: folderName(dest), dest, importedAt: new Date(clock.now()).toISOString(), size });
  /** The command that puts a project's repo inside a copy of an image, word for word, so the test that reads the
   * machine's log and the machine that runs it read one line. No --branch where the record names no base: the
   * remote's own default branch is what the clone then takes. */
  const cloneOnMachine = (project: ProjectView, computer: string): string =>
    cloneLines({
      source: projectSource(project.source.kind),
      remote: project.remote,
      checkout: project.path,
      computer,
      ...(project.base !== undefined ? { branch: project.base } : {}),
    }).join("\n");
  /** The clone inside a copy: git's own last line is the failure, so a person reads what git said and not that a
   * stage failed. */
  const cloneProject = async (entry: LiveWorkspace, project: ProjectView, report: StageReport): Promise<void> => {
    // A copy forked from the project's own image already holds the checkout and its dependencies, and so does one
    // the computer copied the checkout into; there is nothing to clone and nothing to install in either.
    if (project.image !== undefined || project.checkout !== undefined) return;
    // And neither has a fork of a project image that carried this checkout: the snapshot is the whole disk, so the
    // project stands at its path with its dependencies installed, and a clone over it is what git refuses. The
    // image the machine was forked from is what says so, read off this workspace's own record.
    if (imageCarriesCheckout((await ctx.imageOf(entry.record.golden)).projects, project.path)) return;
    report("project-cloned", `Cloning ${project.remote} into ${project.path}.`);
    const cloned = await entry.machine.exec(cloneOnMachine(project, ctx.placeName(entry.record.place ?? places.wired)), { timeoutMs: CLONE_MS });
    if (cloned.exitCode !== 0) throw new Error(lastLineOf(cloned.stderr) || lastLineOf(cloned.stdout) || `git clone exited ${cloned.exitCode}`);
    // Fresh dependencies on the machine holding the checkout: the catalog's row for whichever lockfile the repo's
    // own root carries, run once, its output in wsp's own folder and never inside the project. A repo no row names
    // an install for installs nothing.
    const root = await entry.machine.exec(`ls -A ${shellQuote(project.path)}`, { timeoutMs: INLINE_EXEC_MS });
    const install = projectInstalls(root.stdout.split("\n").map(name => name.trim()), project.path)[0];
    if (install === undefined) return;
    report("project-cloned", `${install.command} in ${project.path}.`);
    const log = `${moduleOf(entry.record.kind).scratch(entry)}/install-${project.id}.log`;
    const ran = await entry.machine.exec(installScript(install, { dir: project.path, log }), { timeoutMs: INSTALL_MS });
    if (ran.exitCode !== 0) throw new Error(`${install.command} in ${project.path}: ${lastLineOf(ran.stderr) || lastLineOf(ran.stdout) || `exit ${ran.exitCode}`}; its whole output is ${log} on the machine`);
  };
  /** One folder on this computer's own remote and the branch that remote's HEAD names, in one command: what a
   * project of a folder here keeps on its record. Both empty where the folder has no origin, which a project
   * here is allowed: nothing clones it. */
  const remoteHere = async (path: string): Promise<{ remote: string; defaultBranch: string }> => {
    const machine = await moduleOf("local").backend({ kind: "local" } as WorkspaceRecord).get(LOCAL_MACHINE_ID);
    // Each command prints exactly one line, its answer or an empty one, so the two are read apart whichever of
    // them the folder can answer: a folder with no origin has no remote and no default branch, not one of each.
    const read = await machine.exec(
      `${shellLine(["git", "-C", path, "remote", "get-url", "origin"])} || echo; ${shellLine(["git", "-C", path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])} || echo`,
      { timeoutMs: INLINE_EXEC_MS },
    );
    const [remote = "", head = ""] = read.stdout.split("\n").map(line => line.trim());
    return { remote, defaultBranch: head.replace(/^origin\//, "") };
  };

  /** One git command on this computer, argv quoted, through the local backend as every read here goes. */
  const gitHere = async (cwd: string, args: readonly string[], timeoutMs = INLINE_EXEC_MS, stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const machine = await moduleOf("local").backend({ kind: "local" } as WorkspaceRecord).get(LOCAL_MACHINE_ID);
    return machine.exec(shellLine(["git", "-C", cwd, ...args]), { timeoutMs, ...(stdin !== undefined ? { stdin: Buffer.from(stdin) } : {}) });
  };
  /** The top of the repo a folder on this computer sits in, the folder itself or one above it; nothing for a folder
   * git holds no repo in. */
  const gitTopOf = async (path: string): Promise<string | undefined> => {
    const read = await gitHere(path, ["rev-parse", "--show-toplevel"]);
    const top = read.stdout.trim();
    return read.exitCode === 0 && top !== "" ? top : undefined;
  };
  /** The branch a folder has checked out; nothing on a detached HEAD or where git answers nothing. */
  const branchAt = async (path: string): Promise<string | undefined> => {
    const read = await gitHere(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = read.stdout.trim();
    return read.exitCode === 0 && branch !== "" ? branch : undefined;
  };
  /** The folder beside the state this host serves, where its worktrees and its own files about them live, so two
   * hosts never share one. Never a home's default: a host serving another home would write into the person's. */
  const stateFolder = (): string => {
    if (opts.statePath === undefined) throw Object.assign(new Error("this runtime was given no state file, so it keeps no worktrees or copies"), { kind: "invalid" });
    return dirname(resolvePathOn(opts.statePath));
  };
  /** A repo cloned on this computer into the folder the person named, which must hold nothing yet: the source's own
   * clone line, argv quoted so neither the url nor the folder is read by the shell, `--` before the url so git
   * reads no option out of it, and no prompt, since nobody is at a terminal to answer one. Git's own last line is
   * the refusal. Answers the folder as it resolved, which is the project's path from here on. */
  const cloneHere = async (word: string, source: ProjectSource, into: string): Promise<string> => {
    const refused = cloneUrlRefusal(word);
    if (refused !== undefined) throw Object.assign(new Error(refused), { kind: "invalid" });
    const dest = folderNamed(into);
    let held: string[] = [];
    try {
      held = readdirSync(dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") held = [dest];
      else if (code !== "ENOENT") throw e;
    }
    if (held.length > 0) throw Object.assign(new Error(cloneIntoTakenLine(homeShortened(dest, homedir()))), { kind: "invalid" });
    const machine = await moduleOf("local").backend({ kind: "local" } as WorkspaceRecord).get(LOCAL_MACHINE_ID);
    const line = `${shellLine(["env", "GIT_TERMINAL_PROMPT=0"])} ${projectSource(source.kind).cloneCommand({ remote: projectRemote(source), dest })}`;
    const cloned = await machine.exec(line, { timeoutMs: CLONE_MS });
    if (cloned.exitCode !== 0) throw Object.assign(new Error(cloneFailedLine(cloned.stderr || cloned.stdout)), { kind: "invalid" });
    return folderNamed(dest);
  };
  /** The import road on this computer: the folder is here already, so its path is recorded at once and nothing is
   * packed or sent. The plan is still read, since it is the one measure of the folder and the one check that it is
   * there, and its bytes are the size the record shows. */
  const registerImport = async (o: ProjectImportOptions, report: ImportReport): Promise<ImportLanded> => {
    report("landing", REGISTERING_LINE);
    const plan = await o.bundler.plan();
    return {
      result: { dest: o.dest, files: plan.files, bytes: plan.bytes, parts: 0, cut: [], rewritten: [], agents: [], project: projectOf(o.dest, plan.bytes) },
      done: registeredLine(o.dest),
    };
  };
  /** The roots file as the machine's daemon reads it, written through the machine so the guest and this computer
   * take one script; a machine that will not take it fails the import before the record names the folder. */
  const writeRoots = async (entry: LiveWorkspace, dests: readonly string[], rootsPath?: string): Promise<void> => {
    const browsable = await entry.machine.exec(writeDaemonRootsScript(dests, rootsPath), { timeoutMs: INLINE_EXEC_MS });
    if (browsable.exitCode !== 0) throw new Error(`could not make ${dests.at(-1)} browsable on the machine: ${browsable.stderr.slice(-200)}`);
  };
  const cloudHome = (id: string): string => {
    const home = guestAgentHomes()[id];
    if (home === undefined) throw new Error(`the catalog has no home for ${id}`);
    return home;
  };
  /** The guest's login plus the variable pointing one harness at its store there, the store cloudHome names: a guest
   * exec carries no environment of its own, so the adapter exports this on every launch. */
  const cloudEnv = (place: string | undefined, id: string): Readonly<Record<string, string>> => {
    const login = loginEnvOn(place);
    const agent = CATALOG_AGENTS.find(a => a.id === id);
    return agent === undefined ? login : { ...login, ...guestEnv(agent) };
  };
  const cloudRoad = async (entry: LiveWorkspace): Promise<DaemonReachView> => {
    const reach = await entry.ws.daemonReach();
    const token = await ctx.daemonTokenOf(entry.machine, DAEMON_TOKEN_PATH);
    return { url: reach.url, expiresAt: reach.expiresAt, ...(token !== undefined ? { daemonToken: token } : {}) };
  };
  const localRoad = async (): Promise<DaemonReachView> => {
    if (local?.daemonRoad === undefined) throw new Error("this host wired no daemon for its local workspace, so nothing on this computer can be dialled");
    return local.daemonRoad();
  };
  /** Puts this runtime's daemon on a fork and hands it this runtime's token: the deploy writes one of its own,
   * so the guest's file is replaced the moment the deploy is done rather than at the next dial. */
  const cloudDeploy = async (entry: LiveWorkspace): Promise<void> => {
    await opts.goldenRecipe!.deployDaemon!(entry.machine);
    ctx.daemonTokens.delete(entry.machine.id);
    await ctx.daemonTokenOf(entry.machine, DAEMON_TOKEN_PATH);
  };
  /** Whether the file one agent's shared login lives in stands under the home that agent reads on this computer.
   * The catalog names both the home and the file, and an agent with no shared login has no file to stand. Only a
   * login kept as a file is seen: one a tool put in this computer's keyring reads here as none. */
  const sharedLoginUnder = (home: string, agentId: string): boolean => {
    const shared = sharedOn(agentId);
    return shared !== undefined && existsSync(join(home, shared.file));
  };
  const placeDoorOf = (): PlaceDoor => {
    if (placeDoor === undefined) throw new Error(noKindLine("place"));
    return placeDoor;
  };
  /** Every run on a machine this runtime is reading, as the call that lets go of each. A poll on a turn left
   * running holds this process after its last line, and a turn on a machine is not this host's to end: closing
   * lets go and leaves them running, and whoever opens them next reads their logs from the first byte. Each
   * kind's wiring holds its own set; this one is for the kinds whose runs live on a machine. */
  const machineReading = new Set<() => void>();
  const modules: Record<WorkspaceKind, KindModule | undefined> = {
    cloud: {
      // A fork lands either at this host's own provider or on a computer somebody joined; the record says which,
      // and a place that forks nowhere refuses here rather than at the provider.
      backend: record => {
        if (record.place === undefined) return backend;
        const at = placeDoorOf().backendOf(record.place);
        if (at === undefined) throw new PlaceForksNowhereError(placeForksNowhereLine(placeDoorOf().nameOf(record.place)));
        return at;
      },
      execStream: (entry, o, waiting) => machineExecStream(entry.machine, { reading: machineReading, ...o }, waiting),
      folder: () => undefined,
      home: (_entry, id) => cloudHome(id),
      homeDir: () => GUEST_HOME,
      env: (entry, id) => cloudEnv(entry.record.place, id),
      // A fork at a provider is a copy of an image, and no sign-in is ever sealed into one, so the vault's key is
      // what a turn there runs on. A workspace on a computer somebody joined shares that computer's own logins,
      // and the word for each is the one its row carries.
      loginStands: (entry, id) => entry.record.place !== undefined && placeDoor?.signInsAt(entry.record.place)?.[id] === "signed-in",
      relayed: () => true,
      // The word, not a path: the deploy writes the shim onto the machine's PATH and the binary under it carries the
      // chip in its own path, so the one stable name for a fork's wsp is the word a turn's own shell runs. It dials
      // no host of its own, it opens a session on this machine's daemon and the daemon carries it up the socket
      // this host already holds.
      wspMcp: () => ({ command: "wsp", args: ["mcp"] }),
      turnReach: () => ({}),
      turnRoad: "relayed",
      keepsAgents: false,
      // A workspace whose computer answers its daemon frames has no daemon of its own to dial and no route worth
      // minting: nothing listens inside it, and the road to its files and its git is the link this host holds.
      hasDaemon: entry => ctx.servedByItsComputer(entry) === undefined && Boolean(entry.machine.previewUrl),
      sharedDaemon: false,
      daemonRoad: entry =>
        ctx.servedByItsComputer(entry) === undefined
          ? cloudRoad(entry)
          : Promise.reject(new Error(placeServesDaemonLine(entry.record.name, ctx.computerOf(entry)))),
      scratch: () => GUEST_TMP,
      daemonVersion: entry => ctx.helloVersion(entry),
      dropped: async () => {},
      // The bundle is the host's to wire; whether it can reach a given machine is canDeployDaemon's reading, since
      // one kind's machines can differ about it (a container a box's runtime boots mints no signed URL).
      ...(opts.goldenRecipe?.deployDaemon !== undefined ? { deployDaemon: async (entry: LiveWorkspace) => cloudDeploy(entry) } : {}),
      import: (entry, o, report) => ctx.copyImport(entry, o, report),
      roots: (entry, dests) => writeRoots(entry, dests),
      landProject: (entry, project, report) => cloneProject(entry, project, report),
      // The key the project was recorded with, which is the folder's own on the computer it was seeded from: a
      // fork holds the checkout at a path of the machine's, and keying off that path would give one project as
      // many memories as it has computers.
      memoryKey: (entry, agentId) => projectMemoryKey(agentId, ctx.projectHeld(entry.record.project)),
    },
    local:
      local === undefined
        ? undefined
        : {
            backend: () => local.backend,
            execStream: (_entry, o, waiting) => local.execStream(o, waiting),
            // A record here is a folder: the project's own or a worktree of its repo, the word its view carries and
            // where a thread on it starts; the same reading threadFolder takes.
            folder: record => ctx.checkoutOf(record),
            home: (_entry, id) => local.home(id),
            homeDir: () => local.homeDir,
            // The person's own login on the computer they are sitting at, read where that agent keeps it.
            loginStands: (_entry, id) => sharedLoginUnder(local.home(id), id),
            // The person's own login and nothing more: threads here share the person's ports, as panes in one
            // terminal do.
            env: () => local.env(),
            relayed: () => false,
            // This computer's own command, as the command line hands it: a thread here runs the wsp tools on this
            // computer, which dial the pair its launch carries rather than riding a machine's daemon. Marked, since here a
            // server missing that pair could otherwise dial the host on the person's own token; a fork's guest door has no
            // such fallback.
            wspMcp: () => {
              const wsp = opts.agents?.wspMcp;
              return wsp === undefined ? undefined : { ...wsp, args: [...wsp.args, SCOPED_MCP_ARG] };
            },
            // A turn here runs on the computer the host runs on, so it dials the host's loopback, and a host that
            // listens on none tells it nothing and hands it no token. The token is identity here, not confinement:
            // the turn runs as the person, who can read the host's own token file.
            turnReach: () => {
              const url = opts.agents?.here?.url;
              return url === undefined || url === "" ? undefined : { url };
            },
            turnRoad: "here",
            keepsAgents: true,
            hasDaemon: () => local.daemonRoad !== undefined,
            sharedDaemon: true,
            daemonRoad: localRoad,
            ...(local.restartDaemon !== undefined ? { restartDaemon: local.restartDaemon } : {}),
            scratch: () => local.backend.folder,
            // The binary beside this host, read by starting the daemon where nothing has: this process holds the
            // process, and the binary it spawns is staged beside the command and can be older than this wsp.
            daemonVersion: async () => (local.hereDaemon === undefined ? null : local.hereDaemon.version()),
            dropped: async () => {},
            import: (_entry, o, report) => registerImport(o, report),
            // The file this host's own daemon reads, which is the wiring's and not a path taken off the home it
            // browses: a host on another state file has its own, and neither rewrites the other's.
            roots: (entry, dests) => writeRoots(entry, dests, local.rootsPath),
            landProject: async () => {},
            // The original folder's key, which is the one the person's own terminal already writes under: every
            // copy of that folder and their own agent in it share one memory directory and one sessions list,
            // with nothing seeded and nothing moved.
            memoryKey: (entry, agentId) => projectMemoryKey(agentId, ctx.projectHeld(entry.record.project)),
          },
  };
  const moduleOf = (kind: WorkspaceKind): KindModule => {
    const found = modules[kind];
    if (found === undefined) throw new Error(noKindLine(kind));
    return found;
  };
  const backendFor = (record: WorkspaceRecord): MachineBackend => moduleOf(record.kind).backend(record);
  const openChannel = opts.daemonChannel ?? openDaemonChannel;
  /** The backend a kind's machines live on where no record is in hand yet: the create that is about to write one,
   * and the roads that ask what this host can do at all. The same reading a record gets, off the two facts a record
   * would carry. */
  const backendOfKind = (kind: WorkspaceKind, place?: string): MachineBackend =>
    moduleOf(kind).backend({ kind, ...(place !== undefined ? { place } : {}) } as WorkspaceRecord);
  /** Whether a fork on this backend stands on an image at all: a provider boots a template or a snapshot it keeps,
   * and a workspace on a computer somebody joined is a copy of that computer's own directories, so it names none
   * and nothing is looked up or built for it. The one reading of that road above the backend, so no road here
   * names a provider or a place to learn it. */
  const keepsImages = (at: MachineBackend): boolean => at.capabilities.images;
  /** Whether this backend's pause keeps the disk: a stop that snapshots it, so a wake resumes the same machine with
   * its home. Such a nap reads nothing of the home; the vault is taken off the running machine at a rebuild instead. */
  const pauseKeepsDisk = (at: MachineBackend): boolean => at.capabilities.pauseMode === "disk";
  /** Whether the machines of this backend come up under the workspace's own name. The one reading of that road
   * above the backend, beside the images one: a fork that is named at its boot is never named again from here. */
  const namesWorkspace = (at: MachineBackend): boolean => at.namesWorkspace === true;
  /** The budgets a kind's backend declares for its naps and wakes. Every reader sits behind the pause refusal or
   * behind a machine's preview route, so a kind without one here is a wiring fault, never a person's road. */
  const lifecycleOf = (entry: LiveWorkspace): Lifecycle => {
    const lifecycle = backendFor(entry.record).lifecycle;
    if (lifecycle === undefined) throw new Error(`${entry.record.kind} machines declare no lifecycle`);
    return lifecycle;
  };
  const execFactoryFor = (entry: LiveWorkspace, o?: MachineExecOptions, waiting?: TurnWaiting): ExecStreamFactory =>
    moduleOf(entry.record.kind).execStream(entry, opts.machineExec === undefined ? o : { ...opts.machineExec, ...o }, waiting);
  /** What one agent on a workspace of this project keys its sessions and its memory to. The project's own key
   * where that agent's catalog row names the variable that pins it, since that key was fixed when the project was
   * recorded and follows it onto whichever computer holds it; every other agent keys off the folder it is worked
   * at, which is the rule the resolver for that agent carries. Read off the catalog row and never off an agent's
   * id, and read here alone, so every kind answers the same way. */
  const projectMemoryKey = (agentId: string, project: ProjectView): string | undefined =>
    CATALOG_AGENTS.find(a => a.id === agentId)?.projectKeyEnv !== undefined ? project.memoryKey : projectStateKey(agentId, project.path);

  /** The folder a turn or a command starts in, the one rule every road reads: the folder the caller named, else
   * the folder this workspace holds its project in, which is the kind's own reading, else the project's own path.
   * The kind is asked rather than the project read directly, because on a computer that makes a workspace by
   * copying the project folder the workspace's folder is that copy and never the person's own checkout. Both
   * roads that launch a process through this runtime read it here, the turn and the exec verb, so the folder a
   * turn opens in and the one a command runs in cannot differ, and the app, the command line and the tool need
   * not restate it. */
  const threadFolder = async (entry: LiveWorkspace, o: { cwd?: string | undefined }): Promise<string> => {
    return o.cwd ?? moduleOf(entry.record.kind).folder(entry.record) ?? ctx.projectHeld(entry.record.project).path;
  };
  return {
    projectOf, remoteHere, gitHere, gitTopOf, branchAt, stateFolder, cloneHere, localRoad, placeDoorOf, machineReading,
    moduleOf, backendFor, openChannel, backendOfKind, keepsImages, pauseKeepsDisk, namesWorkspace, lifecycleOf,
    execFactoryFor, threadFolder,
  };
}


function transcriptsArea(ctx: RuntimeContext): TranscriptsArea {
  const {
    opts, store, bus, clock, live, threadRecords, sessions, indexFlushes, transcripts, rows, unreadIndexes,
    pendingEvents, pendingBytes, transcriptIndex, indexFor, transcriptBytes, sizeOf,
  } = ctx;
  const keptWrites = new Map<string, Promise<void>>();
  /** One chain per workspace, so two sends writing at once cannot lose each other's keys. */
  const onKept = (workspaceId: string, step: (held: KeptImages) => Promise<KeptImages | undefined>): Promise<void> => {
    const next = (keptWrites.get(workspaceId) ?? Promise.resolve())
      .then(async () => {
        const held = ((await store.get(ATTACHMENT_KEYS, workspaceId)) as KeptImages | undefined) ?? { threads: {} };
        // A step that wrote its own document answers nothing here.
        const now = await step(held);
        if (now === undefined) return;
        if (Object.keys(now.threads).length === 0) await store.delete(ATTACHMENT_KEYS, workspaceId);
        else await store.put(ATTACHMENT_KEYS, workspaceId, now);
      })
      .catch((e: unknown) => console.warn(`the images ${workspaceId}'s messages carried were not kept as asked: ${e instanceof Error ? e.message : String(e)}`));
    keptWrites.set(workspaceId, next);
    return next;
  };
  /** Keeps the images a send carried, for every client to draw again; a send no client could name keeps none. */
  const keepSentImages = (workspaceId: string, threadId: string, requestId: string | undefined, attachments: readonly Attachment[]): Promise<void> => {
    const kept = attachments.flatMap((a, index) => {
      const key = attachmentKey(threadId, requestId, index);
      return isImage(a.mediaType) && key !== undefined ? [{ key, mediaType: a.mediaType, bytes: a.bytes }] : [];
    });
    if (kept.length === 0) return Promise.resolve();
    return onKept(workspaceId, async held => {
      const had = (held.threads[threadId] ?? []).filter(h => !kept.some(k => k.key === h.key));
      // The entry before the bytes: a crash between the two leaves an entry whose blob is missing, which reads as not
      // found and goes with its thread, never a blob no document names and nothing can sweep.
      await store.put(ATTACHMENT_KEYS, workspaceId, { threads: { ...held.threads, [threadId]: [...had, ...kept.map(({ key, mediaType }) => ({ key, mediaType }))] } });
      for (const k of kept) await store.putBlob(ATTACHMENTS, k.key, Buffer.from(k.bytes, "base64"));
      return undefined;
    });
  };
  /** Takes these images away, a send's records having left the transcript, so no row can ask for them again. */
  const dropKeptKeys = (workspaceId: string, keys: readonly string[]): Promise<void> =>
    onKept(workspaceId, async held => {
      const going = new Set(keys);
      if (!Object.values(held.threads).some(list => list.some(k => going.has(k.key)))) return undefined;
      for (const key of going) await store.deleteBlob(ATTACHMENTS, key);
      const threads = Object.entries(held.threads).flatMap(([id, list]) => {
        const left = list.filter(k => !going.has(k.key));
        return left.length === 0 ? [] : [[id, left] as const];
      });
      return { threads: Object.fromEntries(threads) };
    });
  /** The keys of the images a start's message carried, which the host keeps while the start is in the transcript. */
  const imageKeysOf = (e: SessionEvent): string[] =>
    e.type !== "session.start" || e.threadId === undefined
      ? []
      : (e.attachments ?? []).flatMap((a, index) => {
          const key = isImage(a.mediaType) ? attachmentKey(e.threadId!, e.requestId, index) : undefined;
          return key === undefined ? [] : [key];
        });
  /** A trim's `gone` that lets the dropped starts' images go once the trim is done. */
  const trimming = (workspaceId: string, also?: (e: SessionEvent) => void): { gone: (e: SessionEvent) => void; done: () => void } => {
    const keys: string[] = [];
    return {
      gone: e => {
        also?.(e);
        keys.push(...imageKeysOf(e));
      },
      done: () => void (keys.length > 0 ? dropKeptKeys(workspaceId, keys) : undefined),
    };
  };
  /** Takes these threads' kept images away, or every one of the workspace's. */
  const dropSentImages = (workspaceId: string, threadIds: readonly string[] | "all"): Promise<void> =>
    onKept(workspaceId, async held => {
      const going = threadIds === "all" ? Object.keys(held.threads) : threadIds.filter(id => held.threads[id] !== undefined);
      if (going.length === 0) return undefined;
      for (const id of going) for (const k of held.threads[id] ?? []) await store.deleteBlob(ATTACHMENTS, k.key);
      return { threads: Object.fromEntries(Object.entries(held.threads).filter(([id]) => !going.includes(id))) };
    });

  /** Drops events until the rest are inside both caps, in place, and answers the bytes left; each dropped event goes
   * to `gone`. Every thread of a project's folder shares one transcript, and trimming it oldest first let a busy
   * thread take a quiet thread's every event while its row stayed, so that thread opened on a blank page. So what
   * goes first is the oldest event of the thread holding the most, outside each thread's newest turn, which no
   * other thread's traffic takes; only a transcript still over its caps with nothing else left loses the oldest of
   * what remains. The newest event stays. */
  const dropOldest = (events: SessionEvent[], bytes: number = events.reduce((n, e) => n + eventBytes(e), 0), gone?: (e: SessionEvent) => void): number =>
    // Sizes are read only where the bytes are what is over: a transcript over its count alone is trimmed by count.
    dropOldestOf(events, bytes, bytes > TRANSCRIPT_BYTES ? sizeOf : eventBytes, gone);
  /** dropOldest over anything that names a thread and a type, each weighed by `weigh`. */
  const dropOldestOf = <E extends { threadId?: string; type: string }>(events: E[], bytes: number, weigh: (e: E) => number, gone?: (e: E) => void): number => {
    if (events.length <= TRANSCRIPT_CAP && bytes <= TRANSCRIPT_BYTES) return bytes;
    // Each thread's newest turn starts at its last start, or is its last event where it has none.
    const lastStart = new Map<string, number>();
    const lastEvent = new Map<string, number>();
    events.forEach((e, i) => {
      const key = e.threadId ?? "";
      lastEvent.set(key, i);
      if (e.type === "session.start") lastStart.set(key, i);
    });
    const byteBound = bytes > TRANSCRIPT_BYTES;
    const threads = new Map<string, { at: number[]; next: number; bytes: number }>();
    events.forEach((e, i) => {
      const key = e.threadId ?? "";
      if (i >= (lastStart.get(key) ?? lastEvent.get(key)!)) return;
      const held = threads.get(key) ?? { at: [], next: 0, bytes: 0 };
      held.at.push(i);
      if (byteBound) held.bytes += weigh(e);
      threads.set(key, held);
    });
    const dropped = new Set<number>();
    let count = events.length;
    const drop = (i: number): void => {
      dropped.add(i);
      bytes -= weigh(events[i]!);
      count--;
    };
    while (count > TRANSCRIPT_CAP || bytes > TRANSCRIPT_BYTES) {
      const byBytes = bytes > TRANSCRIPT_BYTES;
      let most: { at: number[]; next: number; bytes: number } | undefined;
      for (const held of threads.values()) {
        if (held.next >= held.at.length) continue;
        if (most === undefined || (byBytes ? held.bytes > most.bytes : held.at.length - held.next > most.at.length - most.next)) most = held;
      }
      if (most === undefined) break;
      const i = most.at[most.next++]!;
      if (byteBound) most.bytes -= weigh(events[i]!);
      drop(i);
    }
    for (let i = 0; i < events.length - 1 && (count > TRANSCRIPT_CAP || bytes > TRANSCRIPT_BYTES); i++) if (!dropped.has(i)) drop(i);
    if (dropped.size === 0) return bytes;
    let kept = 0;
    for (let i = 0; i < events.length; i++) {
      if (dropped.has(i)) gone?.(events[i]!);
      else events[kept++] = events[i]!;
    }
    events.length = kept;
    return bytes;
  };
  /** dropOldest with the dropped starts' images let go after it. */
  const trimmed = (workspaceId: string, events: SessionEvent[], bytes?: number, also?: (e: SessionEvent) => void): number => {
    const trim = trimming(workspaceId, also);
    const left = dropOldest(events, bytes, trim.gone);
    trim.done();
    return left;
  };
  const trimTranscript = (workspaceId: string, events: SessionEvent[]): void =>
    void transcriptBytes.set(workspaceId, trimmed(workspaceId, events, transcriptBytes.get(workspaceId), e => forgetChild(indexFor(workspaceId), e)));
  /** A transcript held as the one opened last, the oldest of the others let go past the cap. */
  const holdTranscript = (workspaceId: string, events: SessionEvent[]): void => {
    transcripts.delete(workspaceId);
    transcripts.set(workspaceId, events);
    for (const id of transcripts.keys()) {
      if (transcripts.size <= TRANSCRIPTS_HELD) break;
      transcripts.delete(id);
      transcriptBytes.delete(id);
    }
  };
  /** A workspace's transcript, from its own file beside the state file: kept inside the state file, every turn's
   * flush rewrote every workspace's transcript with it, and a host whose file had grown to hundreds of megabytes
   * spent its loop on that for minutes. */
  const transcriptBlob = (record: TranscriptRecord): Buffer => Buffer.from(JSON.stringify(record));
  /** A transcript file's events, nothing where there is no file, and a refusal where there is a file that did not
   * read: a caller that took the two for one wrote what it held over everything the file had. A file that reads and
   * does not parse never will, and refusing it would keep every later event unwritten, so its bytes are moved aside
   * under a name of their own and it counts as no file. */
  const readTranscript = async (workspaceId: string, collection: string = TRANSCRIPTS): Promise<SessionEvent[] | undefined> => {
    let bytes: Buffer | undefined;
    try {
      bytes = await store.getBlob(collection, workspaceId);
      if (bytes === undefined && (await store.statBlob(collection, workspaceId)) === undefined) return undefined;
    } catch (e) {
      throw new Error(transcriptUnreadLine(workspaceId, e instanceof Error ? e.message : String(e)));
    }
    if (bytes === undefined) throw new Error(transcriptUnreadLine(workspaceId, "the file is there and could not be read"));
    try {
      const events = (JSON.parse(bytes.toString("utf8")) as Partial<TranscriptRecord>).events;
      if (!Array.isArray(events)) throw new Error("it holds no events");
      return numbered(events);
    } catch (e) {
      const aside = `${workspaceId}.${Date.now()}`;
      await store.putBlob(`${collection}-unparsed`, aside, bytes);
      await store.deleteBlob(collection, workspaceId);
      console.warn(`the transcript of ${workspaceId} does not parse (${e instanceof Error ? e.message : String(e)}), so its bytes are kept as ${collection}-unparsed/${aside} and it starts again empty`);
      return undefined;
    }
  };
  /** The index written beside a transcript, marked with the transcript file as it stands now. */
  const writeIndex = async (workspaceId: string, index: TranscriptIndex): Promise<void> => {
    const bytes = indexBytes(index, await store.statBlob(TRANSCRIPTS, workspaceId));
    await store.putBlob(TRANSCRIPT_INDEX, workspaceId, bytes);
  };
  /** A transcript an older build kept inside the state file, merged into what its files already hold: an older build
   * run on this state after this one writes its new events there again, and a move cut short by a crash leaves both
   * copies. Every event is kept once, by its JSON, in the order its stamp says. The tail inside the byte cap is what
   * this host holds and flushes; everything before it goes to the head file, which nothing trims. */
  const moveTranscript = async (moving: TranscriptRecord): Promise<void> => {
    const id = moving.workspaceId;
    const seen = new Set<string>();
    const all: SessionEvent[] = [];
    for (const read of [...((await readTranscript(id, TRANSCRIPT_HEADS)) ?? []), ...((await readTranscript(id)) ?? []), ...moving.events]) {
      // Positions are given again below, so the same event read off two copies is still one.
      const e = { ...read };
      delete e.pos;
      const key = JSON.stringify(e);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(e);
    }
    all.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    all.forEach((e, i) => (e.pos = i + 1));
    const held = [...all];
    dropOldest(held);
    const kept = new Set(held);
    const head = all.filter(e => !kept.has(e));
    if (head.length > 0) await store.putBlob(TRANSCRIPT_HEADS, id, transcriptBlob({ workspaceId: id, events: head }));
    await store.putBlob(TRANSCRIPTS, id, transcriptBlob({ workspaceId: id, events: held }));
    const index = indexOf(held);
    transcriptIndex.set(id, index);
    await writeIndex(id, index);
  };
  /** The index a workspace's transcript left beside it where it was read off the file as it stands, else one read off
   * the transcript itself: an index older than its file answers search and a send from before the last turn. */
  const loadIndex = async (workspaceId: string): Promise<void> => {
    if (rows !== undefined) return loadRowsIndex(rows, workspaceId);
    try {
      const mark = await store.statBlob(TRANSCRIPTS, workspaceId).catch((e: unknown) => {
        throw new Error(transcriptUnreadLine(workspaceId, e instanceof Error ? e.message : String(e)));
      });
      if (mark === undefined) return;
      const bytes = await store.getBlob(TRANSCRIPT_INDEX, workspaceId);
      const kept = bytes === undefined ? undefined : indexRead(bytes);
      if (kept?.of !== undefined && kept.of.bytes === mark.bytes && kept.of.at === mark.at) {
        transcriptIndex.set(workspaceId, kept.index);
        return;
      }
      const index = indexOf((await readTranscript(workspaceId)) ?? []);
      transcriptIndex.set(workspaceId, index);
      await writeIndex(workspaceId, index).catch((e: unknown) => console.warn(`the transcript index of ${workspaceId} was not written: ${e instanceof Error ? e.message : String(e)}`));
    } catch (e) {
      console.warn(`${e instanceof Error ? e.message : String(e)}, so search and a send leave it out until it reads`);
    }
  };
  /** On rows the index is written in the transaction that changes them, so the one kept is the one read; a workspace
   * whose rows have none (the move found none that matched its blob) has one read off the rows and written. */
  const loadRowsIndex = (rows: TranscriptRows, workspaceId: string): void => {
    let newest: number | undefined;
    try {
      newest = rows.newestPos(workspaceId);
      const json = rows.index(workspaceId);
      const kept = json === undefined ? undefined : indexRead(Buffer.from(json));
      if (kept !== undefined) return void transcriptIndex.set(workspaceId, kept.index);
      const { events } = rows.all(workspaceId);
      if (events.length === 0) return;
      const index = indexOf(events);
      rows.putIndex(workspaceId, indexBytes(index, undefined).toString("utf8"));
      transcriptIndex.set(workspaceId, index);
    } catch (e) {
      console.warn(`${transcriptUnreadLine(workspaceId, e instanceof Error ? e.message : String(e))}, so search and a send leave it out until it reads`);
      // Positions go on after the newest row: issued again from one, the next flush would meet rows already kept and
      // write none of its events.
      if (newest !== undefined) transcriptIndex.set(workspaceId, { ...emptyIndex(), pos: newest });
      unreadIndexes.add(workspaceId);
    }
  };
  /** The transcripts an earlier build kept as blobs, moved into rows once: what was moved is said in one line. */
  const moveBlobs = (rows: TranscriptRows): void => {
    const done = rows.moveBlobs();
    for (const u of done.setAside) console.warn(`the transcript of ${u.workspaceId} could not move into the state database (${u.why}), so its bytes are kept as ${TRANSCRIPTS}-unparsed/${u.aside} and it starts again empty`);
    if (done.moved > 0) console.warn(`moved ${done.moved === 1 ? "1 transcript" : `${done.moved} transcripts`} (${done.events} events) into the state database`);
  };
  // Every read and write of one workspace's transcript file takes its turn here, so the later snapshot always lands
  // last whatever order the store finishes in, and a read never lands between a flush's write and the moment the
  // events it wrote stop counting as unwritten.
  const transcriptQueue = new Map<string, Promise<void>>();
  const onTranscriptQueue = <T>(workspaceId: string, step: () => Promise<T>): Promise<T> => {
    const run = (transcriptQueue.get(workspaceId) ?? Promise.resolve()).then(step);
    transcriptQueue.set(workspaceId, run.then(() => {}, () => {}));
    return run;
  };
  /** A workspace's transcript whole: held already, or its file and what was written since, read on demand. The copy
   * this answers is the one to use: another open can let it go from the held ones at any await, so a caller never
   * looks it up again. */
  const openTranscript = (workspaceId: string): Promise<SessionEvent[]> => {
    if (rows !== undefined) return Promise.resolve(openRows(rows, workspaceId));
    const held = transcripts.get(workspaceId);
    if (held !== undefined) {
      holdTranscript(workspaceId, held);
      return Promise.resolve(held);
    }
    return onTranscriptQueue(workspaceId, () => openInQueue(workspaceId));
  };
  /** The open itself, run inside the queue. A transcript that exists is held as the one opened last; one with no file
   * and nothing written, or of a workspace deleted meanwhile, is answered and not held. */
  const openInQueue = async (workspaceId: string): Promise<SessionEvent[]> => {
    const landed = transcripts.get(workspaceId);
    if (landed !== undefined) return landed;
    const read = await readTranscript(workspaceId);
    const events = [...(read ?? []), ...(pendingEvents.get(workspaceId) ?? [])];
    const bytes = trimmed(workspaceId, events);
    if (events.length > 0 && transcriptIndex.has(workspaceId)) {
      holdTranscript(workspaceId, events);
      transcriptBytes.set(workspaceId, bytes);
    }
    return events;
  };
  /** On a store that keeps transcripts as rows, none is held: an open reads the rows, with what was written since
   * after them, trimmed as a flush would trim them. Nothing is let go: a start the read drops is still a row until a
   * flush drops it, and its images go then. */
  const openRows = (rows: TranscriptRows, workspaceId: string): SessionEvent[] => {
    const kept = rows.all(workspaceId);
    const pending = pendingEvents.get(workspaceId) ?? [];
    const events = [...kept.events, ...pending];
    dropOldest(events, kept.size + (pendingBytes.get(workspaceId) ?? 0));
    return events;
  };
  /** One thread's events read off the transcript as openTranscript answers it, or on rows off the thread's index, the
   * events written since the last flush first. */
  const transcriptReader: TranscriptReader = {
    read: async (workspaceId, threadId, o) => {
      const pos = transcriptIndex.get(workspaceId)?.pos ?? 0;
      if (rows === undefined) return { ...readThread(await openTranscript(workspaceId), threadId, o), pos };
      const pending = (pendingEvents.get(workspaceId) ?? []).filter(e => e.threadId === threadId);
      const newest = function* (): Generator<SessionEvent> {
        for (let i = pending.length - 1; i >= 0; i--) yield pending[i]!;
        yield* rows.newest(workspaceId, threadId, o.before);
      };
      return { events: pickNewest(newest(), o), total: rows.count(workspaceId, threadId) + pending.length, pos };
    },
  };
  /** Inside the queue: `events` written as the transcript, the first `took` events written since the last flush
   * cleared the moment the file has them, and the index made again off what was written. */
  const writeTranscript = async (workspaceId: string, events: SessionEvent[], took: number): Promise<void> => {
    await store.putBlob(TRANSCRIPTS, workspaceId, transcriptBlob({ workspaceId, events }));
    // Before the index is written, so an index write that fails cannot leave these to be written a second time.
    const pending = pendingEvents.get(workspaceId);
    pending?.splice(0, took);
    if (pending !== undefined && pending.length === 0) {
      pendingEvents.delete(workspaceId);
      pendingBytes.delete(workspaceId);
    } else if (pending !== undefined) pendingBytes.set(workspaceId, pending.reduce((n, e) => n + eventBytes(e), 0));
    const index = indexOf(events);
    index.pos = Math.max(index.pos, transcriptIndex.get(workspaceId)?.pos ?? 0);
    // An index that did not land keeps its old mark, and boot reads that transcript again.
    await writeIndex(workspaceId, index).catch((e: unknown) => console.warn(`the transcript index of ${workspaceId} was not written: ${e instanceof Error ? e.message : String(e)}`));
    // What arrived during the writes is folded on after them, as record folded it on the index this replaces.
    for (const e of pendingEvents.get(workspaceId) ?? []) foldEvent(index, e);
    if (transcriptIndex.has(workspaceId)) transcriptIndex.set(workspaceId, index);
  };
  /** Takes the events `drops` names out of a transcript, the file and what was written since alike, and writes it: one
   * turn of the queue on the copy the open answered, so nothing can let that copy go between the change and the
   * write, and no flush runs between them. */
  const dropFromTranscript = (workspaceId: string, drops: (e: SessionEvent) => boolean): Promise<void> =>
    onTranscriptQueue(workspaceId, async () => {
      if (rows !== undefined) return settleRows(rows, workspaceId, drops);
      const events = await openInQueue(workspaceId);
      for (let i = events.length - 1; i >= 0; i--) if (drops(events[i]!)) events.splice(i, 1);
      transcriptBytes.delete(workspaceId);
      const pending = pendingEvents.get(workspaceId) ?? [];
      for (let i = pending.length - 1; i >= 0; i--) if (drops(pending[i]!)) pending.splice(i, 1);
      await writeTranscript(workspaceId, [...events], pending.length);
    });
  /** Inside the queue, on rows: what was written since the last flush appended, the events `drops` names taken out
   * and the oldest past the caps dropped, in one transaction with the index beside them. The rows are read again for
   * the index only where events went, since record folded every event that came. */
  const settleRows = (rows: TranscriptRows, workspaceId: string, drops?: (e: SessionEvent) => boolean): void => {
    const pending = pendingEvents.get(workspaceId) ?? [];
    const trim = trimming(workspaceId);
    let index = transcriptIndex.get(workspaceId) ?? emptyIndex();
    rows.atomically(() => {
      rows.append(workspaceId, drops === undefined ? pending : pending.filter(e => !drops(e)));
      let lost = drops !== undefined && pending.some(drops);
      if (drops !== undefined) {
        const going = rows.all(workspaceId).events.filter(drops);
        rows.remove(workspaceId, going.map(e => e.pos!));
        lost ||= going.length > 0;
      }
      const { count, size } = rows.total(workspaceId);
      if (count > TRANSCRIPT_CAP || size > TRANSCRIPT_BYTES) {
        const going: EventSize[] = [];
        dropOldestOf(rows.sizes(workspaceId), size, e => e.size, e => void going.push(e));
        // Only a start carries images, so only starts are read before they go.
        for (const e of rows.at(workspaceId, going.filter(g => g.type === "session.start").map(g => g.pos))) trim.gone(e);
        rows.remove(workspaceId, going.map(g => g.pos));
        lost ||= going.length > 0;
      }
      if (lost) {
        const issued = index.pos;
        index = indexOf(rows.all(workspaceId).events);
        index.pos = Math.max(index.pos, issued);
        unreadIndexes.delete(workspaceId);
      }
      if (!unreadIndexes.has(workspaceId)) rows.putIndex(workspaceId, indexBytes(index, undefined).toString("utf8"));
    });
    trim.done();
    pendingEvents.delete(workspaceId);
    pendingBytes.delete(workspaceId);
    if (transcriptIndex.has(workspaceId)) transcriptIndex.set(workspaceId, index);
  };
  const transcriptTimers = new Map<string, () => void>();
  // One token per machine, written to a guest the first time a client asks to reach its daemon; the file the
  // guest carried before (the golden's, or an earlier run's) stops working then. Per machine and not per process:
  // a machine whose root is hostile reads its own token file, and that token opens no other machine of this host.
  const daemonSeed = opts.daemonToken;
  if (daemonSeed !== undefined) assertTokenShape(daemonSeed);
  const machineTokens = new Map<string, string>();
  /** The token this machine is given, made once and kept: derived from the seed a caller pinned, or random. */
  const tokenForMachine = (machineId: string): string => {
    const held = machineTokens.get(machineId);
    if (held !== undefined) return held;
    const minted = daemonSeed === undefined ? randomBytes(24).toString("hex") : daemonTokenFor(daemonSeed, machineId);
    machineTokens.set(machineId, minted);
    return minted;
  };
  // Whether each machine answered a daemon, keyed by machine id: a resurrect or upgrade brings a fresh guest and file.
  const daemonTokens = new Map<string, { hasDaemon: boolean; at: number }>();
  const daemonTokenOf = async (machine: Machine, path?: string): Promise<string | undefined> => {
    const token = tokenForMachine(machine.id);
    const cached = daemonTokens.get(machine.id);
    if (cached && (cached.hasDaemon || Date.now() - cached.at < DAEMON_TOKEN_MISS_TTL_MS)) return cached.hasDaemon ? token : undefined;
    const hasDaemon = await rotateDaemonToken(machine, token, daemonTokenPathOf(machine, path));
    daemonTokens.set(machine.id, { hasDaemon, at: Date.now() });
    return hasDaemon ? token : undefined;
  };

  const cancelFlush = (workspaceId: string): void => {
    transcriptTimers.get(workspaceId)?.();
    transcriptTimers.delete(workspaceId);
  };

  /** The flushes queued and not yet begun, so a burst of asks is one write. */
  const flushesQueued = new Map<string, Promise<void>>();
  /** The transcripts whose file did not read at their last flush, so the refusal is said once. */
  const unreadSaid = new Set<string>();
  // The copy is taken when the flush's turn comes, not per event: a store may serialise after it returns, and the
  // events keep arriving under it. A transcript not held is its file with what was written since appended.
  const flushTranscript = (workspaceId: string): Promise<void> => {
    cancelFlush(workspaceId);
    const queued = flushesQueued.get(workspaceId);
    if (queued !== undefined) return queued;
    const flush = onTranscriptQueue(workspaceId, async () => {
      flushesQueued.delete(workspaceId);
      if (rows !== undefined) return pendingEvents.has(workspaceId) ? settleRows(rows, workspaceId) : undefined;
      const held = transcripts.get(workspaceId);
      if (held === undefined && !pendingEvents.has(workspaceId)) return;
      let events: SessionEvent[];
      if (held !== undefined) events = [...held];
      else {
        let read: SessionEvent[] | undefined;
        try {
          read = await readTranscript(workspaceId);
        } catch (e) {
          // What was written since stays unwritten for the next flush, and the file keeps what it has. Said once
          // until a flush lands, since every event past the threshold asks again.
          if (!unreadSaid.has(workspaceId)) console.warn(`${e instanceof Error ? e.message : String(e)}, so nothing is written over it and its newest events wait for the next flush`);
          unreadSaid.add(workspaceId);
          return;
        }
        events = [...(read ?? []), ...(pendingEvents.get(workspaceId) ?? [])];
        trimmed(workspaceId, events);
      }
      unreadSaid.delete(workspaceId);
      await writeTranscript(workspaceId, events, pendingEvents.get(workspaceId)?.length ?? 0);
    });
    const settled = flush.catch(() => {});
    flushesQueued.set(workspaceId, settled);
    return settled;
  };

  const capSessions = (workspaceId: string): void => {
    const rows = [...sessions].filter(([, s]) => s.view.workspaceId === workspaceId);
    const excess = rows.length - SESSION_INDEX_CAP;
    if (excess <= 0) return;
    const finished = rows.filter(([, s]) => s.view.status !== "running").sort(([, a], [, b]) => (a.view.startedAt ?? 0) - (b.view.startedAt ?? 0));
    for (const [id] of finished.slice(0, excess)) sessions.delete(id);
  };

  // Rows are copied at queue time, like the transcript: the store may serialise after it returns. A harness that
  // settles after its workspace was deleted must not write the document back.
  /** Every workspace's viewed marks, by path against the blob id each file had when it was marked; kept on the session
   * index so they outlive the host and go with the workspace. */
  const viewedMarks = new Map<string, Record<string, string>>();

  const persistSessions = (workspaceId: string): Promise<void> => {
    if (!live.has(workspaceId)) return Promise.resolve();
    capSessions(workspaceId);
    const rows = [...sessions.values()]
      .filter(s => s.view.workspaceId === workspaceId && s.launch === undefined)
      .map(s => ({
        ...s.view,
        turnId: s.turnId,
        ...(s.notify !== undefined ? { notify: s.notify } : {}),
        ...(s.notifyBy !== undefined ? { notifyBy: s.notifyBy } : {}),
        ...(s.notifyRoad !== undefined ? { notifyRoad: s.notifyRoad } : {}),
        ...(s.view.status === "running" && s.turnLive?.reply !== undefined ? { reply: s.turnLive.reply } : {}),
        ...(s.view.status === "running" && s.run !== undefined ? { run: s.run } : {}),
        ...(s.view.status === "running" && s.from !== undefined ? { from: s.from } : {}),
        ...(s.view.status === "running" && s.asked !== undefined ? { asked: s.asked } : {}),
        ...(s.view.status === "running" && s.turnToken !== undefined ? { turnToken: s.turnToken } : {}),
        // Beside the turn token and for the same reason: the process out there still holds this device, so a host
        // that re-opens the turn has to know which one to take away when it ends.
        ...(s.view.status === "running" && s.scopeDeviceId !== undefined ? { scopeDeviceId: s.scopeDeviceId } : {}),
        ...(s.snapshot !== undefined ? { snapshot: s.snapshot } : {}),
      }));
    const threads: Record<string, ThreadRecord> = {};
    for (const [threadId, { workspaceId: on, ...held }] of threadRecords) if (on === workspaceId) threads[threadId] = held;
    const marks = viewedMarks.get(workspaceId);
    const snapshot: SessionIndexRecord = { workspaceId, sessions: rows, threads, ...(marks !== undefined && Object.keys(marks).length > 0 ? { viewed: marks } : {}) };
    const queued = (indexFlushes.get(workspaceId) ?? Promise.resolve())
      .then(() => store.put(SESSIONS, workspaceId, snapshot))
      .catch(() => {});
    indexFlushes.set(workspaceId, queued);
    return queued;
  };

  // Deltas are only appended in memory; the store sees the transcript at turn
  // boundaries, so a crash mid-turn loses that turn's partial output and
  // nothing else. A session's end is written at once, anything before it waits
  // for the debounce.
  const record = (unstamped: SessionEvent): void => {
    const event: SessionEvent = { ...unstamped, at: Date.now(), pos: indexFor(unstamped.workspaceId).pos + 1 };
    const id = event.workspaceId;
    // A subagent's text and thinking are clipped as a tool result is, so a subagent that thinks for pages cannot push its
    // lead's own lines out of the ring.
    const clipped = event.type === "session.delta" && event.text.length > TOOL_RESULT_KEPT && (event.kind === "tool_result" || (event.parentToolUseId !== undefined && (event.kind === "text" || event.kind === "thinking")));
    const kept = clipped ? { ...event, text: event.text.slice(0, TOOL_RESULT_KEPT) } : event;
    const size = eventBytes(kept);
    const held = transcripts.get(id);
    if (held !== undefined) {
      held.push(kept);
      const had = transcriptBytes.get(id);
      if (had !== undefined) transcriptBytes.set(id, had + size);
      trimTranscript(id, held);
    }
    const pending = pendingEvents.get(id) ?? [];
    pending.push(kept);
    pendingEvents.set(id, pending);
    const unwritten = (pendingBytes.get(id) ?? 0) + size;
    pendingBytes.set(id, unwritten);
    foldEvent(indexFor(id), kept);
    if (event.type === "session.end" || unwritten > PENDING_FLUSH_BYTES) void flushTranscript(event.workspaceId);
    else if (event.type !== "session.delta" && !transcriptTimers.has(event.workspaceId)) {
      transcriptTimers.set(event.workspaceId, clock.schedule(() => void flushTranscript(event.workspaceId), TRANSCRIPT_FLUSH_MS));
    }
    bus.emit(event);
    if ((event.type === "session.start" || event.type === "session.end") && event.threadId !== undefined) ctx.pushHead(event.threadId);
  };

  /** The newest accrued cost each workspace's meter pushed, for a slate's cost source. */
  const accrued = new Map<string, number>();
  bus.on("workspace.cost", e => {
    if (e.type === "workspace.cost") accrued.set(e.workspaceId, e.accruedUsd);
  });
  /** The model, effort and window a thread's own turns ran with, read off its rows as the composer reads them: for
   * each, the last turn that named one, the window split back off the model the CLI announced. */
  const ownPicks = (workspaceId: string, threadId: string): { model?: string; effort?: string; contextWindow?: string } => {
    const rows = ctx.rowsOn(threadId).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const ran = rows.filter(r => r.model !== undefined).at(-1);
    const session = ctx.startedAs(workspaceId, threadId);
    const model = ran?.model ?? (session === undefined ? undefined : ctx.resumedFact(workspaceId, session, "model"));
    const effort = rows.filter(r => r.effort !== undefined).at(-1)?.effort;
    const window = ran?.contextWindow ?? /\[([^\]]+)\]$/.exec(model ?? "")?.[1];
    return { ...(model !== undefined ? { model: baseModel(model) } : {}), ...(effort !== undefined ? { effort } : {}), ...(window !== undefined ? { contextWindow: window } : {}) };
  };
  /** The workspace a thread runs on where that is a machine of its own, not this computer. */
  const boxOf = (threadId: string): LiveWorkspace | undefined => {
    const workspaceId = ctx.latestOn(threadId)?.workspaceId ?? threadRecords.get(threadId)?.workspaceId;
    const entry = workspaceId === undefined ? undefined : live.get(workspaceId);
    return entry === undefined || isLocalWorkspace(entry.record) ? undefined : entry;
  };
  return {
    keptWrites, keepSentImages, dropSentImages, moveTranscript, loadIndex, moveBlobs, transcriptQueue, openTranscript,
    transcriptReader, dropFromTranscript, transcriptTimers, daemonTokens, daemonTokenOf, cancelFlush, flushTranscript,
    viewedMarks, persistSessions, record, accrued, ownPicks, boxOf,
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

function reachArea(ctx: RuntimeContext): ReachArea {
  const { bus, clock, daemonHelloTimeoutMs, live, sessions } = ctx;
  /** A status pushed outside the poll, for a phase change the poller would show
   * late. Machine state is what the phase implies: asking the provider here
   * would reset its idle timer for a fact the runtime already knows. The nap
   * countdown rides along as the poller sends it: a client replaces the whole
   * status, so leaving it out would blank the row until the next poll. */
  /** The reach the poll last measured for a workspace's running machine; a machine that is not running, or one
   * replaced since, leaves nothing here. Held because a status pushed between polls has to say something about the
   * reach and the runtime has no probe of its own. */
  const polledReach = new Map<string, { machineId: string; reach: ReachState }>();

  /** A pause the provider refused outright stands for that machine until one lands: Solari refuses every pause past its size cap (measured 2026-09-23). */
  const napRefusals = new Map<string, { machineId: string; said: string }>();
  const napRefusedOf = (entry: LiveWorkspace): string | undefined => {
    const refused = napRefusals.get(entry.record.id);
    if (refused === undefined) return undefined;
    if (refused.machineId === entry.machine.id) return refused.said;
    napRefusals.delete(entry.record.id);
    return undefined;
  };
  const napRefusedReason = (entry: LiveWorkspace): string | undefined => {
    const said = napRefusedOf(entry);
    return said === undefined ? undefined : napRefusedLine(said);
  };
  /** A stop the provider would not take while the snapshot of the disk fails, by workspace, held like a refused pause:
   * on the row from the first one, for the machine it was said of, until a pause lands. */
  const stopRefusals = new Map<string, { machineId: string; said: string }>();
  const stopRefusedReason = (entry: LiveWorkspace): string | undefined => {
    const refused = stopRefusals.get(entry.record.id);
    return refused === undefined || refused.machineId !== entry.machine.id ? undefined : stopRefusedLine(refused.said);
  };
  /** How full the disk of a machine whose stop snapshots it read at its last turn's end, by workspace and machine. */
  const disks = new Map<string, { machineId: string; pct: number }>();
  const diskReason = (entry: LiveWorkspace): string | undefined => {
    const read = disks.get(entry.record.id);
    return read === undefined || read.machineId !== entry.machine.id || !(read.pct > DISK_FULL_PCT) ? undefined : diskFullLine(read.pct);
  };
  /** Reads the disk at a turn's end, where the stop snapshots it: what a turn wrote is what fills it, and the nap that
   * may fail on a full one comes a window after. A row crossing the line either way is pushed at once. */
  const readDisk = async (entry: LiveWorkspace): Promise<void> => {
    if (!ctx.pauseKeepsDisk(ctx.backendFor(entry.record)) || entry.record.phase !== "running") return;
    const res = await entry.machine.exec(DISK_USE_CMD, { timeoutMs: INLINE_EXEC_MS }).catch(() => undefined);
    const pct = res?.exitCode === 0 ? diskUsePct(res.stdout) : undefined;
    if (pct === undefined) return;
    const was = diskReason(entry);
    disks.set(entry.record.id, { machineId: entry.machine.id, pct });
    const now = diskReason(entry);
    if (now !== was && entry.record.phase === "running") await emitStatus(entry, reachOf(entry), ctx.rowReason(entry));
  };

  /** The reach a status pushed for a running machine carries: what the poll last measured, and where it has
   * measured nothing, the claim this kind's road makes. A measurement outranks the claim because the pushes that
   * carry a line about the daemon happen exactly when the daemon is dead: claiming reachable there paints the row
   * as answering, and leaves the poll's own no-daemon looking like a repeat of the claim, which the bus drops. */
  const reachOf = (entry: LiveWorkspace): ReachState => {
    if (ctx.unreachedOf(entry) !== undefined) return "unreachable";
    const seen = polledReach.get(entry.record.id);
    if (seen !== undefined && seen.machineId === entry.machine.id) return seen.reach;
    // The same reading the status poll makes: a machine wsp can ask at all, by a route or by its own answer.
    return ctx.moduleOf(entry.record.kind).hasDaemon(entry) || entry.machine.daemonAnswers !== undefined ? "reachable" : "unsupported";
  };
  const emitStatus = async (entry: LiveWorkspace, reach: ReachState, reason?: string): Promise<void> => {
    const size = entry.record.size;
    const idleAt = entry.record.phase === "running" ? ctx.idle.idleAt(entry.record.id) : undefined;
    bus.emit({
      type: "workspace.status",
      status: {
        ...ctx.view(entry.record),
        machineState: machineStateOf(entry.record.phase),
        reach: { state: reach },
        size,
        rateUsdPerHour: ctx.backendFor(entry.record).pricing.rateUsdPerHour(size),
        ...(reason !== undefined ? { reason } : {}),
        ...(entry.wakeAsk !== undefined ? { wakeAsk: entry.wakeAsk } : {}),
        ...(idleAt !== undefined ? { idleAt } : {}),
        ...(entry.checkout !== undefined ? { checkout: entry.checkout } : {}),
        ...(entry.pr !== undefined ? { pr: entry.pr } : {}),
        ...(entry.tree !== undefined ? { tree: entry.tree } : {}),
      },
    });
  };

  /** One line about the wake in flight, pushed now and kept on the entry so the poll's own statuses carry it too. */
  const saysWaking = async (entry: LiveWorkspace, words: string): Promise<void> => {
    entry.wakeSaid = words;
    await emitStatus(entry, "napping", words);
  };

  /** The one preamble every dial this runtime makes to a machine's daemon repeats: the preview route, then this
   * runtime's token on the guest, then the link. null when the guest holds no daemon token, which each caller reads
   * its own way. The caller owns the link and closes it; the previewUrl guard stays with the caller, which knows
   * what a backend without preview routes means for it. */
  const dialDaemon = async (entry: LiveWorkspace, deadline: number, o: { onEvent?: (e: DaemonEvent) => void; heartbeatMs?: number } = {}): Promise<DaemonReach | null> => {
    const reach = await until(entry.ws.daemonReach(), deadline, "preview route");
    const token = await until(ctx.daemonTokenOf(entry.machine), deadline, "daemon token");
    if (token === undefined) return null;
    return connectDaemon({ previewUrl: reach.url, token, onEvent: o.onEvent ?? (() => {}), ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}) });
  };

  /** How long one ask of a machine's own daemon check gets, and how long before the next one: the budget is the
   * whole of what the daemon is given, and a boot that is still coming up answers no rather than nothing. */
  const ASK_DAEMON_MS = 5_000;
  const ASK_AGAIN_MS = 500;

  /** The daemon answering is what proves a resumed guest serves; resume() returning does not (a zombie reports
   * running for 10+ minutes while exec and the edge 502). Asked over the machine's own road where it has one and
   * through the edge where the route is the only way in, since the two readings of one machine's reach would
   * otherwise disagree: a container's published port is on the loopback of the box that runs it, and a host that
   * is not that computer would fail this check on a live guest, which on a backend whose wake takes one attempt
   * throws the container away and forks the golden again. A machine with neither road has nothing to ask, so the
   * check falls back to the shape comparison. */
  const daemonAnswer = async (entry: LiveWorkspace): Promise<string | undefined> => {
    const machine = entry.machine;
    const answersMs = ctx.lifecycleOf(entry).budgets.daemonAnswersMs;
    // The person's stop on a wake ends the wait here too: the budget runs to minutes, and the row's toggle waits for
    // the wake to let go.
    const stop = entry.wakeStop?.signal;
    const orStopped = <T>(p: Promise<T>): Promise<T> =>
      stop === undefined
        ? p
        : Promise.race([p, new Promise<never>((_, reject) => (stop.aborted ? reject(new Error(WAKE_STOPPED)) : stop.addEventListener("abort", () => reject(new Error(WAKE_STOPPED)), { once: true })))]);
    if (machine.daemonAnswers !== undefined) {
      const deadline = clock.now() + answersMs;
      try {
        // Asked again until the budget is out rather than once at the start of it: a machine that was stopped for
        // its nap rather than frozen comes back with its boot still running, and the budget is what the daemon is
        // given to answer in. A machine that answers at once costs one ask, as it always did.
        for (;;) {
          const up = await orStopped(until(machine.daemonAnswers({ timeoutMs: Math.min(answersMs, ASK_DAEMON_MS) }), deadline, "daemon answer"));
          if (up) return undefined;
          if (clock.now() >= deadline) return `nothing listens on the daemon's port inside ${machine.id}`;
          await orStopped(new Promise<void>(done => clock.schedule(done, ASK_AGAIN_MS, { unref: true })));
        }
      } catch (e) {
        // The error is in hand here, so it is what the row says: only the edge road, which learns nothing but that
        // it waited, reports the budget.
        return `the daemon on ${machine.id} could not be asked (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    if (!machine.previewUrl) return undefined;
    const deadline = clock.now() + answersMs;
    let link: DaemonReach | null = null;
    try {
      const dialled = dialDaemon(entry, deadline, { heartbeatMs: answersMs });
      // A dial the stop walked away from still lets go of its link once it lands.
      dialled.then(l => (stop?.aborted === true ? l?.close() : undefined), () => {});
      link = await orStopped(dialled);
      if (link === null) {
        // No daemon to ask; an exec that returns is the guest's own answer.
        await orStopped(until(machine.exec("true"), deadline, "guest exec", clock));
        return undefined;
      }
      await orStopped(until(link.ready, deadline, "daemon link", clock));
      await orStopped(until(link.request("ping"), deadline, "daemon ping", clock));
      return undefined;
    } catch (e) {
      return `daemon on ${machine.id} did not answer within ${answersMs} ms (${e instanceof Error ? e.message : String(e)})`;
    } finally {
      link?.close();
    }
  };

  /** How long a wait on a daemon runs before a machine that can start its own daemon is asked to, for a provider that
   * can leave it down after a restore however long the wait, and how long after a start that failed it is asked
   * again: a command on a box whose disk is still streaming in can outlast its own timeout. Each start is one more
   * try inside the same budget, which stays the outer cut. */
  const START_DAEMON_AFTER_MS = 60_000;

  const pingDaemon = async (entry: LiveWorkspace): Promise<string | undefined> => {
    const machine = entry.machine;
    if (machine.startDaemon === undefined) return daemonAnswer(entry);
    const start = machine.startDaemon.bind(machine);
    const began = clock.now();
    let over = false;
    let cancel = (): void => {};
    const arm = (): void => {
      cancel = clock.schedule(
        () => {
          const late = `daemon on ${machine.id} (workspace ${entry.record.id}) had not answered ${Math.round((clock.now() - began) / 1000)} s into the wait, so wsp started it`;
          const again = (): void => (over ? undefined : arm());
          void start().then(
            r => {
              const tail = r.exitCode === 0 ? "" : r.stderr.trim().slice(-200);
              console.warn(`${late} (exit ${r.exitCode}${tail === "" ? "" : `: ${tail}`})`);
              if (r.exitCode !== 0) again();
            },
            (e: unknown) => {
              console.warn(`${late}, and the start failed (${e instanceof Error ? e.message : String(e)})`);
              again();
            },
          );
        },
        START_DAEMON_AFTER_MS,
        { unref: true },
      );
    };
    arm();
    try {
      return await daemonAnswer(entry);
    } finally {
      over = true;
      cancel();
    }
  };

  /** The version the machine's daemon announces in its hello, null when no daemon answers within the bound: a
   * daemon says what it is on connect and answers no op for it, so reading the version is one dial and one frame.
   * A machine whose daemon is gone, whose backend mints no preview route or whose guest holds no token has none. */
  const helloVersion = async (entry: LiveWorkspace): Promise<number | null> => {
    if (!entry.machine.previewUrl) return null;
    const deadline = Date.now() + daemonHelloTimeoutMs;
    let link: DaemonReach | null = null;
    try {
      let announce: (v: number) => void = () => {};
      const hello = new Promise<number>(done => (announce = done));
      link = await dialDaemon(entry, deadline, { onEvent: e => (e.type === "daemon.hello" ? announce(e.version) : undefined) });
      if (link === null) return null;
      return await until(hello, deadline, "daemon hello");
    } catch {
      return null;
    } finally {
      link?.close();
    }
  };

  /** The machine's row now, rather than at the next poll. A machine that stopped running is left to the poller:
   * only it knows what that machine's reach is by then. */
  const pushStatus = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.phase !== "running") return;
    await emitStatus(entry, reachOf(entry));
  };

  /** The copy's checkout read through its own daemon, kept on the entry and pushed on its status: at a turn's end, on
   * view and after a write, and never on a timer. Within CHECKOUT_TTL_MS the fact held answers unless the caller
   * forces a read. A machine that is not running is asked nothing unless its computer answers for it, which reads a
   * stopped copy off its files; one that cannot answer keeps its last fact and the time git gave it. */
  const readCheckout = (entry: LiveWorkspace, force: boolean): Promise<Checkout | undefined> => {
    const held = entry.checkout;
    if (!force && held !== undefined && clock.now() - held.readAt < CHECKOUT_TTL_MS) return Promise.resolve(held);
    if (entry.record.phase !== "running" && ctx.servedByItsComputer(entry) === undefined) return Promise.resolve(held);
    if (entry.checkoutReading !== undefined) return entry.checkoutReading;
    const reading = (async (): Promise<Checkout | undefined> => {
      try {
        const said = GitStatusReply.parse(await ctx.withDaemon(entry, ask => ask({ op: "git.status", cwd: ctx.checkoutOf(entry.record) })));
        entry.checkout = {
          branch: said.branch.head,
          ahead: said.branch.ahead,
          behind: said.branch.behind,
          changed: said.entries.filter(e => e.xy !== "!!").length,
          ...(said.editsUnread === true ? { editsUnread: true } : {}),
          ...(said.countsUnknown === true ? { countsUnknown: true } : {}),
          ...(said.stashes !== undefined ? { stashes: said.stashes } : {}),
          ...(/^[0-9a-f]{7,40}$/.test(said.branch.oid) ? { head: said.branch.oid } : {}),
          readAt: clock.now(),
        };
        const { readAt: _was, ...kept } = entry.record.checkout ?? { readAt: 0 };
        const { readAt: _now, ...read } = entry.checkout;
        if (JSON.stringify(kept) !== JSON.stringify(read)) {
          entry.record.checkout = entry.checkout;
          await ctx.persist(entry.record);
        }
        await statusNow(entry);
      } catch {
        // A copy git could not read keeps the last fact it gave; the time on it says how old it is.
      }
      return entry.checkout;
    })().finally(() => {
      delete entry.checkoutReading;
    });
    entry.checkoutReading = reading;
    return reading;
  };

  /** A lead's children read against the lead's branch as the git host holds it, kept on the lead and pushed on its
   * status: each child's branch off its own checkout fact, one compare on this computer's command line with the
   * repository off the child's project, and what the child's record keeps. Read at a child's turn end, after its bring
   * back, after a merge into the lead and when the lead's thread opens; never on a timer. A lead whose children are all
   * gone has its tree taken off. */
  const readTree = (lead: LiveWorkspace): Promise<TreeFact | undefined> => {
    if (lead.treeReading !== undefined) return lead.treeReading;
    const reading = (async (): Promise<TreeFact | undefined> => {
      const children = [...live.values()].filter(e => e.record.parentWorkspaceId === lead.record.id && e.creating !== true);
      if (children.length === 0) {
        if (lead.tree !== undefined) {
          delete lead.tree;
          await statusNow(lead);
        }
        return undefined;
      }
      const project = ctx.projectHeld(lead.record.project);
      const leadBranch = (await readCheckout(lead, false))?.branch ?? lead.record.base ?? project.base ?? project.defaultBranch;
      const rows = await Promise.all(children.map(child => treeChildOf(child, leadBranch)));
      lead.tree = { leadBranch, children: rows, readAt: clock.now() };
      await statusNow(lead);
      return lead.tree;
    })().finally(() => {
      delete lead.treeReading;
    });
    lead.treeReading = reading;
    return reading;
  };

  /** One child's row: its branch, the host's count of it against what the lead's copy holds of it where this computer
   * could ask, and what its record keeps. A merge into the lead stays in the lead's copy until its bring back, so
   * after one the count is against the child's commit it took. A compare nothing could answer leaves the counts out,
   * which the row reads as not counted. */
  const treeChildOf = async (child: LiveWorkspace, leadBranch: string): Promise<TreeChild> => {
    const branch = (await readCheckout(child, false))?.branch ?? child.record.worktree?.branch ?? child.record.base ?? "";
    const thread = [...sessions.values()].map(v => v.view).find(v => v.workspaceId === child.record.id && v.threadId !== undefined)?.threadId;
    const remote = ctx.projectHeld(child.record.project).remote;
    const asked =
      branch === "" || branch === DETACHED_HEAD || remoteHost(remote) === undefined
        ? undefined
        : await ctx.onThisComputer((ask, home) => ask({ op: "git.branchCompare", cwd: home, remote, base: child.record.tree?.merged?.head ?? leadBranch, head: branch }))
            .then(r => GitBranchCompareReply.parse(r))
            .catch(() => undefined);
    const counted = asked === undefined ? {} : asked.pushed ? { pushed: true, ...(asked.aheadBy !== undefined ? { aheadOfLead: asked.aheadBy } : {}), ...(asked.behindBy !== undefined ? { behindLead: asked.behindBy } : {}) } : { pushed: false };
    return { workspaceId: child.record.id, ...(thread !== undefined ? { threadId: thread } : {}), branch, ...counted, ...(child.record.tree ?? {}) };
  };

  /** The tree a workspace is a child in, read again where something about the child moved. */
  const readLeadOf = (child: LiveWorkspace): void => {
    const lead = child.record.parentWorkspaceId === undefined ? undefined : live.get(child.record.parentWorkspaceId);
    if (lead !== undefined) void readTree(lead);
  };

  /** A workspace's status pushed now, with the reach its phase implies, for a fact read outside the poll. */
  const statusNow = (entry: LiveWorkspace): Promise<void> => emitStatus(entry, entry.record.phase === "running" ? reachOf(entry) : "napping");
  return {
    polledReach, napRefusals, napRefusedOf, napRefusedReason, stopRefusals, stopRefusedReason, diskReason, readDisk,
    reachOf, emitStatus, saysWaking, pingDaemon, helloVersion, pushStatus, readCheckout, readTree, readLeadOf,
    statusNow,
  };
}


function daemonArea(ctx: RuntimeContext): DaemonArea {
  const { bus, clock, daemonHelloTimeoutMs, live, sessions } = ctx;
  /** A message into a thread, or a thread opened with it, answered as soon as it is on its way, as `wsp send --detach`
   * does: joined into the running turn, waiting behind it, or started. The turn goes on without the caller. */
  const sendDetached = async (
    workspaceId: string,
    o: { prompt: string; thread?: string },
    origin: Caller | undefined,
  ): Promise<{ outcome: "steered" | "queued" | "started"; threadId: string; harness: string }> => {
    const requestId = randomUUID();
    let queuedNow: ((harness: string) => void) | undefined;
    const queued = new Promise<{ queuedOn: string }>(resolve => {
      queuedNow = harness => resolve({ queuedOn: harness });
    });
    const off = bus.on("session.queued", e => {
      if (e.type === "session.queued" && e.requestId === requestId) queuedNow?.(e.harness);
    });
    try {
      const started = ctx.sessionsApi.start(workspaceId, { ...o, requestId }, origin);
      const first = await Promise.race([started, queued]);
      if ("queuedOn" in first) {
        started.catch((e: unknown) => console.warn(`a message waiting in thread ${threadWord(o.thread ?? "")} was not sent: ${e instanceof Error ? e.message : String(e)}`));
        return { outcome: "queued", threadId: o.thread!, harness: first.queuedOn };
      }
      const view = first.view();
      return { outcome: first.outcome === "steered" ? "steered" : "started", threadId: view.threadId ?? view.id, harness: view.harness };
    } finally {
      off();
    }
  };

  /** A message into the workspace's first thread, which is the one the work was opened in; one with none opens one. */
  const toFirstThread = (workspaceId: string, prompt: string, origin: Caller | undefined): ReturnType<typeof sendDetached> => {
    const first = [...sessions.values()].map(v => v.view).filter(v => v.workspaceId === workspaceId && v.threadId !== undefined).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))[0];
    return sendDetached(workspaceId, { prompt, ...(first?.threadId !== undefined ? { thread: first.threadId } : {}) }, origin);
  };

  /** The line the machine's row carries while the runtime is doing something to its daemon; undefined clears it. */
  const noteDaemon = async (entry: LiveWorkspace, note: string | undefined): Promise<void> => {
    if (note === undefined) ctx.daemonNotes.delete(entry.record.id);
    else ctx.daemonNotes.set(entry.record.id, note);
    await ctx.pushStatus(entry);
  };

  /** A line for the machine's row that rides one status and no more, so the next poll shows the row's own facts
   * again. What the row is for is the machine's rate and its nap countdown; a failure nobody here can act on must
   * not sit on top of them for the life of the host. */
  const flashDaemon = async (entry: LiveWorkspace, note: string): Promise<void> => {
    ctx.daemonNotes.set(entry.record.id, note);
    await ctx.pushStatus(entry);
    ctx.daemonNotes.delete(entry.record.id);
  };

  /** The writes of each machine's roots file, one at a time: each writes the whole file, so two at once can land in
   * either order. */
  const rootsWrites = new Map<string, Promise<unknown>>();
  const rootsWrite = <T>(machineId: string, work: () => Promise<T>): Promise<T> => {
    const done = (rootsWrites.get(machineId) ?? Promise.resolve()).then(work);
    const tail = done.catch(() => {});
    rootsWrites.set(machineId, tail);
    void tail.then(() => {
      if (rootsWrites.get(machineId) === tail) rootsWrites.delete(machineId);
    });
    return done;
  };

  /** The folders the record says this machine's daemon may browse beside its home. Derived state: the record is the
   * one place, and the file follows it on every connect, so a project that landed before the daemon read that file
   * is browsable without a second import. Non-fatal: an update or a turn must not fail on it. `entry` names the
   * machine and may be a record already gone from it, whose folders the write then leaves out. */
  const writeDaemonRoots = (entry: LiveWorkspace): Promise<void> =>
    rootsWrite(entry.record.machineId, async () => {
      // A host that has closed writes nothing more on a machine: the boot fires this at every running workspace
      // without waiting for it, and a write that landed after the close would be this process touching a computer
      // it has let go of.
      if (ctx.state.closed) return;
      // And nothing is written inside a workspace whose computer serves its daemon: that daemon reads the path off
      // the frame and browses the workspace's own rootfs, so a list of folders inside it says nothing to anybody.
      if (ctx.servedByItsComputer(entry) !== undefined) return;
      // Every checkout the daemon serving this machine has to browse, not this workspace's alone: the file is that
      // daemon's one list and is written whole, and on the computer the host runs on one daemon serves every
      // workspace here, each in a copy of the project folder at a path of its own. Read once the write before has
      // landed, so a write never puts back a list older than the one already there.
      const sharing = [...live.values()].filter(e => e.record.machineId === entry.record.machineId);
      const dests = [...new Set(sharing.flatMap(e => [ctx.projectHeld(e.record.project).path, ctx.checkoutOf(e.record)]))];
      // Through the kind, which is what knows where that machine's daemon looks; the import road writes the same
      // file through the same call, so a folder is browsable at the same path whichever of the two got there first.
      await ctx.moduleOf(entry.record.kind)
        .roots(entry, dests)
        .catch((e: unknown) => console.warn(`browsable folders for ${entry.record.id} not written on ${entry.machine.id}: ${(e instanceof Error ? e.message : String(e)).slice(-200)}`));
    });

  /** Settles once no turn is running on the workspace: at once when none is, else when the last one ends. Replacing
   * the daemon ends the ptys under it, so the work a person or an agent started finishes first. */
  const turnRuns = (workspaceId: string): boolean => [...sessions.values()].some(s => s.view.workspaceId === workspaceId && s.view.status === "running");

  const whenNoTurnRuns = (workspaceId: string): Promise<void> => {
    if (!turnRuns(workspaceId)) return Promise.resolve();
    return new Promise(done => {
      // A turn leaves running on its done or its end and on nothing else, so this wakes twice a turn rather than
      // once per output chunk of every workspace on the bus.
      const offs: (() => void)[] = [];
      const check = (): void => {
        if (turnRuns(workspaceId)) return;
        for (const off of offs) off();
        done();
      };
      offs.push(bus.on("session.done", check), bus.on("session.end", check));
    });
  };

  /** Whether this runtime has a road to put a daemon on a machine: the kind's own module must have one wired, since
   * what a deploy needs differs by kind and only the module knows whether its host gave it one, and the bundle has
   * to reach the machine, which is the machine's own question and not its kind's. Both roads into updateDaemon
   * read this, so neither offers to deploy where the other would not. */
  const canDeployDaemon = (entry: LiveWorkspace): boolean =>
    // Nothing is put inside a workspace whose computer serves its daemon: the daemon answering for it is that
    // computer's own, moved as a computer and never as a workspace. Read here, so neither the sync nor the revive
    // offers a deploy the update would refuse.
    ctx.servedByItsComputer(entry) === undefined &&
    ctx.moduleOf(entry.record.kind).deployDaemon !== undefined &&
    landsBytes(ctx.backendFor(entry.record).capabilities, entry.machine);

  /** Every road that puts a daemon on a machine runs the kind's deploy through here, and this is the one place
   * that writes down how it went: a machine that answered with what it lacks keeps its own sentence and the
   * moment it said it, and every other ending takes them off. The record rather than a map in this process,
   * because the whole point of remembering is the next host start. */
  const deployDaemonOn = async (entry: LiveWorkspace, deploy: (e: LiveWorkspace) => Promise<void | string>): Promise<void | string> => {
    const forget = async (): Promise<void> => {
      if (entry.record.daemonRefusedAt === undefined) return;
      delete entry.record.daemonRefusedAt;
      await ctx.persist(entry.record);
    };
    try {
      const detail = await deploy(entry);
      await forget();
      return detail;
    } catch (e) {
      // Which of the three endings this is decides what the record keeps. A deploy that got past the machine's
      // own checks and fell over later proves the machine no longer lacks what it named, whatever else went
      // wrong. A machine that never answered proves nothing either way, and a box switched off has not stopped
      // lacking a compiler, so what the record already knows stands and its hour keeps running.
      const lacks = machineLacksLine(e);
      if (lacks !== undefined) {
        entry.record.daemonRefusedAt = { machineId: entry.machine.id, at: new Date(clock.now()).toISOString(), why: lacks };
        await ctx.persist(entry.record);
      } else if (!machineNeverAnswered(e)) await forget();
      throw e;
    }
  };

  /** What the machine under this record last said it lacks, and nothing another machine said: a machine replaced
   * under the record answers for itself, so the old one's sentence comes off rather than sitting on the record
   * for good and being shown on a row for a machine that is gone. */
  const lacksSaid = async (entry: LiveWorkspace): Promise<{ at: string; why: string } | undefined> => {
    const refused = entry.record.daemonRefusedAt;
    if (refused === undefined) return undefined;
    if (refused.machineId === entry.machine.id) return refused;
    delete entry.record.daemonRefusedAt;
    await ctx.persist(entry.record);
    return undefined;
  };

  /** Everything the runtime settles with a machine's daemon the moment it can reach it, and the only place that
   * does: the folders the record says it may browse, then a daemon older than this wsp replaced with this one's,
   * waiting out any running turn first. Nobody asks for it, and nothing about it is a person's to know: the panes
   * that need the new ops simply work once it lands. A failure leaves the old daemon serving, says so on the row
   * once, and puts the reason in this host's log, where the person who runs the host can read it.
   * One run per machine at a time, so two connects at once do the work once. */
  const daemonSyncs = new Map<string, Promise<void>>();
  const syncDaemon = (entry: LiveWorkspace): Promise<void> => {
    const key = entry.machine.id;
    const held = daemonSyncs.get(key);
    if (held !== undefined) return held;
    const work = (async () => {
      const module = ctx.moduleOf(entry.record.kind);
      // Nothing is deployed into a workspace whose computer serves its daemon, and no roots file is written in it:
      // the daemon answering for it is that computer's own, which the update road moves as a computer and not as a
      // workspace.
      if (ctx.servedByItsComputer(entry) !== undefined) return;
      // A machine that answered with what it lacks is left alone until its window is out, whether it is being
      // given a first daemon or having one replaced: the thing it has not got stops both roads, and only a person
      // can change that answer. Read off the record above every round trip below, so a tick that finds the window
      // still holding costs that machine nothing. Whether a daemon is being placed or replaced decides the words
      // alone, which say installing rather than updating.
      const placing = !module.hasDaemon(entry);
      const said = await lacksSaid(entry);
      if (said !== undefined && clock.now() - Date.parse(said.at) < DAEMON_LACKS_AGAIN_MS) return;
      await writeDaemonRoots(entry);
      // A host that cannot deploy asks no version: a line would promise an ask that changes nothing, at every connect.
      if (!canDeployDaemon(entry)) return;
      const version = await module.daemonVersion(entry);
      if (version === null) {
        unreadAt.set(entry.record.id, { machineId: key, at: clock.now() });
        console.warn(`daemon on ${key} (workspace ${entry.record.id}): version not read within ${daemonHelloTimeoutMs / 1000} s; asking again at the next reach probe`);
        return;
      }
      unreadAt.delete(entry.record.id);
      if (version >= DAEMON_VERSION) return;
      if (turnRuns(entry.record.id)) console.warn(`daemon on ${key} (workspace ${entry.record.id}): update waits for the running turn`);
      await whenNoTurnRuns(entry.record.id);
      if (entry.record.phase !== "running") return;
      await noteDaemon(entry, placing ? DAEMON_INSTALLING : DAEMON_UPDATING);
      // Marking the row awaits a push, which is several ticks wide; a turn that opened inside that window would
      // lose its ptys to the deploy, so the wait runs again until nothing is running as the deploy starts.
      while (turnRuns(entry.record.id)) await whenNoTurnRuns(entry.record.id);
      // The last read before the deploy: a machine that napped under the wait is handed no exec on a paused sandbox.
      if (entry.record.phase !== "running") {
        await noteDaemon(entry, undefined);
        return;
      }
      try {
        // The update verb's door refuses a workspace still creating, which is when the create's sync runs.
        await deployDaemonOn(entry, module.deployDaemon!);
        await writeDaemonRoots(entry);
        await noteDaemon(entry, undefined);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await noteDaemon(entry, undefined);
        // A machine that napped or went under the update did not fail one: its row says what its phase says.
        if (entry.record.phase !== "running") return;
        console.warn(`daemon on ${entry.machine.id} (workspace ${entry.record.id}) ${placing ? "not installed" : "not updated"}: ${reason}`);
        // The machine's own sentence where it gave one: it is one line, it names the thing the machine has not
        // got, and a person can act on it. A deploy that failed further in gives an npm log instead, which is
        // hundreds of characters of nothing anybody reading a row can do.
        await flashDaemon(entry, machineLacksLine(e) ?? (placing ? DAEMON_INSTALL_FAILED : DAEMON_UPDATE_FAILED));
      }
    })();
    daemonSyncs.set(key, work);
    void work.catch(() => {}).then(() => {
      if (daemonSyncs.get(key) === work) daemonSyncs.delete(key);
    });
    return work;
  };

  /** Every attempt to put a daemon back on a workspace's current machine, and when the last one was. */
  const revivedAt = new Map<string, MachineMoment>();
  /** Every workspace whose last sync could not read its daemon's version, and when that read gave up. */
  const unreadAt = new Map<string, MachineMoment>();
  /** Every workspace whose machine the provider last answered it cannot reach, with the sentence its row carries. */
  const unreached = new Map<string, { machineId: string; line: string }>();
  /** The mark on the entry's own machine; one a replaced machine left is dropped here. */
  const unreachedOf = (entry: LiveWorkspace): string | undefined => {
    const mark = unreached.get(entry.record.id);
    if (mark === undefined) return undefined;
    if (mark.machineId === entry.machine.id) return mark.line;
    unreached.delete(entry.record.id);
    return undefined;
  };
  const daemonRevivals = new Map<string, Promise<void>>();

  /** A running machine whose daemon port answers nothing gets this runtime's daemon put back on it, on the same
   * road the doctor and the golden build use and with the workspace's own token. The kernel's memory killer took
   * a daemon once and the machine sat with none for five hours while its turns, which go over the provider's
   * exec, kept running, so only the reach probe noticed (2026-09-08). Every poll that
   * measures the machine calls this, not every status the bus carries: a machine parked at no-daemon builds the
   * same status each time and the bus rightly drops the repeats, so a road listening there would try once and
   * never again. The probe window is behind the word already, since reachShown gives a row no-daemon only on the
   * second unanswered probe in a row. Unlike an update this waits out no turn: a daemon that answers nothing holds
   * no ptys to lose. One run per machine at a time. */
  const reviveDaemon = (entry: LiveWorkspace, reach: ReachState): void => {
    if (reach !== "no-daemon" || entry.record.phase !== "running") return;
    // A deploy rides the exec the provider is refusing, and its failure would flash over the row's own sentence.
    if (!canDeployDaemon(entry) || unreachedOf(entry) !== undefined) return;
    const key = entry.machine.id;
    if (daemonRevivals.has(key)) return;
    const last = revivedAt.get(entry.record.id);
    if (last !== undefined && last.machineId === key && clock.now() - last.at < DAEMON_REVIVE_AGAIN_MS) return;
    revivedAt.set(entry.record.id, { machineId: key, at: clock.now() });
    const deploy = ctx.moduleOf(entry.record.kind).deployDaemon!;
    const work = (async () => {
      await noteDaemon(entry, DAEMON_RESTARTING);
      // The last read before the deploy: a machine that napped under the note is handed no exec on a paused sandbox.
      if (entry.record.phase !== "running") {
        await noteDaemon(entry, undefined);
        return;
      }
      try {
        await deployDaemonOn(entry, deploy);
        await writeDaemonRoots(entry);
        await noteDaemon(entry, undefined);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await noteDaemon(entry, undefined);
        // A machine that napped or went while the daemon was going back on did not fail a restart.
        if (entry.record.phase !== "running") return;
        console.warn(`daemon on ${entry.machine.id} (workspace ${entry.record.id}) not restarted: ${reason}`);
        await flashDaemon(entry, DAEMON_RESTART_FAILED);
      }
    })();
    daemonRevivals.set(key, work);
    void work.catch(() => {}).then(() => {
      if (daemonRevivals.get(key) === work) daemonRevivals.delete(key);
    });
  };

  /** A machine that answered with what it lacks is offered the daemon again on the first poll after its hour is
   * out, with this host never restarted. For a machine over ssh the sync runs at hydrate and at a machine swap and
   * nowhere else, so a person who installed the compiler their machine asked for would read the refusal on their
   * row until they restarted the host. The hour itself stays where it is decided, in the sync; this says only
   * which machines are worth asking it about, and asks about none the poll did not just hear from: a status
   * carries the machine's own facts only when it answered a dial this tick, so a box that is off is left alone
   * rather than dialled a second time for the same silence, and so is one whose answer came back unreadable. The
   * window restarts on each refusal, so a machine still lacking what it named is asked once an hour and not once
   * a tick.
   * The evidence is the kind's own read of what its machine is, so only a kind whose machines answer that read can
   * be offered again: one that cannot say what it is gives the same nothing whether it is up or dark. What makes
   * that whole is that a place asks its machine for something only where wsp did not build that machine, and a
   * machine that already existed is one that answers the read; a fork asks nothing, so it records no refusal for
   * anything to re-offer. A check added to a place whose machines answer no such read would sit on its row for
   * good, so that kind answers for itself here first. */
  const offerDaemonAgain = (entry: LiveWorkspace, polled: WorkspaceStatus): void => {
    if (entry.record.daemonRefusedAt === undefined || polled.facts === undefined) return;
    void syncDaemon(entry);
  };

  /** Nothing else runs the sync again before the next connect, and a hello that missed it leaves an old daemon serving. */
  const readVersionAgain = (entry: LiveWorkspace, polled: WorkspaceStatus): void => {
    const unread = unreadAt.get(entry.record.id);
    if (unread === undefined) return;
    if (unread.machineId !== entry.machine.id) {
      unreadAt.delete(entry.record.id);
      return;
    }
    if (polled.phase !== "running" || polled.reach.state !== "reachable" || clock.now() - unread.at < DAEMON_REVIVE_AGAIN_MS) return;
    void syncDaemon(entry);
  };
  return {
    sendDetached, toFirstThread, rootsWrite, writeDaemonRoots, turnRuns, deployDaemonOn, daemonSyncs, syncDaemon,
    revivedAt, unreadAt, unreached, unreachedOf, reviveDaemon, offerDaemonAgain, readVersionAgain,
  };
}

function machinesArea(ctx: RuntimeContext): MachinesArea {
  const {
    opts, backend, store, bus, goneConfirmMs, lateReadMs, clock, vaultCapBytes, defaultIdleWindowMs, hostId,
    vaultExport, live, gone, threadRecords, sessions, execs, indexFlushes, transcripts, rows, unreadIndexes,
    pendingEvents, pendingBytes, transcriptIndex, transcriptBytes,
  } = ctx;
  /** Size is always explicit: a create that names none gets the provider's own
   * default (2048 MB on Solari), not the size the record and the rate assume. */
  const forkSpec = (r: WorkspaceRecord, kind: MachineKind, image: ReturnType<typeof goldenImage>["spec"] | undefined, engine: boolean, override?: WorkspaceSpec): MachineSpec & WorkspaceSize => ({
    ...image,
    kind,
    ...(engine ? { engine: true } : {}),
    // The project's own folders on its computer, as the create recorded them: a wake mounts what the create did,
    // and the copy of the checkout it was made with is made again from the same folder.
    ...(r.spec.binds !== undefined && r.spec.binds.length > 0 ? { binds: r.spec.binds } : {}),
    ...(r.spec.copy !== undefined ? { copy: r.spec.copy } : {}),
    // The view's size rather than the row's: the row carries the guest's count, which no offer need match.
    cpu: override?.cpu ?? r.shape?.cpu ?? r.size.cpu,
    memMb: override?.memMb ?? r.shape?.memMb ?? r.size.memMb,
    envs: { ...loginEnvOn(r.place), ...r.spec.envs, ...override?.envs },
    labels: { ...r.spec.labels, [WSP_LABEL]: "1", [OWNER_LABEL]: ctx.state.owner, [WORKSPACE_LABEL]: r.id, [NAME_LABEL]: r.name, [GOLDEN_LABEL]: r.golden, [CREATED_AT_LABEL]: new Date().toISOString() },
    onIdle: "pause",
    idleTimeoutMs: backstopMs(idleWindowOf(r)),
  });
  /** The mark on every image this state makes: the host's id and this state file's owner, each in the class the
   * provider's name field has taken. Two state files on one computer read one host id, and on Box a snapshot's name
   * is its id, so the owner is what keeps one state's image from being the other's. */
  const imageMark = (): string => templateHost(hostId) + templateHost(ctx.state.owner);

  /** The store holds the attempt's key and stamp before the provider hears of it: a retry the provider never answered
   * (the connection dropped, the process died) sends the same body under the same key and gets back the machine the
   * first try booted. An answer of any kind ends the attempt and a changed request starts one, so the key after a kill
   * or a refusal is always fresh. A replay naming a dead machine is dropped and the create made anew (measured
   * 2026-09-04: the provider replays a killed machine's id). Another live process's attempt is never joined. */
  const keyedCreate = async (at: MachineBackend, purpose: string, spec: MachineSpec, waiting?: (line: string) => void, afterCorpse = false): Promise<Machine> => {
    const body = fingerprint(spec);
    const held = (await store.get(CREATES, purpose)) as PendingCreate | undefined;
    const theirs = held !== undefined && (held.host !== hostId || (held.pid !== process.pid && pidAlive(held.pid)));
    const name = purpose.length <= KEY_PURPOSE_MAX ? purpose : createHash("sha256").update(purpose).digest("hex");
    const attempt: PendingCreate = held?.body === body && !theirs
      ? { ...held, host: hostId, pid: process.pid }
      : { key: `${name}:${randomBytes(8).toString("hex")}`, createdAt: new Date().toISOString(), body, host: hostId, pid: process.pid };
    await store.put(CREATES, purpose, attempt);
    let machine: Machine;
    try {
      machine = await at.create({
        ...spec,
        idempotencyKey: attempt.key,
        ...(spec.labels?.[CREATED_AT_LABEL] !== undefined ? { labels: { ...spec.labels, [CREATED_AT_LABEL]: attempt.createdAt } } : {}),
      }, waiting);
    } catch (e) {
      if (typeof (e as WspError).status === "number") await store.delete(CREATES, purpose);
      throw e;
    }
    await store.delete(CREATES, purpose);
    if (machine.replayed === true) {
      if ((await machine.state()) === "gone") {
        if (afterCorpse) throw new Error(`create for ${purpose}: the provider replayed ${machine.id}, which is gone, under a key it had never seen (${attempt.key})`);
        console.warn(`create for ${purpose}: the replay under ${attempt.key} named ${machine.id}, which is gone; creating anew`);
        return keyedCreate(at, purpose, spec, waiting, true);
      }
      console.warn(`create for ${purpose}: ${machine.id} replayed from an earlier attempt under ${attempt.key}`);
    }
    return machine;
  };

  /** Ids this process has created and not yet recorded; the sweep must not read them as lost. */
  const inflight = new Set<string>();
  /** purpose names the record every create inside run is for; its attempts are keyed under it. */
  const claiming = <T>(purpose: string, run: (b: MachineBackend) => Promise<T>, at: MachineBackend = backend): Promise<T> => {
    const mine: string[] = [];
    const b: MachineBackend = {
      capabilities: at.capabilities,
      pricing: at.pricing,
      // The golden's builder is created through this handle, so the image the provider boots from rides along.
      ...(at.baseTemplates !== undefined ? { baseTemplates: at.baseTemplates } : {}),
      // And whether this backend's machines come up under the workspace's own name, since the fork behind this
      // handle is what would name one again.
      ...(at.namesWorkspace !== undefined ? { namesWorkspace: at.namesWorkspace } : {}),
      get: id => at.get(id),
      list: labels => at.list(labels),
      deleteSnapshot: id => at.deleteSnapshot(id),
      // Every call a backend may or may not carry, in one place: a module keeps its methods on its prototype, so
      // this handle cannot be a spread of the backend, and a call left out is one the roads inside here lose.
      ...forwardedCalls(at),
      create: async (spec, waiting) => {
        const m = await keyedCreate(at, purpose, spec, waiting);
        inflight.add(m.id);
        mine.push(m.id);
        return m;
      },
    };
    return run(b).finally(() => mine.forEach(id => inflight.delete(id)));
  };
  /** The machine with its exec reported to the recipe's listener; every other member is the provider's own, bound to it.
   * A listener that throws is warned about once and never changes an exec's result: the log records the run, it cannot fail it. */
  const observed = (machine: Machine): Machine => {
    const onExec = opts.goldenRecipe?.onExec;
    if (onExec === undefined) return machine;
    let unheard = false;
    const report = (exec: GoldenExec): void => {
      try {
        onExec(exec);
      } catch (e) {
        if (unheard) return;
        unheard = true;
        console.warn(`exec log for ${machine.id} failed, its execs go on unlogged: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const reported = async (cmd: string, call: () => Promise<ExecResult>, unlogged = false): Promise<ExecResult> => {
      const t0 = Date.now();
      try {
        const res = await call();
        // A command that says its answer is the person's own file is recorded as having run and exited; what it
        // printed is that file, and a log kept on their disk is no place for it.
        report({ machineId: machine.id, cmd, ms: Date.now() - t0, ...(unlogged ? { exitCode: res.exitCode } : res) });
        return res;
      } catch (e) {
        report({ machineId: machine.id, cmd, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };
    const exec = (cmd: string, o?: { timeoutMs?: number }): Promise<ExecResult> => reported(cmd, () => machine.exec(cmd, o));
    // A run is one command to the log, however many execs carry it.
    const run = (script: string, o: RunOptions): Promise<ExecResult> => reported(script, () => machine.run(script, o), o.unlogged === true);
    return new Proxy(machine, {
      get(target, prop) {
        if (prop === "exec") return exec;
        if (prop === "run") return run;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  /** The entry's machine with every exec and run read for the provider's word that it cannot reach it: that refusal
   * marks the workspace and puts the sentence on the row now, and any answer takes the mark off for the next tick to
   * say, since a push here would carry the marked tick's reach without its sentence. */
  const watched = (entry: LiveWorkspace, machine: Machine): Machine => {
    const heard = async (call: () => Promise<ExecResult>): Promise<ExecResult> => {
      let res: ExecResult;
      try {
        res = await call();
      } catch (e) {
        if (e instanceof MachineUnreachableError && entry.machine.id === machine.id) {
          const standing = ctx.unreached.get(entry.record.id)?.machineId === machine.id;
          ctx.unreached.set(entry.record.id, { machineId: machine.id, line: e.message });
          if (!standing && entry.record.phase === "running") await ctx.emitStatus(entry, "unreachable", e.message);
        }
        throw e;
      }
      if (ctx.unreached.get(entry.record.id)?.machineId === machine.id) ctx.unreached.delete(entry.record.id);
      return res;
    };
    const exec = (cmd: string, o?: { timeoutMs?: number }): Promise<ExecResult> => heard(() => machine.exec(cmd, o));
    const run = (script: string, o: RunOptions): Promise<ExecResult> => heard(() => machine.run(script, o));
    return new Proxy(machine, {
      get(target, prop) {
        if (prop === "exec") return exec;
        if (prop === "run") return run;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  const observing = (b: MachineBackend): MachineBackend => ({ ...b, create: async spec => observed(await b.create(spec)), get: async id => observed(await b.get(id)) });
  /** Boots a golden fork for the record and writes back what the provider says it built.
   * A snapshot restores as the kind it was taken from, so the spec names that kind;
   * versions sealed before it was recorded were all sandbox. The create reads the guest's memory itself, once its
   * daemon has answered, so it forks with `readsMemory` off. */
  const fork = (record: WorkspaceRecord, bind: (machine: Machine) => void, override?: WorkspaceSpec, report?: StageReport, readsMemory = true): Promise<Machine> =>
    claiming(
      `workspace/${record.id}`,
      async b => {
        const image = ctx.keepsImages(b) ? await ctx.imageOf(record.golden) : undefined;
        const golden = image?.version;
        // A project golden's snapshot is the image; only a version's own snapshot may stand behind a template.
        const spec = forkSpec(record, golden?.kind ?? "sandbox", image === undefined ? undefined : goldenImage(image.projects === undefined && golden !== undefined ? golden : { snapshotId: record.golden }).spec, record.spec.engine === true || (golden !== undefined && (await ctx.recipeAsksEngine(golden))), override);
        // A place that has never held this image says missing about a reference no registry has: the fork lands
        // nowhere and the sentence says where it would land until that place holds a copy.
        const machine = await b.create(spec, report === undefined ? undefined : line => report("fork-requested", line, { waiting: true })).catch((e: unknown) => {
          if (image === undefined || record.place === undefined || !isMissing(e)) throw e;
          throw Object.assign(new Error(placeHoldsNoImageLine(ctx.placeDoorOf().nameOf(record.place), spec.fromSnapshot ?? spec.template ?? record.golden)), { kind: "invalid" });
        });
        // Named by its record before the claim is released, so no sweep sees it unclaimed.
        bind(machine);
        // No line for the machine coming up: the starting line above is the step a person waits through, and a
        // fork's own id names nothing to them.
        // A machine that boots under the workspace's name is not named again: the name is on the specification the
        // computer booted it from, and the command here runs inside the workspace, where it has no right to change
        // the host name and says so on every create.
        if (!ctx.namesWorkspace(b)) {
          const named = await setHostname(machine, record.name);
          if (named.refused === undefined) report?.("hostname-set", hostnameSetLine(named.host));
          else report?.("hostname-set", HOSTNAME_KEPT, { detail: named.refused });
        }
        // The fork carries the golden's copy; this one names the workspace and reads the disk and secrets as they are now.
        const context = await applyMachineContext(machine, { workspace: { name: record.name }, ...(golden !== undefined ? { golden } : {}) });
        if (context.failure !== undefined) console.warn(`machine context for ${record.id} on ${machine.id} ${context.summary}`);
        const shape = await ctx.shapeOf(machine);
        if (shape !== undefined) record.shape = shape;
        else delete record.shape;
        record.size = ctx.sizeBuilt(shape, spec);
        if (readsMemory && record.place === undefined) await ctx.readMemory(record, machine, b.capabilities.sizes);
        if (machine.streamUrl !== undefined) record.screen = { streamUrl: machine.streamUrl };
        else delete record.screen;
        return machine;
      },
      // The record says where its machine lives: this host's own provider, or the computer it was forked on.
      ctx.backendFor(record),
    );

  /** The machine a fork made, taken away and proven gone at the provider rather than at the delete's answer: a
   * DELETE Solari takes and does not act on would otherwise read as a machine that went. Rejects while the
   * provider still holds it, which is what keeps a record naming it. A machine gone is marked, so one the provider
   * lists running again is the sweep's to kill; a mark the store refuses is said, and the machine is still gone. */
  const unfork = async (entry: LiveWorkspace): Promise<void> => {
    const id = entry.machine.id;
    await killUntilGone(ctx.backendFor(entry.record), entry.machine, opts.killConfirm);
    await store.put(DROPPED, id, { machineId: id, at: new Date(clock.now()).toISOString() } satisfies DroppedMachine).catch((e: unknown) => {
      console.warn(`machine ${id} is gone but its mark was not stored (${e instanceof Error ? e.message : String(e)}); should the provider list it running again, the sweep reports it rather than killing it`);
    });
  };

  /** The engine knows three phases. A pause in flight is a nap to it (the wake resumes either way); a gone record's
   * machine is a stand-in it only ever meets through rebuild, which replaces the machine whatever the phase says. */
  const enginePhaseOf = (phase: WorkspacePhase): EnginePhase => {
    switch (phase) {
      case "running":
      case "napping":
      case "waking":
        return phase;
      case "pausing":
      case "gone":
        return "napping";
      default: {
        const _exhaustive: never = phase;
        return "running";
      }
    }
  };

  /** The record follows the engine once a wake, upgrade or rebuild put a machine under it; a gone record is gone no more. */
  const followMachine = (entry: LiveWorkspace): void => {
    entry.record.phase = "running";
    entry.record.machineId = entry.ws.machineId;
    entry.record.firstLife = entry.ws.isFirstLife;
    delete entry.record.gone;
    void ctx.syncDaemon(entry);
  };

  const attach = (record: WorkspaceRecord, machine: Machine): LiveWorkspace => {
    const entry: LiveWorkspace = { record, machine, ws: undefined as unknown as Workspace, generation: (live.get(record.id)?.generation ?? -1) + 1 };
    entry.machine = watched(entry, machine);
    // A merged or closed pull request reads as the record kept it and is never read again, a restart included.
    const kept = record.pr;
    if (kept !== undefined && kept.state !== "open") entry.pr = { ...kept, readAt: kept.mergedAt ?? kept.closedAt ?? 0 };
    if (record.checkout !== undefined) entry.checkout = record.checkout;
    const at = ctx.backendFor(record);
    /** A vault carries a workspace's own home onto a fresh fork of an image. A computer that keeps no image forks
     * none: such a workspace is a copy of that computer, its files stand on that computer's own disk, and its
     * pause is the stop of its machine there. So it gets none of the four hooks, a nap reads nothing off it and
     * stores nothing, a wake puts nothing back, and a stamp or a refusal an earlier nap wrote on its record is
     * about a vault it never had and goes. */
    const vaulted = ctx.keepsImages(at);
    if (!vaulted) {
      delete record.vaultedAt;
      delete record.vaultRefused;
    }
    entry.ws = new Workspace(
      machine,
      {
        goldenSnapshot: record.golden,
        // A kind that declares no lifecycle has its nap and wake refused before the engine is asked, so it never wakes.
        wakeAttempts: at.lifecycle?.budgets.wakeAttempts ?? 0,
        retire: m => gone.stop(at, m),
        resurrect: (override?: Partial<MachineSpec>) =>
          fork(record, m => {
            entry.machine = watched(entry, m);
          }, override),
        ...(vaulted
          ? ({
              // Taken off the running machine right before a replacement, capped: over the cap it says so, in the
              // one line that names the size and the cap, and the replacement goes on with no backup.
              vaultExport: async (m, drop) => {
                try {
                  return await vaultExport(m, { maxBytes: vaultCapBytes, ...(drop === undefined ? {} : { drop }) });
                } catch (e) {
                  if (e !== null && typeof e === "object" && (e as { kind?: unknown }).kind === "vaultTooLarge") {
                    console.warn(`vault for ${record.id} not taken before the replacement: ${e instanceof Error ? e.message : String(e)}; replacing with no backup`);
                    return undefined;
                  }
                  throw e;
                }
              },
              vaultImport: async (m, payload) => {
                await importInto(m, payload, "/");
              },
              stashVault: async m => {
                // The vault the last landed nap stored stands until the provider pauses this machine at all.
                if (ctx.napRefusedOf(entry) !== undefined) return;
                // The disk is synced before the pause whatever the backend, so a stop that snapshots it holds a whole
                // one; a machine that cannot be asked still pauses.
                await syncDisk(entry.machine).catch((e: unknown) => {
                  console.warn(`disk sync before the nap of ${record.id} failed: ${e instanceof DiskSyncError ? e.answer : e instanceof Error ? e.message : String(e)}; napping anyway`);
                });
                // A pause that keeps the disk resumes the same machine with the home on it, so the nap reads none of
                // it; the vault is taken off the running machine at a rebuild instead.
                if (ctx.pauseKeepsDisk(at)) return;
                try {
                  await store.putBlob(VAULTS, record.id, await vaultExport(m, { maxBytes: vaultCapBytes }));
                  record.vaultedAt = new Date(clock.now()).toISOString();
                  delete record.vaultRefused;
                } catch (e) {
                  const why = e instanceof Error ? e.message : String(e);
                  // The record carries it, and the record alone: the files stay unbacked until a nap stores one, so the
                  // verdict stands on the pane's own backup line rather than passing through one nap's status.
                  record.vaultRefused = why;
                  console.warn(`nap vault for ${record.id} not stored, previous kept: ${why}`);
                }
              },
              restoreVault: async m => {
                const payload = await store.getBlob(VAULTS, record.id);
                if (payload !== undefined) await importInto(m, payload, "/");
              },
            } satisfies Pick<WorkspaceHooks, "vaultExport" | "vaultImport" | "stashVault" | "restoreVault">)
          : {}),
        // The backend settles its own moves under its own budgets; the runtime sends each once, hands the resume
        // the person's stop, and says on the row that a resume the backend gave up on is being read about.
        move: (m, move) =>
          move === "resume"
            ? m.resume(entry.wakeStop?.signal).catch(async (e: unknown) => {
                if (e instanceof ResumeUnansweredError) await ctx.saysWaking(entry, RESUME_UNANSWERED);
                throw e;
              })
            : m.pause(),
        wakeCheck: async m => {
          const expected = record.shape;
          let both = "";
          if (expected !== undefined && m.describe) {
            let actual: MachineShape;
            try {
              actual = await m.describe();
            } catch (e) {
              return `provider view of ${m.id} unavailable (${e instanceof Error ? e.message : String(e)})`;
            }
            both = `created as ${JSON.stringify(expected)}, provider view ${JSON.stringify(actual)}`;
            const fault = shapeFault(expected, actual);
            if (fault !== undefined) {
              console.warn(`wake check on ${m.id}: ${fault}; ${both}`);
              return `${fault} on ${m.id} (${both})`;
            }
          }
          const fault = await ctx.pingDaemon(entry);
          return fault === undefined || both === "" ? fault : `${fault} (${both})`;
        },
      },
      { phase: enginePhaseOf(record.phase), firstLife: record.firstLife },
    );
    live.set(record.id, entry);
    return entry;
  };

  const idleWindowOf = (r: WorkspaceRecord): number | null => settingFor(r.idleWindowMs, ctx.settingsAt(ctx.placeIdOf(r))?.napMs, defaultIdleWindowMs);

  /** Every live session and exec of a workspace ends here when its machine goes away under it; the harness's own end, if it ever comes, is dropped. */
  const endSessions = (workspaceId: string, reason: string): void => {
    for (const s of sessions.values()) if (s.view.workspaceId === workspaceId) s.end?.(reason);
    for (const e of execs) if (e.workspaceId === workspaceId) e.end(reason);
  };

  /** Everything a workspace left on this side once its machine is dealt with: live state, flushes, stored rows, vault. */
  const drop = async (id: string): Promise<void> => {
    const going = live.get(id);
    going?.lateRead?.();
    // Whatever this host was holding open about the machine goes with the record that named it: the child
    // carrying the road to a machine over ssh would otherwise hold a port for a workspace nobody can name.
    if (going !== undefined) {
      await ctx.moduleOf(going.record.kind)
        .dropped(going)
        .catch((e: unknown) => console.warn(`${going.record.name}'s machine ${going.machine.id} kept something of this host's: ${e instanceof Error ? e.message : String(e)}`));
    }
    live.delete(id);
    // A folder on this computer goes from its daemon's roots file with its record, since the computer and the
    // folder both stay; a fork's machine goes with its record and takes its file along.
    if (going !== undefined && copiesFolder(going.record.kind)) await ctx.writeDaemonRoots(going);
    ctx.revivedAt.delete(id);
    ctx.unreadAt.delete(id);
    ctx.unreached.delete(id);
    ctx.polledReach.delete(id);
    ctx.napRefusals.delete(id);
    transcripts.delete(id);
    transcriptBytes.delete(id);
    pendingEvents.delete(id);
    pendingBytes.delete(id);
    transcriptIndex.delete(id);
    ctx.daemonNotes.delete(id);
    // Every thread this workspace drops takes its slate with it, as a thread's own delete does: its record, its
    // timers (an always one would tick on for a thread nobody can reach) and its folder.
    const dropped = new Set<string>();
    for (const [threadId, held] of threadRecords) if (held.workspaceId === id) dropped.add(threadId);
    for (const s of sessions.values()) if (s.view.workspaceId === id && s.view.threadId !== undefined) dropped.add(s.view.threadId);
    for (const [handleId, s] of sessions) if (s.view.workspaceId === id) sessions.delete(handleId);
    for (const [threadId, kept] of ctx.keptAgents) if (kept.workspaceId === id) ctx.reapKept(threadId);
    for (const [threadId, held] of threadRecords) if (held.workspaceId === id) threadRecords.delete(threadId);
    for (const threadId of dropped) await ctx.slates.forget(threadId);
    ctx.viewedMarks.delete(id);
    live.get(id)?.prPoll?.();
    ctx.cancelFlush(id);
    await ctx.transcriptQueue.get(id);
    ctx.transcriptQueue.delete(id);
    await indexFlushes.get(id);
    indexFlushes.delete(id);
    await store.delete(WORKSPACES, id);
    await store.deleteBlob(TRANSCRIPTS, id);
    rows?.clear(id);
    unreadIndexes.delete(id);
    await store.deleteBlob(TRANSCRIPT_HEADS, id);
    await store.deleteBlob(TRANSCRIPT_INDEX, id);
    await ctx.dropSentImages(id, "all");
    ctx.keptWrites.delete(id);
    await store.delete(WORKSPACE_NAMES, id);
    await store.delete(SESSIONS, id);
    await store.delete(CREATES, `workspace/${id}`);
    await store.deleteBlob(VAULTS, id);
    bus.emit({ type: "workspace.deleted", workspaceId: id });
  };

  // Pausing is persisted and pushed before the provider is asked, so a list
  // fetched mid-pause never says running, and the sessions end while the
  // machine can still be told to stop them.
  const napWith = async (id: string, reason?: string): Promise<WorkspaceView> => {
    const entry = await ctx.entryOf(id);
    if (await runsUnderNapping(entry)) await adoptRunning(entry);
    if (entry.napping) return entry.napping;
    if (entry.record.phase !== "running") return ctx.view(entry.record);
    entry.napping = (async () => {
      try {
        entry.record.phase = "pausing";
        await ctx.persist(entry.record);
        await ctx.emitStatus(entry, "napping");
        try {
          await entry.ws.nap();
        } catch (e) {
          // A 404 the pause answered with is a sighting like any other: it settles only where the state read agrees,
          // and a machine still running takes the road any other refused pause takes.
          if (isMissing(e) && settled(await settleGone(entry, goneWords(entry.record.machineId, { by: "pause", at: clock.now(), answer: providerSaid(e) })))) throw e;
          entry.record.phase = entry.ws.currentPhase;
          await ctx.persist(entry.record);
          if (e instanceof NapRefusedError) {
            if (ctx.napRefusedOf(entry) === undefined) console.warn(`the provider does not pause ${entry.machine.id} of ${id} (${e.said}); an idle nap waits for the backstop and exports no vault until a pause lands`);
            ctx.napRefusals.set(id, { machineId: entry.machine.id, said: e.said });
          }
          if (e instanceof StopRefusedError) ctx.stopRefusals.set(id, { machineId: entry.machine.id, said: e.said });
          await ctx.emitStatus(entry, ctx.reachOf(entry), e instanceof Error ? e.message : String(e));
          throw e;
        }
        // The reason says the machine paused, so it is written once the provider has confirmed that.
        endSessions(id, PAUSED_REASON);
        ctx.napRefusals.delete(id);
        ctx.stopRefusals.delete(id);
        entry.record.phase = "napping";
        await ctx.persist(entry.record);
        bus.emit({ type: "workspace.napped", workspaceId: id });
        await ctx.emitStatus(entry, "napping", reason);
        return ctx.view(entry.record);
      } finally {
        delete entry.napping;
      }
    })();
    return entry.napping;
  };

  /** One read of the provider a while after a wake gave up: a resume the runtime stopped waiting on can land later,
   * and a record still saying napping over a machine that runs would bill under a paused row until a verb met it.
   * The read that finds it running adopts, as any verb would. */
  const armLateRead = (entry: LiveWorkspace): void => {
    entry.lateRead?.();
    entry.lateRead = clock.schedule(() => {
      delete entry.lateRead;
      void runsUnderNapping(entry)
        .then(runs => (runs ? adoptRunning(entry) : undefined))
        .catch((e: unknown) => console.warn(`late read of ${entry.record.id}: ${e instanceof Error ? e.message : String(e)}`));
    }, lateReadMs, { unref: true });
  };

  /** The provider paused the machine outside a nap (its idle timer, a console click): the record follows the fact, so a wake resumes it the normal way. */
  const adoptPause = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.phase !== "running" || entry.napping || entry.waking) return;
    entry.ws.notePaused();
    ctx.napRefusals.delete(entry.record.id);
    entry.record.phase = "napping";
    await ctx.persist(entry.record);
    endSessions(entry.record.id, PAUSED_REASON);
    bus.emit({ type: "workspace.napped", workspaceId: entry.record.id, found: true });
    await ctx.emitStatus(entry, "napping", "paused outside wsp");
  };
  /** One read of the provider for a record that says napping: true when the machine runs there, so the pause never
   * took or nobody wrote the resume. A read the provider refuses answers false; the record's word stands until a
   * verb meets the machine. */
  const runsUnderNapping = async (entry: LiveWorkspace): Promise<boolean> =>
    entry.record.phase === "napping" && (await entry.machine.state().catch(() => "paused")) === "running";
  /** The provider runs a machine the record calls napping: the record follows the fact and the machine is reached
   * like any running one. Nothing is resumed, so the first life the record holds is untouched. */
  const adoptRunning = (entry: LiveWorkspace): Promise<void> => {
    if (entry.adopting) return entry.adopting;
    if (entry.record.phase !== "napping" || entry.napping || entry.waking) return Promise.resolve();
    entry.adopting = (async () => {
      try {
        entry.ws.noteRunning();
        followMachine(entry);
        await ctx.persist(entry.record);
        bus.emit({ type: "workspace.woken", workspaceId: entry.record.id, machineId: entry.record.machineId });
        await ctx.emitStatus(entry, ctx.reachOf(entry), ALREADY_RUNNING);
      } finally {
        delete entry.adopting;
      }
    })();
    return entry.adopting;
  };
  /** What a gone verdict is checked against, a short wait after the call that made it: the provider read until
   * GONE_READS reads in a row answer gone, since a gateway copy that never held the machine answers 404 while the
   * other bills on. A read that fails another way confirms nothing and answers its error. */
  const goneConfirmed = async (backend: MachineBackend, machineId: string): Promise<MachineState | Error> => {
    if (goneConfirmMs > 0) await new Promise<void>(resolve => void clock.schedule(() => resolve(), goneConfirmMs, { unref: true }));
    return readGone(backend, machineId).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  };
  /** The one road to gone, whichever call found the provider no longer knew the machine (deleted behind wsp, or
   * expired): the verdict is confirmed, and where it holds the record follows the fact and stays there. Until then
   * the record keeps the phase it had, so the row and the meter go on reading the machine as billing and the sweep
   * spares it as claimed. The gone event closes the awake stretch with a cost tick at this instant, drops the idle
   * window and ends the sessions; the row and the one log line carry the words; rebuild and delete are the roads out. */
  const settleGone = async (entry: LiveWorkspace, reason: string): Promise<GoneOutcome> => {
    const machineId = entry.record.machineId;
    const read = await goneConfirmed(ctx.backendFor(entry.record), machineId);
    if (read !== "gone") {
      const followed = read instanceof Error ? `the reads that followed failed: ${read.message}` : `the state read that followed said ${read}`;
      console.warn(`workspace ${entry.record.id} is not gone: ${reason}, and ${followed}`);
      return read instanceof Error ? "unchecked" : "not-gone";
    }
    return markGone(entry, machineId, reason);
  };
  /** A verdict already confirmed, written: the record, the sessions, the event and the row move together. */
  const markGone = async (entry: LiveWorkspace, machineId: string, reason: string): Promise<GoneOutcome> => {
    if (entry.record.phase === "gone" || entry.record.machineId !== machineId) return "moot";
    entry.record.phase = "gone";
    entry.record.gone = reason;
    await ctx.persist(entry.record);
    endSessions(entry.record.id, GONE_REASON);
    console.warn(goneLogLine(entry.record.id, reason));
    bus.emit({ type: "workspace.gone", workspaceId: entry.record.id, machineId: entry.record.machineId, reason });
    await ctx.emitStatus(entry, "gone", reason);
    return "settled";
  };
  /** Records whose gone verdict is being read again: the poll sees the same 404 every tick while the reads run. */
  const rereading = new Set<string>();
  /** A sighting from outside a verb (the poll, the sweep): a nap or a wake in flight meets the machine itself and
   * settles what it finds, so the sighting defers to it. The row never read gone, so a verdict that did not hold
   * leaves it as it was, and one nothing could check says so. */
  const adoptGone = async (entry: LiveWorkspace, reason: string): Promise<void> => {
    const id = entry.record.id;
    if (entry.record.phase === "gone" || entry.napping || entry.waking || rereading.has(id)) return;
    rereading.add(id);
    try {
      if ((await settleGone(entry, reason)) === "unchecked") await ctx.emitStatus(entry, ctx.reachOf(entry), GONE_UNCHECKED);
    } finally {
      rereading.delete(id);
    }
  };
  /** A record marked gone over a machine the provider still holds: the state read by id is the word on gone, so the
   * record follows it back rather than leaving a rebuild to abandon a healthy machine that would bill on unrecorded.
   * The phase the record left gone for, or undefined when this read moved nothing. */
  const recoverGone = async (entry: LiveWorkspace): Promise<"running" | "napping" | undefined> => {
    if (entry.record.phase !== "gone" || entry.napping || entry.waking) return undefined;
    const read = await entry.machine.state().catch(() => undefined);
    const phase = read === undefined ? undefined : phaseLeavingGone(read);
    if (phase === undefined) return undefined;
    if (phase === "running") {
      entry.ws.noteRunning();
      followMachine(entry);
    } else {
      entry.ws.notePaused();
      entry.record.phase = phase;
      delete entry.record.gone;
    }
    await ctx.persist(entry.record);
    if (phase === "running") bus.emit({ type: "workspace.woken", workspaceId: entry.record.id, machineId: entry.record.machineId });
    else bus.emit({ type: "workspace.napped", workspaceId: entry.record.id, found: true });
    await ctx.emitStatus(entry, phase === "running" ? ctx.reachOf(entry) : "napping", NOT_GONE);
    return phase;
  };
  bus.on("workspace.status", e => {
    if (e.type !== "workspace.status") return;
    // No session ends on a reach verdict: the probe reads this computer's own road, and a resolver that dropped one
    // name for three minutes on 2026-09-12 read two live machines dark and cost every turn on them its process.
    const entry = live.get(e.status.id);
    if (entry === undefined) return;
    if (e.status.phase === "running" && e.status.machineState === "paused") void adoptPause(entry);
  });

  /** How long the machine behind a record has been quiet by its own computer's reading, where that computer
   * counts one. A read that fails says nothing about the workspace, and the stop goes ahead: a backend that
   * cannot be asked is a backend that does not answer. */
  const quietOf = async (id: string): Promise<number | undefined> => {
    const entry = live.get(id);
    if (entry === undefined || entry.record.phase !== "running") return undefined;
    // Called on the lifecycle itself, as the backstop below is, rather than pulled off it and called detached:
    // one interface, and an implementer is free to write this as a method, which keeps its own object only if
    // the call goes through it.
    return ctx.backendFor(entry.record).lifecycle?.quietForMs?.(entry.machine).catch((e: unknown) => {
      console.warn(`quiet figure of ${id} not read: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
  };

  const idle = createIdlePolicy({
    windowOf: id => {
      const entry = live.get(id);
      if (entry === undefined) return null;
      const windowMs = idleWindowOf(entry.record);
      // A refusal that stands is asked again only at the backstop; a window that is off stays off.
      return windowMs !== null && ctx.napRefusedOf(entry) !== undefined ? backstopMs(windowMs) : windowMs;
    },
    onIdle: async (id, windowMs) => {
      // What the computer running it can see of the workspace working, asked once here rather than counted by
      // the timer: a dev server somebody is clicking through and a build somebody started answer with a figure
      // inside the window, and the window starts over instead of the workspace stopping under them. A backend
      // that cannot say leaves the stop to this host's own clock, which is every provider.
      const quiet = await quietOf(id);
      if (quiet !== undefined && quiet < windowMs) {
        idle.touch(id);
        return;
      }
      try {
        await napWith(id, IDLE_REASON.of(windowMs));
      } catch (e) {
        if (e instanceof MoveUnansweredError) throw e;
        // A machine the pause found gone settled its record on the way out; the gone event dropped this window.
        if (isMissing(e)) return;
        // The provider answered with a refusal: asking again at once changes nothing, so a full window starts from
        // its answer, the backstop where the refusal stands for the machine, and the row is pushed once more with
        // that window, the words unchanged. A refusal that stands was logged once, where the pause met it.
        idle.touch(id);
        const entry = live.get(id);
        if (entry !== undefined) await ctx.emitStatus(entry, ctx.reachOf(entry), ctx.napRefusedReason(entry) ?? ctx.stopRefusedReason(entry) ?? (e instanceof Error ? e.message : String(e)));
        if (!(e instanceof NapRefusedError)) console.warn(`idle nap of ${id} was answered with ${providerSaid(e)}; a full ${Math.round(windowMs / 60_000)} min window starts over`);
      }
    },
    retryMs: opts.status?.pollIntervalMs ?? POLL_INTERVAL_MS,
    clock,
    // A backend whose backstop is pushed rather than set at create hears the instant on every arming of a running
    // machine; the backend decides whether one is worth a call, and a call that fails changes nothing about the
    // window. A touch on a napped or gone workspace arms a window too, but its machine needs no stop timer.
    onBackstop: (id, until) => {
      const entry = live.get(id);
      if (entry === undefined || entry.record.phase !== "running") return;
      void ctx.backendFor(entry.record)
        .lifecycle?.backstop?.(entry.machine, until)
        .catch((e: unknown) => console.warn(`backstop of ${id} on ${entry.machine.id} not set: ${e instanceof Error ? e.message : String(e)}`));
    },
  });
  // Every road into a workspace the runtime can see starts its window over;
  // typing over the browser's daemon link arrives as workspaces.touch.
  for (const type of ["session.start", "session.delta", "session.done", "session.end", "session.steer", "inbox.file", "workspace.woken", "workspace.upgraded", "project.import", "project.export"] as const) {
    bus.on(type, e => idle.touch((e as { workspaceId: string }).workspaceId));
  }
  bus.on("workspace.created", e => e.type === "workspace.created" && idle.touch(e.workspace.id));
  for (const type of ["workspace.napped", "workspace.gone", "workspace.deleted"] as const) {
    bus.on(type, e => idle.forget((e as { workspaceId: string }).workspaceId));
  }
  return {
    imageMark, inflight, claiming, observed, observing, fork, unfork, followMachine, attach, endSessions, drop, napWith,
    armLateRead, adoptPause, runsUnderNapping, adoptRunning, settleGone, markGone, rereading, adoptGone, recoverGone,
    idle,
  };
}

function bootArea(ctx: RuntimeContext): BootArea {
  const {
    store, local, placeDoor, bus, clock, hostId, deviceDoor, live, projectsHeld, setups, builders, threadRecords,
    wakeAt, sessions, rows, transcriptIndex, places,
  } = ctx;
  /** Whether a seal can still be taken from a builder at this place: the machine's own first life, or a provider
   * whose copy of a disk is the disk as it stands. The one place the golden road asks it; every reader above the
   * runtime takes the answer on the builder's view. A place nothing here can reach yet answers on first life
   * alone, which is what the record already says. */
  const sealableAt = (place: string | undefined, firstLife: boolean): boolean => {
    if (firstLife) return true;
    const at = places.backend(place ?? places.wired) ?? placeDoor?.backendOf(place ?? places.wired);
    return at?.capabilities.snapshotsAnyLife === true;
  };
  const lifeOf = (stored: StoredBuilder, machine: Machine, sealable: boolean): LiveBuilder["life"] => {
    // Only a label that names another state file makes it foreign; a view with no labels is ours.
    const label = machine.labels?.[OWNER_LABEL];
    // A hold from this host is checked against its pid; one from another host is trusted while its heartbeat
    // is fresh, and a heartbeat that cannot be read counts as fresh: when unsure, the builder is held.
    const holder = stored.heldBy;
    const mine = holder !== undefined && holder.host === hostId && holder.pid === process.pid;
    const beatAge = holder !== undefined ? Date.now() - Date.parse(holder.heartbeat) : Number.NaN;
    const fresh = Number.isNaN(beatAge) || beatAge < HELD_TTL_MS;
    const held = holder !== undefined && !mine && fresh && (holder.host !== hostId || pidAlive(holder.pid));
    // A placeholder its dead holder left mid-setup never finished its stages: stale, whatever the marker says.
    return label !== undefined && label !== ctx.state.owner ? "foreign" : held ? "held" : !sealable || stored.building === true ? "stale" : "reusable";
  };
  const liveOf = (record: BuilderRecord, machine: Machine): LiveBuilder => {
    const sealable = sealableAt(record.place, record.firstLife);
    return {
      record,
      builder: {
        machine, kind: record.kind, baseTemplate: record.baseTemplate, setupSha: record.setupSha, createdAt: record.createdAt, firstLife: record.firstLife, size: record.size,
        ...(record.import !== undefined ? { import: record.import } : {}),
        ...(record.base !== undefined ? { base: record.base } : {}),
      },
      sealable,
      life: lifeOf(record, machine, sealable),
    };
  };
  /** A stored record this process has no entry for yet; its machine is fetched once, here. */
  const admit = async (stored: StoredBuilder): Promise<void> => {
    // A builder made at another place is read on that place's backend; the wired one has never heard of it. A
    // joined computer that has never said what it forks with cannot be asked, and one that is not connected
    // answers absent: either way the record stays as it is until that computer dials in, and only a place that
    // reads the machine gone through readGone drops it; one it still finds is admitted at the next refresh.
    const place = stored.place ?? places.wired;
    const at = places.backend(place) ?? placeDoor?.backendOf(place);
    if (at === undefined) return;
    let machine: Machine;
    try {
      machine = ctx.observed(await at.get(stored.id));
    } catch (e) {
      if (isPlaceAbsent(e) || isNoProvider(e)) return;
      if (!isMissing(e)) throw e;
      if ((await readGone(at, stored.id)) === "gone") await store.delete(BUILDERS, stored.id);
      return;
    }
    // The view get() fetched is read once: a second read would reset the provider's idle timer again.
    const seen = machine.seen;
    const state = seen?.state ?? (await machine.state());
    // A machine found paused was paused: that alone clears the marker for good. Nothing is read from the
    // provider's createdAt: on a running machine never paused, resumed or exec'd it read +6.4 s at two minutes
    // and +306 s at ten (canary, 2026-09-04 UTC), so it moves with no lifecycle event and decides nothing.
    const firstLife = stored.firstLife === true && state === "running";
    const record: BuilderRecord = { ...stored, firstLife, size: stored.size ?? ctx.sizeBuilt(await ctx.shapeOf(machine), at.pricing.defaultSize) };
    if (stored.firstLife === true && !firstLife) await store.put(BUILDERS, record.id, record);
    builders.set(record.id, liveOf(record, machine));
    if (stored.sealed !== undefined) ctx.armGrace(record.id, stored.sealed.at);
  };
  /** The store is the truth across processes, and another wsp (an init beside this host, a second host) writes it
   * after this one hydrated: every decision that kills or reuses a builder reads it first. A row this process has
   * no entry for is admitted, a changed hold or marker re-derives the life, a row another process dropped goes with
   * it. Own records are this process's and are not re-read; no machine is re-read either, so the first-life marker
   * only ever drops here. Passes overlap (a sweep beside a prepare): the newest listing wins, so a pass that finds
   * a newer one started after its own listing applies nothing, drops nothing, and hands its caller the newer pass. */
  let passes = 0;
  let latest: Promise<void> = Promise.resolve();
  const refreshBuilders = (): Promise<void> => (latest = refreshNow(++passes));
  const refreshNow = async (pass: number): Promise<void> => {
    const rows = (await store.list(BUILDERS)) as StoredBuilder[];
    const seen = new Set<string>();
    for (const stored of rows) {
      if (pass !== passes) return latest;
      seen.add(stored.id);
      const current = builders.get(stored.id);
      if (current === undefined) await admit(stored);
      else if (current.life !== "own") {
        const record: BuilderRecord = { ...stored, firstLife: stored.firstLife === true && current.builder.firstLife, size: stored.size ?? current.record.size };
        Object.assign(current, liveOf(record, current.builder.machine));
      }
    }
    if (pass !== passes) return latest;
    for (const [id, b] of [...builders]) if (!seen.has(id) && b.life !== "own") builders.delete(id);
  };

  /** Whether this host holds that workspace by a stand-in for a machine it could not ask anything about: the one
   * reading of "nothing is known about this one yet", which is what a place dialling in is the moment to fix. A
   * record with no live entry at all reads the same, since a hydration that never ran holds nothing either. */
  const isHeldAway = (id: string): boolean => {
    const entry = live.get(id);
    return entry === undefined || isAbsentMachine(entry.machine);
  };

  /** What the provider said to the load's one read of a record now held, quoted when the record settles gone. */
  const heldAnswers = new Map<string, string>();
  /** A record the load held by a stand-in, read again the way a gone verdict is confirmed: a machine the provider
   * finds is loaded onto, one it answers gone for GONE_READS reads in a row settles gone through markGone, and a
   * read that fails leaves the record held for the next sweep. */
  const rereadHeld = async (id: string, by: GoneSeenBy): Promise<void> => {
    const entry = live.get(id);
    if (entry === undefined || !isAbsentMachine(entry.machine) || ctx.rereading.has(id)) return;
    ctx.rereading.add(id);
    try {
      const machineId = entry.record.machineId;
      const seen = await Promise.resolve()
        .then(() => sightMachine(ctx.backendFor(entry.record), machineId))
        .catch(() => undefined);
      if (seen === undefined || ctx.state.closed || live.get(id) !== entry) return;
      if (seen.machine !== undefined) {
        const raw = await store.get(WORKSPACES, id);
        const again = raw === undefined ? undefined : await hydrateWorkspace(raw, seen as FoundMachine);
        if (again !== undefined) void ctx.syncDaemon(again);
        return;
      }
      const answer = heldAnswers.get(id);
      // The stand-in refuses every call with the held line; a gone record stands on the machine every gone load gets.
      await ctx.markGone(ctx.attach(entry.record, deadMachine(machineId)), machineId, goneWords(machineId, { by, at: clock.now(), ...(answer !== undefined ? { answer } : {}) }));
    } finally {
      if (!isHeldAway(id)) heldAnswers.delete(id);
      ctx.rereading.delete(id);
    }
  };

  /** One stored workspace read into a live one: what the provider says about its machine decides the phase, and
   * the record follows. Read once for every record at hydration, and again for a record on a place the moment that
   * place dials in, since until then nothing could be asked about its machine. Answers the entry whose daemon wants
   * syncing, since the sync waits out a running turn and only the caller knows when its session rows are in. */
  const hydrateWorkspace = async (raw: unknown, seen?: FoundMachine): Promise<LiveWorkspace | undefined> => {
    const stored = raw as WorkspaceRecord;
    const kind = stored.kind;
    // A record whose kind this host wired no module for, or whose place forks nothing any more, is left as it
    // was: only the host that owns that machine can serve it.
    let at: MachineBackend;
    try {
      at = ctx.moduleOf(kind).backend(stored as WorkspaceRecord);
    } catch (e) {
      console.warn(`workspace ${stored.id} is left as it was: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // The store is the fleet's truth and get(id) the provider's: a record whose machine the provider lost is
    // gone and one whose machine it holds paused is napping, whatever phase either was left at, and both say so
    // before anything lists it or meters it. A machine nothing can be asked about is neither: a place that is not
    // connected, a host started without its provider key and a provider read that failed all leave the record on
    // the word it was left with, and the host serves the rest rather than failing on the first record it cannot read.
    const goldenKind = (await ctx.imageOf(stored.golden).catch(() => undefined))?.version?.kind ?? "sandbox";
    let missing: string | undefined;
    let absent = false;
    // The kind is the golden's, which the record names: a desktop fork on a computer that is away is a desktop
    // fork, and nothing about it is guessed while nothing can be asked. The stand-in refuses with the error that
    // came back, so every road on the row says the one true thing about why it cannot be read.
    const heldAway = (e: unknown): Machine => {
      absent = true;
      const refusal = e instanceof Error ? e : new Error(String(e));
      return absentMachine(stored.machineId, goldenKind, () => {
        throw refusal;
      });
    };
    const machine =
      seen?.machine ??
      (await at.get(stored.machineId).catch((e: unknown) => {
        if (!isMissing(e)) return heldAway(e);
        // One 404 is not gone: a gateway copy that never held the machine answers it while the other bills on. A live
        // record is held as it was and confirmed once the host serves (rereadHeld), since the reads that confirm a
        // gone machine take seconds each and a fleet the provider expired overnight answers 404 for every record.
        if (stored.phase !== "gone") {
          heldAnswers.set(stored.id, providerSaid(e));
          return heldAway(new Error(goneUnconfirmedLine(stored.machineId, providerSaid(e))));
        }
        missing = providerSaid(e);
        return deadMachine(stored.machineId);
      }));
    // The state rides on the view get() just fetched; a second read would reset the provider's idle timer.
    const atProvider = missing !== undefined ? "gone" : absent ? undefined : (seen?.state ?? machine.seen?.state ?? (await machine.state().catch(() => undefined)));
    // A record left gone leaves it on the one predicate every road out of gone reads, and on nothing else. Any
    // other record follows the provider whatever word it was left with: paused means the pause landed or the
    // resume never did, running means the pause never took or the resume landed with nobody left to write it.
    // Only a machine still starting leaves the stored word standing, and a pausing one then reads napping: a
    // wake resumes it either way.
    const phase: WorkspacePhase =
      atProvider === undefined
        ? stored.phase
        : stored.phase === "gone"
          ? (phaseLeavingGone(atProvider) ?? "gone")
          : atProvider === "gone"
            ? "gone"
            : atProvider === "paused"
              ? "napping"
              : atProvider === "running"
                ? "running"
                : stored.phase === "pausing"
                  ? "napping"
                  : stored.phase;
    const record: WorkspaceRecord = {
      ...stored,
      phase,
      ...(machine.streamUrl !== undefined ? { screen: { streamUrl: machine.streamUrl } } : {}),
    };
    if (phase === "gone") record.gone = stored.gone ?? goneWords(stored.machineId, { by: "record load", at: clock.now(), ...(missing !== undefined ? { answer: missing } : {}) });
    else delete record.gone;
    ctx.attach(record, machine);
    if (phase !== stored.phase) {
      if (phase === "gone") console.warn(goneLogLine(stored.id, record.gone!));
      else console.warn(`workspace ${stored.id} was left ${stored.phase} and its machine is ${String(atProvider)} at the provider; the record hydrates ${phase}`);
      await ctx.persist(record);
    }
    if (phase !== "running" || absent) return undefined;
    ctx.idle.touch(stored.id);
    return live.get(stored.id)!;
  };

  let hydrated: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    hydrated ??= (async () => {
      const stored = (await store.get(OWNER, "id")) as { id?: unknown } | undefined;
      if (typeof stored?.id === "string" && stored.id !== "") ctx.state.owner = stored.id;
      else {
        ctx.state.owner = `h_${randomBytes(4).toString("hex")}`;
        await store.put(OWNER, "id", { id: ctx.state.owner });
      }
      const since = (await store.get(READS, READS_ID)) as { at?: unknown } | undefined;
      if (typeof since?.at === "number") ctx.state.readsSince = since.at;
      else {
        ctx.state.readsSince = clock.now();
        await store.put(READS, READS_ID, { at: ctx.state.readsSince });
      }
      await ctx.migrateCopies();
      // The places are read before the workspaces: a fork standing on one asks which backend it lives on, and that
      // answer comes off what the place last said about itself rather than off a socket that may not be open.
      await placeDoor?.load();
      // The projects are read before the workspaces: every workspace record names one, and its view joins that
      // project's name, path and computer off this map.
      for (const raw of await store.list(PROJECTS)) {
        const project = raw as ProjectView;
        projectsHeld.set(project.id, project);
      }
      // A project recorded before the repo it sits in was kept on it gets it read once here; a folder git holds no
      // repo in is read again at each boot, which is one git call.
      if (local !== undefined) {
        await Promise.all(
          [...projectsHeld.values()]
            .filter(p => p.git === undefined && p.source.kind === "folder" && copiesFolder(kindForComputer(p.computer)))
            .map(async p => {
              const top = await ctx.gitTopOf(p.path).catch(() => undefined);
              if (top !== undefined) await ctx.rememberProject({ ...p, git: { top } });
            }),
        );
      }
      await setups.load();
      const toSync: LiveWorkspace[] = [];
      for (const raw of await store.list(WORKSPACES)) {
        const entry = await hydrateWorkspace(raw);
        if (entry !== undefined) toSync.push(entry);
      }
      // A state file an older build wrote holds the transcripts inside it: each is written to its files whole, and
      // only then is the state file written once without them.
      const inside = (await store.list(TRANSCRIPTS)) as TranscriptRecord[];
      // One whose files did not read stays in the state file, whole, for the next boot to move.
      const moved: string[] = [];
      for (const t of inside) {
        try {
          await ctx.moveTranscript(t);
          moved.push(t.workspaceId);
        } catch (e) {
          console.warn(`${e instanceof Error ? e.message : String(e)}, so it stays in the state file for the next boot to move`);
        }
      }
      await Promise.all(moved.map(id => store.delete(TRANSCRIPTS, id)));
      if (rows !== undefined) ctx.moveBlobs(rows);
      for (const id of await store.keys(WORKSPACES)) if (!transcriptIndex.has(id)) await ctx.loadIndex(id);
      const left: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; run?: string; from?: number; asked?: TurnAsked; turnToken?: string; scopeDeviceId?: string; snapshot?: string }[] = [];
      /** Turns that ended while their card was still being read: the commit stayed on the row for this host to read. */
      const unread: { view: SessionView; turnId: string; snapshot?: string }[] = [];
      for (const raw of await store.list(SESSIONS)) {
        const index = raw as SessionIndexRecord;
        if (!live.has(index.workspaceId)) continue;
        const marks = Object.entries(index.viewed ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === "string");
        if (marks.length > 0) ctx.viewedMarks.set(index.workspaceId, Object.fromEntries(marks));
        for (const [threadId, held] of Object.entries(index.threads ?? {})) {
          if (typeof held?.harness !== "string") continue;
          const placed = ThreadPlacement.safeParse(held.section);
          threadRecords.set(threadId, {
            workspaceId: index.workspaceId,
            harness: held.harness,
            ...(typeof held.permissionMode === "string" ? { permissionMode: held.permissionMode } : {}),
            ...(typeof held.readAt === "number" ? { readAt: held.readAt } : {}),
            ...(typeof held.settledAt === "number" ? { settledAt: held.settledAt } : {}),
            ...(typeof held.pinnedAt === "number" ? { pinnedAt: held.pinnedAt } : {}),
            ...(typeof held.snoozedUntil === "number" ? { snoozedUntil: held.snoozedUntil } : {}),
            ...(placed.success ? { section: placed.data } : {}),
            ...(typeof held.resumeAt === "string" ? { resumeAt: held.resumeAt } : {}),
            ...(typeof held.rewound?.before === "string" && typeof held.rewound.at === "number" ? { rewound: { before: held.rewound.before, at: held.rewound.at } } : {}),
          });
          if (typeof held.snoozedUntil === "number") wakeAt(threadId, held.snoozedUntil);
        }
        if (!Array.isArray(index.sessions)) {
          console.warn(`sessions document for ${index.workspaceId} has no rows array, read as empty`);
          continue;
        }
        for (const { turnId, notify, notifyBy, notifyRoad, reply, run, from, asked: storedAsked, turnToken, scopeDeviceId, snapshot, ...view } of index.sessions) {
          const by = readScope(notifyBy);
          const asked = readAsked(storedAsked);
          const road = readRoad(notifyRoad);
          const row: {
            view: SessionView;
            turnId: string;
            notify?: readonly string[];
            notifyBy?: ThreadScope;
            notifyRoad?: WorkspaceOrigin;
            turnLive?: TurnLive;
            run?: string;
            from?: number;
            asked?: TurnAsked;
            turnToken?: string;
            scopeDeviceId?: string;
            snapshot?: string;
            end?: (reason: string) => void;
          } = {
            view,
            turnId,
            // A state file written before a row held several targets carries the one it had as a bare string; the
            // document is read back unchecked, so the shape is settled here rather than in every reader of it.
            ...(notify !== undefined ? { notify: typeof notify === "string" ? [notify] : notify } : {}),
            // A document written before the scope rode beside the targets carries none, and its lines go as they
            // went then, as the person's; one that does not read as a scope is no scope at all.
            ...(by !== undefined ? { notifyBy: by } : {}),
            ...(road !== undefined ? { notifyRoad: road } : {}),
            ...(reply !== undefined ? { turnLive: { reply } } : {}),
            ...(run !== undefined ? { run } : {}),
            ...(typeof from === "number" && Number.isSafeInteger(from) && from >= 0 ? { from } : {}),
            ...(asked !== undefined ? { asked } : {}),
            ...(turnToken !== undefined ? { turnToken } : {}),
            ...(scopeDeviceId !== undefined ? { scopeDeviceId } : {}),
            ...(snapshot !== undefined ? { snapshot } : {}),
          };
          // A row left running because nothing answered about its run has no harness of its own to end, and the poll
          // that finds its machine gone must still be able to settle it.
          row.end = reason => {
            if (row.view.status !== "running") return;
            ctx.settleCut(row, reason, () => reason);
            void ctx.persistSessions(row.view.workspaceId);
          };
          if (view.status === "running") left.push(row);
          else if (row.snapshot !== undefined) unread.push(row);
          sessions.set(view.id, row);
        }
      }
      // A turn's run belongs to the machine it runs on, not to the host that asked for it, so a host that comes back
      // re-opens every run the machines still hold and reads the rest of its output. Only the machine's own answer
      // that a run is gone ends that turn, and a machine that answered nothing leaves its turn running. The ends are
      // told once every workspace's rows are in: the parent a settled turn tells may sit in a workspace read after
      // its own, and a re-opened turn's own end tells it later, when it ends.
      const answers = await Promise.all(left.map(async s => ({ row: s, answer: await ctx.reattach(s) })));
      for (const { row, answer } of answers) {
        if (answer === "cannot") ctx.settleCut(row, RESTARTED_REASON, endedAt => restartCutLine(endedAt - (row.view.startedAt ?? endedAt)));
        else if (answer === "gone") ctx.settleCut(row, RUN_GONE_LINE, () => RUN_GONE_LINE);
      }
      for (const workspaceId of new Set(left.map(s => s.view.workspaceId))) void ctx.persistSessions(workspaceId);
      for (const row of unread) {
        const { workspaceId, threadId, cwd, claudeSessionId, id, startedAt } = row.view;
        const entry = live.get(workspaceId)!;
        const from = row.snapshot!;
        void (async () => {
          const read =
            threadId === undefined ||
            cwd === undefined ||
            turnWritten(await ctx.openTranscript(workspaceId), row.turnId).changes ||
            (await ctx.readTurnChanges(entry, { sessionId: claudeSessionId ?? id, turnId: row.turnId, threadId, cwd, from, startedAt: startedAt ?? Date.now() }));
          delete row.snapshot;
          if (read || !ctx.state.closing) await ctx.persistSessions(workspaceId);
        })().catch((e: unknown) => console.warn(`what ${row.turnId} changed was not read: ${e instanceof Error ? e.message : String(e)}`));
      }
      // The re-attach above has settled the rows the machines no longer hold, so a sync waiting out a running turn reads rows that are in.
      for (const entry of toSync) void ctx.syncDaemon(entry);
      void Promise.all([...live.keys()].map(id => rereadHeld(id, "record load").catch((e: unknown) => console.warn(`workspace ${id} was not read again: ${e instanceof Error ? e.message : String(e)}`))));
      // Every run left over from a host that never came back to read it, now that this host knows which ones it does
      // hold: a harness whose reader is gone answers nobody and holds the machine's memory for its life.
      await Promise.all([...live.values()].map(entry => ctx.sweepRuns(entry)));
      // A turn's token dies with the turn, and a host that went down under one never reached that exit: every scoped
      // device whose thread is not running now is taken away here, so a restart is not how a token outlives its turn.
      for (const device of await deviceDoor.list()) {
        const thread = device.scope?.threadId;
        if (thread !== undefined && !ctx.threadRuns(thread)) await deviceDoor.revoke(device.id);
      }
      await deviceDoor.revokeAsides();
      for (const raw of await store.list(BUILDERS)) await admit(raw as StoredBuilder);
      // Not waited on: a fetch of a big copy's branches takes seconds, and the records it drops leave as they go.
      ctx.state.copiesMoving = ctx.moveOldCopies().catch((e: unknown) => console.warn(`the move off old copies stopped: ${e instanceof Error ? e.message : String(e)}`));
      ctx.armSweep();
      // A run that was running when the host stopped is failed and its done fires once, at start (02, "Host restart").
      void ctx.slates.ready().catch((e: unknown) => console.warn(`the slates were not loaded: ${e instanceof Error ? e.message : String(e)}`));
    })();
    return hydrated;
  };

  /** Every verb that names a workspace comes through here, so the origin rule is read once for all of them. */
  const entryOf = async (id: string, origin?: Caller): Promise<LiveWorkspace> => {
    await ready();
    const entry = live.get(id);
    // A workspace this host does not hold and one outside the caller's tree read alike to a thread: telling the two
    // apart is how a thread walks what else stands here.
    if (!entry || entry.creating) throw notFoundRefusal(scopeOf(origin) !== undefined ? noWorkspaceRefusal() : `${noWorkspaceRefusal()}: ${id}`);
    ctx.refuseRelayed(entry.record, origin);
    return entry;
  };
  /** A lead's child named by id or by name, refused for a workspace that is not that lead's child. */
  const childOf = async (lead: LiveWorkspace, ref: string, origin?: Caller): Promise<LiveWorkspace> => {
    const named = await ctx.workspaces.resolve(ref, origin);
    const kid = await entryOf(named.id, origin);
    if (kid.record.parentWorkspaceId !== lead.record.id) throw Object.assign(new Error(notTheLeadsChildRefusal(kid.record.name, lead.record.name)), { kind: "invalid" });
    return kid;
  };
  /** Which rows a caller reaches, for the verbs that name a thread rather than a workspace: the thread tree, then
   * the kind rule on the row's workspace, so a request relayed from a machine still drives only kinds that take
   * one. Neither the project rule nor the workspace tree is read here: a child on a fresh copy reaches its lead on
   * the workspace the person made, which the workspace rule alone would hide from it. */
  const reachesRow = (row: { threadId?: string; workspaceId: string }, caller: Caller | undefined): boolean => {
    if (!ctx.drivesThread(row.threadId, caller)) return false;
    const record = live.get(row.workspaceId)?.record;
    return record === undefined || ctx.drives(record, caller);
  };
  /** Every session verb that names a thread comes through here, as the verbs naming a workspace come through
   * entryOf: the entry the row stands on, or nothing when the caller is a thread the row is out of reach for, so
   * the verb answers absence and no sentence says which rule hid the row. A caller that is no thread reads the
   * workspace as every verb naming one does. */
  const entryOfRow = async (row: { threadId?: string; workspaceId: string }, origin: Caller | undefined): Promise<LiveWorkspace | undefined> => {
    if (scopeOf(origin) === undefined) return entryOf(row.workspaceId, origin);
    await ready();
    const entry = live.get(row.workspaceId);
    return entry === undefined || entry.creating || !reachesRow(row, origin) ? undefined : entry;
  };
  /** Rows as a listing answers them: each with the stamps and marks its thread's record keeps, and with what only a
   * live turn knows, which rides the answer and never the row. */
  const listedRows = (held: readonly (typeof sessions extends Map<string, infer V> ? V : never)[]): SessionView[] => {
    // A thread's subagents ride its latest row alone, the one foldThreads reads, so a thread of several rows lists
    // each child once.
    const latest = new Map(held.map(s => [threadKeyOf(s.view), s] as const));
    // The turn's process and what its calls are stopped behind ride the answer and never the row itself: both are
    // this host's to know while the turn runs, and a pid written down outlives the process it named while a wait
    // written down outlives the question it was on.
    return held.map(s => {
      const behind = s.view.status === "running" ? ctx.stoppedBehind(s) : undefined;
      const marks = threadRecords.get(threadKeyOf(s.view));
      const children = latest.get(threadKeyOf(s.view)) === s && s.view.threadId !== undefined ? transcriptIndex.get(s.view.workspaceId)?.children.get(s.view.threadId) : undefined;
      return {
        ...s.view,
        ...(s.view.status === "running" && s.pid !== undefined ? { pid: s.pid } : {}),
        ...(behind !== undefined ? { waitingOn: behind } : {}),
        ...(children !== undefined && children.size > 0 ? { subagents: [...children.values()].map(({ turnId: _turn, startRow: _row, ...child }) => child) } : {}),
        ...((): { setupRefusal?: string } => {
          const entry = live.get(s.view.workspaceId);
          const place = entry === undefined ? undefined : ctx.setupPlace(entry);
          const refused = place === undefined ? undefined : ctx.setupRefusals.get(keyOf(place, s.view.harness));
          return refused !== undefined ? { setupRefusal: refused } : {};
        })(),
        // A turn that ended before the stamps began reads as seen the moment it ended, not at the upgrade, so the quiet
        // the sidebar folds a thread by still counts from its end.
        readAt: marks?.readAt ?? (s.view.endedAt !== undefined && s.view.endedAt < ctx.state.readsSince ? s.view.endedAt : ctx.state.readsSince),
        ...(marks?.settledAt !== undefined ? { settledAt: marks.settledAt } : {}),
        ...(marks?.pinnedAt !== undefined ? { pinnedAt: marks.pinnedAt } : {}),
        ...(marks?.snoozedUntil === undefined ? {} : marks.snoozedUntil > clock.now() ? { snoozedUntil: marks.snoozedUntil } : { wokeAt: marks.snoozedUntil }),
        ...(marks?.section !== undefined ? { section: marks.section } : {}),
        ...(marks?.rewound !== undefined ? { rewoundAt: marks.rewound.at } : {}),
      };
    });
  };
  /** A thread's facts off its rows here, as a listing folds them; undefined where the host holds no row of it. */
  const threadFacts = (threadId: string): ThreadFacts | undefined => {
    const held = [...sessions.values()].filter(s => threadKeyOf(s.view) === threadId);
    const [listed] = foldThreads(listedRows(held));
    if (listed === undefined) return undefined;
    const { subagents: _subagents, ...thread } = listed;
    const latest = held.at(-1)!.view;
    const running = held.filter(s => s.view.status === "running").at(-1);
    return {
      ...thread,
      ...(latest.model !== undefined ? { model: latest.model } : {}),
      ...(latest.effort !== undefined ? { effort: latest.effort } : {}),
      ...(latest.contextWindow !== undefined ? { contextWindow: latest.contextWindow } : {}),
      ...(running !== undefined ? { turnId: running.turnId } : {}),
    };
  };
  /** Tells every window a thread's facts moved, so none asks for its head again. */
  const pushHead = (threadId: string): void => {
    const facts = threadFacts(threadId);
    if (facts !== undefined) bus.emit({ type: "thread.head", workspaceId: facts.workspaceId, threadId, facts, pos: transcriptIndex.get(facts.workspaceId)?.pos ?? 0 });
  };
  /** Moves the read or settled stamp of each thread, by fold key, on the thread's record, which a thread from before
   * records existed takes here off its latest row; each workspace touched is written once and told once. Every
   * thread is checked before any moves, so a list naming one the caller cannot reach moves nothing. */
  const mark = async (threadIds: readonly string[], stamps: Partial<Omit<ThreadRecord, "harness" | "permissionMode">>, origin: Caller | undefined): Promise<void> => {
    await ready();
    const found = await Promise.all(
      threadIds.map(async threadId => {
        const latest = [...sessions.values()].filter(s => threadKeyOf(s.view) === threadId).at(-1)?.view;
        const record = threadRecords.get(threadId);
        const workspaceId = latest?.workspaceId ?? record?.workspaceId;
        if (workspaceId === undefined || (await entryOfRow({ ...(latest?.threadId !== undefined ? { threadId: latest.threadId } : { threadId }), workspaceId }, origin)) === undefined) {
          throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
        }
        return { threadId, workspaceId, base: record ?? { workspaceId, harness: latest!.harness } };
      }),
    );
    const touched = new Map<string, string[]>();
    for (const { threadId, workspaceId, base } of found) {
      const next: ThreadRecord & { workspaceId: string } = { ...base, ...stamps };
      for (const key of Object.keys(stamps) as (keyof typeof stamps)[]) if (stamps[key] === undefined) delete next[key];
      threadRecords.set(threadId, next);
      // A thread the person settled is done with: its kept agent goes now rather than at the end of the keep.
      if (next.settledAt !== undefined) ctx.reapKept(threadId);
      if (next.snoozedUntil !== undefined) wakeAt(threadId, next.snoozedUntil);
      touched.set(workspaceId, [...(touched.get(workspaceId) ?? []), threadId]);
    }
    for (const [workspaceId, ids] of touched) {
      await ctx.persistSessions(workspaceId);
      bus.emit({ type: "thread.marked", workspaceId, threadIds: ids });
    }
  };
  /** A thread that asks for the person or fails ends the snooze standing on its tree, its own or its root's, as a
   * snooze that ran out does: the thread reads as woken now and every window hears it. A turn that finished does not,
   * or a busy tree could never stay snoozed. */
  const endSnoozeFor = (row: Pick<SessionView, "threadId" | "rootThreadId">): void => {
    const now = clock.now();
    const standing = [...new Set([row.threadId, row.rootThreadId])].filter((id): id is string => id !== undefined && (threadRecords.get(id)?.snoozedUntil ?? 0) > now);
    if (standing.length > 0) void mark(standing, { snoozedUntil: now }, undefined).catch((e: unknown) => console.warn(`snooze not ended for ${standing.join(", ")}: ${e instanceof Error ? e.message : String(e)}`));
  };
  /** Whether a thread of the caller's tree stands on that workspace, which is what lets a child list and read the
   * transcript of the workspace its lead runs on; a caller that is no thread reads workspaces by their own rule. */
  const treeStandsOn = (workspaceId: string, caller: Caller | undefined): boolean =>
    scopeOf(caller) !== undefined && [...sessions.values()].some(s => s.view.workspaceId === workspaceId && reachesRow(s.view, caller));

  /** The create itself, one stage report per awaited step. The hostname is set inside the fork, before the daemon
   * is asked and before the workspace is listed or reachable, so no shell can open under the guest's boot name. */
  /** Where a fork lands: the word the person typed, else the place a fork last landed on. This host's own provider is
   * a place with no id, which is what every fork before joined computers existed stood on. */
  /** The computers a project can live on, by the row each carries in the places table: this computer, the ones
   * joined to it and the providers. A host wired without places holds the two it has anyway, so a project can be
   * recorded before anybody joins a computer. */
  const computerRows = async (): Promise<{ id: string; name: string }[]> => {
    const rows = placeDoor === undefined ? [{ id: HERE_PLACE_ID, name: hostname() }] : (await placeDoor.list(clock.now())).map(p => ({ id: p.id, name: p.name }));
    // The provider this host forks on is a computer a project can live on whether or not the places table lists it:
    // a host wired without places holds no table at all, and one whose door has not heard of its provider yet
    // still forks there.
    return rows.some(r => r.id === places.wired) ? rows : [...rows, { id: places.wired, name: places.wired }];
  };

  /** What a sentence calls a computer: the name its row carries, the id where this host holds no row for it. */
  const nameOfComputer = (computer: string, rows: readonly { id: string; name: string }[]): string => rows.find(r => r.id === computer)?.name ?? computer;

  /** The image a workspace forks when nobody named a project image: the head of this host's own, or nothing where
   * this host has sealed none yet. */
  const imageHeadOrNone = async (): Promise<string | undefined> => goldenHead(await ctx.copyOf(await ctx.imagePlace("default"), "default"))?.snapshotId;

  /** The same, for every road that cannot go on without one. */
  const imageHead = async (): Promise<string> => {
    const head = await imageHeadOrNone();
    if (head === undefined) throw new Error(NO_IMAGE_YET);
    return head;
  };

  /** Where a workspace of a project lands, as a place: this computer and the provider this host forks on carry no
   * place id, and every other computer is the place it is. */
  const landingPlace = async (computer: string): Promise<{ placeId?: string }> => {
    const lands = workspaceLands(computer, places.wired);
    return lands.at === "place" ? ctx.placeDoorOf().placeFor(lands.place) : {};
  };
  return {
    refreshBuilders, isHeldAway, rereadHeld, hydrateWorkspace, ready, entryOf, childOf, reachesRow, entryOfRow,
    listedRows, threadFacts, pushHead, mark, endSnoozeFor, treeStandsOn, computerRows, nameOfComputer, imageHeadOrNone,
    imageHead, landingPlace,
  };
}

function createArea(ctx: RuntimeContext): CreateArea {
  const { opts, backend, placeDoor, bus, clock, live, builders, places } = ctx;
  const createStaged = async (
    o: CreateWorkspaceOptions,
    project: ProjectView,
    id: string,
    report: StageReport,
    spawned?: ThreadScope,
    landed?: () => void,
    childBase?: string,
  ): Promise<CreatedWorkspace> => {
    // Where this fork lands is the project's computer and nothing else: one workspace is one project's copy, so
    // no flag and no default place has a say in it.
    const { placeId } = await ctx.landingPlace(project.computer);
    await ctx.placeRefuses(placeId);
    const at = await ctx.landingBackend(placeId);
    // What this project's computer mounts into every workspace of it, off the road that landed the project there.
    // Where this project's computer keeps its memory, off that computer's own road, read again here because the
    // road can answer it now: a record filled at boot while that computer had said nothing about itself carries
    // whatever could be worked out then, and the folder a workspace mounts has to be the one the computer holds.
    // The record is put right the first time a workspace of it is made, so the two can never disagree again.
    const road = projectLanding(ctx.landingKind(project.computer, at));
    const landingOn = (await ctx.landingDeps(project.computer)).deps;
    // Why no workspace of this project can be made on that computer at all, before a machine is asked for or a
    // record written: a create that read the refusal later left a workspace record behind for a fork that never
    // happened.
    const refused = road.refusal(project, landingOn);
    if (refused !== undefined) throw Object.assign(new Error(refused), { kind: "invalid" });
    const said = road.places({ project, memoryKey: project.memoryKey, deps: landingOn });
    if (said.memoryDir !== project.memoryDir) await ctx.rememberProject({ ...project, memoryDir: said.memoryDir });
    const binds = road.workspaceBinds(ctx.projectHeld(project.id));
    // A project whose checkout the add left on that computer: this workspace takes its own copy of it, mounted at
    // the path the project has inside, so the seed and the install the add paid for are there and nothing is
    // cloned again. A project the computer keeps in an image carries it in the image instead. On a computer that
    // clones at the add, a project with no checkout was refused above by that road's own refusal; a project at a
    // provider has neither, and cloneProject clones it inside the fork.
    const copy = project.checkout === undefined ? undefined : { from: project.checkout, at: project.path };
    // A computer that keeps no image is forked from none: the workspace is a copy of that computer itself, so no
    // image is read, no copy of one is built there ahead of the fork, and the record names none the way a copy of
    // a folder here does.
    const fromImage = ctx.keepsImages(at);
    // What this workspace forks: the image the add built for this project where it built one, since that image
    // already holds the clone and its dependencies; else, at a place that is not the image's own, that place's
    // current copy of the image, built there first when it holds none, and everywhere else the snapshot asked for.
    const golden = fromImage ? await ctx.copyForFork(o.golden ?? project.image?.snapshotId ?? (await ctx.imageHead()), placeId, (where, rate) => report("fork-requested", copyFirstLine(where, o.name, rate))) : "";
    const inherited = fromImage ? (await ctx.imageOf(golden)).version?.size : undefined;
    const record: WorkspaceRecord = {
      id,
      name: o.name,
      kind: "cloud",
      machineId: "",
      phase: "running",
      golden,
      createdAt: new Date().toISOString(),
      project: project.id,
      spec: {
        ...(o.envs !== undefined ? { envs: o.envs } : {}),
        ...(o.labels !== undefined ? { labels: o.labels } : {}),
        ...(o.engine === true ? { engine: true } : {}),
        // What this project's own computer mounts into every workspace of it: its memory folder on a computer that
        // holds one, nothing where the project's memory rides the image. Kept on the record, so a wake mounts what
        // the create mounted.
        ...(binds.length > 0 ? { binds } : {}),
        ...(copy !== undefined ? { copy } : {}),
      },
      ...(o.idleWindowMs !== undefined ? { idleWindowMs: o.idleWindowMs } : {}),
      ...(placeId !== undefined ? { place: placeId } : {}),
      size: {
        cpu: o.cpu ?? inherited?.cpu ?? at.pricing.defaultSize.cpu,
        memMb: o.memMb ?? inherited?.memMb ?? at.pricing.defaultSize.memMb,
      },
      firstLife: true,
      // Written before the machine is asked for: the cap counts machines under a root off these two fields, so a
      // fork that is still landing already holds its place and two forks at once cannot both pass the count.
      ...ctx.treeOf(spawned),
      ...(o.parent !== undefined ? { parentWorkspaceId: o.parent } : {}),
      // The branch this copy starts from, kept because a bring back measures against it long after the parent may
      // have moved on or gone to sleep; nothing reads the parent's machine for it again.
      ...((childBase ?? project.base) !== undefined ? { base: childBase ?? project.base } : {}),
      // A fork a thread asked for stores no switch of its own: it carries the tree it belongs to, and the switch is
      // read off that tree's root wherever it is asked for, so one workspace holds the answer for the whole tree.
      ...(spawned === undefined && o.agents !== undefined ? { agents: agentsFrom(ctx.spawnAt(placeId ?? places.wired), o.agents) } : {}),
    };
    // Only an asked size is checked: the golden's own is what it was built at, whatever the provider offers today.
    if (namesSize(o) && !offeredSize(at.capabilities.sizes, record.size)) {
      throw Object.assign(new Error(refusalLine(sizeRefusal(sizeWord(record.size), at.capabilities.sizes), SIZE_PICK_FIX)), { kind: "invalid" });
    }
    const bind = (m: Machine): void => {
      record.machineId = m.id;
      ctx.attach(record, m).creating = true;
      // The record is in the live map from here, so the place the guard took for it is handed back in the same
      // step: one fork counts as one from the reservation through to the machine being ready, never as two while
      // it boots. A create that never binds hands its place back in the caller's finally instead.
      landed?.();
    };
    const notices: string[] = [];
    const asked = record.size;
    // The computer the fork lands on, by the name its own row carries: the place a person picked, else the
    // provider word this host's machines wear, which is what every other surface names a fork's home by.
    const where = placeId === undefined ? places.wired : ctx.placeDoorOf().nameOf(placeId);
    report("fork-requested", startingLine(record.name, where));
    try {
      await ctx.fork(record, bind, undefined, report, false);
    } catch (e) {
      // A slot for work beats a builder kept for one more change: at the cap one kept builder of this setup is
      // stopped and the fork tried again, the next one only on the next refusal. A held or foreign builder is
      // never touched, and a refusal with none left to stop is turned into words that name the slots' holders.
      if (!isCapRefusal(e)) throw e;
      let refusal: unknown = e;
      let made = false;
      await ctx.refreshBuilders();
      for (const x of [...builders.values()].filter(x => (x.life === "own" || x.life === "reusable") && x.record.sealed !== undefined)) {
        const stopped = `Stopped the builder kept from image v${x.record.sealed!.version} to make room at the machine cap.`;
        ctx.graceTimers.get(x.record.id)?.();
        ctx.graceTimers.delete(x.record.id);
        await killUntilGone(backend, x.builder.machine, opts.killConfirm);
        await ctx.forgetBuilder(x.record.id);
        notices.push(stopped);
        console.warn(`workspace ${record.id}: ${stopped.charAt(0).toLowerCase()}${stopped.slice(1, -1)} (${x.record.id})`);
        report("fork-requested", `${startingLine(record.name, where)} again`, { notice: stopped });
        try {
          await ctx.fork(record, bind, undefined, report, false);
          made = true;
          break;
        } catch (again) {
          if (!isCapRefusal(again)) throw again;
          refusal = again;
        }
      }
      if (!made) {
        // A create still in flight holds its slot; the one being refused never bound a machine, so it cannot name itself.
        const holding = [...live.values()].filter(w => ctx.holdsSlot(w.record)).map(w => w.record.name);
        const line = machineCapRefusal(holding, [...builders.values()].map(x => x.record.name));
        throw Object.assign(new Error(line, { cause: refusal }), { kind: "concurrency", ...(typeof (refusal as WspError).status === "number" ? { status: (refusal as WspError).status } : {}) });
      }
    }
    const entry = live.get(id)!;
    // A computer that would not fork at the size asked for says so on the handle, and the create's own answer is
    // where a person reads it: the record already holds the size that computer actually gave.
    if (entry.machine.notice !== undefined) notices.push(entry.machine.notice);
    // A workspace whose computer serves its daemon is asked nothing here: there is no route to mint and no daemon
    // inside to answer, so the create says nothing about either rather than printing a note about a port nothing
    // listens on.
    let fault: string | undefined;
    if (ctx.servedByItsComputer(entry) === undefined && (entry.machine.previewUrl !== undefined || entry.machine.daemonAnswers !== undefined)) {
      // The route and the daemon are two questions, and the create asks them apart: minting is what the app and
      // the first client will dial, and a mint that fails is its own line rather than a verdict on the guest.
      if (entry.machine.previewUrl !== undefined) {
        try {
          await until(entry.ws.daemonReach(), Date.now() + ctx.lifecycleOf(entry).budgets.daemonAnswersMs, "preview route");
          report("preview-route", "Preview route to the daemon minted.");
        } catch (e) {
          report("preview-route", "No preview route to the daemon.", { notice: `preview route for ${entry.machine.id} not minted (${e instanceof Error ? e.message : String(e)})` });
        }
      }
      // A daemon that does not answer is reported, not fatal: the workspace exists either way, and the status check
      // keeps asking and names a zombie. Asked the way the wake and the poll ask, so a machine reached without a
      // route is asked here too rather than left with no word at all.
      fault = await ctx.pingDaemon(entry);
      report("daemon-answering", fault === undefined ? "Daemon answered." : "Daemon did not answer.", { notice: fault });
      void ctx.syncDaemon(entry);
    }
    if (placeId === undefined) {
      // A guest whose daemon is silent may not serve exec yet either, and would spend the exec budget on top of the daemon's.
      if (fault !== undefined) console.warn(`workspace ${record.id}: memory not read: the daemon did not answer`);
      else if ((await ctx.readMemory(record, entry.machine, at.capabilities.sizes)) && (record.size.cpu !== asked.cpu || record.size.memMb !== asked.memMb)) {
        const line = sizeGotLine(asked, record.size, namesSize(o));
        notices.push(line);
        console.warn(`workspace ${record.id}: ${line}`);
      }
    }
    // The project goes in before the workspace is ready: a copy without the work in it is not a workspace of that
    // project, so a clone that fails ends the create and the machine goes with it.
    await ctx.moduleOf(record.kind).landProject(entry, project, report);
    await ctx.writeDaemonRoots(entry);
    await ctx.persist(record);
    // The place a fork landed on is where the next one lands when nobody says.
    await placeDoor?.markUsed(placeId);
    delete entry.creating;
    report("ready", CREATE_READY);
    const v = ctx.view(record);
    bus.emit({ type: "workspace.created", workspace: v });
    return notices.length > 0 ? { ...v, notice: notices.join(" ") } : v;
  };

  /** The name a workspace takes from what was typed: the space around it is no part of a name. The fork and the
   * rename both read it here, so a name is never stored with spaces a person would have to type back for `--in`. */
  const nameGiven = (name: string): string => name.trim();
  /** Names whose fork is between its check and its first machine: held here so two forks asked for together cannot both land. */
  const forking = new Set<string>();
  /** Creates that failed before any machine was recorded, by the id their stages carried: every client keeps a row
   * for one until it is deleted, so resolve and delete reach it here. */
  const failedCreates = new Map<string, WorkspaceView>();
  const createStages = new Map<string, WorkspaceCreatingEvent>();
  bus.on("*", e => {
    if (e.type === "workspace.creating") {
      // Held without the seq the bus stamped: sent again on a subscribe, it is no position in the stream.
      const { seq: _seq, ...stage } = e;
      createStages.set(e.workspaceId, stage);
    } else if (e.type === "workspace.created") createStages.delete(e.workspace.id);
    else if (e.type === "workspace.deleted") createStages.delete(e.workspaceId);
  });
  const failedView = (id: string, name: string, kind: WorkspaceKind, golden: string, began: number, project: ProjectView, said: string): WorkspaceView => ({
    id,
    name,
    machineId: "",
    phase: "gone",
    kind,
    golden,
    createdAt: new Date(began).toISOString(),
    project: ctx.refOf(project),
    gone: said,
  });
  /** A create asked again under a name supersedes the one that failed under it, and every client's row of it. */
  const supersedeFailed = (name: string): void => {
    for (const [failedId, failed] of failedCreates) {
      if (failed.name !== name) continue;
      failedCreates.delete(failedId);
      bus.emit({ type: "workspace.deleted", workspaceId: failedId });
    }
  };
  /** One create's stages as every client hears them. Who asked rides every stage from the first, which is emitted
   * before the create has a record: the stream's tree rule has nothing to read until then, so a thread watching its
   * own fork boot would see it start midway. */
  const stageReporter = (id: string, name: string, began: number, spawned: ThreadScope | undefined): StageReport => {
    const askedBy = spawned !== undefined ? { threadId: spawned.threadId, rootThreadId: spawned.rootThreadId } : undefined;
    return (stage, message, said) => {
      bus.emit({
        type: "workspace.creating",
        workspaceId: id,
        name,
        stage,
        message,
        elapsedMs: clock.now() - began,
        ...(said?.notice !== undefined ? { notice: said.notice } : {}),
        ...(said?.detail !== undefined ? { detail: said.detail } : {}),
        ...(said?.waiting === true ? { waiting: true as const } : {}),
        ...(askedBy !== undefined ? { askedBy } : {}),
      });
    };
  };
  /** Why a fork of this name is refused, or nothing when the name is free: one entry holds it, whatever it is doing
   * (a delete in flight says so), or a fork of it is under way. A name never names two workspaces, and a fork and a
   * delete of one name never interleave. */
  const nameRefusal = (name: string): string | undefined => {
    if (nameGiven(name) === "") return BLANK_NAME_REFUSAL;
    const entry = [...live.values()].find(e => e.record.name === name);
    if (entry !== undefined) return entry.deleting ? nameDeletingRefusal(name) : nameTakenRefusal(name);
    return forking.has(name) ? nameTakenRefusal(name) : undefined;
  };

  /** The records of one project's folders on this computer: the project folder's own and one per worktree. */
  const foldersOf = (projectId: string): LiveWorkspace[] => [...live.values()].filter(e => copiesFolder(e.record.kind) && e.record.project === projectId);
  /** The folder records being made, by project and branch, so two starts asking for the same folder at once get the
   * one record rather than two. */
  const folderMaking = new Map<string, Promise<LiveWorkspace>>();
  const oneFolder = (key: string, make: () => Promise<LiveWorkspace>): Promise<LiveWorkspace> => {
    const held = folderMaking.get(key);
    if (held !== undefined) return held;
    const making = make().finally(() => folderMaking.delete(key));
    folderMaking.set(key, making);
    return making;
  };
  return {
    createStaged, nameGiven, forking, failedCreates, createStages, failedView, supersedeFailed, stageReporter,
    nameRefusal, foldersOf, oneFolder,
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

function agentsArea(ctx: RuntimeContext): AgentsArea {
  const { opts, adapters, local, clock, live, setups, threadRecords, sessions } = ctx;
  /** One probe per harness per machine per TTL, a failed one included and one in flight shared: a binary that does
   * not answer costs one exec, not one per composer mount. Past the TTL the lists held answer while the binary is
   * asked again, so a send waits on a probe only the first time a machine is asked. */
  const catalogs = new Map<string, { at: number; catalog: Promise<HarnessCatalog> }>();
  const catalogOn = (table: HarnessCatalog, entry: LiveWorkspace, adapter: HarnessAdapter): Promise<HarnessCatalog> => {
    const machine = entry.machine;
    const known: HarnessCatalog = {
      ...table,
      steers: adapter.steers,
      renames: adapter.renameSession !== undefined,
      images: adapter.attachments !== undefined,
      ...(adapter.mcpServers === true ? { mcpServers: true } : {}),
      ...(adapter.movesAccess === true ? { movesAccess: true } : {}),
      asides: adapter.aside !== undefined,
      ...(adapter.compacts !== undefined ? { compacts: adapter.compacts } : {}),
      ...(adapter.resumesAt === true || adapter.revert !== undefined ? { rewindsConversation: true } : {}),
      ...(adapter.revert !== undefined ? { rewindsByCount: true } : {}),
      ...(adapter.screenCommands !== undefined ? { screenCommands: [...adapter.screenCommands] } : {}),
    };
    if (adapter.probeCatalog === undefined) return Promise.resolve(known);
    const key = `${machine.id}:${table.harness}`;
    const hit = catalogs.get(key);
    const now = clock.now();
    if (hit !== undefined && now - hit.at < CATALOG_TTL_MS) return hit.catalog;
    const catalog = adapter
      .probeCatalog(command => machine.exec(command, { timeoutMs: CATALOG_PROBE_TIMEOUT_MS }).then(res => res.stdout))
      // A binary that named why it described nothing keeps the table's lists and lends the footer its words.
      .then(
        answer => (answer === null ? known : catalogRefused(answer) ? { ...known, refusal: answer.refused } : catalogFromProbe(known, answer)),
        (e: unknown) => {
          // The lists a start is checked against are then wsp's own, which refuse a model the binary there takes.
          console.warn(`${table.harness} on ${machine.id}: the probe of the agent failed (${e instanceof Error ? e.message : String(e)}); wsp's built-in list answers until the next probe`);
          return known;
        },
      );
    if (hit === undefined) {
      catalogs.set(key, { at: now, catalog });
      return catalog;
    }
    const asking = { at: now, catalog: hit.catalog };
    catalogs.set(key, asking);
    void catalog.then(() => {
      if (catalogs.get(key) === asking) asking.catalog = catalog;
    });
    return hit.catalog;
  };

  /** One title read per harness session per machine per TTL, a failed one included and one in flight shared: the
   * clients reload the index on every session event and each reload must not cost an exec. `failed` holds from a
   * read that failed until one answers, so a store that fails every window is said once. */
  const titleReads = new Map<string, { at: number; done: Promise<void>; live: boolean; failed: boolean }>();
  /** Asks the harness what it calls a row's session and keeps the answer on every row that shares it, so the title
   * a client folds a thread by follows a rename made inside the harness. `force` reads past the TTL: a turn has just
   * ended, which is when the harness writes its own title. Nothing happens while the machine cannot be asked, or
   * when the harness has no title for the session: the rows keep the last one read rather than losing it to a nap.
   */
  const refreshTitle = (view: SessionView, force: boolean): Promise<void> => {
    const sessionId = view.claudeSessionId;
    const entry = live.get(view.workspaceId);
    if (sessionId === undefined || entry === undefined) return Promise.resolve();
    if (workspaceState({ phase: entry.record.phase }) !== "running" || ctx.unreachedOf(entry) !== undefined || adapters[view.harness] === undefined) return Promise.resolve();
    const key = `${entry.machine.id}:${sessionId}`;
    const hit = titleReads.get(key);
    const now = clock.now();
    if (hit !== undefined && (hit.live || (!force && now - hit.at < SESSION_TITLE_TTL_MS))) return hit.done;
    // The adapter is built after the window is checked, so a refresh inside it costs nothing at all.
    const read = adapterFor(entry, view.harness).adapter.sessionTitle;
    if (read === undefined) return Promise.resolve();
    const pending: { at: number; done: Promise<void>; live: boolean; failed: boolean } = { at: now, live: true, done: Promise.resolve(), failed: hit?.failed ?? false };
    // The read is started inside a promise and never on this stack: an adapter that refuses the id throws where it
    // builds its command (the codex guard does), and one row's store read may never cost the listing or the turn
    // that asked for it. Nothing here rejects, so both callers may leave it unawaited.
    pending.done = confineSetup(entry, view.harness)
      .then(() => read(sessionId, command => entry.machine.exec(command, { timeoutMs: SESSION_TITLE_TIMEOUT_MS }).then(res => res.stdout)))
      // The window opens when the store answered, before the answer is kept: a row that shows the title is a read
      // that is over, so a listing that sees one waits on nothing.
      .finally(() => {
        pending.at = clock.now();
        pending.live = false;
      })
      .then(
        async title => {
          pending.failed = false;
          if (title === null) return;
          const moved = new Set<string>();
          // A title in the harness's own store is the person's rename inside it or the one the harness itself made
          // for them, and both outrank anything we would generate; only the opening words, which codex writes there
          // at a thread's start, are the seed again, and a seed is no news to a row that already carries a name.
          let unnamed: SessionView | undefined;
          for (const s of sessions.values()) {
            if (s.view.workspaceId !== entry.record.id || s.view.claudeSessionId !== sessionId) continue;
            const source = storedTitleSource(title, s.view.prompt);
            if (source === "seed" && sourceOf(s.view) !== "seed") {
              if (s.view.harnessTitle !== undefined && s.view.harnessTitle !== title) unnamed = s.view;
              continue;
            }
            if (s.view.harnessTitle !== title) moved.add(threadKeyOf(s.view));
            s.view.harnessTitle = title;
            s.view.titleSource = source;
          }
          await ctx.persistSessions(entry.record.id);
          // A name given before codex wrote the thread's index row had nowhere to land; by a turn's end the row is
          // there, so the name the row carries is written again.
          if (force && unnamed?.harnessTitle !== undefined) void nameInHarness(unnamed, unnamed.harnessTitle);
          for (const threadId of moved) ctx.pushHead(threadId);
        },
        (e: unknown) => {
          if (!pending.failed) console.warn(noTitleLogLine(sessionId, entry.record.id, providerSaid(e)));
          pending.failed = true;
        },
      );
    titleReads.set(key, pending);
    return pending.done;
  };

  /** Where a row's title came from; a row written before provenance was recorded, and one with no title at all,
   * read as the words its opening turn seeded the thread with. */
  const sourceOf = (view: SessionView): TitleSource => view.titleSource ?? "seed";
  /** Every turn of one thread, whatever harness session each of them ran under. */
  const rowsOn = (threadId: string): SessionView[] => [...sessions.values()].filter(s => s.view.threadId === threadId).map(s => s.view);
  /** Where the thread's title came from, over all its turns: a person's name on any of them is the thread's, since
   * the fold reads the latest turn's title and a resume writes a row of its own. */
  const threadSource = (threadId: string): TitleSource => {
    let source: TitleSource = "seed";
    for (const view of rowsOn(threadId)) {
      if (sourceOf(view) === "person") return "person";
      if (sourceOf(view) === "auto") source = "auto";
    }
    return source;
  };
  /** The title a new turn of an existing thread carries in: the newest turn that has one. A resume writes a fresh
   * row, and the fold titles the thread by the latest, so a thread that is not seeded again here loses its name. */
  const carriedTitle = (threadId: string): Pick<SessionView, "harnessTitle" | "titleSource"> => {
    const titled = rowsOn(threadId)
      .filter(v => v.harnessTitle !== undefined)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (titled?.harnessTitle === undefined) return {};
    return { harnessTitle: titled.harnessTitle, titleSource: sourceOf(titled) };
  };

  /** Writes a thread's name into the harness's own store, so `claude --resume` and codex's own list say what the app
   * says. The name stands here whatever the store answers: a harness that keeps no name of a person's does nothing,
   * and a store that refused says so in the log once. */
  const nameInHarness = (view: SessionView, title: string): Promise<void> => {
    const sessionId = view.claudeSessionId;
    const entry = live.get(view.workspaceId);
    if (sessionId === undefined || entry === undefined) return Promise.resolve();
    if (workspaceState({ phase: entry.record.phase }) !== "running" || adapters[view.harness] === undefined) return Promise.resolve();
    const write = adapterFor(entry, view.harness).adapter.renameSession;
    if (write === undefined) return Promise.resolve();
    // Started inside a promise and never on this stack, as the store read is: an adapter that refuses the id throws
    // where it builds its command, and naming a thread may never cost the turn that asked for it.
    return confineSetup(entry, view.harness)
      .then(() => ctx.writeSession(sessionId, () => write(sessionId, title, command => entry.machine.exec(command, { timeoutMs: SESSION_TITLE_TIMEOUT_MS }).then(res => res.stdout))))
      .then(
        wrote => {
          if (wrote.kind === "failed") console.warn(noNameWriteLogLine(sessionId, entry.record.id, wrote.error));
        },
        (e: unknown) => console.warn(noNameWriteLogLine(sessionId, entry.record.id, e instanceof Error ? e.message : String(e))),
      );
  };

  /** The threads whose one title question has been asked, so a harness that answered nothing is not asked again at
   * the next turn's start. In memory only: a host that started again asks once more, which is not a loop. */
  const titlesAsked = new Set<string>();
  /** Asks the harness for a name for the thread whose first turn just started, from the opening turn alone, once per
   * thread and only while the thread still carries the words its opening turn seeded it with. A person's name, given
   * here or found in the harness's own store, is never replaced: it is read before the question goes out and again
   * when the answer lands, since a rename can happen while the harness is thinking. The answer is written back into
   * the harness's store, so its own UI shows the same name.
   */
  const makeTitle = async (view: SessionView): Promise<void> => {
    const threadId = view.threadId;
    const entry = live.get(view.workspaceId);
    if (threadId === undefined || entry === undefined || titlesAsked.has(threadId)) return;
    if (view.prompt === undefined || threadSource(threadId) !== "seed") return;
    if (workspaceState({ phase: entry.record.phase }) !== "running" || adapters[view.harness] === undefined) return;
    const { harness, adapter } = await launchAdapterFor(entry, view.harness);
    if (adapter.titleFor === undefined) return;
    titlesAsked.add(threadId);
    const table = harnessCatalog(harness);
    const model = smallestModel(table === undefined ? undefined : await catalogOn(table, entry, adapter));
    const title = await adapter.titleFor(
      { opening: view.prompt, ...(model !== undefined ? { model } : {}) },
      command => entry.machine.exec(command, { timeoutMs: TITLE_MAKE_TIMEOUT_MS }).then(res => res.stdout),
    );
    if (title === null) {
      console.warn(noMadeTitleLogLine(threadId, entry.record.id, "the harness answered with no title"));
      return;
    }
    if (threadSource(threadId) === "person") return;
    for (const row of sessions.values()) {
      if (row.view.threadId === threadId) {
        row.view.harnessTitle = title;
        row.view.titleSource = "auto";
      }
    }
    await ctx.persistSessions(entry.record.id);
    ctx.pushHead(threadId);
    await nameInHarness(view, title);
  };

  /** Which rows a refresh asks about: the newest turn of each harness session, newest first and no more than the cap. */
  const titleRows = (rows: readonly SessionView[]): SessionView[] => {
    const newest = new Map<string, SessionView>();
    for (const view of [...rows].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))) {
      if (view.claudeSessionId !== undefined && !newest.has(view.claudeSessionId)) newest.set(view.claudeSessionId, view);
    }
    return [...newest.values()].slice(0, SESSION_TITLE_REFRESH_MAX);
  };

  /** The computer a workspace's agents run on, as the person's setup is keyed: this computer for a copy here, the
   * computer a fork stands on, and none for a fork at a provider, whose image is the whole of its setup. */
  const setupPlace = (entry: LiveWorkspace): string | undefined => (isLocalWorkspace(entry.record) ? HERE_PLACE_ID : entry.record.place);
  /** Whether the person turned this agent off on the computer the workspace stands on. */
  const agentOff = (entry: LiveWorkspace, agent: string): boolean => {
    const place = setupPlace(entry);
    return place !== undefined && setups.off(place, agent);
  };
  const agentLabel = (agent: string): string => harnessCatalog(agent)?.label ?? agent;

  /** A config folder as the computer it names resolves it, links followed: this one off its own disk, a joined one
   * over its link, each with its home and the folders wsp keeps its own state in there. */
  const configFolderOn = async (placeId: string, path: string): Promise<ResolvedFolder> => {
    if (placeId === HERE_PLACE_ID) {
      const home = await realFolderHere(local?.homeDir ?? homedir());
      const kept = [await realFolderHere(join(home, ".wsp")), ...(opts.statePath !== undefined ? [await realFolderHere(dirname(resolvePathOn(opts.statePath)))] : [])];
      return { folder: await realFolderHere(path), home, kept };
    }
    const door = ctx.placeDoorOf();
    const read = await door.exec(placeId, realFolderScript(path), { timeoutMs: INLINE_EXEC_MS });
    if (read.exitCode === 3) throw Object.assign(new Error(read.stderr.trim()), { kind: "usage" });
    const [folder, home] = read.stdout.trim().split("\n");
    if (read.exitCode !== 0 || folder === undefined || home === undefined || !home.startsWith("/")) throw Object.assign(new Error(`${door.nameOf(placeId)} did not say where ${path} is: ${read.stderr.trim() || `exit ${read.exitCode}`}`), { kind: "invalid" });
    return { folder: posix.normalize(folder), home, kept: [join(home, ".wsp")] };
  };

  /** The latest word on each agent's kept config folder by computer and agent, where it was refused: what a thread
   * row of that agent there says, read off the last check rather than a new one. */
  const setupRefusals = new Map<string, string>();
  const keptFolder = (entry: LiveWorkspace, harness: string): { place: string; folder: string } | undefined => {
    const place = setupPlace(entry);
    const folder = place === undefined ? undefined : setups.get(place, harness)?.configDir;
    return place === undefined || folder === undefined ? undefined : { place, folder };
  };
  /** The one check on an agent's kept config folder, read again on the computer the workspace stands on before wsp
   * starts the agent or reads or writes under that folder: why it now leads out of that computer's home, onto it, or
   * into wsp's own, or null where it stands. Nothing falls back to the agent's own default folder. */
  const setupRefusal = async (entry: LiveWorkspace, named?: string): Promise<string | null> => {
    const harness = named ?? DEFAULT_AGENT.id;
    const kept = keptFolder(entry, harness);
    return kept === undefined ? null : keptRefusal(kept.place, harness, kept.folder);
  };
  const keptRefusal = async (place: string, harness: string, folder: string): Promise<string | null> => {
    const why = configDirRefusal(agentLabel(harness), folder, await configFolderOn(place, folder));
    const refused = why === null ? null : configDirLaunchRefusal(agentLabel(harness), harness, folder, why);
    if (refused === null) setupRefusals.delete(keyOf(place, harness));
    else setupRefusals.set(keyOf(place, harness), refused);
    return refused;
  };
  const homesHere = async (): Promise<Record<string, string>> => {
    await ctx.ready();
    const homes: Record<string, string> = {};
    for (const { id } of CATALOG_AGENTS) {
      const kept = setups.get(HERE_PLACE_ID, id)?.configDir;
      const refused = kept === undefined ? null : await keptRefusal(HERE_PLACE_ID, id, kept);
      if (refused !== null) throw Object.assign(new Error(refused), { kind: "usage" });
      homes[id] = kept ?? local?.home(id) ?? agentHomes(homedir())[id]!;
    }
    return homes;
  };
  /** Settles at once where no config folder is kept, so a road with nothing to check waits on nothing more than before. */
  const confineSetup = (entry: LiveWorkspace, named?: string): Promise<void> =>
    keptFolder(entry, named ?? DEFAULT_AGENT.id) === undefined
      ? Promise.resolve()
      : setupRefusal(entry, named).then(refused => {
          if (refused !== null) throw Object.assign(new Error(refused), { kind: "usage" });
        });
  /** adapterFor for a road that starts the agent's process or runs under its setup, its config folder checked first. */
  const launchAdapterFor = async (...a: Parameters<typeof adapterFor>): Promise<ReturnType<typeof adapterFor>> => {
    await confineSetup(a[0], a[1]);
    return adapterFor(...a);
  };

  /** The agent a new thread runs when its start names none: the project's, then the person's default, then the
   * catalog's first, each only where it runs on that workspace's computer. The marks, the start and the drafter all
   * read this one answer. */
  const defaultAgentOf = (prefs: Preferences, entry: LiveWorkspace | undefined): string => {
    const runs = (id: string): boolean => adapters[id] !== undefined && (entry === undefined || !agentOff(entry, id));
    const project = entry === undefined ? undefined : prefs.projectDefaults[entry.record.project];
    return resolveThreadDefaults({ firstAgent: CATALOG_AGENTS.find(a => runs(a.id))?.id ?? DEFAULT_AGENT.id, catalogOf: harnessCatalog, runs, prefs, ...(project !== undefined ? { project } : {}) }).agent.value;
  };

  /** One agent's lists with the person's own models in and the marks moved onto what a new thread on that project
   * starts on, so the composer shows it and startPicks fills it in, with what an open list cannot mark beside them.
   * Never cached: a start and a list share one probe. */
  const defaultsOn = (catalog: HarnessCatalog, prefs: Preferences, project: ProjectOverrides | undefined): { catalog: HarnessCatalog; open: { model?: string; effort?: string } } => {
    const lists = withCustomModels(catalog, prefs.agentDefaults[catalog.harness]?.models);
    const defaults = resolveThreadDefaults({ firstAgent: catalog.harness, named: catalog.harness, catalogOf: () => lists, prefs, ...(project !== undefined ? { project } : {}) });
    return { catalog: markedFor(lists, defaults), open: openDefaults(lists, defaults) };
  };

  /** The harness's own mode for wsp's word a start named, or the refusal naming the words it takes. */
  const namedMode = (catalog: HarnessCatalog | undefined, harness: string, word: AccessChoice): string => {
    const mode = catalog === undefined ? undefined : accessMode(catalog, word);
    if (mode !== undefined) return mode;
    throw Object.assign(new Error(accessRefusal(catalog ?? { label: agentLabel(harness), permissionModes: [] }, word)!), { kind: "usage" });
  };

  /**
   * The turn's images on the road its adapter declared, filesBlocked having already turned away what cannot go. An
   * inline adapter is handed the bytes and nothing lands anywhere, so there is no folder to answer with. A file
   * adapter is handed paths inside this send's own folder (turnImagesDir), readied and written as the thread's files
   * are: two sends on one thread would otherwise write the same paths and the first turn would be handed the
   * second's picture, since the landing happens before either turn is registered. The caller removes the folder when
   * the turn it was sent for ends.
   */
  const landImages = async (
    entry: LiveWorkspace,
    road: AttachmentRoad | undefined,
    folder: string,
    dir: string,
    images: readonly Attachment[],
  ): Promise<{ images: TurnImage[]; dir?: string }> => {
    if (images.length === 0 || road === undefined) return { images: [] };
    if (road === "inline") return { images: images.map(({ mediaType, bytes }) => ({ mediaType, bytes })) };
    const ready = await entry.machine.exec(landFilesLine(folder, dir), { timeoutMs: INLINE_EXEC_MS });
    if (ready.exitCode !== 0) throw new Error(filesNotLandedLine(folder));
    const landed = images.map((image, index) => ({ ...image, path: imagePathIn(dir, index, image.mediaType) }));
    for (const image of landed) await landBytes(entry.machine, image.path, Buffer.from(image.bytes, "base64"));
    return { images: landed.map(({ mediaType, bytes, path }) => ({ mediaType, bytes, path })), dir };
  };

  /**
   * The turn's files that are not images, landed in the folder the thread works in, where its agent reads them at
   * any access and the person's copy holds them: one command readies this send's own folder, then each file goes by
   * the machine's byte road. Answers the paths, which the agent's prompt names. They stay once the turn ends, since
   * a later turn of the thread may read them again, and go when the thread is forgotten or its workspace deleted.
   */
  const landFiles = async (entry: LiveWorkspace, folder: string, dir: string, files: readonly Attachment[]): Promise<string[]> => {
    if (files.length === 0) return [];
    const ready = await entry.machine.exec(landFilesLine(folder, dir), { timeoutMs: INLINE_EXEC_MS });
    if (ready.exitCode !== 0) throw new Error(filesNotLandedLine(folder));
    const taken = new Set<string>();
    const paths: string[] = [];
    for (const file of files) {
      const path = filePathIn(dir, file.name, taken);
      await landBytes(entry.machine, path, Buffer.from(file.bytes, "base64"));
      paths.push(path);
    }
    return paths;
  };

  /** Takes these threads' attached files off the folders their turns ran in, which are the person's own copy: nothing
   * reads them once the thread is gone. One command per folder, and a machine that is not running, or does not
   * answer, keeps them. */
  const dropThreadFiles = async (entry: LiveWorkspace, threadIds: Iterable<string>): Promise<void> => {
    if (entry.record.phase !== "running") return;
    const byFolder = new Map<string, string[]>();
    for (const threadId of threadIds) {
      for (const folder of threadRecords.get(threadId)?.filesIn ?? []) byFolder.set(folder, [...(byFolder.get(folder) ?? []), threadId]);
    }
    for (const [folder, threads] of byFolder) {
      await entry.machine.exec(dropFilesLine(folder, threads), { timeoutMs: INLINE_EXEC_MS }).catch((e: unknown) => {
        console.warn(`attached files of ${threads.join(", ")} not removed from ${folder}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  };

  /** Takes one send's images off the machine once the turn they were sent for is over, whatever it came to: the
   * harness read them at its start and nothing reads them again, so a thread that sends a screenshot and then runs
   * twenty text turns is not still holding it. A machine that is gone or asleep keeps the folder, and the thread's
   * own dir goes with the thread. */
  const dropImages = (entry: LiveWorkspace, dir: string): void => {
    void entry.machine.exec(`rm -rf ${shellQuote(dir)}`, { timeoutMs: INLINE_EXEC_MS }).catch((e: unknown) => {
      console.warn(`images for a finished turn not removed from ${entry.record.id}: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  /** The adapter for a harness on this workspace's current machine; unnamed means the runtime's default. `turnEnv` is
   * what only a turn's own launch carries, laid over the machine's login environment: every kind answers with that
   * environment through its one module, so a variable put on here reaches a launch on every kind of machine and is
   * written nowhere else. `waiting` is the turn's own reading of whether it is waiting on something outside its own
   * process, a person's answer to a prompt or a command it started in the background, which its stream's idle clock
   * reads; absent on every road that is not a turn. It is handed beside the limits and never as one; the wall the
   * factory gets is the turn limit of the place the workspace stands on, read at each launch, where the door has one. `servers` is the values the MCP servers'
   * definitions read by name, which only a turn's agent starts servers with, under the machine's own environment. */
  const adapterFor = (entry: LiveWorkspace, named?: string, turnEnv?: Readonly<Record<string, string>>, waiting?: TurnWaiting, servers: Readonly<Record<string, string>> = {}): { harness: string; adapter: HarnessAdapter } => {
    const harness = named ?? DEFAULT_AGENT.id;
    const factory = adapters[harness];
    if (!factory) throw new Error(noAdapterLine(harness, Object.keys(adapters)));
    const kind = ctx.moduleOf(entry.record.kind);
    const vault = opts.vault?.() ?? {};
    const place = setupPlace(entry);
    const setup = place === undefined ? undefined : setups.launchOf(place, harness);
    return {
      harness,
      adapter: factory({
        machine: entry.machine,
        workspaceId: entry.record.id,
        execStream: ctx.execFactoryFor(entry, ctx.turnLimitOf(entry.record), waiting),
        home: id => (place === undefined ? undefined : setups.get(place, id)?.configDir) ?? kind.home(entry, id),
        // The person's variables over the computer's own and under the turn's, which only wsp sets.
        env: { ...servers, ...kind.env(entry, harness), ...setup?.env, ...turnEnv },
        ...(setup?.launch !== undefined ? { launch: setup.launch } : {}),
        ...((): { projectKey?: string } => {
          const key = kind.memoryKey(entry, harness);
          return key !== undefined ? { projectKey: key } : {};
        })(),
        signInRefusal: signInRefusalLine({ kind: entry.record.kind }),
        vault,
        loginStands: id => kind.loginStands(entry, id),
      }),
    };
  };
  return {
    catalogOn, refreshTitle, sourceOf, rowsOn, carriedTitle, nameInHarness, makeTitle, titleRows, setupPlace, agentOff,
    agentLabel, configFolderOn, setupRefusals, setupRefusal, homesHere, confineSetup, launchAdapterFor, defaultAgentOf,
    defaultsOn, namedMode, landImages, landFiles, dropThreadFiles, dropImages, adapterFor,
  };
}

function threadsArea(ctx: RuntimeContext): ThreadsArea {
  const { opts, bus, clock, deviceDoor, live, threadRecords, sessions } = ctx;
  /** Whether any row of the thread is running, the harness holding it or not: a start writes its row before the turn
   * reaches the machine, and that row is one, so this is the test for whether the thread is spoken for. turnRuns is
   * the same test keyed by workspace. */
  const threadRuns = (threadId: string): boolean => [...sessions.values()].some(s => s.view.threadId === threadId && s.view.status === "running");
  /** The thread's row whose turn is still reaching the machine, if it has one; there is never more than one. */
  const launchingOn = (threadId: string): { turnId: string; launch: Promise<void> } | undefined => {
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && s.launch !== undefined) return { turnId: s.turnId, launch: s.launch };
    }
    return undefined;
  };

  const runningOn = (threadId: string): LiveSession | undefined => {
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && s.view.status === "running" && s.handle !== undefined) return s as LiveSession;
    }
    return undefined;
  };
  /** The latest row of a thread, by its runtime id, across every workspace: a thread is named from anywhere. */
  const latestOn = (threadId: string): SessionView | undefined => {
    let latest: SessionView | undefined;
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && (latest === undefined || (s.view.startedAt ?? 0) >= (latest.startedAt ?? 0))) latest = s.view;
    }
    return latest;
  };
  /** Each thread's agent process kept up between its turns on this computer, by thread: what its launch fixed, which a
   * next turn has to match to run on it, and the turn token and device its environment still carries, which name the
   * thread for as long as the process is kept and are taken away when it goes. A thread's running turn holds its
   * process and is not in here; its end puts the process back. */
  const keptAgents = new Map<string, KeptProcess>();

  /** Ends one thread's kept process and takes its token and device away with it. */
  const reapKept = (threadId: string, o?: { now: true }): void => {
    const kept = keptAgents.get(threadId);
    if (kept === undefined) return;
    keptAgents.delete(threadId);
    endKept(threadId, kept, o);
  };
  const endKept = (threadId: string, kept: KeptProcess, o?: { now: true }): void => {
    kept.cancel();
    if (kept.scopeDeviceId !== undefined) void deviceDoor.revoke(kept.scopeDeviceId).catch((e: unknown) => console.warn(`the token of thread ${threadWord(threadId)} was not taken away: ${e instanceof Error ? e.message : String(e)}`));
    void kept.agent.close(o).catch((e: unknown) => console.warn(`the kept agent of thread ${threadWord(threadId)} did not end: ${e instanceof Error ? e.message : String(e)}`));
  };

  /** The host's own writes into a harness session's file still going, by session. Their bytes land before the write
   * answers, so a send waits them out before it reads the file against a kept process's stamp. */
  const hostWrites = new Map<string, Promise<void>>();
  /** This host writes into a harness session's own file (a title, a rename): the processes kept on that session stamp
   * the file again once it is in, or the next send would read the host's own write as the person resuming the session
   * elsewhere. */
  const writeSession = (harnessSessionId: string, write: () => Promise<SessionRenameWrite>): Promise<SessionRenameWrite> => {
    const wrote = write().then(w => {
      if (w.kind !== "written") return w;
      for (const kept of keptAgents.values()) {
        if (kept.session !== harnessSessionId) continue;
        const file = stampSessionFile(kept.agent.sessionFile, kept.file?.path);
        if (file !== undefined) kept.file = file;
      }
      return w;
    });
    const settled: Promise<void> = Promise.all([hostWrites.get(harnessSessionId), wrote.catch(() => {})]).then(() => {
      if (hostWrites.get(harnessSessionId) === settled) hostWrites.delete(harnessSessionId);
    });
    hostWrites.set(harnessSessionId, settled);
    return wrote;
  };

  /** The process a thread's next turn runs on, taken out of the keep: only where it was launched exactly as this turn
   * would be, resumes the session this turn resumes, and nothing else wrote that session since its last turn (the
   * person resumed it in a terminal). Any other kept process of the thread is ended here, and the turn boots cold. */
  const takeKept = (threadId: string, launch: KeptLaunch | undefined, session: string | undefined): KeptProcess | undefined => {
    const kept = keptAgents.get(threadId);
    if (kept === undefined) return undefined;
    if (launch === undefined || !launchesAs(kept.launch, launch) || kept.session !== session || !sameSessionFile(kept.agent.sessionFile, kept.file)) {
      reapKept(threadId);
      return undefined;
    }
    keptAgents.delete(threadId);
    kept.cancel();
    return kept;
  };

  /** A turn's process put back in the keep once the turn is over: the thread's next send runs on it until the keep
   * runs out, the thread goes, or a seventh would be kept, which ends the one idle longest. Answers whether it was
   * kept, since the turn's token and device stay with the process only then. */
  const holdKept = (threadId: string, o: Omit<KeptProcess, "file" | "usedAt" | "cancel">): boolean => {
    if (ctx.state.closing || !threadRecords.has(threadId)) {
      void o.agent.close().catch(() => {});
      return false;
    }
    reapKept(threadId);
    const file = stampSessionFile(o.agent.sessionFile);
    const kept: KeptProcess = { ...o, ...(file !== undefined ? { file } : {}), usedAt: clock.now(), cancel: () => {} };
    const timer = clock.schedule(() => {
      if (keptAgents.get(threadId) === kept) reapKept(threadId);
    }, AGENT_KEEP_MS, { unref: true });
    kept.cancel = timer;
    keptAgents.set(threadId, kept);
    // A process that went on its own takes its token with it; nothing is left to close.
    void o.agent.exited.then(() => {
      if (keptAgents.get(threadId) !== kept) return;
      keptAgents.delete(threadId);
      kept.cancel();
      if (kept.scopeDeviceId !== undefined) void deviceDoor.revoke(kept.scopeDeviceId).catch(() => {});
    });
    while (keptAgents.size > AGENTS_KEPT) {
      const [oldest] = [...keptAgents].reduce((a, b) => (b[1].usedAt < a[1].usedAt ? b : a));
      reapKept(oldest);
    }
    return true;
  };

  /** The thread a request came out of, by the token that request's own launch environment carries: the row holding
   * that token beside its session id. Every token this host knows it minted into one turn's launch, so one no row
   * carries names a turn the caller is not, and it is refused rather than read as the person, which would send a
   * builder's report where nobody is waiting for it. */
  const threadOfToken = (token: string): string => {
    // Only a row still running answers: a turn the runtime ended from this side (a nap, a stop, a restart it could
    // not re-open) never reaches the exit that drops its token, and a token whose turn is over names nobody.
    for (const s of sessions.values()) if (s.turnToken === token && s.view.status === "running" && s.view.threadId !== undefined) return s.view.threadId;
    // A process kept between turns still holds the token its first turn was launched with.
    for (const [threadId, kept] of keptAgents) if (kept.turnToken === token) return threadId;
    throw new Error(NO_SUCH_TURN);
  };
  /** Every thread the tree under this one holds, whether or not anything on it is running: read off the parent each
   * row carries, level by level, so a thread that spawned a thread that spawned a thread is all of it. */
  const treeUnder = (threadId: string): string[] => {
    const found: string[] = [];
    let front = [threadId];
    for (let steps = sessions.size + 1; steps > 0 && front.length > 0; steps--) {
      const next = [...new Set([...sessions.values()].map(x => x.view).filter(v => v.threadId !== undefined && v.parentThreadId !== undefined && front.includes(v.parentThreadId)).map(v => v.threadId!))].filter(id => !found.includes(id) && id !== threadId);
      found.push(...next);
      front = next;
    }
    return found;
  };
  /** Which threads a thread's own token reaches: every thread of its own tree, the lead that started it, the ones
   * beside it under that lead and the ones under itself, on whatever workspace each runs, read off the root every
   * row carries. Two trees on one workspace neither read nor drive each other, the person's own thread beside a
   * lead included, and anything crossing between them goes through the person. A caller that is no thread reaches
   * every thread this host holds; a row with no thread of its own is in nobody's tree and is hidden from every
   * thread. This sits beside the workspace rule rather than inside it: the tree, not the workspace, is what a
   * thread's token reaches for threads. */
  const drivesThread = (threadId: string | undefined, caller: Caller | undefined): boolean => {
    const scope = scopeOf(caller);
    if (scope === undefined) return true;
    return threadId !== undefined && ctx.rootOf(threadId) === scope.rootThreadId;
  };
  /** What a thread is called, by the one rule every listing reads it by: its own rows folded, so a thread named in
   * another thread's row reads there exactly as it reads in the sidebar. */
  const threadTitle = (threadId: string): string => {
    const rows = [...sessions.values()].map(x => x.view).filter(v => v.threadId === threadId).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return foldThreads(rows)[0]?.title ?? threadWord(threadId);
  };

  /** The prompt each thread is stopped on, whole, by thread id. The row carries the lead as a line; a thread whose
   * own call is waiting behind this one has to draw the question and answer it, so the question itself is kept here
   * for as long as it stands open. */
  const leadAsks = new Map<string, PermissionAsk>();

  /** The thread one running turn's calls are stopped behind, when one of them is a wsp call that follows another
   * thread to the end of its turn and that thread has an open prompt. A call that opened its own thread is behind
   * the whole tree under the caller, so a chain of agents waiting on each other names the one question at the
   * bottom of it: answering that is what moves any of them. */
  const stoppedBehind = (s: { view: SessionView; calls?: Map<string, { toolName: string; input: string }> }): ThreadWaitingOn | undefined => {
    const caller = s.view.threadId;
    if (caller === undefined || s.calls === undefined) return undefined;
    for (const call of s.calls.values()) {
      const follows = threadsFollowed(call);
      if (follows === undefined) continue;
      const behind: string[] = "opened" in follows ? treeUnder(caller) : [...sessions.values()].map(x => x.view.threadId).filter((id): id is string => id !== undefined && follows.named.some(ref => id.startsWith(ref)));
      for (const threadId of behind) {
        const prompt = leadAsks.get(threadId);
        if (prompt === undefined || threadId === caller) continue;
        const asked = [...sessions.values()].find(x => x.view.threadId === threadId && x.view.status === "running");
        if (asked === undefined) continue;
        return { threadId, workspaceId: asked.view.workspaceId, sessionId: asked.view.id, title: threadTitle(threadId), prompt: { ...prompt, options: [...prompt.options] } };
      }
    }
    return undefined;
  };

  /** Stops every running turn on the tree under a thread, deepest first, and answers with the threads it stopped. */
  const stopUnder = async (threadId: string, caller: Caller | undefined): Promise<string[]> => {
    const stopped: string[] = [];
    for (const child of treeUnder(threadId).reverse()) {
      const row = latestOn(child);
      if (row === undefined || row.status !== "running") continue;
      const outcome = await ctx.sessionsApi.interrupt(row.id, caller).catch((e: unknown) => {
        console.warn(`thread ${threadWord(child)} was not stopped with its root: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      });
      if (outcome?.outcome === "accepted") stopped.push(child);
    }
    return stopped;
  };
  /** What the thread's start registered, kept by every turn on it: the targets, the thread that named them and the
   * road it named them from. */
  const notifyOn = (threadId: string): { notify: readonly string[]; by?: ThreadScope; road?: WorkspaceOrigin } | undefined => {
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && s.notify !== undefined) {
        return { notify: s.notify, ...(s.notifyBy !== undefined ? { by: s.notifyBy } : {}), ...(s.notifyRoad !== undefined ? { road: s.notifyRoad } : {}) };
      }
    }
    return undefined;
  };
  /** Whether a row can be told anything at all: it has a session to resume. A thread whose workspace went while its
   * builder worked has none, and the report must not go with it. The one predicate both roads read, the check before
   * a line is addressed and the send that carries it. */
  const tellable = (row: SessionView | undefined): row is SessionView => row?.claudeSessionId !== undefined;
  /** Every thread these targets lead to through the notify registrations: a thread's end tells its targets, and each
   * of those ends tells its own. Walked as a set, since two targets may lead to one thread and a chain that already
   * loops would otherwise be walked forever. */
  const notifyReach = (from: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = from.filter(target => target !== NOTIFY_ME);
    for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
      if (seen.has(at)) continue;
      seen.add(at);
      queue.push(...(notifyOn(at)?.notify ?? []).filter(target => target !== NOTIFY_ME));
    }
    return seen;
  };
  /** Lines for a parent whose workspace could not take a start when the child ended (napping, or the nap that ended
   * the child), sent when that workspace wakes; in memory only, so a host restart during the nap drops them. */
  const heldLines = new Map<string, { from: string; notify: string; text: string; by?: ThreadScope; road?: WorkspaceOrigin; fell?: () => void }[]>();
  /** Who the lines off a row are delivered as: the thread that registered its targets and the road it registered
   * them from, read off the row that holds both so the two never drift apart. */
  const tellAs = (s: { notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin }): { by?: ThreadScope; road?: WorkspaceOrigin } => ({
    ...(s.notifyBy !== undefined ? { by: s.notifyBy } : {}),
    ...(s.notifyRoad !== undefined ? { road: s.notifyRoad } : {}),
  });
  /** The line into the parent thread as a send would go: steered into its running turn, or queued behind it, which
   * is what a parent still in its own reply tail gets, since the send road waits for that process rather than
   * refusing. It goes under the thread that named the target, so the switch on that thread's workspace and the
   * tree rule are read at delivery and not at registration alone; a line a person registered goes as the person's,
   * which is what every row written before the scope rode beside the targets carries. A parent with no session to
   * resume, and a start that door refuses, drop the line with a warning and call the line's own `fell`, which tells
   * the person the report is there; the child's end must not fail on either. */
  const deliver = (line: { from: string; notify: string; text: string; by?: ThreadScope; road?: WorkspaceOrigin; fell?: () => void }): void => {
    const { from, notify, text, by, road, fell = () => {} } = line;
    const parent = latestOn(notify);
    if (!tellable(parent)) {
      console.warn(`thread ${from.slice(0, 8)} ended, but thread ${notify.slice(0, 8)} has no session to tell`);
      fell();
      return;
    }
    const phase = live.get(parent.workspaceId)?.record.phase;
    if (phase !== undefined && sendRefusal(workspaceState({ phase })) !== null) {
      // The line keeps the road that tells the person: a wake is minutes or hours later, and one the door refuses
      // then falls away exactly as one refused now does, once for the turn that ended.
      heldLines.set(parent.workspaceId, [...(heldLines.get(parent.workspaceId) ?? []), line]);
      return;
    }
    // The road the targets were named from is read again here, where the line starts a turn: a device the person
    // paired may not start one, by the same list both doors read, so a row an older host wrote under that road
    // falls away to the person rather than starting a turn a paired socket could not.
    if (road === "paired" && !DEVICE_OPS.includes("sessions.start")) {
      console.warn(`thread ${from.slice(0, 8)} ended, but its line was registered from a paired computer, which starts no turn on thread ${notify.slice(0, 8)}`);
      fell();
      return;
    }
    // The caller this start runs under: the thread that registered the targets where one did, and the road it
    // registered them from. A line nobody but the person registered carries neither and goes as theirs, which is
    // what every row written before the road rode beside the targets holds.
    const asWho: Caller | undefined = by === undefined ? road : { origin: road ?? "here", by };
    ctx.sessionsApi.start(parent.workspaceId, { prompt: text, harness: parent.harness, thread: notify, startedBy: "agent" }, asWho).catch((e: unknown) => {
      console.warn(`thread ${from.slice(0, 8)} ended, but its line did not reach thread ${notify.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
      fell();
    });
  };
  // A wake or a rebuild (of a gone or zombie machine) puts the workspace back to running: the held lines go now.
  for (const type of ["workspace.woken", "workspace.upgraded"] as const) {
    bus.on(type, e => {
      if (e.type !== type) return;
      const lines = heldLines.get(e.workspaceId) ?? [];
      heldLines.delete(e.workspaceId);
      for (const l of lines) deliver(l);
    });
  }
  /** The one line an ending turn sends where its thread's start said: into a thread, or nowhere further for me, whom
   * the recorded event reaches. Recorded before the turn's session.done, since a follower ends there; the person's
   * own row for a line the target's door refused is the exception, since that answer comes after the start it made. */
  const notifyEnd = (s: { view: SessionView; turnId: string }, notify: readonly string[], named: { by?: ThreadScope; road?: WorkspaceOrigin }, result: TurnResult): void => {
    const threadId = s.view.threadId;
    if (threadId === undefined) return;
    // A target whose thread has gone by now cannot be told, and its report must not go with it: the person is told
    // instead, once, however many targets fell away.
    const reachable = notify.filter(target => target === NOTIFY_ME || tellable(latestOn(target)));
    const targets = reachable.length === notify.length ? notify : [...new Set([...reachable, NOTIFY_ME])];
    let toldThePerson = targets.includes(NOTIFY_ME);
    // The same road for a line the target's own door refused, which the start answers only after this loop is over:
    // a workspace whose switch went off after the registration, or a thread that left the tree that named it.
    const fell = (): void => {
      if (toldThePerson) return;
      toldThePerson = true;
      ctx.record({ type: "session.notify", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId, notify: NOTIFY_ME, text: notifyLine(threadId, result, "tail") });
    };
    for (const target of targets) {
      // A thread reads its child's line as a message and acts on it, so it gets the report whole; the person reads
      // it as a row beside every other, so theirs stays one line.
      const text = notifyLine(threadId, result, target === NOTIFY_ME ? "tail" : "whole");
      ctx.record({ type: "session.notify", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId, notify: target, text });
      if (target !== NOTIFY_ME) deliver({ from: threadId, notify: target, text, ...named, fell });
    }
  };
  /** Settles a running row whose process the runtime ended or lost before the harness's own session.end: to the reply
   * it held, whose line already went, or failed with `cutLine` as the parent's word when it never replied. The
   * session.end carries `reason` either way. The one rule for both roads, the runtime's end() and the restart load. */
  const settleCut = (s: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; snapshot?: string }, reason: string, cutLine: (endedAt: number) => string): void => {
    const reply = s.turnLive?.reply;
    delete s.snapshot;
    const endedAt = Date.now();
    s.view.status = reply ?? "failed";
    ctx.portRootsMoved(s.view.workspaceId);
    s.view.endedAt = endedAt;
    if (s.view.status === "failed") ctx.endSnoozeFor(s.view);
    // A prompt the turn was stopped on goes with it, on this road as on the harness's own exit: nothing can answer
    // one whose process is gone, and a settled row still carrying it would read as waiting on a person forever.
    delete s.view.asking;
    if (s.view.threadId !== undefined) leadAsks.delete(s.view.threadId);
    if (reply === undefined && s.notify !== undefined) notifyEnd(s, s.notify, tellAs(s), { status: "failed", error: cutLine(endedAt) });
    ctx.record({ type: "session.end", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId: s.view.threadId, exitCode: null, sawResult: reply !== undefined, reason });
  };
  /** A folder on this computer git holds no repo in: it keeps no checkpoint and no rewind moves its files. */
  const notARepo = (r: WorkspaceRecord): boolean => copiesFolder(r.kind) && ctx.projectHeld(r.project).git === undefined;
  /** What a rewind to a turn needs, kept once the turn is over: the checkout's tree through the workspace's own
   * daemon, and the harness's anchor. A checkout the daemon takes none of (not a repo, a daemon too old, a machine
   * gone) leaves the anchor alone; the turn itself is as it ended either way. */
  /** The checkpoint a thread's last turn is still writing, which a drop of its refs waits for. */
  const checkpointsLanding = new Map<string, Promise<void>>();
  const keepCheckpoint = async (entry: LiveWorkspace, turn: { sessionId: string; threadId: string; turnId: string; anchor?: string; kept?: string }): Promise<void> => {
    let ref: string | undefined;
    if (!notARepo(entry.record)) {
      try {
        // Scoped by the record's id, so the refs of two folders of one repo never share a prefix.
        const taken = await ctx.withDaemon(entry, ask => ask({ op: "git.checkpoint", cwd: ctx.checkoutOf(entry.record), thread: turn.threadId, turn: turn.turnId, scope: entry.record.id }));
        if (typeof taken["ref"] === "string") ref = taken["ref"];
      } catch (e) {
        console.warn(noCheckpointLogLine(turn.threadId, entry.record.id, e instanceof Error ? e.message : String(e)));
      }
    }
    if (ref === undefined && turn.anchor === undefined && turn.kept === undefined) return;
    ctx.record({ type: "session.checkpoint", workspaceId: entry.record.id, sessionId: turn.sessionId, turnId: turn.turnId, threadId: turn.threadId, ...(ref !== undefined ? { ref } : {}), ...(turn.anchor !== undefined ? { anchor: turn.anchor } : {}), ...(turn.kept !== undefined ? { kept: turn.kept } : {}) });
  };
  /** Recorded once the harness took the line, so the row sits where the turn could first see it. */
  /** The handle a start already taken answers with: the turn's own while it runs, and while it does not, one whose
   * finish is the end the transcript holds. Nothing where the session index no longer holds the session. */
  const takenTurn = async (workspaceId: string, taken: Taken): Promise<SessionHandle | undefined> => {
    const held = sessions.get(taken.sessionId);
    if (held === undefined) return undefined;
    if (held.handle !== undefined && held.turnId === taken.turnId) return { ...held.handle, outcome: taken.outcome };
    const events = await ctx.openTranscript(workspaceId);
    const done = events.find(e => e.type === "session.done" && e.turnId === taken.turnId);
    const end = events.find(e => e.type === "session.end" && e.turnId === taken.turnId);
    const result: TurnResult = done?.type === "session.done" ? done.result : { status: "failed", error: end?.type === "session.end" && end.reason !== undefined ? end.reason : RESTARTED_REASON };
    return { id: taken.sessionId, workspaceId, turnId: taken.turnId, outcome: taken.outcome, finished: Promise.resolve(result), view: () => sessions.get(taken.sessionId)?.view ?? held.view, interrupt: async () => {} };
  };

  const recordSteer = (s: { view: SessionView; turnId: string }, handleId: string, o: { prompt: string; requestId?: string; via?: "slate" }): void => {
    ctx.record({
      type: "session.steer",
      workspaceId: s.view.workspaceId,
      sessionId: s.view.claudeSessionId ?? handleId,
      turnId: s.turnId,
      ...(s.view.threadId !== undefined ? { threadId: s.view.threadId } : {}),
      prompt: o.prompt,
      ...(o.requestId !== undefined ? { requestId: o.requestId } : {}),
      ...(o.via !== undefined ? { via: o.via } : {}),
      // Read off the row the turn writes its open prompt on: a message that joined a turn stopped on one waits for
      // the person as the turn does, and the caller says so rather than going quiet until the prompt is answered.
      ...(s.view.asking !== undefined ? { waiting: true } : {}),
    });
  };

  /** How long a launch waits on its folder's snapshot before the turn runs without one. */
  const snapshotMs = opts.turnSnapshotMs ?? 3_000;

  /** The folder a turn works in as one commit, through the daemon's own snapshot, which leaves the checkout's index
   * and refs as they were. Nothing where the workspace is the person's own folder, the machine has no daemon to ask,
   * the folder is no checkout, or the daemon does not answer inside the deadline: the turn runs regardless and its
   * reply lists no changes. */
  const snapshotOf = async (entry: LiveWorkspace, cwd: string): Promise<string | undefined> => {
    if (notARepo(entry.record) || ctx.reachOf(entry) !== "reachable") return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">(resolve => (timer = setTimeout(() => resolve("late"), snapshotMs)));
    const taken = ctx.withDaemon(entry, async ask => String((await ask({ op: "git.snapshot", cwd }))["commit"])).catch((e: unknown) => {
      if (!(e instanceof DaemonRefusal && e.code === "not-a-git-repo")) console.warn(`no snapshot of ${cwd} on ${entry.record.name}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    try {
      const commit = await Promise.race([taken, late]);
      if (commit === "late") console.warn(`no snapshot of ${cwd} on ${entry.record.name} inside ${snapshotMs}ms; the turn runs without one and its reply lists no changes`);
      return commit === "late" ? undefined : commit;
    } finally {
      clearTimeout(timer);
    }
  };

  /** Whether another thread's turn in this workspace ran in the same folder at any point between the two times. */
  const sharedFolder = (workspaceId: string, threadId: string, cwd: string, from: number, to: number): boolean =>
    [...sessions.values()].some(({ view }) => view.workspaceId === workspaceId && view.threadId !== threadId && view.cwd === cwd && (view.startedAt ?? 0) <= to && (view.endedAt ?? to) >= from);

  /** What a turn changed in its folder: a snapshot now, the range from the commit its launch took, and the files in it
   * recorded under the turn. True once the range is read, whether or not it held anything; a turn that changed nothing
   * records nothing. */
  const readTurnChanges = async (entry: LiveWorkspace, turn: { sessionId: string; turnId: string; threadId: string; cwd: string; from: string; startedAt: number }): Promise<boolean> => {
    const { sessionId, turnId, threadId, cwd, from, startedAt } = turn;
    const workspaceId = entry.record.id;
    const to = await snapshotOf(entry, cwd);
    if (to === undefined) return false;
    const range = await ctx.withDaemon(entry, ask => ask({ op: "git.turn", cwd, from, to })).catch((e: unknown) => {
      console.warn(`what ${turnId} changed in ${cwd} was not read: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    const read = GitDiffReply.safeParse(range);
    if (!read.success) return false;
    const files = read.data.files.map(({ path, kind, additions, deletions }) => ({ path, kind, additions, deletions }));
    const moved = read.data.moved;
    // A turn that only moved HEAD (a checkout or pull with no edit of its own) still records its line.
    if (files.length === 0 && moved.length === 0) return true;
    const shared = sharedFolder(workspaceId, threadId, cwd, startedAt, Date.now());
    ctx.record({ type: "session.changes", workspaceId, sessionId, turnId, threadId, from, to, files, moved, ...(shared ? { shared: true as const } : {}) });
    return true;
  };

  /** What a turn is once its harness session exists: the one road from the harness's events to the transcript, the
   * index, the bus and the row, whether the session was launched here or re-opened on the machine after a restart.
   * A re-opened turn's run is read from its first byte, so what the transcript already holds for this turn is
   * counted first and read past in silence: a delta is recorded once however many hosts read the run it came from. */
  /** The computer a workspace runs on as the usage records key it: its place, this computer, or the provider it forks at. */
  const usageComputerOf = (r: WorkspaceRecord): string => r.place ?? (isLocalWorkspace(r) ? HERE_PLACE_ID : (r.provider ?? r.kind));

  /** What the vault holds for an agent's sign-in, where the machine's own login does not stand in front of it. */
  const vaultedFor = (agent: string, loginStands?: boolean): Vaulted => {
    const secrets = CATALOG_AGENTS.some(a => a.id === agent) ? secretsOf(opts.vault?.() ?? {}, agent as ThreadAgent, loginStands) : {};
    return secrets.oauthToken !== undefined ? "token" : secrets.apiKey !== undefined ? "key" : undefined;
  };

  /** The sign-in a machine runs a harness with, as the usage records key and name it. */
  const usageAccountOf = (entry: LiveWorkspace, harness: string, named?: { id: string; label?: string }) =>
    accountOf({
      agent: harness,
      agentName: harnessCatalog(harness)?.label ?? harness,
      ...(named !== undefined ? { named } : {}),
      vaulted: vaultedFor(harness, ctx.moduleOf(entry.record.kind).loginStands(entry, harness)),
      computer: { id: usageComputerOf(entry.record), name: ctx.computerOf(entry) },
    });

  /** Whether a turn of this agent on this workspace reads its account's banked resets in full: an agent whose plan
   * banks none never does, and a ledger that cannot be read leaves the turn on the count alone. */
  const limitDetailsDue = async (entry: LiveWorkspace, harness: string): Promise<boolean> => {
    if (PLAN_RESETS[harness as ThreadAgent] === undefined) return false;
    try {
      const limits = await ctx.ledger.limits();
      const vaulted = vaultedFor(harness, ctx.moduleOf(entry.record.kind).loginStands(entry, harness));
      const { key } = accountOnComputer({ agent: harness, agentName: harnessCatalog(harness)?.label ?? harness, computer: { id: usageComputerOf(entry.record), name: ctx.computerOf(entry) }, limits, vaulted });
      return resetDetailsDue(limits.find(l => l.key === key), clock.now());
    } catch {
      return false;
    }
  };
  return {
    threadRuns, launchingOn, runningOn, latestOn, keptAgents, reapKept, endKept, hostWrites, writeSession, takeKept,
    holdKept, threadOfToken, treeUnder, drivesThread, leadAsks, stoppedBehind, stopUnder, notifyOn, notifyReach, tellAs,
    notifyEnd, settleCut, notARepo, checkpointsLanding, keepCheckpoint, takenTurn, recordSteer, snapshotOf,
    readTurnChanges, usageComputerOf, vaultedFor, usageAccountOf, limitDetailsDue,
  };
}

function turnsArea(ctx: RuntimeContext): TurnsArea {
  const { bus, clock, deviceDoor, live, threadRecords, sessions } = ctx;
  const runTurn = (t: {
    entry: LiveWorkspace;
    view: SessionView;
    /** How much of itself a turn re-opened after a restart has written. A new turn has written nothing. */
    written?: TurnWritten;
    /** The thread this turn runs on, which every row the runtime writes carries. */
    threadId: string;
    turnId: string;
    notify?: readonly string[];
    /** The thread that named those targets, where a thread named them: the line their end delivers starts the
     * target's turn under it, so the rules that let it name them are read again when the line goes. */
    notifyBy?: ThreadScope;
    /** And the road they were named from, read at delivery beside the thread, so a caller that may start no
     * process on the target's workspace gets none started for it a turn later. */
    notifyRoad?: WorkspaceOrigin;
    /** The token this turn was launched with, kept on its row while the turn runs so a request out of it can name
     * this thread. */
    turnToken?: string;
    /** The device this turn's launch environment carries into the machine, taken away at the exit beside the turn
     * token: the two are one turn's identity and they end together. */
    scopeDeviceId?: string;
    outcome: SessionStartOutcome;
    /** What this turn's own session.start row carries, for the road that still has to write it. */
    opening: { prompt: string; requestId?: string; via?: "slate"; afterCut?: boolean; opensThread?: boolean; title?: string; attachments?: readonly AttachmentRecord[] };
    /** The message the agent is handed and the effort it runs at, kept beside the run while the turn runs. */
    asked?: TurnAsked;
    /** The harness session this turn resumes, so the row it takes over keeps who opened the thread and with what. */
    resume?: string;
    /** The rewind's anchor this turn was launched to cut at; the thread lets it go once the turn announces itself. */
    cutAt?: string;
    /** What the row already knows of this turn's reply: a re-opened turn whose result landed before the restart is
     * still working, and reads as such until the run's own result line comes round again. */
    turnLive?: TurnLive;
    /** The folder this turn's images landed in on the machine, removed when the turn ends however it ends; absent on
     * a turn that landed none, whose harness read them inline or which carried none at all. */
    imagesDir?: string;
    /** The snapshot of the turn's folder taken as it launched, which the range of what it changed starts from: the
     * commit itself where it is known as the turn is handed over, a launch's already in or a re-opened turn's off
     * its row. */
    snapshot?: { from: Promise<string | undefined> | string; cwd: string };
    /** The box the turn's own exec stream reads to know it is waiting on something outside its own process: flipped
     * while a permission prompt of this turn stands open, and while its harness reports a command or a subagent it
     * started still running, so the turn's idle clock does not run out under a question nobody has answered yet nor
     * under a quiet watch on work the turn started. Absent on a road that hands the adapter no stream of its own. */
    waiting?: { on: boolean };
    /** What the turn's process was launched with, where it may be kept for the thread's next turn once this one is over. */
    keep?: { launch: KeptLaunch };
    open: (onEvent: (event: AdapterEvent) => void) => HarnessSession;
  }): SessionHandle => {
    const { entry, view, threadId, turnId, opening, outcome, notify, notifyBy, notifyRoad, turnToken, scopeDeviceId } = t;
    const workspaceId = entry.record.id;
    const { lines: deltasWritten, subagents: subagentsWritten, reply: recordedReply, started: startWritten, changes: changesWritten } = t.written ?? { lines: 0, subagents: 0, started: false, changes: false };
    /** What the turn changed, read once at the first of its reply and its exit. */
    let changesRead = changesWritten;
    /** While the read is out the turn's ending keeps the launch's commit on its row, so a host that goes before the
     * card is in leaves the read to the next host. Once that ending is on disk (endWritten), a read that lands after
     * it writes the row again to take the commit off. */
    let changesOut = false;
    let endWritten = false;
    const readChanges = (sessionId: string): void => {
      if (changesRead || t.snapshot === undefined) return;
      changesRead = true;
      changesOut = true;
      const { from: taken, cwd } = t.snapshot;
      const startedAt = view.startedAt ?? Date.now();
      void (async () => {
        const from = await taken;
        return from !== undefined && (await ctx.readTurnChanges(entry, { sessionId, turnId, threadId, cwd, from, startedAt }));
      })().then(read => {
        changesOut = false;
        const row = sessions.get(rowId);
        if (!endWritten || row?.turnId !== turnId || row.snapshot === undefined) return;
        delete row.snapshot;
        // A closing host's read fails as its daemon channel shuts, and leaves the commit on disk for the next host.
        if (read || !ctx.state.closing) void ctx.persistSessions(workspaceId);
      });
    };
    // The reply and its line to the parent go together, so one gate stands for both.
    let replyRecorded = recordedReply !== undefined;
    /** The account the harness named for this turn's sign-in, off its limit reading, which the ledger files it under. */
    let turnAccount: { id: string; label?: string } | undefined;
    let startRecorded = startWritten;
    let deltas = deltasWritten;
    let replaying = deltasWritten;
    let subagentRows = subagentsWritten;
    let replayingSubagents = subagentsWritten;
    let ended = false;
    /** The harness's own name for where this turn ended, kept with the turn's checkpoint once it is over. */
    let anchor: string | undefined;
    /** The harness's word that it cannot cut this thread's conversation, kept with the checkpoint as the anchor is. */
    let keptWhy: string | undefined;
    let over = false;
    /** The turn is over however it ended: no rewind in this copy can be undone any more, since an undo would take
     * this turn's files with it, and what a rewind to this turn needs is kept, off the turn's road so nothing waits
     * on the machine. */
    const turnOver = (): void => {
      if (over) return;
      over = true;
      const undone: string[] = [];
      for (const [id, held] of threadRecords) {
        if (held.workspaceId !== workspaceId || held.rewound === undefined) continue;
        delete held.rewound;
        undone.push(id);
      }
      if (undone.length > 0) {
        void ctx.persistSessions(workspaceId);
        bus.emit({ type: "thread.marked", workspaceId, threadIds: undone });
      }
      // The slate's snapshot is keyed by the turn and never waits on the machine, so every turn that ends has one.
      void ctx.slates.turnEnded({ threadId, turnId }).catch((e: unknown) => console.warn(`the slate of thread ${threadWord(threadId)} was not kept at the end of turn ${turnId}: ${e instanceof Error ? e.message : String(e)}`));
      const kept = ctx.keepCheckpoint(entry, { sessionId: view.claudeSessionId ?? view.id, threadId, turnId, ...(anchor !== undefined ? { anchor } : {}), ...(keptWhy !== undefined ? { kept: keptWhy } : {}) });
      ctx.checkpointsLanding.set(threadId, kept);
      void kept.finally(() => {
        if (ctx.checkpointsLanding.get(threadId) === kept) ctx.checkpointsLanding.delete(threadId);
      });
    };
    // The reply's status, held while the process still runs. Shared with this turn's session-map entry so runningOn
    // and the persisted row read it whether the harness emits its result synchronously in start() (before the entry
    // exists) or later from its stream.
    const turnLive: TurnLive = t.turnLive ?? {};
    /** The permission prompts of this turn nobody has answered. The harness is blocked on every one of them, so this
     * map is what the thread is waiting on, and it holds for as long as the turn lives. */
    const open = new Map<string, PermissionAsk>();
    /** Whether the harness reports work this turn started still running in the background. Beside the open prompts
     * because the two say the same thing about the turn: it is waiting on something its own process is not doing. */
    let tasksRunning = false;
    /** The tool calls of this turn the harness has not answered yet: what the agent is inside right now. A wsp call
     * among them that follows another thread is what can leave this turn stopped on a question it never asked. */
    const calls = new Map<string, { toolName: string; input: string }>();
    /** The harness's own answer road, once the turn is open; a prompt raised inside start() is answered through it
     * too, since it may stand for hours past the synchronous run that raised it. */
    let answerAsk: HarnessSession["answer"];

    /** The spans of this turn that went on a person rather than on work: closed ones added up, and the moment the
     * span still running began. The harness counts wall time from launch to result, so these are what its figure has
     * to give back before a reader is told how long the turn worked. */
    let waited = 0;
    let waitingSince: number | undefined;
    /** What the turn has spent on the person by now, the open span included, so a result that lands under a prompt
     * still standing counts the same as one that lands after it closed. */
    const waitedSoFar = (): number => waited + (waitingSince === undefined ? 0 : clock.now() - waitingSince);

    /** The one expression that says the turn is waiting on something outside its own process, which its stream's
     * idle clock touches on every poll: a prompt of its own nobody has answered, or work it started that the harness
     * says is still running. */
    const readsWaiting = (): void => {
      if (t.waiting !== undefined) t.waiting.on = open.size > 0 || tasksRunning;
    };

    /** Everything that moves when a prompt of this turn opens or closes, by the protocol's one rule for which open
     * prompt leads: what the row says the thread is waiting on, the question itself for a thread waiting behind
     * this one, whether the turn is blocked on a person, and the clock on how long it has been. Written on every
     * open and close, so the sidebar, the command line, the turn's idle clock and its settled figure read one fact. */
    const readsOpen = (): void => {
      const lead = leadAsk(open.values());
      if (lead === undefined) {
        delete view.asking;
        ctx.leadAsks.delete(threadId);
      } else {
        view.asking = askingLine(lead);
        ctx.leadAsks.set(threadId, lead);
      }
      readsWaiting();
      if (open.size > 0) waitingSince ??= clock.now();
      else if (waitingSince !== undefined) {
        waited += clock.now() - waitingSince;
        waitingSince = undefined;
      }
      void ctx.persistSessions(workspaceId);
    };

    /** The ask as clients read it: the harness's slug for a mode option carries no words of its own, and the words
     * for one live in the harness table beside the picker's, so they are lent here rather than in the adapter. */
    const named = (ask: PermissionAsk): PermissionOption[] => {
      const modes = harnessCatalog(view.harness)?.permissionModes ?? [];
      return ask.options.map(o =>
        o.effect === "mode" && o.mode !== undefined ? { ...o, label: permissionModeOptionLabel(modes.find(m => m.value === o.mode)?.label ?? o.mode) } : { ...o },
      );
    };

    /** The row that says a prompt is closed. Both the harness's own close and the runtime ending the turn under it
     * come through here: a turn cut from this side never reaches the adapter's close, and a row left open would keep
     * offering options that answer nothing. */
    const closeAsk = (askId: string, outcome: PermissionOutcome, optionId?: string): void => {
      if (!open.has(askId)) return;
      open.delete(askId);
      readsOpen();
      ctx.record({
        type: "session.permission.closed",
        workspaceId,
        sessionId: view.claudeSessionId ?? view.id,
        turnId,
        threadId,
        askId,
        outcome,
        ...(optionId !== undefined ? { optionId } : {}),
      });
    };

    /** Every prompt still waiting, closed as going with its turn; the caller is ending the turn. */
    const closeOpenAsks = (): void => {
      for (const askId of [...open.keys()]) closeAsk(askId, "cancelled");
    };

    /** The one place a pick becomes an outcome and the line the agent reads as the call's result. Only a person picks,
     * so a deny is always the person's and says so. */
    const answer = async (askId: string, o: { optionId: string; reason?: string }): Promise<SessionAnswerResult["outcome"]> => {
      const held = open.get(askId);
      if (held === undefined) return "gone";
      // One pick may name several options: a question that takes more than one answer sends them as one id.
      const option = pickedOptions(held.options, o.optionId)?.[0];
      if (option === undefined) return "no-option";
      // A turn that raised a prompt has the road that raised it; with none there is nothing left to answer it.
      if (answerAsk === undefined) return "gone";
      const outcome: PermissionOutcome = option.effect === "deny" ? "denied" : "allowed";
      // A reason rides a deny alone: it is what the person wants done instead of the call they refused.
      const reason = option.effect === "deny" && o.reason !== undefined && o.reason.trim() !== "" ? o.reason.trim() : undefined;
      return (await answerAsk(askId, { optionId: o.optionId, outcome, denyMessage: deniedLine(reason), ...(reason === undefined ? {} : { reason }) })) === "answered" ? "answered" : "gone";
    };

    const forward = (event: AdapterEvent): void => {
      if (ended) return;
      const sessionId = event.sessionId;
      switch (event.type) {
        case "session.start": {
          view.claudeSessionId = sessionId;
          if (event.cwd !== undefined) view.cwd = event.cwd;
          if (event.model !== undefined) view.model = event.model;
          entry.record.claudeSessionId = sessionId;
          // The harness loaded the session up to the rewind's anchor, so the thread no longer holds it for a later start.
          if (t.cutAt !== undefined && threadRecords.get(threadId)?.resumeAt === t.cutAt) delete threadRecords.get(threadId)!.resumeAt;
          void ctx.persist(entry.record);
          void ctx.persistSessions(workspaceId);
          // The harness keys its store by the id it just announced, so a name given at the start is written now;
          // a CLI that already took it at launch is told the same name twice, which is what keeps this one road.
          if (opening.title !== undefined && !startRecorded) void ctx.nameInHarness(view, opening.title);
          // One turn is one start row however often the harness announces itself.
          if (startRecorded) return;
          startRecorded = true;
          ctx.record({
            type: "session.start",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            prompt: opening.prompt,
            ...(opening.requestId !== undefined ? { requestId: opening.requestId } : {}),
            ...(opening.via !== undefined ? { via: opening.via } : {}),
            ...(opening.afterCut === true ? { afterCut: true } : {}),
            ...(opening.opensThread === true ? { opensThread: true } : {}),
            startedBy: view.startedBy,
            ...(opening.attachments !== undefined ? { attachments: [...opening.attachments] } : {}),
            ...(event.model !== undefined ? { model: event.model } : {}),
            ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
            ...(view.permissionMode !== undefined ? { permissionMode: view.permissionMode } : {}),
            agent: view.harness,
            ...(event.tools !== undefined ? { tools: event.tools } : {}),
            ...(event.harness !== undefined ? { harness: event.harness } : {}),
          });
          // The thread is named now, from its opening words, so a builder's row reads what it is about seconds
          // after it starts rather than after an hour-long turn. Asked here and not before the harness announced
          // its session: the store is read first, since what the harness already calls the session is a person's
          // and a thread that has one is never asked, and the answer is written back under that same id. This sits
          // under the one start row a turn writes, so a re-opened run, whose row the host that launched it wrote,
          // returns above and asks nothing.
          if (ctx.sourceOf(view) === "seed") {
            void ctx.refreshTitle(view, false)
              .then(() => ctx.makeTitle(view))
              .catch((e: unknown) => console.warn(noMadeTitleLogLine(threadId, workspaceId, e instanceof Error ? e.message : String(e))));
          }
          return;
        }
        case "turn.delta":
          if (event.kind === "tool_use" && event.toolUseId !== undefined && event.toolName !== undefined) calls.set(event.toolUseId, { toolName: event.toolName, input: event.text });
          else if (event.kind === "tool_result" && event.toolUseId !== undefined) calls.delete(event.toolUseId);
          if (replaying > 0) {
            replaying--;
            return;
          }
          ctx.record({
            type: "session.delta",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            line: ++deltas,
            kind: event.kind,
            text: event.text,
            ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
            ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
            ...(event.isError !== undefined ? { isError: event.isError } : {}),
            ...(event.parentToolUseId !== undefined ? { parentToolUseId: event.parentToolUseId } : {}),
            ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
          });
          return;
        case "turn.done": {
          // A reply already written stands, and the gate comes before the status is taken: what the run says on the
          // way round again is the reply this turn already gave, and nothing later may overwrite it.
          if (replyRecorded) {
            replyRecorded = false;
            turnLive.reply ??= recordedReply;
            return;
          }
          // The reply is in, but the row stays running until session.end (the process exited): the harness can
          // keep working past its result, and a row read as completed here lets a send start a second agent in the
          // same worktree. The result is held and applied at the exit below.
          turnLive.reply = event.result.status;
          // The harness counts wall time from launch to result, prompts included, so the spans the turn stood on a
          // person ride out with it and every reader takes them off one figure rather than guessing at them.
          const onThePerson = waitedSoFar();
          const result: TurnResult = onThePerson > 0 ? { ...event.result, waitedMs: onThePerson } : event.result;
          // The cause rides the row too, since a refused turn did none of the work: what a thread is read as having
          // run is decided off the rows, and the result itself lives only in the transcript.
          if (result.refusal !== undefined) view.refusal = result.refusal;
          // So does what the turn cost, added to what the row's earlier turns cost: a resumed turn takes over the
          // row it resumes, and a listing has to answer what a thread spent without reading anyone's transcript.
          if (result.costUsd !== undefined) view.costUsd = (view.costUsd ?? 0) + result.costUsd;
          // What the turn used, filed in the ledger under the sign-in it ran on; a turn that counted nothing files nothing.
          if (result.tokens !== undefined || result.costUsd !== undefined) {
            const account = ctx.usageAccountOf(entry, view.harness, turnAccount);
            const model = result.model ?? view.model;
            // An agent that names each model a turn used files a row for each; the turn counts once, under its own model.
            const uses = result.models !== undefined && result.models.length > 0 ? result.models : [{ model, tokens: result.tokens, costUsd: result.costUsd }];
            const counted = uses.some(u => u.model === model) ? model : uses[0]!.model;
            for (const use of uses)
              void ctx.ledger
                .add({
                  at: clock.now(),
                  agent: view.harness,
                  account: account.key,
                  accountLabel: account.label,
                  computer: ctx.usageComputerOf(entry.record),
                  project: entry.record.project,
                  turns: use.model === counted ? 1 : 0,
                  ...(use.model !== undefined ? { model: use.model } : {}),
                  ...(use.tokens !== undefined ? { tokens: use.tokens } : {}),
                  ...(use.costUsd !== undefined ? { costUsd: use.costUsd } : {}),
                  ...((view.claudeSessionId ?? sessionId) !== undefined ? { session: view.claudeSessionId ?? sessionId } : {}),
                  source: "wsp",
                })
                .catch((e: unknown) => console.warn(`the use of turn ${turnId} was not filed: ${e instanceof Error ? e.message : String(e)}`));
          }
          void ctx.persistSessions(workspaceId);
          if (notify !== undefined) ctx.notifyEnd({ view, turnId }, notify, ctx.tellAs(t), result);
          ctx.record({ type: "session.done", workspaceId, sessionId, turnId, threadId, result });
          readChanges(sessionId);
          return;
        }
        case "turn.anchor":
          anchor = event.anchor;
          keptWhy = event.kept;
          return;
        case "subagent":
          // Counted apart from the deltas, so a run re-read from its first line writes none of these a second time and
          // a run a host from before them left has all of them written.
          if (replayingSubagents > 0) {
            replayingSubagents--;
            return;
          }
          ctx.record({
            type: "session.subagent",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            line: ++subagentRows,
            task: event.task,
            state: event.state,
            ...(event.parentToolUseId !== undefined ? { parentToolUseId: event.parentToolUseId } : {}),
            ...(event.title !== undefined ? { title: event.title } : {}),
            ...(event.summary !== undefined ? { summary: event.summary } : {}),
            ...(event.depth !== undefined ? { depth: event.depth } : {}),
          });
          return;
        case "limit": {
          turnAccount = event.limit.account ?? turnAccount;
          const account = ctx.usageAccountOf(entry, view.harness, turnAccount);
          void ctx.ledger
            .limit({ key: account.key, agent: view.harness, label: account.label, road: account.road, computer: ctx.usageComputerOf(entry.record), limit: event.limit })
            .then(async ({ before, after }) => {
              await ctx.alerts.read(before, after);
              // The row as the Usage page reads it now, so a slate's bound meter moves the moment a turn reports.
              const row = (await ctx.usageAccounts()).accounts.find(a => a.key === account.key);
              if (row !== undefined) bus.emit({ type: "usage.account", key: account.key, row });
            })
            .catch((e: unknown) => console.warn(`the limits of ${account.key} were not kept: ${e instanceof Error ? e.message : String(e)}`));
          return;
        }
        case "turn.usage":
          // Only a run re-read after a restart reads the agent's stamp, and only against its own other stamps.
          ctx.burn.add({ account: ctx.usageAccountOf(entry, view.harness, turnAccount).key, threadId, tokens: event.tokens, ...(t.written !== undefined && event.at !== undefined ? { replayed: { run: turnId, at: event.at } } : {}) });
          return;
        case "turn.plan":
          ctx.record({ type: "session.plan", workspaceId, sessionId, turnId, threadId, ...(event.steps !== undefined ? { steps: event.steps } : {}), ...(event.text !== undefined ? { text: event.text } : {}) });
          return;
        case "turn.tasks":
          // The harness's own word on the work this turn started: while any of it runs the turn is working, whatever
          // its agent has already said, so the idle clock is held the way an open prompt holds it.
          tasksRunning = event.running > 0;
          readsWaiting();
          return;
        case "permission.ask": {
          const ask = { ...event.ask, options: named(event.ask) };
          // The turn stops here until an option comes back. Nothing else closes it: a person who was away for an
          // hour comes back to the question they were asked, rather than to an agent that was denied and told to
          // ask for a mode that does not ask.
          open.set(ask.askId, ask);
          readsOpen();
          ctx.record({ type: "session.permission", workspaceId, sessionId, turnId, threadId, ...ask, options: [...ask.options] });
          ctx.endSnoozeFor(view);
          return;
        }
        case "permission.close":
          closeAsk(event.askId, event.outcome, event.optionId);
          return;
        case "session.end":
          // A prompt the harness left open goes with its process: nothing can answer it now, and a row left open
          // would leave the thread reading as waiting on a person forever.
          closeOpenAsks();
          // The process exited: the turn is over now, so the row takes the reply's status here (synchronously,
          // before the event is recorded, so a waiter woken by it reads the settled row, not the running one).
          if (turnLive.reply !== undefined) view.status = turnLive.reply;
          view.endedAt = Date.now();
          ctx.record({
            type: "session.end",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            exitCode: event.exitCode,
            sawResult: event.sawResult,
          });
          turnOver();
          readChanges(sessionId);
          return;
      }
    };

    // A process kept from an earlier turn reads the box that turn left, which may still say it was waiting.
    readsWaiting();
    ctx.idle.hold(workspaceId);
    let started: HarnessSession;
    try {
      started = t.open(forward);
    } catch (e) {
      ctx.idle.release(workspaceId);
      throw e;
    }
    started.finished.then(
      () => {
        ctx.idle.release(workspaceId);
        void ctx.readDisk(entry).catch((e: unknown) => console.warn(`disk of ${workspaceId} not read after its turn: ${e instanceof Error ? e.message : String(e)}`));
      },
      () => ctx.idle.release(workspaceId),
    );
    answerAsk = started.answer?.bind(started);
    const handleId = started.localId;
    // A row that already has an id keeps it: a re-opened turn is named by the harness's own session, which is not
    // always the id the row was keyed by, and a client holding the row must not see it change under a restart. The
    // turn's own id is the exception, the one the start road keyed this row by while the turn was still reaching the
    // machine, and it gives way to the harness's here: an id does move under a client inside that window, which is
    // safe only because every client keys a thread by its threadId, through foldThreads and through the wait alike.
    if (view.id === "" || view.id === turnId) view.id = handleId;
    const rowId = view.id;
    // A resumed turn takes over the row of the turn it resumes; the row keeps saying who opened the thread and
    // with what, since every client titles the thread by the row's prompt. Later turns live in the transcript.
    const resumed = t.resume !== undefined ? sessions.get(handleId)?.view : undefined;
    if (resumed !== undefined) {
      view.startedBy = resumed.startedBy ?? view.startedBy;
      if (resumed.prompt !== undefined) view.prompt = resumed.prompt;
      // What the row cost is every turn that ran on it, so the earlier turns' figure carries into the row this one
      // takes over; a listing reads the row, not the transcript.
      if (resumed.costUsd !== undefined) view.costUsd = resumed.costUsd;
    }

    /** A pick made while this turn runs, taken by the harness: the row carries the mode the turn is now at. */
    const setAccess = async (mode: string): Promise<"set" | "refused" | "gone"> => {
      const outcome = await started.setAccess!(mode);
      if (outcome === "set") view.permissionMode = mode;
      return outcome;
    };

    const handle: SessionHandle = {
      id: rowId,
      workspaceId,
      finished: started.finished,
      turnId,
      outcome,
      view: () => ({ ...view }),
      interrupt: () => started.interrupt(),
      ...(started.steer !== undefined ? { steer: (prompt: string) => started.steer!(prompt) } : {}),
      ...(started.answer !== undefined ? { answer } : {}),
      ...(started.setAccess !== undefined ? { setAccess } : {}),
      ...(started.stopTask !== undefined ? { stopTask: (task: string) => started.stopTask!(task) } : {}),
    };
    const end = (reason: string): void => {
      if (ended || view.status !== "running") return;
      // Before `ended` shuts the forward road: the interrupt below reaches the harness, whose own close would then
      // be dropped, so the rows and the waits are ended here.
      closeOpenAsks();
      ended = true;
      const row = sessions.get(rowId);
      if (row?.turnId === turnId) delete row.snapshot;
      ctx.settleCut({ view, turnId, ...(notify !== undefined ? { notify } : {}), ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}), turnLive }, reason, () => reason);
      void ctx.persistSessions(workspaceId);
      void started.interrupt().catch(() => {});
      turnOver();
    };
    // One row per turn, never two: the key the start road held this turn under goes as the harness's own takes over.
    if (turnId !== rowId) sessions.delete(turnId);
    sessions.set(rowId, { view, turnId, calls, ...(notify !== undefined ? { notify } : {}), ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}), ...(turnToken !== undefined ? { turnToken } : {}), ...(scopeDeviceId !== undefined ? { scopeDeviceId } : {}), handle, end, turnLive, ...(started.run !== undefined ? { run: started.run } : {}), ...(started.from !== undefined ? { from: started.from } : {}), ...(t.asked !== undefined ? { asked: t.asked } : {}), ...(typeof t.snapshot?.from === "string" ? { snapshot: t.snapshot.from } : {}), ...(started.pid !== undefined ? { pid: started.pid } : {}) });
    if (started.pid !== undefined && ctx.moduleOf(entry.record.kind).sharedDaemon) {
      const groups = ctx.turnGroups.get(workspaceId) ?? new Set<number>();
      ctx.turnGroups.set(workspaceId, groups);
      groups.add(started.pid);
      ctx.armRootsRecheck();
    }
    ctx.portRootsMoved(workspaceId);
    void ctx.persistSessions(workspaceId);
    // A launch that hands its prompt over late resolves its snapshot after the row exists; the row takes it then.
    const taking = t.snapshot?.from;
    if (taking instanceof Promise) {
      void taking.then(commit => {
        const row = sessions.get(rowId);
        if (commit === undefined || row === undefined || row.turnId !== turnId || row.view.status !== "running") return;
        row.snapshot = commit;
        void ctx.persistSessions(workspaceId);
      });
    }
    /** The turn's process is over: its status settles, its token stops naming anything, and the harness's own title
     * for the session is read again, since it writes one as the turn settles. */
    const settled = (status: TurnStatus): void => {
      const row = sessions.get(rowId);
      if (row !== undefined && row.turnToken === turnToken) delete row.turnToken;
      if (row?.turnId === turnId && !changesOut) delete row.snapshot;
      // A process kept for the thread's next turn keeps the token and the device in its environment, which name the
      // thread until the keep ends it.
      const agent = t.keep !== undefined ? started.kept?.() : undefined;
      const keeps =
        agent !== undefined &&
        !ended &&
        turnToken !== undefined &&
        view.claudeSessionId !== undefined &&
        ctx.holdKept(threadId, { workspaceId, agent, launch: t.keep!.launch, session: view.claudeSessionId, turnToken, ...(scopeDeviceId !== undefined ? { scopeDeviceId } : {}), waiting: t.waiting ?? { on: false } });
      if (agent !== undefined && !keeps) void agent.close().catch(() => {});
      // The process is gone, so the token in its environment names nothing that can be asked for anything: it is
      // taken away here, the one exit both the reply road and the failure road reach.
      if (scopeDeviceId !== undefined && !keeps) {
        void deviceDoor.revoke(scopeDeviceId).catch((e: unknown) => console.warn(`the token of thread ${threadWord(threadId)} was not taken away: ${e instanceof Error ? e.message : String(e)}`));
      }
      if (!ended) view.status = status;
      ctx.portRootsMoved(workspaceId);
      view.endedAt ??= Date.now();
      if (view.status === "failed") ctx.endSnoozeFor(view);
      // A pick this turn did not take landed on the thread's record alone; the row says it from here on, since
      // every client folds the thread's access off the row and the next turn runs at the record's.
      const kept = threadRecords.get(threadId)?.permissionMode;
      if (kept !== undefined) view.permissionMode = kept;
      // The turn is over: its own calls follow nobody now, and nobody waiting behind it is waiting any more.
      calls.clear();
      ctx.leadAsks.delete(threadId);
      void ctx.persistSessions(workspaceId);
      endWritten = true;
      // Only a turn that ended on its own: a turn this host ended is one whose workspace is going away under it,
      // and the harness's own store for it goes with the machine, so the read would reach a machine that is being
      // taken down and say so in the log for every thread on it.
      if (!ended) void ctx.refreshTitle(view, true);
      // The turn may have moved the branch or the files, so the tile's line is read again now rather than on a timer,
      // and the pull request with it, since the agent may have pushed.
      if (!ended) void ctx.readCheckout(entry, true).then(() => ctx.readPullRequest(entry, true)).then(() => ctx.readLeadOf(entry));
      // A tree whose root's pull request has settled settles again as its last turn ends: merged stays merged, and a
      // send into the tree is what took it off the fold.
      if (!ended) {
        const rootOn = view.rootThreadId === undefined ? entry : live.get(ctx.latestOn(view.rootThreadId)?.workspaceId ?? "");
        if (rootOn !== undefined && rootOn.record.pr !== undefined && rootOn.record.pr.state !== "open") void ctx.settleTree(rootOn);
      }
      if (t.imagesDir !== undefined) ctx.dropImages(entry, t.imagesDir);
    };
    // The reload a client runs on session.end shares that read rather than starting a second.
    started.finished.then(
      result => {
        settled(result.status);
        if (!ended && result.status === "completed") void ctx.takeReview(entry, threadId, result.text ?? "").catch((e: unknown) => console.warn(`the review in ${entry.record.name} was not read: ${e instanceof Error ? e.message : String(e)}`));
      },
      () => settled("failed"),
    );
    return handle;
  };

  /** Every harness run on one workspace's machine that this host does not hold, ended. Read after the rows are in
   * and every one that could be re-opened has been, so what is left is a run no thread here will ever read: the host
   * that launched it went down under it, or its own row could not be re-opened and was settled. The runs this host
   * holds are named to the machine rather than found there, so a turn this host is reading is never ended by its own
   * sweep. Best effort: a machine that will not answer keeps its runs, and the next connect asks again. */
  const sweepRuns = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.phase !== "running") return;
    // Nothing can be asked about a machine held by a stand-in, so nothing is: a computer that is away and a host
    // started without its provider key both leave the runs where they are rather than saying so at every start.
    if (ctx.isHeldAway(entry.record.id)) return;
    const sweep = ctx.execFactoryFor(entry).sweep;
    if (sweep === undefined) return;
    // Every running row's run and not this workspace's alone: the workspaces on one computer share its run folder,
    // so a sweep that kept only its own would end the turns of the others.
    const held: string[] = [];
    for (const s of sessions.values()) {
      if (s.view.status === "running" && s.run !== undefined) held.push(s.run);
    }
    const swept = await sweep(held).catch((e: unknown) => {
      console.warn(`the runs on ${entry.record.id} were left as they are: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    });
    if (swept.length > 0) console.warn(sweptRunsLogLine(entry.record.id, swept));
  };


  /** A turn the store left running, re-opened where it runs. The machine still holds the run and its whole output,
   * so the events this host missed reach it as the run's own lines and the thread goes on running to its reply.
   * `cannot` covers a row with no run recorded (a host from before this road, or a harness whose runs die with it),
   * no workspace or no machine running under it, no adapter for its harness in this process, and a handle that is
   * not one this host could have launched. */
  const reattach = async (s: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; run?: string; from?: number; asked?: TurnAsked; turnToken?: string; scopeDeviceId?: string; snapshot?: string }): Promise<Reopened> => {
    const { view, run } = s;
    const threadId = view.threadId;
    const entry = live.get(view.workspaceId);
    if (run === undefined || threadId === undefined || entry === undefined || entry.record.phase !== "running") return "cannot";
    const cannot = (words: string): "cannot" => {
      console.warn(`thread ${threadId.slice(0, 8)} on ${view.workspaceId} cannot be re-opened: ${words}`);
      return "cannot";
    };
    let adapter: HarnessAdapter;
    // As on the start road: the re-opened stream reads this while the turn it attached to is stopped on a question.
    const waiting = { on: false };
    try {
      adapter = ctx.adapterFor(entry, view.harness, undefined, () => waiting.on).adapter;
    } catch (e: unknown) {
      return cannot(e instanceof Error ? e.message : String(e));
    }
    const open = adapter.attach?.bind(adapter);
    if (open === undefined) return "cannot";
    // The harness may start reading the run the moment it is opened, which is before the row that records those
    // lines exists, so what arrives first is held and handed to the row's own forward in order once it does.
    const held: AdapterEvent[] = [];
    let sink: ((event: AdapterEvent) => void) | undefined;
    let opened: HarnessSession | "gone";
    try {
      opened = await open({
        run,
        sessionId: view.claudeSessionId ?? view.id,
        startedAt: view.startedAt ?? Date.now(),
        ...(view.model !== undefined ? { model: view.model } : {}),
        ...(view.cwd !== undefined ? { cwd: view.cwd } : {}),
        ...(s.asked !== undefined ? { prompt: s.asked.prompt, ...(s.asked.effort !== undefined ? { effort: s.asked.effort } : {}) } : {}),
        ...(s.from !== undefined ? { from: s.from } : {}),
        onEvent: event => (sink === undefined ? void held.push(event) : sink(event)),
      });
    } catch (e: unknown) {
      // Nothing answered about the run, so nothing is known about it: the turn is left exactly as it was.
      console.warn(`thread ${threadId.slice(0, 8)} on ${view.workspaceId} was left running: ${e instanceof Error ? e.message : String(e)}`);
      return "unreached";
    }
    if (opened === "gone") return "gone";
    // The turn reads how much of itself is written off the transcript it is handed, the copy this open answers. A file
    // that did not read says nothing about the run, so the row is left running as it was.
    let written: SessionEvent[];
    try {
      written = await ctx.openTranscript(view.workspaceId);
    } catch (e: unknown) {
      console.warn(`thread ${threadId.slice(0, 8)} on ${view.workspaceId} was left running: ${e instanceof Error ? e.message : String(e)}`);
      return "unreached";
    }
    try {
      runTurn({
        entry,
        view,
        written: turnWritten(written, s.turnId),
        threadId,
        turnId: s.turnId,
        ...(s.notify !== undefined ? { notify: s.notify } : {}),
        ...(s.notifyBy !== undefined ? { notifyBy: s.notifyBy } : {}),
        ...(s.notifyRoad !== undefined ? { notifyRoad: s.notifyRoad } : {}),
        // The token this turn was launched with is still in the process this attach reached, so the row that answers
        // for it takes it back; a token this host had never minted would be one nobody can answer for.
        ...(s.turnToken !== undefined ? { turnToken: s.turnToken } : {}),
        // The device that turn was launched with is still in the process this attach reached, so the row that
        // answers for it takes it back and its exit is what hands it over.
        ...(s.scopeDeviceId !== undefined ? { scopeDeviceId: s.scopeDeviceId } : {}),
        ...(s.turnLive !== undefined ? { turnLive: s.turnLive } : {}),
        ...(s.asked !== undefined ? { asked: s.asked } : {}),
        ...(s.snapshot !== undefined && view.cwd !== undefined ? { snapshot: { from: s.snapshot, cwd: view.cwd } } : {}),
        outcome: "started",
        waiting,
        // The row's own prompt is the thread's opening once a later turn takes the row over, so the start row a
        // re-opened turn still owes is written from what was typed for this turn.
        opening: { prompt: s.asked?.typed ?? s.asked?.prompt ?? view.prompt ?? "" },
        open: forward => {
          sink = forward;
          for (const event of held.splice(0)) forward(event);
          return opened as HarnessSession;
        },
      });
    } catch (e: unknown) {
      return cannot(e instanceof Error ? e.message : String(e));
    }
    return "attached";
  };
  return { runTurn, sweepRuns, reattach };
}

function sessionsArea(ctx: RuntimeContext): SessionsArea {
  const {
    opts, store, bus, clock, deviceDoor, threadLaunch, live, setups, threadRecords, sessions, transcriptIndex,
  } = ctx;
  const sessionsApi: Runtime["sessions"] = {
    async start(workspaceId, opened, origin) {
      await ctx.ready();
      const prefs = ctx.state.preferencesHeld ?? (await ctx.preferences.get());
      // A start is known by its request id, so one sent again after the host stopped under it is the same message:
      // the host that took it answers with the turn it opened or joined, on a thread the caller reaches, and starts
      // nothing. The one rule every client's road back reads, so a restart neither drops a message nor runs it twice.
      const taken = opened.requestId === undefined ? undefined : transcriptIndex.get(workspaceId)?.taken.get(opened.requestId);
      if (taken !== undefined && (await ctx.entryOfRow({ threadId: taken.threadId, workspaceId }, origin)) !== undefined) {
        const answered = await ctx.takenTurn(workspaceId, taken);
        if (answered !== undefined) return answered;
      }
      // The thread this start lands in is read before the workspace is: a send into a thread of the caller's tree
      // reaches it on whatever workspace it runs, and only a start that opens a thread is a workspace act.
      // A thread whose rows fell off the index cap, or whose index is gone, is still the thread its record or its
      // transcript says it is.
      const named = opened.thread === undefined ? undefined : ctx.latestOn(opened.thread);
      const fromTranscript = opened.thread === undefined ? undefined : ctx.startedAs(workspaceId, opened.thread);
      const heldOn = opened.thread === undefined ? undefined : (named?.workspaceId ?? threadRecords.get(opened.thread)?.workspaceId ?? (fromTranscript !== undefined ? workspaceId : undefined));
      if (opened.thread !== undefined && heldOn !== workspaceId) throw new Error(`no thread ${opened.thread} on this workspace`);
      // Read again where the thread becomes this send's to run: the id it must resume may not exist yet.
      let resume = named?.claudeSessionId ?? fromTranscript;
      const threadId = opened.thread ?? randomUUID();
      // A message into a thread that already has turns is a send; anything else opens one, and only one of those
      // two is what a thread's own token is capped on. Read before the machine is asked for anything. The thread's
      // record answers before its rows, since the rows are capped and the record is not.
      const opens = !threadRecords.has(threadId) && ctx.rowsOn(threadId).length === 0;
      // A send goes into a thread the caller drives, read on the thread it lands in.
      const opening = live.get(workspaceId)?.record;
      const reached = opens ? await ctx.entryOf(workspaceId, opening !== undefined && ctx.opensIn(opening, scopeOf(origin)) ? undefined : origin) : await ctx.entryOfRow({ threadId, workspaceId }, origin);
      if (reached === undefined) throw new Error(`no thread ${opened.thread} on this workspace`);
      const entry = reached;
      // A worktree somebody removed by hand reads as gone the moment a thread asks for it, so the turn runs in the
      // project folder rather than in a folder that is not there.
      const worktree = entry.record.worktree;
      const goneNow = worktree !== undefined && worktree.gone !== true && !existsSync(worktree.path) ? worktree.path : undefined;
      if (goneNow !== undefined) await ctx.worktreeGone(entry, "removed", { starting: true });
      // What a thread already carries decides two of this send's picks, and it is read after the reading above, so
      // a caller that cannot drive the thread learns nothing about it. A thread keeps its agent: the turn runs on
      // the harness its record names, and a request naming another is refused rather than resuming that thread's
      // harness session under an agent that never wrote it. Its access is its own the same way, so a mode named on
      // a send is dropped and sessions.access is the one road that changes what a thread may touch; the access the
      // thread runs at is then read off its record below, as a send that named none has always read it.
      const carried: Pick<ThreadRecord, "harness"> | undefined = opens ? undefined : (threadRecords.get(threadId) ?? ctx.latestOn(threadId));
      if (carried !== undefined && opened.harness !== undefined && opened.harness !== carried.harness) throw new Error(threadRunsOnLine(carried.harness, opened.harness));
      // A start that names no agent runs the project's, else the person's default, else the catalog's first, so the
      // command line, the composer and a tool all open the next thread on the same agent.
      const overrides = prefs.projectDefaults[entry.record.project];
      // A send, a notify or a press that names no model, effort or window runs on the thread's own last picks: a
      // resume that names none runs on the CLI's default rather than the thread's.
      const own = !opens && opened.model === undefined && opened.effort === undefined && opened.contextWindow === undefined ? ctx.ownPicks(workspaceId, threadId) : {};
      const o = { ...opened, ...(own.contextWindow !== undefined ? { contextWindow: own.contextWindow } : {}), harness: carried?.harness ?? opened.harness ?? ctx.defaultAgentOf(prefs, entry) };
      if (carried !== undefined) {
        delete o.permissionMode;
        delete o.access;
      }
      if (ctx.agentOff(entry, o.harness)) throw Object.assign(new Error(agentOffLine(ctx.agentLabel(o.harness), ctx.computerOf(entry))), { kind: "usage" });
      await ctx.confineSetup(entry, o.harness);
      const refuse = (): void => {
        const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone, entry.record.name);
        if (refusal !== null) throw new Error(refusal);
      };
      refuse();
      // A blocked computer refuses a new turn but never a message joining one still running there, so a busy thread asks once it frees.
      let cleared = !ctx.threadRuns(threadId);
      if (cleared) await ctx.copyBlocked(entry);
      const title = o.title === undefined ? undefined : titleLine(o.title);
      if (title === "") throw new Error(EMPTY_TITLE_LINE);
      ctx.spawnGuard(opens ? "thread_new" : "send", origin);
      // The tree this thread sits in, written on its first row and read off it by every later turn: a thread a
      // person opened is its own root, and one a thread opened hangs under that thread's root.
      const spawnedBy = opens ? scopeOf(origin) : undefined;
      const tree = opens
        ? ctx.treeOf(spawnedBy)
        : { ...(ctx.parentOf(threadId) !== undefined ? { parentThreadId: ctx.parentOf(threadId)! } : {}), ...(ctx.rootOf(threadId) !== threadId ? { rootThreadId: ctx.rootOf(threadId) } : {}) };
      // me is the caller: the thread this request came out of when its token says it came out of one, and the person
      // when there is no token, which is every road that is not a turn. A target named twice is one target, since a
      // list says who is told and not how often.
      const asked =
        o.notify === undefined
          ? undefined
          : [...new Set(o.notify.map(target => (target === NOTIFY_ME && o.turnToken !== undefined ? ctx.threadOfToken(o.turnToken) : target)))];
      // The threads a start may name as targets: the ones the caller drives, every thread of its own tree, so a
      // notify reaches no thread a send could not and the line it delivers is one the caller could have sent by
      // hand. A thread of another tree reads as no thread at all, so a guest cannot tell a foreign thread from
      // none. The one crossing this keeps is the shim's own `--notify me`, which is the caller itself.
      for (const target of asked ?? []) {
        if (target === NOTIFY_ME) continue;
        const on = ctx.latestOn(target);
        if (on === undefined || !ctx.reachesRow(on, origin)) throw new Error(`no thread ${target} to notify`);
        if (target === threadId) throw new Error("a thread cannot notify itself");
        // Each end would start the next turn on the other thread with no one sending anything, so the chain is
        // walked whole; it is a lead and its builders, so it is short.
        if (ctx.notifyReach(ctx.notifyOn(target)?.notify ?? []).has(threadId)) {
          throw new Error(`thread ${target.slice(0, 8)} already notifies this thread; a cycle would run forever`);
        }
      }
      const registered = ctx.notifyOn(threadId);
      const notify = asked ?? registered?.notify;
      // Who named these targets, kept beside them: a start out of a thread carries that thread's scope, so the line
      // its end delivers starts the target's turn under it; one the person made carries none and goes as theirs. A
      // send into a thread takes what the thread's opener registered, this beside the targets themselves.
      const notifyBy = asked === undefined ? registered?.by : scopeOf(origin);
      // And the road they were named from, beside the thread: the line's own start reads the same rules the
      // registration did, so a road that may not start a process on the target's workspace does not get one
      // started for it a turn later.
      const notifyRoad = asked === undefined ? registered?.road : roadOf(origin);
      const turnToken = randomBytes(16).toString("hex");
      const { scoped, env: launchEnv, wsp } = await threadLaunch(entry, threadId, tree.rootThreadId ?? threadId);
      const dropScope = (): void => {
        if (scoped !== undefined) void deviceDoor.revoke(scoped.deviceId).catch((e: unknown) => console.warn(`the token of thread ${threadWord(threadId)} was not taken away: ${e instanceof Error ? e.message : String(e)}`));
      };
      // The one refusal left that comes after the mint, since the launch environment is what it is given: a harness
      // this host has no adapter for hands the token back rather than leaving it standing until a restart.
      let built: { harness: string; adapter: HarnessAdapter };
      // Flipped while a permission prompt of this turn stands open: the stream the adapter is about to launch reads
      // it, and the row the turn opens writes it, so a turn stopped on a question is not read as a quiet one.
      const waiting = { on: false };
      try {
        built = ctx.adapterFor(
          entry,
          o.harness,
          { [TURN_TOKEN_ENV]: turnToken, ...launchEnv },
          () => waiting.on,
          // A name no catalog row declares is one an MCP server's definition reads, which only the environment carries.
          serverValuesOf(opts.vault?.() ?? {}),
        );
      } catch (e) {
        dropScope();
        throw e;
      }
      const { harness, adapter } = built;
      // Only on this computer: a box keeps the prompt in its launch seed, since a write there is one more exec trip.
      const promptsLate = adapter.waitsForPrompt === true && copiesFolder(entry.record.kind);
      // The wsp tools ride every launch, for a harness that takes servers with one: under the same name as the
      // person's own wsp server, which Claude Code's --mcp-config and Codex's -c overrides both replace while the
      // person's other servers stay (measured on 2.1.284 and 0.155.1 against the user-scope config; a project's own
      // .mcp.json naming wsp was not measured). A harness that takes none is refused where a caller named servers and
      // left alone here, since the person asked for a thread, not for tools.
      // A thread another thread started has no slate: its launch says nothing of one, and on this computer, where the
      // server is the host's own wsp and knows the word, its server is told too. A box's server is served by this host
      // as a guest, which reads the same off the thread's token; the box's own wsp may be older and never sees a word.
      const sub = tree.rootThreadId !== undefined && tree.rootThreadId !== threadId;
      const served = wsp === undefined || !sub ? wsp : { ...wsp, noSlate: true as const, ...(wsp.args.includes(SCOPED_MCP_ARG) ? { args: [...wsp.args, NO_SLATE_MCP_ARG] } : {}) };
      const mcpServers = served !== undefined && adapter.mcpServers === true ? { [MCP_SERVER_NAME]: served, ...o.mcpServers } : o.mcpServers;
      const records = (o.attachments ?? []).map(attachmentRecord);
      const blocked = filesBlocked(records, adapter.attachments, harness) ?? mcpServersBlocked(o.mcpServers, adapter.mcpServers, harness);
      if (blocked !== null) {
        dropScope();
        throw new Error(blocked);
      }
      const turnId = randomUUID();
      // The thread's row is written here, before anything is asked of the machine: the harness's own lists, the
      // folder and the images all sit between this line and the launch, and they are seconds. A thread no row holds
      // is a thread nothing can be waited on, so a wait fired the moment after a detached start would find nothing
      // to wait for. Only where the thread has none of its own: a thread whose turn is running already has the row
      // a wait waits on, and a second would be the one every client folds the thread's state, folder and times off
      // while it holds none of them. So a send that finds the thread taken holds nothing until the thread is free,
      // and holds its row from then to the launch. The row carries what is known now; the picks and the folder land
      // on it below, and the harness's own facts as the turn answers.
      const view: SessionView = {
        id: turnId,
        workspaceId,
        harness,
        status: "running",
        startedBy: o.startedBy ?? "person",
        threadId,
        ...tree,
        ...(o.attempt !== undefined ? { attempt: o.attempt } : {}),
        prompt: o.prompt,
        startedAt: Date.now(),
        ...(title !== undefined ? { harnessTitle: title, titleSource: "person" as const } : ctx.carriedTitle(threadId)),
        ...(resume !== undefined ? { claudeSessionId: resume } : {}),
        ...(o.contextWindow !== undefined ? { contextWindow: o.contextWindow } : {}),
      };
      let launched!: () => void;
      const launch = new Promise<void>(r => (launched = r));
      let held = false;
      const hold = (): void => {
        if (held || ctx.threadRuns(threadId)) return;
        // The thread is this send's to run, and the session it resumes is the one the thread's latest turn ran as:
        // a send that arrived while that turn was still launching read none, since the harness names its session
        // only after it is up.
        resume = ctx.latestOn(threadId)?.claudeSessionId ?? resume;
        held = true;
        // The row that says the thread is spoken for also says who its turns tell: a send into the thread reads the
        // opener's notify off its rows, and inside the launch window this is the only one.
        sessions.set(turnId, { view, turnId, launch, ...(notify !== undefined ? { notify } : {}), ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}) });
        bus.emit({ type: "session.held", workspaceId, threadId, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
      };
      hold();
      let outcome: SessionStartOutcome = "started";
      let images: TurnImage[] = [];
      let imagesDir: string | undefined;
      let filePaths: string[] = [];
      let filesFolder: string | undefined;
      // Every send takes one trip before its launch: its files land and its folder's snapshot is taken, or only started
      // where the agent takes its prompt late.
      let landed = false;
      let snapshot: { from: Promise<string | undefined> | string; cwd: string } | undefined;
      // What this send's own folders on the machine are named by where its request id cannot be: the landing runs
      // before any turn is registered, so two sends arriving together both pass the wait, and a folder they shared
      // would leave the first turn holding the second's picture.
      const minted = randomUUID();
      // Every road out of the window between the row above and runTurn is in here, since the row that says this
      // thread is working and the images this send put on the machine both belong to a turn that does not exist on
      // any of them: a refusal after a trip, a start that never opened. A steer leaves by returning and holds
      // neither: a send steers only a turn that was running when it looked, before it held the thread or landed a
      // thing.
      let handedOver = false;
      let failure: string | undefined;
      let keptTaken: KeptProcess | undefined;
      try {
        const table = harnessCatalog(harness);
        // Checked against the binary's own lists, the ones the composer shows for this workspace, with the marks on
        // what the person's defaults resolve to here, which startPicks fills in for anything this start leaves out.
        const resolved = table === undefined ? undefined : ctx.defaultsOn(await ctx.catalogOn(table, entry, adapter), prefs, overrides);
        const catalog = resolved?.catalog;
        const named = o.permissionMode ?? (o.access === undefined ? undefined : ctx.namedMode(catalog, harness, o.access));
        // The thread's own access, read against the list in front of us: a mode this harness does not take is a pick
        // that does not apply here, not a send to refuse. An access this send NAMED is still refused, by startPicks.
        const picksFor = (session: string | undefined): StartPicks => {
          const access = named ?? (catalog === undefined ? undefined : listedPick(catalog.permissionModes, ctx.accessOf(workspaceId, threadId, session)));
          const open = session === undefined ? (resolved?.open ?? {}) : {};
          // The thread's own picks, like its access, only where the lists in front of us still carry them.
          const model = o.model ?? (catalog === undefined || catalog.models.length === 0 ? own.model : listedPick(everyModel(catalog), own.model)) ?? open.model;
          const ownEffort = catalog === undefined || catalog.efforts.length === 0 ? own.effort : listedPick(effortsFor(catalog, modelOf(catalog, model)), own.effort);
          const effort = o.effort ?? ownEffort ?? open.effort;
          return startPicks(catalog, { ...o, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), permissionMode: access }, session === undefined, session === undefined ? undefined : ctx.resumedFact(workspaceId, session, "model"));
        };
        // A pick the lists do not carry is refused here, before this send waits on anything; the picks themselves
        // are decided below the loop, against the session this send turns out to resume.
        picksFor(resume);
        const folder = await ctx.threadFolder(entry, o);
        if (o.cwd !== undefined && isLocalWorkspace(entry.record) && !existsSync(folder)) throw Object.assign(new Error(noCwdLine(homeShortened(folder, homedir()))), { kind: "usage" });
        const limitDetails = await ctx.limitDetailsDue(entry, harness);
        // Two processes on one harness session corrupt its transcript, so a thread runs one turn at a time. Nothing
        // below this loop may await: the wait ends the moment no turn is running, and every line from there to
        // runTurn, which registers this one, is one synchronous run. The images land inside it for that reason, once
        // the thread is this send's, and the workspace is checked again after them, since landing them is a trip to
        // the machine and the row this send holds keeps every other send behind it meanwhile. Sends are taken as they
        // reach this loop, which is the order their trips finish and not always the order they arrived.
        for (;;) {
          const running = ctx.runningOn(threadId);
          if (running === undefined) {
            // A turn of this thread another send is still carrying to the machine has no harness to steer or to wait
            // out yet, so this one waits for the moment it has one or is given up, and looks again.
            const launching = ctx.launchingOn(threadId);
            if (launching !== undefined && launching.turnId !== turnId) {
              if (outcome === "started") bus.emit({ type: "session.queued", workspaceId, threadId, harness, prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
              outcome = "queued";
              await launching.launch;
              refuse();
              cleared = false;
              continue;
            }
            if (!cleared) {
              cleared = true;
              await ctx.copyBlocked(entry);
              continue;
            }
            const writing = resume === undefined ? undefined : ctx.hostWrites.get(resume);
            if (writing !== undefined) {
              await writing;
              refuse();
              continue;
            }
            hold();
            if (landed) break;
            landed = true;
            const landing = ctx.runsIn(entry, resume === undefined ? undefined : ctx.folderOf(workspaceId, resume), folder);
            ({ images, dir: imagesDir } = await ctx.landImages(entry, adapter.attachments, landing, turnImagesDir(landing, threadId, o.requestId, minted), (o.attachments ?? []).filter(a => isImage(a.mediaType))));
            filePaths = await ctx.landFiles(entry, landing, sendFilesDir(landing, threadId, o.requestId, minted), (o.attachments ?? []).filter(a => !isImage(a.mediaType)));
            if (filePaths.length > 0) filesFolder = landing;
            const taken = promptsLate ? ctx.snapshotOf(entry, landing) : await ctx.snapshotOf(entry, landing);
            snapshot = taken === undefined ? undefined : { from: taken, cwd: landing };
            refuse();
            continue;
          }
          // A turn that has already answered takes no message, however well its harness steers: the words would
          // land after the reply the caller read. The send waits for that process to exit and runs as the thread's
          // next turn; nothing here is ever refused for being in the way.
          const steer = running.turnLive?.reply === undefined && adapter.steers ? running.handle.steer : undefined;
          if (steer !== undefined && (await steer(o.prompt)) === "accepted") {
            ctx.recordSteer(running, running.handle.id, o);
            return { ...running.handle, outcome: "steered" };
          }
          if (outcome === "started") bus.emit({ type: "session.queued", workspaceId, threadId, harness, prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
          outcome = "queued";
          await running.handle.finished.catch(() => {});
          refuse();
          cleared = false;
        }
        // A thread whose worktree went runs on in the project folder and is told so in its transcript. An agent that
        // keys its sessions to the project carries its session across; any other opens a fresh one there.
        const ranIn = resume === undefined ? undefined : ctx.folderOf(workspaceId, resume);
        const cwd = ctx.runsIn(entry, ranIn, folder);
        if (o.behind !== undefined) ctx.record({ type: "session.behind", workspaceId, sessionId: resume ?? turnId, turnId, threadId, text: o.behind });
        const movedFrom = ranIn ?? goneNow;
        if (movedFrom !== undefined && cwd !== movedFrom && entry.record.worktree?.gone === true) {
          const fresh = ranIn !== undefined && CATALOG_AGENTS.find(a => a.id === harness)?.projectKeyEnv === undefined;
          ctx.record({ type: "session.moved", workspaceId, sessionId: resume ?? turnId, turnId, threadId, from: movedFrom, to: cwd, ...(entry.record.worktree.branch !== undefined ? { branch: entry.record.worktree.branch } : {}), ...(fresh ? { fresh: true as const } : {}) });
          if (fresh) {
            resume = undefined;
            delete view.claudeSessionId;
          }
        }
        const picks = picksFor(resume);
        const afterCut = resume !== undefined && ctx.cutBefore(workspaceId, threadId);
        // What the trips above settled, onto the row the start wrote: the reads that decide them are behind us, so
        // none of them can be answered from the row they are about. Written before adapter.start, so events that
        // fire synchronously inside start() land on the same view.
        Object.assign(view, picks, cwd !== undefined ? { cwd } : {}, resume !== undefined ? { claudeSessionId: resume } : {});
        // A rewind's cut rides the first resume after it, on a harness that takes one there.
        const cutAt = resume !== undefined && adapter.resumesAt === true ? threadRecords.get(threadId)?.resumeAt : undefined;
        const handed = attachedFilesPrompt(o.prompt, filePaths);
        // What a launch fixes for the life of the agent's process: a turn runs on the thread's kept process only where
        // its own launch would be the same, and a rewind's cut is a launch of its own.
        const launchKey: KeptLaunch | undefined =
          ctx.moduleOf(entry.record.kind).keepsAgents && cutAt === undefined
            ? {
                fixed: JSON.stringify({ harness, cwd, mcpServers: o.mcpServers, version: catalog?.version, setup: ctx.setupPlace(entry) === undefined ? undefined : setups.launchOf(ctx.setupPlace(entry)!, harness) }),
                // A pick filled in from the thread's own last turn is the one its kept process already runs at, so only
                // what this send named is held against the process; the fill stands for a cold launch.
                picks: Object.fromEntries(
                  Object.entries({ ...picks, ...(o.contextWindow !== undefined ? { contextWindow: o.contextWindow } : {}) }).filter(
                    ([pick]) => !(resume !== undefined && ((pick === "model" && opened.model === undefined) || (pick === "effort" && opened.effort === undefined) || (pick === "contextWindow" && own.contextWindow !== undefined))),
                  ),
                ),
              }
            : undefined;
        const kept = ctx.takeKept(threadId, launchKey, resume);
        // The kept process carries the token and the device its first turn was launched with; this send's go unused.
        if (kept !== undefined) dropScope();
        const promptAfter = promptsLate && snapshot?.from instanceof Promise ? snapshot.from.then(() => {}) : undefined;
        keptTaken = kept;
        const handle = ctx.runTurn({
          entry,
          view,
          threadId,
          turnId,
          ...(notify !== undefined ? { notify } : {}),
          ...(notifyBy !== undefined ? { notifyBy } : {}),
          ...(notifyRoad !== undefined ? { notifyRoad } : {}),
          turnToken: kept?.turnToken ?? turnToken,
          outcome,
          ...((): { scopeDeviceId?: string } => {
            const device = kept !== undefined ? kept.scopeDeviceId : scoped?.deviceId;
            return device !== undefined ? { scopeDeviceId: device } : {};
          })(),
          ...(launchKey !== undefined ? { keep: { launch: kept?.launch ?? launchKey } } : {}),
          opening: { prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}), ...(o.via !== undefined ? { via: o.via } : {}), ...(afterCut ? { afterCut } : {}), ...(opens ? { opensThread: true } : {}), ...(title !== undefined ? { title } : {}), ...(records.length > 0 ? { attachments: records } : {}) },
          asked: { prompt: handed, ...(picks.effort !== undefined ? { effort: picks.effort } : {}), ...(handed !== o.prompt ? { typed: o.prompt } : {}) },
          ...(imagesDir !== undefined ? { imagesDir } : {}),
          ...(snapshot !== undefined ? { snapshot } : {}),
          ...(resume !== undefined ? { resume } : {}),
          ...(cutAt !== undefined ? { cutAt } : {}),
          waiting: kept?.waiting ?? waiting,
          open: onEvent =>
            kept !== undefined
              ? kept.agent.next({ prompt: handed, ...(images.length > 0 ? { images } : {}), ...(promptAfter !== undefined ? { after: promptAfter } : {}), onEvent })
              : adapter.start({
              prompt: handed,
              ...(resume !== undefined ? { resume } : {}),
              ...(cutAt !== undefined ? { resumeAt: cutAt } : {}),
              ...(cwd !== undefined ? { cwd } : {}),
              ...picks,
              ...(o.contextWindow !== undefined ? { contextWindow: o.contextWindow } : {}),
              ...(title !== undefined ? { title } : {}),
              ...(images.length > 0 ? { images } : {}),
              ...(mcpServers !== undefined ? { mcpServers } : {}),
              ...(limitDetails ? { limitDetails: true as const } : {}),
              ...(promptAfter !== undefined ? { promptAfter } : {}),
              ...(launchKey !== undefined ? { keep: true as const } : {}),
              ...(catalog?.source === "harness" && catalog.version !== null ? { version: catalog.version } : {}),
              // The thread's earlier turns as its transcript holds them, this one left out since its message follows.
              ...(resume !== undefined ? { seed: async () => threadSeed(threadMessages((await ctx.openTranscript(workspaceId)).filter(e => e.turnId !== turnId), threadId)) } : {}),
              onEvent,
            }),
        });
        handedOver = true;
        void ctx.keepSentImages(workspaceId, threadId, o.requestId, o.attachments ?? []);
        // The thread's record, written at its first turn from what that turn runs at, once the turn is under way so a
        // launch that never opened leaves none; a thread from before the record existed gets one here too, off what
        // its rows said this turn runs at, so it is read the one way from now on. Persisted with the row as the turn
        // announces itself and at its end.
        if (!threadRecords.has(threadId)) threadRecords.set(threadId, { workspaceId, harness, ...(picks.permissionMode !== undefined ? { permissionMode: picks.permissionMode } : {}) });
        const thread = threadRecords.get(threadId)!;
        if (filesFolder !== undefined && !(thread.filesIn ?? []).includes(filesFolder)) threadRecords.set(threadId, { ...thread, filesIn: [...(thread.filesIn ?? []), filesFolder] });
        launched();
        // The turn is running; what the record failed to remember must not read as a start that failed.
        if (resume === undefined) await ctx.rememberTarget(entry.record).catch((e: unknown) => console.warn(`last target for ${workspaceId} not remembered: ${e instanceof Error ? e.message : String(e)}`));
        return handle;
      } catch (e: unknown) {
        failure = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        if (!handedOver) {
          // The turn never reached a machine, so nothing out there is holding this token: it goes now rather than
          // standing until a host restart.
          dropScope();
          if (held) {
            sessions.delete(turnId);
            // Whoever the row told this thread was working must not be left waiting for a turn that never opened, so
            // its end goes out. On the bus alone and not through record: no turn ran, and a transcript that held an
            // end with no start behind it would be read as the thread's latest turn by every reader that folds those
            // rows, which is what the reply, the read and the wait itself all come off. Nothing goes out where the
            // road out named no reason, which is the message the thread's running turn took instead, nor where the
            // thread is still working: the turn that is running is the one a wait here is waiting on.
            if (failure !== undefined && !ctx.threadRuns(threadId)) {
              bus.emit({ type: "session.end", workspaceId, sessionId: view.id, turnId, threadId, exitCode: null, sawResult: false, reason: failure, at: Date.now() });
            }
          }
          // After the row is gone and its end is out, so a send that waited on it finds the thread as it now is.
          launched();
        }
        if (!handedOver && imagesDir !== undefined) ctx.dropImages(entry, imagesDir);
        // A kept process taken for a turn that never opened on it holds the thread's token with nobody to answer for it.
        if (!handedOver && keptTaken !== undefined) ctx.endKept(threadId, keptTaken);
      }
    },

    async list(workspaceId, origin) {
      await ctx.ready();
      // A listing that names a workspace refuses like any other verb naming one, unless a thread of the caller's
      // tree stands there; a listing of them all leaves out the rows the caller may not reach, as workspaces.list
      // leaves out the workspaces.
      if (workspaceId !== undefined && !ctx.treeStandsOn(workspaceId, origin)) ctx.refuseNamed(workspaceId, origin);
      const all = [...sessions.values()].filter(s => ctx.reachesRow(s.view, origin));
      const held = workspaceId === undefined ? all : all.filter(s => s.view.workspaceId === workspaceId);
      const rows = held.map(s => s.view);
      // A refresh is where a rename made inside the harness reaches us: nothing on this side changed. A row that
      // already carries a title is answered from the index and its read goes out unawaited, so a wedged guest
      // costs the listing nothing and the rename lands on the next refresh, which is the window the TTL promises.
      // A row with none blocks, so a thread is titled on the first listing that sees it.
      const asked = ctx.titleRows(rows).map(view => ({ first: view.harnessTitle === undefined, done: ctx.refreshTitle(view, false) }));
      await Promise.all(asked.filter(a => a.first).map(a => a.done));
      return ctx.listedRows(held);
    },

    async history(workspaceId, origin) {
      await ctx.ready();
      // A thread reads the transcript of a workspace its tree stands on, its lead's included, and of its own tree's
      // workspaces; any other it names reads as every workspace verb reads it, so it learns nothing by asking.
      if (!ctx.treeStandsOn(workspaceId, origin)) await ctx.entryOf(workspaceId, origin);
      return (await ctx.openTranscript(workspaceId)).filter(e => ctx.drivesThread(e.threadId, origin)).map(e => ({ ...e }));
    },

    async page(workspaceId, window, origin) {
      await ctx.ready();
      if (!ctx.treeStandsOn(workspaceId, origin)) await ctx.entryOf(workspaceId, origin);
      if (!ctx.drivesThread(window.threadId, origin)) return { events: [], pos: transcriptIndex.get(workspaceId)?.pos ?? 0, total: 0 };
      return ctx.transcriptReader.read(workspaceId, window.threadId, {
        ...(window.before !== undefined ? { before: window.before } : {}),
        limit: window.limit ?? HISTORY_PAGE_EVENTS,
        bytes: HISTORY_PAGE_BYTES,
      });
    },

    async head(threadId, origin) {
      await ctx.ready();
      const facts = ctx.threadFacts(threadId);
      if (facts === undefined || (await ctx.entryOfRow({ threadId: facts.threadId ?? threadId, workspaceId: facts.workspaceId }, origin)) === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      // The events take what the facts leave of the head's bytes, less the reply's own keys and numbers.
      const room = HEAD_BYTES - Buffer.byteLength(JSON.stringify(facts)) - 100;
      return { facts, ...(await ctx.transcriptReader.read(facts.workspaceId, facts.threadId ?? threadId, { limit: Infinity, bytes: room, strict: true, shape: headShape })) };
    },

    async attachment(workspaceId, threadId, requestId, index, origin) {
      await ctx.ready();
      if (!ctx.treeStandsOn(workspaceId, origin)) await ctx.entryOf(workspaceId, origin);
      await ctx.keptWrites.get(workspaceId);
      const key = attachmentKey(threadId, requestId, index);
      const held = key === undefined || !ctx.drivesThread(threadId, origin) ? undefined : ((await store.get(ATTACHMENT_KEYS, workspaceId)) as KeptImages | undefined)?.threads[threadId]?.find(k => k.key === key);
      const bytes = held === undefined ? undefined : await store.getBlob(ATTACHMENTS, held.key);
      if (held === undefined || bytes === undefined) throw notFoundRefusal(`no image ${index + 1} kept on that message`);
      return { mediaType: held.mediaType, bytes: bytes.toString("base64") };
    },

    async interrupt(sessionId, origin, task) {
      await ctx.ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      // One absence for every row a thread cannot reach, wherever it stands: a sentence about the workspace would
      // tell a thread which of the two rules hid the row.
      if ((await ctx.entryOfRow(s.view, origin)) === undefined) return { outcome: "not-found" };
      // One subagent of the turn, and nothing else: the threads under this one and the turn itself run on.
      if (task !== undefined) {
        if (s.view.status !== "running" || s.handle === undefined) return { outcome: "not-running" };
        const agent = ctx.agentLabel(s.view.harness);
        if (s.handle.stopTask === undefined) return { outcome: "unsupported", error: taskStopUnsupportedLine(agent) };
        const stopped = await s.handle.stopTask(task);
        if (stopped.outcome === "refused") return { outcome: "refused", error: taskStopRefusedLine(agent, stopped.error) };
        return stopped.outcome === "unsupported" ? { outcome: "unsupported", error: taskStopUnsupportedLine(agent) } : { outcome: stopped.outcome };
      }
      // A thread's agents spawned a tree under it, and a stop on the thread is a stop on the tree: the children go
      // first, so nothing under a stopped lead is left working for a thread that is no longer reading. The lead
      // itself may already be over, which is an answer and not a reason to leave its builders running. A child
      // that stops its lead stops its siblings and itself with it, and may never read the answer.
      const under = s.view.threadId === undefined ? [] : await ctx.stopUnder(s.view.threadId, origin);
      const answered = (outcome: SessionInterruptOutcome): SessionInterruptResult => ({ outcome, ...(under.length > 0 ? { under } : {}) });
      if (s.view.status !== "running" || s.handle === undefined) return answered("not-running");
      await s.handle.interrupt();
      // The harness resolves finished only after session.end, so accepted means the turn is over on the transcript too.
      await s.handle.finished.catch(() => {});
      return answered("accepted");
    },

    async steer(sessionId, o, origin) {
      await ctx.ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const entry = await ctx.entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      if (s.view.status !== "running" || s.handle === undefined) return { outcome: "not-running" };
      if (s.handle.steer === undefined) return { outcome: "unsupported" };
      const outcome = await s.handle.steer(o.prompt);
      if (outcome !== "accepted") return { outcome };
      ctx.recordSteer(s, sessionId, o);
      return { outcome: "accepted" };
    },

    async answer(sessionId, o, origin) {
      await ctx.ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const entry = await ctx.entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      if (s.handle?.answer === undefined) return { outcome: s.handle === undefined ? "gone" : "unsupported" };
      return { outcome: await s.handle.answer(o.askId, { optionId: o.optionId, ...(o.reason === undefined ? {} : { reason: o.reason }) }) };
    },

    async access(sessionId, permissionMode, origin) {
      await ctx.ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const entry = await ctx.entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      const { harness, adapter } = await ctx.launchAdapterFor(entry, s.view.harness);
      const table = harnessCatalog(harness);
      // Checked against the list the picker showed, so a mode this CLI does not take is refused in the same words a
      // start refuses it with rather than travelling to the machine as a request it will not answer.
      if (table !== undefined) startPicks(await ctx.catalogOn(table, entry, adapter), { permissionMode }, false);
      // The pick lands on the thread's record whatever the turn running now does with it: this is the one road that
      // changes a thread's access, and the thread's next turn runs at it. The thread's latest row says the same, as
      // every client folds the access off that row; a running turn's row moves where the harness took the pick,
      // and otherwise as the turn ends, so no row says a mode the thread's next turn will not run at.
      const threadId = s.view.threadId;
      const running = threadId === undefined ? (s.view.status === "running" && s.handle !== undefined ? (s as LiveSession) : undefined) : ctx.runningOn(threadId);
      const latest = threadId === undefined ? s.view : (ctx.latestOn(threadId) ?? s.view);
      const landed = (): void => {
        if (threadId !== undefined) threadRecords.set(threadId, { ...(threadRecords.get(threadId) ?? { workspaceId: s.view.workspaceId, harness: s.view.harness }), permissionMode });
        if (latest.status !== "running") latest.permissionMode = permissionMode;
        void ctx.persistSessions(s.view.workspaceId);
        ctx.pushHead(threadKeyOf(s.view));
      };
      if (latest.status !== "running") {
        landed();
        return { outcome: "set" };
      }
      // A CLI that refused a mode its own list carries is one that will not take it on a turn already under way and
      // whose adapter had no way to stand in for it, as is one that takes none at all: the turn keeps its mode and
      // the pick stands for the next turn, which is what unsupported tells the composer to say. A turn whose process
      // this host does not hold, still launching or re-opened without one, is one the pick cannot reach.
      const outcome = running === undefined ? "gone" : running.handle.setAccess === undefined ? "refused" : await running.handle.setAccess(permissionMode);
      landed();
      return { outcome: outcome === "set" ? "set" : outcome === "refused" ? "unsupported" : "not-running" };
    },

    async rename(sessionId, title, origin) {
      await ctx.ready();
      const named = title.trim();
      if (named === "") throw new Error(EMPTY_TITLE_LINE);
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const harnessSessionId = s.view.claudeSessionId;
      const entry = await ctx.entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "rename", entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      await ctx.copyBlocked(entry);
      const write = (await ctx.launchAdapterFor(entry, s.view.harness)).adapter.renameSession;
      if (write === undefined) return { outcome: "unsupported" };
      // The store is keyed by the harness's own id, so a thread whose harness never announced one has nothing to name.
      if (harnessSessionId === undefined) return { outcome: "no-session" };
      const wrote = await ctx.writeSession(harnessSessionId, () => write(harnessSessionId, named, command => entry.machine.exec(command, { timeoutMs: SESSION_TITLE_TIMEOUT_MS }).then(res => res.stdout)));
      // A store that refused the write says nothing about which sessions it has, so its own line travels as the answer.
      if (wrote.kind === "failed") return { outcome: "failed", error: wrote.error };
      if (wrote.kind === "no-session") return { outcome: "no-session" };
      // Every turn of the thread shares the harness's session, and the fold reads the latest turn's title. The name
      // is the person's, so a title the harness is still thinking about is thrown away when it lands.
      for (const row of sessions.values()) {
        if (row.view.workspaceId === entry.record.id && row.view.claudeSessionId === harnessSessionId) {
          row.view.harnessTitle = named;
          row.view.titleSource = "person";
        }
      }
      await ctx.persistSessions(entry.record.id);
      ctx.pushHead(threadKeyOf(s.view));
      return { outcome: "renamed" };
    },

    async read(threadId, origin) {
      await ctx.mark([threadId], { readAt: clock.now() }, origin);
    },

    async settle(threadIds, origin) {
      const at = clock.now();
      await ctx.mark(threadIds, { readAt: at, settledAt: at }, origin);
    },

    async mark(threadIds, marks, origin) {
      const at = clock.now();
      await ctx.mark(
        threadIds,
        {
          ...(marks.pinned !== undefined ? { pinnedAt: marks.pinned ? at : undefined } : {}),
          ...(marks.snoozedUntil === undefined ? {} : marks.snoozedUntil === null ? { snoozedUntil: undefined } : { snoozedUntil: marks.snoozedUntil, readAt: at }),
          ...(marks.section !== undefined ? { section: marks.section ?? undefined } : {}),
        },
        origin,
      );
    },

    async restore(threadIds, origin) {
      await ctx.mark(threadIds, { readAt: clock.now(), settledAt: undefined }, origin);
    },

    async search(query, origin) {
      await ctx.ready();
      const words = query.trim().toLowerCase();
      if (words === "") return { hits: [] };
      const found: { hit: SessionSearchResult["hits"][number]; last: number }[] = [];
      for (const [workspaceId, index] of transcriptIndex) {
        // The workspaces a caller reads the transcript of, by the rule history reads them by.
        if (!ctx.treeStandsOn(workspaceId, origin) && !(await ctx.entryOf(workspaceId, origin).then(() => true, () => false))) continue;
        for (const [threadId, { lines, last }] of index.words) {
          if (lines.length === 0 || !ctx.drivesThread(threadId, origin)) continue;
          // The snippet stays inside the one message that holds the words, so it never runs one message into the next.
          const text = lines.find(line => line.toLowerCase().includes(words));
          if (text !== undefined) found.push({ hit: { workspaceId, threadId, snippet: snippetAround(text, text.toLowerCase().indexOf(words), words.length) }, last });
        }
      }
      return { hits: found.sort((a, b) => b.last - a.last).map(f => f.hit) };
    },

    async aside(sessionId, question, origin) {
      await ctx.ready();
      if (question.trim() === "") throw new Error(BLANK_ASIDE_LINE);
      const s = sessions.get(sessionId);
      if (!s) throw notFoundRefusal(`no session ${sessionId}`);
      const entry = await ctx.entryOfRow(s.view, origin);
      if (entry === undefined) throw notFoundRefusal(`no session ${sessionId}`);
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      const latest = s.view.threadId === undefined ? s.view : (ctx.latestOn(s.view.threadId) ?? s.view);
      const servers = serverValuesOf(opts.vault?.() ?? {});
      const { harness, adapter: bare } = await ctx.launchAdapterFor(entry, latest.harness, undefined, undefined, servers);
      if (bare.aside === undefined) throw new Error(asideUnsupportedLine(harness));
      if (latest.claudeSessionId === undefined) throw new Error(ASIDE_NO_SESSION_LINE);
      const ask = { session: latest.claudeSessionId, question, ...(latest.cwd !== undefined ? { cwd: latest.cwd } : {}), ...(latest.model !== undefined ? { model: latest.model } : {}) };
      if (bare.asideServers !== true || bare.mcpServers !== true) return { text: (await bare.aside(ask)).text };
      // A copy that loads the thread's servers is launched with the thread's own wsp server and the pair it dials
      // with, since a harness resuming a session that announced a server it no longer has tells the model so, and the
      // answer opens on it. The harness keeps every tool off; the token goes back the moment the answer is in.
      const threadId = threadKeyOf(latest);
      const { scoped, env: launchEnv, wsp } = await threadLaunch(entry, threadId, ctx.rootOf(threadId), { aside: true });
      try {
        const { adapter } = ctx.adapterFor(entry, harness, launchEnv, undefined, servers);
        if (adapter.aside === undefined) throw new Error(asideUnsupportedLine(harness));
        return { text: (await adapter.aside({ ...ask, ...(wsp !== undefined ? { mcpServers: { [MCP_SERVER_NAME]: wsp } } : {}) })).text };
      } finally {
        if (scoped !== undefined) await deviceDoor.revoke(scoped.deviceId).catch((e: unknown) => console.warn(`the token of a side question on thread ${threadWord(threadId)} was not taken away: ${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async run(step, origin) {
      await ctx.ready();
      if (scopeOf(origin) !== undefined) throw new Error(RUN_PERSONS_LINE);
      const rows = [...sessions.values()].filter(s => s.view.threadId === step.threadId);
      const workspaceId = rows[0]?.view.workspaceId ?? threadRecords.get(step.threadId)?.workspaceId;
      if (workspaceId === undefined) throw notFoundRefusal(`no thread ${threadWord(step.threadId)}`);
      const entry = await ctx.entryOfRow({ threadId: step.threadId, workspaceId }, origin);
      if (entry === undefined) throw notFoundRefusal(`no thread ${threadWord(step.threadId)}`);
      // Read off the transcript rather than kept beside it, so an ending recorded before a restart still holds.
      for (const e of await ctx.openTranscript(workspaceId)) {
        if (e.type === "session.run" && e.runId === step.runId && e.state !== "running") return { ...e };
      }
      const latest = ctx.latestOn(step.threadId);
      const event: SessionRunEvent = {
        type: "session.run",
        workspaceId,
        sessionId: latest?.claudeSessionId ?? latest?.id ?? step.turnId,
        turnId: step.turnId,
        threadId: step.threadId,
        runId: step.runId,
        block: step.block,
        command: step.command,
        state: step.state,
        ...(step.ptyId !== undefined ? { ptyId: step.ptyId } : {}),
        ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
        ...(step.signal !== undefined ? { signal: step.signal } : {}),
        ...(step.output !== undefined ? { output: runOutputTail(step.output) } : {}),
      };
      ctx.record(event);
      return { ...event, at: Date.now() };
    },

    async rewind(threadId, opts, origin) {
      await ctx.ready();
      const rows = [...sessions.values()].filter(s => s.view.threadId === threadId);
      const held = threadRecords.get(threadId);
      const workspaceId = rows[0]?.view.workspaceId ?? held?.workspaceId;
      if (workspaceId === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      const entry = await ctx.entryOfRow({ threadId, workspaceId }, origin);
      if (entry === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      const conflict = (line: string): Error => Object.assign(new Error(line), { kind: "conflict" });
      // Every refusal comes before anything is written: nothing below this block moves a file or a row.
      if (rows.some(r => r.view.status === "running")) throw conflict(REWIND_WORKING_LINE);
      // A kept agent holds the conversation as it stood before the cut in its own memory.
      ctx.reapKept(threadId);
      const tree = ctx.treeUnder(threadId);
      const under = foldThreads([...sessions.values()].map(s => s.view).filter(v => v.threadId !== undefined && tree.includes(v.threadId)));
      const running = under.filter(t => t.status === "running");
      if (running.length > 0) throw conflict(rewindChildrenLine(running.map(t => t.title)));
      // The folder is every thread's on the record: files moved under one that runs would go back mid-turn.
      const besideRunning = (): void => {
        const beside = foldThreads([...sessions.values()].map(s => s.view).filter(v => v.workspaceId === workspaceId && v.threadId !== undefined && v.threadId !== threadId)).find(t => t.status === "running");
        if (beside !== undefined) throw conflict(rewindBesideLine(beside.title));
      };
      const cwd = ctx.checkoutOf(entry.record);
      const restore = (checkpoint: string) => ctx.queued(entry.record.id, () => ctx.withDaemon(entry, ask => ask({ op: "git.restore", cwd, checkpoint, scope: entry.record.id })));
      const done = async (): Promise<void> => {
        await ctx.persistSessions(workspaceId);
        await ctx.flushTranscript(workspaceId);
        bus.emit({ type: "thread.rewound", workspaceId, threadId });
      };

      if (opts.undo === true) {
        const rewound = held?.rewound;
        if (rewound === undefined) throw conflict(REWIND_NO_UNDO_LINE);
        besideRunning();
        const back = await restore(rewound.before);
        delete held!.rewound;
        // The slate follows the conversation, which undo never puts back: it stays as the rewind left it.
        await done();
        return { turns: 0, files: Number(back["files"] ?? 0) };
      }

      // A copy, read for the turns and their checkpoints alone: the cut below takes its own copy inside the queue.
      const events = [...(await ctx.openTranscript(workspaceId))];
      const order: string[] = [];
      for (const e of events) if (e.threadId === threadId && e.turnId !== undefined && !order.includes(e.turnId)) order.push(e.turnId);
      const at = opts.turnId === undefined ? -1 : order.indexOf(opts.turnId);
      if (at < 0) throw notFoundRefusal(`no turn ${opts.turnId ?? ""} on thread ${threadWord(threadId)}`);
      if (at === order.length - 1) throw conflict(REWIND_LATEST_LINE);
      const cut = order.slice(at + 1);
      const keptOf = (turnId: string): Extract<SessionEvent, { type: "session.checkpoint" }> | undefined => {
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i]!;
          if (e.type === "session.checkpoint" && e.turnId === turnId) return e;
        }
        return undefined;
      };
      const kept = keptOf(order[at]!);
      const latest = ctx.latestOn(threadId) ?? rows[0]?.view;
      const { harness, adapter } = await ctx.launchAdapterFor(entry, latest?.harness ?? held?.harness);
      const agent = harnessCatalog(harness)?.label ?? harness;
      let files = opts.files === true;
      if (files && kept?.ref === undefined) throw conflict(REWIND_NO_CHECKPOINT_LINE);
      // Files go back only where no other thread ran a turn in the folder after the checkpoint, running ones
      // included: otherwise the files hold that thread's work too, and the conversation alone goes back.
      const keptAt = kept?.at ?? [...sessions.values()].find(r => r.turnId === order[at])?.view.endedAt ?? 0;
      const shared = files && [...sessions.values()].some(({ view: v }) => v.workspaceId === workspaceId && v.threadId !== undefined && v.threadId !== threadId && (v.endedAt ?? Number.POSITIVE_INFINITY) > keptAt);
      if (shared) files = false;
      // A harness that said it cannot cut this thread keeps every turn: the files alone go back and it is not asked.
      const uncut = events.find((e): e is Extract<SessionEvent, { type: "session.checkpoint" }> => e.type === "session.checkpoint" && e.threadId === threadId && e.kept !== undefined)?.kept;
      if (uncut !== undefined && !files) throw conflict(shared ? REWIND_SHARED_LINE : rewindKeptLine(uncut, false));
      const cutsConversation = (adapter.resumesAt === true || adapter.revert !== undefined) && uncut === undefined;
      if (adapter.resumesAt === true && kept?.anchor === undefined) throw conflict(rewindNoAnchorLine(agent));
      if (!cutsConversation && !files) throw conflict(shared ? REWIND_SHARED_LINE : rewindNoAnchorLine(agent));

      // Files first, since they alone can be put back: a harness that then will not cut has them restored again and
      // the whole rewind refused, rather than a conversation cut over files that never moved.
      const moved = files ? await restore(kept!.ref!) : undefined;
      const before = moved === undefined ? undefined : String(moved["before"]);
      let keptWhy: string | undefined;
      if (adapter.revert !== undefined && cutsConversation && latest?.claudeSessionId !== undefined) {
        const firstCut = keptOf(cut[0]!)?.anchor;
        // A turn that named no anchor is found by count among the harness's own, off each cut turn's anchor and end.
        const endOf = (turnId: string): TurnResult | undefined => {
          for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i]!;
            if (e.type === "session.done" && e.turnId === turnId) return e.result;
          }
          return undefined;
        };
        const turnOf = (turnId: string): { anchor?: string; result?: TurnResult } => {
          const anchor = keptOf(turnId)?.anchor;
          const result = endOf(turnId);
          return { ...(anchor !== undefined ? { anchor } : {}), ...(result !== undefined ? { result } : {}) };
        };
        try {
          const answer = await adapter.revert({ session: latest.claudeSessionId, cwd, ...(firstCut !== undefined ? { beforeTurn: firstCut } : { turns: cut.map(turnOf) }) });
          keptWhy = answer?.kept;
        } catch (e) {
          if (before !== undefined) await restore(before).catch((back: unknown) => console.warn(`the files of thread ${threadWord(threadId)} were not put back after a refused rewind: ${back instanceof Error ? back.message : String(back)}`));
          throw e;
        }
      }
      const record = held ?? { workspaceId, harness };
      threadRecords.set(threadId, record);
      if (adapter.resumesAt === true) record.resumeAt = kept!.anchor!;
      if (before !== undefined) record.rewound = { before, at: clock.now() };
      if (keptWhy !== undefined) {
        await done();
        throw conflict(rewindKeptLine(keptWhy, before !== undefined));
      }
      if (cutsConversation) await ctx.dropFromTranscript(workspaceId, e => e.threadId === threadId && cut.includes(e.turnId ?? ""));
      await ctx.slates.rewound({ threadId, turnId: order[at]!, cut });
      await done();
      return { turns: cutsConversation ? cut.length : 0, ...(moved !== undefined ? { files: Number(moved["files"] ?? 0) } : {}), ...(shared ? { kept: REWIND_SHARED_LINE } : {}) };
    },

    async delete(threadId, origin) {
      await ctx.ready();
      ctx.spawnGuard("delete", origin);
      const workspaceId = [...sessions.values()].find(s => s.view.threadId === threadId)?.view.workspaceId ?? threadRecords.get(threadId)?.workspaceId;
      if (workspaceId === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      const entry = await ctx.entryOfRow({ threadId, workspaceId }, origin);
      if (entry === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      if (!copiesFolder(entry.record.kind)) throw Object.assign(new Error(threadOnMachineLine(entry.record.name)), { kind: "usage" });
      const tree = entry.record.worktree;
      if (tree?.made === true && tree.gone !== true) {
        // Every thread in it goes with the worktree, so none may be working, and none can land a checkpoint after
        // its refs were dropped.
        if (ctx.turnRuns(workspaceId)) throw Object.assign(new Error(WORKTREE_BUSY_LINE), { kind: "conflict" });
        const threads = new Set([...sessions.values()].flatMap(s => (s.view.workspaceId === workspaceId && s.view.threadId !== undefined ? [s.view.threadId] : [])));
        await ctx.workspaces.delete(workspaceId, origin);
        return { workspaceId, worktree: tree.path, threads: threads.size };
      }
      if (ctx.threadRuns(threadId)) throw Object.assign(new Error(THREAD_WORKING_LINE), { kind: "conflict" });
      ctx.reapKept(threadId);
      await ctx.openTranscript(workspaceId);
      await ctx.dropCheckpoints(entry, threadId);
      await ctx.dropThreadFiles(entry, [threadId]);
      await ctx.dropSentImages(workspaceId, [threadId]);
      for (const [id, s] of [...sessions]) if (s.view.threadId === threadId) sessions.delete(id);
      threadRecords.delete(threadId);
      await ctx.dropFromTranscript(workspaceId, e => e.threadId === threadId);
      await ctx.persistSessions(workspaceId);
      await ctx.slates.forget(threadId);
      return { workspaceId, threads: 1 };
    },

    async forget(threadId, origin) {
      await ctx.ready();
      const held = [...sessions].filter(([, s]) => s.view.threadId === threadId);
      const record = threadRecords.get(threadId);
      const workspaceId = held[0]?.[1].view.workspaceId ?? record?.workspaceId;
      if (workspaceId === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      // The same absence a name nothing holds gets: a sentence of its own would tell a thread of another tree that
      // the thread it named is there, and the refusal past this gate says its turn ran.
      const entry = await ctx.entryOfRow({ threadId, workspaceId }, origin);
      if (entry === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      // A record is written once a turn was handed over, so a thread with a record and no row left is one whose
      // turns ran and fell off the index cap; the rows alone would read it as a thread that never ran.
      if (threadRan(held.map(([, s]) => s.view)) || (held.length === 0 && record !== undefined)) throw Object.assign(new Error(threadForgetRefusal(threadId)), { kind: "conflict" });
      // A transcript that does not read refuses here, before anything is changed.
      await ctx.openTranscript(workspaceId);
      // A launch that never got going can still have landed the files its send carried.
      await ctx.dropThreadFiles(entry, [threadId]);
      await ctx.dropSentImages(workspaceId, [threadId]);
      for (const [id] of held) sessions.delete(id);
      threadRecords.delete(threadId);
      await ctx.slates.forget(threadId);
      await ctx.dropFromTranscript(workspaceId, e => e.threadId === threadId);
      await ctx.persistSessions(workspaceId);
    },
  };
  return { sessionsApi };
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
