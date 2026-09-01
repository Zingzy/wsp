// SPDX-License-Identifier: AGPL-3.0-only
// Resilient client for the in-VM daemon over a Solari previewUrl. The edge
// idle-sweeps quiet connections (~30s) and browsers cannot protocol-ping, so
// liveness is an app-level ping op; every (re)connect re-subscribes and
// rescans the inbox because events pushed during a gap are gone for good.

import { DaemonEvent, type DaemonLinkStatus } from "@wsp/protocol";
import WebSocket from "ws";

export interface ReachOptions {
  /** Solari previewUrl (https, pt_token already embedded) or a ws:// url in tests. */
  previewUrl: string;
  /** The daemon's own token, appended as the `token` query param. */
  token: string;
  onEvent: (e: DaemonEvent) => void;
  /** Fires on every transition; reauth-needed and dead are terminal. */
  onStatus?: (s: DaemonLinkStatus) => void;
  heartbeatMs?: number;
  backoffMs?: (attempt: number) => number;
}

export interface ReachStats {
  pingsSent: number;
  pongsReceived: number;
  reconnects: number;
}

export interface DaemonReach {
  /** Resolves after the first successful connect + subscribe + rescan; rejects on 4401. */
  readonly ready: Promise<void>;
  request(op: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(): DaemonLinkStatus;
  stats(): ReachStats;
  close(): void;
}

/** previewUrl → dialable ws(s) url carrying both the edge pt_token and our token. */
export function daemonWsUrl(previewUrl: string, token: string): string {
  const url = new URL(previewUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const defaultBackoff = (attempt: number): number => Math.min(10_000, 500 * 2 ** (attempt - 1));

interface Pending {
  resolve: (m: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

export function connectDaemon(opts: ReachOptions): DaemonReach {
  const url = daemonWsUrl(opts.previewUrl, opts.token);
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const backoff = opts.backoffMs ?? defaultBackoff;

  let ws: WebSocket | null = null;
  let closed = false;
  let nextId = 1;
  let attempt = 0;
  let connections = 0;
  let awaitingPong = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  const pending = new Map<number, Pending>();
  const stats: ReachStats = { pingsSent: 0, pongsReceived: 0, reconnects: 0 };

  let status!: DaemonLinkStatus;
  function setStatus(s: DaemonLinkStatus): void {
    if (s === status) return;
    status = s;
    opts.onStatus?.(s);
  }

  let readyResolve!: () => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {}); // a caller that never awaits ready must not crash the process

  function send(op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) return Promise.reject(new Error("daemon unreachable"));
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

  function startHeartbeat(sock: WebSocket): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (awaitingPong) {
        sock.terminate(); // no ack within a full beat: the socket is half-dead
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
    retryTimer = setTimeout(dial, backoff(attempt));
  }

  async function ritual(sock: WebSocket): Promise<void> {
    try {
      await send("ports.watch");
      await send("inbox.watch");
      await send("inbox.rescan");
    } catch {
      return; // connection died mid-ritual; the close handler redials
    }
    if (ws !== sock || closed) return;
    attempt = 0;
    connections++;
    stats.reconnects = connections - 1;
    startHeartbeat(sock);
    setStatus("live");
    readyResolve();
  }

  function dial(): void {
    if (closed) return;
    setStatus("connecting");
    const sock = new WebSocket(url);
    ws = sock;
    sock.addEventListener("open", () => void ritual(sock));
    sock.addEventListener("message", ev => handleMessage(ev.data));
    sock.addEventListener("error", () => {}); // a close event always follows
    sock.addEventListener("close", ev => {
      if (ws !== sock) return; // an already-replaced socket
      stopHeartbeat();
      flushPending("connection lost");
      if (closed) return;
      if (ev.code === 4401) {
        setStatus("reauth-needed"); // retrying cannot fix a bad token; a new one must be provisioned
        readyReject(new Error("daemon rejected token (4401)")); // no-op once ready resolved
        return;
      }
      scheduleReconnect();
    });
  }

  dial();

  return {
    ready,
    request: send,
    status: () => status,
    stats: () => ({ ...stats }),
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      stopHeartbeat();
      flushPending("client closed");
      ws?.close(1000);
      setStatus("dead");
      readyReject(new Error("client closed")); // no-op once ready resolved
    },
  };
}
