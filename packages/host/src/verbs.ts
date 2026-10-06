// SPDX-License-Identifier: AGPL-3.0-only
// The verbs a person or a local agent runs beside the app: thin clients of
// the host's protocol on localhost, authenticated with the token the host
// wrote to the state dir. One verb table with two doors on every entry: the
// command line (its usage, its flags, a run from the parsed line to an exit
// code) and the MCP tool (its description, the zod shape it takes and answers,
// a call from the parsed arguments to a result). The parser, the help and the
// tool list all read the table, so a verb is added in one place. Nothing here
// reads a key or imports the runtime: the host is the only process that talks
// to the provider.
import { homedir, hostname, platform } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { connect as connectTcp } from "node:net";
import { Transform, type Readable, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { z } from "zod";
import { CATALOG_AGENTS, ROAD_MODULES, THREAD_AGENTS, agentName, catalogEntry, isRoad } from "@wsp/catalog";
import { nodeHost, readGhosttyConfig, type Platform } from "@wsp/collect";
import { freshEphemeral, keyFingerprint, makeSeal, openFrame, sealKeys, sharedSecret, signPlaceBytes, verifyPlaceBytes, SEAL_REFUSAL, type PlaceKeyPair, type Seal } from "@wsp/keys";
import {
  AccessChoice,
  AgentSetupView,
  ThreadDefaults,
  accessWordRefusal,
  pickRefusal,
  accessWordsLine,
  agentEnvRefusal,
  ENV_REFUSED_FIX,
  configDirSignInLine,
  EnvName,
  AgentDefaults,
  type AgentDefaultsPatch,
  type AgentSetupSet,
  type ModelPicker,
  type ProjectOverridesPatch,
  AFTER_CUT_LINE,
  LOOPBACK,
  SSH_ALIAS_PREFIX,
  sshAlias,
  COORDINATOR_HANDOFF,
  EMPTY_MESSAGE_LINE,
  EXIT_CODES,
  HOST_STOPPING_CLOSE,
  HOST_CLOSED_LINE,
  HOST_STOPPING_LINE,
  NOT_DELIVERED_LINE,
  fmtDuration,
  HostFolderListing,
  AgentRow,
  AgentsReport,
  AgentsTarget,
  McpRow,
  McpScope,
  commandWords,
  unclosedQuoteRefusal,
  McpTool,
  ServerToolsAnswer,
  SkillAdded,
  SkillHit,
  SkillPreview,
  SkillRow,
  SKILL_PREVIEW_BYTES,
  agentSignInWord,
  InitSetup,
  initSetupLines,
  FILES_MAX,
  FILE_MAX_WORDS,
  IMAGE_ALREADY_NEWEST,
  IMAGE_MAX_WORDS,
  IMAGE_MOVE_CONFIRM,
  IMAGE_TYPE_WORDS,
  LOGIN_CHOICES,
  NOTIFY_CALLER,
  NOTIFY_ME,
  NOTIFY_WORDS,
  ANOTHER_AGENT_WORDS,
  PLACE_LINK_NONCE_BYTES,
  SEAL_CLIENT,
  SealOpenReply,
  deviceAuthOldHostLine,
  pairKeyRefusal,
  placeLinkTranscript,
  ProjectExportResult,
  ProjectGolden,
  ProjectGoldenRemoved,
  SealedImage,
  SealedImageBuilt,
  SealedImageCopy,
  SealedImageView,
  SealedProjectImage,
  NO_SEALED_IMAGE,
  IMAGE_PASSPHRASE_ENV,
  IMAGE_PASSPHRASE_MIN,
  GOLDEN_STAGE_WORDS,
  sealedBuiltLine,
  sealedCopyLine,
  sealedPinLine,
  sealedExportLine,
  sealedImageLine,
  sealedProjectLine,
  noProjectImageLine,
  projectImageRemoveNotice,
  projectImageRemovedLine,
  type GoldenStageEvent,
  type SealedImageExport,
  ProjectImportResult,
  PlaceView,
  PlaceSettingWord,
  placeSettingsLine,
  NAP_AFTER_MAX_MS,
  napMsOf,
  TURN_LIMIT_MAX_MS,
  turnLimitMsOf,
  type PlaceSettingsAsk,
  ProjectPlan,
  RECIPE_TICKS,
  RecipeTick,
  SessionInterruptOutcome,
  SessionInterruptResult,
  SessionRenameOutcome,
  SessionRenameResult,
  SessionStartOutcome,
  SessionStartResult,
  type SessionSteerEvent,
  TURN_END_WORDS,
  TerminalConfig,
  TerminalScheme,
  ThreadMessage,
  ThreadHead,
  ThreadView,
  TurnStatus,
  UpgradeResult,
  WorkspaceAgents,
  type WorkspaceKind,
  WorkspaceListing,
  WorkspaceOut,
  WorkspaceView,
  actionRefusal,
  agentsKindRefusal,
  agentsLine,
  agentsMayDrive,
  authRefusal,
  authority,
  canTravel,
  defaultAgents,
  defaultConsent,
  deleteNotice,
  onDeleteOf,
  execFolderLine,
  folderLevelLine,
  fmtBytes,
  plural,
  fmtThreads,
  foldThreads,
  threadWordOf,
  subagentStateWord,
  foreignFlagLine,
  forgetNotice,
  goldenHead,
  goneRefusal,
  goneRoadRefusal,
  guestNamesWorkspaceLine,
  guestNoFileLine,
  imageKeptLine,
  attachmentLine,
  imageTypeOf,
  filesRefusal,
  importConsented,
  importRequest,
  type MachineOnDelete,
  type StandsOn,
  UNNAMED_COMPUTER,
  machineWord,
  needsRebuild,
  noAdapterLine,
  noMessagesLine,
  noReplyLine,
  noWorkspaceRefusal,
  notFoundRefusal,
  needsYouLine,
  openAsk,
  askingLine,
  type PermissionEffect,
  type PermissionOption,
  type SessionAnswerOutcome,
  SessionAnswerResult,
  type SessionPermissionEvent,
  notAFileLine,
  type NotifyLength,
  notifyLine,
  notifyTail,
  offeredSize,
  sayOnce,
  secretOffer,
  secretSignalsLine,
  sizeFromWord,
  sizeRefusal,
  startPicks,
  stillWorkingLine,
  terminalConfigLines,
  threadMessages,
  threadReplyRows,
  threadReadText,
  threadResult,
  threadStateWord,
  toolActivityLine,
  toolAnsweredLine,
  turnSettledLine,
  turnTokenOf,
  unknownAgentLine,
  usageRefusal,
  validatorRefusal,
  verbFailure,
  problemListsOf,
  waitTimedOutLine,
  workspaceAsleepAgainLine,
  workspaceKind,
  workspaceState,
  workspaceStateLine,
  type PauseMode,
  workspaceStateOf,
  workspaceStaysAwakeLine,
  type Capabilities,
  type ExecEvent,
  type GoldenManifest,
  type HarnessCatalog,
  type Attachment,
  type StartPicks,
  UNTYPED_FILE,
  type ProjectExportEvent,
  type ProjectImportEvent,
  type ProjectImportRequest,
  type SessionEvent,
  type SessionOrigin,
  type SessionView,
  type TurnRefusal,
  type TurnResult,
  type WorkspaceCreateResult,
  type WorkspaceCreatingEvent,
  Preferences,
  WorkspaceProject,
  type WorkspaceSize,
  type WorkspaceState,
  homeShortened,
  BRANCH_HERE_ONLY_LINE,
  HOST_TOKEN_ENV,
  threadDeleteQuestion,
  localFolderRefusal,
  localWorktreeRefusal,
  threadDeletedLine,
  WorktreeMade,
  worktreeRemovedLine,
  noImportRoadLine,
  noThreadTargetLine,
  projectsInPlace,
  registerTakesNoConsentLine,
  shellQuote,
  fmtPrice,
  threadOpenedLine,
  threadWithoutIdRefusal,
  threadWord,
  ProjectView,
  addedProjectLine,
  computerNamed,
  copyTakesNone,
  copiesFolder,
  kindForComputer,
  computerKindWord,
  MEMORY_KEPT_CLAUSE,
  noSuchProjectLine,
  sourceKind,
  sourceWord,
  HERE_PLACE_ID,
  isLocalWorkspace,
  threadOnMachineLine,
  turnSpendWord,
  agentsCell,
  placeDaemonBehind,
  absentComputer,
  placeRoom,
  placeSpendLimit,
  placeStateOf,
  PlaceSpend,
  RecipeView,
  RECIPE_KINDS,
  NO_RECIPE,
  type RecipeFile,
  setupWord,
  pendingWord,
  PENDING_STEP_WORDS,
  PendingComputer,
  AddLine,
  PlaceWait,
  spendMeterWord,
  namesPlace,
  noSuchPlaceRefusal,
  placeForksNowhereLine,
  localRunsOneFix,
  localRunsOneLine,
  packageOf,
  addToolsHereRefusal,
  SignInLine,
  THIS_COMPUTER,
  type SealedPin,
  escapeC1,
  jsonLine,
  withoutControlChars,
  CommitDraft,
  GitCommitReply,
  GitDiscardReply,
  committedLine,
  discardedLine,
  FIX_RESULT_FIELDS,
  FixResult,
  FIX_CHECK_OR_CHILD,
  MergeInResult,
  fixMergeChildLine,
  mergeInLine,
  GitUpdateReply,
  MergeMethod,
  MergeResult,
  fixAskedLine,
  fixConflictsLine,
  fixNothingLine,
  mergedLine,
  updateConflictsLine,
  updatedLine,
  isProviderPlace,
  providerKeyName,
  ReviewPostResult,
  START_WORDS,
  StartResult,
  type ReviewVerdict,
  AccountRow,
  UsageRange,
  UsageSplit,
  UsedAnswer,
  USAGE_RANGES,
  USAGE_SPLITS,
  USAGE_WORDS,
  accountState,
  creditsWord,
  listWords,
  noSuchAccountLine,
  ResetAnswer,
  resetQuestion,
  fmtTokens,
  freshIn,
  usedPrice,
  windowCell,
  type LimitKind,
  SLATE_TOOLS,
} from "@wsp/protocol";
import type { CliIO } from "./cli.js";
import { relaySignIn, targetLink, type BoxSignedIn } from "./place-signin.js";
import type { RelayTerminal } from "./signin-relay.js";
import { gitRootOf, mainWorktreeOf } from "./repo-root.js";
import { CLOUD_ON } from "./cloud.js";
import { cloudText } from "./skill.js";
import { dialAddress, heldOrStarted, hostTokenFor, hostTokenPath, POLL_MS, SERVICE_WAIT_MS, servingHost } from "./host-lock.js";
import type { HostStarter } from "./host-start.js";
import { addressNotPairedLine, aimAddress, aimHolds, aimName, aimedHost, deviceRefusedLine, dialWindowMs, hostSideOnlyFix, hostSideOnlyLine, noAnswerRefusal, noAnswerWithin, READ_THE_HOSTS, stateIgnoredLine, wsUrlOf, wspHome, writeHost, type HostAim, type HostPick } from "./hosts.js";
import { readDeviceKeyPair } from "./account.js";
import { colourDepth, isTTY, wrap } from "./init-layout.js";
import { watchBlock, watchOn, type WatchSignals } from "./watch.js";
import { RecipeAnswer, RecipeScan, recipePrintout, scanPrintout } from "./recipe-answer.js";
import { isRecipeTick, runRecipe, runScan, type ScanInput } from "./recipe-command.js";
import { historyCache, smallRecipePath } from "./recipe-file.js";
import { addComputer } from "./setup-follow.js";
import { type HostClient, dialHost, HOST_RESTARTING_LINE, hostBack, formatter, hostPlatform, computerLines, followLine, recipeLines, recipeShownLines, recipeSavedLine, recipeRemovedLine, oneOf, readUsage, accountNamed, usageTableLines, readComputers, SETTING_RESETS, setComputer, napAsked, turnLimitAsked, dollarsAsked, table, type Flags, type VerbDeps, type VerbContext, usageIs, tool, type Page, optionalValues, type CliVerb, type CliOnlyVerb, type Verb, hasTool, COMMON, PICK_FLAGS, PICK_OPTIONS, SEND_OPTIONS, flag, flagList, absolutePath, absoluteFolder, openedThreadLine, pick, failed, jsonAsked, hostSchemaRefusal } from "./verbs/client.js";
import { workspaces, threads, workspaceOf, threadOf, threadsOf, threadRows, pauseModeOf, stateLine, wokeLine, nap, rebuild, rebuiltLine, imageView, buildImageAt, imageLines, HOST_SIDE_VAULT, SSH_PIPES_HERE_LINE, sshWorkspaceOf, pipeBytes, imagePassphrase, moveImage, imageMovedLine, renameWorkspace, renamedWorkspaceLine, awake, committed, askedToFix, mergedIn, fixLine, startedFrom, reviewStarted, reviewPosted, startedLines, VERDICTS, mergedPr, updateLine, napAfterDeadLaunch, withLine, stop, stopLine, forgetThread, threadForgotLine, rename, renameLine, madeWorktree, dropping, deleting, forgetQuestion, forget, forgotLine, deleteQuestion, imageRemoveQuestion, deleteWorkspace, deletedLine, THREAD_HEAD, threadLines, threadTree, placeNames, projectsOf, projectOf, projectLine, NO_PROJECT_YET, createFor, agentsAsked, countAsked, projectImageOf, removeProjectImage, setAgents, snapshot, projectGoldenLine } from "./verbs/workspaces-help.js";
import { type Turn, pickFlags, checkedStart, runTarget, threadHere, refuseMachineThread, threadDeleted, worktreeFor, openingOf, notifyOf, messageTo, startDetached, follow, waitThrough, hostRestartedLine, restartHost, readThread, readLine, threadHead, headLine, turnFailure, type AnswerRoad, ANSWER_ROADS, answerOpenAsk, followVerb, beforeSending, detachVerb, turnView } from "./verbs/turns-help.js";
import { execOn, type ExportRequest, exportProject, withReplaceHint, agentsFlag, confirmed, QUIET, QUIET_LINE, QUIET_TURN, Created, SEND_MEETS, TurnOut, WaitOut, ThreadRowOut, Argv, asJson, asText, turnText, detachedOut, waitAnswer, timeoutFlag, turnOut, WorkspaceIn, AgentIn, NotifyIn, RunProjectIn, BranchIn, RunCwdIn, CwdIn, DetachIn, TitleIn, FilesIn, FastIn, ConfirmIn, ACCESS_IN_WORDS, PICK_INPUTS, SEND_INPUTS, SizeIn, SpawnIn, MaxMachinesIn, MaxDepthIn, AGENTS_ASKED_NOTHING_LINE, agentsToolAskedNothing, PROJECT_FOLDERS, WEIGH_BY_FOLDERS, projectFolders, schemeFlag, projectsFlag, progress, printTable, hostFolders, initSetup, folderLines, REASON_FLAG } from "./verbs/io.js";
import { drawRows, aimedUsage, agentsTarget, projectAsked, toolsProject, agentsReport, AGENTS_FRAME, reportFacts, agentRowLines, skillRowLines, serverRowLines, toolLines, serverToolsOf, serverChanged, serverValues, serverCommand, serverScope, ServerNameIn, ServerAgentIn, ServerScopeIn, ServerProjectIn, SERVER_CHANGE_WORDS, SERVER_TOOLS_WORDS, toolsAddedLine, addTools, signInHere, signedInLine, searchSkillsSh, skillHitLines, skillShown, shownText, skillAdded, isInLine, addedLine, goneFromLine, turnedInLine, removedLine, skillChanged, turnedLine, SkillNameIn, SkillProjectIn, SKILL_CHANGE_WORDS, AGENT_SET_RESETS, PROJECT_SET_RESETS, AGENT_SETUP_RESETS, agentDefaultsSet, agentDefaultsLine, defaultAgentSet, defaultAgentLine, envNameOf, agentSetupSet, agentSetupLines, projectDefaultsOf, projectDefaultsSet, newThreadsHeadLine, threadDefaultsLines, defaultsCell, AgentsWorkspaceIn, AgentsOnIn, AGENTS_ON_WORDS, AGENTS_READ_WORDS } from "./verbs/agents-help.js";
export * from "./verbs/client.js";
export * from "./verbs/workspaces-help.js";
export * from "./verbs/turns-help.js";
export * from "./verbs/io.js";
export * from "./verbs/agents-help.js";

/** The lines another terminal answers a thread's open prompt with, one per road that carries a verb: the same op the
 * app's buttons send, by thread id, so a person or an agent watching a thread from anywhere can unstick it. */
const ANSWER_VERBS: readonly CliVerb[] = ANSWER_ROADS.filter((road): road is AnswerRoad & { answer: NonNullable<AnswerRoad["answer"]> } => road.answer !== undefined).map(road => ({
  name: `thread ${road.answer.verb}`,
  usage: `wsp thread ${road.answer.verb} <thread>${road.answer.reasons === true ? ' [--reason "<words>"]' : ""}`,
  about: road.answer.about,
  page: "agent" as const,
  options: road.answer.reasons === true ? REASON_FLAG : {},
  run: async (ctx: VerbContext) => {
    const [ref] = ctx.args;
    if (ref === undefined || ctx.args.length !== 1) throw usageRefusal(`wsp thread ${road.answer.verb} takes one thread.`, usageIs(ctx));
    const answered = await answerOpenAsk(await ctx.client(), ref, road, flag(ctx.flags, "reason"));
    ctx.out.emit({ threadId: answered.threadId, askId: answered.askId, optionId: answered.optionId }, answered.line);
    return 0;
  },
  tool: tool({
    description: `${road.answer.about[0]!.toUpperCase()}${road.answer.about.slice(1)}, by thread id or a prefix of it. A thread stopped on a prompt reads Needs you in threads and runs nothing until somebody picks, so this is how a thread you did not open is unstuck; the prompt itself is on the thread's own rows, which thread_read prints. Refused in one line when the thread is waiting on no prompt and when the prompt it is stopped on carries no such answer, which is what a call that asks the person something rather than for consent does.`,
    input: {
      thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them"),
      ...(road.answer.reasons === true ? { reason: z.string().optional().describe("what the agent should do instead, in your words; the agent reads it with the refusal, as it reads the reason a person types in the app") } : {}),
    },
    output: { threadId: z.string(), askId: z.string(), optionId: z.string() },
    call: async ({ thread: ref, reason }: { thread: string; reason?: string }, deps: VerbDeps) => {
      const answered = await answerOpenAsk(await deps.client(), ref, road, reason);
      return asText(answered.line, { threadId: answered.threadId, askId: answered.askId, optionId: answered.optionId });
    },
  }),
}));

// --- the slate: a live panel per thread the agent builds and the person reads, presses and fills in ---

const SlateThreadIn = z.string().optional().describe("another thread's id");
const SlateIfVersionIn = z.number().int().optional().describe("only at this version");
/** What every slate tool answers: the version and the sketch as text, the rest an open record the text already says. */
const slateOut = <K extends string>(...rest: K[]) => ({ version: z.number().int(), text: z.string(), ...(Object.fromEntries(rest.map(k => [k, z.unknown()])) as Record<K, z.ZodUnknown>) });

/** The thread a slate line names, as the host takes it: one named by id or prefix, else the turn this line runs
 * inside, else nothing, which the host reads off the caller's own token. */
async function slateTarget(client: HostClient, ref: string | undefined, env: VerbDeps["env"]): Promise<{ threadId?: string; turnToken?: string }> {
  if (ref !== undefined) {
    const thread = await threadOf(client, ref);
    return { threadId: thread.threadId ?? thread.id };
  }
  const token = turnTokenOf(env);
  return token !== undefined ? { turnToken: token } : {};
}

/** A slate op's answer without the reply frame's own id and ok, so both doors print the answer alone. */
async function slateAsk<T extends { text: string }>(client: HostClient, op: string, params: Record<string, unknown>): Promise<T> {
  const { id: _id, ok: _ok, ...answer } = await client.request<Record<string, unknown>>(op, params);
  return answer as T;
}

/** The sketch as the one frame ahead of the result, and the result without it. */
function emitSlate(ctx: VerbContext, answer: { text: string }): void {
  const { text, ...rest } = answer;
  ctx.out.emit({ text }, text);
  ctx.out.emit(rest);
}

/** A slate file as a write sends it: the JSX-like form for .slate, the stored document for .json. */
function slateFile(ctx: VerbContext, path: string): { text: string } | { document: Record<string, unknown> } {
  if (ctx.elsewhere === true) throw usageRefusal(`${path} is a file on your machine, which this host cannot read.`, "Pass the slate to slate_write as text instead.");
  const at = resolve(ctx.cwd ?? process.cwd(), path);
  if (!path.endsWith(".slate") && !path.endsWith(".json")) throw usageRefusal(`${path} is neither a .slate nor a .json file.`, "Write the JSX-like form to a .slate file or the stored form to a .json file.");
  let text: string;
  try {
    text = readFileSync(at, "utf8");
  } catch {
    throw usageRefusal(`there is no file at ${at}.`, "Name a .slate or .json file that is there.");
  }
  if (path.endsWith(".slate")) return { text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw usageRefusal(`${path} does not parse as JSON (${e instanceof Error ? e.message : String(e)}).`, "Fix the JSON or write the JSX-like form to a .slate file.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw usageRefusal(`${path} holds no JSON object.`, "Write the stored document, an object with schema, root and pieces.");
  return { document: parsed as Record<string, unknown> };
}

const ifVersionOf = (ctx: VerbContext): number | undefined => {
  const raw = ctx.flags["if-version"];
  if (typeof raw !== "string") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw usageRefusal(`--if-version takes a version number, and ${raw} is not one.`, usageIs(ctx));
  return n;
};

/** A $path=json word of a state line: the value parsed as JSON, else taken as the text it is. */
function stateValue(word: string): [string, unknown] | undefined {
  const at = word.indexOf("=");
  if (at <= 0) return undefined;
  const raw = word.slice(at + 1);
  try {
    return [word.slice(0, at), JSON.parse(raw)];
  } catch {
    return [word.slice(0, at), raw];
  }
}

const SLATE_VERBS: readonly Verb[] = [
  {
    name: "slate catalog",
    usage: "wsp slate catalog [<name>]",
    about: "what a slate can hold: the index of pieces, sources, steps, functions and rules, or one entry in full",
    page: "agent",
    options: {},
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp slate catalog takes one name at most.", usageIs(ctx));
      const client = await ctx.client();
      const read = await slateAsk<{ text: string }>(client, "slates.catalog", { ...(await slateTarget(client, undefined, ctx.env)), ...pick({ name: ctx.args[0] }) });
      ctx.out.emit(read, read.text);
      return 0;
    },
    tool: tool({
      description: "What a slate, the live panel beside the chat, can hold: every piece, and the runs that keep it fresh. Call it first whenever the person wants to see, watch, monitor or keep an eye on something, tick things off as they go, or see what's unread, even when another tool fetches the data.",
      input: { name: z.string().optional().describe("leave out first: the index of every piece; then an entry, like runs") },
      output: { text: z.string() },
      call: async ({ name }, deps) => {
        const client = await deps.client();
        const read = await slateAsk<{ text: string }>(client, "slates.catalog", { ...(await slateTarget(client, undefined, deps.env)), ...pick({ name }) });
        return asText(read.text, read);
      },
    }),
  },
  {
    name: "slate write",
    usage: "wsp slate write [<thread>] [<file>] [--check] [--set <path>=<json>]... [--press <piece>] [--row <n>] [--action <n>] [--if-version <n>]",
    about: "writes the thread's slate from a .slate file (a whole <slate> or a patch) or a .json document and prints its sketch; --check stores nothing, and with --set or --press rehearses values and a press on a copy, the file optional",
    page: "agent",
    options: { check: { type: "boolean" }, set: { type: "string", multiple: true }, press: { type: "string" }, row: { type: "string" }, action: { type: "string" }, "if-version": { type: "string" } },
    run: async ctx => {
      const values: Record<string, unknown> = {};
      for (const word of flagList(ctx.flags, "set")) {
        const pair = stateValue(word);
        if (pair === undefined) throw usageRefusal(`--set ${word} is not <path>=<json>.`, "Write it like --set '$i=2'.");
        values[pair[0]] = pair[1];
      }
      const piece = typeof ctx.flags["press"] === "string" ? ctx.flags["press"] : undefined;
      const row = typeof ctx.flags["row"] === "string" ? Number(ctx.flags["row"]) : undefined;
      const action = typeof ctx.flags["action"] === "string" ? Number(ctx.flags["action"]) : undefined;
      for (const [flag, n] of [["row", row], ["action", action]] as const) if (n !== undefined && (piece === undefined || !Number.isInteger(n) || n < 0)) throw usageRefusal(`--${flag} goes with --press, a whole number from 0:`, usageIs(ctx));
      const rehearsal = Object.keys(values).length > 0 || piece !== undefined;
      const [a, b] = ctx.args;
      if ((a === undefined && !rehearsal) || ctx.args.length > 2) throw usageRefusal("wsp slate write takes a file, after a thread where it is not yours.", usageIs(ctx));
      const [ref, file] = b !== undefined ? [a, b] : a !== undefined && /\.(slate|json)$/.test(a) ? [undefined, a] : [a, undefined];
      if (file === undefined && !rehearsal) throw usageRefusal("wsp slate write takes a .slate or .json file, after a thread where it is not yours.", usageIs(ctx));
      const client = await ctx.client();
      const ifVersion = ifVersionOf(ctx);
      const rehearse = { ...(Object.keys(values).length > 0 ? { values } : {}), ...(piece !== undefined ? { press: { piece, ...(row !== undefined ? { index: row } : {}), ...(action !== undefined ? { action } : {}) } } : {}) };
      const wrote = await slateAsk<{ text: string }>(client, "slates.write", { ...(await slateTarget(client, ref, ctx.env)), ...(file !== undefined ? slateFile(ctx, file) : {}), ...(ctx.flags["check"] === true ? { check: true } : {}), ...rehearse, ...(ifVersion !== undefined ? { ifVersion } : {}) });
      emitSlate(ctx, wrote);
      return 0;
    },
    tool: tool({
      description: "Writes this thread's slate, the live panel shown here beside the chat. Use it to show the person anything they want to see, watch, monitor or keep an eye on while you work (live data, traffic, metrics, a price, logs, a PR, progress, status), or a dashboard, a form to fill in or a checklist. A run with every= refreshes itself on a timer with no turns, so nothing polls.",
      input: {
        thread: SlateThreadIn,
        text: z.string().optional().describe("JSX-like text: a <slate>, or a patch"),
        document: z.record(z.string(), z.unknown()).optional().describe("JSON form from slate_read; not for writing"),
        check: z.boolean().optional().describe("validate, write nothing"),
        values: z.record(z.string(), z.unknown()).optional().describe("with check: $path: value"),
        press: z.string().optional().describe("with check: piece id to press"),
        row: z.number().int().optional().describe("pressed row, from 0"),
        action: z.number().int().optional().describe("row action, from 0"),
        if_version: SlateIfVersionIn,
      },
      output: slateOut("warnings", "problems", "waiting"),
      stream: ["text"],
      call: async ({ thread, text, document, check, values, press, row, action, if_version }, deps) => {
        const client = await deps.client();
        const pressed = press === undefined ? undefined : { piece: press, ...pick({ index: row, action }) };
        const wrote = await slateAsk<{ text: string }>(client, "slates.write", { ...(await slateTarget(client, thread, deps.env)), ...pick({ text, document, check, values, press: pressed, ifVersion: if_version }) });
        return asText(wrote.text, wrote);
      },
    }),
  },
  {
    name: "slate state",
    usage: "wsp slate state [<thread>] [<path>=<json>...] [--start <run>]... [--if-version <n>]",
    about: "sets the slate's $values by path, like '$steps[2].done=true' or 'i=2', starts runs the person let run every time, and prints its sketch",
    page: "agent",
    options: { "if-version": { type: "string" }, start: { type: "string", multiple: true } },
    run: async ctx => {
      const values: Record<string, unknown> = {};
      const rest: string[] = [];
      for (const word of ctx.args) {
        const pair = stateValue(word);
        if (pair === undefined) rest.push(word);
        else values[pair[0]] = pair[1];
      }
      const start = flagList(ctx.flags, "start");
      if (rest.length > 1 || (Object.keys(values).length === 0 && start.length === 0)) throw usageRefusal("wsp slate state takes $path=<json> words or --start <run>, after a thread where it is not yours.", usageIs(ctx));
      const client = await ctx.client();
      const ifVersion = ifVersionOf(ctx);
      const wrote = await slateAsk<{ text: string }>(client, "slates.state", { ...(await slateTarget(client, rest[0], ctx.env)), ...(Object.keys(values).length > 0 ? { values } : {}), ...(start.length > 0 ? { start } : {}), ...(ifVersion !== undefined ? { ifVersion } : {}) });
      emitSlate(ctx, wrote);
      return 0;
    },
    tool: tool({
      description: "Sets the slate's live $values by path, so the person sees progress, status or a checklist tick move as you work; reactions fire. start starts a run the person allowed to run always.",
      input: { thread: SlateThreadIn, values: z.record(z.string(), z.unknown()).optional().describe("$path: new value"), start: z.array(z.string()).optional().describe("runs allowed always"), if_version: SlateIfVersionIn },
      output: slateOut("problems", "waiting", "notStarted"),
      stream: ["text"],
      call: async ({ thread, values, start, if_version }, deps) => {
        const client = await deps.client();
        const wrote = await slateAsk<{ text: string }>(client, "slates.state", { ...(await slateTarget(client, thread, deps.env)), ...pick({ values, start, ifVersion: if_version }) });
        return asText(wrote.text, wrote);
      },
    }),
  },
  {
    name: "slate read",
    usage: "wsp slate read [<thread>] [--values <path>]... [--no-text] [--no-sketch] [--document]",
    about: "the slate as it stands: the sketch, then the JSX-like form, the values, derived values, runs, problems and the paths named; --no-text leaves out the JSX-like form, --document adds the stored JSON",
    page: "agent",
    options: { values: { type: "string", multiple: true }, "no-text": { type: "boolean" }, "no-sketch": { type: "boolean" }, document: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp slate read takes one thread at most.", usageIs(ctx));
      const client = await ctx.client();
      const values = flagList(ctx.flags, "values");
      const read = await slateAsk<{ text: string }>(client, "slates.read", { ...(await slateTarget(client, ctx.args[0], ctx.env)), ...(values.length > 0 ? { values } : {}), ...(ctx.flags["no-text"] === true ? { text: false } : {}), ...(ctx.flags["no-sketch"] === true ? { sketch: false } : {}), ...(ctx.flags["document"] === true ? { document: true } : {}) });
      emitSlate(ctx, read);
      return 0;
    },
    tool: tool({
      description: "Reads this thread's slate: what the person filled in or pressed, live values, run output and logs, and the sketch: the panel's words as the person sees them.",
      input: { thread: SlateThreadIn, values: z.array(z.string()).optional().describe("$run.json, $value, source path, or *"), text: z.boolean().optional().describe("false: no JSX-like form"), sketch: z.boolean().optional().describe("false: no sketch"), document: z.boolean().optional().describe("true: add stored JSON") },
      output: slateOut("document", "values", "derived", "runs", "state", "problems", "waiting", "comments", "approvals"),
      stream: ["text"],
      call: async ({ thread, values, text, sketch, document }, deps) => {
        const client = await deps.client();
        const read = await slateAsk<{ text: string }>(client, "slates.read", { ...(await slateTarget(client, thread, deps.env)), ...pick({ values, text, sketch, document }) });
        return asText(read.text, read);
      },
    }),
  },
];

/** The slate's tools: loaded up front by a client that defers tools behind a search, since a model that never searched
 * never found them, and left off a server for a thread that has no slate. */
export const SLATE_TOOL_NAMES: ReadonlySet<string> = new Set<string>(SLATE_TOOLS);

/** Every verb, the cloud's among them; VERBS below is the table this process answers. */
export const ALL_VERBS: readonly Verb[] = [
  {
    name: "computers",
    usage: "wsp computers",
    about: "your computers: this Mac, each box you added<!-- cloud --> and each cloud account<!-- /cloud -->, with what each has, whether it is connected, how many machines it holds and what runs there against its cap<!-- cloud -->, and what each cloud spent today<!-- /cloud -->",
    page: "front",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp computers takes no positional arguments.", usageIs(ctx));
      const read = await readComputers(await ctx.client());
      ctx.out.emit(read, computerLines(read.computers, hostPlatform(), read.spend, read.pending).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Every computer this host holds, which is the whole of where work can run: the computer the app runs on<!-- cloud -->, each box joined to it and each cloud account<!-- /cloud --><!-- no cloud --> and each box joined to it<!-- /no cloud -->. A row carries what that computer last reported (cores, memory, free disk, the engine it has for a project's own containers) and whether it is connected right now<!-- cloud -->; a cloud row carries its hourly rate<!-- /cloud -->. Every row carries its cap, threads at once on a computer<!-- cloud --> and machines at once and spend per day on a cloud<!-- /cloud --> (the number the person set, else one thread per 2.5 GB of memory up to its cores<!-- cloud -->, and 3 machines and $10 a day<!-- /cloud -->), and running, the threads running there now on a computer<!-- cloud --> or the machines holding a slot on a cloud<!-- /cloud -->; a row whose running meets its cap is full.<!-- cloud --> spend holds one row per cloud, what it has spent today (since midnight where the host runs) and this month and what it burns an hour now; a cloud whose spend today reaches its spend per day is at its limit and starts no new machine until midnight, while the machines already running there go on.<!-- /cloud --> A row whose copy of the image is building says which stage it is at, and one whose last build stopped says why. A project lives on a computer: on the computer the app runs on its threads run in the project's folder, and on a box<!-- cloud --> or a cloud<!-- /cloud --> they run on a machine forked from the image with the project inside. pending holds every add that has not reached Set up: how far it got, what was chosen for it, and why it stopped where one did.",
      input: {},
      output: { computers: z.array(PlaceView), spend: z.array(PlaceSpend), pending: z.array(PendingComputer) },
      call: async (_args, deps) => asJson(await readComputers(await deps.client())),
    }),
  },
  {
    name: "computers set",
    cloudFlags: ["machines", "spend"],
    usage: "wsp computers set <computer> [--threads <n>] [--machines <n>] [--spend <usd>] [--nap <minutes>|off] [--turn-limit <hours>|off] [--spawn on|off] [--max-machines <n>] [--max-depth <n>] [--recipe <name>|none] [--reset <setting>]...",
    about: "what you set on one of your computers: how many threads run there at once, how long a quiet machine there runs before it naps, how long one turn there may run, whether agents there may start agents, the recipe it follows<!-- cloud -->, and on a cloud how many machines at once and how much it spends a day<!-- /cloud -->; --reset takes a setting back to its default",
    page: "agent",
    options: { threads: { type: "string" }, machines: { type: "string" }, spend: { type: "string" }, nap: { type: "string" }, "turn-limit": { type: "string" }, spawn: { type: "string" }, "max-machines": { type: "string" }, "max-depth": { type: "string" }, recipe: { type: "string" }, reset: { type: "string", multiple: true } },
    run: async ctx => {
      const [ref, ...rest] = ctx.args;
      if (ref === undefined || rest.length > 0) throw usageRefusal("wsp computers set takes one computer.", usageIs(ctx));
      const recipe = flag(ctx.flags, "recipe");
      const threads = flag(ctx.flags, "threads");
      const machines = flag(ctx.flags, "machines");
      const spend = flag(ctx.flags, "spend");
      const nap = flag(ctx.flags, "nap");
      const turnLimit = flag(ctx.flags, "turn-limit");
      const spawn = agentsAsked(flag(ctx.flags, "spawn"), flag(ctx.flags, "max-machines"), flag(ctx.flags, "max-depth"), ref);
      const computer = await setComputer(await ctx.client(), ref, {
        ...(threads !== undefined ? { threads: countAsked("--threads", threads, 1, ref) } : {}),
        ...(machines !== undefined ? { machines: countAsked("--machines", machines, 1, ref) } : {}),
        ...(spend !== undefined ? { spendPerDayUsd: dollarsAsked(spend, ref) } : {}),
        ...(nap !== undefined ? { napMs: napMsOf(napAsked(nap, ref)) } : {}),
        ...(turnLimit !== undefined ? { turnLimitMs: turnLimitMsOf(turnLimitAsked(turnLimit, ref)) } : {}),
        ...(spawn !== undefined ? { spawn } : {}),
      }, flagList(ctx.flags, "reset").map(word => oneOf("reset", SETTING_RESETS, word, ref)!), recipe);
      ctx.out.emit({ computer }, recipe === undefined ? placeSettingsLine(computer) : followLine(computer));
      return 0;
    },
    tool: tool({
      description:
        "Sets what the person may set on one computer and answers its row as it now reads, the same row computers lists: threads, how many threads may run there at once, a new one waiting past it (one per 2.5 GB of that computer's memory up to its cores until it is set); nap, the minutes a machine there with no window of its own runs with no turn and no work before it naps and stops costing anything, waking on the next message (20 until it is set, 0 never naps it), which every machine there counts again from now and which the computer the app runs on does not take, since its threads run in folders; turn_limit, the hours one turn there may run before it is stopped, a send carrying it on from where it stopped (none on a computer the person owns<!-- cloud --> and 6 on a cloud<!-- /cloud --> until it is set, 0 is none), read at each turn's start; spawn, max_machines and max_depth, what the agents there may ask of this host where the folder or the machine they run in holds no switch of its own, as workspaces_agents names it for one (on, up to 3 machines and 2 levels deep, until it is set), read at every ask so one made before the change follows it<!-- cloud -->; machines and spend on a cloud, how many machines may run there at once and the dollars a day it may spend before it starts no new machine (3 and $10 until they are set)<!-- /cloud -->. A setting left out keeps what stands, and each word under reset takes that setting back to its default. The row carries cap, what runs there now, capDefault, what it reads by default, and settings, what the person set. A setting the computer's kind does not take, and a call that sets nothing, are refused in one line.",
      input: {
        computer: z.string().describe("the computer, by the name computers lists or its id"),
        threads: z.number().int().min(1).optional().describe("how many threads may run on that computer at once"),
        machines: z.number().int().min(1).optional().describe("how many machines may run on that cloud at once"),
        spend: z.number().min(0).optional().describe("the dollars a day that cloud may spend before it starts no new machine"),
        nap: z.number().int().min(0).max(NAP_AFTER_MAX_MS / 60_000).optional().describe("the minutes a quiet machine there runs before it naps; 0 never naps it"),
        turn_limit: z.number().int().min(0).max(TURN_LIMIT_MAX_MS / 3_600_000).optional().describe("the hours one turn there may run before it is stopped; 0 never stops one"),
        spawn: z.enum(["on", "off"]).optional().describe("whether agents there may open threads and fork machines under the thread they run in, capped, where the folder or the machine they run in holds no switch of its own"),
        max_machines: z.number().int().min(0).optional().describe("how many machines may stand at once under one root thread there while spawn is on"),
        max_depth: z.number().int().min(1).optional().describe("how many levels deep the tree under a root thread there may go while spawn is on"),
        recipe: z.string().optional().describe("the saved recipe it follows from now, as recipes lists it, or none: one it follows syncs to it, a change to the recipe reaching it with no step, and none keeps what it has"),
        reset: z.array(z.enum(SETTING_RESETS)).optional().describe("the settings to take back to their defaults, by the same words"),
      },
      output: { computer: PlaceView },
      call: async ({ computer: ref, threads, machines, spend, nap, turn_limit: turnLimit, spawn: on, max_machines: maxMachines, max_depth: maxDepth, recipe, reset }, deps) => {
        const spawn = agentsAsked(on, maxMachines, maxDepth);
        const computer = await setComputer(await deps.client(), ref, {
          ...(threads !== undefined ? { threads } : {}),
          ...(machines !== undefined ? { machines } : {}),
          ...(spend !== undefined ? { spendPerDayUsd: spend } : {}),
          ...(nap !== undefined ? { napMs: napMsOf(nap) } : {}),
          ...(turnLimit !== undefined ? { turnLimitMs: turnLimitMsOf(turnLimit) } : {}),
          ...(spawn !== undefined ? { spawn } : {}),
        }, reset ?? [], recipe);
        return asJson({ computer });
      },
    }),
  },
  {
    name: "add",
    command: true,
    tool: tool({
      description:
        "Adds a computer of the person's over ssh and sets it up from a saved recipe, as `wsp add <user@host> --recipe <name>` does: address is user@host or an alias from the ssh config, and the host logs in, checks it can run wsp there (root, or a login whose sudo runs it as root, systemd with cgroup v2, room on the disk), installs wsp, waits for it to dial back, then puts on the base tools and everything the recipe picks. With resume, address names a computer already added, or one that joined and waits on its picks, and sets it up again: from recipe where one is named, else from what it holds, running only what is missing, a sign-in that waited or ran out among it. This tool never waits on the person: it answers at the first sign-in waiting on them (the page and the code are in waiting, to hand over), at the end, or after ten minutes, and is called again with resume for the next of those; with later it does not stop at a sign-in and leaves it waiting. setup is the setup's steps as the computer's row holds them, each with its state and what it took; an install that fails is refused with the step it failed at. A login whose sudo asks for a password is refused with the line that says where the person types it, at a terminal or in the app, since no password travels through this tool. A computer this host has never dialled needs host_key, as the person read it off that computer, or the add is refused with the key it answered with. A project, a provider's key and the join code are not added here: projects_add records a project, and the other two belong at the host's own terminal.",
      input: {
        address: z.string().describe("user@host, an alias from the ssh config, or with resume a computer already added"),
        recipe: z.string().optional().describe("the saved recipe to set it up from, as recipes lists it"),
        later: z.boolean().optional().describe("go on past a sign-in that waits on the person and leave it waiting"),
        resume: z.boolean().optional().describe("set up a computer already added, or one that joined and waits on its picks"),
        name: z.string().optional().describe("what to call the computer here; what its address calls it without one"),
        ssh_port: z.number().int().min(1).max(65535).optional().describe("the port ssh dials it on (default 22)"),
        ssh_key: z.string().optional().describe("the key file ssh logs in with"),
        host_key: z.string().optional().describe("the host key of a computer this one has never dialled, as read off that computer"),
      },
      output: { computer: PlaceView, setup: z.array(AddLine), waiting: z.array(PlaceWait) },
      stream: ["setup", "waiting"],
      call: async ({ address, recipe, later, resume, name, ssh_port: sshPort, ssh_key: keyPath, host_key: hostKey }, deps) =>
        asJson(
          await addComputer(await deps.client(), {
            address,
            ...(recipe !== undefined ? { recipe } : {}),
            ...(later !== undefined ? { later } : {}),
            ...(resume !== undefined ? { resume } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(sshPort !== undefined ? { sshPort } : {}),
            ...(keyPath !== undefined ? { keyPath } : {}),
            ...(hostKey !== undefined ? { hostKey } : {}),
          }),
        ),
    }),
  },
  {
    name: "recipes",
    usage: "wsp recipes",
    about: "your saved recipes: what each puts on a computer in one line, and the computers that follow it",
    page: "agent",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp recipes takes no positional arguments.", usageIs(ctx));
      const { recipes } = await (await ctx.client()).request<{ recipes: RecipeView[] }>("recipes.list");
      ctx.out.emit({ recipes }, recipeLines(recipes).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Every recipe this host keeps: a named pick of what goes on a computer of the person's (agents and how each signs in, MCP servers per agent, CLIs by the manager they came from, skills, plugins, folders to move over as projects, and the git, shell and GitHub configs), chosen from what the computer the app runs on has. Each carries summary, one line of what it holds, and machines, the computers that follow it: a recipe edit reaches them. A recipe holds names and never a secret; a token reaches a computer only in the environment of a run there.",
      input: {},
      output: { recipes: z.array(RecipeView) },
      call: async (_args, deps) => {
        const { recipes } = await (await deps.client()).request<{ recipes: RecipeView[] }>("recipes.list");
        return asJson({ recipes });
      },
    }),
  },
  {
    name: "recipes show",
    usage: "wsp recipes show <name>",
    about: "one recipe whole: every row it holds by kind, the computers that follow it, and the hash it resolves to on this computer now",
    page: "agent",
    options: {},
    run: async ctx => {
      const [name, ...rest] = ctx.args;
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp recipes show takes one recipe.", usageIs(ctx));
      const shown = await (await ctx.client()).request<{ recipe: RecipeView; hash: string }>("recipes.get", { name });
      ctx.out.emit({ recipe: shown.recipe, hash: shown.hash }, recipeShownLines(shown.recipe, shown.hash).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "One recipe by its name: file is the recipe as saved, every row by kind (agents with signin vault or machine, mcp with the agents each server goes to, clis with via, the manager it came from, and needs where it builds with the C toolchain, skills with from, the folder it is read from here, plugins, folders with from, name, icon, hue and keep, configs git, shell and github, github with signin vault, machine or skip), machines the computers that follow it, and hash what it resolves to on the computer the app runs on now: the versions, the skill folders and the configs read there, which a computer that applied it is held against.",
      input: { name: z.string().describe("the recipe's name, as recipes lists it") },
      output: { recipe: RecipeView, hash: z.string() },
      call: async ({ name }, deps) => {
        const shown = await (await deps.client()).request<{ recipe: RecipeView; hash: string }>("recipes.get", { name });
        return asJson({ recipe: shown.recipe, hash: shown.hash });
      },
    }),
  },
  {
    name: "recipes save",
    usage: "wsp recipes save <name> --from <computer>",
    about: "saves what one of your computers was set up with as a recipe under that name, and that computer follows it from then on",
    page: "agent",
    options: { from: { type: "string" } },
    run: async ctx => {
      const [name, ...rest] = ctx.args;
      const from = flag(ctx.flags, "from");
      if (name === undefined || rest.length > 0 || from === undefined) throw usageRefusal("wsp recipes save takes one name and the computer to save it from.", usageIs(ctx));
      const { recipe } = await (await ctx.client()).request<{ recipe: RecipeView }>("recipes.save", { name, from });
      ctx.out.emit({ recipe }, recipeSavedLine(recipe));
      return 0;
    },
    tool: tool({
      description:
        "Saves the picks one of the person's computers was set up with as a recipe under name, rewriting a recipe of that name whole, and that computer follows it from then on, so an edit to the recipe reaches it. Refused for a name with no letter or digit in it, for the computer the app runs on, and for a computer set up before picks were kept. The answer is the recipe as saved.",
      input: { name: z.string().describe("what to call the recipe"), from: z.string().describe("the computer whose picks to save, by the name computers lists") },
      output: { recipe: RecipeView },
      call: async ({ name, from }, deps) => {
        const { recipe } = await (await deps.client()).request<{ recipe: RecipeView }>("recipes.save", { name, from });
        return asJson({ recipe });
      },
    }),
  },
  {
    name: "recipes remove",
    usage: "wsp recipes remove <name>",
    about: "takes a recipe away; the computers that followed it keep what they have and follow none",
    page: "agent",
    options: {},
    run: async ctx => {
      const [name, ...rest] = ctx.args;
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp recipes remove takes one recipe.", usageIs(ctx));
      const { recipe } = await (await ctx.client()).request<{ recipe: RecipeView }>("recipes.remove", { name });
      ctx.out.emit({ recipe }, recipeRemovedLine(recipe));
      return 0;
    },
    tool: tool({
      description: "Takes a recipe's file away. The computers that followed it keep everything it put there and follow none from then on, so nothing reaches them from it again. The answer is the recipe as it stood, machines naming the computers it was taken off.",
      input: { name: z.string().describe("the recipe's name, as recipes lists it") },
      output: { recipe: RecipeView },
      call: async ({ name }, deps) => {
        const { recipe } = await (await deps.client()).request<{ recipe: RecipeView }>("recipes.remove", { name });
        return asJson({ recipe });
      },
    }),
  },
  {
    name: "usage",
    usage: "wsp usage [--range day|week|month] [--by agent|account|computer|project|model]",
    about: "what each agent account signed in on any of your computers may still use, and what was used over a day, a week or a month split one way; two answers, never added together",
    page: "agent",
    options: { range: { type: "string" }, by: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp usage takes no positional arguments.", usageIs(ctx));
      const range = oneOf("range", USAGE_RANGES, flag(ctx.flags, "range")) ?? "day";
      const by = oneOf("by", USAGE_SPLITS, flag(ctx.flags, "by")) ?? "agent";
      const read = await readUsage(await ctx.client(), range, by);
      ctx.out.emit(read, usageTableLines({ accounts: z.array(AccountRow).parse(read.accounts), used: UsedAnswer.parse(read.used) }, Date.now()).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Two answers that are never added together. accounts: every agent account signed in on any computer, the same one on three computers once, each with how much of its plan's windows is used and when each starts again, as that agent printed them in the last turn wsp ran on it; an agent that prints none reports no plan limit, a sign-in by API key pays per token with no plan window, and an account no turn has run on yet has no reading. used: the tokens the turns used over the range (today, the last seven days or the last thirty), split by agent, account, computer, project or model (a model once for each agent that ran it, and a row by agent, account or model naming its agent), each row with the cost its agent reported, a list price off one table for every token and what the cache saved, input counting the cached and the written tokens, the turns wsp ran, and a series over the range with one line per row.",
      input: { range: UsageRange.optional().describe("day (the default), week or month"), by: UsageSplit.optional().describe("agent (the default), account, computer, project or model") },
      output: { accounts: z.array(AccountRow), used: UsedAnswer },
      call: async ({ range, by }, deps) => asJson(await readUsage(await deps.client(), range ?? "day", by ?? "agent")),
    }),
  },
  {
    name: "usage reset",
    usage: "wsp usage reset <account> [--credit <id>] [--on <computer>] [--yes]",
    about: "spends one of the resets a Codex account has banked, on a computer of yours that holds its login, after reading the account there: its five-hour and weekly windows start again now; asks first unless --yes",
    page: "agent",
    options: { credit: { type: "string" }, on: { type: "string" }, yes: { type: "boolean" } },
    cliOnly: "spends a reset the person owns; the skill already says an agent does not read the person's accounts, and a thread's socket is refused every usage op",
    run: async ctx => {
      const [word, ...rest] = ctx.args;
      if (word === undefined || rest.length > 0) throw usageRefusal("wsp usage reset takes one account.", usageIs(ctx));
      const client = await ctx.client();
      const { accounts } = await client.request<{ accounts: unknown }>("usage.accounts");
      const row = accountNamed(z.array(AccountRow).parse(accounts), word);
      if (!(await confirmed(ctx, resetQuestion(row.label, row.credits?.count), `Every reset banked on ${row.label}`))) return 1;
      const credit = flag(ctx.flags, "credit");
      const on = flag(ctx.flags, "on");
      const answer = ResetAnswer.parse(await client.request("usage.reset", { account: row.key, ...(credit !== undefined ? { creditId: credit } : {}), ...(on !== undefined ? { on } : {}) }));
      ctx.out.emit(answer, answer.said);
      return 0;
    },
  },
  {
    name: "agents",
    usage: "wsp agents [<workspace>] [--on <computer>]",
    about: "the coding agents on this computer, a box you added or a workspace: each one's version and the newest out, whether it is signed in there, and whether it carries the wsp tools",
    page: "agent",
    options: { on: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp agents takes one workspace at most.", usageIs(ctx));
      const report = await agentsReport(await ctx.client(), ctx.args[0], flag(ctx.flags, "on"), usageIs(ctx));
      ctx.out.emit({ ...reportFacts(report), agents: report.agents }, agentRowLines(report).join("\n"));
      return 0;
    },
    tool: tool({
      description: `The coding agents the catalog knows, as they stand on one computer or workspace: whether each is on that login's PATH and where, the version its command answers, the newest its vendor publishes as this host last read it (asked of npm, GitHub or the vendor from this host alone, kept a day, never with Newest agent versions off in Settings > Privacy or WSP_UPDATE_CHECK=0) and the version wsp's install pins, its sign-in there (signed in, your key from this host's vault, not signed in, or unknown) and how it stands in the status command's own words (signInDetail), the kind of that login (signInKind: api-key, subscription or oauth) and the plan it names (signInPlan), how a person signs it in, whether one of its MCP config files names the wsp server, the vendor's own command that brings it up to the newest where it is older (update, which wsp shows and never runs), and on a computer how the person set it to run there (setup: on or off, the program, the config folder, the launch words and the names of its variables, never a value). ${AGENTS_READ_WORDS}`,
      input: { workspace: AgentsWorkspaceIn, on: AgentsOnIn },
      output: { ...AGENTS_FRAME, agents: z.array(AgentRow) },
      call: async ({ workspace, on }, deps) => {
        const report = await agentsReport(await deps.client(), workspace, on, "agents takes a workspace or on, not both");
        return asText(agentRowLines(report).join("\n"), { ...reportFacts(report), agents: report.agents });
      },
    }),
  },
  {
    name: "skills",
    usage: "wsp skills [<workspace>] [--on <computer>]",
    about: "the skills on this computer, a box you added or a workspace, each by name with every folder it lives in and which agent loads it from there",
    page: "agent",
    options: { on: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp skills takes one workspace at most.", usageIs(ctx));
      const report = await agentsReport(await ctx.client(), ctx.args[0], flag(ctx.flags, "on"), usageIs(ctx));
      ctx.out.emit({ ...reportFacts(report), skills: report.skills }, skillRowLines(report).join("\n"));
      return 0;
    },
    tool: tool({
      description: `Every skill on one computer or workspace, one row per folder name: its description off its SKILL.md, every folder it lives in with the agent whose own folder that is (none for the shared ~/.agents/skills) and where a folder links to, and whether it is the person's own, a project's inside a workspace, or a plugin's. ${AGENTS_READ_WORDS}`,
      input: { workspace: AgentsWorkspaceIn, on: AgentsOnIn },
      output: { ...AGENTS_FRAME, skills: z.array(SkillRow) },
      call: async ({ workspace, on }, deps) => {
        const report = await agentsReport(await deps.client(), workspace, on, "skills takes a workspace or on, not both");
        return asText(skillRowLines(report).join("\n"), { ...reportFacts(report), skills: report.skills });
      },
    }),
  },
  {
    name: "skills search",
    usage: "wsp skills search <query> [--limit <n>]",
    about: "searches skills.sh for skills by their words, each with how often it was installed and the id wsp skills add takes",
    page: "agent",
    options: { limit: { type: "string" } },
    run: async ctx => {
      const q = ctx.args.join(" ");
      const raw = flag(ctx.flags, "limit");
      const limit = raw === undefined ? undefined : Number(raw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) throw usageRefusal("--limit takes a whole number from 1 to 50.", usageIs(ctx));
      const hits = await searchSkillsSh(await ctx.client(), q, limit);
      ctx.out.emit({ skills: hits }, skillHitLines(hits).join("\n"));
      return 0;
    },
    tool: tool({
      description: "Skills on skills.sh whose words match the query, most installed first as skills.sh ranks them: each one's name, the repo it comes from, how many times it was installed, and the id skills_add takes. The host asks skills.sh; an empty query is refused.",
      input: { query: z.string().describe("the words to search skills.sh for"), limit: z.number().int().min(1).max(50).optional().describe("how many to answer, 20 without it") },
      output: { skills: z.array(SkillHit) },
      call: async ({ query, limit }, deps) => {
        const hits = await searchSkillsSh(await deps.client(), query, limit);
        return asText(skillHitLines(hits).join("\n"), { skills: hits });
      },
    }),
  },
  {
    name: "skills show",
    usage: "wsp skills show <skill> [<workspace>] [--on <computer>] [--project [<name>]]",
    about: "prints a skill's SKILL.md: one on skills.sh by its <owner>/<repo>/<skill> before it is installed, or one already on this computer, a box you added or a workspace by its name",
    page: "agent",
    options: { on: { type: "string" }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [skill, workspace, ...rest] = ctx.args;
      if (skill === undefined || rest.length > 0) throw usageRefusal("wsp skills show takes one skill and one workspace at most.", usageIs(ctx));
      const shown = await skillShown(await ctx.client(), skill, workspace, flag(ctx.flags, "on"), projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx)), usageIs(ctx));
      ctx.out.emit(shown, shownText(shown));
      return 0;
    },
    tool: tool({
      description: `A skill's SKILL.md as text, its first ${SKILL_PREVIEW_BYTES / 1024} KB and the whole file's size: a skill on skills.sh by its <owner>/<repo>/<skill>, read by the host with nothing installed, or a skill already on one computer or workspace by its name. Nothing in it runs.`,
      input: { skill: z.string().describe("an <owner>/<repo>/<skill> off skills_search, or the name of a skill skills lists"), workspace: AgentsWorkspaceIn, on: AgentsOnIn, project: SkillProjectIn },
      output: SkillPreview.shape,
      call: async ({ skill, workspace, on, project }, deps) => {
        const shown = await skillShown(await deps.client(), skill, workspace, on, projectAsked(project, workspace, on, "skills_show"), aimedUsage("skills_show"));
        return asText(shownText(shown), shown);
      },
    }),
  },
  {
    name: "skills add",
    usage: "wsp skills add <skill> [<workspace>] [--on <computer>] [--agent <id>]... [--project [<name>]]",
    about: "installs a skill off skills.sh by its <owner>/<repo>/<skill> into the shared skills folder, with a link or a copy for each agent named that does not read that folder; every file is checked first and lands as a plain file that runs nothing",
    page: "agent",
    options: { on: { type: "string" }, agent: { type: "string", multiple: true }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [skill, workspace, ...rest] = ctx.args;
      if (skill === undefined || rest.length > 0) throw usageRefusal("wsp skills add takes one skill and one workspace at most.", usageIs(ctx));
      const agents = flagList(ctx.flags, "agent");
      const added = await skillAdded(await ctx.client(), skill, workspace, flag(ctx.flags, "on"), agents.length > 0 ? agents : undefined, projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx)), usageIs(ctx));
      ctx.out.emit(added, addedLine(skill, added));
      return 0;
    },
    tool: tool({
      description:
        "Installs one skill off skills.sh on one computer or workspace, as the login it was added with: its files land once in ~/.agents/skills/<name> (the project's .agents/skills with project, from a workspace), and each agent named that does not read that folder gets a link to it or a copy in its own skills folder; with no agent named, every agent whose own folder's home is there gets it. The download is checked whole before anything lands: every path plain and inside the skill, at most 200 files, 1 MB each and 5 MB in all, a SKILL.md at its root; every file lands 0644 and nothing in the skill runs. A skill already there is refused rather than written over.",
      input: {
        skill: z.string().describe("the skill's <owner>/<repo>/<skill>, as skills_search answers it"),
        workspace: AgentsWorkspaceIn,
        on: AgentsOnIn,
        agent: z.array(z.string()).optional().describe("the catalog ids of the agents to put it in; every agent whose folder is there without it"),
        project: z.union([z.boolean(), z.string()]).optional().describe("put it in a project rather than the home: true for the workspace's own, or the project's name, as projects lists it, with on"),
      },
      output: SkillAdded.shape,
      call: async ({ skill, workspace, on, agent, project }, deps) => {
        const added = await skillAdded(await deps.client(), skill, workspace, on, agent, projectAsked(project, workspace, on, "skills_add"), aimedUsage("skills_add"));
        return asText(addedLine(skill, added), added);
      },
    }),
  },
  {
    name: "skills remove",
    usage: "wsp skills remove <name> [<workspace>] [--on <computer>] [--project [<name>]]",
    about: "removes a skill by its name: every folder it lives in and every link to it, where a link's own folder elsewhere stays",
    page: "agent",
    options: { on: { type: "string" }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp skills remove takes one skill's name and one workspace at most.", usageIs(ctx));
      const removed = await skillChanged(await ctx.client(), "skills.remove", name, workspace, flag(ctx.flags, "on"), projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx)), undefined, usageIs(ctx));
      ctx.out.emit({ removed }, removedLine(name, removed));
      return 0;
    },
    tool: tool({
      description: `Removes one skill on one computer or workspace by its name, as the login it was added with: every folder skills lists for it and every link to it; a folder a link points to outside the skills folders stays. ${SKILL_CHANGE_WORDS}`,
      input: { name: SkillNameIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn, project: SkillProjectIn },
      output: { removed: z.array(z.string()) },
      call: async ({ name, workspace, on, project }, deps) => {
        const removed = await skillChanged(await deps.client(), "skills.remove", name, workspace, on, projectAsked(project, workspace, on, "skills_remove"), undefined, aimedUsage("skills_remove"));
        return asText(removedLine(name, removed), { removed });
      },
    }),
  },
  ...(["disable", "enable"] as const).map(
    (word): Verb => ({
      name: `skills ${word}`,
      usage: `wsp skills ${word} <name> [<workspace>] [--on <computer>]`,
      about: word === "disable" ? "turns a skill off by its name, its SKILL.md renamed SKILL.md.off where it lives, so no agent loads it until it is turned on" : "turns a skill that was turned off on again, its SKILL.md.off renamed back",
      page: "agent",
      options: { on: { type: "string" } },
      run: async ctx => {
        const [name, workspace, ...rest] = ctx.args;
        if (name === undefined || rest.length > 0) throw usageRefusal(`wsp skills ${word} takes one skill's name and one workspace at most.`, usageIs(ctx));
        const paths = await skillChanged(await ctx.client(), "skills.toggle", name, workspace, flag(ctx.flags, "on"), { project: false }, word === "enable", usageIs(ctx));
        ctx.out.emit({ paths }, turnedLine(name, word === "enable"));
        return 0;
      },
      tool: tool({
        description: `Turns one skill ${word === "enable" ? "on again" : "off"} on one computer or workspace by its name, as the login it was added with: its SKILL.md is renamed ${word === "enable" ? "back from SKILL.md.off" : "SKILL.md.off"} in each folder it really lives in, which every link to it follows, and no agent config is edited. A project's skill lives in the repo and is refused. ${SKILL_CHANGE_WORDS}`,
        input: { name: SkillNameIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn },
        output: { paths: z.array(z.string()) },
        call: async ({ name, workspace, on }, deps) => {
          const paths = await skillChanged(await deps.client(), "skills.toggle", name, workspace, on, { project: false }, word === "enable", aimedUsage(`skills_${word}`));
          return asText(turnedLine(name, word === "enable"), { paths });
        },
      }),
    }),
  ),
  {
    name: "servers",
    usage: "wsp servers [<workspace>] [--on <computer>]",
    about: "the MCP servers the agents on this computer, a box you added or a workspace are set up with: how each is reached, the file it is defined in and its sign-in as its config says it",
    page: "agent",
    options: { on: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp servers takes one workspace at most.", usageIs(ctx));
      const report = await agentsReport(await ctx.client(), ctx.args[0], flag(ctx.flags, "on"), usageIs(ctx));
      ctx.out.emit({ ...reportFacts(report), servers: report.servers }, serverRowLines(report).join("\n"));
      return 0;
    },
    tool: tool({
      description: `Every MCP server each agent's own config file defines on one computer or workspace, and a workspace's project files: the agent, the file, how it is reached (its command with every value hidden, or its url's host), the names of the variables it sets or reads and never their values, whether the file switches it off, whether wsp's recipe put it there on a box, and its sign-in as the config alone says it: open for a command or a fixed header, unknown for a remote server until something connects. ${AGENTS_READ_WORDS}`,
      input: { workspace: AgentsWorkspaceIn, on: AgentsOnIn },
      output: { ...AGENTS_FRAME, servers: z.array(McpRow) },
      call: async ({ workspace, on }, deps) => {
        const report = await agentsReport(await deps.client(), workspace, on, "servers takes a workspace or on, not both");
        return asText(serverRowLines(report).join("\n"), { ...reportFacts(report), servers: report.servers });
      },
    }),
  },
  {
    name: "agents signin",
    usage: "wsp agents signin <agent> [<workspace>]",
    about: "signs an agent in on this computer or in a workspace, its own sign-in run there and shown in this terminal; a box you added takes wsp add <computer> --sign-in <agent>",
    page: "agent",
    options: {},
    cliOnly: "runs the agent's own sign-in in a terminal a person types into, which is where the ones that ask them to pick a provider are answered",
    run: async ctx => {
      const [agent, workspace, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents signin takes one agent and one workspace at most.", usageIs(ctx));
      const target = await agentsTarget(await ctx.client(), workspace, undefined, usageIs(ctx));
      const answer = await signInHere(ctx, target, { agent });
      ctx.io.log(signedInLine(agentName(agent), workspace ?? THIS_COMPUTER, answer));
      return answer.signedIn ? 0 : 1;
    },
  },
  {
    name: "agents key",
    usage: "wsp agents key <agent>",
    about: "puts an agent's token or API key into this host's vault, typed where nothing echoes it; Claude Code's token is the one claude setup-token prints",
    page: "agent",
    options: {},
    cliOnly: "takes a token typed at the host's own terminal into its vault, which is the person's to hand over",
    hostSide: HOST_SIDE_VAULT,
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents key takes one agent.", usageIs(ctx));
      if (ctx.io.isTTY !== true) throw usageRefusal("nobody is at this terminal to paste a token.", "Run it in a terminal on the computer the host runs on.");
      const mint = catalogEntry(agent)?.signIn;
      const ask = mint !== undefined && "mint" in mint ? `Run ${mint.mint} in another terminal, then paste the token it prints` : `Paste ${agentName(agent)}'s API key`;
      const key = await ctx.io.askSecret(ask);
      await (await ctx.client()).request("agents.key", { agent, key });
      ctx.io.log(`${agentName(agent)}'s key is in this host's vault; every turn reads it from there.`);
      return 0;
    },
  },
  {
    name: "agents addtools",
    usage: "wsp agents addtools <agent>",
    about: "writes the wsp server into an agent's own config on this computer, the entry wsp mcp install writes, with the wsp skill beside it",
    page: "agent",
    options: {},
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents addtools takes one agent.", usageIs(ctx));
      const added = await addTools(await ctx.client(), agent);
      ctx.out.emit(added, toolsAddedLine(agentName(agent), added.file));
      return 0;
    },
    tool: tool({
      description: `Writes the wsp server into one agent's own MCP config on the computer the app runs on, the same entry wsp mcp install writes, with the wsp skill beside it, and answers the file. ${addToolsHereRefusal}`,
      input: { agent: z.string().describe("the catalog id of the agent, as agents lists it") },
      output: { file: z.string() },
      call: async ({ agent }, deps) => {
        const added = await addTools(await deps.client(), agent);
        return asText(toolsAddedLine(agentName(agent), added.file), added);
      },
    }),
  },
  {
    name: "agents default",
    usage: "wsp agents default <agent>",
    about: "the agent a new thread runs when neither the line nor its project names one; the catalog's first without it",
    page: "agent",
    options: {},
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents default takes one agent.", usageIs(ctx));
      const set = await defaultAgentSet(await ctx.client(), agent);
      ctx.out.emit(set, defaultAgentLine(agent));
      return 0;
    },
    tool: tool({
      description: "Sets the agent a new thread runs when neither its start nor its project names one, on every computer and in the app alike; the catalog's first agent without it. A project's own agent, set with projects_set, wins over it, and an agent turned off on a computer is passed over there. An agent this host runs no thread of is refused naming the ones it runs.",
      input: { agent: z.string().describe(`the catalog id of the agent, one of ${THREAD_AGENTS.join(", ")}`) },
      output: { defaultAgent: z.string() },
      call: async ({ agent }, deps) => asText(defaultAgentLine(agent), await defaultAgentSet(await deps.client(), agent)),
    }),
  },
  {
    name: "agents set",
    usage: "wsp agents set <agent> [--model <slug>] [--effort <word>] [--access <word>] [--hide <model>]... [--show <model>]... [--order <model,model>] [--add-model <id>]... [--drop-model <id>]... [--reset <field>]...",
    about: "an agent's defaults on every computer: the model, effort and access a new thread on it starts on, and which models its picker lists",
    page: "agent",
    options: { model: { type: "string" }, effort: { type: "string" }, access: { type: "string" }, hide: { type: "string", multiple: true }, show: { type: "string", multiple: true }, order: { type: "string" }, "add-model": { type: "string", multiple: true }, "drop-model": { type: "string", multiple: true }, reset: { type: "string", multiple: true } },
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents set takes one agent.", usageIs(ctx));
      const order = flag(ctx.flags, "order");
      const set = await agentDefaultsSet(await ctx.client(), agent, {
        ...(flag(ctx.flags, "model") !== undefined ? { model: flag(ctx.flags, "model")! } : {}),
        ...(flag(ctx.flags, "effort") !== undefined ? { effort: flag(ctx.flags, "effort")! } : {}),
        ...(flag(ctx.flags, "access") !== undefined ? { access: flag(ctx.flags, "access")! } : {}),
        hide: flagList(ctx.flags, "hide"),
        show: flagList(ctx.flags, "show"),
        ...(order !== undefined ? { order: order.split(",").map(m => m.trim()).filter(m => m !== "") } : {}),
        addModel: flagList(ctx.flags, "add-model"),
        dropModel: flagList(ctx.flags, "drop-model"),
        reset: flagList(ctx.flags, "reset"),
      });
      ctx.out.emit({ agent, defaults: set }, agentDefaultsLine(agent, set));
      return 0;
    },
    tool: tool({
      description: `Sets one agent's defaults, the same on every computer and in the app: the model and effort a new thread on it starts on, its access, and its model picker: models hidden from it (a start still takes one by name), the order it lists models in, and model ids the binary does not list that the person runs anyway, which a start then takes. A project's own model, effort and access, set with projects_set, win over these, and what a start names wins over both. An access word the agent maps to none of its modes is refused naming the ones it takes. reset puts a field back on the agent's own: model, effort, access or models.`,
      input: {
        agent: z.string().describe("the catalog id of the agent, as agents lists it"),
        model: z.string().optional().describe("the model a new thread on it starts on, by the agent's own slug"),
        effort: z.string().optional().describe("the effort a new thread on it starts at, by the agent's own word, where its model takes that one"),
        access: z.string().optional().describe(ACCESS_IN_WORDS),
        hide: z.array(z.string()).optional().describe("models to take off its picker, by slug"),
        show: z.array(z.string()).optional().describe("hidden models to put back on its picker, by slug"),
        order: z.array(z.string()).optional().describe("the models its picker lists first, in this order, by slug; the rest follow in the agent's own order"),
        add_model: z.array(z.string()).optional().describe("model ids the binary does not list that a start may name and the picker shows"),
        drop_model: z.array(z.string()).optional().describe("model ids added before, taken back off"),
        reset: z.array(z.enum(AGENT_SET_RESETS)).optional().describe("fields to put back on the agent's own: model, effort, access, models"),
      },
      output: { agent: z.string(), defaults: AgentDefaults },
      call: async ({ agent, model, effort, access, hide, show, order, add_model, drop_model, reset }, deps) => {
        const set = await agentDefaultsSet(await deps.client(), agent, {
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(access !== undefined ? { access } : {}),
          ...(hide !== undefined ? { hide } : {}),
          ...(show !== undefined ? { show } : {}),
          ...(order !== undefined ? { order } : {}),
          ...(add_model !== undefined ? { addModel: add_model } : {}),
          ...(drop_model !== undefined ? { dropModel: drop_model } : {}),
          ...(reset !== undefined ? { reset } : {}),
        });
        return asText(agentDefaultsLine(agent, set), { agent, defaults: set });
      },
    }),
  },
  {
    name: "agents setup",
    usage: "wsp agents setup <agent> [--on <computer>] [--enable | --disable] [--program <path>] [--config <folder>] [--arg <word>]... [--env <NAME>]... [--unset-env <NAME>]... [--reset <field>]...",
    about: "how an agent runs on one computer: on or off there, the program run in its place, its config folder, words added to every launch and variables every launch carries, each value typed where nothing echoes it",
    page: "agent",
    options: { on: { type: "string" }, enable: { type: "boolean" }, disable: { type: "boolean" }, program: { type: "string" }, config: { type: "string" }, arg: { type: "string", multiple: true }, env: { type: "string", multiple: true }, "unset-env": { type: "string", multiple: true }, reset: { type: "string", multiple: true } },
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents setup takes one agent.", usageIs(ctx));
      if (ctx.flags["enable"] === true && ctx.flags["disable"] === true) throw usageRefusal("--enable and --disable say two things.", "Name one.");
      const names = flagList(ctx.flags, "env").map(name => envNameOf(name, "--env"));
      for (const name of names) {
        const refused = agentEnvRefusal(name, agentName(agent));
        if (refused !== null) throw usageRefusal(`${refused}.`, ENV_REFUSED_FIX);
      }
      if (names.length > 0 && ctx.io.isTTY !== true) throw usageRefusal("nobody is at this terminal to type a variable's value.", "Run it in a terminal on the computer the host runs on.");
      const values: Record<string, string> = {};
      for (const name of names) values[name] = await ctx.io.askSecret(`${name} for ${agentName(agent)}`);
      const config = flag(ctx.flags, "config");
      const row = await agentSetupSet(
        await ctx.client(),
        agent,
        {
          ...(flag(ctx.flags, "on") !== undefined ? { on: flag(ctx.flags, "on")! } : {}),
          ...(ctx.flags["enable"] === true ? { enabled: true } : ctx.flags["disable"] === true ? { enabled: false } : {}),
          ...(flag(ctx.flags, "program") !== undefined ? { program: flag(ctx.flags, "program")! } : {}),
          ...(config !== undefined ? { config } : {}),
          args: flagList(ctx.flags, "arg"),
          unsetEnv: flagList(ctx.flags, "unset-env"),
          reset: flagList(ctx.flags, "reset"),
        },
        values,
        usageIs(ctx),
      );
      ctx.out.emit({ agent: row }, agentSetupLines(row, config !== undefined).join("\n"));
      return 0;
    },
    tool: tool({
      description: `Sets how one agent runs on one computer, this computer without on: whether it is offered there at all (off, the app's lists drop it there and a start naming it is refused naming the computer), the program run in its place, the folder it keeps its config, sessions and sign-in in (an agent with no variable for one is refused, and a folder that is not under that computer's home once its links are followed, the home itself, or wsp's own folder; a login kept under the old folder does not follow, so sign it in again there), words added to every turn's launch, and variables taken off its launch. A variable that decides how the process starts or what it loads (PATH, HOME, LD_ and DYLD_ ones, NODE_OPTIONS and the like) is never set, nor one of wsp's own. A variable's value is never taken here: the person types it at wsp agents setup --env, where nothing echoes it. Answers the agent's row as that computer's read now gives it, its variables by name alone. reset puts back the agent's own program, config or args.`,
      input: {
        agent: z.string().describe("the catalog id of the agent, as agents lists it"),
        on: z.string().optional().describe("the computer it runs on, by the name computers lists; absent is the computer the app runs on"),
        enabled: z.boolean().optional().describe("false turns the agent off on that computer, true back on"),
        program: z.string().optional().describe("the program run in the agent's place there, a path or a word on that computer's PATH"),
        config: z.string().optional().describe("the folder on that computer the agent keeps its config, sessions and sign-in in, absolute"),
        args: z.array(z.string()).optional().describe("words added to every turn's launch there, each passed as one word; they replace any set before"),
        unset_env: z.array(z.string()).optional().describe("variables to take off its launch there, by name"),
        reset: z.array(z.enum(AGENT_SETUP_RESETS)).optional().describe("fields to put back on the agent's own: program, config, args"),
      },
      output: { agent: AgentRow },
      call: async ({ agent, on, enabled, program, config, args, unset_env, reset }, deps) => {
        const row = await agentSetupSet(
          await deps.client(),
          agent,
          { ...(on !== undefined ? { on } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(program !== undefined ? { program } : {}), ...(config !== undefined ? { config } : {}), ...(args !== undefined ? { args } : {}), ...(unset_env !== undefined ? { unsetEnv: unset_env } : {}), ...(reset !== undefined ? { reset } : {}) },
          {},
          "agents_setup takes on, a computer by name",
        );
        return asText(agentSetupLines(row, config !== undefined).join("\n"), { agent: row });
      },
    }),
  },
  {
    name: "servers signin",
    usage: "wsp servers signin <name> --agent <id> [<workspace>] [--on <computer>]",
    about: "signs one MCP server in by its agent's own command for it, run where the server is set up and shown in this terminal",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" } },
    cliOnly: "runs the harness's own sign-in for the server in a terminal a person types into, where the page's answer is pasted",
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers signin takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers signin needs --agent, the agent whose config names the server, as wsp servers shows it.", usageIs(ctx));
      const on = flag(ctx.flags, "on");
      const target = await agentsTarget(await ctx.client(), workspace, on, usageIs(ctx));
      const answer = await signInHere(ctx, target, { agent, name });
      ctx.io.log(signedInLine(name, workspace ?? on ?? THIS_COMPUTER, answer));
      return answer.signedIn ? 0 : 1;
    },
  },
  {
    name: "servers tools",
    usage: "wsp servers tools <name> --agent <id> [<workspace>] [--on <computer>] [--project <name>] [--refresh]",
    about: "starts one MCP server once where it is set up and lists its tools with their descriptions, and says whether it needs a sign-in",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" }, project: { type: "string", valueWith: "on" }, refresh: { type: "boolean" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers tools takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers tools needs --agent, the agent whose config names the server, as wsp servers shows it.", usageIs(ctx));
      const project = toolsProject(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
      const answer = await serverToolsOf(await ctx.client(), name, agent, workspace, flag(ctx.flags, "on"), ctx.flags["refresh"] === true, usageIs(ctx), project);
      ctx.out.emit(answer, toolLines(name, answer).join("\n"));
      return 0;
    },
    tool: tool({
      description: `One MCP server's tools with their descriptions, and its sign-in as that one connect found it (open, signed in, needs a sign-in, failed, or unknown), with why nothing came back where nothing did. ${SERVER_TOOLS_WORDS}`,
      input: {
        name: z.string().describe("the server's name, as servers lists it"),
        agent: z.string().describe("the catalog id of the agent whose config names it, as servers lists it"),
        workspace: AgentsWorkspaceIn,
        on: AgentsOnIn,
        project: z.string().optional().describe("the project on that computer whose server it is, by the name projects lists, with on; a workspace finds its own project's servers"),
        refresh: z.boolean().optional().describe("start it again even where an answer from the last three minutes stands"),
      },
      output: ServerToolsAnswer.shape,
      call: async ({ name, agent, workspace, on, project, refresh }, deps) => {
        const usage = aimedUsage("servers_tools");
        const answer = await serverToolsOf(await deps.client(), name, agent, workspace, on, refresh === true, usage, toolsProject(project, workspace, on, usage));
        return asText(toolLines(name, answer).join("\n"), answer);
      },
    }),
  },
  {
    name: "servers add",
    usage: "wsp servers add <name> [<workspace>] [--on <computer>] --agent <id> (--command \"<line>\" | --url <address> [--header <name>=<VARIABLE>]...) [--env <NAME>]... [--project [<name>]]",
    about: "writes one MCP server into an agent's own config: a command with its arguments and variables, or an address with its headers, each value read off this terminal's environment and written into that file on this computer, a variable's value kept in the vault as well; on any other the file names a variable and the value goes to the vault, an argument or the address naming a variable as ${NAME} keeps that name there, and an agent that reads no variable there refuses it",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" }, command: { type: "string" }, env: { type: "string", multiple: true }, url: { type: "string" }, header: { type: "string", multiple: true }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers add takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers add needs --agent, the agent whose config takes the server.", usageIs(ctx));
      const command = flag(ctx.flags, "command");
      const url = flag(ctx.flags, "url");
      const values = serverValues(ctx.env, flagList(ctx.flags, "env"), flagList(ctx.flags, "header"), usageIs(ctx));
      const project = projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
      const body = { agent, name, ...serverCommand(command, usageIs(ctx)), ...(url !== undefined ? { url } : {}), ...values, ...(project.project ? { project: true } : {}) };
      const added = await serverChanged(await ctx.client(), "servers.add", body, workspace, flag(ctx.flags, "on"), usageIs(ctx), project.name);
      ctx.out.emit(added, isInLine(name, added.file));
      return 0;
    },
    tool: tool({
      description: `Writes one MCP server into one agent's own config on one computer or workspace, the project's file with project from a workspace: a command with its arguments and the variables it is given, or an address with its headers. Every value is read by name off the environment the wsp tools run with and never goes into an answer: on this computer it goes into that file, a variable's value into the vault as well, and on any other the file names a variable and the value goes to the vault, which hands it to every turn. An argument or the address may name one of those variables as \${NAME}, an address's variables being only the ones it names: on this computer the value is put in place, on any other the name stays in the agent's own syntax, and an agent that reads no variable there is refused. A name already in the file is refused rather than written over. ${SERVER_CHANGE_WORDS}`,
      input: {
        name: z.string().describe("what to call the server in the agent's config"),
        agent: z.string().describe("the catalog id of the agent whose config takes it"),
        workspace: AgentsWorkspaceIn,
        on: AgentsOnIn,
        command: z.string().optional().describe("the line the server runs, the program and its arguments as a shell would split them, nothing expanded; or url"),
        env: z.array(z.string()).optional().describe("variables the server is given, or the address names as ${NAME}, each by its name, its value read off the same name in the environment the wsp tools run with; an argument or the address may name one as ${NAME}"),
        url: z.string().optional().describe("the server's https address; or command"),
        header: z.array(z.string()).optional().describe("headers sent to the address, each <name>=<VARIABLE>, its value read off that variable in the environment the wsp tools run with"),
        project: z.union([z.boolean(), z.string()]).optional().describe("put it in a project's file rather than the agent's own: true for the workspace's own project, or the project's name, as projects lists it, with on"),
      },
      output: { file: z.string() },
      call: async ({ name, agent, workspace, on, command, env, url, header, project }, deps) => {
        const usage = aimedUsage("servers_add");
        const values = serverValues(deps.env, env ?? [], header ?? [], usage);
        const asked = projectAsked(project, workspace, on, usage);
        const body = { agent, name, ...serverCommand(command, usage), ...(url !== undefined ? { url } : {}), ...values, ...(asked.project ? { project: true } : {}) };
        const added = await serverChanged(await deps.client(), "servers.add", body, workspace, on, usage, asked.name);
        return asText(isInLine(name, added.file), added);
      },
    }),
  },
  {
    name: "servers remove",
    usage: "wsp servers remove <name> [<workspace>] [--on <computer>] --agent <id> [--scope <user|home|project>] [--project [<name>]]",
    about: "takes one MCP server's entry out of an agent's own config, every other line of the file as it was, and, once no agent's config on this computer lists that server, frees the vault's values kept for it that no other server holds",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" }, scope: { type: "string" }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers remove takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers remove needs --agent, the agent whose config names the server, as wsp servers shows it.", usageIs(ctx));
      const project = projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
      const scope = serverScope(flag(ctx.flags, "scope"), usageIs(ctx), project);
      const removed = await serverChanged(await ctx.client(), "servers.remove", { agent, name, ...scope }, workspace, flag(ctx.flags, "on"), usageIs(ctx), project.name);
      ctx.out.emit(removed, goneFromLine(name, removed.file));
      return 0;
    },
    tool: tool({
      description: `Takes one MCP server's entry out of one agent's own config on one computer or workspace, in the scope servers lists it under, every other server and line of the file as it was, and, once no agent's config on this computer lists that server, frees the vault's values kept for it that no other server holds. ${SERVER_CHANGE_WORDS}`,
      input: { name: ServerNameIn, agent: ServerAgentIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn, scope: ServerScopeIn, project: ServerProjectIn },
      output: { file: z.string() },
      call: async ({ name, agent, workspace, on, scope, project }, deps) => {
        const usage = aimedUsage("servers_remove");
        const asked = projectAsked(project, workspace, on, usage);
        const removed = await serverChanged(await deps.client(), "servers.remove", { agent, name, ...serverScope(scope, usage, asked) }, workspace, on, usage, asked.name);
        return asText(goneFromLine(name, removed.file), removed);
      },
    }),
  },
  ...(["disable", "enable"] as const).map(
    (word): Verb => ({
      name: `servers ${word}`,
      usage: `wsp servers ${word} <name> [<workspace>] [--on <computer>] --agent <id> [--scope <user|home|project>] [--project [<name>]]`,
      about: word === "disable" ? "turns one MCP server off by the switch its agent reads, so the agent leaves it out until it is turned on" : "turns an MCP server that was turned off on again",
      page: "agent",
      options: { agent: { type: "string" }, on: { type: "string" }, scope: { type: "string" }, project: { type: "string", valueWith: "on" } },
      run: async ctx => {
        const [name, workspace, ...rest] = ctx.args;
        const agent = flag(ctx.flags, "agent");
        if (name === undefined || rest.length > 0) throw usageRefusal(`wsp servers ${word} takes one server's name and one workspace at most.`, usageIs(ctx));
        if (agent === undefined) throw usageRefusal(`wsp servers ${word} needs --agent, the agent whose config names the server, as wsp servers shows it.`, usageIs(ctx));
        const project = projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
        const scope = serverScope(flag(ctx.flags, "scope"), usageIs(ctx), project);
        const changed = await serverChanged(await ctx.client(), "servers.toggle", { agent, name, ...scope, on: word === "enable" }, workspace, flag(ctx.flags, "on"), usageIs(ctx), project.name);
        ctx.out.emit(changed, turnedInLine(name, word === "enable", changed.file));
        return 0;
      },
      tool: tool({
        description: `Turns one MCP server ${word === "enable" ? "on again" : "off"} in one agent's own config on one computer or workspace, by the switch that agent reads (Codex's enabled line, OpenCode's enabled field, Gemini CLI's mcp.excluded); Claude Code keeps no such switch per server and is refused. ${SERVER_CHANGE_WORDS}`,
        input: { name: ServerNameIn, agent: ServerAgentIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn, scope: ServerScopeIn, project: ServerProjectIn },
        output: { file: z.string() },
        call: async ({ name, agent, workspace, on, scope, project }, deps) => {
          const usage = aimedUsage(`servers_${word}`);
          const asked = projectAsked(project, workspace, on, usage);
          const changed = await serverChanged(await deps.client(), "servers.toggle", { agent, name, ...serverScope(scope, usage, asked), on: word === "enable" }, workspace, on, usage, asked.name);
          return asText(turnedInLine(name, word === "enable", changed.file), changed);
        },
      }),
    }),
  ),
  {
    name: "projects",
    usage: "wsp projects",
    about: "your projects, each on its computer: where its code comes from, where its folder sits, the branch a machine of it starts on and how many threads it has",
    page: "front",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp projects takes no positional arguments.", usageIs(ctx));
      const client = await ctx.client();
      const projects = await projectsOf(client);
      const held = projects.length === 0 ? [] : await workspaces(client);
      const running = projects.length === 0 ? [] : await threads(client);
      // The computer's own name, off the one places reading every other table takes; a thread's token is refused
      // that list, and its rows then read the id, which is what it can name a computer by anyway.
      const named = projects.length === 0 ? new Map<string, string>() : await placeNames(client).catch(() => new Map<string, string>());
      const defaults = projects.length === 0 ? {} : await projectDefaultsOf(client);
      ctx.out.emit({ projects, defaults }, projects.length === 0 ? NO_PROJECT_YET : table([["PROJECT", "ID", "COMPUTER", "SOURCE", "PATH", "BASE", "THREADS", "NEW THREADS"], ...projects.map(p => [...projectLine(p, held, running, named), defaultsCell(defaults[p.id])])]).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Every project this host holds: its name, the computer it lives on, where its code comes from (a folder on the computer the app runs on, or a repo a computer clones), where its folder sits, the branch a machine of it starts on, and its repo's top folder where it is a folder here inside a git repo. The name is what run takes. A project is recorded with add and is one source on one computer; on the computer the app runs on its threads run in its folder, or in a worktree of its repo for another branch. defaults holds, by project id, the agent, model, effort and access a new thread there starts on when its start names none, each with where it came from: the project's own (projects_set), the person's default (agents_set, agents_default) or the agent's own.",
      input: {},
      output: { projects: z.array(ProjectView), defaults: z.record(z.string(), ThreadDefaults) },
      call: async (_args, deps) => {
        const client = await deps.client();
        return asJson({ projects: await projectsOf(client), defaults: await projectDefaultsOf(client) });
      },
    }),
  },
  {
    name: "projects add",
    toolOnly:
      "the command line records a project with wsp add, the same word that joins a computer and takes a provider's key; those two belong at the terminal the host runs at, so the tool door carries the project half alone",
    tool: tool({
      description:
        "Records a project: one source on one computer. A folder on the computer the app runs on is the project as it stands, a git repo or not, a folder inside a repo being a project of that repo; its threads run in it. A repo is cloned into the empty folder named with into on the computer the app runs on, which is then a folder project there, or by the computer named with on, whose machines then hold a checkout of it. A repo with neither into nor on, a folder to clone into that holds something, and a source already recorded on that computer are each refused in one line, and a clone that fails says git's own last line. The answer is the project, whose name is what run takes.",
      input: {
        source: z.string().describe("a folder on the computer the app runs on, or a repo's url"),
        on: z.string().optional().describe("the computer that clones the repo, by the name computers lists; a folder, and a repo cloned with into, take none"),
        into: z.string().optional().describe("an absolute path on the computer the app runs on, absent or an empty folder, to clone the repo into; the project is then that folder"),
        name: z.string().optional().describe("what to call the project here; the folder's or the repo's own last word without it"),
        base: z.string().optional().describe("the branch a machine of the project starts on; the remote's own default branch at the clone without it"),
      },
      output: { project: ProjectView, notice: z.string().optional() },
      call: async (args, deps) => {
        const client = await deps.client();
        const { project, notice } = await client.request<{ project: ProjectView; notice?: string }>("projects.add", {
          source: args.source,
          ...(args.on !== undefined ? { on: args.on } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.base !== undefined ? { base: args.base } : {}),
          ...(args.into !== undefined ? { into: args.into } : {}),
        });
        const named = await placeNames(client).catch(() => new Map<string, string>());
        // What landed and is not what was asked for rides the answer: an add that stands with the commits left
        // behind reads as an add that stands, and the caller has to be told which.
        const said = addedProjectLine(project, named, hostPlatform());
        return asText(notice === undefined ? said : `${said}\n${notice}`, { project, ...(notice !== undefined ? { notice } : {}) });
      },
    }),
  },
  {
    name: "projects remove",
    usage: "wsp projects remove <project>",
    about: "takes a project out of this wsp, with the folder wsp itself made for it on the computer holding it; a folder of yours on this computer is left where it is, and a project with a machine standing on it is refused naming them",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp projects remove takes one project.", usageIs(ctx));
      const client = await ctx.client();
      const project = await projectOf(client, ref);
      // The sentence comes off the wire: what a remove took is true differently on a computer of the person's, at
      // a provider and on this computer, and the runtime's own road for that computer is what says which.
      const { said } = await client.request<{ said: string }>("projects.remove", { projectId: project.id });
      ctx.out.emit({ project, said }, said);
      return 0;
    },
    tool: tool({
      description: `Takes a project's record out of this wsp, and with it the folder wsp itself made for the project on the computer holding it: its checkout there goes, and ${MEMORY_KEPT_CLAUSE}. A folder of yours on this computer stays exactly where it is, and no repo is ever asked for anything. Refused in one line while a machine of it stands, naming them; delete those first.`,
      input: { project: z.string().describe("the project's name, or its id when two share a name") },
      output: { project: ProjectView, said: z.string() },
      call: async ({ project: ref }, deps) => {
        const client = await deps.client();
        const project = await projectOf(client, ref);
        const { said } = await client.request<{ said: string }>("projects.remove", { projectId: project.id });
        return asText(said, { project, said });
      },
    }),
  },
  {
    name: "projects set",
    usage: "wsp projects set <project> [--agent <id>] [--model <slug>] [--effort <word>] [--access <word>] [--reset <field>]...",
    about: "what a new thread on one project starts on, over the agent's own defaults: its agent, model, effort and access",
    page: "agent",
    options: { agent: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, access: { type: "string" }, reset: { type: "string", multiple: true } },
    run: async ctx => {
      const [ref, ...rest] = ctx.args;
      if (ref === undefined || rest.length > 0) throw usageRefusal("wsp projects set takes one project.", usageIs(ctx));
      const set = await projectDefaultsSet(await ctx.client(), ref, {
        ...(flag(ctx.flags, "agent") !== undefined ? { agent: flag(ctx.flags, "agent")! } : {}),
        ...(flag(ctx.flags, "model") !== undefined ? { model: flag(ctx.flags, "model")! } : {}),
        ...(flag(ctx.flags, "effort") !== undefined ? { effort: flag(ctx.flags, "effort")! } : {}),
        ...(flag(ctx.flags, "access") !== undefined ? { access: flag(ctx.flags, "access")! } : {}),
        reset: flagList(ctx.flags, "reset"),
      });
      ctx.out.emit(set, [newThreadsHeadLine(set.project.name), ...threadDefaultsLines(set.defaults)].join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Sets what a new thread on one project starts on, over each agent's own defaults and under what a start names: its agent, model, effort and access. Nothing about a computer is a project's to set (threads at once, an agent's program, config folder, launch words, variables, or whether it is on); agents_setup sets those per computer. A model or effort kept for the project's agent drops to the agent's own on a thread that runs another agent, and an access word the project's agent maps to none of its modes is refused naming the ones it takes. Answers what a new thread there now starts on, each value with where it came from. reset puts a field back on the layer below: agent, model, effort or access.",
      input: {
        project: z.string().describe("the project's name, or its id when two share a name"),
        agent: z.string().optional().describe(`the agent a new thread on it runs, one of ${THREAD_AGENTS.join(", ")}`),
        model: z.string().optional().describe("the model a new thread on it starts on, by the agent's own slug"),
        effort: z.string().optional().describe("the effort a new thread on it starts at, by the agent's own word"),
        access: z.string().optional().describe(ACCESS_IN_WORDS),
        reset: z.array(z.enum(PROJECT_SET_RESETS)).optional().describe("fields to put back on the layer below: agent, model, effort, access"),
      },
      output: { project: ProjectView, defaults: ThreadDefaults },
      call: async ({ project, agent, model, effort, access, reset }, deps) => {
        const set = await projectDefaultsSet(await deps.client(), project, { ...(agent !== undefined ? { agent } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(access !== undefined ? { access } : {}), ...(reset !== undefined ? { reset } : {}) });
        return asText([newThreadsHeadLine(set.project.name), ...threadDefaultsLines(set.defaults)].join("\n"), set);
      },
    }),
  },
  {
    name: "threads",
    usage: "wsp threads [<project>] [--tree] [--watch]",
    about: "who is working, where and on which computer: every thread as the sidebar lists it, with its project, the folder it works in, that folder's branch, the agent, the state and who opened it, and under each thread the agent's own subagents with their TASK id; --tree indents the threads an agent spawned under the one that spawned them, and --watch draws the same table again every second where it stands",
    page: "front",
    options: { tree: { type: "boolean" }, watch: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp threads takes at most one project; wsp threads wait is its one subcommand, and wsp thread read <thread> prints what one said.", usageIs(ctx));
      return drawRows(ctx, "wsp threads", async client => {
        const rows = await threadRows(client, ctx.args[0]);
        const lines = ctx.flags["tree"] === true ? threadTree(rows).flatMap(t => threadLines(t.row, "  ".repeat(t.depth))) : rows.flatMap(t => threadLines(t));
        return { value: { threads: rows }, rows: table([THREAD_HEAD, ...lines]) };
      });
    },
    tool: tool({
      description:
        "Every thread as the sidebar lists it: its project, the folder it works in (the project folder, or a worktree of the project's repo), that folder's branch as git reads it now, the computer it runs on, the agent inside, its state, who opened it (person, cli or agent) and its title. Optionally within one project. A thread an agent inside another thread opened carries parentThreadId and rootThreadId, which is the tree stop ends as one. subagents lists the agent's own subagents of every turn (id, title, state running, done, failed or stopped); stop takes one of them alone by its id.",
      input: { project: z.string().optional().describe("one project's threads, by the name or the id projects lists") },
      output: { threads: z.array(ThreadRowOut) },
      call: async ({ project: within }, deps) => asJson({ threads: await threadRows(await deps.client(), within) }),
    }),
  },
  {
    name: "threads wait",
    usage: "wsp threads wait <thread>... [--timeout <s>] [--tail]",
    about:
      "blocks until one of the threads leaves running and prints its finished line, with the reply whole under it; --tail prints the reply's last line alone, which is what a notify sends, and --timeout gives up after so many seconds and says so on stderr",
    page: "agent",
    options: { timeout: { type: "string" }, tail: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length === 0) throw usageRefusal("wsp threads wait takes one thread or more.", usageIs(ctx));
      const timeoutMs = timeoutFlag(flag(ctx.flags, "timeout"));
      const named = await threadsOf(await ctx.client(), ctx.args);
      // The whole reply unless the tail was asked for: a last line is a paragraph's end or a code fence, and a
      // person waiting on a thread is waiting for its answer, not for the shape of its final line.
      const waited = await waitThrough(ctx, named, timeoutMs, () => ctx.io.error(HOST_RESTARTING_LINE));
      const { value, line } = waitAnswer(named, waited, ctx.flags["tail"] === true ? "tail" : "whole");
      if (value.timedOut === true) {
        ctx.out.emit(value);
        ctx.io.error(line);
      } else ctx.out.emit(value, line);
      return 0;
    },
    tool: tool({
      description: `Blocks until one of the named threads leaves running and answers with that thread's end: its id, status (completed, interrupted or failed), how long it worked, what it cost and the last line of its reply, the text being the one line a notify sends. One thread per call: a caller that started three builders calls this three times, dropping each returned id from the list, since a thread already over comes back at once and would come back again. With timeout, the seconds to wait before answering with nothing and timedOut true, so other work fits between calls; keep it under your own tool call limit and call again. This blocks, so it is for a shell script and not for your own conversation. ${NOTIFY_CALLER}. ${COORDINATOR_HANDOFF}. Never poll threads for a state change.`,
      input: {
        threads: z.array(z.string()).min(1).describe("thread ids, or prefixes that each pick one"),
        timeout: z.number().positive().optional().describe("seconds to wait; absent waits until one of the threads finishes"),
      },
      output: WaitOut.shape,
      call: async ({ threads: refs, timeout }, deps) => {
        const named = await threadsOf(await deps.client(), refs);
        const { value, line } = waitAnswer(named, await waitThrough(deps, named, timeout === undefined ? undefined : timeout * 1_000));
        return asText(line, value);
      },
    }),
  },
  {
    name: "recipe scan",
    readsHere: "the agents, package managers and history it reads are this computer's own",
    usage: "wsp recipe scan [--project <folder>]",
    about:
      "read this computer and print every option, writing nothing: the agents, the tools with why and size, what else a package manager here has that the image could take, the commands your agents ran, and the sign-ins, each with what to do about it and one line of why; --project weighs the histories by a folder and --json prints it as one object",
    page: "agent",
    options: { project: { type: "string", multiple: true } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp recipe scan takes no positional arguments.", usageIs(ctx));
      const host = nodeHost();
      const scan = await runScan(host, { ...projectsFlag(ctx.flags), cache: historyCache(ctx.statePath), ...(ctx.alsoHere !== undefined ? { alsoHere: ctx.alsoHere } : {}) }, progress(ctx.io));
      printTable(ctx, scan, depth => scanPrintout(scan, host.platform, depth), `Nothing was written. Take the do column with wsp recipe --set <id>=on and --signin <id>=machine, then run wsp init --recipe ${resolve(smallRecipePath(ctx.statePath))}.`);
      return 0;
    },
    tool: tool({
      description:
        "Every option this computer offers for a machine, read once and written nowhere: the person's agents and the catalog's tools with the tick their own use reaches and what each adds to the machine, what else a package manager on this computer has that the image could take (alsoHere, by manager, with the line that installs each on the machine, each row's id being the one to hand recipe's set, which ticks that package as a row of its own), whose scanned says whether anything looked, the commands their agents ran that the catalog does not carry, and the sign-in each ticked row brings. Every row carries a recommended value and a one-line reason, so apply those and put only the rows whose reason says worth a question. Run this before recipe, and before asking the person anything. Only names and counts are read.",
      input: { project: PROJECT_FOLDERS },
      output: RecipeScan.shape,
      call: async ({ project }, deps) => {
        const host = nodeHost();
        const scan = await runScan(host, {
          cache: historyCache(deps.statePath),
          ...(project !== undefined ? { projects: projectFolders(project) } : {}),
          ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
        });
        return asText(scanPrintout(scan, host.platform).join("\n"), scan);
      },
    }),
  },
  {
    name: "recipe",
    readsHere: "the agents, package managers and history it reads are this computer's own",
    usage: `wsp recipe [--tick ${RECIPE_TICKS.join("|")}] [--set <id>=on|off] [--signin <id>=${LOGIN_CHOICES.join("|")}] [--add <id>=<command>] [--add-check <id>=<command>] [--why <words>] [--engine] [--project <folder>] [--out <path>]`,
    about:
      `write the recipe and print it as a table: every catalog agent and tool with its tick, why it has it and what it costs on the machine, then the commands your agents ran that no catalog row carries. --tick used|installed|default names the rule that decides every tick (used, the default, ticks what your agents actually ran here); --set <id>=on|off flips a row by its catalog id, or a package this computer's own package managers have by the id wsp recipe scan gives it, which the build installs by that package's own road; --signin <id>=${LOGIN_CHOICES.join("|")} answers a sign-in by catalog id, later leaving it to the first time the tool is needed on the machine and key bringing the key files beside a login and nothing else of it; --add <id>=<command> carries a tool neither the catalog nor this computer has, installed by that command on the machine, with --add-check <id>=<command> saying it is there and --why <words> what the rows it adds are for; --engine marks the recipe so every machine from its image gets the place's Docker or podman through a socket of its own (a project whose compose file needs one), and stays in the file until you edit it out; --project reads a folder's own manifests for what it takes to build and weighs the histories by it, --out says where the file goes and --json prints the table as one object. Naming --tick or --project decides every tick again; without either, what the file says stands and the flags flip rows on top of it. A sign-in answer stands either way: no rule decides one. All of them repeat. Review it, then wsp init --recipe`,
    page: "agent",
    options: {
      out: { type: "string" },
      tick: { type: "string" },
      set: { type: "string", multiple: true },
      signin: { type: "string", multiple: true },
      add: { type: "string", multiple: true },
      "add-check": { type: "string", multiple: true },
      why: { type: "string" },
      engine: { type: "boolean" },
      project: { type: "string", multiple: true },
    },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp recipe takes no positional arguments; wsp recipe scan is its one subcommand.", usageIs(ctx));
      const why = flag(ctx.flags, "why");
      const tick = flag(ctx.flags, "tick");
      if (tick !== undefined && !isRecipeTick(tick)) throw usageRefusal(`--tick takes one of ${RECIPE_TICKS.join(", ")}, and got ${JSON.stringify(tick)}.`, "Name one of those.");
      const out = resolve(flag(ctx.flags, "out") ?? smallRecipePath(ctx.statePath));
      const table = await runRecipe(
        nodeHost(),
        {
          out,
          cache: historyCache(ctx.statePath),
          ...(tick !== undefined ? { tick } : {}),
          ...(ctx.flags["engine"] === true ? { engine: true } : {}),
          set: flagList(ctx.flags, "set"),
          signin: flagList(ctx.flags, "signin"),
          add: flagList(ctx.flags, "add"),
          addCheck: flagList(ctx.flags, "add-check"),
          ...(why !== undefined ? { why } : {}),
          ...projectsFlag(ctx.flags),
          ...(ctx.alsoHere !== undefined ? { alsoHere: ctx.alsoHere } : {}),
        },
        progress(ctx.io),
      );
      printTable(ctx, table, depth => recipePrintout(table, depth), `Recipe written to ${out}. Review it, flip a row with wsp recipe --set <id>=on, then run wsp init --recipe ${out}.`);
      return 0;
    },
    tool: tool({
      description: `The recipe for a machine, read off this computer and written to a file: every catalog agent and tool with its tick, why it has that tick, and what it adds to the machine, plus the commands the person's agents ran that no catalog row carries. tick names the rule: used ticks what their agents actually ran here, installed ticks what is on this computer, default ticks what the catalog ships on; an agent wsp cannot open a thread on is off unless installed. The file is the state, so a second call is not a fresh start: naming tick or project lets the rule decide every tick again and throws away the flips a call before it made, and a call that names neither keeps what the file says and puts its own flips on top. Sign-in answers stand through every call whatever the rule, since nothing but the person decides one. Put the heavy rows to the person with their sizes before anything is built, then flip rows with set and run \`wsp init --recipe <out> --non-interactive --json\` from a shell, handing the person each sign-in line it prints, since the sign-ins finish in their browser. Only names and counts are read; nothing a session held is returned.`,
      input: {
        tick: RecipeTick.optional().describe(`which rule decides every tick: ${RECIPE_TICKS.join(", ")}. Naming it re-decides every row from the rule, so any flip an earlier call made goes; absent, the file's own rule and its ticks stand, and used decides a first call and any row the file does not carry`),
        set: z.array(z.string()).optional().describe('rows to flip, "<id>=on" or "<id>=off", applied over whatever decided the row: a catalog id, or the id recipe_scan gives a package one of this computer\'s own package managers has (alsoHere), which ticks that package as a row of its own and installs it by its own road. On a call that names tick or project they sit over the rule\'s fresh answer; on any other call they sit over the ticks already in the file'),
        signin: z.array(z.string()).optional().describe(`what happens to a row's sign-in, "<id>=${LOGIN_CHOICES.join("|")}"; key brings the key files beside its login and the login still runs on the machine. An answer already in the file stands until a later call names that row again, whatever tick or project do to the ticks`),
        add: z.array(z.string()).optional().describe('tools neither the catalog carries nor this computer has, "<id>=<install command>"; the line runs on the machine as given after every catalog install, and such a row is never offered a sign-in. A package recipe_scan already lists under alsoHere is refused here and ticked with set instead, since it is a row of its own. Rows an earlier call added stand, whatever tick or project do to the ticks'),
        add_check: z.array(z.string()).optional().describe('what proves an added tool landed, "<id>=<command that exits 0>"; without one the id on PATH is the check'),
        why: z.string().optional().describe("what the rows this call adds are for, in your own words; absent, they say an agent added them"),
        engine: z.boolean().optional().describe("mark the recipe so every machine from its image gets the place's container engine (Docker or podman) through a socket of its own, for a project whose compose file needs one; it stays in the file until edited out"),
        project: WEIGH_BY_FOLDERS,
        out: z.string().optional().describe("where the recipe file goes, absolute; absent means the host's own recipe.json beside its state"),
      },
      output: RecipeAnswer.shape,
      call: async ({ tick, set, signin, add, add_check: addCheck, why, engine, project, out }, deps) => {
        const table = await runRecipe(nodeHost(), {
          out: out === undefined ? smallRecipePath(deps.statePath) : absolutePath("out is a path on this computer", out),
          cache: historyCache(deps.statePath),
          ...(tick !== undefined ? { tick } : {}),
          ...(set !== undefined ? { set } : {}),
          ...(signin !== undefined ? { signin } : {}),
          ...(add !== undefined ? { add } : {}),
          ...(addCheck !== undefined ? { addCheck } : {}),
          ...(why !== undefined ? { why } : {}),
          ...(engine === true ? { engine: true } : {}),
          ...(project !== undefined ? { projects: projectFolders(project) } : {}),
          ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
        });
        return asText(recipePrintout(table).join("\n"), table);
      },
    }),
  },
  {
    name: "workspaces agents",
    usage: "wsp workspaces agents <workspace> [--spawn on|off] [--max-machines <n>] [--max-depth <n>]",
    about: "what the agents inside the workspace may ask of this host: threads and machines under the thread they run in, capped, which is the default, or off",
    page: "agent",
    options: { spawn: { type: "string" }, "max-machines": { type: "string" }, "max-depth": { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp workspaces agents takes one workspace.", usageIs(ctx));
      const asked = agentsAsked(flag(ctx.flags, "spawn"), flag(ctx.flags, "max-machines"), flag(ctx.flags, "max-depth"));
      if (asked === undefined) throw usageRefusal(AGENTS_ASKED_NOTHING_LINE, usageIs(ctx));
      const workspace = await setAgents(await ctx.client(), ref, asked);
      ctx.out.emit({ workspace }, `${workspace.name}: ${agentsLine(workspace.agents)}`);
      return 0;
    },
    tool: tool({
      description:
        "Turns the workspace's agents switch on or off, names its caps, or both; a cap named alone tightens the switch as it stands. Every turn on a workspace is launched with a token into this host scoped to its own thread. With the switch on, which is what every workspace reads as until it is turned off, that thread may open threads and fork machines under itself, up to maxMachines machines at once under one root thread and maxDepth levels deep, and may touch no other workspace, delete nothing, pause nothing and pair no computer. On this Mac the token is identity, not confinement: a thread there runs as the person and can read the host's own token file. Off, each of those acts is refused in one line. A caller that is itself a thread on a machine is refused: what agents may do is the person's to decide.",
      input: { workspace: WorkspaceIn, spawn: SpawnIn, max_machines: MaxMachinesIn, max_depth: MaxDepthIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref, spawn, max_machines: maxMachines, max_depth: maxDepth }, deps) => {
        const asked = agentsAsked(spawn, maxMachines, maxDepth);
        if (asked === undefined) throw agentsToolAskedNothing();
        const workspace = await setAgents(await deps.client(), ref, asked);
        return asText(`${workspace.name}: ${agentsLine(workspace.agents)}`, { workspace });
      },
    }),
  },
  {
    name: "rename",
    usage: 'wsp rename <workspace> "<name>"',
    about: "names the workspace on this computer; the name is unique here, so one another workspace holds is refused",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref, name] = ctx.args;
      if (ref === undefined || name === undefined || ctx.args.length !== 2) throw usageRefusal("wsp rename takes a workspace and one name.", usageIs(ctx));
      const renamed = await renameWorkspace(await ctx.client(), ref, name);
      ctx.out.emit(renamed, renamedWorkspaceLine(renamed));
      return 0;
    },
    tool: tool({
      description:
        "Names the workspace on this computer, the name the sidebar and every listing show and the one workspace takes. A name is unique here, since that is how a workspace is addressed, so a name another workspace holds and a blank one are refused in one line and nothing is renamed. Threads on the machine are addressed by id and run on through it, and the machine at the provider keeps the metadata name it was forked under until it is next forked or rebuilt.",
      input: { workspace: WorkspaceIn, name: z.string() },
      output: { was: z.string(), workspace: WorkspaceOut },
      call: async ({ workspace: ref, name }, deps) => {
        const renamed = await renameWorkspace(await deps.client(), ref, name);
        return asText(renamedWorkspaceLine(renamed), { ...renamed });
      },
    }),
  },
  {
    name: "snapshot",
    cloud: true,
    usage: "wsp snapshot <workspace>",
    about: "a project image of the workspace: your image plus the project as it is now, ready to fork",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp snapshot takes one workspace.", usageIs(ctx));
      const projectGolden = await snapshot(await ctx.client(), ref);
      ctx.out.emit({ projectGolden }, projectGoldenLine(projectGolden));
      return 0;
    },
    tool: tool({
      description: "A project image of the workspace: its image version plus the project loaded on it as its disk stands now, synced first so a file written just before is whole on the image, ready for new with from. Only a running machine with a project imported, on a provider that copies a machine's disk, can be snapshotted, and which life the copy may come from is that provider's rule: a machine that was never resumed on the cloud, any life on a container fork. Anything else, and a disk whose sync fails, is refused in one line and nothing is taken.",
      input: { workspace: WorkspaceIn },
      output: { projectGolden: ProjectGolden },
      call: async ({ workspace: ref }, deps) => asJson({ projectGolden: await snapshot(await deps.client(), ref) }),
    }),
  },
  {
    name: "fork",
    cloud: true,
    usage: 'wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>] [--send "<task>" [run\'s flags]]',
    about: "a new machine from the source's image version, not a copy of its live disk; --size as new's",
    page: "agent",
    options: { name: { type: "string" }, size: { type: "string" }, send: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS, cwd: { type: "string" }, notify: { type: "string", multiple: true }, spawn: { type: "string" }, "max-machines": { type: "string" }, "max-depth": { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp fork takes one workspace.", usageIs(ctx));
      const task = flag(ctx.flags, "send");
      for (const dependent of ["agent", ...PICK_FLAGS, "cwd", "notify"]) if (task === undefined && flag(ctx.flags, dependent) !== undefined) throw usageRefusal(`--${dependent} says how a thread opens, and this line opens none.`, `Add --send "<task>", or drop --${dependent}.`);
      const client = await ctx.client();
      const harness = flag(ctx.flags, "agent");
      const picks = pickFlags(ctx.flags);
      // Resolved and checked before the machine is minted, so a bad reference or pick costs nothing. The picks are
      // checked against the source's machine, since the fork's own comes from the golden that machine runs.
      const reads = async (): Promise<{ source: WorkspaceView; notify: string[] | undefined }> => {
        const source = await workspaceOf(client, ref);
        if (workspaceState({ phase: source.phase }) === "gone") throw new Error(goneRefusal(source.name, "fork", source.gone));
        const notify = await notifyOf(client, flagList(ctx.flags, "notify"));
        if (task !== undefined) await checkedStart(client, task, harness, picks, source.id);
        return { source, notify };
      };
      const { source, notify } = task === undefined ? await reads() : await beforeSending(client, reads);
      const asked = agentsAsked(flag(ctx.flags, "spawn"), flag(ctx.flags, "max-machines"), flag(ctx.flags, "max-depth"));
      const created = await createFor(client, ctx.out, await projectOf(client, source.project.id), flag(ctx.flags, "name") ?? `${source.name}-fork`, { parent: source.id, ...(flag(ctx.flags, "size") !== undefined ? { size: flag(ctx.flags, "size")! } : {}), ...(asked !== undefined ? { agents: asked } : {}) });
      if (task === undefined) return 0;
      ctx.out.emit({ turn: turnView(await followVerb(ctx, client, openingOf(ctx.env, created.workspace, task, { harness, ...picks, cwd: flag(ctx.flags, "cwd"), notify, elsewhere: ctx.elsewhere }), true, {}, { spend: turnSpendWord(created.workspace) })) });
      return 0;
    },
    tool: tool({
      description: "A sibling workspace from the source's image version (a new machine, not a copy of its live disk); with a task, its first thread is opened and the reply returned. When that first turn fails, the error still names the workspace, which exists: continue with run on it rather than forking again.",
      input: { workspace: WorkspaceIn, name: z.string().optional().describe("defaults to <source>-fork"), size: SizeIn, task: z.string().optional(), agent: AgentIn, ...PICK_INPUTS, cwd: CwdIn, notify: NotifyIn, spawn: SpawnIn, max_machines: MaxMachinesIn, max_depth: MaxDepthIn },
      output: Created.extend({ turn: TurnOut.optional(), failure: z.string().optional() }).shape,
      stream: ["workspace", "notice"],
      call: async ({ workspace: ref, name, size: word, task, agent: harness, cwd: folder, notify: tell, spawn, max_machines: maxMachines, max_depth: maxDepth, ...input }, deps) => {
        absoluteFolder(folder);
        const client = await deps.client();
        const reads = async (): Promise<WorkspaceView> => {
          const source = await workspaceOf(client, ref);
          if (task !== undefined) await checkedStart(client, task, harness, input, source.id);
          return source;
        };
        const source = task === undefined ? await reads() : await beforeSending(client, reads);
        const asked = agentsAsked(spawn, maxMachines, maxDepth);
        const created = await createFor(client, QUIET, await projectOf(client, source.project.id), name ?? `${source.name}-fork`, { parent: source.id, ...(word !== undefined ? { size: word } : {}), ...(asked !== undefined ? { agents: asked } : {}) });
        if (task === undefined) return asJson(created);
        let failure: string;
        try {
          const turn = await follow(client, openingOf(deps.env, created.workspace, task, { harness, ...input, cwd: folder, notify: await notifyOf(client, tell ?? []), elsewhere: deps.elsewhere }), "agent", QUIET_TURN, () => hostBack(deps));
          const ended = turnFailure(turn);
          if (ended === undefined) return asJson({ ...created, turn: turnView(turn) });
          failure = ended;
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }
        // The machine was minted before the turn failed; an error that hid it would have the agent fork a second one.
        return { ...asText(`created ${created.workspace.name} ${created.workspace.id}; first turn failed: ${failure}`, { ...created, failure }), isError: true };
      },
    }),
  },
  {
    name: "commit",
    usage: 'wsp commit <workspace> [--message "<message>"] [--file <path>]...',
    about: "commits the files the workspace's copy changed, or the ones named; without a message its agent drafts one",
    page: "agent",
    options: { message: { type: "string", short: "m" }, file: { type: "string", multiple: true } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp commit takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const { workspace: awoken } = await awake(client, workspace, "commit", line => ctx.io.error(line));
      const made = await committed(client, awoken.id, flag(ctx.flags, "message"), flagList(ctx.flags, "file"), line => ctx.io.error(line));
      ctx.out.emit({ ...made }, committedLine(awoken.name, made));
      return 0;
    },
    tool: tool({
      description:
        "Commits the files the workspace's copy changed against its last commit, untracked ones added, with the message given, running the copy's hooks as git does; files names some of them by path from the checkout's top and leaves the rest uncommitted. Without a message the workspace's own agent drafts one from the diff and the task its newest thread was opened with, on its own command line with no thread and no tool, and the commit is made with that. Refused in one line when a file named has no change, when git knows no author in the copy (with the command that sets one), when a hook said no (with its last line), and when another git in the copy holds the index after one wait. Nothing reaches a remote: the app's Push is what pushes.",
      input: {
        workspace: WorkspaceIn,
        message: z.string().optional().describe("the commit message, a subject line then a blank line and the body; without one the workspace's agent drafts it"),
        files: z.array(z.string()).optional().describe("the files to commit, by path from the checkout's top as git status names them; without it every changed file"),
      },
      output: GitCommitReply.shape,
      call: async ({ workspace: ref, message, files }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const { workspace: awoken } = await awake(client, workspace, "commit", QUIET_LINE);
        const made = await committed(client, awoken.id, message, files ?? [], () => {});
        return asText(committedLine(awoken.name, made), { ...made });
      },
    }),
  },
  {
    name: "discard",
    usage: "wsp discard <workspace> <path>",
    about: "puts one changed file of the workspace's copy back as its last commit has it, or removes it where that has none",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref, path] = ctx.args;
      if (ref === undefined || path === undefined || ctx.args.length !== 2) throw usageRefusal("wsp discard takes one workspace and one file.", usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const { workspace: awoken } = await awake(client, workspace, "discard", line => ctx.io.error(line));
      const put = GitDiscardReply.parse(await client.request("workspaces.discard", { workspaceId: awoken.id, path }));
      ctx.out.emit({ ...put }, discardedLine(awoken.name, put.path));
      return 0;
    },
    tool: tool({
      description:
        "Puts one changed file of the workspace's copy back as its last commit has it: an edit or a deletion is undone, a rename takes its new name away and brings the old one back, and a file the last commit does not have is removed. Only the file named moves, and it cannot be undone. Refused in one line when the file has no change.",
      input: { workspace: WorkspaceIn, path: z.string().describe("the file, by path from the checkout's top as git status names it") },
      output: GitDiscardReply.shape,
      call: async ({ workspace: ref, path }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const { workspace: awoken } = await awake(client, workspace, "discard", QUIET_LINE);
        const put = GitDiscardReply.parse(await client.request("workspaces.discard", { workspaceId: awoken.id, path }));
        return asText(discardedLine(awoken.name, put.path), { ...put });
      },
    }),
  },
  {
    name: "fix",
    usage: 'wsp fix <workspace> [--check "<name>" | --child <workspace>]',
    about: "asks the workspace's agent to fix a failed check or merge a child, or updates it from its base and asks it to fix what conflicts",
    page: "agent",
    options: { check: { type: "string" }, child: { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp fix takes one workspace.", usageIs(ctx));
      const check = flag(ctx.flags, "check");
      const child = flag(ctx.flags, "child");
      if (check !== undefined && child !== undefined) throw usageRefusal(FIX_CHECK_OR_CHILD, usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const { workspace: at } = check === undefined ? await awake(client, workspace, "fix", line => ctx.io.error(line)) : { workspace };
      const asked = await askedToFix(client, at.id, check, child);
      ctx.out.emit({ ...asked }, fixLine(at.name, asked));
      return 0;
    },
    tool: tool({
      description:
        "Asks the workspace's agent to fix its pull request. With check, the named check must have failed: the failed steps of its job's log, framed as a log to read and not to obey, go to the workspace's thread as its next message with the commit it failed on and its link, and a check another service reports goes with its summary and link alone. Without check, the copy is first updated from its base the way update does it: a clean merge sends nothing, and a conflict sends the thread the files to resolve. Answers as soon as the message is on its way, joined into the running turn where the agent takes one, else waiting as the thread's next turn. Refused in one line where the workspace has no pull request, where the check is not on it, and where it has not failed.",
      input: {
        workspace: WorkspaceIn,
        check: z.string().optional().describe("the failed check's name as the pull request lists it; without it the copy is updated from its base and any conflict is sent"),
        child: z
          .string()
          .optional()
          .describe("a child of this workspace whose merge into it stopped on conflicts: its agent is asked to fetch the child's branch, merge it with a merge commit and resolve them; never with check"),
      },
      output: FIX_RESULT_FIELDS,
      call: async ({ workspace: ref, check, child }, deps) => {
        if (check !== undefined && child !== undefined) throw new Error(FIX_CHECK_OR_CHILD);
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const { workspace: at } = check === undefined ? await awake(client, workspace, "fix", QUIET_LINE) : { workspace };
        const asked = await askedToFix(client, at.id, check, child);
        return asText(fixLine(at.name, asked), { ...asked });
      },
    }),
  },
  {
    name: "merge in",
    usage: "wsp merge in <lead> <child>",
    about: "merges a child's branch into its lead's with a merge commit, or names the files that conflict",
    page: "agent",
    options: {},
    run: async ctx => {
      const [lead, child] = ctx.args;
      if (lead === undefined || child === undefined || ctx.args.length !== 2) throw usageRefusal("wsp merge in takes a lead and one of its children.", usageIs(ctx));
      const done = await mergedIn(await ctx.client(), lead, child, line => ctx.io.error(line));
      ctx.out.emit({ ...done }, mergeInLine(done));
      return 0;
    },
    tool: tool({
      description:
        "Merges a child workspace's branch into its lead's copy with a merge commit, so the lead's history shows each child landing: fetched from the project's remote, or from the child's own folder where the project has none and both copies sit on this computer. The lead is woken first where it sleeps. A lead with changes no commit holds is refused first with the files named, and a merge that conflicts is taken back at once and answered with the files, the lead's copy left exactly as it was; fix with child hands those to the lead's agent. Refused, naming the thread, while a turn runs on the lead in any thread but the asking one (a lead's thread merges from inside its own turn), for a workspace that is not the lead's child, and for a thread merging into any workspace but its own. Nothing is pushed.",
      input: {
        lead: WorkspaceIn,
        child: z.string().describe("the child workspace whose branch is merged in, by name or id"),
      },
      output: MergeInResult.shape,
      call: async ({ lead, child }, deps) => {
        const done = await mergedIn(await deps.client(), lead, child, QUIET_LINE);
        return asText(mergeInLine(done), { ...done });
      },
    }),
  },
  {
    name: "merge",
    usage: "wsp merge <workspace> [--method merge|squash|rebase] [--when-checks-pass]",
    about: "merges the workspace's pull request, or merges it once its checks pass",
    page: "agent",
    options: { method: { type: "string" }, "when-checks-pass": { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp merge takes one workspace.", usageIs(ctx));
      const named = flag(ctx.flags, "method");
      const method = named === undefined ? undefined : MergeMethod.safeParse(named);
      if (method !== undefined && !method.success) throw usageRefusal(`--method takes merge, squash or rebase, and got ${named}.`, usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const merged = await mergedPr(client, workspace.id, method?.data, ctx.flags["when-checks-pass"] === true);
      ctx.out.emit({ ...merged }, mergedLine(workspace.name, merged));
      return 0;
    },
    tool: tool({
      description:
        "Merges the workspace's pull request as the person, by the method named or the repository's own default, and only while its head is still the commit the host last read, so a push since then fails it in the git host's own words. when_checks_pass arms it to merge once its checks pass instead, where the repository allows that. Answers with the number, the method, and whether it merged now or waits on its checks. Refused in one line where the workspace has no open pull request, where the repository does not allow the method or does not merge by itself, and with the git host's own reason where it refused, branch protection included. A thread's own token is refused: merging is the person's act.",
      input: {
        workspace: WorkspaceIn,
        method: MergeMethod.optional().describe("merge, squash or rebase; without it the repository's default"),
        when_checks_pass: z.boolean().optional().describe("merge once the checks pass rather than now, where the repository allows it"),
      },
      output: MergeResult.shape,
      call: async ({ workspace: ref, method, when_checks_pass }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const merged = await mergedPr(client, workspace.id, method, when_checks_pass === true);
        return asText(mergedLine(workspace.name, merged), { ...merged });
      },
    }),
  },
  {
    name: "start",
    usage: "wsp start <link> [--project <name>] [--agent <id>] [--model, --effort, --access <word>]",
    about: "a thread off a GitHub issue or pull request link, the issue or the pull request its first message; an issue's thread runs in the project folder, a pull request's in a worktree on its branch",
    page: "agent",
    options: { project: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS },
    run: async ctx => {
      const [url] = ctx.args;
      if (url === undefined || ctx.args.length !== 1) throw usageRefusal("wsp start takes one link.", usageIs(ctx));
      const client = await ctx.client();
      const started = await startedFrom(client, { url, project: flag(ctx.flags, "project"), agent: flag(ctx.flags, "agent"), model: flag(ctx.flags, "model"), effort: flag(ctx.flags, "effort"), access: flag(ctx.flags, "access") });
      ctx.out.emit({ ...started }, startedLines(started));
      return 0;
    },
    tool: tool({
      description:
        "Opens a thread off a GitHub issue or pull request link, returning as soon as the thread is started. The link names the repository, and the project here whose remote is that repository is the one used (project names one where two computers hold it); a link no project matches is refused naming the repository and the add line. The issue's or pull request's title, description, comments and link are the thread's first message, and an issue's thread is asked to have its pull request close the issue. On the computer the app runs on an issue's thread runs in the project folder, and a pull request's head is fetched into the project's repo as a branch and its thread runs in a worktree on it, so the project folder's checkout never moves. A thread's own token is refused: starting work from a link is the person's act.",
      input: {
        link: z.string().describe("a GitHub issue or pull request link, https://github.com/<owner>/<repo>/issues/<n> or /pull/<n>"),
        project: z.string().optional().describe("the project by name or id where two projects hold the repository; absent is this computer's"),
        agent: AgentIn,
        ...PICK_INPUTS,
      },
      output: StartResult.shape,
      call: async ({ link, project, agent, model, effort, access }, deps) => {
        const started = await startedFrom(await deps.client(), { url: link, project, agent, model, effort, access });
        return asText(startedLines(started, id => openedThreadLine(id, undefined)), { ...started });
      },
    }),
  },
  {
    name: "review",
    usage: "wsp review <link|workspace> [--agent <id>] [--model, --effort <word>]",
    about: "a reviewer thread on a pull request, read-only, whose review waits in wsp until you post it",
    page: "agent",
    options: { agent: { type: "string" }, model: { type: "string" }, effort: { type: "string" } },
    run: async ctx => {
      const [target] = ctx.args;
      if (target === undefined || ctx.args.length !== 1) throw usageRefusal("wsp review takes one pull request link or workspace.", usageIs(ctx));
      const client = await ctx.client();
      const on = /^https?:\/\//.test(target) ? { url: target } : { workspaceId: (await workspaceOf(client, target)).id };
      const started = await reviewStarted(client, { ...on, agent: flag(ctx.flags, "agent"), model: flag(ctx.flags, "model"), effort: flag(ctx.flags, "effort") });
      ctx.out.emit({ ...started }, startedLines(started));
      return 0;
    },
    tool: tool({
      description:
        "Starts a reviewer thread on a pull request, off its link or off a workspace's own pull request, and returns as soon as the thread is started. The reviewer works in a fresh copy at the pull request's head, at its agent's read-only access (Codex unless another is named; an agent with no read-only access is refused naming the ones that have one), with the description, the diff against the base and the repository's own review rules in its task. Its reply ends in a review the host keeps as the workspace's draft; nothing reaches the git host until review_post. A thread's own token is refused.",
      input: {
        target: z.string().describe("a GitHub pull request link, or the workspace whose pull request to review"),
        agent: z.string().optional().describe("the reviewing agent, codex or claude; absent is codex"),
        model: PICK_INPUTS.model,
        effort: PICK_INPUTS.effort,
      },
      output: StartResult.shape,
      call: async ({ target, agent, model, effort }, deps) => {
        const client = await deps.client();
        const on = /^https?:\/\//.test(target) ? { url: target } : { workspaceId: (await workspaceOf(client, target)).id };
        const started = await reviewStarted(client, { ...on, agent, model, effort });
        return asText(startedLines(started, id => openedThreadLine(id, undefined)), { ...started });
      },
    }),
  },
  {
    name: "review post",
    usage: 'wsp review post <workspace> [--verdict comment|approve|request-changes] [--summary "<text>"]',
    about: "posts a review workspace's review on its pull request as you, its ticked comments on their lines",
    page: "agent",
    options: { verdict: { type: "string" }, summary: { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp review post takes one workspace.", usageIs(ctx));
      const named = flag(ctx.flags, "verdict");
      const verdict = named === undefined ? undefined : VERDICTS[named];
      if (named !== undefined && verdict === undefined) throw usageRefusal(`--verdict takes comment, approve or request-changes, and got ${named}.`, usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const posted = await reviewPosted(client, workspace.id, { ...(verdict !== undefined ? { verdict } : {}), ...(flag(ctx.flags, "summary") !== undefined ? { summary: flag(ctx.flags, "summary")! } : {}) });
      ctx.out.emit({ ...posted }, START_WORDS.posted(workspace.name, posted.number, posted.comments, posted.folded));
      return 0;
    },
    tool: tool({
      description:
        "Posts a review workspace's review on its pull request as the person, in one call: the verdict, the summary and every ticked comment on its line, pinned to the head the review was written against. verdict and summary edit the draft first. A comment on a line outside the diff goes into the summary, since the git host takes none there. Refused in one line where the workspace has no review yet, and with the git host's own reason where it refused, approving one's own pull request included. A thread's own token is refused: posting under the person's name is the person's act.",
      input: {
        workspace: WorkspaceIn,
        verdict: z.enum(["comment", "approve", "request_changes"]).optional().describe("comment, approve or request_changes; absent is the draft's"),
        summary: z.string().optional().describe("the review's summary; absent is the draft's"),
      },
      output: ReviewPostResult.shape,
      call: async ({ workspace: ref, verdict, summary }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const posted = await reviewPosted(client, workspace.id, { ...(verdict !== undefined ? { verdict } : {}), ...(summary !== undefined ? { summary } : {}) });
        return asText(START_WORDS.posted(workspace.name, posted.number, posted.comments, posted.folded), { ...posted });
      },
    }),
  },
  {
    name: "update",
    usage: "wsp update <workspace>",
    about: "merges the latest commits of the workspace's base into its branch, or names the files that conflict",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp update takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const { workspace: awoken } = await awake(client, workspace, "update", line => ctx.io.error(line));
      const done = GitUpdateReply.parse(await client.request("workspaces.update", { workspaceId: awoken.id }));
      ctx.out.emit({ ...done }, updateLine(awoken.name, done));
      return 0;
    },
    tool: tool({
      description:
        "Merges the latest commits of the workspace's base from the remote into the branch its copy is on, with a merge commit, so a branch already pushed is never rewritten. A copy with changes no commit holds is refused first with the files named. A merge that conflicts is taken back at once and answered with the files that conflict, the copy left exactly as it was; fix sends those to the agent. Nothing is pushed.",
      input: { workspace: WorkspaceIn },
      output: GitUpdateReply.shape,
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const { workspace: awoken } = await awake(client, workspace, "update", QUIET_LINE);
        const done = GitUpdateReply.parse(await client.request("workspaces.update", { workspaceId: awoken.id }));
        return asText(updateLine(awoken.name, done), { ...done });
      },
    }),
  },
  {
    name: "pause",
    usage: "wsp pause <workspace>",
    about: "naps the workspace's machine",
    page: "front",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp pause takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const workspace = await nap(client, ref);
      ctx.out.emit({ workspace }, stateLine(workspace, await pauseModeOf(client, workspace.project.id)));
      return 0;
    },
    tool: tool({
      description: "Naps the workspace's machine; it wakes on the next thread or command.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref }, deps) => asJson({ workspace: await nap(await deps.client(), ref) }),
    }),
  },
  {
    name: "wake",
    usage: "wsp wake <workspace>",
    about: "wakes the workspace's machine and prints the state the next wsp workspaces will show for it",
    page: "front",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp wake takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const { workspace } = await awake(client, await workspaceOf(client, ref), "wake", line => ctx.io.error(line));
      ctx.out.emit({ workspace }, await wokeLine(client, workspace));
      return 0;
    },
    tool: tool({
      description: "Wakes the workspace's machine and returns its view once the runtime has answered; one already running comes back unchanged. run, send and exec do this themselves, so it is only needed to wake a machine ahead of them.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        return asJson({ workspace: (await awake(client, await workspaceOf(client, ref), "wake", QUIET_LINE)).workspace });
      },
    }),
  },
  {
    name: "rebuild",
    cloud: true,
    usage: "wsp rebuild <workspace>",
    about: "replaces a gone workspace's machine from its image and prints the state of the new one",
    page: "app",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp rebuild takes one workspace.", usageIs(ctx));
      const workspace = await rebuild(await ctx.client(), ref);
      ctx.out.emit({ workspace }, rebuiltLine(workspace));
      return 0;
    },
    tool: tool({
      description:
        "Replaces the machine of a workspace the provider no longer has, forking it afresh from the image the workspace was made on and importing the vault its last nap left; the workspace keeps its id, its name and its threads, and the new machine's id and state come back once the runtime has them. Anything written on the old machine's disk since that nap is not there. This is the road out of the refusal every other verb gives a gone workspace, and it is refused in one line on a machine that still answers.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref }, deps) => {
        const workspace = await rebuild(await deps.client(), ref);
        return asText(rebuiltLine(workspace), { workspace });
      },
    }),
  },
  {
    name: "image",
    usage: "wsp image",
    about: "the image this host owns: its version, its hash, whether it holds your sign-ins, and the copy each place has built of it",
    page: "agent",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp image takes no positional arguments.", usageIs(ctx));
      const view = await imageView(await ctx.client());
      ctx.out.emit(view, imageLines(view).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The image this host owns and the copy each place has built of it. The record is the recipe the seal was planned from, the sign-ins it holds and a hash over both; a copy built at that hash is current and any other is stale, whatever version the place's own manifest gave it. A record with no vault was read back off its own copy rather than written at a seal, so it judges none of them and every copy of it asks for the sign-ins again: cutting the next version holds them. The project images taken off workspaces are listed under it, each with its snapshot id, the workspace it was taken off, its size where the provider lists one and its date.",
      input: {},
      output: { image: SealedImage.nullable(), copies: z.array(SealedImageCopy), projects: z.array(SealedProjectImage) },
      call: async (_args, deps) => {
        const view = await imageView(await deps.client());
        return asText(imageLines(view).join("\n"), view);
      },
    }),
  },
  {
    name: "image build",
    cloud: true,
    usage: "wsp image build <place> [--force]",
    about: "builds this host's image at a place from the record, its sign-ins coming from the vault and no sign-in run again",
    page: "agent",
    options: { force: { type: "boolean" } },
    run: async ctx => {
      const [place] = ctx.args;
      if (place === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image build takes one place.", usageIs(ctx));
      const { image, built } = await buildImageAt(await ctx.client(), ctx.out, place, ctx.flags["force"] === true);
      ctx.out.emit(built, sealedBuiltLine(image, built));
      return 0;
    },
    tool: tool({
      description:
        "Builds this host's image at a place from the record alone: a builder is forked there with the recipe the image was sealed from and every sign-in set to skip, the sign-ins the seal held are landed on it out of the vault, and the copy is sealed and recorded under that place at the record's hash. Nothing signs in again and no Keychain is read. A place that already holds a copy built from this record is answered with that copy and `built` false, so asking twice costs nothing; a place whose copy is building is answered with that build, never a second one. A joined computer builds its copy at the end of its setup; every other copy, and every copy a newer version left behind, is built only when this line asks or when a fork there finds no current copy, and that fork says so before the build starts, since a build bills where it runs. Refused in one line for a place this host does not hold, for a place that takes no copy at all, and for a record sealed without the recipe it was built from. A record holding no sign-ins is refused too, since every copy of it would ask for them again; `force` builds it anyway.",
      input: { place: z.string().describe("the place to build the copy at, by the name wsp places lists"), force: z.boolean().optional().describe("build even where the record holds no sign-ins, so the copy asks for every one of them again") },
      output: { copy: SealedImageCopy, built: z.boolean() },
      call: async ({ place, force }, deps) => {
        const { image, built } = await buildImageAt(await deps.client(), QUIET, place, force);
        return asText(sealedBuiltLine(image, built), built);
      },
    }),
  },
  {
    name: "image export",
    cloud: true,
    usage: "wsp image export <file>",
    about: "writes the image record and your sign-ins to one encrypted file, sealed to a passphrase you type",
    page: "agent",
    options: {},
    cliOnly: "the vault leaves the host only at a person's hand, with a passphrase they type",
    hostSide: HOST_SIDE_VAULT,
    run: async ctx => {
      const [dest] = ctx.args;
      if (dest === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image export takes one file on this computer.", usageIs(ctx));
      const passphrase = await imagePassphrase(ctx);
      const { exported } = await (await ctx.client()).request<{ exported: SealedImageExport }>("image.export", { dest: resolve(dest), passphrase });
      ctx.out.emit({ exported }, sealedExportLine(exported));
      return 0;
    },
  },
  {
    name: "image move",
    cloud: true,
    usage: "wsp image move <workspace>",
    about: "moves the workspace onto the newest version of its image and prints what of the image's own files it kept",
    page: "app",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image move takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const source = await workspaceOf(client, ref);
      ctx.io.error(IMAGE_MOVE_CONFIRM);
      const moved = await moveImage(client, source.id);
      ctx.out.emit(moved, imageMovedLine(moved));
      return 0;
    },
    tool: tool({
      description:
        "Moves the workspace onto the newest version of the image it was forked from: a fresh machine of that image replaces the old one and the workspace's home folder comes across, less the files the image itself wrote and nobody changed here, whose newer copies come with the image. `kept` names the files of the image's own this workspace had changed, which travelled instead. An archive carries no deletion, so a file taken out of a folder the image writes into comes back with the new image. Anything installed outside the home folder comes from the new image, and everything running on the old machine stops with it. Refused in one line on a workspace that is not running, one forked from a project image, and one whose image this host no longer holds; one already on the newest version comes back untouched and says so.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut, moved: z.boolean(), kept: z.array(z.string()), fallback: z.boolean().optional() },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        const source = await workspaceOf(client, ref);
        const moved = await moveImage(client, source.id);
        return asText(imageMovedLine(moved), moved);
      },
    }),
  },
  {
    name: "image remove",
    cloud: true,
    usage: "wsp image remove <snapshot id> [--yes]",
    about: "deletes a project image's snapshot at the provider and drops its record; refused while a workspace stands on it",
    page: "app",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [id] = ctx.args;
      if (id === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image remove takes one project image, by the id wsp image lists it under.", usageIs(ctx));
      const client = await ctx.client();
      const golden = await projectImageOf(client, id);
      if (!(await confirmed(ctx, imageRemoveQuestion(golden), id))) return 1;
      const removed = await removeProjectImage(client, id);
      ctx.out.emit(removed, projectImageRemovedLine(id, removed.alreadyGone));
      return 0;
    },
    tool: tool({
      description:
        "Deletes a project image's snapshot at the provider its place names and then drops its record, so no later fork starts from it; the id is the one the image tool lists each project image under, never a project's name. The provider's listing is read back until the id has left it: a snapshot the provider had already lost drops its record and answers `alreadyGone` true, a listing that still holds the id after the wait keeps the record and says to ask again, and any other refusal of the provider's keeps the record and carries the provider's own words. Refused in one line while any workspace stands on the image, whatever its state, naming them: delete those first, or forget one whose machine is gone. Called without confirm it removes nothing and answers with what would go, which is the line to put to the person.",
      input: {
        image: z.string().describe("the project image's snapshot id, as the image tool lists it"),
        confirm: z.boolean().optional().describe("true deletes the snapshot; absent or false answers with what would go and deletes nothing, so a person can be asked first"),
      },
      output: ProjectGoldenRemoved.shape,
      call: async ({ image: id, confirm }, deps) => {
        const client = await deps.client();
        const golden = await projectImageOf(client, id);
        if (confirm !== true) {
          return { ...asText(`${id} kept. ${projectImageRemoveNotice(golden)} Ask the person, then call image_remove again with confirm true.`, { projectGolden: golden, alreadyGone: false }), isError: true };
        }
        const removed = await removeProjectImage(client, id);
        return asText(projectImageRemovedLine(id, removed.alreadyGone), removed);
      },
    }),
  },
  {
    name: "forget",
    usage: "wsp forget <workspace> [--yes]",
    about: "drops a gone workspace and its threads from this computer; refused while its machine exists",
    page: "agent",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp forget takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const f = await dropping(client, ref);
      if (!(await confirmed(ctx, forgetQuestion(f), f.workspace.name))) return 1;
      await forget(client, f);
      ctx.out.emit({ workspaceId: f.workspace.id, name: f.workspace.name, threads: f.threads }, forgotLine(f));
      return 0;
    },
    tool: tool({
      description:
        "Drops a workspace whose machine the provider no longer has: its record and its threads leave this computer and the person's sidebar. The provider is read until twelve reads in a row agree the machine is gone, and nothing is asked of the machine. Refused in one line while the machine still exists (pause it, or delete it at the provider, first).",
      input: { workspace: WorkspaceIn },
      output: { workspaceId: z.string(), name: z.string(), threads: z.number().int() },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        const f = await dropping(client, ref);
        await forget(client, f);
        return asText(forgotLine(f), { workspaceId: f.workspace.id, name: f.workspace.name, threads: f.threads });
      },
    }),
  },
  {
    name: "delete",
    usage: "wsp delete <thread>|<workspace> [--yes]",
    about:
      "takes a thread on this computer away, its turns and checkpoints with it, and the worktree wsp made for it with every thread in it, never the project folder; a workspace on a box goes as before, its machine deleted at the provider and its record and threads dropped from this computer",
    page: "front",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp delete takes one thread, or one workspace on a box.", usageIs(ctx));
      const client = await ctx.client();
      const here = await threadHere(client, ref);
      if (here !== undefined) {
        if (!(await confirmed(ctx, threadDeleteQuestion(here.id, here.worktree), here.id))) return 1;
        const gone = await threadDeleted(client, here.id);
        ctx.out.emit({ threadId: here.id, ...gone }, threadDeletedLine(here.id, gone));
        return 0;
      }
      // A workspace by that name comes first; a ref that names none but is a thread on a box's machine says how that
      // thread goes, rather than that no workspace has its id.
      const d = await deleting(client, ref).catch(async (e: unknown) => {
        await refuseMachineThread(client, ref);
        throw e;
      });
      if (!(await confirmed(ctx, deleteQuestion(d), d.workspace.name))) return 1;
      await deleteWorkspace(client, d);
      ctx.out.emit({ workspaceId: d.workspace.id, name: d.workspace.name, machineId: d.workspace.machineId, threads: d.threads }, deletedLine(d));
      return 0;
    },
    tool: tool({
      description:
        "Takes a thread on this computer away, named by thread: its turns and checkpoints go, and where it ran in a worktree wsp made, that worktree goes with every thread in it, refused over files no commit holds; the project folder is never touched. Named by workspace, a workspace on a box goes as before: its machine is deleted at the provider and its record and threads dropped from this computer and the person's sidebar, and everything on that machine's disk that was not exported or pushed goes with it. Called without confirm it deletes nothing and answers with what would go, which is the line to put to the person.",
      input: { thread: z.string().optional().describe("a thread on this computer, by its id or a prefix that names one"), workspace: WorkspaceIn.optional(), confirm: ConfirmIn },
      output: { threadId: z.string().optional(), workspaceId: z.string(), worktree: z.string().optional(), name: z.string().optional(), machineId: z.string().optional(), threads: z.number().int() },
      call: async ({ thread: threadRef, workspace: ref, confirm }, deps) => {
        const client = await deps.client();
        if (threadRef !== undefined) {
          const here = await threadHere(client, threadRef);
          if (here === undefined) {
            await refuseMachineThread(client, threadRef);
            throw usageRefusal(`no thread ${threadRef} on this computer`, "Name a thread wsp threads lists.");
          }
          if (confirm !== true) return { ...asText(`thread ${here.id} kept. ${threadDeleteQuestion(here.id, here.worktree).split("\n")[1]} Ask the person, then call delete again with confirm true.`, { threadId: here.id, workspaceId: here.workspaceId, threads: 1 }), isError: true };
          const gone = await threadDeleted(client, here.id);
          return asText(threadDeletedLine(here.id, gone), { threadId: here.id, ...gone });
        }
        if (ref === undefined) throw usageRefusal("delete takes a thread, or a workspace on a box.", "Name one.");
        const d = await deleting(client, ref);
        const going = { workspaceId: d.workspace.id, name: d.workspace.name, machineId: d.workspace.machineId, threads: d.threads };
        // The command line asks a person before this and the app will; over MCP the second call is that step, so a
        // machine is never killed by one tool call the caller made on its own.
        if (confirm !== true) {
          return { ...asText(`${d.workspace.name} kept. ${deleteNotice(d.threads, workspaceKind(d.workspace), madeWorktree(d.workspace), d.workspace.machineId, d.on)} Ask the person, then call delete again with confirm true.`, going), isError: true };
        }
        await deleteWorkspace(client, d);
        return asText(deletedLine(d), going);
      },
    }),
  },
  {
    name: "run",
    usage: 'wsp run [<project>] [--branch <branch>] [--cwd <path>] [--agent <id>] [--model, --effort, --access <word>] [--fast] [--notify <thread|me>] [--title <title>] [--file <path>] [--detach] "<message>"',
    about:
      "an agent works in the project's folder and you read its reply: a thread with the agent, model, effort and access the app offers; --branch runs it in a worktree of the project's repo on that branch, made under wsp's folder unless one already holds it, and --cwd in a folder inside the project or one of its worktrees; with no project, run from inside one of your project folders, or from a thread, beside it; follows its first turn, or with --detach prints the id and returns",
    page: "front",
    options: { branch: { type: "string" }, cwd: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS, fast: { type: "boolean" }, notify: { type: "string", multiple: true }, title: { type: "string" }, file: { type: "string", multiple: true }, detach: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length === 0) throw usageRefusal(EMPTY_MESSAGE_LINE, 'Put the message in quotes: wsp run <project> "say hi".');
      if (ctx.args.length > 2) throw usageRefusal(`wsp run takes a project and a message; ${ctx.args[2]!} reads as a third word.`, usageIs(ctx));
      const client = await ctx.client();
      const harness = flag(ctx.flags, "agent");
      const picks = pickFlags(ctx.flags);
      const [ref, message] = ctx.args.length === 2 ? [ctx.args[0], ctx.args[1]!] : [undefined, ctx.args[0]!];
      const where = { branch: flag(ctx.flags, "branch"), cwd: flag(ctx.flags, "cwd") };
      const { opened, woken, opening } = await beforeSending(client, async () => {
        const target = await runTarget(client, ref, ctx.cwd, ctx.env, ctx.elsewhere, where);
        await checkedStart(client, message, harness, picks, "workspace" in target ? target.workspace.id : undefined);
        const woken = "workspace" in target ? await awake(client, target.workspace, "send", line => ctx.io.error(line)) : undefined;
        const opening = openingOf(ctx.env, woken?.workspace ?? ("here" in target ? target : target.workspace), message, { harness, ...picks, notify: await notifyOf(client, flagList(ctx.flags, "notify")), title: flag(ctx.flags, "title"), files: flagList(ctx.flags, "file"), elsewhere: ctx.elsewhere, ...("workspace" in target ? { cwd: where.cwd } : {}) });
        return { opened: target.opened, woken, opening };
      });
      let started: Turn | undefined;
      try {
        if (ctx.flags["detach"] === true) await detachVerb(ctx, client, opening, {}, opened);
        else ctx.out.emit(turnView(await followVerb(ctx, client, opening, true, {}, { opened, spend: turnSpendWord(woken?.workspace ?? { kind: "local" }) }, t => (started = t))));
      } catch (e) {
        throw woken === undefined ? e : withLine(e, await napAfterDeadLaunch(client, woken, started));
      }
      return 0;
    },
    tool: tool({
      description: `Opens a thread under the named agent, on the model, effort and access mode named or the catalog's defaults (a cheaper model for a review, say), and follows its first turn; returns the reply text as soon as it is complete, with the thread id for send. It runs in the project's folder; with branch, in a worktree of the project's repo on that branch (one that already holds the branch, wherever it is, else one wsp makes under its own folder with the dependencies carried in); with cwd, in that folder, which must be inside the project or one of its worktrees. With no project, from a thread, it runs beside that thread in its folder. With detach true it returns the thread id the moment the turn is started, without the reply: the road for a turn that runs for minutes or an hour. ${TURN_END_WORDS}. With notify, each turn of the thread sends one line (outcome, duration, cost, and the reply whole into a thread or its last line to the person) to every target named, so a caller need not wait here or poll. ${NOTIFY_WORDS}. ${NOTIFY_CALLER}. ${ANOTHER_AGENT_WORDS}.`,
      input: { project: RunProjectIn, branch: BranchIn, cwd: RunCwdIn, message: z.string(), agent: AgentIn, ...PICK_INPUTS, fast: FastIn, notify: NotifyIn, title: TitleIn, files: FilesIn, detach: DetachIn },
      output: TurnOut.shape,
      call: async ({ project: ref, branch, cwd, message, agent: harness, notify: tell, title, files, detach, ...input }, deps) => {
        const client = await deps.client();
        const { opened, woken, opening } = await beforeSending(client, async () => {
          const target = await runTarget(client, ref, deps.cwd, deps.env, deps.elsewhere, { branch, cwd });
          await checkedStart(client, message, harness, input, "workspace" in target ? target.workspace.id : undefined);
          const woken = "workspace" in target ? await awake(client, target.workspace, "send", QUIET_LINE) : undefined;
          const opening = openingOf(deps.env, woken?.workspace ?? ("here" in target ? target : target.workspace), message, { harness, ...input, notify: await notifyOf(client, tell ?? []), title, files, elsewhere: deps.elsewhere, ...("workspace" in target ? { cwd } : {}) });
          return { opened: target.opened, woken, opening };
        });
        let started: Turn | undefined;
        try {
          if (detach === true) return detachedOut(await startDetached(client, opening, "agent", undefined, () => hostBack(deps)), opened);
          const turn = await follow(client, opening, "agent", { ...QUIET_TURN, started: t => (started = t) }, () => hostBack(deps));
          const out = turnOut(turn);
          return asText(opened === undefined ? turnText(out) : `${opened(out.threadId, turn.session.cwd)}\n${turnText(out)}`, out);
        } catch (e) {
          throw woken === undefined ? e : withLine(e, await napAfterDeadLaunch(client, woken, started));
        }
      },
    }),
  },
  {
    name: "worktree",
    usage: "wsp worktree <project> <branch>",
    about:
      "a worktree of the project's repo on the branch, for an agent to work in by path or to start a thread in: the one git already has the branch checked out in, wherever it is, else one wsp makes under its own folder, from the project folder's current commit for a new branch, with the folder's .env files and installed dependencies carried in; prints its path",
    page: "agent",
    options: {},
    run: async ctx => {
      const [project, branch] = ctx.args;
      if (project === undefined || branch === undefined || ctx.args.length !== 2) throw usageRefusal("wsp worktree takes a project and a branch.", usageIs(ctx));
      const made = await worktreeFor(await ctx.client(), project, branch);
      ctx.out.emit({ ...made }, made.path);
      return 0;
    },
    tool: tool({
      description:
        "A worktree of the project's repo on the branch, answered with its path: the one git already has the branch checked out in, the project folder or a worktree the person or an agent made included, else one wsp makes under its own folder, a new branch starting from the project folder's current commit, with .env files and installed dependencies carried in from the project folder and build folders tied to their path left to rebuild. made says whether wsp made it, which is the only kind it ever removes. A running session cannot move into it: work there by path, or start a thread in it with run and cwd. git worktree add works too, without the carried files and the cleanup.",
      input: { project: z.string().describe("the project, by the name or the id projects lists"), branch: z.string().describe("the branch, existing or new") },
      output: WorktreeMade.shape,
      call: async ({ project, branch }, deps) => {
        const made = await worktreeFor(await deps.client(), project, branch);
        return asText(made.path, { ...made });
      },
    }),
  },
  {
    name: "worktree remove",
    usage: "wsp worktree remove <project> <branch> [--force]",
    about: "takes away a worktree wsp made for the branch, with git: refused while a thread is working in it, and over files no commit holds unless --force; the branch stays, and a worktree wsp did not make is never removed",
    page: "agent",
    options: { force: { type: "boolean" } },
    run: async ctx => {
      const [project, branch] = ctx.args;
      if (project === undefined || branch === undefined || ctx.args.length !== 2) throw usageRefusal("wsp worktree remove takes a project and a branch.", usageIs(ctx));
      await (await ctx.client()).request("worktree.remove", { project, branch, ...(ctx.flags["force"] === true ? { force: true } : {}) });
      ctx.out.emit({ project, branch, removed: true }, worktreeRemovedLine(branch));
      return 0;
    },
    tool: tool({
      description:
        "Takes away the worktree wsp made for the branch, with git: refused while a thread is working in it, and over files no commit holds unless force, which loses them. The branch itself stays, and a detached worktree's commit is kept under refs/rescue. A worktree the person or an agent made is never removed; threads that ran in a removed worktree go on in the project folder.",
      input: { project: z.string().describe("the project, by the name or the id projects lists"), branch: z.string().describe("the branch the worktree holds"), force: z.boolean().optional().describe("remove it over files no commit holds, which go with it") },
      output: { project: z.string(), branch: z.string(), removed: z.literal(true) },
      call: async ({ project, branch, force }, deps) => {
        await (await deps.client()).request("worktree.remove", { project, branch, ...(force === true ? { force: true } : {}) });
        return asText(worktreeRemovedLine(branch), { project, branch, removed: true as const });
      },
    }),
  },
  {
    name: "thread read",
    usage: "wsp thread read <thread> [--last]",
    about:
      "the thread's messages as the app lists them, oldest first: who each one is, when the runtime recorded it and the text, with every tool call folded to the one line the app's row reads; --last prints the final reply alone, the whole message its finished line carries. A tool's output and the agent's reasoning are no rows of it. Reading marks the thread read, so it stops reading Done here and in the app",
    page: "agent",
    options: { last: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp thread read takes one thread.", usageIs(ctx));
      const last = ctx.flags["last"] === true;
      const client = await ctx.client();
      const read = await readThread(client, await threadOf(client, ref), last);
      ctx.out.emit(read, readLine(read, last));
      return 0;
    },
    tool: tool({
      description:
        "The thread's messages as the app lists them, oldest first: each one's who (person for the message that opened or steered a turn, agent for the agent's own words, tool for one call of its folded to a line, turn for the outcome, duration and cost the turn ended with), at, the ms epoch the runtime recorded it, and its text. With last true, the final reply alone, the whole message the thread's finished line carries, and a row under it saying so when the thread has started another turn since, so a report is never read as the one being written. This is how you read a thread you did not open, and how you read the report behind a line that reached you; the transcript is the host's, so nothing on a machine is touched and a paused machine's thread reads the same as a running one's. A thread of many turns answers with all of them, so read one with last true when the report is what you are after. A call's output and the agent's reasoning are no rows of it. A thread whose rows the transcript's cap has dropped answers with none, which is an answer and not an error. Reading marks the thread read, as the app showing it does, so a finished thread stops reading Done in threads and in the app.",
      input: {
        thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them"),
        last: z.boolean().optional().describe("true answers with the final reply alone, the whole message the thread's finished line carries, with a row under it where the thread has started another turn since; absent answers with every message"),
      },
      output: { threadId: z.string(), messages: z.array(ThreadMessage) },
      call: async ({ thread: ref, last }, deps) => {
        const client = await deps.client();
        const read = await readThread(client, await threadOf(client, ref), last === true);
        return asText(readLine(read, last === true), read);
      },
    }),
  },
  {
    name: "thread head",
    usage: "wsp thread head <thread>",
    about:
      "the thread's facts and its newest events, what the app draws first on opening it: the title, the agent, model and access it runs on, where it stands and its folder, then as many of its newest events as fit in 64 KB, each tool result past 2 KB cut and marked with its whole length. Reading a head marks nothing",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp thread head takes one thread.", usageIs(ctx));
      const client = await ctx.client();
      const head = await threadHead(client, await threadOf(client, ref));
      ctx.out.emit(head, headLine(head));
      return 0;
    },
    tool: tool({
      description:
        "The thread's head (by id, or a prefix of it): facts, the thread as threads lists it with the model, effort and context window its latest turn runs on and turnId while a turn runs; events, as many of the thread's newest transcript events as fit in 64 KB, oldest first, each tool result past 2 KB cut with cut set to its whole length; pos, the newest position the transcript has issued, which every event carries as its own pos; and total, how many events of the thread the transcript holds. It is the cheap look at a thread: read the whole conversation with thread_read. Nothing on a machine is touched and the thread is not marked read.",
      input: { thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them") },
      output: ThreadHead.shape,
      call: async ({ thread: ref }, deps) => {
        const client = await deps.client();
        const head = await threadHead(client, await threadOf(client, ref));
        return asText(headLine(head), head);
      },
    }),
  },
  {
    name: "thread rename",
    usage: 'wsp thread rename <thread> "<title>"',
    about: "names the thread inside the agent's own store, so the agent shows the same name",
    page: "app",
    options: {},
    run: async ctx => {
      const [ref, title] = ctx.args;
      if (ref === undefined || title === undefined || ctx.args.length !== 2) throw usageRefusal("wsp thread rename takes a thread and one name.", usageIs(ctx));
      const client = await ctx.client();
      const thread = await threadOf(client, ref);
      await awake(client, await workspaceOf(client, thread.workspaceId), "rename", line => ctx.io.error(line));
      const renamed = await rename(client, thread, title);
      ctx.out.emit(renamed, renameLine(renamed));
      return 0;
    },
    tool: tool({
      description:
        "Names the thread (by id, or a prefix of it) in the agent's own store on the machine, the field the agent writes when a person renames the session inside it, so the thread reads by that name in wsp and in the agent. outcome renamed means the store took it; unsupported means the thread's agent keeps no name of a person's, which is an answer, not an error; no-session means the agent's store on the machine has no such session; failed means the store refused the write and error carries the machine's own line for it. Whether an agent keeps a name is on its row in harnesses.list, from the adapter on the machine.",
      input: { thread: z.string(), title: z.string() },
      output: { threadId: z.string(), title: z.string(), harness: z.string(), outcome: SessionRenameOutcome, error: z.string().optional() },
      call: async ({ thread: ref, title }, deps) => {
        const client = await deps.client();
        const thread = await threadOf(client, ref);
        await awake(client, await workspaceOf(client, thread.workspaceId), "rename", QUIET_LINE);
        const renamed = await rename(client, thread, title);
        return asText(renameLine(renamed), { ...renamed });
      },
    }),
  },
  {
    name: "thread forget",
    usage: "wsp thread forget <thread>",
    about: "drops a thread no turn ever ran on, the row a launch that never got going leaves behind; refused once a turn of it did work",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp thread forget takes one thread.", usageIs(ctx));
      const client = await ctx.client();
      const thread = await threadOf(client, ref);
      await forgetThread(client, thread);
      ctx.out.emit({ threadId: thread.id, workspaceId: thread.workspaceId }, threadForgotLine(thread));
      return 0;
    },
    tool: tool({
      description:
        "Drops a thread (by id, or a prefix of it) no turn ever ran on: the row a launch that never got going leaves in threads and in the person's sidebar goes, and nothing is asked of the machine. A launch the agent refused outright, for want of a sign-in, counts as one that ran nothing and goes the same way. Refused in one line once a turn of the thread did work, since that work is written down on it and nowhere else; delete takes a thread that ran, with its turns.",
      input: { thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them") },
      output: { threadId: z.string(), workspaceId: z.string() },
      call: async ({ thread: ref }, deps) => {
        const client = await deps.client();
        const thread = await threadOf(client, ref);
        await forgetThread(client, thread);
        return asText(threadForgotLine(thread), { threadId: thread.id, workspaceId: thread.workspaceId });
      },
    }),
  },
  ...ANSWER_VERBS,
  ...SLATE_VERBS,
  {
    name: "send",
    usage: 'wsp send <thread> [--model, --effort <value>] [--fast] [--file <path>] [--detach] "<message>"',
    about: "a message to the thread, on a named model or effort, fast or not, with files; the thread keeps its own access and a running turn its own picks; --detach prints the id and returns",
    page: "front",
    options: { ...SEND_OPTIONS, fast: { type: "boolean" }, file: { type: "string", multiple: true }, detach: { type: "boolean" } },
    run: async ctx => {
      const [ref, message] = ctx.args;
      if (ref === undefined || message === undefined || ctx.args.length !== 2) throw usageRefusal("wsp send takes a thread and one message.", usageIs(ctx));
      const client = await ctx.client();
      const picks = pickFlags(ctx.flags);
      const { thread, workspace } = await beforeSending(client, async () => {
        const thread = await threadOf(client, ref);
        await checkedStart(client, message, thread.harness, picks, thread.workspaceId);
        return { thread, ...(await awake(client, await workspaceOf(client, thread.workspaceId), "send", line => ctx.io.error(line))) };
      });
      const files = flagList(ctx.flags, "file");
      if (ctx.flags["detach"] === true) await detachVerb(ctx, client, messageTo(thread, message, picks, files, ctx.elsewhere), picks);
      else ctx.out.emit(turnView(await followVerb(ctx, client, messageTo(thread, message, picks, files, ctx.elsewhere), false, picks, { spend: turnSpendWord(workspace) })));
      return 0;
    },
    tool: tool({
      description: `Sends a message to an existing thread (by id, or a prefix of it) and returns the reply when it is complete; a person's message on the same thread lands in order with yours. With detach true it returns the thread id the moment the turn is started, without the reply, and the turn's end reaches whoever the thread's start named. A model or effort named here is the turn's; the thread runs on the agent and at the access its own turns ran at, which a message does not change; a turn that joins a running one keeps that one's. ${SEND_MEETS}`,
      input: { thread: z.string(), message: z.string(), ...SEND_INPUTS, fast: FastIn, files: FilesIn, detach: DetachIn },
      output: TurnOut.shape,
      call: async ({ thread: ref, message, files, detach, ...input }, deps) => {
        const client = await deps.client();
        const thread = await beforeSending(client, async () => {
          const thread = await threadOf(client, ref);
          await checkedStart(client, message, thread.harness, input, thread.workspaceId);
          await awake(client, await workspaceOf(client, thread.workspaceId), "send", QUIET_LINE);
          return thread;
        });
        if (detach === true) return detachedOut(await startDetached(client, messageTo(thread, message, input, files, deps.elsewhere), "agent", undefined, () => hostBack(deps)));
        const out = turnOut(await follow(client, messageTo(thread, message, input, files, deps.elsewhere), "agent", QUIET_TURN, () => hostBack(deps)));
        return asText(turnText(out), out);
      },
    }),
  },
  {
    name: "restart",
    usage: "wsp restart",
    about: "stops the host and brings it back on the road it came up on, its service, the verb that started it or the app; running turns go on and the host that comes back re-opens them. A host wsp up holds in a terminal refuses",
    page: "agent",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp restart takes no arguments.", usageIs(ctx));
      const back = await restartHost(ctx);
      ctx.out.emit(back, hostRestartedLine(back.running));
      return 0;
    },
    tool: tool({
      description:
        "Stops the host and brings it back on the road it came up on: its service's manager, the verb that started it, or the app. Running turns go on across it and the host that comes back re-opens them, your own turn included, so a coordinator thread lands a host change with this and keeps working. Answers once that host serves, with running the ids of the threads running on it then. A run, send or wait this cut dials the host again and carries on. Refused for a host wsp up holds in a terminal, which only that terminal brings back.",
      input: {},
      output: { running: z.array(z.string()) },
      call: async (_, deps) => {
        const back = await restartHost(deps);
        return asText(hostRestartedLine(back.running), back);
      },
    }),
  },
  {
    name: "stop",
    usage: "wsp stop <thread> [--task <id>]",
    about: "stops the thread's running turn, as the app's stop does, or with --task one of its agent's own subagents alone; the machine stays up",
    page: "front",
    options: { task: { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp stop takes one thread.", usageIs(ctx));
      const stopped = await stop(await ctx.client(), ref, flag(ctx.flags, "task"));
      ctx.out.emit(stopped, stopLine(stopped));
      return 0;
    },
    tool: tool({
      description: "Stops the thread's running turn (by id, or a prefix of it), as the app's stop button does; the machine stays up and the thread takes the next send. outcome accepted means the turn ended interrupted; not-running means it had already ended, which is an answer, not an error. A thread whose agents spawned threads of their own stops as one: under names each of those that was running and was stopped with it. Given the id of one of the agent's own subagents (off threads' subagents), that one is stopped alone and the turn runs on: accepted means the agent took the stop, refused and unsupported carry the reason in error.",
      input: { thread: z.string(), task: z.string().optional() },
      output: { threadId: z.string(), task: z.string().optional(), outcome: SessionInterruptOutcome, under: z.array(z.string()).optional(), error: z.string().optional() },
      call: async ({ thread: ref, task }, deps) => {
        const stopped = await stop(await deps.client(), ref, task);
        return asText(stopLine(stopped), { ...stopped });
      },
    }),
  },
  {
    name: "ssh",
    usage: "wsp ssh <workspace>",
    about: "carries one ssh connection to the workspace's own ssh server, starting it there, over this computer's stdin and stdout: the ProxyCommand wsp's ssh config gives every wsp- alias, so `ssh wsp-<name>` and an editor's remote window land inside the workspace",
    page: "agent",
    options: {},
    cliOnly: "a proxy for an ssh client on the computer the host runs on, piping raw bytes; an agent has no ssh client there to hand it to",
    startsNoHost: "a proxy for one connection to a host already up: a host it started would serve a state no config named, find no such workspace and stay up after ssh gave up",
    run: async ctx => {
      const [ref, ...rest] = ctx.args;
      if (ref === undefined || rest.length > 0) throw usageRefusal("wsp ssh takes one workspace.", usageIs(ctx));
      const bytes = ctx.io.bytes;
      if (bytes === undefined || ctx.elsewhere === true) throw usageRefusal(SSH_PIPES_HERE_LINE, "Run it from an ssh client on that computer, as wsp's ssh config does.");
      const client = await ctx.client();
      const workspace = await sshWorkspaceOf(client, ref);
      const { port } = await client.request<{ port: number }>("ssh.port", { workspaceId: workspace.id });
      await pipeBytes(port, bytes);
      return 0;
    },
  },
  {
    name: "exec",
    usage: "wsp exec <workspace> [--cwd <dir>] -- <command...>",
    about: "runs the command on the machine, each word as given, in --cwd or the folder a thread would start in",
    page: "agent",
    options: { cwd: { type: "string" } },
    run: async ctx => {
      const [ref, ...words] = ctx.args;
      if (ref === undefined || words.length === 0) throw usageRefusal("wsp exec takes a workspace, then -- and the command.", usageIs(ctx));
      const client = await ctx.client();
      const { workspace } = await awake(client, await workspaceOf(client, ref), "exec", line => ctx.io.error(line));
      const folder = absoluteFolder(flag(ctx.flags, "cwd"));
      const { exit, ranIn } = await execOn(client, workspace.id, words, folder, e => {
        if (e.type === "exec.output") ctx.out.emit(e, e.text);
      });
      if (exit.error !== undefined) throw new Error(exit.error);
      ctx.out.emit({ exitCode: exit.exitCode, ...(ranIn !== undefined ? { cwd: ranIn } : {}) });
      if (exit.exitCode !== null && exit.exitCode !== 0) ctx.io.error(execFolderLine(ranIn));
      return exit.exitCode ?? EXIT_CODES.provider;
    },
    tool: tool({
      description: "Runs a command on the workspace's machine as argv (each word as given; use sh -c for a shell line), in the folder cwd names or the one a thread would start in (the workspace's last used or only project, else its own folder), and returns its output lines, exit code and the folder it ran in. A non-zero exit is a result; the machine going away is an error.",
      input: { workspace: WorkspaceIn, argv: Argv, cwd: CwdIn },
      output: { exitCode: z.number().int().nullable(), output: z.array(z.string()), cwd: z.string().optional().describe("the folder the command ran in, as the host resolved it; absent only on a machine whose kind names no folder, where its own home is where the command ran") },
      stream: ["output"],
      call: async ({ workspace: ref, argv, cwd: folder }, deps) => {
        const asked = absoluteFolder(folder);
        const client = await deps.client();
        const { workspace: target } = await awake(client, await workspaceOf(client, ref), "exec", QUIET_LINE);
        const output: string[] = [];
        const { exit, ranIn } = await execOn(client, target.id, argv, asked, e => {
          if (e.type === "exec.output") output.push(e.text);
        });
        if (exit.error !== undefined) throw new Error(exit.error);
        return asText(output.join("\n"), { exitCode: exit.exitCode, output, ...(ranIn !== undefined ? { cwd: ranIn } : {}) });
      },
    }),
  },
  {
    name: "folders",
    usage: "wsp folders [<folder>] [--hidden] [--repos] [--on <computer>]",
    about: "the folders inside one folder on this computer or on a box you added with --on, or with --repos every git repo under the home folder, most recently used first, for naming one to record",
    page: "app",
    options: { hidden: { type: "boolean" }, repos: { type: "boolean" }, on: { type: "string" } },
    run: async ctx => {
      const [folder] = ctx.args;
      if (ctx.args.length > 1) throw usageRefusal("wsp folders takes one folder on this computer at most.", usageIs(ctx));
      const on = typeof ctx.flags["on"] === "string" ? ctx.flags["on"] : undefined;
      const listing = await hostFolders(await ctx.client(), { folder, hidden: ctx.flags["hidden"] === true, repos: ctx.flags["repos"] === true, on }, f => resolve(f));
      ctx.out.emit(listing, folderLines(listing).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The folders directly inside one folder on the person's own computer, or on a box they added, one level at a time, as the app's import dialog browses them: each folder's absolute path, whether git tracks it, and how many hidden ones the level holds. Browse this to name a folder for import instead of guessing a path. The roots are that computer's home folder and the folder of every project on it; a path outside those is refused, and folder absent lists the home folder.<!-- cloud --> A cloud account keeps no computer to browse and is refused.<!-- /cloud --> Folders only: no file is named and nothing is read.",
      input: {
        folder: z.string().optional().describe("the folder to list, absolute and inside the roots; absent lists the home folder"),
        hidden: z.boolean().optional().describe("true lists the hidden folders too, which are otherwise only counted"),
        repos: z.boolean().optional().describe("true answers every git repo under the home folder and the recorded projects instead of one level, each with its branch and when git last wrote to it, most recent first; folder is ignored"),
        on: z.string().optional().describe("the computer whose folders to list, by the name computers lists; absent is the computer the app runs on"),
      },
      output: HostFolderListing.shape,
      call: async ({ folder, hidden, repos, on }, deps) => {
        const listing = await hostFolders(await deps.client(), { folder, hidden, repos, on }, f => absolutePath("folder is a path on this computer", f));
        return asText(folderLines(listing).join("\n"), listing);
      },
    }),
  },
  {
    name: "setup",
    usage: "wsp setup",
    about: "the setup on this host as the app's Settings reads it: which keys are held (never their values), the agents here<!-- cloud -->, what a machine costs<!-- /cloud -->, and the init job's phase, rows and progress when one runs or ran",
    page: "app",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp setup takes no positional arguments.", usageIs(ctx));
      const setup = await initSetup(await ctx.client());
      ctx.out.emit({ setup }, initSetupLines(setup).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The setup on this host, as the app's Settings reads it: which keys the host holds (their presence, never a value), the agents on this computer and whether each carries the wsp tools<!-- cloud -->, what a machine costs<!-- /cloud -->, and the init job when one runs or ran: its road, phase, screens, rows and progress. The rows are the image's stages, each sign-in with the page the person opens on this computer and the code it asks for while it waits, then its state, and the first machine once forked. Read it to tell the person where the build is and which sign-in waits for them; the build is started from the app's Settings, and wsp init --recipe from a shell is the same run.",
      input: {},
      output: { setup: InitSetup },
      call: async (_args, deps) => asJson({ setup: await initSetup(await deps.client()) }),
    }),
  },
  {
    name: "terminal config",
    readsHere: "the Ghostty config it reads is the person's own, in their home on this computer",
    usage: `wsp terminal config [--scheme ${TerminalScheme.options.join("|")}]`,
    about:
      "the Ghostty config on this computer as the app's terminal pane applies it, read from ~/.config/ghostty and Application Support with its includes and theme resolved: the font and its fallbacks, the size, the colors, the cursor, the padding, the background opacity, and the blur, which is read but not applied; --scheme picks the side of a light:...,dark:... theme",
    page: "app",
    options: { scheme: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp terminal config takes no positional arguments.", usageIs(ctx));
      const config = await readGhosttyConfig(nodeHost(), schemeFlag(flag(ctx.flags, "scheme")));
      ctx.out.emit(config, terminalConfigLines(config).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The person's Ghostty config on this computer as the app's terminal pane applies it: every config file Ghostty would load and the theme it names, read now, with only the keys the pane honours. files is empty when they have no Ghostty config, and each other key is absent when no file sets it, so the pane keeps its default there. backgroundBlur is read and not applied: the desktop window's own material is the blur, and a browser tab has none. Read this to say how their terminal looks or to check what a config change did; nothing is written.",
      input: { scheme: TerminalScheme.optional().describe("which side of a light:...,dark:... theme to resolve; dark when absent") },
      output: TerminalConfig.shape,
      call: async ({ scheme }, _deps) => {
        const config = await readGhosttyConfig(nodeHost(), scheme);
        return asText(terminalConfigLines(config).join("\n"), config);
      },
    }),
  },
  {
    name: "export",
    usage: "wsp export <workspace> <folder> [--from <path on the machine>] [--replace] [--agents <ids>]",
    about: "brings a project folder and the agent sessions keyed to it home from the machine",
    page: "agent",
    options: { from: { type: "string" }, replace: { type: "boolean" }, agents: { type: "string" } },
    run: async ctx => {
      const [ref, folder] = ctx.args;
      if (ref === undefined || folder === undefined || ctx.args.length !== 2) throw usageRefusal("wsp export takes a workspace and a folder on this computer.", usageIs(ctx));
      const dest = resolve(folder);
      const agents = agentsFlag(flag(ctx.flags, "agents"));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const req: ExportRequest = { source: flag(ctx.flags, "from") ?? dest, dest, ...(ctx.flags["replace"] === true ? { replace: true } : {}), ...(agents !== undefined ? { agents } : {}) };
      let done = "";
      try {
        const exported = await exportProject(client, workspace.id, req, e => {
          if (e.stage === "done") done = e.message;
          else if (e.stage !== "failed") ctx.out.stream(`${e.message}\n`);
        });
        ctx.out.emit(exported, done);
        return 0;
      } catch (e) {
        throw withReplaceHint(e);
      }
    },
    tool: tool({
      description:
        "Brings a project folder and the agent sessions keyed to it home from the workspace's machine to this computer: the folder lands at `folder` (absolute, must not exist unless replace), the sessions in the agents' homes here keyed to it. `from` is the folder's path on the machine, the same path as `folder` when absent. The result says per agent what moved, what landed as transcripts only, and how many indexed rollouts were skipped.",
      input: {
        workspace: WorkspaceIn,
        folder: z.string().describe("where the folder lands on this computer, absolute"),
        from: z.string().optional().describe("the folder's path on the machine; defaults to folder"),
        replace: z.boolean().optional().describe("remove what is at folder first; without it an existing folder is refused"),
        agents: z.array(z.string()).optional().describe("catalog ids of the agents whose sessions come home; absent means every agent with sessions for the folder"),
      },
      output: ProjectExportResult.shape,
      call: async ({ workspace: ref, folder, from, replace, agents }, deps) => {
        const client = await deps.client();
        const target = await workspaceOf(client, ref);
        const req: ExportRequest = { source: from ?? folder, dest: folder, ...(replace !== undefined ? { replace } : {}), ...(agents !== undefined ? { agents } : {}) };
        let done = "";
        const exported = await exportProject(client, target.id, req, e => {
          if (e.stage === "done") done = e.message;
        });
        return asText(done, exported);
      },
    }),
  },
];

const isCloudVerb = (v: Verb): boolean => "cloud" in v && v.cloud === true;

/** A verb with its cloud flags gone from its table, its usage and its tool, for a process with no cloud registered. */
function withoutCloudFlags(v: Verb): Verb {
  const dropped = "cloudFlags" in v ? (v.cloudFlags ?? []) : [];
  if (dropped.length === 0 || !("run" in v)) return v;
  const options = Object.fromEntries(Object.entries(v.options).filter(([name]) => !dropped.includes(name)));
  const usage = dropped.reduce((line, name) => line.replace(new RegExp(` \\[--${name}\\b[^\\]]*\\]`), ""), v.usage);
  if (!hasTool(v)) return { ...v, options, usage };
  const input = Object.fromEntries(Object.entries(v.tool.input).filter(([name]) => !dropped.includes(name.replaceAll("_", "-"))));
  return { ...v, options, usage, tool: { ...v.tool, input } };
}

/** A verb in the words this process says it in: its phrase and its tool's description, each span kept or dropped by
 * its cloud mark, as the skill's are. */
function inCloudWords(v: Verb): Verb {
  const worded = "about" in v ? { ...v, about: cloudText(v.about, CLOUD_ON) } : v;
  return hasTool(worded) ? { ...worded, tool: { ...worded.tool, description: cloudText(worded.tool.description, CLOUD_ON) } } : worded;
}

/** The verbs this process answers: every one where a cloud is registered, and with none, every one but the cloud's,
 * each without its cloud flags. What the pages, the tool server and the skill's rows are all built from. */
export const VERBS: readonly Verb[] = (CLOUD_ON ? ALL_VERBS : ALL_VERBS.filter(v => !isCloudVerb(v)).map(withoutCloudFlags)).map(inCloudWords);

/** The line a person typed, as the cloud line it is when no cloud is registered here: the verb it opens, or that
 * verb with the cloud flag it carries. Nothing where the line means something without one. */
export function cloudLineOf(argv: ReadonlyArray<string>): string | undefined {
  if (CLOUD_ON) return undefined;
  const opens = (v: Verb): boolean => v.name.split(" ").every((w, i) => argv[i] === w);
  const verb = [...ALL_VERBS].sort((a, b) => b.name.length - a.name.length).find(opens);
  if (verb === undefined) return undefined;
  if (isCloudVerb(verb)) return `wsp ${verb.name}`;
  const typed = ("cloudFlags" in verb ? (verb.cloudFlags ?? []) : []).find(name => argv.some(w => w === `--${name}` || w.startsWith(`--${name}=`)));
  return typed === undefined ? undefined : `wsp ${verb.name} --${typed}`;
}

/** The entries the command line answers, in the help's order. */
export const CLI_VERBS: readonly (CliVerb | CliOnlyVerb)[] = VERBS.filter((v): v is CliVerb | CliOnlyVerb => "run" in v);

/** The verb whose words open argv, the longest first, so `thread read` wins over a verb named `thread`. */
export function findVerb(argv: ReadonlyArray<string>): CliVerb | CliOnlyVerb | undefined {
  return [...CLI_VERBS].sort((a, b) => b.name.length - a.name.length).find(v => {
    const words = v.name.split(" ");
    return words.every((w, i) => argv[i] === w);
  });
}

/** Every line of help fits this many columns. */
export const HELP_WIDTH = 80;

/** What each flag a verb reads says in that verb's own help, one short line each: a reminder, not a lesson. A word
 * that means the same thing wherever it is read is keyed by the word alone; one that means two things is keyed by
 * the verb and the word, since a sentence covering both meanings is the paragraph this table was split out of. The
 * parity test holds every flag of every verb to a row here, so a flag added to a verb is documented or named.
 *
 * The tool inputs' own descriptions are not these: an agent reading a tool needs the whole rule before it calls,
 * and a person at a terminal needs the line that reminds them which word to type.
 *
 * The words after model, effort and access are examples a person reads before they type, not the list the run is
 * held to: the agent's own catalog is that, it is fetched per agent at the turn, and a line printed before any
 * agent is named cannot await it. A word outside the catalog is refused by the runtime naming the list it does
 * hold, which is where the truth is said. */
export const FLAG_WORDS: Readonly<Record<string, string>> = {
  agent: `which agent runs the thread, by its catalog id (${THREAD_AGENTS.join(", ")}); the project's own default without it`,
  agents: "the agents whose sessions for that folder travel with it, by catalog id, comma separated; every one that has them without it",
  "add-check": "<id>=<command> proving that added tool is on the machine; repeats",
  add: "<id>=<command> carrying a tool neither the catalog nor this computer has, installed by that command on the machine; repeats",
  access: "how far the agent may go without asking: ask, auto-edit, full or plan, refused where the agent has no such mode; without it, the project's, else the agent's default, else full",
  cwd: "the folder on the machine to work in; the project's folder without it",
  detach: "print the thread's id and return, leaving the reply to the thread's finished line",
  "thread deny reason": "what the agent should do instead, in your words; it reads them with the refusal, as it reads the reason typed in the app",
  "stop task": "stop one of the agent's own subagents alone, by its TASK id off wsp threads; the turn and its other subagents run on",
  effort: "how hard the agent thinks, by its own word (low, medium, high, xhigh, max); its default without it",
  engine: "give it the place's Docker or podman through a socket that sees its own containers alone",
  "recipe engine": "mark the recipe so every machine from its image gets the place's Docker or podman; it stays in the file until you edit it out",
  "run branch": "a branch other than the one the project's folder has checked out: the thread runs in the worktree holding it, made under wsp's folder from the folder's current commit for a new branch",
  "run cwd": "a folder inside the project or one of its worktrees, absolute, to start the thread in; the project's folder without it",
  "worktree remove force": "remove it over files no commit holds, which go with it",
  "export from": "the folder on the machine to bring home; the project registered for the folder you named without it",
  "recipes save from": "the computer whose picks the recipe is saved from, by the name wsp computers shows; it follows the recipe from then on",
  "computers set recipe": "the saved recipe it follows from now, by the name wsp recipes shows, or none to keep what it has and follow nothing",
  force: "build again even where the place already holds this version",
  hidden: "list the folders whose names start with a dot too",
  "usage range": "the days what was used is read over: day (today, the default), week (the last seven) or month (the last thirty); the accounts' limits are the same whatever it says",
  "usage by": "how what was used is split: agent (the default), account, computer, project or model",
  "folders on": "the computer whose folders to list, by the name wsp computers shows; a box you added answers from its own disk, and this computer is listed without it",
  "agents on": AGENTS_ON_WORDS,
  "usage reset on": "the computer to spend it on, by the name wsp computers shows, one of the account's own that holds its login; the first of those that is connected without it",
  "usage reset credit": "the reset to spend, by the id Codex lists it under; whichever Codex picks without it",
  "skills on": AGENTS_ON_WORDS,
  "skills show on": AGENTS_ON_WORDS,
  "skills add on": AGENTS_ON_WORDS,
  "skills remove on": AGENTS_ON_WORDS,
  "skills disable on": AGENTS_ON_WORDS,
  "skills enable on": AGENTS_ON_WORDS,
  "skills search limit": "how many skills to answer, from 1 to 50; 20 without it",
  "skills show project": "the project's skill of that name rather than the one that is not a project's: alone from a workspace, or the project's name with --on",
  "skills remove project": "the project's skill of that name rather than the one that is not a project's: alone from a workspace, or the project's name with --on",
  "skills add agent": "an agent to put the skill in, by its catalog id; repeats, and every agent whose folder is there without it",
  "skills add project": "put it in a project rather than the home: alone for the workspace's own, or the project's name with --on",
  "servers on": AGENTS_ON_WORDS,
  "servers tools on": AGENTS_ON_WORDS,
  "servers signin on": AGENTS_ON_WORDS,
  "servers signin agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers tools agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers tools refresh": "start the server again even where an answer from the last three minutes stands",
  "servers tools project": "the project on the computer --on names whose server it is, by name; a workspace finds its own project's servers",
  "servers add on": AGENTS_ON_WORDS,
  "servers add agent": "the agent whose config takes the server, by its catalog id",
  "servers add command": "the line the server runs, its program and arguments in one quoted value, split as a shell splits it and nothing expanded; or --url",
  "servers add env": "a variable the server is given, or one the address names as ${NAME}, by its name, its value read off the same name in this terminal's environment; an argument or the address may name it as ${NAME}; repeats",
  "servers add url": "the server's https address; or --command",
  "servers add header": "<name>=<VARIABLE>, a header sent to the address with its value read off that variable in this terminal's environment; repeats",
  "servers add project": "put it in a project's file rather than the agent's own: alone for the workspace's own project, or the project's name with --on",
  "servers remove on": AGENTS_ON_WORDS,
  "servers remove agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers remove scope": "user, home or project, as wsp servers shows it; user without it",
  "servers remove project": "the project scope: alone for the workspace's own project, or the project's name with --on",
  "servers disable on": AGENTS_ON_WORDS,
  "servers disable agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers disable scope": "user, home or project, as wsp servers shows it; user without it",
  "servers disable project": "the project scope: alone for the workspace's own project, or the project's name with --on",
  "servers enable on": AGENTS_ON_WORDS,
  "servers enable agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers enable scope": "user, home or project, as wsp servers shows it; user without it",
  "servers enable project": "the project scope: alone for the workspace's own project, or the project's name with --on",
  repos: "every git repo under the home folder instead of one level, most recently used first",
  fast: "run the turn in the agent's fast mode, on a model that offers one; refused naming the model otherwise",
  file: "a file on this computer to send with the message: an image goes as an image, any other file lands in the thread's folder and the message names its path; repeats",
  last: "the final reply alone, the whole message the thread's finished line carries",
  "slate write check": "validate and sketch the slate, storing nothing",
  "slate write set": "with --check, a value to rehearse against, like '$i=2' or 'picked=1'; repeats",
  "slate write press": "with --check, a piece to rehearse a press on, after the --set values",
  "slate write row": "the row index of the --press piece inside a list, from 0",
  "slate write action": "which row action of a --press table to rehearse, from 0",
  "if-version": "the version a read printed; refused with V750 when the document moved past it",
  "slate state start": "a run to start now that the person said \"Always in this thread\" to; any other answers held; repeats",
  "slate read values": "a path to resolve now, like '$check.exit' or usage.week.percent, or * for every bound one; repeats",
  "slate read no-text": "leave out the slate in the JSX-like form a patch is written against",
  "slate read document": "also print the stored JSON document",
  "slate read no-sketch": "leave the sketch out",
  threads: "how many threads may run on that computer at once; a new one waits past it",
  machines: "how many machines may run on that cloud at once",
  spend: "the dollars a day that cloud may spend before it starts no new machine",
  nap: "the minutes a quiet machine there runs before it naps, or off",
  "turn-limit": "the hours one turn there may run before it is stopped, or off; off on a computer you own<!-- cloud --> and 6 on a cloud<!-- /cloud --> until it is set",
  "computers set spawn": "on lets agents there whose folder or machine holds no switch of its own open threads and fork machines, capped; off refuses them",
  reset: "a setting to take back to its default, by its flag's word; repeats",
  "max-depth": "how many levels of threads may stand under the root thread while spawning is on; defaults to 2",
  "max-machines": "how many machines may stand at once under one root thread while spawning is on; defaults to 3",
  model: "the model the turn runs on, by the agent's own slug (claude-sonnet-5); the thread's own without it",
  name: "what to call the new workspace; <source>-fork without it",
  notify: "where each turn's end is sent, a thread's id or me; repeats",
  out: "where the recipe file is written",
  "recipe project": "a folder on this computer to weigh the histories by; repeats",
  "recipe scan project": "a folder on this computer to weigh the histories by; repeats",
  replace: "overwrite what is already at the destination",
  scheme: `which side of a light:...,dark:... theme to read; ${TerminalScheme.options.join(" or ")}`,
  send: "a task for the new workspace's first thread, with run's own flags after it",
  set: "<id>=on|off flipping one row of the recipe by its id; repeats",
  signin: `<id>=${LOGIN_CHOICES.join("|")} answering one sign-in by catalog id; repeats`,
  size: "the machine size as <cpu>x<memGb>, like 2x4; a size the provider does not offer is refused naming the ones it does",
  spawn: "on lets the agents there open threads and fork machines of their own, capped, and is what a workspace made without it is; off refuses them",
  "threads wait tail": "print the reply's last line alone, the line a notify sends, rather than the whole reply",
  tick: `the rule that decides every tick: ${RECIPE_TICKS.join(", ")}`,
  timeout: "how long to wait before answering that they are still running",
  title: "what to call the thread; the agent names it from its first message without one",
  "commit message": "the commit message, a subject line, a blank line, then the body, -m for short; the workspace's agent drafts it without one",
  "commit file": "a file to commit, by path from the checkout's top, once per file; every changed file without one",
  "fix check": "the failed check to send, by its name on the pull request; without it the copy is updated from its base and a conflict is sent",
  "fix child": "a child of the workspace whose merge into it stopped on conflicts, by name or id; its agent is asked to merge it and resolve them, and nothing is updated",
  "merge method": "merge, squash or rebase; the repository's own default without one",
  "merge when-checks-pass": "merge once the checks pass rather than now, where the repository allows it",
  "start project": "the project by name or id where two computers hold the link's repository; this computer's without it",
  "review agent": "the reviewing agent, codex or claude, each at its read-only access; codex without it",
  "review post verdict": "comment, approve or request-changes; the draft's own, the reviewer's word unless you changed it, without it",
  "review post summary": "the review's summary, written over the draft's",
  tree: "indent the threads an agent opened under the one that opened them",
  watch: "draw the table again every second where it stands, until Ctrl-C; it needs a terminal to redraw on",
  why: "what the rows this line adds are for, in your own words; the rows say an agent added them without it",
  yes: "go ahead without being asked",
  "agents set model": "the model a new thread on it starts on, by the agent's own slug",
  "agents set effort": "the effort a new thread on it starts at, by the agent's own word",
  "agents set access": "how far a new thread on it may go without asking: ask, auto-edit, full or plan, refused where the agent has no such mode",
  "agents set hide": "a model to take off its picker; a start still takes it by name; repeats",
  "agents set show": "a hidden model to put back on its picker; repeats",
  "agents set order": "the models its picker lists first, comma separated; the rest follow in the agent's own order",
  "agents set add-model": "a model id the binary does not list, which a start may then name; repeats",
  "agents set drop-model": "a model id added before, taken back off; repeats",
  "agents set reset": "put a field back on the agent's own: model, effort, access or models; repeats",
  "agents setup on": "the computer, by the name wsp computers shows; this computer without it",
  "agents setup enable": "offer the agent there again",
  "agents setup disable": "take the agent off that computer: the app's lists drop it there and a start naming it is refused",
  "agents setup program": "the program run in the agent's place there, a path or a word on its PATH",
  "agents setup config": "the folder there the agent keeps its config, sessions and sign-in in, absolute and under that computer's home; sign it in again there",
  "agents setup arg": "a word added to every turn's launch there; repeats, and replaces any set before",
  "agents setup env": "a variable every launch there carries, by name, never one that decides how the process starts (PATH, LD_*, NODE_OPTIONS and the like); its value is asked for where nothing echoes it; repeats",
  "agents setup unset-env": "a variable to take off its launch there, by name; repeats",
  "agents setup reset": "put a field back on the agent's own: program, config or args; repeats",
  "projects set agent": `the agent a new thread on it runs (${THREAD_AGENTS.join(", ")})`,
  "projects set model": "the model a new thread on it starts on, by the agent's own slug",
  "projects set effort": "the effort a new thread on it starts at, by the agent's own word",
  "projects set access": "how far a new thread on it may go without asking: ask, auto-edit, full or plan",
  "projects set reset": "put a field back on the layer below: agent, model, effort or access; repeats",
};

/** The line one flag gets in one verb's own help: the verb's own row where the word means two things, else the
 * word's own. Nothing where no row carries it, which the parity test refuses. */
export const flagSays = (verb: string, name: string): string | undefined => {
  const said = FLAG_WORDS[`${verb} ${name}`] ?? FLAG_WORDS[name];
  return said === undefined ? undefined : cloudText(said, CLOUD_ON);
};

/** The verb's about behind the indent, wrapped to the help's width. */
const aboutLines = (verb: CliVerb | CliOnlyVerb, indent: string): string[] => wrap(`${indent}${verb.about}`, HELP_WIDTH, indent);

/** The usage wrapped at the gaps between its groups and never inside a bracket, so a flag stays on the line with its
 * value. `lead` is what the first line opens with, so a page that opens it with `usage: ` is wrapped to the columns
 * it will actually stand in rather than to two spaces and then widened by five. */
export function usageLines(usage: string, indent: string, lead = "  "): string[] {
  // Each line of a usage that has more than one is wrapped on its own: wrap reads a newline as one more character.
  return usage.split("\n").flatMap((line, at) => {
    let depth = 0;
    const grouped = [...line]
      .map(c => {
        if (c === "[") depth++;
        if (c === "]") depth--;
        return c === " " && depth > 0 ? "\u00a0" : c;
      })
      .join("");
    return wrap(`${at === 0 ? lead : ""}${grouped}`, HELP_WIDTH, indent).map(l => l.replaceAll("\u00a0", " "));
  });
}

/** The lines of one page: each usage, then what it does indented under it, so no line runs wide. */
export function verbHelp(page?: Page): string {
  return CLI_VERBS.filter(v => page === undefined || v.page === page)
    .map(v => [...usageLines(v.usage, "    "), ...aboutLines(v, "      ")].join("\n"))
    .join("\n");
}

/** Every flag a verb reads beside the ones every verb takes, in the order the verb declares them. */
export const ownFlagsOf = (verb: CliVerb | CliOnlyVerb): string[] => Object.keys(verb.options).filter(name => !Object.hasOwn(COMMON, name));

/** What the flags every line takes say, wherever a page prints them. One home, so a verb's own help, a command's
 * own help and the agent page cannot word the same flag three ways, which they did. `hostSide` is what --host means
 * to a line that runs at its own host's terminal and dials nobody else. */
export const COMMON_FLAG_WORDS = {
  json: "print the raw protocol values, one JSON object per line, with everything else on stderr",
  state: "the state file the host serves",
  host: "run the line against a host on your account, by the name wsp hosts lists it under; WSP_HOST names one for a whole shell",
  hostSide: "read to say this line runs at its own host's terminal; it dials no other",
} as const;

/** One page of help: the usage wrapped as every page wraps it, what the line does, then a line per flag. The one
 * renderer, so a verb's page, a command's page and the tool server's own read alike. */
export function helpPage(usage: string, about: readonly string[], rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([word]) => word.length), 0) + 4;
  return [
    ...usageLines(usage, "       ", "usage: "),
    ...about,
    ...(rows.length === 0 ? [] : ["", ...rows.flatMap(([word, says]) => wrap(`  ${word.padEnd(width)}${says}`, HELP_WIDTH, " ".repeat(width + 2)))]),
  ].join("\n");
}

/** What one verb's own `--help` prints: its usage, what it does, its own flags one line each, then the three every
 * verb takes. A page that named ten flags on the usage line and then documented three of them left the person to
 * guess what the other seven took. */
export function verbPage(verb: CliVerb | CliOnlyVerb, host: string): string {
  return helpPage(verb.usage, aboutLines(verb, "  "), [
    ...ownFlagsOf(verb).map((name): [string, string] => [`--${name}`, flagSays(verb.name, name) ?? ""]),
    ["--json", COMMON_FLAG_WORDS.json],
    ["--state", COMMON_FLAG_WORDS.state],
    ["--host", host],
  ]);
}

/** The usage of every verb that opens with this word, for a command that stopped short of one; none when no verb does. */
export function verbUsage(word: string): string | undefined {
  const usages = CLI_VERBS.filter(v => v.name.split(" ")[0] === word).map(v => `usage: ${v.usage}`);
  return usages.length > 0 ? usages.join("\n") : undefined;
}

/** The refusal a verb's own parse leaves: the line naming the verbs that read a flag this one does not, or the
 * parser's own words behind the verb's usage. */
function parseRefusal(verb: CliVerb | CliOnlyVerb, e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  const usage = `usage: ${verb.usage}`;
  const named = (e as { code?: unknown }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /^Unknown option '--([^']+)'/.exec(message)?.[1] : undefined;
  if (named === undefined) return usageRefusal(message, usage);
  const readers = CLI_VERBS.filter(v => v !== verb && Object.hasOwn(v.options, named)).map(v => `wsp ${v.name}`);
  return readers.length === 0 ? usageRefusal(message, usage) : usageRefusal(foreignFlagLine(`--${named}`, readers, `wsp ${verb.name}`), usage);
}

export async function runVerb(verb: CliVerb | CliOnlyVerb, argv: ReadonlyArray<string>, io: CliIO, statePathOf: (flag?: string) => string, deps: Pick<VerbDeps, "alsoHere" | "cwd" | "env" | "start" | "signals" | "dial" | "elsewhere" | "terminal" | "open">): Promise<number> {
  let flags: Flags;
  let args: string[];
  try {
    const parsed = parseArgs({ args: optionalValues(argv.slice(verb.name.split(" ").length), verb.options), options: { ...COMMON, ...verb.options }, allowPositionals: true });
    flags = parsed.values as Flags;
    args = parsed.positionals;
    absoluteFolder(flag(flags, "cwd"));
  } catch (e) {
    return failed(io, jsonAsked(argv), parseRefusal(verb, e));
  }
  const hostSide = "hostSide" in verb ? verb.hostSide : undefined;
  if (flags["help"] === true) {
    // A line that runs at its own host's terminal takes the flag only to say so, which is what its own line says.
    const host = hostSide === undefined ? COMMON_FLAG_WORDS.host : COMMON_FLAG_WORDS.hostSide;
    io.log(verbPage(verb, host));
    return 0;
  }
  const statePath = statePathOf(flag(flags, "state"));
  // Which host this line runs against is read once: the dial takes the same reading, so a hosts file that changed
  // mid-line cannot send the note one way and the socket another.
  let aim: HostAim;
  try {
    aim = aimedHost(statePath, { ...(flag(flags, "host") !== undefined ? { host: flag(flags, "host")! } : {}), env: deps.env });
  } catch (e) {
    return failed(io, flags["json"] === true, e, `wsp ${verb.name}: `);
  }
  // A line whose work happens at the host's own terminal is answered here however it was aimed, as wsp host pair and
  // wsp host devices are: it never dials, so nothing of this computer's crosses to the other one.
  if (hostSide !== undefined && aim.kind !== "here") {
    return failed(io, flags["json"] === true, usageRefusal(hostSideOnlyLine(verb.name, aimName(aim)), hostSideOnlyFix(hostSide)));
  }
  // The note rides with the dial, not with the line: the recipe verbs write beside the state file whatever host
  // the line names, so saying it is not read before they run would be untrue.
  const stateNote = aim.kind !== "here" && flag(flags, "state") !== undefined ? stateIgnoredLine(aimName(aim)) : undefined;
  let noted = false;
  let client: HostClient | undefined;
  const ctx: VerbContext = {
    args,
    flags,
    usage: verb.usage,
    io,
    out: formatter(io, flags["json"] === true),
    statePath,
    aim,
    env: deps.env,
    ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
    ...(deps.start !== undefined ? { start: deps.start } : {}),
    ...(deps.signals !== undefined ? { signals: deps.signals } : {}),
    ...(deps.elsewhere === true ? { elsewhere: true } : {}),
    ...(deps.terminal !== undefined ? { terminal: deps.terminal } : {}),
    ...(deps.open !== undefined ? { open: deps.open } : {}),
    client: async again => {
      if (stateNote !== undefined && !noted) {
        noted = true;
        io.error(stateNote);
      }
      if (client !== undefined && again === undefined) return client;
      const start = verb.startsNoHost === undefined ? deps.start : undefined;
      client = await (deps.dial ?? dialHost)(statePath, { aim, say: line => io.error(line), ...(again !== undefined ? { deadlineMs: again.withinMs } : start !== undefined ? { start } : {}) });
      return client;
    },
  };
  try {
    return await verb.run(ctx);
  } catch (e) {
    return failed(io, flags["json"] === true, hostSchemaRefusal(e, verb.usage) ?? e, `wsp ${verb.name}: `);
  } finally {
    client?.close();
  }
}
