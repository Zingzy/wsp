// SPDX-License-Identifier: AGPL-3.0-only
// The browser's link to one workspace's daemon, carried by the host over the
// socket this page already holds: the host dials the road the workspace's kind
// answers with and relays the frames, so the daemon's token and its minted
// route never leave the host and no page dials a machine's edge. The edge rules
// still hold under it: the edge idle-sweeps quiet sockets (~30s) and browsers
// cannot protocol-ping, so liveness is an app-level ping op, and every channel
// is fresh, so the pane re-subscribes on every live transition.
import { DaemonErrorCode, DaemonEvent, type DaemonChannelEvent, type DaemonLinkStatus } from "@wsp/protocol";
import type { DaemonApi } from "../protocol/client.js";
import { errorText } from "../lib/utils.js";
import type { TerminalWire } from "./link.js";

/** The daemon refused a request; code is set when the op sends a typed one (files and diff ops do). */
export class DaemonRequestError extends Error {
  readonly code: DaemonErrorCode | undefined;
  constructor(message: string, code: DaemonErrorCode | undefined) {
    super(message);
    this.name = "DaemonRequestError";
    this.code = code;
  }
}

export interface DaemonLinkOptions {
  daemon: DaemonApi;
  workspaceId: string;
  onEvent(e: DaemonEvent): void;
  /** Fires on every transition, with the door's sentence when the status is refused; dead is terminal. */
  onStatus?(s: DaemonLinkStatus, refusal?: string): void;
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
  /** The door's own sentence while the status is refused, else null. */
  refusal(): string | null;
  stats(): DaemonLinkStats;
  close(): void;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const defaultBackoff = (attempt: number): number => Math.min(10_000, 500 * 2 ** (attempt - 1));
/** What a refused link waits: no retry at the usual pace opens a door that answered with a status, so every dial
 * after one is spaced at the backoff's ceiling until something past the door answers. */
const REFUSED_ATTEMPT = 32;

interface Waiting {
  reject: (e: Error) => void;
}

export function connectDaemonLink(opts: DaemonLinkOptions): DaemonLink {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const backoff = opts.backoffMs ?? defaultBackoff;

  /** The channel the host answered the last dial with, until it is dropped. */
  let channel: string | null = null;
  /** The channel a ping has come back on: what a request may be put on. */
  let proven: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  let attempt = 0;
  let connections = 0;
  let awaitingPong = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<Waiting>();
  const stats: DaemonLinkStats = { pingsSent: 0, pongsReceived: 0, reconnects: 0 };

  let status!: DaemonLinkStatus;
  let refusal: string | null = null;
  function setStatus(s: DaemonLinkStatus, sentence: string | null = null): void {
    const said = s === "refused" ? sentence : null;
    if (s === status && said === refusal) return;
    status = s;
    refusal = said;
    opts.onStatus?.(s, said ?? undefined);
  }

  function flushPending(reason: string): void {
    for (const p of pending) p.reject(new Error(reason));
    pending.clear();
  }

  /** One frame down a proven channel, with the daemon's own refusal raised as the error it always was. */
  function sendOn(on: string, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const waiting: Waiting = { reject };
      pending.add(waiting);
      opts.daemon.send(on, frame as Parameters<DaemonApi["send"]>[1]).then(
        reply => {
          pending.delete(waiting);
          if (reply.ok === true) resolve(reply as Record<string, unknown>);
          else {
            const code = DaemonErrorCode.safeParse((reply as { code?: unknown }).code);
            reject(new DaemonRequestError(String((reply as { error?: unknown }).error ?? "daemon error"), code.success ? code.data : undefined));
          }
        },
        (e: unknown) => {
          pending.delete(waiting);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  function request(op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const on = proven;
    if (on === null) return Promise.reject(new Error("daemon unreachable"));
    return sendOn(on, { op, ...params });
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    awaitingPong = false;
  }

  /** Lets go of a channel locally; the host is told separately when we are the ones ending it. */
  function drop(): void {
    unsubscribe?.();
    unsubscribe = null;
    channel = null;
    proven = null;
    stopHeartbeat();
  }

  /** A channel we no longer trust: the host is asked to end it, and the next dial opens a fresh one. */
  function abandon(on: string): void {
    if (channel !== on) return;
    drop();
    flushPending("connection lost");
    void opts.daemon.close(on).catch(() => {});
    if (closed) return;
    setStatus("connecting");
    scheduleRetry();
  }

  function scheduleRetry(at = ++attempt): void {
    if (closed) return;
    retryTimer = setTimeout(() => void dial(), backoff(at));
  }

  function onFrame(e: DaemonChannelEvent): void {
    if (e.channel !== channel) return;
    if (e.type === "daemon.event") {
      // Validated here as it always was: a daemon of another version may push a type this app does not know.
      const parsed = DaemonEvent.safeParse(e.event);
      if (parsed.success) opts.onEvent(parsed.data);
      return;
    }
    drop();
    flushPending("connection lost");
    if (closed) return;
    // The host rotates the token on every start; the next dial carries what it holds now.
    setStatus(e.code === 4401 ? "reauth-needed" : "connecting");
    scheduleRetry();
  }

  function startHeartbeat(on: string): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (awaitingPong) {
        abandon(on); // no ack within a full beat: the channel is half-dead
        return;
      }
      awaitingPong = true;
      stats.pingsSent++;
      request("ping").then(
        () => {
          stats.pongsReceived++;
          awaitingPong = false;
        },
        () => {}, // the closed frame or the next beat owns recovery
      );
    }, heartbeatMs);
  }

  async function dial(): Promise<void> {
    if (closed) return;
    retryTimer = null;
    // A door that answered with a status keeps its sentence while the dials go on: nothing here is reconnecting.
    if (status !== "refused") setStatus("connecting");
    let opened: { channel: string };
    try {
      opened = await opts.daemon.open(opts.workspaceId);
    } catch (e) {
      if (closed) return;
      const kind = (e as { kind?: unknown }).kind;
      if (kind === "refused") {
        setStatus("refused", errorText(e));
        scheduleRetry(REFUSED_ATTEMPT);
        return;
      }
      // A 4401 means the dial got through and the daemon answered, so a refusal is over even when one was held.
      if (kind === "reauth") {
        setStatus("reauth-needed");
        scheduleRetry();
        return;
      }
      // Nothing got past the door, so a dial that failed for a reason of the host's own does not turn a refusal
      // into a reconnect the person can wait out; the sentence and the ceiling stand until something opens.
      if (status === "refused") {
        scheduleRetry(REFUSED_ATTEMPT);
        return;
      }
      setStatus("connecting");
      scheduleRetry();
      return;
    }
    if (closed) {
      void opts.daemon.close(opened.channel).catch(() => {});
      return;
    }
    channel = opened.channel;
    unsubscribe = opts.daemon.onFrame(opened.channel, onFrame);
    // A ping before live, as a direct dial always did: a channel that dies on opening never flaps through live.
    try {
      await sendOn(opened.channel, { op: "ping" });
    } catch {
      abandon(opened.channel);
      return;
    }
    if (channel !== opened.channel || closed) return;
    attempt = 0;
    connections++;
    stats.reconnects = connections - 1;
    proven = opened.channel;
    startHeartbeat(opened.channel);
    setStatus("live");
  }

  void dial();

  return {
    request,
    status: () => status,
    refusal: () => refusal,
    stats: () => ({ ...stats }),
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const on = channel;
      drop();
      flushPending("client closed");
      if (on !== null) void opts.daemon.close(on).catch(() => {});
      setStatus("dead");
    },
  };
}
