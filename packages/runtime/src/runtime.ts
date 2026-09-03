import { randomBytes, randomUUID } from "node:crypto";
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
  applyGoldenImport,
  type Builder,
  type BuildGoldenOptions,
  type GoldenImport,
  type ImportLedger,
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
  rollback as rollbackGolden,
} from "@wsp/engine";
import type {
  DaemonReachView,
  EventUnion,
  GoldenBuilderView,
  GoldenStage,
  PortReachView,
  ReachState,
  SessionEvent,
  SessionView,
  WorkspaceSize,
  WorkspaceView,
} from "@wsp/protocol";
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
  interrupt?(): Promise<void>;
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
}

function eventBus(): EventBus & { emit(event: EventUnion): void } {
  const listeners = new Map<string, Set<EventListener>>();
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
    emit(event) {
      for (const type of [event.type, "*"] as const) {
        for (const l of listeners.get(type) ?? []) l(event);
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
}

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
  /** How long a seal waits for a killed machine to read gone (tests shrink it). */
  killConfirm?: KillConfirm;
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

/** A fresh fork boots as "localhost"; naming it is cosmetic, so a guest that refuses is only logged. */
async function setHostname(machine: Machine, name: string): Promise<void> {
  const host = hostnameFor(name);
  const res = await machine
    .exec(`hostname ${host} && echo ${host} > /etc/hostname`)
    .catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) }));
  if (res.exitCode !== 0) console.warn(`hostname ${host} on ${machine.id} failed: ${res.stderr.trim()}`);
}

export interface GoldenBuildRequest extends Omit<BuildGoldenOptions, "backend" | "manifest"> {
  /** Store key; several goldens can coexist. */
  name?: string;
}

export interface Runtime {
  readonly events: EventBus;
  readonly backend: MachineBackend;
  readonly workspaces: {
    create(opts: CreateWorkspaceOptions): Promise<WorkspaceView>;
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
  };
  readonly golden: {
    build(opts: GoldenBuildRequest): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
    get(name?: string): Promise<GoldenManifest | undefined>;
    /** Boots a first-life builder from the recipe; a person sets it up on its live screen, then seals it. */
    prepare(opts?: { name?: string; kind?: MachineKind }): Promise<GoldenBuilderView>;
    /** Snapshot, smoke-fork, append a version. The builder is consumed whether this succeeds, fails, or is refused. */
    seal(builderId: string): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
    /** How a browser dials the builder's daemon; the builder is not a workspace, so it has its own road. */
    builderReach(builderId: string): Promise<DaemonReachView>;
    builders(): Promise<GoldenBuilderView[]>;
    /** Moves the golden's head; new forks follow it, workspaces already forked keep their image. */
    rollback(version: number, name?: string): Promise<GoldenManifest>;
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
const TRANSCRIPTS = "transcripts";
/** Mirrors @wsp/daemon's DEFAULT_TOKEN_PATH; the runtime cannot import the daemon package (it only runs inside guests). */
const DAEMON_TOKEN_PATH = "/root/.wsp-daemon-token";
/** A guest with no token file is asked again after this long (a daemon may be deployed later). */
const DAEMON_TOKEN_MISS_TTL_MS = 60_000;
/** Events kept per workspace; the oldest fall off so one chatty workspace cannot grow the store forever. */
const TRANSCRIPT_CAP = 5000;
/** A turn boundary waits this long for more before the transcript is written; measured at one put per
 * event, 5000 events cost 4 s of memory-store clones and 6.6 s of file rewrites after the last turn. */
const TRANSCRIPT_FLUSH_MS = 250;

interface TranscriptRecord {
  workspaceId: string;
  events: SessionEvent[];
}

/** Builders live apart from workspaces: never in the rail, and a record left
 * by a crashed wizard is exactly what reap() sweeps. */
const BUILDERS = "builders";
/** One id per state file, stamped on every machine it creates so another host's sweep can tell them apart from its own. */
const OWNER = "owner";

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
  /** What of the recipe this builder carries; a prepare with the same recipe hash reuses it. */
  import?: ImportLedger;
}

interface LiveBuilder {
  record: BuilderRecord;
  builder: Builder;
  /** Hydrated from the store and not proven first-life, so it can never seal; reap stops it. */
  stale: boolean;
  /** Loaded from an earlier process's record, so nobody in this process is working on it. */
  hydrated: boolean;
  reach?: PreviewReach;
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
  const sessions = new Map<string, { view: SessionView; handle: SessionHandle }>();
  const transcripts = new Map<string, SessionEvent[]>();
  // Puts are chained per workspace so the later snapshot always lands last,
  // whatever order the store finishes in.
  const transcriptFlushes = new Map<string, Promise<void>>();
  const transcriptTimers = new Map<string, NodeJS.Timeout>();
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
    clearTimeout(transcriptTimers.get(workspaceId));
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
      transcriptTimers.set(event.workspaceId, setTimeout(() => void flushTranscript(event.workspaceId), TRANSCRIPT_FLUSH_MS));
    }
    bus.emit(event);
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
  /** Ids this process has created and not yet recorded; the sweep must not read them as lost. */
  const inflight = new Set<string>();
  const claiming = <T>(run: (b: MachineBackend) => Promise<T>): Promise<T> => {
    const mine: string[] = [];
    const b: MachineBackend = {
      capabilities: backend.capabilities,
      pricing: backend.pricing,
      get: id => backend.get(id),
      list: labels => backend.list(labels),
      deleteSnapshot: id => backend.deleteSnapshot(id),
      create: async spec => {
        const m = await backend.create(spec);
        inflight.add(m.id);
        mine.push(m.id);
        return m;
      },
    };
    return run(b).finally(() => mine.forEach(id => inflight.delete(id)));
  };
  /** Boots a golden fork for the record and writes back what the provider says it built.
   * A snapshot restores as the kind it was taken from, so the spec names that kind;
   * versions sealed before it was recorded were all sandbox. */
  const fork = (record: WorkspaceRecord, bind: (machine: Machine) => void, override?: WorkspaceSpec): Promise<Machine> =>
    claiming(async b => {
      const spec = forkSpec(record, (await goldenVersionOf(record.golden))?.kind ?? "sandbox", override);
      const machine = await b.create(spec);
      // Named by its record before the claim is released, so no sweep sees it unclaimed.
      bind(machine);
      await setHostname(machine, record.name);
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
        vaultImport: (m, payload) => importInto(m, payload, "/"),
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
      { phase: record.phase, firstLife: record.firstLife },
    );
    live.set(record.id, entry);
    return entry;
  };

  const idleWindowOf = (r: WorkspaceRecord): number | null => (r.idleWindowMs === undefined ? defaultIdleWindowMs : r.idleWindowMs);

  const napWith = async (id: string, reason?: string): Promise<WorkspaceView> => {
    const entry = await entryOf(id);
    if (entry.record.phase !== "running") return view(entry.record);
    await entry.ws.nap();
    entry.record.phase = "napping";
    await persist(entry.record);
    bus.emit({ type: "workspace.napped", workspaceId: id });
    if (reason !== undefined) await emitStatus(entry, "napping", reason);
    return view(entry.record);
  };

  const idle = createIdlePolicy({
    windowOf: id => {
      const entry = live.get(id);
      return entry === undefined ? null : idleWindowOf(entry.record);
    },
    onIdle: async (id, windowMs) => {
      await napWith(id, idleReason(windowMs));
    },
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
        attach(
          {
            ...stored,
            size: stored.size ?? sizeBuilt(await shapeOf(machine), backend.pricing.defaultSize),
            ...(machine.streamUrl !== undefined ? { screen: { streamUrl: machine.streamUrl } } : {}),
          },
          machine,
        );
        if (stored.phase === "running") idle.touch(stored.id);
      }
      for (const raw of await store.list(TRANSCRIPTS)) {
        const t = raw as TranscriptRecord;
        transcripts.set(t.workspaceId, t.events);
      }
      for (const raw of await store.list(BUILDERS)) {
        const stored = raw as Omit<BuilderRecord, "size" | "firstLife"> & { size?: WorkspaceSize; firstLife?: boolean };
        const machine = await backend.get(stored.id).catch((e: unknown) => {
          if ((e as { kind?: string }).kind === "missing") return undefined;
          throw e;
        });
        if (!machine) {
          await store.delete(BUILDERS, stored.id);
          continue;
        }
        // A machine found paused was paused: the marker is cleared for good. A pause and
        // resume from outside wsp leaves no trace the provider reports, so it fails at the seal.
        const firstLife = stored.firstLife === true && (await machine.state()) === "running";
        const record: BuilderRecord = { ...stored, firstLife, size: stored.size ?? sizeBuilt(await shapeOf(machine), backend.pricing.defaultSize) };
        if (stored.firstLife === true && !firstLife) await store.put(BUILDERS, record.id, record);
        const reusable = firstLife && machine.labels?.[OWNER_LABEL] === owner;
        builders.set(record.id, {
          record,
          builder: {
            machine, kind: record.kind, baseTemplate: record.baseTemplate, setupSha: record.setupSha, createdAt: record.createdAt, firstLife: reusable, size: record.size,
            ...(record.import !== undefined ? { import: record.import } : {}),
          },
          stale: !reusable,
          hydrated: true,
        });
      }
    })();
    return hydrated;
  };

  const entryOf = async (id: string): Promise<LiveWorkspace> => {
    await ready();
    const entry = live.get(id);
    if (!entry) throw new Error(`no such workspace: ${id}`);
    return entry;
  };

  const workspaces: Runtime["workspaces"] = {
    async create(o) {
      await ready();
      const inherited = (await goldenVersionOf(o.golden))?.size;
      const record: WorkspaceRecord = {
        id: `ws_${randomBytes(4).toString("hex")}`,
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
      await fork(record, m => {
        record.machineId = m.id;
        attach(record, m);
      });
      await persist(record);
      const v = view(record);
      bus.emit({ type: "workspace.created", workspace: v });
      return v;
    },

    async get(id) {
      return view((await entryOf(id)).record);
    },

    async list() {
      await ready();
      return [...live.values()].map(e => view(e.record));
    },

    async nap(id) {
      return napWith(id);
    },

    async wake(id) {
      const entry = await entryOf(id);
      if (entry.waking) return entry.waking;
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
      };
      const turnId = randomUUID();

      const forward = (event: AdapterEvent): void => {
        const sessionId = event.sessionId;
        switch (event.type) {
          case "session.start": {
            sessionView.claudeSessionId = sessionId;
            entry.record.claudeSessionId = sessionId;
            void persist(entry.record);
            record({
              type: "session.start",
              workspaceId,
              sessionId,
              turnId,
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
              kind: event.kind,
              text: event.text,
              ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
              ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
              ...(event.isError !== undefined ? { isError: event.isError } : {}),
            });
            return;
          case "turn.done":
            sessionView.status = event.result.status;
            record({ type: "session.done", workspaceId, sessionId, turnId, result: event.result });
            return;
          case "session.end":
            sessionView.endedAt = Date.now();
            record({
              type: "session.end",
              workspaceId,
              sessionId,
              turnId,
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
        interrupt: async () => {
          await started.interrupt?.();
        },
      };
      sessions.set(handleId, { view: sessionView, handle });
      started.finished
        .then(result => {
          sessionView.status = result.status;
          sessionView.endedAt ??= Date.now();
        })
        .catch(() => {
          sessionView.status = "failed";
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
      return [...(transcripts.get(workspaceId) ?? [])];
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
  });

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

  const golden: Runtime["golden"] = {
    async build(o) {
      await ready();
      const { name, ...build } = o;
      const key = name ?? "default";
      const prior = (await store.get(GOLDENS, key)) as GoldenManifest | undefined;
      const result = await claiming(b =>
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
      const { deployDaemon, smoke, import: imp, ...size } = recipe;
      void smoke;
      const stage = stageOf(name);
      return claiming(async b => {
        // A first-life builder carrying the same ticks is attached to instead of
        // booting a second one, whichever process made it; the stages skip on its
        // ledger. A hydrated builder not proven first-life is stale: never reused.
        const same = imp === undefined ? undefined : [...builders.values()].find(x => !x.stale && x.record.name === name && x.record.import?.recipeHash === imp.recipeHash);
        if (same && imp) {
          try {
            const applied = await applyGoldenImport(same.builder.machine, { import: imp, setup: recipe.setup, ...(same.record.import !== undefined ? { ledger: same.record.import } : {}), onStage: stage });
            same.record.import = applied.ledger;
            await store.put(BUILDERS, same.record.id, same.record);
          } catch (e) {
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
        }
        const builder = await prepareBuilder({
          backend: b,
          ...size,
          ...(o?.kind !== undefined ? { kind: o.kind } : {}),
          ...(deployDaemon !== undefined ? { deployDaemon } : {}),
          ...(imp !== undefined ? { import: imp } : {}),
          labels: { ...recipe.labels, wsp: "1", "wsp-builder": "1", [OWNER_LABEL]: owner, createdAt: new Date().toISOString() },
          onStage: stage,
        });
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
        const entry: LiveBuilder = { record, builder, stale: false, hydrated: false };
        builders.set(record.id, entry);
        await store.put(BUILDERS, record.id, record);
        return builderView(record, entry);
      });
    },

    async seal(builderId) {
      await ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      const recipe = recipeOrThrow();
      const prior = (await store.get(GOLDENS, entry.record.name)) as GoldenManifest | undefined;
      try {
        const result = await claiming(b =>
          sealGolden(entry.builder, {
            backend: b,
            smoke: recipe.smoke,
            ...(recipe.cpu !== undefined ? { cpu: recipe.cpu } : {}),
            ...(recipe.memMb !== undefined ? { memMb: recipe.memMb } : {}),
            ...(recipe.envs !== undefined ? { envs: recipe.envs } : {}),
            labels: { ...recipe.labels, wsp: "1", "wsp-smoke": "1", [OWNER_LABEL]: owner, createdAt: new Date().toISOString() },
            ...(prior !== undefined ? { manifest: prior } : {}),
            onStage: stageOf(entry.record.name),
            ...(opts.killConfirm !== undefined ? { killConfirm: opts.killConfirm } : {}),
          }),
        );
        await store.put(GOLDENS, entry.record.name, result.manifest);
        return result;
      } catch (e) {
        // sealGolden consumes the builder on every road but a refusal; a refused
        // builder can never seal and under a two-machine cap must not outlive it.
        if (e instanceof NotFirstLifeError) await killUntilGone(backend, entry.builder.machine, opts.killConfirm);
        throw e;
      } finally {
        // The record goes whatever happened: a machine that outlived its kills
        // is then unrecorded, which is exactly what reap sweeps.
        await forgetBuilder(builderId);
      }
    },

    async builderReach(builderId) {
      await ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      const reach = await refreshPreviewToken(entry.builder.machine, DAEMON_PORT, entry.reach);
      entry.reach = reach;
      const daemonToken = await daemonTokenOf(entry.builder.machine);
      return { url: reach.url, expiresAt: reach.expiresAt, ...(daemonToken !== undefined ? { daemonToken } : {}) };
    },

    async builders() {
      await ready();
      return [...builders.values()].map(b => builderView(b.record, b));
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
      return [...live.values()].map(e => ({
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
      // A hydrated builder not proven first-life can never seal; stopping it is the only thing that ends its bill.
      // A kept first-life one dies at six hours by our createdAt label: every get(id) on it resets the
      // provider's rolling idle timer (measured), so the kill it was created with never fires while a host is up.
      const reaped: ReapedMachine[] = [];
      const failed: ReapFailure[] = [];
      const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      const now = Date.now();
      for (const b of [...builders.values()]) {
        const bornAt = Date.parse(b.builder.machine.labels?.["createdAt"] ?? b.record.createdAt);
        const ageMs = Number.isNaN(bornAt) ? undefined : now - bornAt;
        const expired = b.hydrated && ageMs !== undefined && ageMs >= BUILDER_IDLE_MS;
        if (!b.stale && !expired) continue;
        try {
          await b.builder.machine.kill();
        } catch (e) {
          if ((e as { kind?: string }).kind !== "missing") {
            failed.push({ id: b.record.id, message: `${messageOf(e)}; stays recorded, retried next sweep` });
            continue;
          }
        }
        await forgetBuilder(b.record.id);
        reaped.push(b.stale ? { id: b.record.id, builder: true, reason: "recorded" } : { id: b.record.id, builder: true, reason: "expired", ageMs: ageMs! });
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
      for (const id of [...transcriptTimers.keys()]) void flushTranscript(id);
      await Promise.all(transcriptFlushes.values());
    },
  };
}
