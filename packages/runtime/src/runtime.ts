import { randomBytes } from "node:crypto";
import type { AdapterEvent, TurnResult } from "@wsp/adapter-claude";
import {
  DAEMON_PORT,
  Workspace,
  buildGolden,
  exportPaths,
  importInto,
  prepareBuilder,
  reap,
  refreshPreviewToken,
  sealGolden,
  type Builder,
  type BuildGoldenOptions,
  type ExecResult,
  type GoldenManifest,
  type GoldenVersion,
  type Machine,
  type MachineBackend,
  type MachineKind,
  type MachineSpec,
  type PreviewReach,
  rollback as rollbackGolden,
} from "@wsp/engine";
import type { DaemonReachView, EventUnion, GoldenBuilderView, GoldenStage, SessionEvent, SessionView, WorkspaceView } from "@wsp/protocol";
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
  spec: WorkspaceSpec;
  firstLife: boolean;
}

interface LiveWorkspace {
  record: WorkspaceRecord;
  ws: Workspace;
  machine: Machine;
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
  // done and end arrive back to back; puts are chained per workspace so the
  // later snapshot always lands last, whatever order the store finishes in.
  const transcriptFlushes = new Map<string, Promise<void>>();
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

  // Deltas are only appended in memory; the store sees the transcript at turn
  // boundaries, so a crash mid-turn loses that turn's partial output and
  // nothing else.
  const record = (event: SessionEvent): void => {
    let events = transcripts.get(event.workspaceId);
    if (!events) {
      events = [];
      transcripts.set(event.workspaceId, events);
    }
    events.push(event);
    if (events.length > TRANSCRIPT_CAP) events.splice(0, events.length - TRANSCRIPT_CAP);
    if (event.type !== "session.delta") {
      const snapshot: TranscriptRecord = { workspaceId: event.workspaceId, events: [...events] };
      const queued = (transcriptFlushes.get(event.workspaceId) ?? Promise.resolve())
        .then(() => store.put(TRANSCRIPTS, event.workspaceId, snapshot))
        .catch(() => {});
      transcriptFlushes.set(event.workspaceId, queued);
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
  });

  const persist = async (r: WorkspaceRecord): Promise<void> => {
    await store.put(WORKSPACES, r.id, r);
  };

  const forkSpec = (r: WorkspaceRecord, override?: WorkspaceSpec): MachineSpec => ({
    kind: "sandbox",
    fromSnapshot: r.golden,
    ...((override?.cpu ?? r.spec.cpu) !== undefined ? { cpu: override?.cpu ?? r.spec.cpu } : {}),
    ...((override?.memMb ?? r.spec.memMb) !== undefined ? { memMb: override?.memMb ?? r.spec.memMb } : {}),
    ...(r.spec.envs !== undefined || override?.envs !== undefined
      ? { envs: { ...r.spec.envs, ...override?.envs } }
      : {}),
    labels: { ...r.spec.labels, wsp: "1", createdAt: new Date().toISOString() },
  });

  const attach = (record: WorkspaceRecord, machine: Machine): LiveWorkspace => {
    const entry: LiveWorkspace = { record, machine, ws: undefined as unknown as Workspace };
    entry.ws = new Workspace(
      machine,
      {
        goldenSnapshot: record.golden,
        resurrect: async (override?: Partial<MachineSpec>) => {
          const m = await backend.create(forkSpec(record, override));
          await setHostname(m, record.name);
          entry.machine = m;
          return m;
        },
        vaultExport: async m => exportPaths(m, await vaultPathsOf(m)),
        vaultImport: (m, payload) => importInto(m, payload, "/"),
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
        const record = raw as WorkspaceRecord;
        const machine = await backend.get(record.machineId).catch((e: unknown) => {
          if ((e as { kind?: string }).kind === "missing") return deadMachine(record.machineId);
          throw e;
        });
        attach(record, machine);
      }
      for (const raw of await store.list(TRANSCRIPTS)) {
        const t = raw as TranscriptRecord;
        transcripts.set(t.workspaceId, t.events);
      }
      for (const raw of await store.list(BUILDERS)) {
        const record = raw as BuilderRecord;
        const machine = await backend.get(record.id).catch((e: unknown) => {
          if ((e as { kind?: string }).kind === "missing") return undefined;
          throw e;
        });
        if (!machine) {
          await store.delete(BUILDERS, record.id);
          continue;
        }
        builders.set(record.id, {
          record,
          builder: { machine, kind: record.kind, baseTemplate: record.baseTemplate, setupSha: record.setupSha, createdAt: record.createdAt, firstLife: false },
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
      const record: WorkspaceRecord = {
        id: `ws_${randomBytes(4).toString("hex")}`,
        name: o.name,
        machineId: "",
        phase: "running",
        golden: o.golden,
        createdAt: new Date().toISOString(),
        spec: {
          ...(o.cpu !== undefined ? { cpu: o.cpu } : {}),
          ...(o.memMb !== undefined ? { memMb: o.memMb } : {}),
          ...(o.envs !== undefined ? { envs: o.envs } : {}),
          ...(o.labels !== undefined ? { labels: o.labels } : {}),
        },
        firstLife: true,
      };
      const machine = await backend.create(forkSpec(record));
      await setHostname(machine, o.name);
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
      const before = entry.ws.machineId;
      await entry.ws.wake();
      const resurrected = entry.ws.machineId !== before;
      entry.record.phase = "running";
      entry.record.machineId = entry.ws.machineId;
      entry.record.firstLife = entry.ws.isFirstLife;
      await persist(entry.record);
      bus.emit({ type: "workspace.woken", workspaceId: id, machineId: entry.record.machineId, resurrected });
      return view(entry.record);
    },

    async upgrade(id, spec) {
      const entry = await entryOf(id);
      await entry.ws.upgrade(spec);
      entry.record.machineId = entry.ws.machineId;
      entry.record.phase = "running";
      entry.record.firstLife = entry.ws.isFirstLife;
      entry.record.spec = { ...entry.record.spec, ...spec };
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
      await store.delete(WORKSPACES, id);
      await store.delete(TRANSCRIPTS, id);
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
      const sessionView: SessionView = { id: "", workspaceId, harness, status: "running" };

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
              prompt: o.prompt,
              ...(event.model !== undefined ? { model: event.model } : {}),
              ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
              ...(event.tools !== undefined ? { tools: event.tools } : {}),
            });
            return;
          }
          case "turn.delta":
            record({
              type: "session.delta",
              workspaceId,
              sessionId,
              kind: event.kind,
              text: event.text,
              ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
              ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
              ...(event.isError !== undefined ? { isError: event.isError } : {}),
            });
            return;
          case "turn.done":
            sessionView.status = event.result.status;
            record({ type: "session.done", workspaceId, sessionId, result: event.result });
            return;
          case "session.end":
            record({
              type: "session.end",
              workspaceId,
              sessionId,
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
        })
        .catch(() => {
          sessionView.status = "failed";
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
        });
        await store.put(GOLDENS, entry.record.name, result.manifest);
        return result;
      } finally {
        // A refused builder can never seal; under a two-machine cap it must not outlive the refusal.
        await entry.builder.machine.kill().catch(() => {});
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
      return [...live.values()].map(e => ({ ...view(e.record), spec: e.record.spec }));
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
  };
}
