// SPDX-License-Identifier: AGPL-3.0-only
// Browser-side client for the runtime WS (see packages/runtime/src/serve.ts).
// Auth: open the socket, send one `auth` frame with the token (host injects it
// via window.__WSP__), then ops flow. The token never rides in the URL.
import type { EventUnion, SessionView, WorkspaceView } from "@wsp/protocol";

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
  nap(id: string): Promise<WorkspaceView>;
  wake(id: string): Promise<WorkspaceView>;
  listSessions(id: string): Promise<SessionView[]>;
  subscribe(fn: (e: ProtocolEvent) => void): () => void;
}

export function makeApi(c: ProtocolClient): Api {
  return {
    listWorkspaces: async () => (await c.request<{ workspaces: WorkspaceView[] }>("workspaces.list")).workspaces,
    getWorkspace: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.get", { workspaceId: id })).workspace,
    createWorkspace: async (golden, name) => (await c.request<{ workspace: WorkspaceView }>("workspaces.create", { golden, ...(name ? { name } : {}) })).workspace,
    nap: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.nap", { workspaceId: id })).workspace,
    wake: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.wake", { workspaceId: id })).workspace,
    listSessions: async id => (await c.request<{ sessions: SessionView[] }>("sessions.list", { workspaceId: id })).sessions,
    subscribe: fn => c.subscribe(fn),
  };
}
