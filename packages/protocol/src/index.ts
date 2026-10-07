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
export * from "./wire/events-union.js";
export * from "./wire/daemon.js";
export * from "./wire/machine-link.js";
export * from "./wire/daemon-version.js";
export * from "./views/place-setup-words.js";
export * from "./wire/daemon-events.js";
export * from "./wire/devices.js";
export * from "./wire/place-link.js";
export * from "./wire/runtime.js";
export * from "./views/snapshot-lineage.js";

export { hereName, isHere, isProviderPlace, placeName, placeOf, workspaceComputerName } from "./place-name.js";
export { needsYouLine, subagentStateWord, threadNeedsYou, threadSeen, threadSettled, threadState, threadStateWord, threadUnread, threadUnseenAt, threadWordOf, waitingLine, type SettleFacts, type ThreadState } from "./thread-state.js";
export { AGENTS_ON, CLOUD_CAP_DEFAULT, NAP_AFTER_MAX_MS, NAP_AFTER_MS, phaseHoldsSlot, placeAtLimitLine, placeCapOf, placeFullLine, placeSetRefusal, placeSettingDropped, placeSettingNamed, placeSettingsLine, placeTakes, settingFor, napMsOf, placeRoom, placeSpendLimit, runningOn, THREAD_MEM_MB, threadsAtOnce, workspacePlace, workspacePlaceId, type PlacedThread, type PlacedWorkspace, placeTurnLimit, TURN_LIMIT_MAX_MS, TURN_WALL_MS, turnLimitMsOf } from "./place-state.js";
export { launchHasSlate, MCP_SERVER_NAME, SLATE_BRIEF, SLATE_SERVER_NAME, SLATE_TOOLS, threadsFollowed, WSP_TOOL_TIMEOUT_SEC } from "./wsp-tools.js";
export { type AbsentComputer, type AwayWord, absentComputer, actionRefusal, daemonSilent, ownDaemonDown, START_DAEMON_WORD, agentsKindRefusal, agentsMayDrive, awayMsOf, composerHeldLine, type CopyToDelete, deleteCopiesNotice, deleteNotice, unpushedLine, onDeleteOf, type StandsOn, UNNAMED_COMPUTER, goneRefusal, COMPUTER_LEFT, pausedOrPausing, notAnsweringYet, screenCommandLine, type ImageMoveInput, imageMoveRefusal, isBilling, isLocalWorkspace, turnSpendWord, type KindReading, kindWords, readingRoad, type ReadingRoad, type MachineOnDelete, machineWord, needsRebuild, FORGET_NEEDS_GONE, goneRoadRefusal, reachShown, SEND_BLOCK_WORDS, type SendBlock, sendRefusal, signInRefusalLine, signInRoad, signedOutLine, type SendRefusalKind, servesReading, WORKSPACE_KIND_WORDS, workspaceKind, type WorkspaceKindWords, workspaceState, type WorkspaceState, type WorkspaceStateInput, whereWord, workspaceStateLine, workspaceStateOf, workspaceWord, type AbsentRoad, type AbsentRoadInput, absentRoad, BACK_OVER_SSH, backUrl, dialsBackWord, linkedOver, lastKnown, REPORTED_WORD, placeDialLine, placeNoDialLine, placeDialRoad, sshRoadOf, type PlaceDialRoad } from "./workspace-state.js";
export * from "./agents-report.js";
export * from "./project-look.js";
export { contextWindowsFor, effortsFor, everyModel, keptPicks, listedPick, markedDefault, modelOf, modelPicks, recordedPicks, type RanPicks } from "./harness-picks.js";
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
export { ENV_FROM_INPUT, inFolder, shellLine, shellQuote } from "./shell-quote.js";
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
export { claudeMemoryDir, claudeProjectKey, folderName, folderSlug, heldPlaceScript, hiddenFolder, parentFolderName, placeDaemonPaths, placeOwnedPaths, placeProvisionPaths, probePath, repoPathOf, rootsPathIn, worktreeOf, SSH_ALIAS_PREFIX, sshAlias, standInMachinePath, standInRecordsPath, underProject, workFolderIn, type FolderMachine } from "./project-path.js";
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
export type { AdapterAttachOptions, AdapterEvent, AgentLaunch, AsideAnswer, AsideQuestion, AttachmentRoad, CommitDrafter, DraftAsk, ExecStream, ExecStreamFactory, HarnessCatalogAnswer, HarnessExec, HarnessCatalogModelProbe, HarnessCatalogProbe, HarnessCatalogRefusal, PermissionAsk, PlanResets, ResetReading, ResetRoad, ResetSpend, SessionAsker, SessionRenameWrite, SessionRenamer, SessionTitleMaker, SessionTitleReader, TaskStop, TitleTurn, TurnImage, SessionReverter } from "./adapter-port.js";
export * from "./slate/wire.js";
