import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { AdapterEvent, TurnResult } from "@wsp/adapter-claude";
import {
  BUILDER_IDLE_MS,
  DAEMON_PORT,
  NotFirstLifeError,
  OWNER_LABEL,
  Workspace,
  buildGolden,
  exportPaths,
  importInto,
  killUntilGone,
  prepareBuilder,
  reap,
  refreshPreviewToken,
  sealGolden,
  applyDelta,
  applyGoldenImport,
  upgradeBuilder,
  nextSetupSha,
  type Builder,
  type BuildGoldenOptions,
  type GoldenDelta,
  type GoldenImport,
  type ImportLedger,
  type SealResult,
  type ExecResult,
  type GoldenManifest,
  type GoldenVersion,
  type KillConfirm,
  type Machine,
  type MachineBackend,
  type MachineKind,
  type MachineShape,
  type MachineSpec,
  type PreviewReach,
  type ReapFailure,
  type ReapResult,
  type ReapedMachine,
  type RetentionPlan,
  type WspError,
  retentionPlan,
  rollback as rollbackGolden,
  snapshotStorage,
} from "@wsp/engine";
import type {
  DaemonReachView,
  EventUnion,
  GoldenBuilderView,
  GoldenLogin,
  GoldenStage,
  RecipeDigest,
  PortReachView,
  ReachState,
  SessionEvent,
  SessionInterruptResult,
  SessionView,
  SnapshotStorage,
  WorkspaceCreateStage,
  WorkspaceSize,
  WorkspaceView,
} from "@wsp/protocol";
import { ALREADY_APPLIED, sendRefusal, workspaceState } from "@wsp/protocol";
import { realClock, type Clock } from "./clock.js";
import { DEFAULT_IDLE_WINDOW_MS, backstopMs, createIdlePolicy, idleReason } from "./idle.js";
import { connectDaemon, type DaemonReach } from "./reach.js";
import { createStatusTracker, machineStateOf, type StatusApi, type StatusWatchOptions } from "./status.js";
import type { Store } from "./store.js";

// --- adapter port -------------------------------------------------------------

export interface HarnessAdapterContext {
  machine: Machine;
  workspaceId: string;
}

export interface HarnessStartOptions {
  prompt: string;
  resume?: string;
  cwd?: string;
  onEvent: (event: AdapterEvent) => void;
}

export interface HarnessSession {
  readonly localId: string;
  readonly claudeSessionId: string;
  readonly finished: Promise<TurnResult>;
  /** Stops the process this session owns; finished settles after it, once session.end has been emitted. */
  interrupt(): Promise<void>;
}

export interface HarnessAdapter {
  start(options: HarnessStartOptions): HarnessSession;
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

interface WorkspaceRecord extends WorkspaceView {
  spec: Pick<WorkspaceSpec, "envs" | "labels">;
  idleWindowMs?: number | null;
  /** What the provider built, read back after every create (it may clamp the
   * request); the rail and the rate use this, never what was asked for. */
  size: WorkspaceSize;
  firstLife: boolean;
  /** The provider's view of the current machine when it was created; a wake compares against it. */
  shape?: MachineShape;
}

interface LiveWorkspace {
  record: WorkspaceRecord;
  ws: Workspace;
  machine: Machine;
  /** The wake in flight, so a second caller joins it instead of resuming twice. */
  waking?: Promise<WorkspaceView>;
  /** The nap in flight: a second nap joins it, a wake waits for it. */
  napping?: Promise<WorkspaceView>;
  /** Set from the fork until the create is ready: the sweep knows the machine, nothing else can reach it yet. */
  creating?: true;
}

/** Reports one create stage as it is reached; the runtime stamps id, name and elapsed time. */
type StageReport = (stage: WorkspaceCreateStage, message: string, notice?: string) => void;

export interface SessionHandle {
  readonly id: string;
  readonly workspaceId: string;
  readonly finished: Promise<TurnResult>;
  view(): SessionView;
  interrupt(): Promise<void>;
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

export interface RuntimeOptions {
  backend: MachineBackend;
  store: Store;
  adapters: Record<string, HarnessAdapterFactory>;
  /** Required for golden.prepare / golden.seal; the scripted golden.build carries its own. */
  goldenRecipe?: GoldenRecipe;
  /**
   * Explicit guest paths carried across an upgrade. Default: everything under
   * /root except golden-provided dirs (VAULT_SKIP), enumerated at export time.
   */
  vaultPaths?: string[];
  /** Defaults for the status poller / cost ticker (tests shrink the intervals). */
  status?: StatusWatchOptions;
  idle?: { defaultWindowMs?: number };
  /** Drives the idle window and the transcript debounce; tests inject one they advance by hand. */
  clock?: Clock;
  /** How long a seal waits for a killed machine to read gone (tests shrink it). */
  killConfirm?: KillConfirm;
  /** Names this machine and install on the holds it writes, so two machines over one state file never mistake
   * each other's. The entry points pass hostIdentity(); the bare hostname when absent, which touches no disk. */
  hostId?: string;
  wake?: WakeOptions;
}

export interface WakeOptions {
  /** How long a resumed guest's daemon gets to answer through the edge before the wake counts as failed. */
  pingTimeoutMs?: number;
  /** A nap-time vault archive over this is not stored (a warning names the size). */
  vaultCapBytes?: number;
}

const WAKE_PING_TIMEOUT_MS = 30_000;
const VAULT_CAP_BYTES = 200 * 1024 * 1024;
/** Blob collection: the latest nap-time vault per workspace id. */
const VAULTS = "vaults";

/** Rejects once the deadline passes; the underlying promise is left to settle on its own. */
function until<T>(p: Promise<T>, deadline: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ms = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
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

export interface GoldenBuildRequest extends Omit<BuildGoldenOptions, "backend" | "manifest"> {
  /** Store key; several goldens can coexist. */
  name?: string;
}

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

export interface Runtime {
  readonly events: EventBus;
  readonly backend: MachineBackend;
  readonly workspaces: {
    create(opts: CreateWorkspaceOptions): Promise<CreatedWorkspace>;
    get(id: string): Promise<WorkspaceView>;
    list(): Promise<WorkspaceView[]>;
    nap(id: string): Promise<WorkspaceView>;
    wake(id: string): Promise<WorkspaceView>;
    upgrade(id: string, spec?: WorkspaceSpec): Promise<WorkspaceView>;
    /** Fresh golden fork with the nap-time vault, old machine killed, id and name kept: the way out of a zombie. */
    rebuild(id: string): Promise<WorkspaceView>;
    delete(id: string): Promise<void>;
    /** A person acted in the workspace; its idle window starts over. */
    touch(id: string): Promise<void>;
    /** One-shot command on the workspace's machine (plumbing for clients; sessions are the main road). */
    exec(id: string, cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
    /** How a browser dials this workspace's daemon; throws on backends without preview URLs. */
    daemonReach(id: string): Promise<DaemonReachView>;
    /** The public route to one guest port, for a browser to frame; same caching and refusal as daemonReach. */
    portReach(id: string, port: number): Promise<PortReachView>;
  };
  readonly sessions: {
    start(
      workspaceId: string,
      opts: { prompt: string; harness?: string; resume?: string; cwd?: string },
    ): Promise<SessionHandle>;
    list(workspaceId?: string): SessionView[];
    /** The workspace's persisted session events, oldest first; a chat replays these on mount. */
    history(workspaceId: string): Promise<SessionEvent[]>;
    /** Stops the session's running turn through its harness; a turn already over or an unknown id answers, never throws. */
    interrupt(sessionId: string): Promise<SessionInterruptResult>;
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
     * successful seal so one more change re-snapshots it; any other builder, and every failed or refused seal, consumes it.
     * logins: what each sign-in asked of the builder came to, stamped on the version. */
    seal(builderId: string, opts?: { logins?: GoldenLogin[] }): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
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
    /** Every snapshot on the account by count, size and monthly cost past the free GB, sized from the provider's
     * listing; undefined on a backend that cannot list snapshots. */
    storage(): Promise<SnapshotStorage | undefined>;
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
  /** Kills what this state file owns and nothing claims, plus orphans past their backstop; lists the running machines it left alone. */
  reap(olderThanMs?: number): Promise<ReapResult>;
  /** Writes every transcript still waiting on its debounce; the store is complete once this resolves. */
  close(): Promise<void>;
}

const WORKSPACES = "workspaces";
const GOLDENS = "goldens";
/** The recipe each sealed version was built from, keyed `<name>@v<version>`; the next update diffs against the head's. */
const GOLDEN_RECIPES = "golden-recipes";
const recipeKey = (name: string, version: number): string => `${name}@v${version}`;
const TRANSCRIPTS = "transcripts";

/** What the timeline shows as the last row of a turn the runtime ended, not the harness. */
const PAUSED_REASON = "machine paused while the agent was working";
const DELETED_REASON = "machine deleted while the agent was working";
const UNANSWERING_REASON = "machine stopped answering while the agent was working";
/** Mirrors @wsp/daemon's DEFAULT_TOKEN_PATH; the runtime cannot import the daemon package (it only runs inside guests). */
const DAEMON_TOKEN_PATH = "/root/.wsp-daemon-token";
/** A guest with no token file is asked again after this long (a daemon may be deployed later). */
const DAEMON_TOKEN_MISS_TTL_MS = 60_000;
/** Events kept per workspace; the oldest fall off so one chatty workspace cannot grow the store forever. */
const TRANSCRIPT_CAP = 5000;
/** A turn boundary waits this long for more before the transcript is written; measured at one put per
 * event, 5000 events cost 4 s of memory-store clones and 6.6 s of file rewrites after the last turn. */
export const TRANSCRIPT_FLUSH_MS = 250;

interface TranscriptRecord {
  workspaceId: string;
  events: SessionEvent[];
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
  const { createdAt, ...stamped } = labels ?? {};
  void idempotencyKey;
  void createdAt;
  return createHash("sha256").update(JSON.stringify({ ...rest, labels: stamped })).digest("hex");
}
/** A holder's heartbeat older than this, or a holder whose pid is gone, no longer keeps a builder from another process. */
const HELD_TTL_MS = 15 * 60_000;
/** Own builders beat this often on their own timer, so a sweep stuck on a slow listing cannot starve the hold. */
const HEARTBEAT_MS = 5 * 60_000;

const isCapRefusal = (e: unknown): boolean => (e as { kind?: unknown }).kind === "concurrency";

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

export function createRuntime(opts: RuntimeOptions): Runtime {
  const { backend, store, adapters } = opts;
  const bus = eventBus();
  const pingTimeoutMs = opts.wake?.pingTimeoutMs ?? WAKE_PING_TIMEOUT_MS;
  const vaultCapBytes = opts.wake?.vaultCapBytes ?? VAULT_CAP_BYTES;
  const defaultIdleWindowMs = opts.idle?.defaultWindowMs ?? DEFAULT_IDLE_WINDOW_MS;
  const hostId = opts.hostId ?? hostname();
  const clock = opts.clock ?? realClock;

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
  const live = new Map<string, LiveWorkspace>();
  const builders = new Map<string, LiveBuilder>();
  /** The prepare in flight per golden name; a second call for the same recipe joins it instead of running the stages twice on one machine. */
  const preparing = new Map<string, { hash: string | undefined; promise: Promise<GoldenBuilderView> }>();
  const sessions = new Map<string, { view: SessionView; handle: SessionHandle; end: (reason: string) => void }>();
  const transcripts = new Map<string, SessionEvent[]>();
  // Puts are chained per workspace so the later snapshot always lands last,
  // whatever order the store finishes in.
  const transcriptFlushes = new Map<string, Promise<void>>();
  const transcriptTimers = new Map<string, () => void>();
  // Keyed by machine id: a resurrect or upgrade brings a fresh guest and file.
  const daemonTokens = new Map<string, { token: string | undefined; readAt: number }>();
  const daemonTokenOf = async (machine: Machine): Promise<string | undefined> => {
    const cached = daemonTokens.get(machine.id);
    if (cached && (cached.token !== undefined || Date.now() - cached.readAt < DAEMON_TOKEN_MISS_TTL_MS)) return cached.token;
    const res = await machine.exec(`cat ${DAEMON_TOKEN_PATH}`);
    const token = res.exitCode === 0 && res.stdout.trim() !== "" ? res.stdout.trim() : undefined;
    daemonTokens.set(machine.id, { token, readAt: Date.now() });
    return token;
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
   * changes a value, so it runs at most once per transcript. A new thread leaves the old events as they were. */
  const threadOf = (workspaceId: string, resume: string | undefined): string => {
    const events = transcripts.get(workspaceId) ?? [];
    if (resume !== undefined) {
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

  const view = (r: WorkspaceRecord): WorkspaceView => ({
    id: r.id,
    name: r.name,
    machineId: r.machineId,
    phase: r.phase,
    golden: r.golden,
    createdAt: r.createdAt,
    ...(r.claudeSessionId !== undefined ? { claudeSessionId: r.claudeSessionId } : {}),
    ...(r.screen !== undefined ? { screen: r.screen } : {}),
  });

  const persist = async (r: WorkspaceRecord): Promise<void> => {
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

  /** The sealed version behind this snapshot, if any manifest knows it. */
  const goldenVersionOf = async (snapshotId: string): Promise<GoldenVersion | undefined> => {
    for (const raw of await store.list(GOLDENS)) {
      const hit = (raw as GoldenManifest).versions.find(v => v.snapshotId === snapshotId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  /** A status pushed outside the poll, for a phase change the poller would show
   * late. Machine state is what the phase implies: asking the provider here
   * would reset its idle timer for a fact the runtime already knows. */
  const emitStatus = async (entry: LiveWorkspace, reach: ReachState, reason?: string): Promise<void> => {
    const size = entry.record.size;
    bus.emit({
      type: "workspace.status",
      status: {
        ...view(entry.record),
        machineState: machineStateOf(entry.record.phase),
        reach: { state: reach },
        size,
        rateUsdPerHour: backend.pricing.rateUsdPerHour(size),
        ...(reason !== undefined ? { reason } : {}),
      },
    });
  };

  /** The daemon answering through the edge is what proves a resumed guest
   * serves; resume() returning does not (a zombie reports running for 10+
   * minutes while exec and the edge 502). Backends without preview routes
   * have no edge to ask, so the check falls back to the shape comparison. */
  const pingDaemon = async (entry: LiveWorkspace): Promise<string | undefined> => {
    const machine = entry.machine;
    if (!machine.previewUrl) return undefined;
    const deadline = Date.now() + pingTimeoutMs;
    let link: DaemonReach | undefined;
    try {
      const reach = await until(entry.ws.daemonReach(), deadline, "preview route");
      const token = await until(daemonTokenOf(machine), deadline, "daemon token");
      if (token === undefined) {
        // No daemon to ask; an exec that returns is the guest's own answer.
        await until(machine.exec("true"), deadline, "guest exec");
        return undefined;
      }
      link = connectDaemon({ previewUrl: reach.url, token, onEvent: () => {}, heartbeatMs: pingTimeoutMs });
      await until(link.ready, deadline, "daemon link");
      await until(link.request("ping"), deadline, "daemon ping");
      return undefined;
    } catch (e) {
      return `daemon on ${machine.id} did not answer within ${pingTimeoutMs} ms (${e instanceof Error ? e.message : String(e)})`;
    } finally {
      link?.close();
    }
  };

  /** Size is always explicit: a create that names none gets the provider's own
   * default (2048 MB on Solari), not the size the record and the rate assume. */
  const forkSpec = (r: WorkspaceRecord, kind: MachineKind, override?: WorkspaceSpec): MachineSpec & WorkspaceSize => ({
    kind,
    fromSnapshot: r.golden,
    cpu: override?.cpu ?? r.size.cpu,
    memMb: override?.memMb ?? r.size.memMb,
    ...(r.spec.envs !== undefined || override?.envs !== undefined
      ? { envs: { ...r.spec.envs, ...override?.envs } }
      : {}),
    labels: { ...r.spec.labels, wsp: "1", [OWNER_LABEL]: owner, createdAt: new Date().toISOString() },
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
        ...(spec.labels?.["createdAt"] !== undefined ? { labels: { ...spec.labels, createdAt: attempt.createdAt } } : {}),
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
    const exec = async (cmd: string, o?: { timeoutMs?: number }): Promise<ExecResult> => {
      const t0 = Date.now();
      try {
        const res = await machine.exec(cmd, o);
        report({ machineId: machine.id, cmd, ms: Date.now() - t0, ...res });
        return res;
      } catch (e) {
        report({ machineId: machine.id, cmd, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };
    return new Proxy(machine, {
      get(target, prop) {
        if (prop === "exec") return exec;
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
      const spec = forkSpec(record, (await goldenVersionOf(record.golden))?.kind ?? "sandbox", override);
      const machine = await b.create(spec);
      // Named by its record before the claim is released, so no sweep sees it unclaimed.
      bind(machine);
      report?.("machine-booting", `Machine ${machine.id} is booting.`);
      const named = await setHostname(machine, record.name);
      report?.("hostname-set", named.refused === undefined ? `Hostname set to ${named.host}.` : "Hostname left as the guest booted it.", named.refused);
      const shape = await shapeOf(machine);
      if (shape !== undefined) record.shape = shape;
      else delete record.shape;
      record.size = sizeBuilt(shape, spec);
      if (machine.streamUrl !== undefined) record.screen = { streamUrl: machine.streamUrl };
      else delete record.screen;
      return machine;
    });

  const attach = (record: WorkspaceRecord, machine: Machine): LiveWorkspace => {
    const entry: LiveWorkspace = { record, machine, ws: undefined as unknown as Workspace };
    entry.ws = new Workspace(
      machine,
      {
        goldenSnapshot: record.golden,
        resurrect: (override?: Partial<MachineSpec>) =>
          fork(record, m => {
            entry.machine = m;
          }, override),
        vaultExport: async m => exportPaths(m, await vaultPathsOf(m)),
        vaultImport: async (m, payload) => {
          await importInto(m, payload, "/");
        },
        stashVault: async m => {
          try {
            const payload = await exportPaths(m, await vaultPathsOf(m), { maxBytes: vaultCapBytes });
            await store.putBlob(VAULTS, record.id, payload);
          } catch (e) {
            console.warn(`nap vault for ${record.id} not stored, previous kept: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
        restoreVault: async m => {
          const payload = await store.getBlob(VAULTS, record.id);
          if (payload !== undefined) await importInto(m, payload, "/");
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
      { phase: record.phase === "pausing" ? "napping" : record.phase, firstLife: record.firstLife },
    );
    live.set(record.id, entry);
    return entry;
  };

  const idleWindowOf = (r: WorkspaceRecord): number | null => (r.idleWindowMs === undefined ? defaultIdleWindowMs : r.idleWindowMs);

  /** Every live session of a workspace ends here when its machine goes away under it; the harness's own end, if it ever comes, is dropped. */
  const endSessions = (workspaceId: string, reason: string): void => {
    for (const s of sessions.values()) if (s.view.workspaceId === workspaceId) s.end(reason);
  };

  // Pausing is persisted and pushed before the provider is asked, so a list
  // fetched mid-pause never says running, and the sessions end while the
  // machine can still be told to stop them.
  const napWith = async (id: string, reason?: string): Promise<WorkspaceView> => {
    const entry = await entryOf(id);
    if (entry.napping) return entry.napping;
    if (entry.record.phase !== "running") return view(entry.record);
    entry.napping = (async () => {
      try {
        entry.record.phase = "pausing";
        await persist(entry.record);
        await emitStatus(entry, "napping");
        try {
          await entry.ws.nap();
        } catch (e) {
          entry.record.phase = entry.ws.currentPhase;
          await persist(entry.record);
          await emitStatus(entry, entry.machine.previewUrl ? "reachable" : "unsupported", e instanceof Error ? e.message : String(e));
          throw e;
        }
        // The reason says the machine paused, so it is written once the provider has confirmed that.
        endSessions(id, PAUSED_REASON);
        entry.record.phase = "napping";
        await persist(entry.record);
        bus.emit({ type: "workspace.napped", workspaceId: id });
        await emitStatus(entry, "napping", reason);
        return view(entry.record);
      } finally {
        delete entry.napping;
      }
    })();
    return entry.napping;
  };

  /** The provider paused the machine outside a nap (its idle timer, a console click): the record follows the fact, so a wake resumes it the normal way. */
  const adoptPause = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.phase !== "running" || entry.napping || entry.waking) return;
    entry.ws.notePaused();
    entry.record.phase = "napping";
    await persist(entry.record);
    endSessions(entry.record.id, PAUSED_REASON);
    bus.emit({ type: "workspace.napped", workspaceId: entry.record.id });
    await emitStatus(entry, "napping", "paused outside wsp");
  };
  bus.on("workspace.status", e => {
    if (e.type !== "workspace.status") return;
    if (e.status.reach.state === "zombie") endSessions(e.status.id, UNANSWERING_REASON);
    const entry = live.get(e.status.id);
    if (entry !== undefined && e.status.phase === "running" && e.status.machineState === "paused") void adoptPause(entry);
  });

  const idle = createIdlePolicy({
    windowOf: id => {
      const entry = live.get(id);
      return entry === undefined ? null : idleWindowOf(entry.record);
    },
    onIdle: async (id, windowMs) => {
      await napWith(id, idleReason(windowMs));
    },
    clock,
  });
  // Every road into a workspace the runtime can see starts its window over;
  // typing over the browser's daemon link arrives as workspaces.touch.
  for (const type of ["session.start", "session.delta", "session.done", "session.end", "inbox.file", "workspace.woken", "workspace.upgraded"] as const) {
    bus.on(type, e => idle.touch((e as { workspaceId: string }).workspaceId));
  }
  bus.on("workspace.created", e => e.type === "workspace.created" && idle.touch(e.workspace.id));
  for (const type of ["workspace.napped", "workspace.deleted"] as const) {
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
    },
    life: lifeOf(record, machine, record.firstLife),
  });
  /** A stored record this process has no entry for yet; its machine is fetched once, here. */
  const admit = async (stored: StoredBuilder): Promise<void> => {
    const machine = await backend.get(stored.id).then(observed, (e: unknown) => {
      if ((e as { kind?: string }).kind === "missing") return undefined;
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
        const stored = raw as Omit<WorkspaceRecord, "size"> & { size?: WorkspaceSize };
        const machine = await backend.get(stored.machineId).catch((e: unknown) => {
          if ((e as { kind?: string }).kind === "missing") return deadMachine(stored.machineId);
          throw e;
        });
        // A record left at pausing died mid-pause: whether or not the provider got the call, a wake resumes it either way.
        const phase = stored.phase === "pausing" ? "napping" : stored.phase;
        attach(
          {
            ...stored,
            phase,
            size: stored.size ?? sizeBuilt(await shapeOf(machine), backend.pricing.defaultSize),
            ...(machine.streamUrl !== undefined ? { screen: { streamUrl: machine.streamUrl } } : {}),
          },
          machine,
        );
        if (phase === "running") idle.touch(stored.id);
      }
      for (const raw of await store.list(TRANSCRIPTS)) {
        const t = raw as TranscriptRecord;
        transcripts.set(t.workspaceId, t.events);
      }
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
    const inherited = (await goldenVersionOf(o.golden))?.size;
    const record: WorkspaceRecord = {
      id,
      name: o.name,
      machineId: "",
      phase: "running",
      golden: o.golden,
      createdAt: new Date().toISOString(),
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
      // stopped and the fork tried again, the next one only on the next refusal; a refusal with none left to
      // stop is the caller's to show. A held or foreign builder is never touched.
      if (!isCapRefusal(e)) throw e;
      let refusal: unknown = e;
      let made = false;
      await refreshBuilders();
      for (const x of [...builders.values()].filter(x => (x.life === "own" || x.life === "reusable") && x.record.sealed !== undefined)) {
        const stopped = `Stopped the builder kept from golden v${x.record.sealed!.version} (${x.record.id}) to make room at the machine cap.`;
        graceTimers.get(x.record.id)?.();
        graceTimers.delete(x.record.id);
        await killUntilGone(backend, x.builder.machine, opts.killConfirm);
        await forgetBuilder(x.record.id);
        notices.push(stopped);
        console.warn(`workspace ${record.id}: ${stopped.charAt(0).toLowerCase()}${stopped.slice(1, -1)}`);
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
      if (!made) throw refusal;
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
    }
    await persist(record);
    delete entry.creating;
    report("ready", "Ready.");
    const v = view(record);
    bus.emit({ type: "workspace.created", workspace: v });
    return notices.length > 0 ? { ...v, notice: notices.join(" ") } : v;
  };

  const workspaces: Runtime["workspaces"] = {
    async create(o) {
      await ready();
      const id = `ws_${randomBytes(4).toString("hex")}`;
      const began = clock.now();
      const report: StageReport = (stage, message, notice) => {
        bus.emit({ type: "workspace.creating", workspaceId: id, name: o.name, stage, message, elapsedMs: clock.now() - began, ...(notice !== undefined ? { notice } : {}) });
      };
      try {
        return await createStaged(o, id, report);
      } catch (e) {
        // A machine already forked goes with the failed create; the retry forks a fresh one.
        const entry = live.get(id);
        if (entry !== undefined) {
          live.delete(id);
          await entry.machine.kill().catch(() => {});
        }
        // The id dies with a failed create, so nothing could ever retry under its key.
        await store.delete(CREATES, `workspace/${id}`);
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },

    async get(id) {
      return view((await entryOf(id)).record);
    },

    async list() {
      await ready();
      return [...live.values()].filter(e => !e.creating).map(e => view(e.record));
    },

    async nap(id) {
      return napWith(id);
    },

    async wake(id) {
      const entry = await entryOf(id);
      if (entry.waking) return entry.waking;
      if (entry.napping) await entry.napping.catch(() => {});
      // A wake nobody should need is the one sign the provider paused the machine on its own: one read settles it.
      if (entry.record.phase === "running" && (await entry.machine.state().catch(() => "running")) === "paused") await adoptPause(entry);
      if (entry.record.phase === "running") return view(entry.record);
      entry.waking = (async () => {
        entry.record.phase = "waking";
        await persist(entry.record);
        await emitStatus(entry, "napping");
        try {
          const result = await entry.ws.wake();
          entry.record.phase = "running";
          entry.record.machineId = entry.ws.machineId;
          entry.record.firstLife = entry.ws.isFirstLife;
          await persist(entry.record);
          bus.emit({ type: "workspace.woken", workspaceId: id, machineId: entry.record.machineId, resurrected: result.resurrected });
          if (result.reason !== undefined) console.warn(`wake of ${id}: ${result.reason}`);
          await emitStatus(entry, entry.machine.previewUrl ? "reachable" : "unsupported", result.reason);
          return view(entry.record);
        } catch (e) {
          entry.record.phase = entry.ws.currentPhase;
          await persist(entry.record);
          await emitStatus(entry, "napping", e instanceof Error ? e.message : String(e));
          throw e;
        } finally {
          delete entry.waking;
        }
      })();
      return entry.waking;
    },

    async upgrade(id, spec) {
      const entry = await entryOf(id);
      await entry.ws.upgrade(spec);
      entry.record.machineId = entry.ws.machineId;
      entry.record.phase = "running";
      entry.record.firstLife = entry.ws.isFirstLife;
      entry.record.spec = {
        ...entry.record.spec,
        ...(spec?.envs !== undefined ? { envs: spec.envs } : {}),
        ...(spec?.labels !== undefined ? { labels: spec.labels } : {}),
      };
      await persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      return view(entry.record);
    },

    async rebuild(id) {
      const entry = await entryOf(id);
      if (entry.waking) await entry.waking.catch(() => {});
      const old = entry.record.machineId;
      const vaulted = (await store.getBlob(VAULTS, id)) !== undefined;
      await entry.ws.rebuild();
      entry.record.machineId = entry.ws.machineId;
      entry.record.phase = "running";
      entry.record.firstLife = true;
      await persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      const reason = `rebuilt: ${old} replaced by ${entry.record.machineId}, ${vaulted ? "nap-time vault imported" : "no vault to import"}`;
      console.warn(`rebuild of ${id}: ${reason}`);
      await emitStatus(entry, entry.machine.previewUrl ? "reachable" : "unsupported", reason);
      return view(entry.record);
    },

    async delete(id) {
      const entry = await entryOf(id);
      endSessions(id, DELETED_REASON);
      await entry.machine.kill().catch((e: unknown) => {
        if ((e as { kind?: string }).kind !== "missing") throw e;
      });
      live.delete(id);
      transcripts.delete(id);
      cancelFlush(id);
      await transcriptFlushes.get(id);
      transcriptFlushes.delete(id);
      await store.delete(WORKSPACES, id);
      await store.delete(TRANSCRIPTS, id);
      await store.delete(CREATES, `workspace/${id}`);
      await store.deleteBlob(VAULTS, id);
      bus.emit({ type: "workspace.deleted", workspaceId: id });
    },

    async touch(id) {
      await entryOf(id);
      idle.touch(id);
    },

    async exec(id, cmd, o) {
      const entry = await entryOf(id);
      return entry.machine.exec(cmd, o);
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
  };

  const sessionsApi: Runtime["sessions"] = {
    async start(workspaceId, o) {
      const entry = await entryOf(workspaceId);
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }));
      if (refusal !== null) throw new Error(refusal);
      const harness = o.harness ?? "claude";
      const factory = adapters[harness];
      if (!factory) throw new Error(`no adapter registered for harness "${harness}"`);
      const adapter = factory({ machine: entry.machine, workspaceId });

      // Created before adapter.start so events that fire synchronously during
      // start() still land on the view.
      const sessionView: SessionView = {
        id: "",
        workspaceId,
        harness,
        status: "running",
        prompt: o.prompt,
        startedAt: Date.now(),
        ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
      };
      const turnId = randomUUID();
      const threadId = threadOf(workspaceId, o.resume);
      let ended = false;

      const forward = (event: AdapterEvent): void => {
        if (ended) return;
        const sessionId = event.sessionId;
        switch (event.type) {
          case "session.start": {
            sessionView.claudeSessionId = sessionId;
            if (event.cwd !== undefined) sessionView.cwd = event.cwd;
            entry.record.claudeSessionId = sessionId;
            void persist(entry.record);
            record({
              type: "session.start",
              workspaceId,
              sessionId,
              turnId,
              threadId,
              prompt: o.prompt,
              ...(event.model !== undefined ? { model: event.model } : {}),
              ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
              ...(event.tools !== undefined ? { tools: event.tools } : {}),
              ...(event.harness !== undefined ? { harness: event.harness } : {}),
            });
            return;
          }
          case "turn.delta":
            record({
              type: "session.delta",
              workspaceId,
              sessionId,
              turnId,
              threadId,
              kind: event.kind,
              text: event.text,
              ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
              ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
              ...(event.isError !== undefined ? { isError: event.isError } : {}),
            });
            return;
          case "turn.done":
            sessionView.status = event.result.status;
            record({ type: "session.done", workspaceId, sessionId, turnId, threadId, result: event.result });
            return;
          case "session.end":
            sessionView.endedAt = Date.now();
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
        started = adapter.start({
          prompt: o.prompt,
          ...(o.resume !== undefined ? { resume: o.resume } : {}),
          ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
          onEvent: forward,
        });
      } catch (e) {
        idle.release(workspaceId);
        throw e;
      }
      started.finished.then(
        () => idle.release(workspaceId),
        () => idle.release(workspaceId),
      );
      const handleId = started.localId;
      sessionView.id = handleId;
      sessionView.claudeSessionId ??= started.claudeSessionId;

      const handle: SessionHandle = {
        id: handleId,
        workspaceId,
        finished: started.finished,
        view: () => ({ ...sessionView }),
        interrupt: () => started.interrupt(),
      };
      const end = (reason: string): void => {
        if (ended || sessionView.status !== "running") return;
        ended = true;
        sessionView.status = "failed";
        sessionView.endedAt = Date.now();
        record({ type: "session.end", workspaceId, sessionId: sessionView.claudeSessionId ?? handleId, turnId, threadId, exitCode: null, sawResult: false, reason });
        void started.interrupt().catch(() => {});
      };
      sessions.set(handleId, { view: sessionView, handle, end });
      started.finished
        .then(result => {
          if (!ended) sessionView.status = result.status;
          sessionView.endedAt ??= Date.now();
        })
        .catch(() => {
          if (!ended) sessionView.status = "failed";
          sessionView.endedAt ??= Date.now();
        });
      return handle;
    },

    list(workspaceId) {
      const all = [...sessions.values()].map(s => ({ ...s.view }));
      return workspaceId === undefined ? all : all.filter(s => s.workspaceId === workspaceId);
    },

    async history(workspaceId) {
      await entryOf(workspaceId);
      return (transcripts.get(workspaceId) ?? []).map(e => ({ ...e }));
    },

    async interrupt(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      if (s.view.status !== "running") return { outcome: "not-running" };
      await s.handle.interrupt();
      // The harness resolves finished only after session.end, so accepted means the turn is over on the transcript too.
      await s.handle.finished.catch(() => {});
      return { outcome: "accepted" };
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
        if ((e as { kind?: string }).kind !== "missing") {
          failed.push({ id: b.record.id, message: `${e instanceof Error ? e.message : String(e)}; stays recorded, retried next sweep` });
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

  const stageOf = (name: string) => (stage: GoldenStage, detail?: string) =>
    bus.emit({ type: "golden.stage", name, stage, ...(detail !== undefined ? { detail } : {}) });

  const recipeOrThrow = (): GoldenRecipe => {
    if (!opts.goldenRecipe) throw new Error("this runtime has no golden recipe; the host wires one (setup + smoke) before the wizard can run");
    return opts.goldenRecipe;
  };

  const builderLabels = (extra: Record<string, string> | undefined): Record<string, string> => ({ ...extra, wsp: "1", "wsp-builder": "1", [OWNER_LABEL]: owner, createdAt: new Date().toISOString() });

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
          createdAt: spec.labels?.["createdAt"] ?? new Date().toISOString(),
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
      createdAt: builder.createdAt,
      size: builder.size,
      firstLife: true,
      ...(builder.machine.streamUrl !== undefined ? { streamUrl: builder.machine.streamUrl } : {}),
      ...(builder.import !== undefined ? { import: builder.import } : {}),
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
          labels: { ...recipe.labels, wsp: "1", "wsp-smoke": "1", [OWNER_LABEL]: owner, createdAt: new Date().toISOString() },
          ...(prior !== undefined ? { manifest: prior } : {}),
          onStage: stageOf(name),
          ...(opts.killConfirm !== undefined ? { killConfirm: opts.killConfirm } : {}),
          ...(logins !== undefined ? { logins } : {}),
          keepBuilder: keep,
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
      // sealGolden consumes the builder on every road but a refusal; a refused
      // builder can never seal and under a two-machine cap must not outlive it.
      if (e instanceof NotFirstLifeError) await killUntilGone(backend, entry.builder.machine, opts.killConfirm);
      await forgetBuilder(entry.record.id);
      throw e;
    }
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
          labels: { ...build.labels, wsp: "1", [OWNER_LABEL]: owner, createdAt: new Date().toISOString() },
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
      return sealEntry(entry, entry.record.import?.recipe !== undefined, o?.logins);
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
      const head = prior?.versions.find(v => v.version === prior.head);
      if (prior === undefined || head === undefined) throw new Error(`no golden named "${name}" to update; wsp init builds one`);
      const stage = stageOf(name);
      // Past its window a kept builder is never used, running or not: it is stopped here and the update forks; one
      // the pass could not stop is named so the person knows it still bills. Inside the window, it is suspended for
      // the update's length: the record loses `sealed` and gains `building` before the first exec, so neither the
      // timer nor a sweep stops the machine mid-stage, and a process that dies here leaves a record the next one
      // stops as unfinished; the seal re-arms the window.
      const swept = await expireGrace();
      for (const f of swept.failed) stage("creating", `an earlier kept builder ${f.id} was not stopped (${f.message})`);
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
            const applied = await applyDelta(kept.builder.machine, o.delta, { setup: recipe.setup, previousSmoke: head.smoke.cmd, onStage: stage });
            const setupSha = nextSetupSha(head.setupSha, recipe.setup, o.delta.import);
            kept.record.import = applied.ledger;
            kept.record.setupSha = setupSha;
            delete kept.record.building;
            // The builder was sealed as the head, so the version it seals next descends from the head's snapshot.
            kept.builder = { ...kept.builder, import: applied.ledger, setupSha, parentSnapshotId: head.snapshotId };
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
      if (o.keepPrevious === false) {
        // A snapshot with live forks under it cannot be deleted (409 on Solari): the builder forked from it goes
        // first, window or not; a version with workspaces still on it stays for them.
        if (road === "fork" && builderKept) {
          graceTimers.get(entry.record.id)?.();
          graceTimers.delete(entry.record.id);
          await killUntilGone(backend, entry.builder.machine, opts.killConfirm);
          await forgetBuilder(entry.record.id);
          builderKept = false;
        }
        try {
          await backend.deleteSnapshot(head.snapshotId);
          manifest = { ...manifest, versions: manifest.versions.filter(v => v.version !== head.version) };
          await store.put(GOLDENS, name, manifest);
          await store.delete(GOLDEN_RECIPES, recipeKey(name, head.version));
          previousDropped = true;
        } catch (e) {
          console.warn(`golden ${name} v${head.version} kept: its snapshot was not deleted (${e instanceof Error ? e.message : String(e)})`);
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
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      return snapshotStorage(await backend.listSnapshots(), backend.pricing.snapshotStorage);
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
          await backend.deleteSnapshot(v.snapshotId);
        } catch (e) {
          // A snapshot the provider already lost is gone either way; its version goes with it.
          if ((e as { kind?: string }).kind !== "missing") {
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
  };

  const status = createStatusTracker({
    rateUsdPerHour: size => backend.pricing.rateUsdPerHour(size),
    records: async () => {
      await ready();
      return [...live.values()].filter(e => !e.creating).map(e => ({
        ...view(e.record),
        size: e.record.size,
        ...(e.record.phase === "running" && idle.idleAt(e.record.id) !== undefined ? { idleAt: idle.idleAt(e.record.id)! } : {}),
        ...(e.machine.previewUrl ? { daemonReach: () => e.ws.daemonReach() } : {}),
        providerState: () => e.machine.state(),
        exec: (cmd, o) => e.machine.exec(cmd, o),
      }));
    },
    emit: e => bus.emit(e),
    on: (type, l) => bus.on(type, l),
    ...(opts.status !== undefined ? { defaults: opts.status } : {}),
    clock,
  });

  return {
    events: bus,
    backend,
    workspaces,
    sessions: sessionsApi,
    golden,
    status,
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
        const bornAt = Date.parse(b.builder.machine.labels?.["createdAt"] ?? b.record.createdAt);
        const ageMs = Number.isNaN(bornAt) ? undefined : now - bornAt;
        const expired = b.life === "reusable" && (ageMs === undefined || ageMs >= BUILDER_IDLE_MS);
        if (b.life !== "stale" && !expired) continue;
        try {
          await b.builder.machine.kill();
        } catch (e) {
          if ((e as { kind?: string }).kind !== "missing") {
            failed.push({ id: b.record.id, message: `${messageOf(e)}; stays recorded, retried next sweep` });
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
      const result = (swept: ReapResult): ReapResult => {
        const allFailed = failed.concat(swept.failed ?? []);
        return { reaped: reaped.concat(swept.reaped), spared: swept.spared, ...(allFailed.length > 0 ? { failed: allFailed } : {}) };
      };
      try {
        return result(
          await reap({
            backend,
            owner,
            knownIds: () => [...live.values()].flatMap(e => [e.record.machineId, e.machine.id]).concat([...builders.keys()], [...inflight], reaped.map(r => r.id)),
            ...(olderThanMs !== undefined ? { olderThanMs } : {}),
          }),
        );
      } catch (e) {
        failed.push({ message: messageOf(e) });
        return result({ reaped: [], spared: [] });
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
      await Promise.all(transcriptFlushes.values());
    },
  };
}
