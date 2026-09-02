// SPDX-License-Identifier: AGPL-3.0-only
// Browser-side client for the runtime WS (see packages/runtime/src/serve.ts).
// Auth: open the socket, send one `auth` frame with the token (host injects it
// via window.__WSP__), then ops flow. The token never rides in the URL. A
// dropped socket is redialled with backoff and authed again with the same
// token; the store re-runs its standing fetches when the status comes back
// to live.
import type {
  Capabilities,
  DaemonReachView,
  EventUnion,
  GoldenBuilderView,
  GoldenManifest,
  GoldenVersion,
  PortReachView,
  SessionEvent,
  SessionView,
  SnapshotLineage,
  SnapshotRollbackResult,
  WorkspaceStatus,
  WorkspaceView,
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
    if (!this.#subscribed) { this.#subscribed = true; if (this.status === "live") this.#raw({ id: this.#next(), op: "events.subscribe" }); }
    return () => this.#listeners.delete(fn);
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
    if (this.#subscribed) this.#raw({ id: this.#next(), op: "events.subscribe" });
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
      for (const fn of this.#listeners) fn(msg as unknown as ProtocolEvent);
      return;
    }
    const id = msg.id;
    if (id === 0) { this.#onAuth(msg.ok === true); return; }
    if (typeof id !== "number") return;
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    if (msg.ok === false) p.reject(new Error(String(msg.error ?? "request failed")));
    else p.resolve(msg);
  }

  #failAll(e: Error): void { for (const p of this.#pending.values()) p.reject(e); this.#pending.clear(); }
}

export interface Api {
  listWorkspaces(): Promise<WorkspaceView[]>;
  getWorkspace(id: string): Promise<WorkspaceView>;
  createWorkspace(golden: string, name?: string): Promise<WorkspaceView>;
  /** Resolves the default golden manifest's head so the UI never handles snapshot ids. */
  createFromGoldenHead(name: string): Promise<WorkspaceView>;
  /** Snapshot of enriched statuses; keeps the runtime's poller + cost ticker running for this socket. */
  watchStatuses(): Promise<WorkspaceStatus[]>;
  nap(id: string): Promise<WorkspaceView>;
  wake(id: string): Promise<WorkspaceView>;
  /** Replaces the machine with a fresh golden fork at the new size; gate on capabilities().resize. */
  upgrade(id: string, size: WorkspaceSizeSpec): Promise<WorkspaceView>;
  capabilities(): Promise<Capabilities>;
  /** How to dial the workspace's daemon right now; ask again per dial, the edge token expires hourly. */
  daemonReach(id: string): Promise<DaemonReachView>;
  /** The public route to one guest port, for an iframe; the runtime remints near the hourly expiry, so ask again before expiresAt. */
  portReach(id: string, port: number): Promise<PortReachView>;
  /** One turn on the workspace; events arrive on the subscription, this resolves with the row. */
  startSession(opts: StartSessionOptions): Promise<SessionView>;
  /** All sessions the runtime knows, or one workspace's. */
  listSessions(id?: string): Promise<SessionView[]>;
  /** The workspace's persisted session events, oldest first: what a chat replays on mount. */
  sessionHistory(id: string): Promise<SessionEvent[]>;
  subscribe(fn: (e: ProtocolEvent) => void): () => void;
  /** The named golden manifest, undefined on a fresh install: that absence is what opens the first-run wizard. */
  getGolden(name?: string): Promise<GoldenManifest | undefined>;
  /** Boots the wizard's builder; progress arrives as golden.stage events on the subscription. */
  prepareGolden(name?: string): Promise<GoldenBuilderView>;
  /** Snapshots the builder, smoke-tests a fork, seals a version. The builder is consumed on every outcome. */
  sealGolden(builderId: string): Promise<{ manifest: GoldenManifest; version: GoldenVersion }>;
  /** How to dial the builder's daemon right now; asked per dial like daemonReach. */
  builderReach(builderId: string): Promise<DaemonReachView>;
  /** Every sealed version of a golden and the head new forks use. */
  listSnapshots(name?: string): Promise<SnapshotLineage>;
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
  harness?: string;
  resume?: string;
  cwd?: string;
}

export function makeApi(c: ProtocolClient): Api {
  const create = async (golden: string, name?: string) =>
    (await c.request<{ workspace: WorkspaceView }>("workspaces.create", { golden, ...(name ? { name } : {}) })).workspace;
  return {
    listWorkspaces: async () => (await c.request<{ workspaces: WorkspaceView[] }>("workspaces.list")).workspaces,
    getWorkspace: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.get", { workspaceId: id })).workspace,
    createWorkspace: create,
    createFromGoldenHead: async name => {
      const { manifest } = await c.request<{ manifest?: GoldenManifest }>("golden.get", { name: "default" });
      const head = manifest?.versions.find(v => v.version === manifest.head);
      if (!head) throw new Error("no golden image yet; build one first (wspx golden build)");
      return create(head.snapshotId, name);
    },
    watchStatuses: async () => (await c.request<{ statuses: WorkspaceStatus[] }>("status.subscribe")).statuses,
    nap: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.nap", { workspaceId: id })).workspace,
    wake: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.wake", { workspaceId: id })).workspace,
    upgrade: async (id, size) =>
      (await c.request<{ workspace: WorkspaceView }>("workspaces.upgrade", { workspaceId: id, ...size })).workspace,
    capabilities: async () => (await c.request<{ capabilities: Capabilities }>("capabilities.get")).capabilities,
    daemonReach: async id => (await c.request<{ reach: DaemonReachView }>("workspaces.daemonReach", { workspaceId: id })).reach,
    portReach: async (id, port) => (await c.request<{ reach: PortReachView }>("workspaces.portReach", { workspaceId: id, port })).reach,
    startSession: async opts => (await c.request<{ session: SessionView }>("sessions.start", { ...opts })).session,
    sessionHistory: async id => (await c.request<{ events: SessionEvent[] }>("sessions.history", { workspaceId: id })).events,
    listSessions: async id =>
      (await c.request<{ sessions: SessionView[] }>("sessions.list", id !== undefined ? { workspaceId: id } : {})).sessions,
    subscribe: fn => c.subscribe(fn),
    getGolden: async (name = "default") => (await c.request<{ manifest?: GoldenManifest }>("golden.get", { name })).manifest,
    prepareGolden: async (name = "default") => (await c.request<{ builder: GoldenBuilderView }>("golden.prepare", { name })).builder,
    sealGolden: async builderId => {
      const { manifest, version } = await c.request<{ manifest: GoldenManifest; version: GoldenVersion }>("golden.seal", { builderId });
      return { manifest, version };
    },
    builderReach: async builderId => (await c.request<{ reach: DaemonReachView }>("golden.builderReach", { builderId })).reach,
    listSnapshots: async name =>
      (await c.request<{ lineage: SnapshotLineage }>("snapshots.list", name !== undefined ? { name } : {})).lineage,
    rollbackSnapshot: async (version, name) => {
      const { lineage, existingWorkspaces } = await c.request<SnapshotRollbackResult>("snapshots.rollback", {
        version,
        ...(name !== undefined ? { name } : {}),
      });
      return { lineage, existingWorkspaces };
    },
  };
}
