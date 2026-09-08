import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { DEFAULT_AGENT } from "@wsp/catalog";
import {
  BUILDER_IDLE_MS,
  DAEMON_PORT,
  INLINE_EXEC_MS,
  NotFirstLifeError,
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
  importInto,
  isMissing,
  isNetworkError,
  landBundle,
  tarOf,
  parseMergeOutput,
  plural,
  agentsOnMachine,
  guestAgentHomes,
  guestTmpPath,
  parseStateListing,
  stateListing,
  killUntilGone,
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
  type Machine,
  type MachineBackend,
  type MachineKind,
  type MachineShape,
  type MachineSpec,
  type MachineState,
  type PreviewReach,
  type ProviderMove,
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
  type WorkspacePhase as EnginePhase,
  retentionPlan,
  rollback as rollbackGolden,
  snapshotStorage,
  applyMachineContext,
  GUEST_USER_ENV,
  LOCAL_MACHINE_ID,
  TOOLS_PATH,
} from "@wsp/engine";
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
  RecipeDigest,
  TerminalConfig,
  TerminalScheme,
  PortProbeView,
  PortReachView,
  ProjectAgentOutcome,
  ProjectAgentResult,
  ProjectExportResult,
  ProjectExportStage,
  ProjectGolden,
  ProjectImportResult,
  ProjectImportStage,
  ProjectPlan,
  ReachState,
  SessionEvent,
  SessionInterruptResult,
  SessionRenameResult,
  SessionRenamer,
  SessionStartOutcome,
  SessionSteerResult,
  SessionOrigin,
  SessionTitleMaker,
  SessionTitleReader,
  SessionView,
  TitleSource,
  SnapshotStorage,
  ImageAttachment,
  ImageRecord,
  TurnImage,
  TurnResult,
  TurnStatus,
  WorkspaceCreateStage,
  WorkspaceKind,
  WorkspaceOrigin,
  WorkspacePhase,
  WorkspaceProject,
  WorkspaceSize,
  WorkspaceView,
} from "@wsp/protocol";
import { actionRefusal, ALREADY_APPLIED, ALREADY_RUNNING, BLANK_NAME_REFUSAL, catalogRefused, DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DAEMON_VERSION, daemonVersionOf, EMPTY_TITLE_LINE, fmtBytes, fmtDuration, goldenImage, goneRefusal, goneWords, imageMoveRefusal, imagePathIn, imageRecord, imagesBlocked, inFolder, localMachineRefusal, machineCapRefusal, moveTimedOutLine, nameDeletingRefusal, nameTakenRefusal, noAdapterLine, NOTIFY_ME, notifyLine, offeredSize, RECORD_RESTORED, relayedRefusal, RUN_GONE_LINE, sendRefusal, shellQuote, sizeRefusal, sizeWord, startPicks, stillWorkingRefusal, storedTitleSource, titleLine, turnImagesDir, underProject, vaultKeptLine, workspaceState } from "@wsp/protocol";
import { templateHost } from "./host-id.js";
import { machineExecStream, type MachineExecOptions } from "./machine-exec.js";
import { realClock, type Clock } from "./clock.js";
import { writeDaemonRootsScript } from "./daemon-roots.js";
import { DAEMON_TOKEN_SET, assertTokenShape, rotateDaemonTokenScript } from "./daemon-token.js";
import { DEFAULT_IDLE_WINDOW_MS, backstopMs, createIdlePolicy, idleReason } from "./idle.js";
import { connectDaemon, type DaemonReach } from "./reach.js";
import { POLL_INTERVAL_MS, createStatusTracker, machineStateOf, providerSaid, type StatusApi, type StatusWatchOptions } from "./status.js";
import type { Store } from "./store.js";
import { HARNESS_CATALOGS, catalogFromProbe, harnessCatalog, smallestModel } from "./harness-catalog.js";

// --- adapter port -------------------------------------------------------------

export interface HarnessAdapterContext {
  machine: Machine;
  workspaceId: string;
  /** How a turn's process is launched on this machine: the guest's detached-and-polled road on a cloud fork, a real
   * child process on the local computer. The one concern that varies by machine kind and reaches the adapter here. */
  execStream: ExecStreamFactory;
  /** Where the harness keeps its sessions on this machine, by agent id: the folder the golden's sign-in wrote into on
   * a cloud fork, the person's own store on the local computer. */
  home: (agentId: string) => string;
  /** The machine's login environment, exported under the harness's own on every launch: the golden's PATH, so a
   * launch served by a process with a bare one still finds the binary. */
  env: Readonly<Record<string, string>>;
}

/** The machine's login environment: who the guest runs as and the PATH the golden's login shells get. Every fork
 * carries it in its envs at create and every adapter exports it under the harness's own. */
export const GUEST_LOGIN_ENV: Readonly<Record<string, string>> = { ...GUEST_USER_ENV, PATH: TOOLS_PATH };

export interface HarnessStartOptions {
  prompt: string;
  resume?: string;
  cwd?: string;
  /** Catalog slugs the adapter maps to its CLI's flags; absent leaves the CLI's default. */
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
  /** The name the thread is opened under, for a CLI that takes one at launch; every harness is told it again through
   * renameSession once its session is announced, so an adapter whose CLI cannot take it here need not. */
  title?: string;
  /** The turn's images, each already on the road its adapter declared: bytes for an inline adapter, a path on the
   * machine for a file one. Empty on a turn that carries none. */
  images?: readonly TurnImage[];
  onEvent: (event: AdapterEvent) => void;
}

export interface HarnessSession {
  readonly localId: string;
  readonly finished: Promise<TurnResult>;
  /** What a later host process attaches to this turn by, on a harness whose run outlives the host that started it;
   * absent where it does not, and the row is settled as cut when this process goes. */
  readonly run?: string;
  /** Stops the process this session owns; finished settles after it, once session.end has been emitted. */
  interrupt(): Promise<void>;
  /** Present on a harness that takes a message mid-turn; absent means it cannot. not-running when the turn had not
   * started or had ended when the message was offered. */
  steer?(prompt: string): Promise<"accepted" | "not-running">;
}

export interface HarnessAdapter {
  start(options: HarnessStartOptions): HarnessSession;
  /** Re-opens a turn this harness is still running on the machine, by the run handle a session of an earlier host
   * process reported. The run's whole output is read again, so the events the host missed reach this one. `gone` is
   * the machine's own answer that it no longer holds the run, and no event is emitted for one. A machine that
   * answers nothing rejects, and the turn is left where it is. Absent on an adapter whose runs die with the host. */
  attach?(options: AdapterAttachOptions): Promise<HarnessSession | "gone">;
  /** Whether this adapter's sessions carry steer; the catalog tells the composer before a turn runs. */
  readonly steers: boolean;
  /** How this harness takes an image with a turn, and that it takes one at all: absent, a turn carrying an image is
   * refused in this agent's name before the machine is asked for anything. */
  readonly attachments?: AttachmentRoad;
  /** Asks the binary on the workspace's machine what it takes: its lists, its own words for why it has none, or null
   * when it does not answer at all; absent, the table alone answers and nothing runs. */
  probeCatalog?(exec: (command: string) => Promise<string>): Promise<HarnessCatalogAnswer>;
  /** Reads the harness's own title for a session out of its store on the machine; absent on a harness that keeps none. */
  sessionTitle?: SessionTitleReader;
  /** Writes a person's name for a session into that same store; absent on a harness that keeps no name of a person's. */
  renameSession?: SessionRenamer;
  /** Asks the harness itself for a name for a thread it has just replied in; absent on a harness that cannot answer a
   * question of its own. */
  titleFor?: SessionTitleMaker;
  /** What a turn's command is exported with on the machine; a plain exec on the workspace runs with the same. Absent
   * means nothing is exported and both run with the machine's own environment only. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Called per session start with the workspace's CURRENT machine (it can change on wake/upgrade). */
export type HarnessAdapterFactory = (ctx: HarnessAdapterContext) => HarnessAdapter;

// --- events -------------------------------------------------------------------

export type EventListener = (event: EventUnion) => void;

export interface EventBus {
  on(type: EventUnion["type"] | "*", listener: EventListener): () => void;
  /** The retained events after sequence `after`, oldest first, with head, the newest sequence issued (0 before any),
   * and stream, the id minted for this process's sequences. gap: `after` is not a cursor into this stream, because it
   * came with another stream id, is older than what is retained, or is past head, so nothing is replayed and the
   * caller must refetch. */
  since(after: number | undefined, stream: string | undefined): { stream: string; head: number; events: EventUnion[]; gap: boolean };
}

/** Events kept for a socket that comes back: one ring shared by every workspace, holding the status and cost ticks
 * that no transcript keeps. 5000 bounds it at one transcript's worth of memory (TRANSCRIPT_CAP); a cursor that fell
 * off it gets a gap, and the client refetches the list, the statuses and sessions.history and converges from those. */
const EVENT_RING_CAP = 5000;

/** How long a machine's catalog answer stands before the binary is asked again; t3code's provider health cadence. */
export const CATALOG_TTL_MS = 5 * 60_000;
/** The probe measured 1 to 3 s on a Mac; a guest that takes longer than this is answered from the table. */
const CATALOG_PROBE_TIMEOUT_MS = 30_000;

/** How long a harness's title for a session stands before its store is read again on a refresh. Clients reload the
 * index on every session event, and a person renaming a session in the harness waits at most this long to see it. */
export const SESSION_TITLE_TTL_MS = 10_000;
/** A grep of one session file or a row out of one sqlite; a guest slower than this keeps the title it last gave. */
const SESSION_TITLE_TIMEOUT_MS = 15_000;
/** How many of a workspace's harness sessions one refresh asks about, newest first: a store read is an exec on the
 * machine, and an index at SESSION_INDEX_CAP must not cost one per row. */
export const SESSION_TITLE_REFRESH_MAX = 20;
/** How long the harness has to answer the one title question a thread costs. A claude-sonnet-5 answer measured 1.4 s
 * of model time on 2026-09-07; this is the wedged case, and a thread that hits it keeps its opening words. */
export const TITLE_MAKE_TIMEOUT_MS = 30_000;

function eventBus(): EventBus & { emit(event: EventUnion): void } {
  const listeners = new Map<string, Set<EventListener>>();
  const ring: EventUnion[] = [];
  const stream = randomUUID();
  let head = 0;
  return {
    on(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    since(after, from) {
      if (after === undefined) return { stream, head, events: [], gap: false };
      const oldest = head - ring.length + 1;
      const foreign = from !== undefined && from !== stream;
      if (foreign || after > head || after < oldest - 1) return { stream, head, events: [], gap: true };
      return { stream, head, events: ring.slice(after - oldest + 1), gap: false };
    },
    emit(event) {
      const stamped: EventUnion = { ...event, seq: ++head };
      ring.push(stamped);
      if (ring.length > EVENT_RING_CAP) ring.splice(0, ring.length - EVENT_RING_CAP);
      for (const type of [event.type, "*"] as const) {
        for (const l of listeners.get(type) ?? []) l(stamped);
      }
    },
  };
}

// --- runtime ------------------------------------------------------------------

export interface WorkspaceSpec {
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
}

/** What a create answers: the view, and a notice when a builder kept after a save was stopped to make room. */
export interface CreatedWorkspace extends WorkspaceView {
  notice?: string;
}

export interface CreateWorkspaceOptions extends WorkspaceSpec {
  /** Snapshot id of the golden image to fork. */
  golden: string;
  name: string;
  /** Auto-nap window; undefined takes the runtime default, null turns auto-nap off. */
  idleWindowMs?: number | null;
}

/** A folder's archive as the host packs it: the bytes, what went in, the secret-shaped paths left out, and the ones
 * that went in rewritten as the plan offered. */
export interface PackedProject {
  tar: Buffer;
  files: number;
  bytes: number;
  cut: string[];
  rewritten: string[];
}

/** The agents whose state for the folder travels: each with its home on the machine and whether the agent is there
 * to read the state once it is keyed to `dest`. */
export interface StateRequest {
  dest: string;
  agents: readonly { agent: string; home: string; present: boolean }[];
}

/** The agents' state as the host packs it: an archive of each agent's files at its machine home, for the guest's
 * root, what became of each agent, and the merge scripts in the archive by agent, each at its path on the guest, for
 * the runtime to run once the archive has landed. */
export interface PackedState {
  tar: Buffer;
  agents: ProjectAgentResult[];
  merges: { agent: string; script: string }[];
}

/** A folder on this computer as the host reads it; the runtime never touches the disk itself. `plan` reads names
 * and sizes, `pack` reads the bytes once consent is known: a secret-shaped file travels only when `carry` names it,
 * or rewritten when `rewrite` names a path the plan offered a rewrite for. `packState` reads the named agents'
 * homes for their state for the folder, re-keyed to the destination for the agents on the machine. */
export interface ProjectBundler {
  plan(): Promise<ProjectPlan>;
  pack(carry: ReadonlySet<string>, rewrite: ReadonlySet<string>): Promise<PackedProject>;
  packState(req: StateRequest): Promise<PackedState>;
}

/** The folder's archive as it came off the machine, rooted at the folder, and the agents' state that came with it. */
export interface LandRequest {
  /** The folder's path on the machine: the key its agent state on the machine is stored under. */
  source: string;
  /** Where the folder lands on this computer, absolute. */
  dest: string;
  /** Remove what is at dest first; without it an existing dest is refused with kind "exists". */
  replace: boolean;
  /** The archive as a file on this computer, streamed off the machine rather than held in memory; whoever asked for
   * the landing removes it afterwards. */
  archive: string;
  /** The agents' state under the guest's root as an archive on this computer, each agent's home on the guest by
   * catalog id, and the agents whose state comes home (every one with sessions for the folder when absent). */
  state?: { archive: string; homes: Readonly<Record<string, string>>; agents?: readonly string[] };
  /** The stores an agent keeps for every project that the listing on the machine could not read: nothing of theirs is
   * in the archive, so the landing report carries a row for each one saying which store and why. */
  unread?: readonly UnreadStore[];
}

/** This computer's own folders as a browser tab's picker walks them, one level at a time; the runtime never touches
 * the disk itself, the host that owns it does. The desktop shell has the system dialog and never asks for this. */
export interface HostFolders {
  list(req: { dir?: string; hidden?: boolean }): Promise<HostFolderListing>;
}

/** The person's terminal config on the computer running the host, read again on every ask; the runtime never reads
 * the disk itself, the host that owns it does. */
export interface HostTerminalConfig {
  read(scheme?: TerminalScheme): Promise<TerminalConfig>;
}

/** One agent's result with its catalog name, for the sentence the runtime says about it. */
export type LandedAgent = ProjectAgentResult & { name: string };

/** What landed on this computer: the folder's files and bytes, and each agent found on the machine with sessions for
 * the folder and what became of its state here. */
export interface LandedProject {
  files: number;
  bytes: number;
  agents: LandedAgent[];
}

/** This computer's side of an export, as the host does it; the runtime never touches the disk itself. `probe` looks at
 * the destination before anything is read from the machine, `land` extracts the folder beside its destination and
 * moves it into place, then keys the agents' state to it in their homes here as an overlay. */
export interface ProjectLander {
  /** What the machine's archive leaves behind: the bundle's own cache rule, so the trip home drops what the trip out dropped. */
  caches: CacheRule;
  /** How many files sit at dest on this computer now, or nothing when the path is free. */
  probe(dest: string): Promise<{ files: number } | undefined>;
  land(req: LandRequest): Promise<LandedProject>;
}

export interface ProjectExportOptions {
  workspaceId: string;
  /** The folder on the machine, absolute. */
  source: string;
  /** Where it lands on this computer, absolute. */
  dest: string;
  /** Remove what is at dest first; without it an existing dest is refused with kind "exists" before anything is read. */
  replace?: boolean;
  /** The agents whose state comes home, by catalog id; absent, every agent with sessions for the folder on the machine. */
  agents?: readonly string[];
  lander: ProjectLander;
}

export interface ProjectImportOptions {
  workspaceId: string;
  /** The folder on this computer, absolute; named in the events. */
  source: string;
  /** Where the folder lands on the machine, absolute; its parents are made. */
  dest: string;
  /** Remove what is at dest first; without it an existing dest is refused with kind "exists". */
  replace?: boolean;
  /** The secret-shaped paths from the plan that may travel as they are; every other one is cut and named. */
  carry?: readonly string[];
  /** The paths the plan offered a rewrite for that land rewritten; wins over carry for the same path. */
  rewrite?: readonly string[];
  /** The plan's agents whose state for the folder travels, by catalog id; nothing of any other agent is read. */
  agents?: readonly string[];
  bundler: ProjectBundler;
}

interface WorkspaceRecord extends WorkspaceView {
  /** cloud or local; a record stored before local existed has none and reads cloud. */
  kind: WorkspaceKind;
  spec: Pick<WorkspaceSpec, "envs" | "labels">;
  idleWindowMs?: number | null;
  /** What the provider built, read back after every create (it may clamp the
   * request); the rail and the rate use this, never what was asked for. */
  size: WorkspaceSize;
  firstLife: boolean;
  /** The provider's view of the current machine when it was created; a wake compares against it. */
  shape?: MachineShape;
  /** With phase gone: the provider's words when the machine was found missing; cleared when a fresh machine lands. */
  gone?: string;
}

interface LiveWorkspace {
  record: WorkspaceRecord;
  ws: Workspace;
  machine: Machine;
  /** Moves with every write of the record; the status poll drops a row it built under an older one. */
  generation: number;
  /** The wake in flight, so a second caller joins it instead of resuming twice. */
  waking?: Promise<WorkspaceView>;
  /** The nap in flight: a second nap joins it, a wake waits for it. */
  napping?: Promise<WorkspaceView>;
  /** The record following a machine the provider runs under a napping word: a second verb that read the same fact joins it. */
  adopting?: Promise<void>;
  /** The delete in flight: a second delete joins it, and the name stays held until the record is dropped. */
  deleting?: Promise<void>;
  /** The pause or wake in flight: what the row calls it, when it began, and when its provider calls stop waiting. */
  budget?: MoveBudget;
  /** Cancels the one read armed after a wake gave up. */
  lateRead?: () => void;
  /** Set from the fork until the create is ready: the sweep knows the machine, nothing else can reach it yet. */
  creating?: true;
  /** Why the nap in flight kept the previous vault, for the napping status it pushes; said once. */
  vaultNote?: string;
}

/** One pause or wake's time: the word its row uses, when the verb started, and the instant its provider calls stop
 * waiting. Every call the verb makes shares it, so the row's words describe the whole verb. */
interface MoveBudget {
  what: "pause" | "wake";
  started: number;
  deadline: number;
}

/** Reports one create stage as it is reached; the runtime stamps id, name and elapsed time. */
type StageReport = (stage: WorkspaceCreateStage, message: string, notice?: string) => void;

export interface SessionHandle {
  readonly id: string;
  readonly workspaceId: string;
  readonly finished: Promise<TurnResult>;
  /** The runtime's id for the turn, as its events carry it. */
  readonly turnId: string;
  /** How the start that handed this out went: steered means the handle is the thread's running turn, not a new one. */
  readonly outcome: SessionStartOutcome;
  view(): SessionView;
  interrupt(): Promise<void>;
  steer?(prompt: string): Promise<"accepted" | "not-running">;
}

/** What every golden built by this runtime gets; the host wires it (the daemon
 * bundle and the harness install script live there, not in the runtime). */
export interface GoldenRecipe {
  setup: string;
  /** Must exit 0 on a fork of the snapshot before a version is sealed. */
  smoke: string;
  baseTemplate?: string;
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
  /** A returned string rides the deploying-daemon stage as its detail (the guest's Node version). */
  deployDaemon?: (machine: Machine) => Promise<void | string>;
  /** The person's files, tools and agents from the saved recipe; applied after the daemon, before the harness. */
  import?: GoldenImport;
  /** Every exec on a builder or its smoke fork, once it has returned or failed; the host's run log. */
  onExec?: (exec: GoldenExec) => void;
}

/** One exec on a golden machine as the run log records it: the command, what came back, and how long it took. */
export interface GoldenExec {
  machineId: string;
  cmd: string;
  ms: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** The exec itself failed (the machine gone, the request refused); no exit code exists. */
  error?: string;
}

/** What a host wires for the one local workspace this computer can be: the backend that answers with this computer,
 * how a turn's process is launched on it (a real child, not the guest's polled road), where each harness keeps its
 * own sessions here, and the environment a turn runs under. Absent, the runtime serves cloud workspaces alone and
 * `createLocal` is refused. The one place the local variant is registered beside the cloud default. */
export interface LocalWiring {
  backend: MachineBackend;
  /** The launch factory for a turn on this computer, under the limits the registry hands every turn (the turn's own
   * by default, none for the exec verb), so a local turn is cut the way a cloud turn is. */
  execStream: (opts?: MachineExecOptions) => ExecStreamFactory;
  home: (agentId: string) => string;
  env: Readonly<Record<string, string>>;
}

export interface RuntimeOptions {
  backend: MachineBackend;
  /** The local computer as a workspace, when a host wires it; the cloud backend serves every other workspace. */
  local?: LocalWiring;
  store: Store;
  adapters: Record<string, HarnessAdapterFactory>;
  /** Required for golden.prepare / golden.seal; the scripted golden.build carries its own. */
  goldenRecipe?: GoldenRecipe;
  /**
   * Explicit guest paths carried across an upgrade. Default: everything under
   * /root except golden-provided dirs (VAULT_SKIP), enumerated at export time.
   */
  vaultPaths?: string[];
  /** What a vault export leaves behind under those paths: the project bundle's cache rule, so a checkout's installs,
   * build output and nested worktrees never travel and never count against the nap-time cap. */
  vaultCaches?: CacheRule;
  /** Defaults for the status poller / cost ticker (tests shrink the intervals). */
  status?: StatusWatchOptions;
  idle?: { defaultWindowMs?: number };
  /** Drives the idle window and the transcript debounce; tests inject one they advance by hand. */
  clock?: Clock;
  /** How long a seal waits for a killed machine to read gone (tests shrink it). */
  killConfirm?: KillConfirm;
  /** How long a seal waits between snapshot attempts the provider refused (tests shrink it). */
  snapshotRetryMs?: number;
  /** Names this machine and install on the holds it writes, so two machines over one state file never mistake
   * each other's. The entry points pass hostIdentity(); the bare hostname when absent, which touches no disk. */
  hostId?: string;
  wake?: WakeOptions;
  /** How long a pause gets in all before the row says it did not complete (tests shrink it). */
  nap?: { pauseDeadlineMs?: number };
  /** How long one read of the provider gets after a pause or a resume missed its deadline (tests shrink it). */
  providerReadMs?: number;
  /** The token every daemon this runtime reaches is given; minted fresh per process when absent (tests pin one). */
  daemonToken?: string;
  /** How long a daemon gets to announce itself when an update reads the version either side of its deploy; the
   * hello lands on connect, so a daemon that is there answers in one round trip (tests shrink it). */
  daemonHelloTimeoutMs?: number;
}

export interface WakeOptions {
  /** How long a resumed guest's daemon gets to answer through the edge before the wake counts as failed. */
  pingTimeoutMs?: number;
  /** How long a wake gets in all, across its resume, re-pause and second resume, before the row says it did not
   * complete (tests shrink it). */
  deadlineMs?: number;
  /** How long after a wake gave up the provider is read once more for a resume that landed late (tests shrink it). */
  lateReadMs?: number;
  /** A nap-time vault archive over this is not stored (a warning names the size). */
  vaultCapBytes?: number;
}

const WAKE_PING_TIMEOUT_MS = 30_000;
/** How long a pause and a wake get in all, each provider call inside them sharing the budget: a pause takes about
 * 75 s live and a resume under a minute, and each verb sends its call twice at most. */
const PAUSE_DEADLINE_MS = 4 * 60_000;
const WAKE_DEADLINE_MS = 6 * 60_000;
/** One read of the provider after a missed deadline; the client sets no request timeout of its own. */
const PROVIDER_READ_MS = 30_000;
/** A resume the runtime stopped waiting on can still land: one read this long after a wake gave up finds it. */
const WAKE_LATE_READ_MS = 3 * 60_000;
/** A daemon that is up answers the hello on connect; a machine whose daemon is gone costs this once on each side of an update. */
const DAEMON_HELLO_TIMEOUT_MS = 5_000;
/** The probe's fetch bound; the frame keeps loading meanwhile, so silence costs nothing but the sentence. */
const PORT_PROBE_TIMEOUT_MS = 10_000;
/** How the import's done line reads each agent's outcome, after the agent's name. */
const OUTCOME_WORDS: Record<Exclude<ProjectAgentOutcome, "failed">, string> = {
  moved: "moved",
  "transcript-only": "transcripts landed but not yet in its session list",
  carried: "carried unchanged since it is not on the machine",
  nothing: "had nothing to carry",
};
function outcomeWords(a: ProjectAgentResult): string {
  if (a.outcome === "failed") return `failed: ${a.error ?? "no reason given"}`;
  const word = OUTCOME_WORDS[a.outcome];
  const note = a.note !== undefined ? ` (${a.note})` : "";
  if (a.outcome === "moved" && a.rows !== undefined) return `${word}, ${a.rows > 0 ? `${plural(a.rows, "row")} merged` : "its rows already there"}${note}`;
  if (a.outcome === "transcript-only") return `${word}${note}`;
  return word;
}
/** Bounds a merge that hangs; one project's rows take python3 well under it. */
const MERGE_DEADLINE_MS = 120_000;
/** Bounds a listing that hangs; walking the agents' homes takes python3 well under it, and past what one inline exec is allowed to run. */
const LISTING_DEADLINE_MS = 120_000;

/** Runs one agent's merge script on the machine and folds what it printed into the agent's result: rows merged is
 * moved, a store not there yet leaves the rows waiting with the reason, a failure carries the last line of stderr.
 * The script is removed by its own exec once the run ended, so a run the deadline killed leaves nothing behind. */
async function mergeOnMachine(machine: Machine, script: string, agent: ProjectAgentResult): Promise<ProjectAgentResult> {
  const dir = script.slice(0, script.lastIndexOf("/"));
  let run: ExecResult;
  try {
    run = await machine.run(`python3 ${shellQuote(script)}`, { deadlineMs: MERGE_DEADLINE_MS });
  } finally {
    await machine.exec(`rm -f ${shellQuote(script)}; rmdir ${shellQuote(dir)} 2>/dev/null`).catch(() => undefined);
  }
  if (run.exitCode !== 0) {
    const why = run.stderr.trimEnd().split("\n").at(-1) || "no output";
    return { ...agent, outcome: "failed", error: `the merge on the machine failed (exit ${run.exitCode}): ${why}` };
  }
  try {
    const out = parseMergeOutput(run.stdout);
    if ("waiting" in out) return { ...agent, note: out.waiting };
    return { ...agent, outcome: "moved", rows: out.merged, ...(out.note !== undefined ? { note: out.note } : {}) };
  } catch (e) {
    return { ...agent, outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/** The same for the export's done line, where the state lands on this computer; `carried` cannot happen here. */
const HOME_WORDS: Record<Exclude<ProjectAgentOutcome, "failed">, string> = {
  moved: "moved",
  "transcript-only": "transcripts landed but not yet in its session list here",
  carried: "carried unchanged",
  nothing: "had nothing to bring",
};

/** One agent's export outcome in words: the name, the sessions counted, what became of them, the rollouts skipped. */
function homeOutcome(a: LandedAgent): string {
  const counted = a.sessions === undefined ? "" : ` (${plural(a.sessions, "session")})`;
  const skipped = a.skipped === undefined || a.skipped === 0 ? "" : `, ${plural(a.skipped, "indexed rollout")} not under sessions/ skipped`;
  return `${a.name}${counted} ${a.outcome === "failed" ? `failed: ${a.error ?? "no reason given"}` : HOME_WORDS[a.outcome]}${skipped}`;
}

/** Vite's and Next's refusals fit in a few hundred bytes; a page that loaded fine is not carried back whole. */
export const PORT_PROBE_BODY_CAP = 2048;
const VAULT_CAP_BYTES = 200 * 1024 * 1024;
/** Blob collection: the latest nap-time vault per workspace id. */
const VAULTS = "vaults";

/** What `until` rejects with when the deadline passed and not the promise, so a caller that retries can tell the
 * two apart. */
class DeadlineError extends Error {}

/** What settleMove ends with when the provider never answered the move (a missed deadline, a call the network
 * dropped), carrying the last such failure as its cause; a refusal the provider answered with is rethrown as itself. */
class MoveUnansweredError extends Error {}

/** Rejects once the deadline passes; the underlying promise is left to settle on its own. The deadline is read on
 * the clock given, so a move budget measured on an injected clock times out on that clock. */
function until<T>(p: Promise<T>, deadline: number, what: string, clock: Clock = realClock): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ms = Math.max(0, deadline - clock.now());
    const cancel = clock.schedule(() => reject(new DeadlineError(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      v => { cancel(); resolve(v); },
      e => { cancel(); reject(e); },
    );
  });
}

/** Size fields the provider reports that differ from what was created, as
 * "field got != expected". createdAt is left out on purpose: Solari moves it
 * to the resume time on every resume, healthy ones included (measured 3/3
 * with exec answering right after), so it only rides along in the reason. */
function shapeFault(expected: MachineShape, actual: MachineShape): string | undefined {
  const diffs: string[] = [];
  for (const key of ["cpu", "memMb"] as const) {
    const want = expected[key];
    const got = actual[key];
    if (want !== undefined && got !== undefined && want !== got) diffs.push(`${key} ${got} != ${want}`);
  }
  return diffs.length === 0 ? undefined : diffs.join(", ");
}

/** Dirs the golden image already provides on every fresh fork; re-vaulting
 * them is dead weight, and extracting them with --recursive-unlink would
 * delete the fork's own copies first (the claude install lives in .local). */
const VAULT_SKIP = new Set([".local", ".cache", ".npm"]);

/** One RFC 1123 label: lowercase alphanumerics and hyphens, at most 63 chars, hyphen-free at both ends. */
function hostnameFor(name: string): string {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return label === "" ? "wsp" : label;
}

/** A fresh fork boots as "localhost"; naming it is cosmetic, so a guest that refuses is only logged. Hands back the
 * name set, or the refusal. */
async function setHostname(machine: Machine, name: string): Promise<{ host: string; refused?: string }> {
  const host = hostnameFor(name);
  const res = await machine
    .exec(`hostname ${host} && echo ${host} > /etc/hostname`)
    .catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) }));
  if (res.exitCode === 0) return { host };
  const refused = `hostname ${host} on ${machine.id} failed: ${res.stderr.trim()}`;
  console.warn(refused);
  return { host, refused };
}

export interface GoldenBuildRequest extends Omit<BuildGoldenOptions, "backend" | "manifest" | "hostId"> {
  /** Store key; several goldens can coexist. */
  name?: string;
}

/** One version the promote road visited: recorded with the template promoted for it, with how many templates
 * already carried the name when the listing was given, or left as it was with the reason, a lost snapshot in the
 * row's own words. */
export type GoldenPromotion = { golden: string; version: number } & ({ templateId: string; sharing?: number } | { error: string });

export interface GoldenUpgradeResult {
  manifest: GoldenManifest;
  version: GoldenVersion;
  /** builder: the delta went onto the builder kept since the save; fork: onto a fresh fork of the previous head. */
  road: "builder" | "fork";
  /** The previous version's snapshot was deleted and the version dropped from the manifest. */
  previousDropped: boolean;
  /** The builder is still running for its window; false when the cap fallback or a drop ended it. */
  builderKept: boolean;
}

/** How long a builder built from a recipe stays running after its seal, so one more change re-snapshots it (about
 * 11 s, measured) instead of forking. Our clock on the record, since every read of the machine resets the provider's. */
export const GRACE_MS = 10 * 60_000;

/** A machine of this setup's the sweep found with no record and recorded again, under the id and name its fork stamped. */
export interface AdoptedMachine {
  id: string;
  workspaceId: string;
  name: string;
  phase: WorkspacePhase;
}

/** What one sweep did: the engine's kills and sparings, plus the machines it recorded rather than killed. */
export interface SweepResult extends ReapResult {
  adopted?: AdoptedMachine[];
}

export interface Runtime {
  readonly events: EventBus;
  readonly backend: MachineBackend;
  readonly workspaces: {
    create(opts: CreateWorkspaceOptions): Promise<CreatedWorkspace>;
    /** The one local workspace: this computer. Refused when this host wired no local backend, when one already
     * exists (one per host), and for a name another workspace holds. It forks nothing; the machine already exists. */
    createLocal(name: string): Promise<WorkspaceView>;
    get(id: string): Promise<WorkspaceView>;
    list(): Promise<WorkspaceView[]>;
    nap(id: string): Promise<WorkspaceView>;
    wake(id: string): Promise<WorkspaceView>;
    upgrade(id: string, spec?: WorkspaceSpec): Promise<WorkspaceView>;
    /** Moves the workspace onto its golden's head version, carrying its files across. Refused in one sentence when
     * the machine is not running, the image is a project golden, or no golden knows the image; a workspace past
     * those and already on the head is returned untouched. */
    updateImage(id: string): Promise<WorkspaceView>;
    /** Fresh golden fork with the nap-time vault, old machine killed, id and name kept: the way out of a zombie. */
    rebuild(id: string): Promise<WorkspaceView>;
    /** Names the workspace, under the rules a fork's name takes: the space around the name is dropped, and a name
     * another workspace holds, one a fork is landing under and a blank one are refused (kind conflict) naming the
     * holder. A name the workspace already carries answers with the record untouched. The record alone changes, so
     * this goes out as workspace.renamed and never as workspace.created, which the awake meter and the auto-nap
     * window read as the machine coming up. Threads on the machine are addressed by id and run on through it. The
     * machine's own metadata keeps the name it was forked under, since the provider takes metadata at create and
     * its API offers no update; the next fork or rebuild stamps the new one, and the name is kept here beside the
     * records so a sweep that records this machine after the store lost its workspace document restores it under
     * the name a person gave rather than the fork's. */
    rename(id: string, name: string): Promise<WorkspaceView>;
    /** Snapshots the running machine as a project golden: the golden it stands on plus the project as it is now, so a
     * fork of the snapshot starts a task with the project in place. Refused in one sentence when the workspace is not
     * running or holds no project; a machine that was ever resumed is refused by the engine (kind notFirstLife). The
     * guest freezes for about three seconds and stays first-life. */
    snapshot(id: string): Promise<ProjectGolden>;
    /** The recipe's daemon deploy on the running machine, replacing the daemon there, then this runtime's token
     * written again so the next reach opens it. The runtime runs it by itself when a machine's daemon is older than
     * this wsp. Throws on a workspace that is not running or a runtime without the deploy. */
    updateDaemon(id: string): Promise<void>;
    delete(id: string): Promise<void>;
    /** Drops a workspace whose machine the provider no longer has: its record, transcripts and sessions go and nothing
     * is asked of the provider. Refused with the reason (kind conflict) while the machine still exists. */
    forget(id: string): Promise<void>;
    /** A person acted in the workspace; its idle window starts over. */
    touch(id: string): Promise<void>;
    /** One-shot command on the workspace's machine (plumbing for clients; sessions are the main road). */
    exec(id: string, cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
    /** The command, word by word, launched the way a harness turn is: detached on the machine, each word quoted for
     * its shell, exported with what the default harness's turns get, its output streamed by line, its exit code at
     * the end; in cwd when given, else the home folder, as a harness turn does. Rejects when the workspace or that
     * harness's adapter is unknown; a launch that fails ends the stream. */
    execStream(id: string, argv: ReadonlyArray<string>, cwd?: string): Promise<ExecStream>;
    /** How a browser dials this workspace's daemon; throws on backends without preview URLs. */
    daemonReach(id: string): Promise<DaemonReachView>;
    /** The public route to one guest port, for a browser to frame; same caching and refusal as daemonReach. */
    portReach(id: string, port: number): Promise<PortReachView>;
    /** One fetch of that route from here, as the frame would see it, redirects unfollowed; rejects when nothing answers at
     * all. A 401 is the edge refusing the token, so the port's route is reminted before the reply and the next portReach
     * carries the fresh one. */
    portProbe(id: string, port: number): Promise<PortProbeView>;
  };
  readonly projects: {
    /** Lands the host's bundle of a folder on the workspace's machine; progress rides project.import events. */
    import(opts: ProjectImportOptions): Promise<ProjectImportResult>;
    /** Brings a folder and the agent state keyed to it home from the workspace's machine; progress rides project.export events. */
    export(opts: ProjectExportOptions): Promise<ProjectExportResult>;
  };
  readonly sessions: {
    /** Starts a turn; never a second one on a session whose turn is running. A start on a thread whose turn runs
     * steers the message into it when the harness steers (the handle is the running turn's, outcome steered), else
     * waits for the turn to end and then starts (outcome queued), several such starts one after another in order. */
    start(
      workspaceId: string,
      opts: {
        prompt: string;
        harness?: string;
        resume?: string;
        /** The thread the message goes to, by its runtime id: its latest turn is resumed, and a thread whose harness
         * never announced a session (a launch that never reached the machine) takes the message as a first turn on
         * that same thread. Rejects when no thread on the workspace has that id. */
        thread?: string;
        cwd?: string;
        model?: string;
        effort?: string;
        permissionMode?: string;
        contextWindow?: string;
        /** Absent means a person asked. */
        startedBy?: SessionOrigin;
        /** Where the request reached the host from: here (this computer's app, CLI or MCP) or relayed from a machine.
         * A local workspace refuses a relayed one; absent reads here. Today nothing relays, so it is here in practice. */
        origin?: WorkspaceOrigin;
        /** The client's id for this send, stamped on the turn's session.start as sent. */
        requestId?: string;
        /** A thread id, or NOTIFY_ME: kept on the thread this start opens, so the end of every turn on it sends one
         * line (notifyLine) into that thread through this same start, or, for me, records it for the person. A start
         * that resumes a thread keeps what the thread had. Rejects when no thread has that id. */
        notify?: string;
        /** The name the thread takes as a person's: it stands from the first second, the harness is told it too, and
         * no generated title ever replaces it. Rejects on a blank one. */
        title?: string;
        /** The images the message carries. Rejects over the caps, and rejects naming the agent when that agent's
         * adapter reads no image, both before the machine is asked for anything. */
        attachments?: readonly ImageAttachment[];
      },
    ): Promise<SessionHandle>;
    /** Every turn this state file knows, the ones before a restart as they were last written. One that was still
     * running then reads running while its machine still holds its run, since the run is re-opened at load and goes
     * on to its reply; one whose run no machine has left reads failed. */
    list(workspaceId?: string): Promise<SessionView[]>;
    /** The workspace's persisted session events, oldest first; a chat replays these on mount. */
    history(workspaceId: string): Promise<SessionEvent[]>;
    /** Stops the session's running turn through its harness; a turn already over or an unknown id answers, never throws. */
    interrupt(sessionId: string): Promise<SessionInterruptResult>;
    /** Sends a message into the session's running turn through its harness and records it as session.steer once the
     * harness took it; a turn already over, a harness without steer or an unknown id answers. Refuses like start
     * while the workspace is pausing or paused. */
    steer(sessionId: string, opts: { prompt: string; requestId?: string }): Promise<SessionSteerResult>;
    /** Names the session's harness session in the harness's own store, in the field the harness itself writes, and
     * keeps the name on every row of the thread; a harness that keeps no name of a person's, a store without that
     * session and an unknown id answer. Refuses while the workspace cannot be reached, as a listing's read needs it. */
    rename(sessionId: string, title: string): Promise<SessionRenameResult>;
  };
  readonly harnesses: {
    /** What each harness with an adapter takes at launch; the composer's pickers render from this. With a running
     * workspace each adapter that probes is asked on its machine, at a session start too, and its answer, or the table
     * when it gives none, is kept per machine and harness for CATALOG_TTL_MS; without one, or on a workspace that is not
     * running, the table answers. */
    list(workspaceId?: string): Promise<HarnessCatalog[]>;
  };
  readonly golden: {
    build(opts: GoldenBuildRequest): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
    get(name?: string): Promise<GoldenManifest | undefined>;
    /** Boots a first-life builder from the recipe; a person sets it up on its live screen, then seals it.
     * Once `signal` aborts the call rejects with PrepareStoppedError: a machine this prepare made is killed by its
     * recorded id and its record dropped (a create still in flight is killed as it lands); a builder it attached to
     * keeps its first life, its hold is released and its record stays reusable. */
    prepare(opts?: { name?: string; kind?: MachineKind; signal?: AbortSignal }): Promise<GoldenBuilderView>;
    /** Snapshot, smoke-fork, append a version. A builder built from a recipe is kept running for GRACE_MS after a
     * successful seal so one more change re-snapshots it; any other builder, and every failed or refused seal, consumes
     * it, except a snapshot the provider refused: that builder is left as it was and stays recorded for the next init
     * to attach to while the provider still has it (SnapshotFailedError says which). keepBuilder false ends it with
     * the seal instead: a caller with no process left to end the window would otherwise leave it billing until the
     * next host sweeps it. logins: what each sign-in asked of the builder came to, stamped on the version. */
    seal(builderId: string, opts?: { logins?: GoldenLogin[]; keepBuilder?: boolean }): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
    /** The recipe the golden's head was built from, or nothing when it was not built from one. */
    recipe(name?: string): Promise<RecipeDigest | undefined>;
    /** The next version from the recipe delta: on the builder kept since the save when there is one, else on a
     * fresh fork of the head. Seals it, repoints the head, and drops the previous version's snapshot when asked. */
    upgrade(opts: { name?: string; delta: GoldenDelta; keepPrevious?: boolean; logins?: GoldenLogin[] }): Promise<GoldenUpgradeResult>;
    /** How a browser dials the builder's daemon; the builder is not a workspace, so it has its own road. */
    builderReach(builderId: string): Promise<DaemonReachView>;
    builders(): Promise<GoldenBuilderView[]>;
    /** Stops a builder of this setup by its recorded id and drops the record; one another live process holds or another setup owns is refused. */
    kill(builderId: string): Promise<void>;
    /** Moves the golden's head; new forks follow it, workspaces already forked keep their image. */
    rollback(version: number, name?: string): Promise<GoldenManifest>;
    /** Makes every version of the golden durable: one with no template gets a fresh promotion of its snapshot and
     * forks boot from it from then on; one whose snapshot the provider has lost is a row saying so and nothing is
     * written. Undefined on a backend without templates; empty when every version already has one. */
    promote(name?: string): Promise<GoldenPromotion[] | undefined>;
    /** Every project golden this runtime took, oldest first. */
    projects(): Promise<ProjectGolden[]>;
    /** Every snapshot on the account by count, size and monthly cost past the free GB, sized from the provider's
     * listing and split by who made each one; undefined on a backend that cannot list snapshots. */
    storage(): Promise<SnapshotStorage | undefined>;
    /** The snapshots and templates this host made that nothing here records, and the rows left alone beside them;
     * undefined on a backend that cannot list snapshots. */
    orphans(): Promise<AccountOrphans | undefined>;
    /** Deletes what orphans() names, each orphan template before the snapshots (the provider refuses to delete a
     * snapshot a template stands on). The split is read again first, so nothing recorded since is touched, and
     * nothing without this host's mark is ever passed to a delete. */
    deleteOrphans(): Promise<OrphansDeleted | undefined>;
    /** The golden's ancestors older than its head and the head's parent, with what deleting them frees, minus every
     * version a workspace of this runtime was forked from; undefined with no golden or no snapshot listing. */
    retention(name?: string): Promise<RetentionPlan | undefined>;
    /** Deletes the snapshots retention offers and drops those versions and their recipes from the manifest. The plan
     * is read again first, so a workspace forked since the offer keeps its version; a delete the provider refuses
     * keeps the version and is reported by version. */
    prune(name?: string): Promise<{ dropped: GoldenVersion[]; failed: { version: number; message: string }[] }>;
  };
  /** Enriched status (machine state, daemon reach, size, rate) + cost ticker. */
  readonly status: StatusApi;
  /** This state file's owner id, stamped on every machine it creates: a machine wearing another one was made by
   * another host standing on the same account. Minted on the first read when the state file has none. */
  owner(): Promise<string>;
  /** Records this state file's workspace machines that no record claims, kills its builders and smoke forks that none
   * claims plus orphans past their backstop, and lists the running machines it left alone. */
  reap(olderThanMs?: number): Promise<SweepResult>;
  /** Writes every transcript still waiting on its debounce; the store is complete once this resolves. */
  close(): Promise<void>;
}

/** What this host left on the account that nothing here records, and what it deliberately leaves alone beside it.
 * A snapshot carries no provider metadata, so a row is this host's only by the mark in its name; anything without
 * that mark is another host's or a person's and is named, never deleted. */
export interface AccountOrphans {
  snapshots: SnapshotRow[];
  templates: TemplateRow[];
  /** What the orphan snapshots hold, and what deleting them takes off the monthly bill once storage is billed. */
  freedBytes: number;
  savesUsdPerMonth: number;
  /** No mark of this host, so nothing here may touch them. */
  others: { snapshots: SnapshotRow[]; templates: TemplateRow[] };
}

export interface OrphansDeleted {
  snapshots: SnapshotRow[];
  templates: TemplateRow[];
  /** One per delete the provider refused; the row stays on the account. */
  failed: { id: string; name?: string; message: string }[];
}

const WORKSPACES = "workspaces";
const GOLDENS = "goldens";
/** The recipe each sealed version was built from, keyed `<name>@v<version>`; the next update diffs against the head's. */
const GOLDEN_RECIPES = "golden-recipes";
/** One document per project golden, keyed by its snapshot id. */
const PROJECT_GOLDENS = "project-goldens";
const recipeKey = (name: string, version: number): string => `${name}@v${version}`;
const TRANSCRIPTS = "transcripts";
/** One document per workspace: the turns sessions.list serves, read back at boot so the rows outlive the process. */
const SESSIONS = "sessions";
/** The name a person gave a workspace, keyed by its id, which its machines carry as a label across every rebuild:
 * the sweep reads it when it records a machine whose workspace document this store lost, so a restored record keeps
 * that name rather than the one the fork stamped, which the provider takes at create and never updates. */
const WORKSPACE_NAMES = "workspace-names";

/** What the timeline shows as the last row of a turn the runtime ended, not the harness. */
const PAUSED_REASON = "machine paused while the agent was working";
const DELETED_REASON = "machine deleted while the agent was working";
const UNANSWERING_REASON = "machine stopped answering while the agent was working";
const RESTARTED_REASON = "host restarted while the agent was working";
const GONE_REASON = "machine gone at the provider while the agent was working";
/** The host log's one line for a workspace found gone, from the road and from the record load alike. */
const goneLogLine = (workspaceId: string, words: string): string => `workspace ${workspaceId} is gone: ${words}`;
/** The host log's one line for a harness store that would not give a title; the read window keeps it to one line
 * per session rather than one per refresh. */
const noTitleLogLine = (sessionId: string, workspaceId: string, words: string): string =>
  `no title for session ${sessionId.slice(0, 8)} on ${workspaceId}: ${words}`;
/** The host log's one line for a thread its harness would not name; the thread keeps its opening turn's words and
 * nothing asks again, so this is said once per thread. */
const noMadeTitleLogLine = (threadId: string, workspaceId: string, words: string): string =>
  `thread ${threadId.slice(0, 8)} on ${workspaceId} keeps its opening words: ${words}`;
/** The host log's one line for a name the harness's own store would not take: the thread carries the name here
 * whatever its harness did with it, so only the harness's own UI is out of step. */
const noNameWriteLogLine = (sessionId: string, workspaceId: string, words: string): string =>
  `the harness did not take the name for session ${sessionId.slice(0, 8)} on ${workspaceId}: ${words}`;
/** What a cut turn's parent hears: the row's own span, since no harness result reports one. */
const restartCutLine = (elapsedMs: number): string => `cut by a host restart after ${fmtDuration(elapsedMs, "clock")}`;
/** A guest with no daemon is asked again after this long (one may be deployed later). */
const DAEMON_TOKEN_MISS_TTL_MS = 60_000;
/** Events kept per workspace; the oldest fall off so one chatty workspace cannot grow the store forever. */
const TRANSCRIPT_CAP = 5000;
/** Index rows kept per workspace; the oldest finished rows fall off, a running one never does. */
const SESSION_INDEX_CAP = 200;
/** A turn boundary waits this long for more before the transcript is written; measured at one put per
 * event, 5000 events cost 4 s of memory-store clones and 6.6 s of file rewrites after the last turn. */
export const TRANSCRIPT_FLUSH_MS = 250;

/** One workspace's name as a person set it here, kept beside the workspace records so a restore can read it. */
interface NamedWorkspace {
  workspaceId: string;
  name: string;
}

interface TranscriptRecord {
  workspaceId: string;
  events: SessionEvent[];
}

/** What a live turn knows beyond its row: the status of a reply that landed while its process still ran, absent
 * until the harness's result arrives and read by every road that ends the row before the process exits. */
interface TurnLive {
  reply?: TurnStatus;
}

interface SessionIndexRecord {
  workspaceId: string;
  /** reply is the held status of a turn whose result landed while its process still ran, on a row still running;
   * run is where that turn is on its machine, so a host that comes back re-opens it rather than failing it. */
  sessions: (SessionView & { turnId: string; notify?: string; reply?: TurnStatus; run?: string })[];
}

/** Builders live apart from workspaces: never in the rail, and a record left
 * by a crashed wizard is exactly what reap() sweeps. */
const BUILDERS = "builders";
/** One id per state file, stamped on every machine it creates so another host's sweep can tell them apart from its own. */
const OWNER = "owner";
/** The create attempt in flight for a record, written before the provider hears of it. */
const CREATES = "creates";
/** The provider caps a key at 255 characters (measured 2026-09-04); the purpose is hashed past what a 16-hex nonce leaves. */
const KEY_PURPOSE_MAX = 255 - 17;
interface PendingCreate {
  key: string;
  createdAt: string;
  /** The request's fingerprint: a changed request is a new attempt, never a replay of the old one. */
  body: string;
  host: string;
  pid: number;
}

/** The spec minus what is minted per attempt, so the same request from two attempts reads the same. */
function fingerprint(spec: MachineSpec): string {
  const { idempotencyKey, labels, ...rest } = spec;
  const { [CREATED_AT_LABEL]: stamp, ...stamped } = labels ?? {};
  void idempotencyKey;
  void stamp;
  return createHash("sha256").update(JSON.stringify({ ...rest, labels: stamped })).digest("hex");
}
/** A holder's heartbeat older than this, or a holder whose pid is gone, no longer keeps a builder from another process. */
const HELD_TTL_MS = 15 * 60_000;
/** Own builders beat this often on their own timer, so a sweep stuck on a slow listing cannot starve the hold. */
const HEARTBEAT_MS = 5 * 60_000;

const isCapRefusal = (e: unknown): boolean => (e as { kind?: unknown }).kind === "concurrency";
/** Whether a workspace still holds one of the account's machine slots: a napped or gone one holds none. Read off
 * the record's phase alone, since a refusal has no time to ask the provider about every workspace. */
const holdsSlot = (record: WorkspaceRecord): boolean => {
  const state = workspaceState({ phase: record.phase });
  return state !== "paused" && state !== "gone";
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

interface BuilderRecord {
  id: string;
  name: string;
  kind: MachineKind;
  baseTemplate: string;
  setupSha: string;
  createdAt: string;
  size: WorkspaceSize;
  streamUrl?: string;
  /** True from creation until the machine is ever paused, resumed or restored; only a first-life machine can be sealed. */
  firstLife: boolean;
  /** The process using this builder: written at creation and attach, refreshed every sweep, cleared on close.
   * Another process over the same store leaves the record alone while the holder is alive and the heartbeat fresh. */
  heldBy?: { host: string; pid: number; heartbeat: string };
  /** Written the moment the machine exists, before any stage runs, and dropped when prepare finishes; a
   * record still marked by a dead holder never completed its setup and can never seal. */
  building?: true;
  /** What of the recipe this builder carries; a prepare with the same recipe hash reuses it. */
  import?: ImportLedger;
  /** The base tools read on this builder, or on the golden it was forked from; the version it seals records them. */
  base?: GoldenBaseTool[];
  /** Saved as this version and kept running since; an update of that version lands on it, the sweep stops it at GRACE_MS. */
  sealed?: { at: string; version: number };
}

interface LiveBuilder {
  record: BuilderRecord;
  builder: Builder;
  /** own: made or attached to by this process. reusable: an earlier process's record, marked and running,
   * wearing this owner's label or none; the sweep ages it out at six hours. stale: an earlier record that
   * can never seal; the sweep stops it. foreign: wears another state file's label; never touched.
   * held: another live process is using it; never touched while its heartbeat is fresh. Read once at load: a
   * host that runs on keeps what it read, and host.lock keeps a second init from starting beside it. */
  life: "own" | "reusable" | "stale" | "foreign" | "held";
  reach?: PreviewReach;
}

/** What prepare rejects with once its signal aborted. `builderId` is the machine it had, when one existed: killed
 * by its recorded id and its record dropped, unless `kept` (attached to, first life worth keeping, hold released,
 * record left reusable) or `left` (the kill failed for this reason and the record stays for the sweep). */
export class PrepareStoppedError extends Error {
  readonly builderId?: string;
  readonly kept: boolean;
  readonly left?: string;
  constructor(builderId?: string, outcome?: { kept: true } | { left: string }) {
    const kept = outcome !== undefined && "kept" in outcome;
    const left = outcome !== undefined && "left" in outcome ? outcome.left : undefined;
    super(
      builderId === undefined
        ? "prepare stopped before a machine existed"
        : kept
          ? `prepare stopped; builder ${builderId} left running with its first life`
          : left === undefined
            ? `prepare stopped; builder ${builderId} killed`
            : `prepare stopped; builder ${builderId} did not stop: ${left}`,
    );
    this.name = "PrepareStoppedError";
    if (builderId !== undefined) this.builderId = builderId;
    this.kept = kept;
    if (left !== undefined) this.left = left;
  }
}

/** Stand-in for a machine that vanished while we were away; resume() failing with
 * kind "missing" is exactly what triggers Workspace's resurrect path. */
function deadMachine(id: string): Machine {
  const gone = () => Object.assign(new Error(`machine ${id} is gone`), { kind: "missing", status: 404 });
  return {
    id,
    kind: "sandbox",
    streamUrl: undefined,
    exec: async () => {
      throw gone();
    },
    run: async () => {
      throw gone();
    },
    snapshot: async () => {
      throw gone();
    },
    pause: async () => {
      throw gone();
    },
    resume: async () => {
      throw gone();
    },
    kill: async () => {},
    state: async () => "gone",
    downloadUrl: async () => {
      throw gone();
    },
    uploadUrl: async () => {
      throw gone();
    },
  };
}

/** Reads at most `cap` bytes of the body and cancels the rest; a body that dies mid-read still leaves the status to report. */
async function readBodyUpTo(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, Math.min(size, cap)).toString("utf8");
}

export function createRuntime(opts: RuntimeOptions): Runtime {
  const { backend, store, adapters } = opts;
  const local = opts.local;

  /** The one place a workspace's kind means anything: the module that answers for machines of that kind. The backend
   * that holds the machine, how a turn's process is launched on it, where each harness keeps its sessions there, the
   * environment a turn runs under, and whether a request relayed from a machine may drive it. Every other road asks
   * the module for a capability or a fact; nothing else compares the kind. Adding a kind (an ssh machine) is a row
   * here and its wiring, nothing more. */
  interface KindModule {
    backend: MachineBackend;
    execStream: (machine: Machine, opts?: MachineExecOptions) => ExecStreamFactory;
    home: (agentId: string) => string;
    env: Readonly<Record<string, string>>;
    /** Whether a request relayed from a machine may drive a workspace of this kind; a local one answers only this computer. */
    relayed: boolean;
  }
  const cloudHome = (id: string): string => {
    const home = guestAgentHomes()[id];
    if (home === undefined) throw new Error(`the catalog has no home for ${id}`);
    return home;
  };
  const modules: Record<WorkspaceKind, KindModule | undefined> = {
    cloud: { backend, execStream: (machine, o) => machineExecStream(machine, o), home: cloudHome, env: GUEST_LOGIN_ENV, relayed: true },
    local: local === undefined ? undefined : { backend: local.backend, execStream: (_machine, o) => local.execStream(o), home: local.home, env: local.env, relayed: false },
  };
  const moduleOf = (kind: WorkspaceKind): KindModule => {
    const found = modules[kind];
    if (found === undefined) throw new Error(`this host has no ${kind} backend wired, so it serves no ${kind} workspace`);
    return found;
  };
  const backendFor = (kind: WorkspaceKind): MachineBackend => moduleOf(kind).backend;
  const execFactoryFor = (entry: LiveWorkspace, o?: MachineExecOptions): ExecStreamFactory => moduleOf(entry.record.kind).execStream(entry.machine, o);
  /** The capability a verb reads before it runs: a machine whose capability is false refuses the verb with the one
   * sentence, which reads for the local computer, the only machine short of these capabilities today. */
  const refuseCannot = (entry: LiveWorkspace, can: keyof Omit<Capabilities, "sizes">, action: string): void => {
    if (backendFor(entry.record.kind).capabilities[can] !== true) throw new Error(localMachineRefusal(entry.record.name, action));
  };
  /** A request relayed from a machine cannot drive a workspace whose module takes none. Today no machine has a road
   * into the host, so nothing relays yet; the rule holds when one appears. */
  const refuseRelayed = (entry: LiveWorkspace, origin: WorkspaceOrigin | undefined): void => {
    if (origin === "relayed" && !moduleOf(entry.record.kind).relayed) throw new Error(relayedRefusal(entry.record.name));
  };
  const bus = eventBus();
  const pingTimeoutMs = opts.wake?.pingTimeoutMs ?? WAKE_PING_TIMEOUT_MS;
  const pauseDeadlineMs = opts.nap?.pauseDeadlineMs ?? PAUSE_DEADLINE_MS;
  const wakeDeadlineMs = opts.wake?.deadlineMs ?? WAKE_DEADLINE_MS;
  const providerReadMs = opts.providerReadMs ?? PROVIDER_READ_MS;
  const lateReadMs = opts.wake?.lateReadMs ?? WAKE_LATE_READ_MS;
  const clock = opts.clock ?? realClock;
  /** Each provider move the guest has to cooperate with: the state it leaves the machine in, and the state a
   * machine the move never touched still reads. */
  const moves: Record<ProviderMove, { leaves: MachineState; from: MachineState }> = {
    pause: { leaves: "paused", from: "running" },
    resume: { leaves: "running", from: "paused" },
  };
  /** One provider move inside a pause or a wake, bounded by what is left of the verb's budget: a call that has not
   * answered in time, or that nothing answered (the network failed under it), is left to settle on its own and the
   * provider is read once. A machine that landed is done; one still where it was gets the call once more; anything
   * else, a second miss or a spent budget ends the move with the row's words, measured from the verb's start. A call
   * the provider refuses is the caller's to judge. */
  const settleMove = async (machine: Machine, move: ProviderMove, budget: MoveBudget): Promise<void> => {
    const rule = moves[move];
    let unanswered: unknown;
    for (let attempt = 1; ; attempt++) {
      const left = budget.deadline - clock.now();
      if (left > 0) {
        // The two attempts share what is left: the first takes half, the second the rest.
        try {
          return await until(machine[move](), clock.now() + (attempt === 1 ? left / 2 : left), `${move} of ${machine.id}`, clock);
        } catch (e) {
          if (!(e instanceof DeadlineError) && !isNetworkError(e)) throw e;
          unanswered = e;
        }
      }
      const reads = await until(machine.state(), clock.now() + providerReadMs, `state of ${machine.id}`, clock).catch(() => undefined);
      if (reads === rule.leaves) return;
      if (attempt === 1 && reads === rule.from && budget.deadline > clock.now()) continue;
      const words = moveTimedOutLine(budget.what, clock.now() - budget.started, reads);
      console.warn(`${machine.id}: ${words}`);
      throw new MoveUnansweredError(words, { cause: unanswered });
    }
  };
  const budgetFor = (what: MoveBudget["what"], ms: number): MoveBudget => {
    const started = clock.now();
    return { what, started, deadline: started + ms };
  };
  const daemonHelloTimeoutMs = opts.daemonHelloTimeoutMs ?? DAEMON_HELLO_TIMEOUT_MS;
  const vaultCapBytes = opts.wake?.vaultCapBytes ?? VAULT_CAP_BYTES;
  const defaultIdleWindowMs = opts.idle?.defaultWindowMs ?? DEFAULT_IDLE_WINDOW_MS;
  const hostId = opts.hostId ?? hostname();
  /** What names this host's templates: the id's hex alone, in the class the provider's name field has taken. */
  const templateHostId = templateHost(hostId);

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
  const vaultExport = async (m: Machine, o: Pick<VaultOptions, "maxBytes"> = {}): Promise<Buffer> =>
    exportPaths(m, await vaultPathsOf(m), { ...o, ...(opts.vaultCaches !== undefined ? { exclude: opts.vaultCaches } : {}) });
  const live = new Map<string, LiveWorkspace>();
  const builders = new Map<string, LiveBuilder>();
  /** The prepare in flight per golden name; a second call for the same recipe joins it instead of running the stages twice on one machine. */
  const preparing = new Map<string, { hash: string | undefined; promise: Promise<GoldenBuilderView> }>();
  /** A row read back from the store has no handle: its process died with the runtime that started it. */
  const sessions = new Map<string, { view: SessionView; turnId: string; notify?: string; handle?: SessionHandle; end?: (reason: string) => void; turnLive?: TurnLive; run?: string }>();
  /** Every exec stream still running, so the machine going away ends it the way it ends a session. */
  const execs = new Set<{ workspaceId: string; end: (reason: string) => void }>();
  const indexFlushes = new Map<string, Promise<void>>();
  const transcripts = new Map<string, SessionEvent[]>();
  // Puts are chained per workspace so the later snapshot always lands last,
  // whatever order the store finishes in.
  const transcriptFlushes = new Map<string, Promise<void>>();
  const transcriptTimers = new Map<string, () => void>();
  // One token per process, written to a guest the first time a client asks to reach its daemon; the file the
  // guest carried before (the golden's, or an earlier run's) stops working then. Keyed by machine id: a
  // resurrect or upgrade brings a fresh guest and file.
  const daemonToken = opts.daemonToken ?? randomBytes(24).toString("hex");
  assertTokenShape(daemonToken);
  const daemonTokens = new Map<string, { hasDaemon: boolean; at: number }>();
  const daemonTokenOf = async (machine: Machine): Promise<string | undefined> => {
    const cached = daemonTokens.get(machine.id);
    if (cached && (cached.hasDaemon || Date.now() - cached.at < DAEMON_TOKEN_MISS_TTL_MS)) return cached.hasDaemon ? daemonToken : undefined;
    const res = await machine.exec(rotateDaemonTokenScript(daemonToken));
    const hasDaemon = res.exitCode === 0 && res.stdout.includes(DAEMON_TOKEN_SET);
    daemonTokens.set(machine.id, { hasDaemon, at: Date.now() });
    return hasDaemon ? daemonToken : undefined;
  };

  const cancelFlush = (workspaceId: string): void => {
    transcriptTimers.get(workspaceId)?.();
    transcriptTimers.delete(workspaceId);
  };

  // The copy is taken here, not per event: a store may serialise after it
  // returns, and the live array keeps moving under it.
  const flushTranscript = (workspaceId: string): Promise<void> => {
    cancelFlush(workspaceId);
    const events = transcripts.get(workspaceId);
    if (!events) return transcriptFlushes.get(workspaceId) ?? Promise.resolve();
    const snapshot: TranscriptRecord = { workspaceId, events: [...events] };
    const queued = (transcriptFlushes.get(workspaceId) ?? Promise.resolve())
      .then(() => store.put(TRANSCRIPTS, workspaceId, snapshot))
      .catch(() => {});
    transcriptFlushes.set(workspaceId, queued);
    return queued;
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
  const persistSessions = (workspaceId: string): Promise<void> => {
    if (!live.has(workspaceId)) return Promise.resolve();
    capSessions(workspaceId);
    const rows = [...sessions.values()]
      .filter(s => s.view.workspaceId === workspaceId)
      .map(s => ({
        ...s.view,
        turnId: s.turnId,
        ...(s.notify !== undefined ? { notify: s.notify } : {}),
        ...(s.view.status === "running" && s.turnLive?.reply !== undefined ? { reply: s.turnLive.reply } : {}),
        ...(s.view.status === "running" && s.run !== undefined ? { run: s.run } : {}),
      }));
    const snapshot: SessionIndexRecord = { workspaceId, sessions: rows };
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
    const event: SessionEvent = { ...unstamped, at: Date.now() };
    let events = transcripts.get(event.workspaceId);
    if (!events) {
      events = [];
      transcripts.set(event.workspaceId, events);
    }
    events.push(event);
    if (events.length > TRANSCRIPT_CAP) events.splice(0, events.length - TRANSCRIPT_CAP);
    if (event.type === "session.end") void flushTranscript(event.workspaceId);
    else if (event.type !== "session.delta" && !transcriptTimers.has(event.workspaceId)) {
      transcriptTimers.set(event.workspaceId, clock.schedule(() => void flushTranscript(event.workspaceId), TRANSCRIPT_FLUSH_MS));
    }
    bus.emit(event);
  };

  /** A start without resume opens a thread; a resumed start joins the thread of the session it resumes, found by
   * the id the CLI announced (it may differ from the one first minted). A transcript from before threads existed
   * was one thread, so resuming into it stamps every event in place: the stamp fills an absent field once and never
   * changes a value, so it runs at most once per transcript. A new thread leaves the old events as they were.
   * The index is asked first: it keeps a thread whose start fell off the transcript cap. */
  const threadOf = (workspaceId: string, resume: string | undefined): string => {
    const events = transcripts.get(workspaceId) ?? [];
    if (resume !== undefined) {
      for (const s of sessions.values()) {
        if (s.view.workspaceId === workspaceId && s.view.claudeSessionId === resume && s.view.threadId !== undefined) return s.view.threadId;
      }
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!;
        if (e.type !== "session.start" || e.sessionId !== resume) continue;
        if (e.threadId !== undefined) return e.threadId;
        const id = randomUUID();
        for (const legacy of events) legacy.threadId ??= id;
        return id;
      }
    }
    return randomUUID();
  };

  /** Whether the thread's last turn ended with no exit code and no result: the runtime or its transport ended the
   * process (a deadline, a host restart, a nap), so the harness resumes a transcript it never finished writing. */
  const cutBefore = (workspaceId: string, threadId: string): boolean => {
    const events = transcripts.get(workspaceId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "session.end" && e.threadId === threadId) return e.exitCode === null && !e.sawResult;
    }
    return false;
  };

  /** The folder a resumed session's harness ran in, from its row or, past the index cap, its start event. The CLI
   * keys a session to that folder, so a resume anywhere else opens nothing. */
  const folderOf = (workspaceId: string, resume: string): string | undefined => {
    for (const s of sessions.values()) {
      if (s.view.workspaceId === workspaceId && s.view.claudeSessionId === resume && s.view.cwd !== undefined) return s.view.cwd;
    }
    const events = transcripts.get(workspaceId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "session.start" && e.sessionId === resume && e.cwd !== undefined) return e.cwd;
    }
    return undefined;
  };

  /** What the runtime is doing to a machine's daemon, by workspace: the line its row shows while an update runs and
   * the sentence left there when one failed. Held here rather than on the record because it says what this process
   * is doing, not what the workspace is. */
  const daemonNotes = new Map<string, string>();

  const view = (r: WorkspaceRecord): WorkspaceView => ({
    id: r.id,
    name: r.name,
    machineId: r.machineId,
    phase: r.phase,
    kind: r.kind,
    golden: r.golden,
    createdAt: r.createdAt,
    ...(r.claudeSessionId !== undefined ? { claudeSessionId: r.claudeSessionId } : {}),
    ...(r.screen !== undefined ? { screen: r.screen } : {}),
    ...(r.project !== undefined ? { project: r.project } : {}),
    ...(r.gone !== undefined ? { gone: r.gone } : {}),
    ...(daemonNotes.has(r.id) ? { daemonNote: daemonNotes.get(r.id)! } : {}),
  });

  const persist = async (r: WorkspaceRecord): Promise<void> => {
    const entry = live.get(r.id);
    if (entry !== undefined) entry.generation++;
    await store.put(WORKSPACES, r.id, r);
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

  /** The workspaces forked from this snapshot, whatever their phase: the lineage retention must not cut. */
  const forkedFrom = (snapshotId: string): string[] => [...live.values()].filter(e => e.record.golden === snapshotId).map(e => e.record.name);

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

  /** What stands behind a snapshot a workspace forks from: a golden version, or a project golden and the version at
   * the root of its lineage. `golden` is that root's snapshot id, the one a snapshot taken from the fork records. */
  const imageOf = async (snapshotId: string): Promise<{ golden: string; version?: GoldenVersion; project?: WorkspaceProject }> => {
    const version = await goldenVersionOf(snapshotId);
    if (version !== undefined) return { golden: snapshotId, version };
    const project = (await store.get(PROJECT_GOLDENS, snapshotId)) as ProjectGolden | undefined;
    if (project === undefined) return { golden: snapshotId };
    const root = await goldenVersionOf(project.golden);
    return { golden: project.golden, ...(root !== undefined ? { version: root } : {}), project: project.project };
  };

  /** A status pushed outside the poll, for a phase change the poller would show
   * late. Machine state is what the phase implies: asking the provider here
   * would reset its idle timer for a fact the runtime already knows. The nap
   * countdown rides along as the poller sends it: a client replaces the whole
   * status, so leaving it out would blank the row until the next poll. */
  /** The reach a status pushed for a running machine claims: the edge answers where the backend mints a route. */
  const reachOf = (entry: LiveWorkspace): ReachState => (entry.machine.previewUrl ? "reachable" : "unsupported");
  const emitStatus = async (entry: LiveWorkspace, reach: ReachState, reason?: string): Promise<void> => {
    const size = entry.record.size;
    const idleAt = entry.record.phase === "running" ? idle.idleAt(entry.record.id) : undefined;
    bus.emit({
      type: "workspace.status",
      status: {
        ...view(entry.record),
        machineState: machineStateOf(entry.record.phase),
        reach: { state: reach },
        size,
        rateUsdPerHour: backendFor(entry.record.kind).pricing.rateUsdPerHour(size),
        ...(reason !== undefined ? { reason } : {}),
        ...(idleAt !== undefined ? { idleAt } : {}),
      },
    });
  };

  /** The one preamble every dial this runtime makes to a machine's daemon repeats: the preview route, then this
   * runtime's token on the guest, then the link. null when the guest holds no daemon token, which each caller reads
   * its own way. The caller owns the link and closes it; the previewUrl guard stays with the caller, which knows
   * what a backend without preview routes means for it. */
  const dialDaemon = async (entry: LiveWorkspace, deadline: number, o: { onEvent?: (e: DaemonEvent) => void; heartbeatMs?: number } = {}): Promise<DaemonReach | null> => {
    const reach = await until(entry.ws.daemonReach(), deadline, "preview route");
    const token = await until(daemonTokenOf(entry.machine), deadline, "daemon token");
    if (token === undefined) return null;
    return connectDaemon({ previewUrl: reach.url, token, onEvent: o.onEvent ?? (() => {}), ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}) });
  };

  /** The daemon answering through the edge is what proves a resumed guest
   * serves; resume() returning does not (a zombie reports running for 10+
   * minutes while exec and the edge 502). Backends without preview routes
   * have no edge to ask, so the check falls back to the shape comparison. */
  const pingDaemon = async (entry: LiveWorkspace): Promise<string | undefined> => {
    const machine = entry.machine;
    if (!machine.previewUrl) return undefined;
    const deadline = Date.now() + pingTimeoutMs;
    let link: DaemonReach | null = null;
    try {
      link = await dialDaemon(entry, deadline, { heartbeatMs: pingTimeoutMs });
      if (link === null) {
        // No daemon to ask; an exec that returns is the guest's own answer.
        await until(machine.exec("true"), deadline, "guest exec");
        return undefined;
      }
      await until(link.ready, deadline, "daemon link");
      await until(link.request("ping"), deadline, "daemon ping");
      return undefined;
    } catch (e) {
      return `daemon on ${machine.id} did not answer within ${pingTimeoutMs} ms (${e instanceof Error ? e.message : String(e)})`;
    } finally {
      link?.close();
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
      link = await dialDaemon(entry, deadline, { onEvent: e => (e.type === "daemon.hello" ? announce(daemonVersionOf(e)) : undefined) });
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

  /** The line the machine's row carries while the runtime is doing something to its daemon; undefined clears it. */
  const noteDaemon = async (entry: LiveWorkspace, note: string | undefined): Promise<void> => {
    if (note === undefined) daemonNotes.delete(entry.record.id);
    else daemonNotes.set(entry.record.id, note);
    await pushStatus(entry);
  };

  /** A line for the machine's row that rides one status and no more, so the next poll shows the row's own facts
   * again. What the row is for is the machine's rate and its nap countdown; a failure nobody here can act on must
   * not sit on top of them for the life of the host. */
  const flashDaemon = async (entry: LiveWorkspace, note: string): Promise<void> => {
    daemonNotes.set(entry.record.id, note);
    await pushStatus(entry);
    daemonNotes.delete(entry.record.id);
  };

  /** The folders the record says this machine's daemon may browse beside its home. Derived state: the record is the
   * one place, and the file follows it on every connect, so a project that landed before the daemon read that file
   * is browsable without a second import. Non-fatal: an update or a turn must not fail on it. */
  const writeDaemonRoots = async (entry: LiveWorkspace): Promise<void> => {
    const dest = entry.record.project?.dest;
    if (dest === undefined) return;
    const written = await entry.machine.exec(writeDaemonRootsScript([dest]), { timeoutMs: INLINE_EXEC_MS }).catch((e: unknown) => ({ exitCode: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) }));
    if (written.exitCode !== 0) console.warn(`browsable folders for ${entry.record.id} not written on ${entry.machine.id}: ${written.stderr.slice(-200)}`);
  };

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
      await writeDaemonRoots(entry);
      const version = await helloVersion(entry);
      if (version === null || version >= DAEMON_VERSION) return;
      if (opts.goldenRecipe?.deployDaemon === undefined) return;
      await whenNoTurnRuns(entry.record.id);
      if (entry.record.phase !== "running") return;
      await noteDaemon(entry, DAEMON_UPDATING);
      // Marking the row awaits a push, which is several ticks wide; a turn that opened inside that window would
      // lose its ptys to the deploy, so the wait runs again until nothing is running as the deploy starts.
      while (turnRuns(entry.record.id)) await whenNoTurnRuns(entry.record.id);
      try {
        await workspaces.updateDaemon(entry.record.id);
        await writeDaemonRoots(entry);
        await noteDaemon(entry, undefined);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await noteDaemon(entry, undefined);
        // A machine that napped or went under the update did not fail one: its row says what its phase says.
        if (entry.record.phase !== "running") return;
        console.warn(`daemon on ${entry.machine.id} (workspace ${entry.record.id}) not updated: ${reason}`);
        await flashDaemon(entry, DAEMON_UPDATE_FAILED);
      }
    })();
    daemonSyncs.set(key, work);
    void work.catch(() => {}).then(() => {
      if (daemonSyncs.get(key) === work) daemonSyncs.delete(key);
    });
    return work;
  };

  /** Size is always explicit: a create that names none gets the provider's own
   * default (2048 MB on Solari), not the size the record and the rate assume. */
  const forkSpec = (r: WorkspaceRecord, kind: MachineKind, image: ReturnType<typeof goldenImage>["spec"], override?: WorkspaceSpec): MachineSpec & WorkspaceSize => ({
    ...image,
    kind,
    cpu: override?.cpu ?? r.size.cpu,
    memMb: override?.memMb ?? r.size.memMb,
    envs: { ...GUEST_LOGIN_ENV, ...r.spec.envs, ...override?.envs },
    labels: { ...r.spec.labels, [WSP_LABEL]: "1", [OWNER_LABEL]: owner, [WORKSPACE_LABEL]: r.id, [NAME_LABEL]: r.name, [GOLDEN_LABEL]: r.golden, [CREATED_AT_LABEL]: new Date().toISOString() },
    onIdle: "pause",
    idleTimeoutMs: backstopMs(idleWindowOf(r)),
  });

  let owner = "";

  /** The store holds the attempt's key and stamp before the provider hears of it: a retry the provider never answered
   * (the connection dropped, the process died) sends the same body under the same key and gets back the machine the
   * first try booted. An answer of any kind ends the attempt and a changed request starts one, so the key after a kill
   * or a refusal is always fresh. A replay naming a dead machine is dropped and the create made anew (measured
   * 2026-09-04: the provider replays a killed machine's id). Another live process's attempt is never joined. */
  const keyedCreate = async (purpose: string, spec: MachineSpec, afterCorpse = false): Promise<Machine> => {
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
      machine = await backend.create({
        ...spec,
        idempotencyKey: attempt.key,
        ...(spec.labels?.[CREATED_AT_LABEL] !== undefined ? { labels: { ...spec.labels, [CREATED_AT_LABEL]: attempt.createdAt } } : {}),
      });
    } catch (e) {
      if (typeof (e as WspError).status === "number") await store.delete(CREATES, purpose);
      throw e;
    }
    await store.delete(CREATES, purpose);
    if (machine.replayed === true) {
      if ((await machine.state()) === "gone") {
        if (afterCorpse) throw new Error(`create for ${purpose}: the provider replayed ${machine.id}, which is gone, under a key it had never seen (${attempt.key})`);
        console.warn(`create for ${purpose}: the replay under ${attempt.key} named ${machine.id}, which is gone; creating anew`);
        return keyedCreate(purpose, spec, true);
      }
      console.warn(`create for ${purpose}: ${machine.id} replayed from an earlier attempt under ${attempt.key}`);
    }
    return machine;
  };

  /** Ids this process has created and not yet recorded; the sweep must not read them as lost. */
  const inflight = new Set<string>();
  /** purpose names the record every create inside run is for; its attempts are keyed under it. */
  const claiming = <T>(purpose: string, run: (b: MachineBackend) => Promise<T>): Promise<T> => {
    const mine: string[] = [];
    const b: MachineBackend = {
      capabilities: backend.capabilities,
      pricing: backend.pricing,
      get: id => backend.get(id),
      list: labels => backend.list(labels),
      deleteSnapshot: id => backend.deleteSnapshot(id),
      // The seal promotes through this handle, so the template calls ride along when the provider has them.
      ...(backend.promoteSnapshot !== undefined ? { promoteSnapshot: backend.promoteSnapshot.bind(backend) } : {}),
      ...(backend.getTemplate !== undefined ? { getTemplate: backend.getTemplate.bind(backend) } : {}),
      ...(backend.listTemplates !== undefined ? { listTemplates: backend.listTemplates.bind(backend) } : {}),
      ...(backend.deleteTemplate !== undefined ? { deleteTemplate: backend.deleteTemplate.bind(backend) } : {}),
      create: async spec => {
        const m = await keyedCreate(purpose, spec);
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
    const reported = async (cmd: string, call: () => Promise<ExecResult>): Promise<ExecResult> => {
      const t0 = Date.now();
      try {
        const res = await call();
        report({ machineId: machine.id, cmd, ms: Date.now() - t0, ...res });
        return res;
      } catch (e) {
        report({ machineId: machine.id, cmd, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };
    const exec = (cmd: string, o?: { timeoutMs?: number }): Promise<ExecResult> => reported(cmd, () => machine.exec(cmd, o));
    // A run is one command to the log, however many execs carry it.
    const run = (script: string, o: RunOptions): Promise<ExecResult> => reported(script, () => machine.run(script, o));
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
   * versions sealed before it was recorded were all sandbox. */
  const fork = (record: WorkspaceRecord, bind: (machine: Machine) => void, override?: WorkspaceSpec, report?: StageReport): Promise<Machine> =>
    claiming(`workspace/${record.id}`, async b => {
      const image = await imageOf(record.golden);
      const golden = image.version;
      // A project golden's snapshot is the image; only a version's own snapshot may stand behind a template.
      const spec = forkSpec(record, golden?.kind ?? "sandbox", goldenImage(image.project === undefined && golden !== undefined ? golden : { snapshotId: record.golden }).spec, override);
      const machine = await b.create(spec);
      // Named by its record before the claim is released, so no sweep sees it unclaimed.
      bind(machine);
      report?.("machine-booting", `Machine ${machine.id} is booting.`);
      const named = await setHostname(machine, record.name);
      report?.("hostname-set", named.refused === undefined ? `Hostname set to ${named.host}.` : "Hostname left as the guest booted it.", named.refused);
      // The fork carries the golden's copy; this one names the workspace and reads the disk and secrets as they are now.
      const context = await applyMachineContext(machine, { workspace: { name: record.name }, ...(golden !== undefined ? { golden } : {}) });
      if (context.failure !== undefined) console.warn(`machine context for ${record.id} on ${machine.id} ${context.summary}`);
      const shape = await shapeOf(machine);
      if (shape !== undefined) record.shape = shape;
      else delete record.shape;
      record.size = sizeBuilt(shape, spec);
      if (machine.streamUrl !== undefined) record.screen = { streamUrl: machine.streamUrl };
      else delete record.screen;
      return machine;
    });

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
    void syncDaemon(entry);
  };

  const attach = (record: WorkspaceRecord, machine: Machine): LiveWorkspace => {
    const entry: LiveWorkspace = { record, machine, ws: undefined as unknown as Workspace, generation: (live.get(record.id)?.generation ?? -1) + 1 };
    entry.ws = new Workspace(
      machine,
      {
        goldenSnapshot: record.golden,
        resurrect: (override?: Partial<MachineSpec>) =>
          fork(record, m => {
            entry.machine = m;
          }, override),
        vaultExport: m => vaultExport(m),
        vaultImport: async (m, payload) => {
          await importInto(m, payload, "/");
        },
        stashVault: async m => {
          try {
            await store.putBlob(VAULTS, record.id, await vaultExport(m, { maxBytes: vaultCapBytes }));
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            entry.vaultNote = vaultKeptLine(why);
            console.warn(`nap vault for ${record.id} not stored, previous kept: ${why}`);
          }
        },
        restoreVault: async m => {
          const payload = await store.getBlob(VAULTS, record.id);
          if (payload !== undefined) await importInto(m, payload, "/");
        },
        move: (m, move) => {
          if (entry.budget === undefined) throw new Error(`${move} of ${m.id} outside a pause or a wake`);
          return settleMove(m, move, entry.budget);
        },
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
          const fault = await pingDaemon(entry);
          return fault === undefined || both === "" ? fault : `${fault} (${both})`;
        },
      },
      { phase: enginePhaseOf(record.phase), firstLife: record.firstLife },
    );
    live.set(record.id, entry);
    return entry;
  };

  const idleWindowOf = (r: WorkspaceRecord): number | null => (r.idleWindowMs === undefined ? defaultIdleWindowMs : r.idleWindowMs);

  /** Every live session and exec of a workspace ends here when its machine goes away under it; the harness's own end, if it ever comes, is dropped. */
  const endSessions = (workspaceId: string, reason: string): void => {
    for (const s of sessions.values()) if (s.view.workspaceId === workspaceId) s.end?.(reason);
    for (const e of execs) if (e.workspaceId === workspaceId) e.end(reason);
  };

  /** Everything a workspace left on this side once its machine is dealt with: live state, flushes, stored rows, vault. */
  const drop = async (id: string): Promise<void> => {
    live.get(id)?.lateRead?.();
    live.delete(id);
    transcripts.delete(id);
    daemonNotes.delete(id);
    for (const [handleId, s] of sessions) if (s.view.workspaceId === id) sessions.delete(handleId);
    cancelFlush(id);
    await transcriptFlushes.get(id);
    transcriptFlushes.delete(id);
    await indexFlushes.get(id);
    indexFlushes.delete(id);
    await store.delete(WORKSPACES, id);
    await store.delete(TRANSCRIPTS, id);
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
    const entry = await entryOf(id);
    if (await runsUnderNapping(entry)) await adoptRunning(entry);
    if (entry.napping) return entry.napping;
    if (entry.record.phase !== "running") return view(entry.record);
    entry.napping = (async () => {
      entry.budget = budgetFor("pause", pauseDeadlineMs);
      try {
        entry.record.phase = "pausing";
        await persist(entry.record);
        await emitStatus(entry, "napping");
        delete entry.vaultNote;
        try {
          await entry.ws.nap();
        } catch (e) {
          if (isMissing(e)) {
            await settleGone(entry, goneWords(entry.record.machineId, { by: "pause", at: clock.now(), answer: providerSaid(e) }));
            throw e;
          }
          entry.record.phase = entry.ws.currentPhase;
          await persist(entry.record);
          await emitStatus(entry, reachOf(entry), e instanceof Error ? e.message : String(e));
          throw e;
        }
        // The reason says the machine paused, so it is written once the provider has confirmed that.
        endSessions(id, PAUSED_REASON);
        entry.record.phase = "napping";
        await persist(entry.record);
        bus.emit({ type: "workspace.napped", workspaceId: id });
        const said = [reason, entry.vaultNote].filter((s): s is string => s !== undefined);
        delete entry.vaultNote;
        await emitStatus(entry, "napping", said.length === 0 ? undefined : said.join("; "));
        return view(entry.record);
      } finally {
        delete entry.budget;
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
    entry.record.phase = "napping";
    await persist(entry.record);
    endSessions(entry.record.id, PAUSED_REASON);
    bus.emit({ type: "workspace.napped", workspaceId: entry.record.id, found: true });
    await emitStatus(entry, "napping", "paused outside wsp");
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
        await persist(entry.record);
        bus.emit({ type: "workspace.woken", workspaceId: entry.record.id, machineId: entry.record.machineId, resurrected: false });
        await emitStatus(entry, reachOf(entry), ALREADY_RUNNING);
      } finally {
        delete entry.adopting;
      }
    })();
    return entry.adopting;
  };
  /** The one road to gone, whichever call found the provider no longer knew the machine (deleted behind wsp, or
   * expired): the record follows the fact and stays there. The gone event closes the awake stretch with a cost tick
   * at this instant, drops the idle window and ends the sessions; the row and the one log line carry the words;
   * rebuild and delete are the roads out. */
  const settleGone = async (entry: LiveWorkspace, reason: string): Promise<void> => {
    entry.record.phase = "gone";
    entry.record.gone = reason;
    await persist(entry.record);
    endSessions(entry.record.id, GONE_REASON);
    console.warn(goneLogLine(entry.record.id, reason));
    bus.emit({ type: "workspace.gone", workspaceId: entry.record.id, machineId: entry.record.machineId, reason });
    await emitStatus(entry, "gone", reason);
  };
  /** A sighting from outside a verb (the poll, the sweep): a nap or a wake in flight meets the machine itself and
   * settles what it finds, so the sighting defers to it. */
  const adoptGone = async (entry: LiveWorkspace, reason: string): Promise<void> => {
    if (entry.record.phase === "gone" || entry.napping || entry.waking) return;
    await settleGone(entry, reason);
  };
  bus.on("workspace.status", e => {
    if (e.type !== "workspace.status") return;
    if (e.status.reach.state === "zombie") endSessions(e.status.id, UNANSWERING_REASON);
    const entry = live.get(e.status.id);
    if (entry === undefined) return;
    if (e.status.phase === "running" && e.status.machineState === "paused") void adoptPause(entry);
    // A status about a machine since replaced says nothing about the one now under the record.
    if (e.status.machineState === "gone" && e.status.phase !== "gone" && e.status.machineId === entry.record.machineId) {
      void adoptGone(entry, e.status.reason ?? goneWords(e.status.machineId));
    }
  });

  const idle = createIdlePolicy({
    windowOf: id => {
      const entry = live.get(id);
      return entry === undefined ? null : idleWindowOf(entry.record);
    },
    onIdle: async (id, windowMs) => {
      try {
        await napWith(id, idleReason(windowMs));
      } catch (e) {
        if (e instanceof MoveUnansweredError) throw e;
        // A machine the pause found gone settled its record on the way out; the gone event dropped this window.
        if (isMissing(e)) return;
        // The provider answered with a refusal: asking again at once changes nothing, so a full window starts from
        // its answer and the row is pushed once more with that window, the words unchanged.
        idle.touch(id);
        const entry = live.get(id);
        if (entry !== undefined) await emitStatus(entry, reachOf(entry), e instanceof Error ? e.message : String(e));
        console.warn(`idle nap of ${id} was answered with ${providerSaid(e)}; a full ${Math.round(windowMs / 60_000)} min window starts over`);
      }
    },
    retryMs: opts.status?.pollIntervalMs ?? POLL_INTERVAL_MS,
    clock,
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

  type StoredBuilder = Omit<BuilderRecord, "size" | "firstLife"> & { size?: WorkspaceSize; firstLife?: boolean };
  const lifeOf = (stored: StoredBuilder, machine: Machine, firstLife: boolean): LiveBuilder["life"] => {
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
    return label !== undefined && label !== owner ? "foreign" : held ? "held" : !firstLife || stored.building === true ? "stale" : "reusable";
  };
  const liveOf = (record: BuilderRecord, machine: Machine): LiveBuilder => ({
    record,
    builder: {
      machine, kind: record.kind, baseTemplate: record.baseTemplate, setupSha: record.setupSha, createdAt: record.createdAt, firstLife: record.firstLife, size: record.size,
      ...(record.import !== undefined ? { import: record.import } : {}),
      ...(record.base !== undefined ? { base: record.base } : {}),
    },
    life: lifeOf(record, machine, record.firstLife),
  });
  /** A stored record this process has no entry for yet; its machine is fetched once, here. */
  const admit = async (stored: StoredBuilder): Promise<void> => {
    const machine = await backend.get(stored.id).then(observed, (e: unknown) => {
      if (isMissing(e)) return undefined;
      throw e;
    });
    if (!machine) {
      await store.delete(BUILDERS, stored.id);
      return;
    }
    // The view get() fetched is read once: a second read would reset the provider's idle timer again.
    const seen = machine.seen;
    const state = seen?.state ?? (await machine.state());
    // A machine found paused was paused: that alone clears the marker for good. Nothing is read from the
    // provider's createdAt: on a running machine never paused, resumed or exec'd it read +6.4 s at two minutes
    // and +306 s at ten (canary, 2026-09-04 UTC), so it moves with no lifecycle event and decides nothing.
    const firstLife = stored.firstLife === true && state === "running";
    const record: BuilderRecord = { ...stored, firstLife, size: stored.size ?? sizeBuilt(await shapeOf(machine), backend.pricing.defaultSize) };
    if (stored.firstLife === true && !firstLife) await store.put(BUILDERS, record.id, record);
    builders.set(record.id, liveOf(record, machine));
    if (stored.sealed !== undefined) armGrace(record.id, stored.sealed.at);
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

  let hydrated: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    hydrated ??= (async () => {
      const stored = (await store.get(OWNER, "id")) as { id?: unknown } | undefined;
      if (typeof stored?.id === "string" && stored.id !== "") owner = stored.id;
      else {
        owner = `h_${randomBytes(4).toString("hex")}`;
        await store.put(OWNER, "id", { id: owner });
      }
      for (const raw of await store.list(WORKSPACES)) {
        const stored = raw as Omit<WorkspaceRecord, "size" | "kind"> & { size?: WorkspaceSize; kind?: WorkspaceKind };
        const kind: WorkspaceKind = stored.kind ?? "cloud";
        // A record whose kind this host wired no module for is left as it was: only the host that owns that machine can serve it.
        let module: KindModule;
        try {
          module = moduleOf(kind);
        } catch (e) {
          console.warn(`workspace ${stored.id} is left as it was: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        // The store is the fleet's truth and get(id) the provider's: a record whose machine the provider lost is
        // gone and one whose machine it holds paused is napping, whatever phase either was left at, and both say
        // so before anything lists it or meters it.
        let missing: string | undefined;
        const machine = await module.backend.get(stored.machineId).catch((e: unknown) => {
          if (!isMissing(e)) throw e;
          missing = providerSaid(e);
          return deadMachine(stored.machineId);
        });
        // The state rides on the view get() just fetched; a second read would reset the provider's idle timer.
        const atProvider = missing !== undefined ? "gone" : (machine.seen?.state ?? (await machine.state()));
        // The record follows the provider whatever word it was left with: paused means the pause landed or the
        // resume never did, running means the pause never took or the resume landed with nobody left to write it.
        // Only a machine still starting leaves the stored word standing, and a pausing one then reads napping: a
        // wake resumes it either way.
        const phase: WorkspacePhase =
          missing !== undefined || atProvider === "gone" || stored.phase === "gone"
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
          kind,
          phase,
          size: stored.size ?? sizeBuilt(await shapeOf(machine), module.backend.pricing.defaultSize),
          ...(machine.streamUrl !== undefined ? { screen: { streamUrl: machine.streamUrl } } : {}),
        };
        if (phase === "gone") record.gone = stored.gone ?? goneWords(stored.machineId, { by: "record load", at: clock.now(), ...(missing !== undefined ? { answer: missing } : {}) });
        attach(record, machine);
        if (phase !== stored.phase) {
          if (phase === "gone") console.warn(goneLogLine(stored.id, record.gone!));
          else console.warn(`workspace ${stored.id} was left ${stored.phase} and its machine is ${atProvider} at the provider; the record hydrates ${phase}`);
          await persist(record);
        }
        if (phase === "running") {
          idle.touch(stored.id);
          void syncDaemon(live.get(stored.id)!);
        }
      }
      for (const raw of await store.list(TRANSCRIPTS)) {
        const t = raw as TranscriptRecord;
        transcripts.set(t.workspaceId, t.events);
      }
      const left: { view: SessionView; turnId: string; notify?: string; turnLive?: TurnLive; run?: string }[] = [];
      for (const raw of await store.list(SESSIONS)) {
        const index = raw as SessionIndexRecord;
        if (!live.has(index.workspaceId)) continue;
        if (!Array.isArray(index.sessions)) {
          console.warn(`sessions document for ${index.workspaceId} has no rows array, read as empty`);
          continue;
        }
        for (const { turnId, notify, reply, run, ...view } of index.sessions) {
          const row: {
            view: SessionView;
            turnId: string;
            notify?: string;
            turnLive?: TurnLive;
            run?: string;
            end?: (reason: string) => void;
          } = {
            view,
            turnId,
            ...(notify !== undefined ? { notify } : {}),
            ...(reply !== undefined ? { turnLive: { reply } } : {}),
            ...(run !== undefined ? { run } : {}),
          };
          // A row left running because nothing answered about its run has no harness of its own to end, and the poll
          // that finds its machine gone must still be able to settle it.
          row.end = reason => {
            if (row.view.status !== "running") return;
            settleCut(row, reason, () => reason);
            void persistSessions(row.view.workspaceId);
          };
          if (view.status === "running") left.push(row);
          sessions.set(view.id, row);
        }
      }
      // A turn's run belongs to the machine it runs on, not to the host that asked for it, so a host that comes back
      // re-opens every run the machines still hold and reads the rest of its output. Only the machine's own answer
      // that a run is gone ends that turn, and a machine that answered nothing leaves its turn running. The ends are
      // told once every workspace's rows are in: the parent a settled turn tells may sit in a workspace read after
      // its own, and a re-opened turn's own end tells it later, when it ends.
      const answers = await Promise.all(left.map(async s => ({ row: s, answer: await reattach(s) })));
      for (const { row, answer } of answers) {
        if (answer === "cannot") settleCut(row, RESTARTED_REASON, endedAt => restartCutLine(endedAt - (row.view.startedAt ?? endedAt)));
        else if (answer === "gone") settleCut(row, RUN_GONE_LINE, () => RUN_GONE_LINE);
      }
      for (const workspaceId of new Set(left.map(s => s.view.workspaceId))) void persistSessions(workspaceId);
      for (const raw of await store.list(BUILDERS)) await admit(raw as StoredBuilder);
    })();
    return hydrated;
  };

  const entryOf = async (id: string): Promise<LiveWorkspace> => {
    await ready();
    const entry = live.get(id);
    if (!entry || entry.creating) throw new Error(`no such workspace: ${id}`);
    return entry;
  };

  /** The create itself, one stage report per awaited step. The hostname is set inside the fork, before the daemon
   * is asked and before the workspace is listed or reachable, so no shell can open under the guest's boot name. */
  const createStaged = async (o: CreateWorkspaceOptions, id: string, report: StageReport): Promise<CreatedWorkspace> => {
    const image = await imageOf(o.golden);
    const inherited = image.version?.size;
    const record: WorkspaceRecord = {
      id,
      name: o.name,
      kind: "cloud",
      machineId: "",
      phase: "running",
      golden: o.golden,
      createdAt: new Date().toISOString(),
      ...(image.project !== undefined ? { project: image.project } : {}),
      spec: {
        ...(o.envs !== undefined ? { envs: o.envs } : {}),
        ...(o.labels !== undefined ? { labels: o.labels } : {}),
      },
      ...(o.idleWindowMs !== undefined ? { idleWindowMs: o.idleWindowMs } : {}),
      size: {
        cpu: o.cpu ?? inherited?.cpu ?? backend.pricing.defaultSize.cpu,
        memMb: o.memMb ?? inherited?.memMb ?? backend.pricing.defaultSize.memMb,
      },
      firstLife: true,
    };
    // Only an asked size is checked: the golden's own is what it was built at, whatever the provider offers today.
    if ((o.cpu !== undefined || o.memMb !== undefined) && !offeredSize(backend.capabilities.sizes, record.size)) {
      throw Object.assign(new Error(sizeRefusal(sizeWord(record.size), backend.capabilities.sizes)), { kind: "invalid" });
    }
    const bind = (m: Machine): void => {
      record.machineId = m.id;
      attach(record, m).creating = true;
    };
    const notices: string[] = [];
    report("fork-requested", "Fork of the golden image requested.");
    try {
      await fork(record, bind, undefined, report);
    } catch (e) {
      // A slot for work beats a builder kept for one more change: at the cap one kept builder of this setup is
      // stopped and the fork tried again, the next one only on the next refusal. A held or foreign builder is
      // never touched, and a refusal with none left to stop is turned into words that name the slots' holders.
      if (!isCapRefusal(e)) throw e;
      let refusal: unknown = e;
      let made = false;
      await refreshBuilders();
      for (const x of [...builders.values()].filter(x => (x.life === "own" || x.life === "reusable") && x.record.sealed !== undefined)) {
        const stopped = `Stopped the builder kept from golden v${x.record.sealed!.version} to make room at the machine cap.`;
        graceTimers.get(x.record.id)?.();
        graceTimers.delete(x.record.id);
        await killUntilGone(backend, x.builder.machine, opts.killConfirm);
        await forgetBuilder(x.record.id);
        notices.push(stopped);
        console.warn(`workspace ${record.id}: ${stopped.charAt(0).toLowerCase()}${stopped.slice(1, -1)} (${x.record.id})`);
        report("fork-requested", "Fork of the golden image requested again.", stopped);
        try {
          await fork(record, bind, undefined, report);
          made = true;
          break;
        } catch (again) {
          if (!isCapRefusal(again)) throw again;
          refusal = again;
        }
      }
      if (!made) {
        // A create still in flight holds its slot; the one being refused never bound a machine, so it cannot name itself.
        const holding = [...live.values()].filter(w => holdsSlot(w.record)).map(w => w.record.name);
        const line = machineCapRefusal(holding, [...builders.values()].map(x => x.record.name));
        throw Object.assign(new Error(line, { cause: refusal }), { kind: "concurrency", ...(typeof (refusal as WspError).status === "number" ? { status: (refusal as WspError).status } : {}) });
      }
    }
    const entry = live.get(id)!;
    if (entry.machine.previewUrl) {
      // A daemon that does not answer is reported, not fatal: the workspace exists either way, and the status check
      // keeps asking and names a zombie. The route minted here is the one the ping and the first client reuse.
      let fault: string | undefined;
      try {
        await until(entry.ws.daemonReach(), Date.now() + pingTimeoutMs, "preview route");
        report("preview-route", "Preview route to the daemon minted.");
        fault = await pingDaemon(entry);
      } catch (e) {
        fault = `preview route for ${entry.machine.id} not minted (${e instanceof Error ? e.message : String(e)})`;
      }
      report("daemon-answering", fault === undefined ? "Daemon answered through the edge." : "Daemon did not answer through the edge.", fault);
      void syncDaemon(entry);
    }
    await persist(record);
    delete entry.creating;
    report("ready", "Ready.");
    const v = view(record);
    bus.emit({ type: "workspace.created", workspace: v });
    return notices.length > 0 ? { ...v, notice: notices.join(" ") } : v;
  };

  /** The name a workspace takes from what was typed: the space around it is no part of a name. The fork and the
   * rename both read it here, so a name is never stored with spaces a person would have to type back for `--in`. */
  const nameGiven = (name: string): string => name.trim();
  /** Names whose fork is between its check and its first machine: held here so two forks asked for together cannot both land. */
  const forking = new Set<string>();
  /** Why a fork of this name is refused, or nothing when the name is free: one entry holds it, whatever it is doing
   * (a delete in flight says so), or a fork of it is under way. A name never names two workspaces, and a fork and a
   * delete of one name never interleave. */
  const nameRefusal = (name: string): string | undefined => {
    if (nameGiven(name) === "") return BLANK_NAME_REFUSAL;
    const entry = [...live.values()].find(e => e.record.name === name);
    if (entry !== undefined) return entry.deleting ? nameDeletingRefusal(name) : nameTakenRefusal(name);
    return forking.has(name) ? nameTakenRefusal(name) : undefined;
  };

  const workspaces: Runtime["workspaces"] = {
    async create(opts) {
      await ready();
      const o = { ...opts, name: nameGiven(opts.name) };
      const refusal = nameRefusal(o.name);
      if (refusal !== undefined) throw Object.assign(new Error(refusal), { kind: "conflict" });
      forking.add(o.name);
      const id = `ws_${randomBytes(4).toString("hex")}`;
      const began = clock.now();
      const report: StageReport = (stage, message, notice) => {
        bus.emit({ type: "workspace.creating", workspaceId: id, name: o.name, stage, message, elapsedMs: clock.now() - began, ...(notice !== undefined ? { notice } : {}) });
      };
      try {
        return await createStaged(o, id, report);
      } catch (e) {
        // A machine already forked goes with the failed create, so the retry forks a fresh one; one the provider
        // will not part with keeps its record instead, since a machine nobody records bills unseen.
        const entry = live.get(id);
        let kept: LiveWorkspace | undefined;
        if (entry !== undefined) {
          const gone = await entry.machine.kill().then(() => true, (k: unknown) => isMissing(k));
          if (gone) live.delete(id);
          else {
            kept = entry;
            delete entry.creating;
            await persist(entry.record).catch((p: unknown) => console.warn(`workspace ${id} not stored: ${p instanceof Error ? p.message : String(p)}`));
            console.warn(`workspace ${id} failed to create and its machine ${entry.machine.id} would not stop; the record stays for wsp delete`);
          }
        }
        // The id dies with a failed create, so nothing could ever retry under its key.
        await store.delete(CREATES, `workspace/${id}`);
        report("failed", e instanceof Error ? e.message : String(e));
        if (kept !== undefined) bus.emit({ type: "workspace.created", workspace: view(kept.record) });
        throw e;
      } finally {
        forking.delete(o.name);
      }
    },

    async get(id) {
      return view((await entryOf(id)).record);
    },

    async createLocal(name) {
      await ready();
      const { backend: mine } = moduleOf("local");
      const n = nameGiven(name);
      const refusal = nameRefusal(n);
      if (refusal !== undefined) throw Object.assign(new Error(refusal), { kind: "conflict" });
      const machine = await mine.get(LOCAL_MACHINE_ID);
      // The machine already exists and is the only one, so one record may stand on it: one local workspace per host.
      const existing = [...live.values()].find(e => e.record.machineId === machine.id);
      if (existing !== undefined) throw Object.assign(new Error(`this computer is already the workspace ${existing.record.name}; there is one local workspace per host`), { kind: "conflict" });
      // A local workspace never naps (a computer runs while the host does), so its auto-nap window is off from the start.
      const record: WorkspaceRecord = {
        id: `ws_${randomBytes(4).toString("hex")}`,
        name: n,
        kind: "local",
        machineId: machine.id,
        phase: "running",
        golden: "",
        createdAt: new Date().toISOString(),
        spec: {},
        size: mine.pricing.defaultSize,
        firstLife: false,
        idleWindowMs: null,
      };
      attach(record, machine);
      await persist(record);
      const v = view(record);
      bus.emit({ type: "workspace.created", workspace: v });
      return v;
    },

    async list() {
      await ready();
      return [...live.values()].filter(e => !e.creating).map(e => view(e.record));
    },

    async nap(id) {
      refuseCannot(await entryOf(id), "ramPreservingPause", "be paused");
      return napWith(id);
    },

    async wake(id) {
      const entry = await entryOf(id);
      if (entry.waking) return entry.waking;
      if (entry.record.phase === "gone") throw new Error(goneRefusal("wake", entry.record.gone));
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
        if (read === "gone") {
          await settleGone(entry, goneWords(entry.record.machineId, { by: "wake", at: clock.now(), ...(answer !== undefined ? { answer } : {}) }));
          throw new Error(goneRefusal("wake", entry.record.gone));
        }
        if (read === "paused") await adoptPause(entry);
      } else if (await runsUnderNapping(entry)) await adoptRunning(entry);
      // A running workspace has nothing to wake, whatever its kind; only a real resume asks the machine for one.
      if (entry.record.phase === "running") return view(entry.record);
      refuseCannot(entry, "ramPreservingPause", "be woken");
      entry.waking = (async () => {
        entry.budget = budgetFor("wake", wakeDeadlineMs);
        entry.record.phase = "waking";
        await persist(entry.record);
        await emitStatus(entry, "napping");
        try {
          const result = await entry.ws.wake();
          followMachine(entry);
          await persist(entry.record);
          bus.emit({ type: "workspace.woken", workspaceId: id, machineId: entry.record.machineId, resurrected: result.resurrected });
          if (result.reason !== undefined) console.warn(`wake of ${id}: ${result.reason}`);
          await emitStatus(entry, reachOf(entry), result.reason);
          return view(entry.record);
        } catch (e) {
          entry.record.phase = entry.ws.currentPhase;
          await persist(entry.record);
          await emitStatus(entry, "napping", e instanceof Error ? e.message : String(e));
          armLateRead(entry);
          throw e;
        } finally {
          delete entry.budget;
          delete entry.waking;
        }
      })();
      return entry.waking;
    },

    async upgrade(id, spec) {
      const entry = await entryOf(id);
      refuseCannot(entry, "liveCloneForks", "be resized");
      await entry.ws.upgrade(spec);
      followMachine(entry);
      entry.record.spec = {
        ...entry.record.spec,
        ...(spec?.envs !== undefined ? { envs: spec.envs } : {}),
        ...(spec?.labels !== undefined ? { labels: spec.labels } : {}),
      };
      await persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      return view(entry.record);
    },

    async updateImage(id) {
      const entry = await entryOf(id);
      refuseCannot(entry, "liveCloneForks", "move to a newer image");
      const manifest = await goldenManifestOf(entry.record.golden);
      const head = goldenHead(manifest);
      const project = (await store.get(PROJECT_GOLDENS, entry.record.golden)) as ProjectGolden | undefined;
      const refusal = imageMoveRefusal(entry.record.name, workspaceState({ phase: entry.record.phase }), { knownVersion: head !== undefined, projectImage: project !== undefined });
      if (refusal !== null) throw Object.assign(new Error(refusal), { kind: "conflict" });
      // The refusal covers an image no manifest knows, so both are there by the time the move runs.
      const to = head!;
      const from = manifest!.versions.find(v => v.snapshotId === entry.record.golden)!.version;
      if (to.snapshotId === entry.record.golden) return view(entry.record);
      // The fork reads the record, so the new image is named before the machine is replaced; the vault carries the
      // work across the way a resize does. A move that throws puts the record back, so a retry forks what the
      // workspace is actually running.
      const was = entry.record.golden;
      entry.record.golden = to.snapshotId;
      try {
        await entry.ws.upgrade();
      } catch (e) {
        entry.record.golden = was;
        throw e;
      }
      followMachine(entry);
      await persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      await emitStatus(entry, reachOf(entry), `moved from image v${from ?? "?"} to v${to.version}`);
      return view(entry.record);
    },

    async rebuild(id) {
      const entry = await entryOf(id);
      refuseCannot(entry, "liveCloneForks", "be rebuilt");
      if (entry.waking) await entry.waking.catch(() => {});
      const old = entry.record.machineId;
      const vaulted = (await store.getBlob(VAULTS, id)) !== undefined;
      await entry.ws.rebuild();
      followMachine(entry);
      await persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      const reason = `rebuilt: ${old} replaced by ${entry.record.machineId}, ${vaulted ? "nap-time vault imported" : "no vault to import"}`;
      console.warn(`rebuild of ${id}: ${reason}`);
      await emitStatus(entry, reachOf(entry), reason);
      return view(entry.record);
    },

    async rename(id, typed) {
      const entry = await entryOf(id);
      const name = nameGiven(typed);
      if (entry.record.name === name) return view(entry.record);
      const refusal = nameRefusal(name);
      if (refusal !== undefined) throw Object.assign(new Error(refusal), { kind: "conflict" });
      entry.record.name = name;
      await persist(entry.record);
      await store.put(WORKSPACE_NAMES, id, { workspaceId: id, name } satisfies NamedWorkspace);
      bus.emit({ type: "workspace.renamed", workspaceId: id, name });
      return view(entry.record);
    },

    async snapshot(id) {
      const entry = await entryOf(id);
      refuseCannot(entry, "liveCloneForks", "be snapshotted");
      const { name, project } = entry.record;
      if (project === undefined) throw new Error(`${name} has no project loaded; import one before snapshotting it`);
      if (entry.record.phase !== "running") throw new Error(`${name} is ${entry.record.phase}; only a running first-life machine can be snapshotted`);
      const createdAt = new Date(clock.now()).toISOString();
      const snapshotId = await entry.ws.checkpoint(projectSnapshotName(templateHostId, project.name, createdAt.replace(/[:.]/g, "-")), `snapshot of ${name}`);
      const image = await imageOf(entry.record.golden);
      const golden: ProjectGolden = {
        snapshotId,
        project,
        golden: image.golden,
        ...(image.version !== undefined ? { version: image.version.version } : {}),
        workspaceId: id,
        workspaceName: name,
        createdAt,
      };
      await store.put(PROJECT_GOLDENS, snapshotId, golden);
      return golden;
    },

    async updateDaemon(id) {
      const entry = await entryOf(id);
      const deploy = opts.goldenRecipe?.deployDaemon;
      if (deploy === undefined) throw new Error("this runtime cannot deploy a daemon; the host wires the bundle");
      if (entry.record.phase !== "running") throw new Error(`wake ${entry.record.name} before updating its daemon`);
      await deploy(entry.machine);
      daemonTokens.delete(entry.machine.id);
      await daemonTokenOf(entry.machine);
    },

    async delete(id) {
      const entry = await entryOf(id);
      if (entry.deleting) return entry.deleting;
      entry.deleting = (async () => {
        try {
          endSessions(id, DELETED_REASON);
          await entry.machine.kill().catch((e: unknown) => {
            if (!isMissing(e)) throw e;
          });
          await drop(id);
        } finally {
          delete entry.deleting;
        }
      })();
      return entry.deleting;
    },

    async forget(id) {
      const entry = await entryOf(id);
      const state = await entry.machine.state();
      if (state !== "gone") {
        throw Object.assign(new Error(`${entry.record.name}'s machine ${entry.machine.id} is still ${state}; pause it or delete it at the provider first`), { kind: "conflict" });
      }
      endSessions(id, DELETED_REASON);
      await drop(id);
    },

    async touch(id) {
      await entryOf(id);
      idle.touch(id);
    },

    async exec(id, cmd, o) {
      const entry = await entryOf(id);
      return entry.machine.exec(cmd, o);
    },

    async execStream(id, argv, cwd) {
      const entry = await entryOf(id);
      const { adapter } = adapterFor(entry);
      // Only the socket or the machine going away ends a command; a build may outlive the deadline a harness turn gets.
      const inner = execFactoryFor(entry, { idleMs: Number.POSITIVE_INFINITY, deadlineMs: Number.POSITIVE_INFINITY })(inFolder(cwd, argv.map(shellQuote).join(" ")), { env: { ...adapter.env } });
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
      return { ...inner, lines: lines(), exited: Promise.race([inner.exited, ended.then(() => null)]) };
    },

    async daemonReach(id) {
      const entry = await entryOf(id);
      const reach = await entry.ws.daemonReach();
      const daemonToken = await daemonTokenOf(entry.machine);
      return { url: reach.url, expiresAt: reach.expiresAt, ...(daemonToken !== undefined ? { daemonToken } : {}) };
    },

    async portReach(id, port) {
      const entry = await entryOf(id);
      const reach = await entry.ws.portReach(port);
      return { url: reach.url, expiresAt: reach.expiresAt };
    },

    async portProbe(id, port) {
      const entry = await entryOf(id);
      const reach = await entry.ws.portReach(port);
      // A followed redirect would refetch without the token or the edge's cookies and report the edge's 401 for a page the frame loads fine.
      const res = await fetch(reach.url, { redirect: "manual", signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS) });
      const body = await readBodyUpTo(res, PORT_PROBE_BODY_CAP);
      if (res.status === 401) await entry.ws.remintPortReach(port);
      return { status: res.status, body };
    },
  };

  /** One probe per harness per machine per TTL, a failed one included and one in flight shared: a binary that does
   * not answer costs one exec, not one per composer mount. */
  const catalogs = new Map<string, { at: number; catalog: Promise<HarnessCatalog> }>();
  const catalogOn = (table: HarnessCatalog, machine: Machine, adapter: HarnessAdapter): Promise<HarnessCatalog> => {
    const known: HarnessCatalog = { ...table, steers: adapter.steers, renames: adapter.renameSession !== undefined, images: adapter.attachments !== undefined };
    if (adapter.probeCatalog === undefined) return Promise.resolve(known);
    const key = `${machine.id}:${table.harness}`;
    const hit = catalogs.get(key);
    const now = clock.now();
    if (hit !== undefined && now - hit.at < CATALOG_TTL_MS) return hit.catalog;
    const catalog = adapter
      .probeCatalog(command => machine.exec(command, { timeoutMs: CATALOG_PROBE_TIMEOUT_MS }).then(res => res.stdout))
      // A binary that named why it described nothing keeps the table's lists and lends the footer its words.
      .then(answer => (answer === null ? known : catalogRefused(answer) ? { ...known, refusal: answer.refused } : catalogFromProbe(known, answer)), () => known);
    catalogs.set(key, { at: now, catalog });
    return catalog;
  };

  /** One title read per harness session per machine per TTL, a failed one included and one in flight shared: the
   * clients reload the index on every session event and each reload must not cost an exec. */
  const titleReads = new Map<string, { at: number; done: Promise<void>; live: boolean }>();
  /** Asks the harness what it calls a row's session and keeps the answer on every row that shares it, so the title
   * a client folds a thread by follows a rename made inside the harness. `force` reads past the TTL: a turn has just
   * ended, which is when the harness writes its own title. Nothing happens while the machine cannot be asked, or
   * when the harness has no title for the session: the rows keep the last one read rather than losing it to a nap.
   */
  const refreshTitle = (view: SessionView, force: boolean): Promise<void> => {
    const sessionId = view.claudeSessionId;
    const entry = live.get(view.workspaceId);
    if (sessionId === undefined || entry === undefined) return Promise.resolve();
    if (workspaceState({ phase: entry.record.phase }) !== "running" || adapters[view.harness] === undefined) return Promise.resolve();
    const key = `${entry.machine.id}:${sessionId}`;
    const hit = titleReads.get(key);
    const now = clock.now();
    if (hit !== undefined && (hit.live || (!force && now - hit.at < SESSION_TITLE_TTL_MS))) return hit.done;
    // The adapter is built after the window is checked, so a refresh inside it costs nothing at all.
    const read = adapterFor(entry, view.harness).adapter.sessionTitle;
    if (read === undefined) return Promise.resolve();
    const pending: { at: number; done: Promise<void>; live: boolean } = { at: now, live: true, done: Promise.resolve() };
    // The read is started inside a promise and never on this stack: an adapter that refuses the id throws where it
    // builds its command (the codex guard does), and one row's store read may never cost the listing or the turn
    // that asked for it. Nothing here rejects, so both callers may leave it unawaited.
    pending.done = Promise.resolve()
      .then(() => read(sessionId, command => entry.machine.exec(command, { timeoutMs: SESSION_TITLE_TIMEOUT_MS }).then(res => res.stdout)))
      // The window opens when the store answered, before the answer is kept: a row that shows the title is a read
      // that is over, so a listing that sees one waits on nothing.
      .finally(() => {
        pending.at = clock.now();
        pending.live = false;
      })
      .then(
        async title => {
          if (title === null) return;
          // A title in the harness's own store is the person's rename inside it or the one the harness itself made
          // for them, and both outrank anything we would generate; only the opening words, which codex writes there
          // at a thread's start, are the seed again, and a seed is no news to a row that already carries a name.
          for (const s of sessions.values()) {
            if (s.view.workspaceId !== entry.record.id || s.view.claudeSessionId !== sessionId) continue;
            const source = storedTitleSource(title, s.view.prompt);
            if (source === "seed" && sourceOf(s.view) !== "seed") continue;
            s.view.harnessTitle = title;
            s.view.titleSource = source;
          }
          await persistSessions(entry.record.id);
        },
        (e: unknown) => console.warn(noTitleLogLine(sessionId, entry.record.id, e instanceof Error ? e.message : String(e))),
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
    return Promise.resolve()
      .then(() => write(sessionId, title, command => entry.machine.exec(command, { timeoutMs: SESSION_TITLE_TIMEOUT_MS }).then(res => res.stdout)))
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
    const { harness, adapter } = adapterFor(entry, view.harness);
    if (adapter.titleFor === undefined) return;
    titlesAsked.add(threadId);
    const table = harnessCatalog(harness);
    const model = smallestModel(table === undefined ? undefined : await catalogOn(table, entry.machine, adapter));
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
    await persistSessions(entry.record.id);
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

  /** The mark goes on the way out, never into the cache: a start and a list share one cached table. */
  const markDefault = (c: HarnessCatalog): HarnessCatalog => ({ ...c, ...(c.harness === DEFAULT_AGENT.id ? { isDefault: true } : {}) });

  /**
   * The turn's images on the road its adapter declared, imagesBlocked having already turned away what cannot go. An
   * inline adapter is handed the bytes and nothing lands anywhere, so there is no folder to answer with. A file
   * adapter is handed paths inside this send's own folder under the thread's images dir: two sends on one thread
   * would otherwise write the same paths and the first turn would be handed the second's picture, since the landing
   * happens before either turn is registered. The folder travels the same signed-URL road an import takes, since the
   * exec body holds 16 KB, and the caller removes it when the turn it was sent for ends.
   */
  const landImages = async (
    entry: LiveWorkspace,
    road: AttachmentRoad | undefined,
    dir: string,
    images: readonly ImageAttachment[],
  ): Promise<{ images: TurnImage[]; dir?: string }> => {
    if (images.length === 0 || road === undefined) return { images: [] };
    if (road === "inline") return { images: images.map(({ mediaType, bytes }) => ({ mediaType, bytes })) };
    const landed = images.map((image, index) => ({ ...image, path: imagePathIn(dir, index, image.mediaType) }));
    await importInto(entry.machine, tarOf(landed.map(i => ({ path: i.path, mode: 0o600, content: Buffer.from(i.bytes, "base64") }))), "/", { overlay: true });
    return { images: landed.map(({ mediaType, bytes, path }) => ({ mediaType, bytes, path })), dir };
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

  /** The adapter for a harness on this workspace's current machine; unnamed means the runtime's default. */
  const adapterFor = (entry: LiveWorkspace, named?: string): { harness: string; adapter: HarnessAdapter } => {
    const harness = named ?? DEFAULT_AGENT.id;
    const factory = adapters[harness];
    if (!factory) throw new Error(noAdapterLine(harness, Object.keys(adapters)));
    const kind = moduleOf(entry.record.kind);
    return { harness, adapter: factory({ machine: entry.machine, workspaceId: entry.record.id, execStream: execFactoryFor(entry), home: kind.home, env: kind.env }) };
  };

  type LiveSession = { view: SessionView; turnId: string; handle: SessionHandle; turnLive?: TurnLive };
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
  /** What the thread's start registered, kept by every turn on it. */
  const notifyOf = (threadId: string): string | undefined => {
    for (const s of sessions.values()) {
      if (s.view.threadId === threadId && s.notify !== undefined) return s.notify;
    }
    return undefined;
  };
  /** Lines for a parent whose workspace could not take a start when the child ended (napping, or the nap that ended
   * the child), sent when that workspace wakes; in memory only, so a host restart during the nap drops them. */
  const heldLines = new Map<string, { from: string; notify: string; text: string }[]>();
  /** The line into the parent thread as a send would go: steered into its running turn, queued behind it, or a turn
   * of its own. A parent whose turn replied but whose process still runs takes no message and a send would be
   * refused, so the line waits for that process to exit and goes then, by the same road. A parent with no session to
   * resume drops the line with a warning; the child's end must not fail on it. */
  const deliver = (from: string, notify: string, text: string): void => {
    const parent = latestOn(notify);
    if (parent?.claudeSessionId === undefined) {
      console.warn(`thread ${from.slice(0, 8)} ended, but thread ${notify.slice(0, 8)} has no session to tell`);
      return;
    }
    const lingering = runningOn(notify);
    if (lingering?.turnLive?.reply !== undefined) {
      const again = (): void => deliver(from, notify, text);
      void lingering.handle.finished.then(again, again);
      return;
    }
    const phase = live.get(parent.workspaceId)?.record.phase;
    if (phase !== undefined && sendRefusal(workspaceState({ phase })) !== null) {
      heldLines.set(parent.workspaceId, [...(heldLines.get(parent.workspaceId) ?? []), { from, notify, text }]);
      return;
    }
    sessionsApi.start(parent.workspaceId, { prompt: text, harness: parent.harness, resume: parent.claudeSessionId, startedBy: "agent" }).catch((e: unknown) => {
      console.warn(`thread ${from.slice(0, 8)} ended, but its line did not reach thread ${notify.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  // A wake or a rebuild (of a gone or zombie machine) puts the workspace back to running: the held lines go now.
  for (const type of ["workspace.woken", "workspace.upgraded"] as const) {
    bus.on(type, e => {
      if (e.type !== type) return;
      const lines = heldLines.get(e.workspaceId) ?? [];
      heldLines.delete(e.workspaceId);
      for (const l of lines) deliver(l.from, l.notify, l.text);
    });
  }
  /** The one line an ending turn sends where its thread's start said: into a thread, or nowhere further for me, whom
   * the recorded event reaches. Recorded before the turn's session.done, since a follower ends there. */
  const notifyEnd = (s: { view: SessionView; turnId: string }, notify: string, result: TurnResult): void => {
    const threadId = s.view.threadId;
    if (threadId === undefined) return;
    const text = notifyLine(threadId, result);
    record({ type: "session.notify", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId, notify, text });
    if (notify !== NOTIFY_ME) deliver(threadId, notify, text);
  };
  /** Settles a running row whose process the runtime ended or lost before the harness's own session.end: to the reply
   * it held, whose line already went, or failed with `cutLine` as the parent's word when it never replied. The
   * session.end carries `reason` either way. The one rule for both roads, the runtime's end() and the restart load. */
  const settleCut = (s: { view: SessionView; turnId: string; notify?: string; turnLive?: TurnLive }, reason: string, cutLine: (endedAt: number) => string): void => {
    const reply = s.turnLive?.reply;
    const endedAt = Date.now();
    s.view.status = reply ?? "failed";
    s.view.endedAt = endedAt;
    if (reply === undefined && s.notify !== undefined) notifyEnd(s, s.notify, { status: "failed", error: cutLine(endedAt) });
    record({ type: "session.end", workspaceId: s.view.workspaceId, sessionId: s.view.claudeSessionId ?? s.view.id, turnId: s.turnId, threadId: s.view.threadId, exitCode: null, sawResult: reply !== undefined, reason });
  };
  /** Recorded once the harness took the line, so the row sits where the turn could first see it. */
  const recordSteer = (s: { view: SessionView; turnId: string }, handleId: string, o: { prompt: string; requestId?: string }): void => {
    record({
      type: "session.steer",
      workspaceId: s.view.workspaceId,
      sessionId: s.view.claudeSessionId ?? handleId,
      turnId: s.turnId,
      ...(s.view.threadId !== undefined ? { threadId: s.view.threadId } : {}),
      prompt: o.prompt,
      ...(o.requestId !== undefined ? { requestId: o.requestId } : {}),
    });
  };

  /** What a turn is once its harness session exists: the one road from the harness's events to the transcript, the
   * index, the bus and the row, whether the session was launched here or re-opened on the machine after a restart.
   * A re-opened turn's run is read from its first byte, so what the transcript already holds for this turn is
   * counted first and read past in silence: a delta is recorded once however many hosts read the run it came from. */
  const runTurn = (t: {
    entry: LiveWorkspace;
    view: SessionView;
    /** The thread this turn runs on, which every row the runtime writes carries. */
    threadId: string;
    turnId: string;
    notify?: string;
    outcome: SessionStartOutcome;
    /** What this turn's own session.start row carries, for the road that still has to write it. */
    opening: { prompt: string; requestId?: string; afterCut?: boolean; title?: string; attachments?: readonly ImageRecord[] };
    /** The harness session this turn resumes, so the row it takes over keeps who opened the thread and with what. */
    resume?: string;
    /** What the row already knows of this turn's reply: a re-opened turn whose result landed before the restart is
     * still working, and reads as such until the run's own result line comes round again. */
    turnLive?: TurnLive;
    /** The folder this turn's images landed in on the machine, removed when the turn ends however it ends; absent on
     * a turn that landed none, whose harness read them inline or which carried none at all. */
    imagesDir?: string;
    open: (onEvent: (event: AdapterEvent) => void) => HarnessSession;
  }): SessionHandle => {
    const { entry, view, threadId, turnId, opening, outcome, notify } = t;
    const workspaceId = entry.record.id;
    const written = transcripts.get(workspaceId) ?? [];
    /** The last row this turn wrote of a kind: the transcript holds every workspace's rows in the order they were
     * written, so a live turn's are at its tail. */
    const lastOf = <T extends SessionEvent["type"]>(type: T): Extract<SessionEvent, { type: T }> | undefined => {
      for (let i = written.length - 1; i >= 0; i--) {
        const e = written[i]!;
        if (e.type === type && e.turnId === turnId) return e as Extract<SessionEvent, { type: T }>;
      }
      return undefined;
    };
    // How many of this turn's lines are written, from the stamp the last surviving one carries rather than from how
    // many survive: the transcript is capped per workspace and drops its oldest rows, so counting them would read a
    // turn whose head has been evicted as shorter than it was and write its tail a second time.
    const deltasWritten = lastOf("session.delta")?.line ?? 0;
    // The reply and its line to the parent go together, so one gate stands for both.
    const recordedReply = lastOf("session.done")?.result.status;
    let replyRecorded = recordedReply !== undefined;
    // A turn with a line or a reply already written had its start written too, whether or not the cap still holds it:
    // a second start row at the tail of the transcript would sit after the work it opened.
    let startRecorded = deltasWritten > 0 || replyRecorded || lastOf("session.start") !== undefined;
    let deltas = deltasWritten;
    let replaying = deltasWritten;
    let ended = false;
    // The reply's status, held while the process still runs. Shared with this turn's session-map entry so runningOn
    // and the persisted row read it whether the harness emits its result synchronously in start() (before the entry
    // exists) or later from its stream.
    const turnLive: TurnLive = t.turnLive ?? {};

    const forward = (event: AdapterEvent): void => {
      if (ended) return;
      const sessionId = event.sessionId;
      switch (event.type) {
        case "session.start": {
          view.claudeSessionId = sessionId;
          if (event.cwd !== undefined) view.cwd = event.cwd;
          if (event.model !== undefined) view.model = event.model;
          entry.record.claudeSessionId = sessionId;
          void persist(entry.record);
          void persistSessions(workspaceId);
          // The harness keys its store by the id it just announced, so a name given at the start is written now;
          // a CLI that already took it at launch is told the same name twice, which is what keeps this one road.
          if (opening.title !== undefined && !startRecorded) void nameInHarness(view, opening.title);
          // One turn is one start row however often the harness announces itself.
          if (startRecorded) return;
          startRecorded = true;
          record({
            type: "session.start",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            prompt: opening.prompt,
            ...(opening.requestId !== undefined ? { requestId: opening.requestId } : {}),
            ...(opening.afterCut === true ? { afterCut: true } : {}),
            ...(opening.attachments !== undefined ? { attachments: [...opening.attachments] } : {}),
            ...(event.model !== undefined ? { model: event.model } : {}),
            ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
            ...(event.tools !== undefined ? { tools: event.tools } : {}),
            ...(event.harness !== undefined ? { harness: event.harness } : {}),
          });
          // The thread is named now, from its opening words, so a builder's row reads what it is about seconds
          // after it starts rather than after an hour-long turn. Asked here and not before the harness announced
          // its session: the store is read first, since what the harness already calls the session is a person's
          // and a thread that has one is never asked, and the answer is written back under that same id. This sits
          // under the one start row a turn writes, so a re-opened run, whose row the host that launched it wrote,
          // returns above and asks nothing.
          if (sourceOf(view) === "seed") {
            void refreshTitle(view, false)
              .then(() => makeTitle(view))
              .catch((e: unknown) => console.warn(noMadeTitleLogLine(threadId, workspaceId, e instanceof Error ? e.message : String(e))));
          }
          return;
        }
        case "turn.delta":
          if (replaying > 0) {
            replaying--;
            return;
          }
          record({
            type: "session.delta",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            line: ++deltas,
            kind: event.kind,
            text: event.text,
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
            ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
            ...(event.isError !== undefined ? { isError: event.isError } : {}),
            ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
          });
          return;
        case "turn.done":
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
          void persistSessions(workspaceId);
          if (notify !== undefined) notifyEnd({ view, turnId }, notify, event.result);
          record({ type: "session.done", workspaceId, sessionId, turnId, threadId, result: event.result });
          return;
        case "session.end":
          // The process exited: the turn is over now, so the row takes the reply's status here (synchronously,
          // before the event is recorded, so a waiter woken by it reads the settled row, not the running one).
          if (turnLive.reply !== undefined) view.status = turnLive.reply;
          view.endedAt = Date.now();
          record({
            type: "session.end",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            exitCode: event.exitCode,
            sawResult: event.sawResult,
          });
          return;
      }
    };

    idle.hold(workspaceId);
    let started: HarnessSession;
    try {
      started = t.open(forward);
    } catch (e) {
      idle.release(workspaceId);
      throw e;
    }
    started.finished.then(
      () => idle.release(workspaceId),
      () => idle.release(workspaceId),
    );
    const handleId = started.localId;
    // A row that already has an id keeps it: a re-opened turn is named by the harness's own session, which is not
    // always the id the row was keyed by, and a client holding the row must not see it change under a restart.
    if (view.id === "") view.id = handleId;
    const rowId = view.id;
    // A resumed turn takes over the row of the turn it resumes; the row keeps saying who opened the thread and
    // with what, since every client titles the thread by the row's prompt. Later turns live in the transcript.
    const resumed = t.resume !== undefined ? sessions.get(handleId)?.view : undefined;
    if (resumed !== undefined) {
      view.startedBy = resumed.startedBy ?? view.startedBy;
      if (resumed.prompt !== undefined) view.prompt = resumed.prompt;
    }

    const handle: SessionHandle = {
      id: rowId,
      workspaceId,
      finished: started.finished,
      turnId,
      outcome,
      view: () => ({ ...view }),
      interrupt: () => started.interrupt(),
      ...(started.steer !== undefined ? { steer: (prompt: string) => started.steer!(prompt) } : {}),
    };
    const end = (reason: string): void => {
      if (ended || view.status !== "running") return;
      ended = true;
      settleCut({ view, turnId, ...(notify !== undefined ? { notify } : {}), turnLive }, reason, () => reason);
      void persistSessions(workspaceId);
      void started.interrupt().catch(() => {});
    };
    sessions.set(rowId, { view, turnId, ...(notify !== undefined ? { notify } : {}), handle, end, turnLive, ...(started.run !== undefined ? { run: started.run } : {}) });
    void persistSessions(workspaceId);
    // The harness writes its own title for the session as the turn settles, so the row is asked again at both
    // ends; the reload a client runs on session.end shares that read rather than starting a second.
    started.finished
      .then(result => {
        if (!ended) view.status = result.status;
        view.endedAt ??= Date.now();
        void persistSessions(workspaceId);
        void refreshTitle(view, true);
        if (t.imagesDir !== undefined) dropImages(entry, t.imagesDir);
      })
      .catch(() => {
        if (!ended) view.status = "failed";
        view.endedAt ??= Date.now();
        void persistSessions(workspaceId);
        void refreshTitle(view, true);
        if (t.imagesDir !== undefined) dropImages(entry, t.imagesDir);
      });
    return handle;
  };

  /** What re-opening a turn the store left running came to. `attached` is a reader on the run again and the thread
   * goes on; `gone` is the machine's own answer that it no longer holds the run, the one answer that ends the turn;
   * `unreached` is a machine that said nothing for the whole reach window, which says nothing about the run, so the
   * row is left running for the poll that watches machines to settle if the machine really is away; `cannot` is a
   * run this host has no road to at all, and the row reads as a turn the restart cut. */
  type Reopened = "attached" | "gone" | "unreached" | "cannot";

  /** A turn the store left running, re-opened where it runs. The machine still holds the run and its whole output,
   * so the events this host missed reach it as the run's own lines and the thread goes on running to its reply.
   * `cannot` covers a row with no run recorded (a host from before this road, or a harness whose runs die with it),
   * no workspace or no machine running under it, no adapter for its harness in this process, and a handle that is
   * not one this host could have launched. */
  const reattach = async (s: { view: SessionView; turnId: string; notify?: string; turnLive?: TurnLive; run?: string }): Promise<Reopened> => {
    const { view, run } = s;
    const threadId = view.threadId;
    const entry = live.get(view.workspaceId);
    if (run === undefined || threadId === undefined || entry === undefined || entry.record.phase !== "running") return "cannot";
    const cannot = (words: string): "cannot" => {
      console.warn(`thread ${threadId.slice(0, 8)} on ${view.workspaceId} cannot be re-opened: ${words}`);
      return "cannot";
    };
    let adapter: HarnessAdapter;
    try {
      adapter = adapterFor(entry, view.harness).adapter;
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
        onEvent: event => (sink === undefined ? void held.push(event) : sink(event)),
      });
    } catch (e: unknown) {
      // Nothing answered about the run, so nothing is known about it: the turn is left exactly as it was.
      console.warn(`thread ${threadId.slice(0, 8)} on ${view.workspaceId} was left running: ${e instanceof Error ? e.message : String(e)}`);
      return "unreached";
    }
    if (opened === "gone") return "gone";
    try {
      runTurn({
        entry,
        view,
        threadId,
        turnId: s.turnId,
        ...(s.notify !== undefined ? { notify: s.notify } : {}),
        ...(s.turnLive !== undefined ? { turnLive: s.turnLive } : {}),
        outcome: "started",
        opening: { prompt: view.prompt ?? "" },
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

  const sessionsApi: Runtime["sessions"] = {
    async start(workspaceId, o) {
      const entry = await entryOf(workspaceId);
      refuseRelayed(entry, o.origin);
      const refuse = (): void => {
        const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone);
        if (refusal !== null) throw new Error(refusal);
      };
      refuse();
      const title = o.title === undefined ? undefined : titleLine(o.title);
      if (title === "") throw new Error(EMPTY_TITLE_LINE);
      const { harness, adapter } = adapterFor(entry, o.harness);
      const records = (o.attachments ?? []).map(imageRecord);
      const blocked = imagesBlocked(records, adapter.attachments, harness);
      if (blocked !== null) throw new Error(blocked);
      const named = o.thread === undefined ? undefined : latestOn(o.thread);
      if (o.thread !== undefined && named?.workspaceId !== workspaceId) throw new Error(`no thread ${o.thread} on this workspace`);
      const resume = o.resume ?? named?.claudeSessionId;
      const threadId = named?.threadId ?? threadOf(workspaceId, resume);
      if (o.notify !== undefined && o.notify !== NOTIFY_ME) {
        if (latestOn(o.notify) === undefined) throw new Error(`no thread ${o.notify} to notify`);
        if (o.notify === threadId) throw new Error("a thread cannot notify itself");
        // Each end would start the next turn on the other thread with no one sending anything, so the chain is
        // walked whole; it is a lead and its builders, so it is short.
        const seen = new Set<string>();
        for (let link = notifyOf(o.notify); link !== undefined && link !== NOTIFY_ME && !seen.has(link); link = notifyOf(link)) {
          if (link === threadId) throw new Error(`thread ${o.notify.slice(0, 8)} already notifies this thread; a cycle would run forever`);
          seen.add(link);
        }
      }
      const notify = o.notify ?? notifyOf(threadId);
      const table = harnessCatalog(harness);
      // Checked against the binary's own lists, the ones the composer shows for this workspace.
      const picks = startPicks(table === undefined ? undefined : await catalogOn(table, entry.machine, adapter), o, resume === undefined);
      let outcome: SessionStartOutcome = "started";
      let images: TurnImage[] = [];
      let imagesDir: string | undefined;
      let landed = (o.attachments?.length ?? 0) === 0;
      // This send's own folder on the machine, named by the request id it minted: the landing runs before any turn is
      // registered, so two sends arriving together both pass the wait, and a folder they shared would leave the first
      // turn holding the second's picture.
      const sendDir = turnImagesDir(threadId, o.requestId, randomUUID());
      // Every road out of the window between the landing and runTurn is in here, since the turn that would take
      // this send's images off the machine is the one that does not exist on any of them: a refusal after the wait,
      // a steer that took the message instead, a start that never opened. The finally covers the steer, which
      // leaves by returning rather than by throwing.
      let handedOver = false;
      try {
        // Two processes on one harness session corrupt its transcript, so a thread runs one turn at a time. Nothing
        // below this loop may await: the wait ends the moment no turn is running, and every line from there to
        // runTurn, which registers this one, is one synchronous run. The images land inside it for that reason, and
        // the wait is entered again after them, since landing them is a trip to the machine.
        for (;;) {
          const running = runningOn(threadId);
          if (running === undefined) {
            if (landed) break;
            landed = true;
            ({ images, dir: imagesDir } = await landImages(entry, adapter.attachments, sendDir, o.attachments ?? []));
            continue;
          }
          // The turn replied and its process has not exited: it takes no message and waiting on it would block the
          // caller for however long the harness lingers, so the send is refused in words naming the thread.
          if (running.turnLive?.reply !== undefined) throw new Error(stillWorkingRefusal(threadId));
          if (adapter.steers && running.handle.steer !== undefined && (await running.handle.steer(o.prompt)) === "accepted") {
            recordSteer(running, running.handle.id, o);
            return { ...running.handle, outcome: "steered" };
          }
          if (outcome === "started") bus.emit({ type: "session.queued", workspaceId, threadId, prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
          outcome = "queued";
          await running.handle.finished.catch(() => {});
          refuse();
        }
        const turnId = randomUUID();
        const cwd = (resume !== undefined ? folderOf(workspaceId, resume) : undefined) ?? o.cwd;
        const afterCut = resume !== undefined && cutBefore(workspaceId, threadId);
        // Created before adapter.start so events that fire synchronously during
        // start() still land on the view. A resume id was announced by the harness
        // in an earlier turn, so the row carries it before this one answers.
        const sessionView: SessionView = {
          id: "",
          workspaceId,
          harness,
          status: "running",
          startedBy: o.startedBy ?? "person",
          threadId,
          prompt: o.prompt,
          startedAt: Date.now(),
          ...(title !== undefined ? { harnessTitle: title, titleSource: "person" as const } : carriedTitle(threadId)),
          ...(resume !== undefined ? { claudeSessionId: resume } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...picks,
          ...(o.contextWindow !== undefined ? { contextWindow: o.contextWindow } : {}),
        };
        const handle = runTurn({
          entry,
          view: sessionView,
          threadId,
          turnId,
          ...(notify !== undefined ? { notify } : {}),
          outcome,
          opening: { prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}), ...(afterCut ? { afterCut } : {}), ...(title !== undefined ? { title } : {}), ...(records.length > 0 ? { attachments: records } : {}) },
          ...(imagesDir !== undefined ? { imagesDir } : {}),
          ...(resume !== undefined ? { resume } : {}),
          open: onEvent =>
            adapter.start({
              prompt: o.prompt,
              ...(resume !== undefined ? { resume } : {}),
              ...(cwd !== undefined ? { cwd } : {}),
              ...picks,
              ...(o.contextWindow !== undefined ? { contextWindow: o.contextWindow } : {}),
              ...(title !== undefined ? { title } : {}),
              ...(images.length > 0 ? { images } : {}),
              onEvent,
            }),
        });
        handedOver = true;
        return handle;
      } finally {
        if (!handedOver && imagesDir !== undefined) dropImages(entry, imagesDir);
      }
    },

    async list(workspaceId) {
      await ready();
      const all = [...sessions.values()].map(s => s.view);
      const rows = workspaceId === undefined ? all : all.filter(v => v.workspaceId === workspaceId);
      // A refresh is where a rename made inside the harness reaches us: nothing on this side changed. A row that
      // already carries a title is answered from the index and its read goes out unawaited, so a wedged guest
      // costs the listing nothing and the rename lands on the next refresh, which is the window the TTL promises.
      // A row with none blocks, so a thread is titled on the first listing that sees it.
      const asked = titleRows(rows).map(view => ({ first: view.harnessTitle === undefined, done: refreshTitle(view, false) }));
      await Promise.all(asked.filter(a => a.first).map(a => a.done));
      return rows.map(v => ({ ...v }));
    },

    async history(workspaceId) {
      await entryOf(workspaceId);
      return (transcripts.get(workspaceId) ?? []).map(e => ({ ...e }));
    },

    async interrupt(sessionId) {
      await ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      if (s.view.status !== "running" || s.handle === undefined) return { outcome: "not-running" };
      await s.handle.interrupt();
      // The harness resolves finished only after session.end, so accepted means the turn is over on the transcript too.
      await s.handle.finished.catch(() => {});
      return { outcome: "accepted" };
    },

    async steer(sessionId, o) {
      await ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const entry = await entryOf(s.view.workspaceId);
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      if (s.view.status !== "running" || s.handle === undefined) return { outcome: "not-running" };
      if (s.handle.steer === undefined) return { outcome: "unsupported" };
      const outcome = await s.handle.steer(o.prompt);
      if (outcome !== "accepted") return { outcome };
      recordSteer(s, sessionId, o);
      return { outcome: "accepted" };
    },

    async rename(sessionId, title) {
      await ready();
      const named = title.trim();
      if (named === "") throw new Error(EMPTY_TITLE_LINE);
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const harnessSessionId = s.view.claudeSessionId;
      const entry = await entryOf(s.view.workspaceId);
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "rename", entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      const write = adapterFor(entry, s.view.harness).adapter.renameSession;
      if (write === undefined) return { outcome: "unsupported" };
      // The store is keyed by the harness's own id, so a thread whose harness never announced one has nothing to name.
      if (harnessSessionId === undefined) return { outcome: "no-session" };
      const wrote = await write(harnessSessionId, named, command => entry.machine.exec(command, { timeoutMs: SESSION_TITLE_TIMEOUT_MS }).then(res => res.stdout));
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
      await persistSessions(entry.record.id);
      return { outcome: "renamed" };
    },
  };

  const builderView = (r: BuilderRecord, b: LiveBuilder): GoldenBuilderView => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    createdAt: r.createdAt,
    size: r.size,
    ...(r.streamUrl !== undefined ? { screen: { streamUrl: r.streamUrl } } : {}),
    firstLife: b.builder.firstLife,
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
    await refreshBuilders();
    const reaped: ReapedMachine[] = [];
    const failed: ReapFailure[] = [];
    for (const b of [...builders.values()]) {
      if (b.record.sealed === undefined || !(b.life === "own" || b.life === "reusable") || inWindow(b.record.sealed.at)) continue;
      try {
        await b.builder.machine.kill();
      } catch (e) {
        if (!isMissing(e)) {
          failed.push({ id: b.record.id, message: `could not stop: ${e instanceof Error ? e.message : String(e)}; stays recorded, retried next sweep` });
          continue;
        }
      }
      graceTimers.get(b.record.id)?.();
      graceTimers.delete(b.record.id);
      await forgetBuilder(b.record.id);
      reaped.push({ id: b.record.id, builder: true, reason: "grace", ageMs: clock.now() - Date.parse(b.record.sealed.at) });
    }
    return { reaped, failed };
  };

  /** Marks the record as this process's, now; the sweep and the heartbeat timer refresh it and close() clears it. */
  let beat: (() => void) | undefined;
  let closed = false;
  let ticking: Promise<void> | undefined;
  const arm = (): void => {
    if (closed || beat !== undefined) return;
    beat = clock.schedule(
      () => {
        beat = undefined;
        ticking = tick();
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
    if (!closed) b.record.heldBy = { host: hostId, pid: process.pid, heartbeat: new Date().toISOString() };
    await store.put(BUILDERS, b.record.id, b.record);
    if (!closed) arm();
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

  const stageOf = (name: string) => (stage: GoldenStage, detail?: string, step?: GoldenStep) =>
    bus.emit({ type: "golden.stage", name, stage, ...(detail !== undefined ? { detail } : {}), ...(step !== undefined ? { step } : {}) });

  const recipeOrThrow = (): GoldenRecipe => {
    if (!opts.goldenRecipe) throw new Error("this runtime has no golden recipe; the host wires one (setup + smoke) before the wizard can run");
    return opts.goldenRecipe;
  };

  const builderLabels = (extra: Record<string, string> | undefined): Record<string, string> => ({ ...extra, [WSP_LABEL]: "1", [BUILDER_LABEL]: "1", [OWNER_LABEL]: owner, [CREATED_AT_LABEL]: new Date().toISOString() });

  /** The hold begins the moment the machine exists: a held placeholder is on the store before any stage runs, so
   * another process over it (a second host, wspx) never reads this machine as lost. */
  const recordingCreates = (
    b: MachineBackend,
    name: string,
    imp: Pick<GoldenImport, "recipeHash" | "recipe"> | undefined,
    made: (placeholder: LiveBuilder) => void,
    stop?: { signal: AbortSignal | undefined; began: (creating: Promise<Machine>) => void },
  ): MachineBackend => ({
    ...b,
    create: spec => {
      if (stop?.signal?.aborted) return Promise.reject(new PrepareStoppedError());
      // Handed out before the provider is called, so a stop that lands inside the call waits for the machine it returns.
      const creating = Promise.resolve().then(async () => {
        const machine = observed(await b.create(spec));
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
        };
        const placeholder: LiveBuilder = { record, builder: { machine, kind: spec.kind, baseTemplate: record.baseTemplate, setupSha: "", createdAt: record.createdAt, firstLife: true, size: asked }, life: "own" };
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
  const settleBuilder = async (name: string, builder: Builder, placeholder: LiveBuilder | undefined): Promise<LiveBuilder> => {
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
    };
    const entry: LiveBuilder = placeholder ?? { record, builder, life: "own" };
    entry.record = record;
    entry.builder = builder;
    builders.set(record.id, entry);
    await hold(entry);
    return entry;
  };

  /** Snapshot, smoke fork, manifest. A kept builder stays recorded with the version it was saved as and its grace
   * armed; every other road drops the record, so a machine that outlived its kills is exactly what reap sweeps. */
  const sealEntry = async (entry: LiveBuilder, keep: boolean, logins?: GoldenLogin[]): Promise<SealResult> => {
    const recipe = recipeOrThrow();
    const name = entry.record.name;
    const prior = (await store.get(GOLDENS, name)) as GoldenManifest | undefined;
    try {
      const result = await claiming(`smoke/${entry.record.id}`, b =>
        sealGolden(entry.builder, {
          backend: observing(b),
          smoke: recipe.smoke,
          ...(recipe.cpu !== undefined ? { cpu: recipe.cpu } : {}),
          ...(recipe.memMb !== undefined ? { memMb: recipe.memMb } : {}),
          ...(recipe.envs !== undefined ? { envs: recipe.envs } : {}),
          labels: { ...recipe.labels, [WSP_LABEL]: "1", [SMOKE_LABEL]: "1", [OWNER_LABEL]: owner, [CREATED_AT_LABEL]: new Date().toISOString() },
          ...(prior !== undefined ? { manifest: prior } : {}),
          onStage: stageOf(name),
          ...(opts.killConfirm !== undefined ? { killConfirm: opts.killConfirm } : {}),
          ...(opts.snapshotRetryMs !== undefined ? { snapshotRetryMs: opts.snapshotRetryMs } : {}),
          ...(logins !== undefined ? { logins } : {}),
          keepBuilder: keep,
          name,
          hostId: templateHostId,
        }),
      );
      await store.put(GOLDENS, name, result.manifest);
      const snapshot = entry.builder.import?.recipe;
      if (snapshot !== undefined) await store.put(GOLDEN_RECIPES, recipeKey(name, result.version.version), snapshot);
      if (result.builderKept) {
        entry.record.sealed = { at: new Date(clock.now()).toISOString(), version: result.version.version };
        entry.life = "own";
        await hold(entry);
        armGrace(entry.record.id, entry.record.sealed.at);
      } else {
        await forgetBuilder(entry.record.id);
      }
      return result;
    } catch (e) {
      // A builder the provider refused to snapshot and still has is untouched, so its record stays for the next attach.
      if (e instanceof SnapshotFailedError && e.builderState !== "gone") throw e;
      // sealGolden consumes the builder on every other road but a refusal; a refused
      // builder can never seal and under a two-machine cap must not outlive it.
      if (e instanceof NotFirstLifeError) await killUntilGone(backend, entry.builder.machine, opts.killConfirm);
      await forgetBuilder(entry.record.id);
      throw e;
    }
  };

  /** Deletes what a version's forks boot from. The template goes first: the provider refuses to delete a snapshot
   * while a template stands on it, and a template already gone is no failure. */
  const dropImage = async (v: GoldenVersion): Promise<void> => {
    if (v.templateId !== undefined) {
      await templatesOf(backend)?.delete(v.templateId).catch((e: unknown) => {
        if (!isMissing(e)) throw e;
      });
    }
    await backend.deleteSnapshot(v.snapshotId);
  };

  const golden: Runtime["golden"] = {
    async build(o) {
      await ready();
      const { name, ...build } = o;
      const key = name ?? "default";
      const prior = (await store.get(GOLDENS, key)) as GoldenManifest | undefined;
      const result = await claiming(`golden/${key}`, b =>
        buildGolden({
          ...build,
          backend: b,
          name: key,
          hostId: templateHostId,
          labels: { ...build.labels, [WSP_LABEL]: "1", [OWNER_LABEL]: owner, [CREATED_AT_LABEL]: new Date().toISOString() },
          ...(prior !== undefined ? { manifest: prior } : {}),
        }),
      );
      await store.put(GOLDENS, key, result.manifest);
      return { manifest: result.manifest, version: result.version };
    },
    async get(name) {
      return (await store.get(GOLDENS, name ?? "default")) as GoldenManifest | undefined;
    },

    async prepare(o) {
      await ready();
      const recipe = recipeOrThrow();
      const name = o?.name ?? "default";
      const signal = o?.signal;
      const { deployDaemon, smoke, import: imp, ...size } = recipe;
      void smoke;
      const active = preparing.get(name);
      if (active !== undefined) {
        if (active.hash === imp?.recipeHash) return active.promise;
        throw new Error(`a builder named ${name} is still being prepared for a different recipe; wait for it to finish, then run again`);
      }
      const stage = stageOf(name);
      const run = claiming(`builder/${name}`, async b => {
        await refreshBuilders();
        // A first-life builder carrying the same ticks is attached to instead of
        // booting a second one, whichever process made it; the stages skip on its
        // ledger. A stale, foreign or held record is never reused, and a recipe with no
        // import never attaches: nothing says which ticks the builder carries. The
        // building check is a second wall: the join above holds it in this process,
        // life does across processes.
        const same = imp === undefined ? undefined : [...builders.values()].find(x => (x.life === "own" || x.life === "reusable") && x.record.building !== true && x.record.sealed === undefined && x.record.name === name && x.record.import?.recipeHash === imp.recipeHash);
        // The machine this prepare has, attached to or made. A stop kills a made one by its recorded id and drops the
        // record; an attached one has a first life and maybe an earlier run's sign-ins, so its hold is released and
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
            await killUntilGone(backend, mine.builder.machine, opts.killConfirm);
          } catch (e) {
            return new PrepareStoppedError(id, { left: e instanceof Error ? e.message : String(e) });
          }
          await forgetBuilder(id).catch(warn(`record of builder ${id} not dropped; the machine is gone and the next load drops it`));
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
            await hold(same);
          } catch (e) {
            if (stopping !== undefined) throw e;
            // Same road as a fresh builder that fails its stages: the machine goes, the person starts over.
            let detail = e instanceof Error ? e.message : String(e);
            await killUntilGone(backend, same.builder.machine, opts.killConfirm).catch((k: unknown) => {
              detail += `; ${k instanceof Error ? k.message : String(k)}`;
            });
            await forgetBuilder(same.record.id);
            stage("failed", detail);
            throw e;
          }
          stage("ready");
          return builderView(same.record, same);
        };
        const fresh = async (): Promise<GoldenBuilderView> => {
          let builder: Builder;
          try {
            builder = await prepareBuilder({
              backend: recordingCreates(b, name, imp, p => (mine = p), { signal, began: c => (creating = c) }),
              ...size,
              ...(o?.kind !== undefined ? { kind: o.kind } : {}),
              ...(deployDaemon !== undefined ? { deployDaemon } : {}),
              ...(imp !== undefined ? { import: imp } : {}),
              labels: builderLabels(recipe.labels),
              onStage: stage,
            });
          } catch (e) {
            // prepareBuilder killed the machine on its way out; the placeholder goes with it. After a stop the record is the stop's.
            if (mine !== undefined && stopping === undefined) await forgetBuilder(mine.record.id);
            throw e;
          }
          // A last exec that outran the kill must not leave a finished record for a machine the stop is killing.
          if (stopping !== undefined) throw await stopping;
          const entry = await settleBuilder(name, builder, mine);
          return builderView(entry.record, entry);
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
      }).finally(() => preparing.delete(name));
      preparing.set(name, { hash: imp?.recipeHash, promise: run });
      return run;
    },

    async seal(builderId, o) {
      await ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      refuseUntouchable(entry);
      // A builder built from a recipe is what an update can land on; a bare one has no recipe to diff.
      return sealEntry(entry, o?.keepBuilder !== false && entry.record.import?.recipe !== undefined, o?.logins);
    },

    async recipe(name) {
      await ready();
      const key = name ?? "default";
      const manifest = (await store.get(GOLDENS, key)) as GoldenManifest | undefined;
      if (manifest === undefined) return undefined;
      return (await store.get(GOLDEN_RECIPES, recipeKey(key, manifest.head))) as RecipeDigest | undefined;
    },

    async upgrade(o) {
      await ready();
      const recipe = recipeOrThrow();
      const name = o.name ?? "default";
      const prior = (await store.get(GOLDENS, name)) as GoldenManifest | undefined;
      const head = goldenHead(prior);
      if (head === undefined) throw new Error(`no golden named "${name}" to update; wsp init builds one`);
      const stage = stageOf(name);
      // Past its window a kept builder is never used, running or not: it is stopped here and the update forks; one
      // the pass could not stop is named so the person knows it still bills. Inside the window, it is suspended for
      // the update's length: the record loses `sealed` and gains `building` before the first exec, so neither the
      // timer nor a sweep stops the machine mid-stage, and a process that dies here leaves a record the next one
      // stops as unfinished; the seal re-arms the window.
      const swept = await expireGrace();
      for (const f of swept.failed) stage("creating", `an earlier kept builder ${f.id}: ${f.message}`);
      await refreshBuilders();
      const kept = [...builders.values()].find(x => (x.life === "own" || x.life === "reusable") && x.record.name === name && x.record.sealed?.version === head.version && inWindow(x.record.sealed.at));
      let entry: LiveBuilder | undefined;
      if (kept !== undefined) {
        graceTimers.get(kept.record.id)?.();
        graceTimers.delete(kept.record.id);
        delete kept.record.sealed;
        kept.record.building = true;
        await store.put(BUILDERS, kept.record.id, kept.record);
        const alive = await kept.builder.machine.exec("true").then(r => r.exitCode === 0, () => false);
        if (!alive) {
          // A machine that does not answer may still bill: it is killed until the provider says gone, then forgotten.
          await killUntilGone(backend, kept.builder.machine, opts.killConfirm);
          await forgetBuilder(kept.record.id);
        } else {
          stage("creating", `your builder from v${head.version}, kept since the save`);
          try {
            const applied = await applyDelta(kept.builder.machine, o.delta, { setup: recipe.setup, previousSmoke: head.smoke.cmd, previousBase: head.base, ...(head.missingTools !== undefined ? { previousMissing: head.missingTools } : {}), ...(head.leftBehind !== undefined ? { previousLeftBehind: head.leftBehind } : {}), onStage: stage });
            const setupSha = nextSetupSha(head.setupSha, recipe.setup, o.delta.import);
            kept.record.import = applied.ledger;
            kept.record.setupSha = setupSha;
            delete kept.record.building;
            // The builder was sealed as the head, so the version it seals next descends from the head's snapshot.
            kept.builder = { ...kept.builder, import: applied.ledger, setupSha, parentSnapshotId: head.snapshotId, retired: o.delta.retiredOnImage };
            kept.life = "own";
            await hold(kept);
          } catch (e) {
            // Same road as a fresh builder that fails its stages: the machine goes, the golden stays as it was.
            let detail = e instanceof Error ? e.message : String(e);
            await killUntilGone(backend, kept.builder.machine, opts.killConfirm).catch((k: unknown) => {
              detail += `; ${k instanceof Error ? k.message : String(k)}`;
            });
            await forgetBuilder(kept.record.id);
            stage("failed", detail);
            throw e;
          }
          stage("ready");
          entry = kept;
        }
      }
      const road = entry !== undefined ? "builder" : "fork";
      entry ??= await claiming(`builder/${name}`, async b => {
        let placeholder: LiveBuilder | undefined;
        let builder: Builder;
        try {
          builder = await upgradeBuilder({
            backend: recordingCreates(b, name, o.delta.import, p => (placeholder = p)),
            head,
            delta: o.delta,
            setup: recipe.setup,
            ...(recipe.cpu !== undefined ? { cpu: recipe.cpu } : {}),
            ...(recipe.memMb !== undefined ? { memMb: recipe.memMb } : {}),
            ...(recipe.envs !== undefined ? { envs: recipe.envs } : {}),
            labels: builderLabels(recipe.labels),
            onStage: stage,
          });
        } catch (e) {
          if (placeholder !== undefined) await forgetBuilder(placeholder.record.id);
          throw e;
        }
        return settleBuilder(name, builder, placeholder);
      });
      // The update keeps the golden's disk, so what was signed in stays signed in: the caller passes the previous
      // version's outcomes, with the rows it re-imported as copies rewritten.
      const sealed = await sealEntry(entry, true, o.logins);
      let manifest = sealed.manifest;
      let previousDropped = false;
      let builderKept = sealed.builderKept;
      // A version with workspaces still on it stays for them: a rebuild boots them from its image, which the provider
      // would delete under a template's forks (they hold no dependency on it).
      const standing = forkedFrom(head.snapshotId);
      if (o.keepPrevious === false) {
        if (standing.length > 0) {
          console.warn(`golden ${name} v${head.version} kept: ${standing.join(", ")} still on it`);
        } else {
          // A snapshot with live forks under it cannot be deleted (409 on Solari): the builder forked from it goes
          // first, window or not.
          if (road === "fork" && builderKept) {
            graceTimers.get(entry.record.id)?.();
            graceTimers.delete(entry.record.id);
            await killUntilGone(backend, entry.builder.machine, opts.killConfirm);
            await forgetBuilder(entry.record.id);
            builderKept = false;
          }
          try {
            await dropImage(head);
            manifest = { ...manifest, versions: manifest.versions.filter(v => v.version !== head.version) };
            await store.put(GOLDENS, name, manifest);
            await store.delete(GOLDEN_RECIPES, recipeKey(name, head.version));
            previousDropped = true;
          } catch (e) {
            console.warn(`golden ${name} v${head.version} kept: its snapshot was not deleted (${e instanceof Error ? e.message : String(e)})`);
          }
        }
      }
      return { manifest, version: sealed.version, road, previousDropped, builderKept };
    },


    async builderReach(builderId) {
      await ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      refuseUntouchable(entry);
      const reach = await refreshPreviewToken(entry.builder.machine, DAEMON_PORT, entry.reach);
      entry.reach = reach;
      const daemonToken = await daemonTokenOf(entry.builder.machine);
      return { url: reach.url, expiresAt: reach.expiresAt, ...(daemonToken !== undefined ? { daemonToken } : {}) };
    },

    async builders() {
      await ready();
      return [...builders.values()].map(b => builderView(b.record, b));
    },

    async kill(builderId) {
      await ready();
      await refreshBuilders();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      // A record its dead holder left mid-setup is stopped here as the sweep would stop it; only seal and reach need finished stages.
      if (entry.life === "foreign" || entry.life === "held") refuseUntouchable(entry);
      await killUntilGone(backend, entry.builder.machine, opts.killConfirm);
      await forgetBuilder(builderId);
    },

    async storage() {
      await ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      return snapshotStorage(await backend.listSnapshots(), backend.pricing.snapshotStorage, { hostId: templateHostId, recorded: await recordedImages(), now: clock.now() });
    },

    async orphans() {
      await ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      const read = { hostId: templateHostId, recorded: await recordedImages(), now: clock.now() };
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
      await ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      const manifest = (await store.get(GOLDENS, name ?? "default")) as GoldenManifest | undefined;
      if (manifest === undefined) return undefined;
      return retentionPlan(manifest, await backend.listSnapshots(), forkedFrom, backend.pricing.snapshotStorage);
    },

    async prune(name) {
      const key = name ?? "default";
      const plan = await golden.retention(key);
      const dropped: GoldenVersion[] = [];
      const failed: { version: number; message: string }[] = [];
      if (plan === undefined) return { dropped, failed };
      for (const v of plan.drop) {
        try {
          await dropImage(v);
        } catch (e) {
          // A snapshot the provider already lost is gone either way; its version goes with it.
          if (!isMissing(e)) {
            failed.push({ version: v.version, message: e instanceof Error ? e.message : String(e) });
            continue;
          }
        }
        const manifest = (await store.get(GOLDENS, key)) as GoldenManifest;
        await store.put(GOLDENS, key, { ...manifest, versions: manifest.versions.filter(x => x.version !== v.version) });
        await store.delete(GOLDEN_RECIPES, recipeKey(key, v.version));
        dropped.push(v);
      }
      return { dropped, failed };
    },

    async rollback(version, name) {
      const key = name ?? "default";
      const missing = (message: string) => Object.assign(new Error(message), { kind: "missing" });
      const prior = (await store.get(GOLDENS, key)) as GoldenManifest | undefined;
      if (!prior) throw missing(`no golden named "${key}"`);
      let next: GoldenManifest;
      try {
        next = rollbackGolden(prior, version);
      } catch (e) {
        throw missing(e instanceof Error ? e.message : String(e));
      }
      await store.put(GOLDENS, key, next);
      return next;
    },

    async promote(name) {
      await ready();
      const templates = templatesOf(backend);
      if (templates === undefined) return undefined;
      const key = name ?? "default";
      const manifest = (await store.get(GOLDENS, key)) as GoldenManifest | undefined;
      const rows: GoldenPromotion[] = [];
      for (const v of manifest?.versions ?? []) {
        if (v.templateId !== undefined) continue;
        try {
          const { templateId, sharing } = await promoteVersion(templates, v.snapshotId, goldenName(templateHostId, key, v.version));
          const current = (await store.get(GOLDENS, key)) as GoldenManifest | undefined;
          if (current === undefined) throw new Error(`golden ${key} was dropped while its versions were being promoted`);
          await store.put(GOLDENS, key, { ...current, versions: current.versions.map(x => (x.version === v.version ? { ...x, templateId } : x)) });
          rows.push({ golden: key, version: v.version, templateId, ...(sharing !== undefined ? { sharing } : {}) });
        } catch (e) {
          rows.push({ golden: key, version: v.version, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return rows;
    },

    async projects() {
      await ready();
      return ((await store.list(PROJECT_GOLDENS)) as ProjectGolden[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };

  const projects: Runtime["projects"] = {
    async import(o) {
      const entry = await entryOf(o.workspaceId);
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "import", entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      const began = clock.now();
      const report = (stage: ProjectImportStage, message: string, progress?: { bytes: number; total: number }): void => {
        bus.emit({ type: "project.import", workspaceId: o.workspaceId, source: o.source, dest: o.dest, stage, message, elapsedMs: clock.now() - began, ...progress });
      };
      try {
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
        const browsable = await entry.machine.exec(writeDaemonRootsScript([o.dest]), { timeoutMs: INLINE_EXEC_MS });
        if (browsable.exitCode !== 0) throw new Error(`could not make ${o.dest} browsable on the machine: ${browsable.stderr.slice(-200)}`);
        entry.record.project = { name: posix.basename(o.dest), dest: o.dest, importedAt: new Date(clock.now()).toISOString() };
        await persist(entry.record);
        report("done", `${plural(packed.files, "file")}, ${fmtBytes(packed.bytes)}, landed at ${o.dest}${parts > 1 ? ` in ${parts} parts` : ""}${agents.length > 0 ? `; sessions: ${outcomes()}` : ""}.`);
        return { dest: o.dest, files: packed.files, bytes: packed.bytes, parts, cut: packed.cut, rewritten: packed.rewritten, agents };
      } catch (e) {
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    async export(o) {
      const entry = await entryOf(o.workspaceId);
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "export", entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
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

  const status = createStatusTracker({
    store,
    records: async () => {
      await ready();
      return [...live.values()].filter(e => !e.creating).map(e => ({
        ...view(e.record),
        size: e.record.size,
        // The rate follows the machine's kind: a local workspace's backend prices it at zero, so no cost line rides its row.
        rateUsdPerHour: backendFor(e.record.kind).pricing.rateUsdPerHour(e.record.size),
        generation: e.generation,
        ...(e.record.phase === "running" && idle.idleAt(e.record.id) !== undefined ? { idleAt: idle.idleAt(e.record.id)! } : {}),
        ...(e.machine.previewUrl ? { daemonReach: () => e.ws.daemonReach() } : {}),
        providerState: () => e.machine.state(),
        ...(e.machine.metrics !== undefined ? { metrics: e.machine.metrics.bind(e.machine) } : {}),
        exec: (cmd, o) => e.machine.exec(cmd, o),
      }));
    },
    emit: e => bus.emit(e),
    on: (type, l) => bus.on(type, l),
    ...(opts.status !== undefined ? { defaults: opts.status } : {}),
    clock,
  });

  /** A workspace machine of this setup's that no record claims is recorded again, never killed: its record was lost
   * (a store the machine outlived), and it bills until a person can see and delete it. The row is confirmed with one
   * get(), so a row the listing lags on after a kill is skipped; a create in flight elsewhere is left its minute. A
   * row the provider would not confirm (a failed read, a state that is neither running nor paused) is claimed in
   * `known` all the same, so the engine spares it this sweep and the next one records it: a kill never rides on one read. */
  const adoptLost = async (listing: ListedMachine[], known: Set<string>, failed: ReapFailure[]): Promise<AdoptedMachine[]> => {
    const adopted: AdoptedMachine[] = [];
    const now = Date.now();
    for (const row of listing) {
      if (known.has(row.id) || !lostWorkspace(row, owner, now)) continue;
      let machine: Machine;
      try {
        machine = observed(await backend.get(row.id));
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
      // A stamped id another machine now holds is a body a rebuild or a wake replaced and failed to stop: the engine kills it.
      const stamped = row.labels[WORKSPACE_LABEL];
      if (stamped !== undefined && live.has(stamped)) continue;
      const id = stamped ?? `ws_${randomBytes(4).toString("hex")}`;
      // The name a person typed here outranks the one the fork stamped: the label is what the machine was forked
      // under, and no provider road updates it.
      const kept = stamped === undefined ? undefined : ((await store.get(WORKSPACE_NAMES, stamped)) as NamedWorkspace | undefined)?.name;
      const named = kept ?? row.labels[NAME_LABEL];
      const bornAt = row.labels[CREATED_AT_LABEL];
      const record: WorkspaceRecord = {
        id,
        name: named !== undefined && nameRefusal(named) === undefined ? named : row.id,
        kind: "cloud",
        machineId: row.id,
        phase: state === "paused" ? "napping" : "running",
        golden: row.labels[GOLDEN_LABEL] ?? goldenHead(await golden.get())?.snapshotId ?? "",
        createdAt: bornAt !== undefined && !Number.isNaN(Date.parse(bornAt)) ? bornAt : new Date().toISOString(),
        spec: { labels: row.labels },
        size: sizeBuilt(await shapeOf(machine), backend.pricing.defaultSize),
        firstLife: false,
        ...(machine.streamUrl !== undefined ? { screen: { streamUrl: machine.streamUrl } } : {}),
      };
      const entry = attach(record, machine);
      await persist(record);
      if (record.phase === "running") void syncDaemon(entry);
      bus.emit({ type: "workspace.created", workspace: view(record) });
      await emitStatus(entry, record.phase === "running" ? reachOf(entry) : "napping", RECORD_RESTORED);
      adopted.push({ id: row.id, workspaceId: id, name: record.name, phase: record.phase });
    }
    return adopted;
  };

  return {
    events: bus,
    backend,
    workspaces,
    projects,
    sessions: sessionsApi,
    harnesses: {
      list: async workspaceId => {
        // Only a harness with an adapter can run a turn; the rest of the table waits for one.
        const table = HARNESS_CATALOGS.filter(c => c.harness in adapters);
        if (workspaceId === undefined) return table.map(markDefault);
        const entry = await entryOf(workspaceId);
        if (entry.record.phase !== "running") return table.map(markDefault);
        return Promise.all(table.map(c => catalogOn(c, entry.machine, adapterFor(entry, c.harness).adapter).then(markDefault)));
      },
    },
    golden,
    status,
    owner: async () => {
      await ready();
      return owner;
    },
    reap: async olderThanMs => {
      await ready();
      await refreshBuilders();
      // A stale record can never seal; stopping it is the only thing that ends its bill. A reusable one no
      // process is using dies at six hours by our createdAt label, or at once when no age can be read: every
      // get(id) on it resets the provider's rolling idle timer (measured), so the kill it was created with
      // never fires while a host is up. Own builders get their heartbeat here, so other processes leave them be.
      const failed: ReapFailure[] = [];
      const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      const grace = await expireGrace().catch((e: unknown) => {
        failed.push({ message: `grace sweep: ${messageOf(e)}` });
        return { reaped: [], failed: [] };
      });
      const reaped: ReapedMachine[] = grace.reaped;
      failed.push(...grace.failed);
      const now = Date.now();
      for (const b of [...builders.values()]) {
        if (b.life === "own") await hold(b);
        const bornAt = Date.parse(b.builder.machine.labels?.[CREATED_AT_LABEL] ?? b.record.createdAt);
        const ageMs = Number.isNaN(bornAt) ? undefined : now - bornAt;
        const expired = b.life === "reusable" && (ageMs === undefined || ageMs >= BUILDER_IDLE_MS);
        if (b.life !== "stale" && !expired) continue;
        try {
          await b.builder.machine.kill();
        } catch (e) {
          if (!isMissing(e)) {
            failed.push({ id: b.record.id, message: `could not stop: ${messageOf(e)}; stays recorded, retried next sweep` });
            continue;
          }
        }
        await forgetBuilder(b.record.id);
        reaped.push(
          b.life === "stale"
            ? { id: b.record.id, builder: true, reason: b.record.building === true ? "unfinished" : "recorded" }
            : { id: b.record.id, builder: true, reason: "expired", ...(ageMs !== undefined ? { ageMs } : {}) },
        );
      }
      const knownIds = (): string[] => [...live.values()].flatMap(e => [e.record.machineId, e.machine.id]).concat([...builders.keys()], [...inflight], reaped.map(r => r.id));
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
        if (entry.creating || entry.napping || entry.waking || entry.deleting || entry.record.phase === "gone" || listed.has(entry.record.machineId)) continue;
        let answer: string | undefined;
        const read = await entry.machine.state().catch((e: unknown) => {
          if (!isMissing(e)) return undefined;
          answer = providerSaid(e);
          return "gone";
        });
        if (read === "gone") await adoptGone(entry, goneWords(entry.record.machineId, { by: "sweep", at: clock.now(), ...(answer !== undefined ? { answer } : {}) }));
      }
      const claimed = new Set(knownIds());
      const adopted = await adoptLost(listing, claimed, failed);
      try {
        return result(await reap({ backend, owner, listing, knownIds: () => [...knownIds(), ...claimed], ...(olderThanMs !== undefined ? { olderThanMs } : {}) }), adopted);
      } catch (e) {
        failed.push({ message: messageOf(e) });
        return result({ reaped: [], spared: [] }, adopted);
      }
    },
    close: async () => {
      idle.close();
      closed = true;
      beat?.();
      beat = undefined;
      for (const cancel of graceTimers.values()) cancel();
      graceTimers.clear();
      await ticking;
      // A clean exit frees its builders at once; a crash leaves the heartbeat to age and the pid to die.
      for (const b of [...builders.values()].filter(b => b.life === "own" && b.record.heldBy !== undefined)) {
        delete b.record.heldBy;
        await store.put(BUILDERS, b.record.id, b.record);
      }
      for (const id of [...transcriptTimers.keys()]) void flushTranscript(id);
      await Promise.all([...transcriptFlushes.values(), ...indexFlushes.values()]);
    },
  };
}
