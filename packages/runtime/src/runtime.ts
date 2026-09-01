import { randomBytes } from "node:crypto";
import type { AdapterEvent, TurnResult } from "@wsp/adapter-claude";
import {
  Workspace,
  buildGolden,
  exportPaths,
  importInto,
  reap,
  type BuildGoldenOptions,
  type ExecResult,
  type GoldenManifest,
  type GoldenVersion,
  type Machine,
  type MachineBackend,
  type MachineSpec,
} from "@wsp/engine";
import type { EventUnion, SessionView, WorkspaceView } from "@wsp/protocol";
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

export interface RuntimeOptions {
  backend: MachineBackend;
  store: Store;
  adapters: Record<string, HarnessAdapterFactory>;
  /**
   * Explicit guest paths carried across an upgrade. Default: everything under
   * /root except golden-provided dirs (VAULT_SKIP), enumerated at export time.
   */
  vaultPaths?: string[];
}

/** Dirs the golden image already provides on every fresh fork; re-vaulting
 * them is dead weight, and extracting them with --recursive-unlink would
 * delete the fork's own copies first (the claude install lives in .local). */
const VAULT_SKIP = new Set([".local", ".cache", ".npm"]);

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
  };
  readonly sessions: {
    start(
      workspaceId: string,
      opts: { prompt: string; harness?: string; resume?: string; cwd?: string },
    ): Promise<SessionHandle>;
    list(workspaceId?: string): SessionView[];
  };
  readonly golden: {
    build(opts: GoldenBuildRequest): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
    get(name?: string): Promise<GoldenManifest | undefined>;
  };
  reap(olderThanMs?: number): Promise<string[]>;
}

const WORKSPACES = "workspaces";
const GOLDENS = "goldens";

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
  const sessions = new Map<string, { view: SessionView; handle: SessionHandle }>();

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
      await store.delete(WORKSPACES, id);
      bus.emit({ type: "workspace.deleted", workspaceId: id });
    },

    async exec(id, cmd, o) {
      const entry = await entryOf(id);
      return entry.machine.exec(cmd, o);
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
            bus.emit({
              type: "session.start",
              workspaceId,
              sessionId,
              ...(event.model !== undefined ? { model: event.model } : {}),
              ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
              ...(event.tools !== undefined ? { tools: event.tools } : {}),
            });
            return;
          }
          case "turn.delta":
            bus.emit({
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
            bus.emit({ type: "session.done", workspaceId, sessionId, result: event.result });
            return;
          case "session.end":
            bus.emit({
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
  };

  return {
    events: bus,
    backend,
    workspaces,
    sessions: sessionsApi,
    golden,
    reap: async olderThanMs => {
      await ready();
      return reap({
        backend,
        knownIds: [...live.values()].map(e => e.record.machineId),
        ...(olderThanMs !== undefined ? { olderThanMs } : {}),
      });
    },
  };
}
