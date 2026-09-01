// SPDX-License-Identifier: AGPL-3.0-only
// Browser-side client for the runtime WS (see packages/runtime/src/serve.ts).
// Auth: open the socket, send one `auth` frame with the token (host injects it
// via window.__WSP__), then ops flow. The token never rides in the URL.
import type { Capabilities, DaemonReachView, EventUnion, SessionEvent, SessionView, WorkspaceStatus, WorkspaceView, SnapshotLineage, SnapshotRollbackResult } from "@wsp/protocol";

export type ProtocolEvent = EventUnion;
type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

export interface ProtocolClientOptions {
  url: string;
  token: string;
  WebSocketCtor?: typeof WebSocket;
  onStatus?: (s: ConnStatus) => void;
}
export type ConnStatus = "connecting" | "live" | "reauth" | "closed";

export class ProtocolClient {
  #ws: WebSocket | null = null;
  #seq = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(e: ProtocolEvent) => void>();
  #opts: ProtocolClientOptions;
  #Ctor: typeof WebSocket;
  #subscribed = false;
  status: ConnStatus = "connecting";

  constructor(opts: ProtocolClientOptions) {
    this.#opts = opts;
    this.#Ctor = opts.WebSocketCtor ?? globalThis.WebSocket;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#setStatus("connecting");
      const ws = new this.#Ctor(this.#opts.url);
      this.#ws = ws;
      ws.onmessage = e => this.#onMessage(String((e as MessageEvent).data));
      ws.onclose = () => { this.#setStatus("closed"); this.#failAll(new Error("socket closed")); };
      ws.onerror = () => reject(new Error("socket error"));
      ws.onopen = () => {
        // auth frame, id 0, resolves connect
        this.#raw({ id: 0, op: "auth", token: this.#opts.token });
        this.#pending.set(0, {
          resolve: () => { this.#setStatus("live"); if (this.#subscribed) this.#raw({ id: this.#next(), op: "events.subscribe" }); resolve(); },
          reject: () => { this.#setStatus("reauth"); reject(new Error("auth rejected")); },
        });
      };
    });
  }

  async request<T = Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> {
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

  close(): void { this.#ws?.close(); }

  #next(): number { return ++this.#seq; }
  #raw(o: Record<string, unknown>): void { this.#ws?.send(JSON.stringify(o)); }
  #setStatus(s: ConnStatus): void { this.status = s; this.#opts.onStatus?.(s); }

  #onMessage(data: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg.type === "string" && !("ok" in msg)) { // server-push event
      for (const fn of this.#listeners) fn(msg as unknown as ProtocolEvent);
      return;
    }
    const id = msg.id as number | null;
    if (id === null || id === undefined) return;
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
  /** One turn on the workspace; events arrive on the subscription, this resolves with the row. */
  startSession(opts: StartSessionOptions): Promise<SessionView>;
  /** All sessions the runtime knows, or one workspace's. */
  listSessions(id?: string): Promise<SessionView[]>;
  /** The workspace's persisted session events, oldest first: what a chat replays on mount. */
  sessionHistory(id: string): Promise<SessionEvent[]>;
  subscribe(fn: (e: ProtocolEvent) => void): () => void;
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

interface GoldenManifestWire {
  head: number;
  versions: { version: number; snapshotId: string }[];
}

export function makeApi(c: ProtocolClient): Api {
  const create = async (golden: string, name?: string) =>
    (await c.request<{ workspace: WorkspaceView }>("workspaces.create", { golden, ...(name ? { name } : {}) })).workspace;
  return {
    listWorkspaces: async () => (await c.request<{ workspaces: WorkspaceView[] }>("workspaces.list")).workspaces,
    getWorkspace: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.get", { workspaceId: id })).workspace,
    createWorkspace: create,
    createFromGoldenHead: async name => {
      const { manifest } = await c.request<{ manifest?: GoldenManifestWire }>("golden.get", { name: "default" });
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
    startSession: async opts => (await c.request<{ session: SessionView }>("sessions.start", { ...opts })).session,
    sessionHistory: async id => (await c.request<{ events: SessionEvent[] }>("sessions.history", { workspaceId: id })).events,
    listSessions: async id =>
      (await c.request<{ sessions: SessionView[] }>("sessions.list", id !== undefined ? { workspaceId: id } : {})).sessions,
    subscribe: fn => c.subscribe(fn),
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
