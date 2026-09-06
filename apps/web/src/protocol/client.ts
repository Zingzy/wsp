// SPDX-License-Identifier: AGPL-3.0-only
// Browser-side client for the runtime WS (see packages/runtime/src/serve.ts).
// Auth: open the socket, send one `auth` frame with the token (host injects it
// via window.__WSP__), then ops flow. The token never rides in the URL. A
// dropped socket is redialled with backoff and authed again with the same
// token; the store re-runs its standing fetches when the status comes back
// to live.
import {
  HarnessCatalog,
  PortForward,
  SessionInterruptOutcome,
  SessionSteerOutcome,
  type Capabilities,
  type DaemonReachView,
  type EventUnion,
  goldenHead,
  type GoldenManifest,
  type GoldenVersion,
  type PortProbeView,
  type PortReachView,
  ProjectExportResult,
  ProjectImportResult,
  ProjectPlan,
  type SessionEvent,
  type SessionView,
  type SnapshotLineage,
  type SnapshotRollbackResult,
  type SnapshotStorage,
  type WorkspaceCreateResult,
  WorkspaceCostEvent,
  type WorkspaceStatus,
  type WorkspaceView,
} from "@wsp/protocol";

export type ProtocolEvent = EventUnion;
type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

export interface ProtocolClientOptions {
  url: string;
  token: string;
  WebSocketCtor?: typeof WebSocket;
  /** Fires on every transition; "closed" is terminal (client closed, or the token was refused). */
  onStatus?: (s: ConnStatus) => void;
  /** Delay before redial number `attempt` (1-based); the default doubles from 250 ms and caps at 5 s. */
  backoffMs?: (attempt: number) => number;
  /** A re-subscribe found the runtime could not replay what this socket missed: anything folded from events is
   * stale and must be refetched. Fires after the redial is live, before any event from the new socket. */
  onGap?: () => void;
}
/** "connecting" until the first auth succeeds, "reconnecting" after a drop; both keep dialling. */
export type ConnStatus = "connecting" | "live" | "reconnecting" | "closed";

export type DisconnectReason = "lost" | "closed" | "unauthorized";
const DISCONNECT_MESSAGE: Record<DisconnectReason, string> = {
  lost: "runtime connection lost",
  closed: "runtime client closed",
  unauthorized: "runtime refused the token",
};

/** What every request settles with when no live socket can carry it. */
export class DisconnectedError extends Error {
  readonly reason: DisconnectReason;
  constructor(reason: DisconnectReason) {
    super(DISCONNECT_MESSAGE[reason]);
    this.name = "DisconnectedError";
    this.reason = reason;
  }
}

/** A runtime refusal. kind is the typed failure when the runtime has one (engine
 * WspError kinds such as "concurrency", the provider's machine cap). */
export class RequestError extends Error {
  readonly kind: string | undefined;
  constructor(message: string, kind?: string) {
    super(message);
    this.name = "RequestError";
    this.kind = kind;
  }
}

export const defaultBackoffMs = (attempt: number): number => Math.min(5_000, 250 * 2 ** (attempt - 1));

export class ProtocolClient {
  #ws: WebSocket | null = null;
  #seq = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(e: ProtocolEvent) => void>();
  #opts: ProtocolClientOptions;
  #Ctor: typeof WebSocket;
  #backoff: (attempt: number) => number;
  #subscribed = false;
  /** seq of the last event seen, or the runtime's head when none was; sent as `after` on every re-subscribe. */
  #cursor: number | undefined;
  /** The runtime process the cursor belongs to; sent with it, and a reply from another one is a gap. */
  #stream: string | undefined;
  #subscribeId: number | null = null;
  #everLive = false;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #dead: DisconnectReason | null = null;
  #firstLive: { resolve: () => void; reject: (e: Error) => void } | null = null;
  status: ConnStatus = "connecting";

  constructor(opts: ProtocolClientOptions) {
    this.#opts = opts;
    this.#Ctor = opts.WebSocketCtor ?? globalThis.WebSocket;
    this.#backoff = opts.backoffMs ?? defaultBackoffMs;
  }

  /** Resolves on the first live socket, however many dials that takes; rejects only when the token is refused. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#firstLive = { resolve, reject };
      this.#dial();
    });
  }

  async request<T = Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.status !== "live") throw new DisconnectedError(this.#dead ?? "lost");
    const id = this.#next();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: v => resolve(v as T), reject });
      this.#raw({ id, op, ...params });
    });
  }

  subscribe(fn: (e: ProtocolEvent) => void): () => void {
    this.#listeners.add(fn);
    if (!this.#subscribed) { this.#subscribed = true; if (this.status === "live") this.#sendSubscribe(); }
    return () => this.#listeners.delete(fn);
  }

  #sendSubscribe(): void {
    this.#subscribeId = this.#next();
    this.#raw({
      id: this.#subscribeId,
      op: "events.subscribe",
      ...(this.#cursor !== undefined ? { after: this.#cursor } : {}),
      ...(this.#stream !== undefined ? { stream: this.#stream } : {}),
    });
  }

  #onSubscribed(msg: Record<string, unknown>): void {
    if (typeof msg.seq !== "number") return;
    const stream = typeof msg.stream === "string" ? msg.stream : undefined;
    const gap = msg.gap === true || (this.#stream !== undefined && stream !== undefined && stream !== this.#stream);
    if (gap || this.#cursor === undefined) this.#cursor = msg.seq;
    this.#stream = stream;
    if (gap) this.#opts.onGap?.();
  }

  close(): void { this.#die("closed"); }

  #next(): number { return ++this.#seq; }
  #raw(o: Record<string, unknown>): void { this.#ws?.send(JSON.stringify(o)); }
  #setStatus(s: ConnStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.#opts.onStatus?.(s);
  }

  #dial(): void {
    if (this.#dead) return;
    const ws = new this.#Ctor(this.#opts.url);
    this.#ws = ws;
    ws.onopen = () => this.#raw({ id: 0, op: "auth", token: this.#opts.token });
    ws.onmessage = e => { if (this.#ws === ws) this.#onMessage(String((e as MessageEvent).data)); };
    ws.onerror = () => {}; // a close event always follows
    ws.onclose = ev => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#failAll(new DisconnectedError("lost"));
      // 4401 is the runtime refusing the token; redialling cannot fix that.
      if (ev.code === 4401) this.#die("unauthorized");
      else this.#scheduleRedial();
    };
  }

  #scheduleRedial(): void {
    this.#setStatus(this.#everLive ? "reconnecting" : "connecting");
    this.#attempt++;
    this.#retryTimer = setTimeout(() => { this.#retryTimer = null; this.#dial(); }, this.#backoff(this.#attempt));
  }

  #onAuth(ok: boolean): void {
    if (!ok) { this.#die("unauthorized"); return; }
    this.#attempt = 0;
    this.#everLive = true;
    // Re-arm before the status flips so the store's refetches never race ahead of the subscription.
    if (this.#subscribed) this.#sendSubscribe();
    this.#setStatus("live");
    const first = this.#firstLive;
    this.#firstLive = null;
    first?.resolve();
  }

  /** Terminal: no socket, no redial. close() before the first live leaves connect() pending, since
   * nothing awaits a client that was thrown away and a rejection there would fault every unmount. */
  #die(reason: DisconnectReason): void {
    if (this.#dead) return;
    this.#dead = reason;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
    this.#failAll(new DisconnectedError(reason));
    this.#setStatus("closed");
    const first = this.#firstLive;
    this.#firstLive = null;
    if (reason === "unauthorized") first?.reject(new DisconnectedError(reason));
  }

  #onMessage(data: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg.type === "string" && !("ok" in msg)) { // server-push event
      if (typeof msg.seq === "number") this.#cursor = msg.seq;
      for (const fn of this.#listeners) fn(msg as unknown as ProtocolEvent);
      return;
    }
    const id = msg.id;
    if (id === 0) { this.#onAuth(msg.ok === true); return; }
    if (typeof id !== "number") return;
    if (id === this.#subscribeId) { this.#onSubscribed(msg); return; }
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    if (msg.ok === false) p.reject(new RequestError(String(msg.error ?? "request failed"), typeof msg.kind === "string" ? msg.kind : undefined));
    else p.resolve(msg);
  }

  #failAll(e: Error): void { for (const p of this.#pending.values()) p.reject(e); this.#pending.clear(); }
}

export interface Api {
  listWorkspaces(): Promise<WorkspaceView[]>;
  getWorkspace(id: string): Promise<WorkspaceView>;
  createWorkspace(golden: string, name?: string): Promise<CreatedWorkspace>;
  /** Resolves the default golden manifest's head so the UI never handles snapshot ids. */
  createFromGoldenHead(name: string): Promise<CreatedWorkspace>;
  /** Snapshot of enriched statuses; keeps the runtime's poller + cost ticker running for this socket. */
  watchStatuses(): Promise<WorkspaceStatus[]>;
  nap(id: string): Promise<WorkspaceView>;
  wake(id: string): Promise<WorkspaceView>;
  /** A person typed into the workspace; the runtime's idle window starts over. Optional so fixtures that never open a terminal need not fake it. */
  touch?(id: string): Promise<void>;
  /** Replaces the machine with a fresh golden fork at the new size; gate on capabilities().resize. */
  upgrade(id: string, size: WorkspaceSizeSpec): Promise<WorkspaceView>;
  /** Replaces a zombie's machine with a fresh golden fork carrying the vault; id and name stay. Optional so fixtures without a zombie need not fake it. */
  rebuild?(id: string): Promise<WorkspaceView>;
  /** Redeploys the daemon on the workspace's machine, replacing the one there; the link redials by itself. Optional so
   * fixtures with a current daemon need not fake it; the machine tab says so when a client lacks it. */
  updateDaemon?(id: string): Promise<void>;
  /** The guest ports the host forwards to this computer's loopback; forward.open and forward.close keep the list current. Optional so fixtures without forwards need not fake it. */
  listForwards?(): Promise<PortForward[]>;
  stopForward?(workspaceId: string, port: number): Promise<void>;
  capabilities(): Promise<Capabilities>;
  /** How to dial the workspace's daemon right now; ask again per dial, the edge token expires hourly. */
  daemonReach(id: string): Promise<DaemonReachView>;
  /** The public route to one guest port, for an iframe; the runtime remints near the hourly expiry, so ask again before expiresAt. */
  portReach(id: string, port: number): Promise<PortReachView>;
  /** What the host saw fetching that route once; the pane explains a refusal from it, since the frame cannot read its own
   * status. Without it the frame is the only truth. */
  portProbe?(id: string, port: number): Promise<PortProbeView>;
  /** One turn on the workspace; events arrive on the subscription, this resolves with the row. */
  startSession(opts: StartSessionOptions): Promise<SessionView>;
  /** All sessions the runtime knows, or one workspace's. */
  listSessions(id?: string): Promise<SessionView[]>;
  /** The workspace's persisted session events, oldest first: what a chat replays on mount. */
  sessionHistory(id: string): Promise<SessionEvent[]>;
  /** Stops the session's running turn; takes the runtime's session id (SessionView.id), not the harness id the events carry.
   * accepted means the turn's done is already on the wire; not-running and not-found are answers, not errors. Optional so
   * fixtures that never stop a turn need not fake it; the composer offers no stop without it. */
  interruptSession?(sessionId: string): Promise<SessionInterruptOutcome>;
  /** Sends a message into the session's running turn; takes the runtime's session id, as interruptSession does. accepted
   * means a session.steer event is on the wire; not-running means the turn beat it and the caller starts a turn instead.
   * Optional so fixtures without a steering harness need not fake it; the composer keeps the stop road without it. */
  steerSession?(sessionId: string, prompt: string, requestId: string): Promise<SessionSteerOutcome>;
  /** What each harness's CLI takes at launch; the composer's pickers render from it. With a workspace the runtime
   * asks the binaries on its machine, else its table answers. Optional so fixtures without pickers need not fake it;
   * without it the composer shows none. */
  listHarnesses?(workspaceId?: string): Promise<HarnessCatalog[]>;
  /** What importing a folder on this computer would carry; nothing is read into memory or uploaded. Optional so
   * fixtures that never import need not fake it; the sidebar offers no import without it. */
  planProject?(source: string): Promise<ProjectPlan>;
  /** Packs the folder and lands it on the workspace's machine; progress rides project.import events, this resolves
   * with what landed. carry and rewrite name paths from the plan's secrets; an existing dest is refused unless replace. */
  importProject?(opts: ImportProjectOptions): Promise<ProjectImportResult>;
  /** Brings a folder and the agent sessions keyed to it home from the workspace's machine; progress rides project.export
   * events, this resolves with what landed. An existing dest is refused (kind "exists") unless replace. Optional so
   * fixtures that never export need not fake it; the sidebar offers no export without it. */
  exportProject?(opts: ExportProjectOptions): Promise<ProjectExportResult>;
  subscribe(fn: (e: ProtocolEvent) => void): () => void;
  /** The named golden manifest, undefined on a fresh install: that absence is what points the page at wsp init. */
  getGolden(name?: string): Promise<GoldenManifest | undefined>;
  /** Every sealed version of a golden and the head new forks use. */
  listSnapshots(name?: string): Promise<SnapshotLineage>;
  /** Every snapshot on the account by count, size and monthly cost; null when the provider cannot list them. */
  snapshotStorage(): Promise<SnapshotStorage | null>;
  /** The workspace's cost ticks since the runtime began metering it, folded to the rate changes and the newest. Optional
   * so fixtures without a usage chart need not fake it; without it the chart starts with the next tick. */
  costHistory?(workspaceId: string): Promise<WorkspaceCostEvent[]>;
  /** Moves head to a version in the manifest; workspaces already forked keep their image. */
  rollbackSnapshot(version: number, name?: string): Promise<SnapshotRollbackResult>;
}

export interface WorkspaceSizeSpec {
  cpu?: number;
  memMb?: number;
}

export interface StartSessionOptions {
  workspaceId: string;
  prompt: string;
  /** Minted per send; the runtime stamps it on the turn's session.start, which is how the sender tells its own start
   * from another client's with the same text. */
  requestId?: string;
  harness?: string;
  resume?: string;
  cwd?: string;
  /** Values from the harness catalog; absent leaves the CLI's own default for that flag. */
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
}

export interface ImportProjectOptions {
  workspaceId: string;
  /** The folder on this computer as the person picked it; events echo this spelling. */
  source: string;
  /** Where it lands on the machine, absolute. */
  dest: string;
  replace?: boolean;
  carry?: string[];
  rewrite?: string[];
}

export interface ExportProjectOptions {
  workspaceId: string;
  /** The folder on the machine, absolute. */
  source: string;
  /** Where it lands on this computer, absolute; events echo this spelling. */
  dest: string;
  replace?: boolean;
  /** The agents whose sessions come home, by catalog id; absent, every agent with sessions for the folder. */
  agents?: string[];
}

/** The created view plus the runtime's notice when it stopped a builder kept after a save to make room. */
export interface CreatedWorkspace extends WorkspaceView {
  notice?: string;
}

export function makeApi(c: ProtocolClient): Api {
  const create = async (golden: string, name?: string): Promise<CreatedWorkspace> => {
    const { workspace, notice } = await c.request<WorkspaceCreateResult>("workspaces.create", { golden, ...(name ? { name } : {}) });
    return notice === undefined ? workspace : { ...workspace, notice };
  };
  return {
    listWorkspaces: async () => (await c.request<{ workspaces: WorkspaceView[] }>("workspaces.list")).workspaces,
    getWorkspace: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.get", { workspaceId: id })).workspace,
    createWorkspace: create,
    createFromGoldenHead: async name => {
      const { manifest } = await c.request<{ manifest?: GoldenManifest }>("golden.get", { name: "default" });
      const head = goldenHead(manifest);
      if (!head) throw new Error("no golden image yet; build one first (wspx golden build)");
      return create(head.snapshotId, name);
    },
    watchStatuses: async () => (await c.request<{ statuses: WorkspaceStatus[] }>("status.subscribe")).statuses,
    nap: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.nap", { workspaceId: id })).workspace,
    wake: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.wake", { workspaceId: id })).workspace,
    touch: async id => void (await c.request("workspaces.touch", { workspaceId: id })),
    upgrade: async (id, size) =>
      (await c.request<{ workspace: WorkspaceView }>("workspaces.upgrade", { workspaceId: id, ...size })).workspace,
    rebuild: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.rebuild", { workspaceId: id })).workspace,
    updateDaemon: async id => void (await c.request("workspaces.updateDaemon", { workspaceId: id })),
    // Parsed, not trusted: a reply without the list must not become the list.
    listForwards: async () => PortForward.array().parse((await c.request<{ forwards?: unknown }>("forwards.list")).forwards),
    stopForward: async (workspaceId, port) => void (await c.request("forwards.stop", { workspaceId, port })),
    capabilities: async () => (await c.request<{ capabilities: Capabilities }>("capabilities.get")).capabilities,
    daemonReach: async id => (await c.request<{ reach: DaemonReachView }>("workspaces.daemonReach", { workspaceId: id })).reach,
    portReach: async (id, port) => (await c.request<{ reach: PortReachView }>("workspaces.portReach", { workspaceId: id, port })).reach,
    portProbe: async (id, port) => (await c.request<{ probe: PortProbeView }>("workspaces.portProbe", { workspaceId: id, port })).probe,
    startSession: async opts => (await c.request<{ session: SessionView }>("sessions.start", { ...opts })).session,
    sessionHistory: async id => (await c.request<{ events: SessionEvent[] }>("sessions.history", { workspaceId: id })).events,
    listSessions: async id =>
      (await c.request<{ sessions: SessionView[] }>("sessions.list", id !== undefined ? { workspaceId: id } : {})).sessions,
    // Parsed, not trusted: an outcome outside the enum must not read as accepted.
    interruptSession: async sessionId =>
      SessionInterruptOutcome.parse((await c.request<{ outcome?: unknown }>("sessions.interrupt", { sessionId })).outcome),
    steerSession: async (sessionId, prompt, requestId) =>
      SessionSteerOutcome.parse((await c.request<{ outcome?: unknown }>("sessions.steer", { sessionId, prompt, requestId })).outcome),
    // Parsed, not trusted: a picker renders only values the wire type vouches for.
    listHarnesses: async workspaceId =>
      HarnessCatalog.array().parse((await c.request<{ harnesses?: unknown }>("harnesses.list", workspaceId !== undefined ? { workspaceId } : {})).harnesses),
    // Parsed, not trusted: the consent step renders only what the wire type vouches for.
    planProject: async source => ProjectPlan.parse((await c.request<{ plan?: unknown }>("project.plan", { source })).plan),
    importProject: async opts => ProjectImportResult.parse((await c.request<{ imported?: unknown }>("project.import", { ...opts })).imported),
    exportProject: async opts => ProjectExportResult.parse((await c.request<{ exported?: unknown }>("project.export", { ...opts })).exported),
    subscribe: fn => c.subscribe(fn),
    getGolden: async (name = "default") => (await c.request<{ manifest?: GoldenManifest }>("golden.get", { name })).manifest,
    listSnapshots: async name =>
      (await c.request<{ lineage: SnapshotLineage }>("snapshots.list", name !== undefined ? { name } : {})).lineage,
    snapshotStorage: async () => (await c.request<{ storage: SnapshotStorage | null }>("snapshots.storage")).storage,
    // Parsed, not trusted: the chart interpolates whatever numbers it is handed.
    costHistory: async workspaceId => WorkspaceCostEvent.array().parse((await c.request<{ points?: unknown }>("cost.history", { workspaceId })).points),
    rollbackSnapshot: async (version, name) => {
      const { lineage, existingWorkspaces } = await c.request<SnapshotRollbackResult>("snapshots.rollback", {
        version,
        ...(name !== undefined ? { name } : {}),
      });
      return { lineage, existingWorkspaces };
    },
  };
}
