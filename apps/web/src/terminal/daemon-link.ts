// SPDX-License-Identifier: AGPL-3.0-only
// The browser's link to one workspace's daemon; the counterpart of the
// runtime's reach client (packages/runtime/src/reach.ts), which the web cannot
// import because it is built on the ws package. Same measured rules: the edge
// idle-sweeps quiet sockets (~30s) and browsers cannot protocol-ping, so
// liveness is an app-level ping op; every redial asks the runtime for a fresh
// reach because the edge token expires hourly; 4401 is terminal, retrying
// cannot fix a wrong token.
import { DaemonEvent, type DaemonLinkStatus } from "@wsp/protocol";
import type { TerminalWire } from "./link.js";

export interface DaemonReachTarget {
  url: string;
  /** Missing while the guest has no daemon token file; the link waits and asks again. */
  daemonToken?: string;
}

export interface DaemonLinkOptions {
  reach(): Promise<DaemonReachTarget>;
  onEvent(e: DaemonEvent): void;
  /** Fires on every transition; reauth-needed and dead are terminal. */
  onStatus?(s: DaemonLinkStatus): void;
  WebSocketCtor?: typeof WebSocket;
  heartbeatMs?: number;
  backoffMs?: (attempt: number) => number;
}

export interface DaemonLinkStats {
  pingsSent: number;
  pongsReceived: number;
  reconnects: number;
}

export interface DaemonLink extends TerminalWire {
  status(): DaemonLinkStatus;
  stats(): DaemonLinkStats;
  close(): void;
}

/** previewUrl → dialable ws(s) url carrying both the edge token and the daemon's. */
export function daemonSocketUrl(previewUrl: string, daemonToken: string): string {
  const url = new URL(previewUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  url.searchParams.set("token", daemonToken);
  return url.toString();
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const defaultBackoff = (attempt: number): number => Math.min(10_000, 500 * 2 ** (attempt - 1));

interface Pending {
  resolve: (m: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

export function connectDaemonLink(opts: DaemonLinkOptions): DaemonLink {
  const Ctor = opts.WebSocketCtor ?? globalThis.WebSocket;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const backoff = opts.backoffMs ?? defaultBackoff;

  let ws: WebSocket | null = null;
  let closed = false;
  let nextId = 1;
  let attempt = 0;
  let connections = 0;
  let awaitingPong = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, Pending>();
  const stats: DaemonLinkStats = { pingsSent: 0, pongsReceived: 0, reconnects: 0 };

  let status!: DaemonLinkStatus;
  function setStatus(s: DaemonLinkStatus): void {
    if (s === status) return;
    status = s;
    opts.onStatus?.(s);
  }

  function send(op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const sock = ws;
    if (!sock || sock.readyState !== 1) return Promise.reject(new Error("daemon unreachable"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sock.send(JSON.stringify({ id, op, ...params }));
    });
  }

  function flushPending(reason: string): void {
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    awaitingPong = false;
  }

  /** Drop a socket we no longer trust; its close event, whenever it comes, is ignored. */
  function abandon(sock: WebSocket): void {
    if (ws !== sock) return;
    ws = null;
    stopHeartbeat();
    flushPending("connection lost");
    sock.close();
    scheduleReconnect();
  }

  function startHeartbeat(sock: WebSocket): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (awaitingPong) {
        abandon(sock); // no ack within a full beat: the socket is half-dead
        return;
      }
      awaitingPong = true;
      stats.pingsSent++;
      send("ping").then(
        () => {
          stats.pongsReceived++;
          awaitingPong = false;
        },
        () => {}, // the close handler owns recovery
      );
    }, heartbeatMs);
  }

  function handleMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id === "number" && pending.has(id)) {
      const p = pending.get(id)!;
      pending.delete(id);
      if (msg["ok"] === true) p.resolve(msg);
      else p.reject(new Error(String(msg["error"] ?? "daemon error")));
      return;
    }
    const parsed = DaemonEvent.safeParse(msg);
    if (parsed.success) opts.onEvent(parsed.data);
  }

  function scheduleReconnect(): void {
    if (closed) return;
    setStatus("connecting");
    attempt++;
    retryTimer = setTimeout(() => void dial(), backoff(attempt));
  }

  async function dial(): Promise<void> {
    if (closed) return;
    setStatus("connecting");
    let target: DaemonReachTarget;
    try {
      target = await opts.reach();
    } catch {
      scheduleReconnect();
      return;
    }
    if (closed) return;
    if (target.daemonToken === undefined) {
      scheduleReconnect();
      return;
    }
    const sock = new Ctor(daemonSocketUrl(target.url, target.daemonToken));
    ws = sock;
    sock.onopen = () => {
      // Live only once the daemon answers: a 4401 close follows the open
      // event, and that must not flap through live first.
      send("ping").then(
        () => {
          if (ws !== sock || closed) return;
          attempt = 0;
          connections++;
          stats.reconnects = connections - 1;
          startHeartbeat(sock);
          setStatus("live");
        },
        () => {},
      );
    };
    sock.onmessage = ev => handleMessage(ev.data);
    sock.onerror = () => {}; // a close event always follows
    sock.onclose = ev => {
      if (ws !== sock) return;
      ws = null;
      stopHeartbeat();
      flushPending("connection lost");
      if (closed) return;
      if (ev.code === 4401) {
        setStatus("reauth-needed");
        return;
      }
      scheduleReconnect();
    };
  }

  void dial();

  return {
    request: send,
    status: () => status,
    stats: () => ({ ...stats }),
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      stopHeartbeat();
      flushPending("client closed");
      const sock = ws;
      ws = null;
      sock?.close(1000);
      setStatus("dead");
    },
  };
}
