import { randomBytes, randomUUID } from "node:crypto";
import type { AdapterEvent, TurnResult } from "@wsp/adapter-claude";
import {
  DAEMON_PORT,
  NotFirstLifeError,
  Workspace,
  buildGolden,
  exportPaths,
  importInto,
  killUntilGone,
  prepareBuilder,
  reap,
  refreshPreviewToken,
  sealGolden,
  type Builder,
  type BuildGoldenOptions,
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
import { connectDaemon, type DaemonReach } from "./reach.js";
import { createStatusTracker, type StatusApi, type StatusWatchOptions } from "./status.js";
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
}

interface WorkspaceRecord extends WorkspaceView {
  spec: Pick<WorkspaceSpec, "envs" | "labels">;
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
    delete(id: string): Promise<void>;
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
  reap(olderThanMs?: number): Promise<string[]>;
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

interface BuilderRecord {
  id: string;
  name: string;
  kind: MachineKind;
  baseTemplate: string;
  setupSha: string;
  createdAt: string;
  size: WorkspaceSize;
  streamUrl?: string;
}

interface LiveBuilder {
  record: BuilderRecord;
  builder: Builder;
  /** Hydrated from the store by a later process, so its first life cannot be vouched for. */
  stale: boolean;
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

  /** A status pushed outside the poll, for a phase change the poller would show late. */
  const emitStatus = async (entry: LiveWorkspace, reach: ReachState, reason?: string): Promise<void> => {
    const machineState = await entry.machine.state().catch(() => "gone" as const);
    const size = entry.record.size;
    bus.emit({
      type: "workspace.status",
      status: {
        ...view(entry.record),
        machineState,
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
    labels: { ...r.spec.labels, wsp: "1", createdAt: new Date().toISOString() },
  });

  /** Boots a golden fork for the record and writes back what the provider says it built.
   * A snapshot restores as the kind it was taken from, so the spec names that kind;
   * versions sealed before it was recorded were all sandbox. */
  const fork = async (record: WorkspaceRecord, override?: WorkspaceSpec): Promise<Machine> => {
    const spec = forkSpec(record, (await goldenVersionOf(record.golden))?.kind ?? "sandbox", override);
    const machine = await backend.create(spec);
    await setHostname(machine, record.name);
    const shape = await shapeOf(machine);
    if (shape !== undefined) record.shape = shape;
    else delete record.shape;
    record.size = sizeBuilt(shape, spec);
    if (machine.streamUrl !== undefined) record.screen = { streamUrl: machine.streamUrl };
    else delete record.screen;
    return machine;
  };

  const attach = (record: WorkspaceRecord, machine: Machine): LiveWorkspace => {
    const entry: LiveWorkspace = { record, machine, ws: undefined as unknown as Workspace };
    entry.ws = new Workspace(
      machine,
      {
        goldenSnapshot: record.golden,
        resurrect: async (override?: Partial<MachineSpec>) => {
          const m = await fork(record, override);
          entry.machine = m;
          return m;
        },
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

  let hydrated: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    hydrated ??= (async () => {
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
      }
      for (const raw of await store.list(TRANSCRIPTS)) {
        const t = raw as TranscriptRecord;
        transcripts.set(t.workspaceId, t.events);
      }
      for (const raw of await store.list(BUILDERS)) {
        const stored = raw as Omit<BuilderRecord, "size"> & { size?: WorkspaceSize };
        const machine = await backend.get(stored.id).catch((e: unknown) => {
          if ((e as { kind?: string }).kind === "missing") return undefined;
          throw e;
        });
        if (!machine) {
          await store.delete(BUILDERS, stored.id);
          continue;
        }
        const record: BuilderRecord = { ...stored, size: stored.size ?? sizeBuilt(await shapeOf(machine), backend.pricing.defaultSize) };
        builders.set(record.id, {
          record,
          builder: { machine, kind: record.kind, baseTemplate: record.baseTemplate, setupSha: record.setupSha, createdAt: record.createdAt, firstLife: false, size: record.size },
          stale: true,
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
        size: {
          cpu: o.cpu ?? inherited?.cpu ?? backend.pricing.defaultSize.cpu,
          memMb: o.memMb ?? inherited?.memMb ?? backend.pricing.defaultSize.memMb,
        },
        firstLife: true,
      };
      const machine = await fork(record);
      record.machineId = machine.id;
      attach(record, machine);
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
      const entry = await entryOf(id);
      await entry.ws.nap();
      entry.record.phase = "napping";
      await persist(entry.record);
      bus.emit({ type: "workspace.napped", workspaceId: id });
      return view(entry.record);
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

      const started = adapter.start({
        prompt: o.prompt,
        ...(o.resume !== undefined ? { resume: o.resume } : {}),
        ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
        onEvent: forward,
      });
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

  const builderView = (r: BuilderRecord): GoldenBuilderView => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    createdAt: r.createdAt,
    ...(r.streamUrl !== undefined ? { screen: { streamUrl: r.streamUrl } } : {}),
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
      const { name, ...build } = o;
      const key = name ?? "default";
      const prior = (await store.get(GOLDENS, key)) as GoldenManifest | undefined;
      const result = await buildGolden({ ...build, backend, ...(prior !== undefined ? { manifest: prior } : {}) });
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
      const { deployDaemon, smoke, ...size } = recipe;
      void smoke;
      const builder = await prepareBuilder({
        backend,
        ...size,
        ...(o?.kind !== undefined ? { kind: o.kind } : {}),
        ...(deployDaemon !== undefined ? { deployDaemon } : {}),
        labels: { ...recipe.labels, wsp: "1", "wsp-builder": "1", createdAt: new Date().toISOString() },
        onStage: stageOf(name),
      });
      const record: BuilderRecord = {
        id: builder.machine.id,
        name,
        kind: builder.kind,
        baseTemplate: builder.baseTemplate,
        setupSha: builder.setupSha,
        createdAt: builder.createdAt,
        size: builder.size,
        ...(builder.machine.streamUrl !== undefined ? { streamUrl: builder.machine.streamUrl } : {}),
      };
      builders.set(record.id, { record, builder, stale: false });
      await store.put(BUILDERS, record.id, record);
      return builderView(record);
    },

    async seal(builderId) {
      await ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      const recipe = recipeOrThrow();
      const prior = (await store.get(GOLDENS, entry.record.name)) as GoldenManifest | undefined;
      try {
        const result = await sealGolden(entry.builder, {
          backend,
          smoke: recipe.smoke,
          ...(recipe.cpu !== undefined ? { cpu: recipe.cpu } : {}),
          ...(recipe.memMb !== undefined ? { memMb: recipe.memMb } : {}),
          ...(recipe.envs !== undefined ? { envs: recipe.envs } : {}),
          labels: { ...recipe.labels, wsp: "1", "wsp-smoke": "1", createdAt: new Date().toISOString() },
          ...(prior !== undefined ? { manifest: prior } : {}),
          onStage: stageOf(entry.record.name),
          ...(opts.killConfirm !== undefined ? { killConfirm: opts.killConfirm } : {}),
        });
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
      return [...builders.values()].map(b => builderView(b.record));
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
    backend,
    records: async () => {
      await ready();
      return [...live.values()].map(e => ({ ...view(e.record), size: e.record.size }));
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
      const reaped: string[] = [];
      for (const b of [...builders.values()].filter(b => b.stale)) {
        await b.builder.machine.kill().catch((e: unknown) => {
          if ((e as { kind?: string }).kind !== "missing") throw e;
        });
        await forgetBuilder(b.record.id);
        reaped.push(b.record.id);
      }
      const swept = await reap({
        backend,
        knownIds: [...live.values()].map(e => e.record.machineId).concat([...builders.keys()]),
        ...(olderThanMs !== undefined ? { olderThanMs } : {}),
      });
      return reaped.concat(swept.filter(id => !reaped.includes(id)));
    },
    close: async () => {
      for (const id of [...transcriptTimers.keys()]) void flushTranscript(id);
      await Promise.all(transcriptFlushes.values());
    },
  };
}
