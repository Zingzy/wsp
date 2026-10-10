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
  IMAGE_MAX_WORDS,
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
import { CLOUD_BUILT, CLOUD_ON } from "./cloud.js";
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
import { type HostClient, dialHost, formatter, type Flags, type VerbDeps, type VerbContext, type Page, optionalValues, type CliVerb, type CliOnlyVerb, type Verb, hasTool, COMMON, flag, absoluteFolder, failed, jsonAsked, hostSchemaRefusal } from "./verbs/client.js";
import { AGENTS_ON_WORDS } from "./verbs/agents-help.js";
import { COMPUTER_VERBS } from "./verbs/computers.js";
import { AGENT_VERBS } from "./verbs/agents.js";
import { PROJECT_VERBS } from "./verbs/projects.js";
import { WORKSPACE_VERBS } from "./verbs/workspaces.js";
import { THREAD_VERBS } from "./verbs/threads.js";
export * from "./verbs/client.js";
export * from "./verbs/workspaces-help.js";
export * from "./verbs/turns-help.js";
export * from "./verbs/io.js";
export * from "./verbs/agents-help.js";
export * from "./verbs/slate.js";

/** Every verb, the cloud's among them; VERBS below is the table this process answers. */
export const ALL_VERBS: readonly Verb[] = [
  ...COMPUTER_VERBS,
  ...AGENT_VERBS,
  ...PROJECT_VERBS,
  ...WORKSPACE_VERBS,
  ...THREAD_VERBS,
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

/** A verb in the words this process says it in: its usage, its phrase and its tool's description, each span kept or
 * dropped by its cloud mark, as the skill's are. */
function inCloudWords(v: Verb): Verb {
  const worded = "about" in v ? { ...v, usage: cloudText(v.usage, CLOUD_ON), about: cloudText(v.about, CLOUD_ON) } : v;
  return hasTool(worded) ? { ...worded, tool: { ...worded.tool, description: cloudText(worded.tool.description, CLOUD_ON) } } : worded;
}

/** The verbs this process answers: every one where a cloud is registered, and with none, every one but the cloud's,
 * each without its cloud flags. What the pages, the tool server and the skill's rows are all built from. */
export const VERBS: readonly Verb[] = (CLOUD_ON ? ALL_VERBS : ALL_VERBS.filter(v => !isCloudVerb(v)).map(withoutCloudFlags)).map(inCloudWords);

/** The line a person typed, as the cloud line it is when no cloud is registered here: the verb it opens, or that
 * verb with the cloud flag it carries. Nothing where the line means something without one, and nothing in a public
 * build, where no variable turns the cloud on and the line is a word like any other this wsp does not know. */
export function cloudLineOf(argv: ReadonlyArray<string>): string | undefined {
  if (CLOUD_ON || !CLOUD_BUILT) return undefined;
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
  "exec cwd": "the folder to run the command in, absolute; the folder the thread works in without it",
  detach: "print the thread's id and return, leaving the reply to the thread's finished line",
  "thread deny reason": "what the agent should do instead, in your words; it reads them with the refusal, as it reads the reason typed in the app",
  "thread settle finished": "settle the finished threads under each thread named, and not the thread itself; a failed one stays for you to read",
  "stop subagent": "stop one of the agent's own subagents alone, by its id in the SUBAGENT column of wsp threads; the turn and its other subagents run on",
  effort: "how hard the agent thinks, by its own word (low, medium, high, xhigh, max); absent on a new thread means the agent's default; on send, the thread's own",
  engine: "give it the place's Docker or podman through a socket that sees its own containers alone",
  "recipe engine": "mark the recipe so every machine from its image gets the place's Docker or podman; it stays in the file until you edit it out",
  "run beside": "a thread whose folder the new thread starts in, by its id or a prefix, on the computer it runs on; never with a project or --branch",
  "run branch": "a branch other than the one the project's folder has checked out: the thread runs in the worktree holding it, made under wsp's folder from the folder's current commit for a new branch",
  "run cwd": "a folder inside the project or one of its worktrees, absolute, to start the thread in; the project's folder without it",
  "worktree remove force": "remove it over files no commit holds, which go with it",
  "projects remove force": "remove it even where its checkout on a computer of yours holds work no remote has, which goes with it",
  "export from": "the folder on the machine to bring home; the project registered for the folder you named without it",
  "recipes save from": "the computer whose picks the recipe is saved from, by the name wsp computers shows; it follows the recipe from then on",
  "computers set ssh": "the login user@host the host reaches a computer you added by over ssh from now, saved only once the computer it reaches reads as that same one",
  "computers set name": "what to call a computer you added from now, which every listing then shows; its id, its projects and its machines stay as they are",
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
  "skills show project": "the project's skill of that name rather than the one that is not a project's: alone with a thread, the thread's own project, or the project's name with --on",
  "skills remove project": "the project's skill of that name rather than the one that is not a project's: alone with a thread, the thread's own project, or the project's name with --on",
  "skills add agent": "an agent to put the skill in, by its catalog id; repeats, and every agent whose folder is there without it",
  "skills add project": "put it in a project rather than the home: alone with a thread, the thread's own project, or the project's name with --on",
  "servers on": AGENTS_ON_WORDS,
  "servers tools on": AGENTS_ON_WORDS,
  "servers signin on": AGENTS_ON_WORDS,
  "servers signin agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers tools agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers tools refresh": "start the server again even where an answer from the last three minutes stands",
  "servers tools project": "the project on the computer --on names whose server it is, by name; a thread finds its own project's servers",
  "servers add on": AGENTS_ON_WORDS,
  "servers add agent": "the agent whose config takes the server, by its catalog id",
  "servers add command": "the line the server runs, its program and arguments in one quoted value, split as a shell splits it and nothing expanded; or --url",
  "servers add env": "a variable the server is given, or one the address names as ${NAME}, by its name, its value read off the same name in this terminal's environment; an argument or the address may name it as ${NAME}; repeats",
  "servers add url": "the server's https address; or --command",
  "servers add header": "<name>=<VARIABLE>, a header sent to the address with its value read off that variable in this terminal's environment; repeats",
  "servers add project": "put it in a project's file rather than the agent's own: alone with a thread, the thread's own project, or the project's name with --on",
  "servers remove on": AGENTS_ON_WORDS,
  "servers remove agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers remove scope": "user, home, local or project, as wsp servers shows it; user without it",
  "servers remove project": "the project scope: alone with a thread, the thread's own project, or the project's name with --on",
  "servers disable on": AGENTS_ON_WORDS,
  "servers disable agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers disable scope": "user, home, local or project, as wsp servers shows it; user without it",
  "servers disable project": "the project scope: alone with a thread, the thread's own project, or the project's name with --on",
  "servers enable on": AGENTS_ON_WORDS,
  "servers enable agent": "the agent whose config names the server, by its catalog id as wsp servers shows it",
  "servers enable scope": "user, home, local or project, as wsp servers shows it; user without it",
  "servers enable project": "the project scope: alone with a thread, the thread's own project, or the project's name with --on",
  "plugins on": AGENTS_ON_WORDS,
  "plugins disable on": AGENTS_ON_WORDS,
  "plugins disable agent": "the agent whose plugin it is, by its catalog id as wsp plugins shows it",
  "plugins enable on": AGENTS_ON_WORDS,
  "plugins enable agent": "the agent whose plugin it is, by its catalog id as wsp plugins shows it",
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
  name: "what to call the new machine; <source>-fork without it",
  notify: "where each turn's end is sent, a thread's id or me; repeats",
  out: "where the recipe file is written",
  "recipe project": "a folder on this computer to weigh the histories by; repeats",
  "recipe scan project": "a folder on this computer to weigh the histories by; repeats",
  replace: "overwrite what is already at the destination",
  replaces: "a stopped or failed thread this one restarts, by id or a prefix; the host settles it once this one starts",
  scheme: `which side of a light:...,dark:... theme to read; ${TerminalScheme.options.join(" or ")}`,
  send: "a message for the new machine's first thread, with run's own flags after it",
  set: "<id>=on|off flipping one row of the recipe by its id; repeats",
  signin: `<id>=${LOGIN_CHOICES.join("|")} answering one sign-in by catalog id; repeats`,
  size: "the machine size as <cpu>x<memGb>, like 2x4; a size the provider does not offer is refused naming the ones it does",
  spawn: "on lets the agents there open threads and fork machines of their own, capped, and is what a machine made without it is; off refuses them",
  "threads wait tail": "print the reply's last line alone, the line a notify sends, rather than the whole reply",
  tick: `the rule that decides every tick: ${RECIPE_TICKS.join(", ")}`,
  timeout: "how long to wait before answering that they are still running",
  title: "what to call the thread; the agent names it from its first message without one",
  "commit message": "the commit message, a subject line, a blank line, then the body, -m for short; the thread's agent drafts it without one",
  "commit file": "a file to commit, by path from the checkout's top, once per file; every changed file without one",
  "fix check": "the failed check to send, by its name on the pull request; without it the folder is updated from its base and a conflict is sent",
  "fix child": "a child thread whose merge into this thread's folder stopped on conflicts, by its id or a prefix; this thread's agent is asked to merge it and resolve them, and nothing is updated",
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
  "projects set after-worktree": "a shell line a new worktree of the project runs once at its top, after each ecosystem's own install",
  "projects set reset": "put a field back on the layer below: agent, model, effort or access, or take the after-worktree command away with after-worktree; repeats",
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
      client = await (deps.dial ?? dialHost)(statePath, { aim, say: line => io.error(line), ...(verb.anyRelease !== undefined ? { anyRelease: true } : {}), ...(again !== undefined ? { deadlineMs: again.withinMs } : start !== undefined ? { start } : {}) });
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
