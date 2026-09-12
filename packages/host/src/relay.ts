// SPDX-License-Identifier: AGPL-3.0-only
// The laptop half of the sign-in callback relay and of the localhost forwards.
// One daemon link per running workspace (and the init builder): a browser.open
// from the guest is shown by the app (opened here only when autoOpen says so),
// and the flow's callback port is listened on locally and tunnelled back over
// that link for a bounded window. A local URL the guest printed forwards its
// port the same way, one per port, until it sees no traffic for a while. The
// URL is never logged.

import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { platform } from "node:os";
import { DaemonEvent, LOOPBACK, hostOf, isHttpUrl, type DaemonReachView, type ForwardEvent, type GoldenBuilderView, type PortForward } from "@wsp/protocol";
import { plumbTunnel, realClock, tunnelFrame, type Clock, type EventUnion, type Runtime } from "@wsp/runtime";
import { DAEMON_CONNECT_TIMEOUT_MS, connectDaemonSocket, type ConnectOptions, type DaemonSocket } from "./doctor.js";

export type UrlOpener = (url: string) => Promise<boolean>;

/** The command this computer opens a page with; the sign-in hand-off prints it for the person to run. */
export function openerCommand(os: NodeJS.Platform = platform()): string {
  return os === "darwin" ? "open" : os === "win32" ? "explorer" : "xdg-open";
}

/** Runs the platform opener and reports whether it exited clean. */
export function systemOpener(os: NodeJS.Platform = platform()): UrlOpener {
  const cmd = openerCommand(os);
  return url =>
    new Promise(resolve => {
      const child = spawn(cmd, [url], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", code => resolve(code === 0));
    });
}

export interface RelayOptions {
  runtime: Runtime;
  /** Opens an http(s) URL on this computer; used only when autoOpen says so. */
  openUrl: UrlOpener;
  /** Whether a browser.open from this target opens without a click. Off by
   * default: the app shows the page and the person opens it. A flow started
   * from the TUI is the case that turns it on (the caller decides). Asked once
   * per event, right before openUrl runs, so a caller that clears its arm
   * inside openUrl is one-shot without a race. Given the callback port when
   * the page names one, so a caller that declines can keep that page for a
   * later click. */
  autoOpen?: (targetId: string, url: string, port?: number) => boolean;
  /** The one line logged when a page arrives and nothing opens, given the workspace name and the URL's hostname; the TUI supplies its own. */
  openLine?: (workspace: string, hostname: string, url: string) => string;
  /** One line per open, forward, refusal and close; never the URL. */
  log: (line: string) => void;
  builder?: GoldenBuilderView;
  clock?: Clock;
  /** A forward whose port the guest was never seen listening on closes after this. Default 3 min. */
  windowMs?: number;
  /** No callback forward lives longer than this, listener or not. Default 15 min. */
  capMs?: number;
  /** A forward for a printed local URL closes after this long with no connection and no bytes. Default 10 min. */
  idleMs?: number;
  connect?: (opts: ConnectOptions) => Promise<DaemonSocket>;
  /** First redial pause after a link drops; doubles per failed attempt up to 30 s. Default 2 s. */
  retryMs?: number;
  /** Laptop addresses to listen on; both loopback families by default. Tests bind one so the fake guest can hold the other. */
  listenHosts?: string[];
  /** A fraction in [0, 1) added to each redial wait (up to half again), so links through one edge do not redial in lockstep. */
  jitter?: () => number;
}

/** callback: a sign-in flow's redirect port, one per workspace, keyed on the guest listener's life.
 * url: a port a printed local URL named, one per port per workspace, kept while traffic flows. */
export type ForwardKind = "callback" | "url";

export interface ForwardView {
  targetId: string;
  port: number;
  kind: ForwardKind;
  /** The guest has been seen listening on the port; a callback forward then lives until that listener closes or the cap. */
  listener: boolean;
  expiresAt: number;
}

export interface CallbackRelay {
  forwards(): ForwardView[];
  /** The open forwards as the app lists them. */
  list(): PortForward[];
  /** Closes one forward from the app; false when none is open there. */
  stop(targetId: string, port: number): boolean;
  /** Hears every forward opened or closed, for the app's socket. */
  on(fn: (e: ForwardEvent) => void): () => void;
  close(): Promise<void>;
}

/** Below this the laptop would need root; no measured tool uses one. */
export const RELAY_MIN_PORT = 1024;
/** Floor for a forward with no listener spotted; a spotted listener keys the window on its own lifetime. */
export const RELAY_WINDOW_MS = 3 * 60_000;
export const RELAY_CAP_MS = 15 * 60_000;
/** A url forward with no connection and no bytes for this long is one nobody is using. */
export const FORWARD_IDLE_MS = 10 * 60_000;
/** url forwards per workspace: the machine names the ports, so its say over this computer's loopback is bounded. */
export const FORWARD_MAX_PER_TARGET = 16;
/** The longest pause between redials of a dropped daemon link, before jitter. */
export const REDIAL_CEILING_MS = 30_000;
/** A callback that lands while the link is down waits this long for it: the longest jittered redial pause plus the dial's
 * budget, so the redial that starts inside every hold also lands inside it. */
export const CALLBACK_HOLD_MS = REDIAL_CEILING_MS * 1.5 + DAEMON_CONNECT_TIMEOUT_MS;
/** A callback is a GET whose head is a few hundred bytes; a held socket that sends more is not one. */
export const CALLBACK_HOLD_MAX_BYTES = 64 * 1024;
/** Held callback connections per forward; a browser opens a handful per host, a page probing loopback opens many. */
export const CALLBACK_HOLD_MAX_CONNS = 8;

interface Target {
  id: string;
  name: string;
  reach(): Promise<DaemonReachView>;
}

interface Link {
  target: Target;
  sock?: DaemonSocket;
  /** What the guest listens on, from the ports.watch reply and the port events after it. */
  ports: Set<number>;
  stopped: boolean;
  wake?: () => void;
  done: Promise<void>;
}

interface Held {
  cancel: () => void;
  /** What the browser sent so far; put back on the socket when it is plumbed. */
  chunks: Buffer[];
  bytes: number;
  onData: (d: Buffer) => void;
}

interface Forward {
  target: Target;
  port: number;
  kind: ForwardKind;
  listener: boolean;
  /** A url forward across a nap: the idle time it had left, restored at the wake. */
  paused?: number;
  /** What brought the workspace back, for the line when its port no longer listens ("the wake", "it moved to a new machine"). */
  pausedBack?: string;
  /** One line per stretch: set when a refusal is logged, cleared when a connection gets through (or the link returns). */
  unreachableLogged?: boolean;
  unansweredLogged?: boolean;
  servers: Server[];
  conns: Map<string, Socket>;
  /** Callback connections that arrived while the link was down, kept until the redial lands or their wait ends. */
  held: Map<Socket, Held>;
  startedAt: number;
  expiresAt: number;
  cancel: () => void;
}

function badGateway(sentence: string): string {
  const body = `${sentence}\n`;
  return `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
}

/** What a laptop connection hears when the guest side refused the tunnel. */
function refusedResponse(f: Forward): string {
  return badGateway(
    f.kind === "url"
      ? `localhost:${f.port} on this computer is forwarded to workspace ${f.target.name}, but nothing there answered on port ${f.port}.`
      : `The sign-in callback reached this computer, but nothing on workspace ${f.target.name} answered on port ${f.port}.`,
  );
}

/** What a held callback hears when its wait ends without a link, its forward closes first, or the hold is full. */
function heldResponse(f: Forward, what: string): string {
  return badGateway(`The sign-in callback reached this computer while workspace ${f.target.name} was reconnecting, ${what}. Start the sign-in again.`);
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1_000)} s`;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

function portsOf(rows: unknown): number[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => (r as { port?: unknown }).port).filter((p): p is number => typeof p === "number");
}

export function startCallbackRelay(o: RelayOptions): CallbackRelay {
  const rt = o.runtime;
  const clock = o.clock ?? realClock;
  const windowMs = o.windowMs ?? RELAY_WINDOW_MS;
  const capMs = o.capMs ?? RELAY_CAP_MS;
  const idleMs = o.idleMs ?? FORWARD_IDLE_MS;
  const connect = o.connect ?? connectDaemonSocket;
  const retryMs = o.retryMs ?? 2_000;
  const listenHosts = o.listenHosts ?? [LOOPBACK, "::1"];
  const autoOpen = o.autoOpen ?? (() => false);
  const openLine = o.openLine ?? ((workspace: string, hostname: string) => `${workspace}: a sign-in page for ${hostname} is ready; open it from the app`);
  const jitter = o.jitter ?? Math.random;
  /** Forwards whose binds are in flight, by target and port, so a second event for the same port joins the first. */
  const binding = new Set<string>();
  const links = new Map<string, Link>();
  /** The one callback forward per target. */
  const forwards = new Map<string, Forward>();
  /** url forwards by target and port. */
  const urlForwards = new Map<string, Forward>();
  const listeners = new Set<(e: ForwardEvent) => void>();
  let seq = 0;
  let closed = false;
  const detaches: (() => void)[] = [];

  const on = (fn: (e: ForwardEvent) => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  if (!rt.backend.capabilities.callbackRelay) return { forwards: () => [], list: () => [], stop: () => false, on, close: async () => {} };

  const urlKey = (targetId: string, port: number): string => `${targetId}:${port}`;
  const allForwards = (targetId: string): Forward[] => {
    const out: Forward[] = [];
    const callback = forwards.get(targetId);
    if (callback) out.push(callback);
    for (const f of urlForwards.values()) if (f.target.id === targetId) out.push(f);
    return out;
  };
  const forwardOn = (targetId: string, port: number): Forward | undefined => allForwards(targetId).find(f => f.port === port);
  const viewOf = (f: Forward): PortForward => ({ workspaceId: f.target.id, port: f.port, startedAt: new Date(f.startedAt).toISOString(), name: f.target.name, kind: f.kind });
  const emit = (e: ForwardEvent): void => {
    for (const fn of listeners) fn(e);
  };

  const sleep = (ms: number, link: Link): Promise<void> =>
    new Promise(resolve => {
      const cancel = clock.schedule(resolve, ms, { unref: true });
      link.wake = () => {
        cancel();
        resolve();
      };
    });

  // --- forwards -------------------------------------------------------------

  const closeForward = (f: Forward, why: string): void => {
    if (f.kind === "callback") {
      if (forwards.get(f.target.id) !== f) return;
      forwards.delete(f.target.id);
    } else {
      const key = urlKey(f.target.id, f.port);
      if (urlForwards.get(key) !== f) return;
      urlForwards.delete(key);
    }
    f.cancel();
    for (const c of f.conns.values()) c.destroy();
    f.conns.clear();
    for (const [c, h] of f.held) {
      h.cancel();
      c.end(heldResponse(f, `but its forward on port ${f.port} closed (${why})`));
    }
    f.held.clear();
    for (const s of f.servers) s.close();
    o.log(`${f.target.name}: stopped forwarding localhost:${f.port} (${why})`);
    emit({ type: "forward.close", workspaceId: f.target.id, port: f.port });
  };

  /** Traffic keeps a url forward alive; a callback forward's window is the guest listener's, not its traffic. */
  const touch = (f: Forward): void => {
    if (f.kind === "url") f.expiresAt = clock.now() + idleMs;
  };

  /** A spotted listener keys the window on its lifetime (the cap remains); without one, the floor. */
  const sawListener = (f: Forward): void => {
    if (f.listener) return;
    f.listener = true;
    f.expiresAt = f.startedAt + capMs;
  };

  const arm = (f: Forward): void => {
    const wait = Math.max(0, f.expiresAt - clock.now());
    f.cancel = clock.schedule(
      () => {
        if (clock.now() < f.expiresAt) arm(f);
        else if (f.kind === "url") closeForward(f, `no traffic for ${minutes(idleMs)}`);
        else closeForward(f, f.listener ? `open for ${minutes(capMs)}, the cap` : `no listener on the workspace within ${minutes(windowMs)}`);
      },
      wait,
      { unref: true },
    );
  };

  const listen = (host: string, port: number, onConn: (c: Socket) => void): Promise<Server | NodeJS.ErrnoException> =>
    new Promise(resolve => {
      const server = createServer(onConn);
      server.once("error", (e: NodeJS.ErrnoException) => resolve(e));
      try {
        server.listen(port, host, () => {
          server.unref();
          resolve(server);
        });
      } catch (e) {
        resolve(e as NodeJS.ErrnoException);
      }
    });

  const plumb = (f: Forward, sock: DaemonSocket, c: Socket): void => {
    plumbTunnel((op, params) => sock.op(op, params), c, {
      port: f.port,
      conns: f.conns,
      tunnelId: `t${++seq}`,
      touched: () => touch(f),
      opened: () => {
        f.unreachableLogged = false;
        f.unansweredLogged = false;
      },
      refused: socket => {
        // The browser was redirected here, so it gets an answer it can show, not a reset.
        socket.end(refusedResponse(f));
        // A tab left open retries every second: one line per stretch, not per connection.
        if (f.unansweredLogged) return;
        f.unansweredLogged = true;
        o.log(
          f.kind === "url"
            ? `${f.target.name}: a connection to localhost:${f.port} here reached the workspace but nothing there answered on port ${f.port}`
            : `${f.target.name}: the sign-in callback on port ${f.port} reached this computer but nothing on the workspace answered`,
        );
      },
    });
  };

  /** A redirect that lands inside the redial wait would otherwise die with a 502; it waits for the link or the hold's end.
   * The socket keeps reading meanwhile (a paused one never sees the browser leave), so its bytes are kept here. */
  const hold = (f: Forward, c: Socket): void => {
    if (f.held.size >= CALLBACK_HOLD_MAX_CONNS) {
      c.end(heldResponse(f, `and ${CALLBACK_HOLD_MAX_CONNS} connections were already waiting for it`));
      return;
    }
    const h: Held = {
      chunks: [],
      bytes: 0,
      onData: d => {
        h.bytes += d.length;
        if (h.bytes > CALLBACK_HOLD_MAX_BYTES) {
          f.held.delete(c);
          h.cancel();
          c.destroy();
          return;
        }
        h.chunks.push(d);
      },
      cancel: () => {},
    };
    h.cancel = clock.schedule(
      () => {
        f.held.delete(c);
        c.end(heldResponse(f, `and the daemon link did not come back within ${seconds(CALLBACK_HOLD_MS)}`));
        o.log(`${f.target.name}: a sign-in callback held on localhost:${f.port} for ${seconds(CALLBACK_HOLD_MS)} found no daemon link; start the sign-in again`);
      },
      CALLBACK_HOLD_MS,
      { unref: true },
    );
    f.held.set(c, h);
    c.on("data", h.onData);
    const gone = (): void => {
      if (f.held.delete(c)) h.cancel();
    };
    c.on("end", gone);
    c.on("close", gone);
    if (f.unreachableLogged) return;
    f.unreachableLogged = true;
    o.log(`${f.target.name}: a sign-in callback reached localhost:${f.port} here while the daemon link is down; holding it until the link is back`);
  };

  /** Never throws: an event from the machine must not end the host process. */
  const forward = async (link: Link, port: number, kind: ForwardKind): Promise<void> => {
    const { target } = link;
    const sock = link.sock;
    if (!sock) return;
    if (!Number.isInteger(port) || port < RELAY_MIN_PORT || port > 65535) {
      o.log(`${target.name}: not forwarding port ${port} (outside ${RELAY_MIN_PORT}..65535)`);
      return;
    }
    // A port already forwarded for this target, by either kind, reaches the guest already. A sign-in whose
    // callback port a printed URL already forwarded rides that url forward, which lives by its idle clock
    // rather than the guest listener's, and gets no sign-in line of its own.
    if (forwardOn(target.id, port)) return;
    // The in-flight set, not the forwards map: a second event for the same port joins the bind,
    // and the forward that works stays in place until the newcomer's servers are listening.
    const key = `${target.id}:${kind}:${port}`;
    if (binding.has(key) || binding.has(`${target.id}:${kind === "url" ? "callback" : "url"}:${port}`)) return;
    // url binds in flight count too: a burst of events in one tick must not all pass the cap before any lands.
    const inFlight = [...binding].filter(k => k.startsWith(`${target.id}:url:`)).length;
    if (kind === "url" && allForwards(target.id).filter(f => f.kind === "url").length + inFlight >= FORWARD_MAX_PER_TARGET) {
      o.log(`${target.name}: not forwarding localhost:${port}; ${FORWARD_MAX_PER_TARGET} ports are already forwarded for this workspace, stop one first`);
      return;
    }
    binding.add(key);
    const startedAt = clock.now();
    const f: Forward = { target, port, kind, listener: false, servers: [], conns: new Map(), held: new Map(), startedAt, expiresAt: startedAt + (kind === "url" ? idleMs : windowMs), cancel: () => {} };
    // The link at connection time, not at bind time: a forward outlives a redial, and a url forward a nap too.
    const onConn = (c: Socket): void => {
      // A browser that resets the socket with the reply unread must not become an uncaught error here.
      c.on("error", () => {});
      const live = links.get(target.id)?.sock;
      if (live === undefined) {
        if (kind === "callback") {
          hold(f, c);
          return;
        }
        c.end(refusedResponse(f));
        if (!f.unreachableLogged) {
          f.unreachableLogged = true;
          o.log(`${target.name}: a connection to localhost:${port} here found the workspace unreachable`);
        }
        return;
      }
      plumb(f, live, c);
    };
    let results: (Server | NodeJS.ErrnoException)[];
    try {
      // Both families: a browser resolves localhost to either, and the guest listener may be on one only.
      // A refusal on either is a port this computer already uses; a missing family (no IPv6) is not.
      results = await Promise.all(listenHosts.map(h => listen(h, port, onConn)));
    } finally {
      binding.delete(key);
    }
    for (const r of results) if (!(r instanceof Error)) f.servers.push(r);
    const inUse = results.some(r => r instanceof Error && r.code === "EADDRINUSE");
    if (inUse || f.servers.length === 0) {
      for (const s of f.servers) s.close();
      const first = results.find(r => r instanceof Error) as NodeJS.ErrnoException | undefined;
      const why = inUse ? "already in use on this computer" : `could not listen: ${first?.message ?? "unknown"}`;
      o.log(`${target.name}: port ${port} is ${why}; ${kind === "url" ? "localhost:" + port + " here will not reach the workspace" : "the sign-in callback is not forwarded"}`);
      return;
    }
    if (closed || link.sock !== sock || forwardOn(target.id, port)) {
      for (const s of f.servers) s.close();
      return;
    }
    if (kind === "url") {
      urlForwards.set(urlKey(target.id, port), f);
      arm(f);
      o.log(`${target.name}: forwarding localhost:${port} on this computer to the workspace (closes after ${minutes(idleMs)} without traffic)`);
    } else {
      const previous = forwards.get(target.id);
      if (previous) closeForward(previous, `port ${port} replaces it`);
      forwards.set(target.id, f);
      if (link.ports.has(port)) sawListener(f);
      arm(f);
      o.log(`${target.name}: forwarding localhost:${port} on this computer to the workspace for the sign-in callback (while the workspace listens, ${minutes(capMs)} at most)`);
    }
    emit({ type: "forward.open", forward: viewOf(f) });
  };

  const tryForward = (link: Link, port: number, kind: ForwardKind): void => {
    forward(link, port, kind).catch((e: unknown) => o.log(`${link.target.name}: not forwarding port ${port} (${e instanceof Error ? e.message : String(e)})`));
  };

  // --- links ----------------------------------------------------------------

  const onEvent = (link: Link, raw: Record<string, unknown>): void => {
    // The machine is the untrusted side: only http(s) ever reaches an opener, whatever the daemon sent.
    if (raw["type"] === "browser.open" && !isHttpUrl(raw["url"])) {
      o.log(`${link.target.name}: ignored a sign-in page that is not an http(s) link`);
      return;
    }
    const parsed = DaemonEvent.safeParse(raw);
    if (!parsed.success) {
      // A relay event that fails the wire shape (a port outside 1024..65535, say) is dropped with a line, never acted on.
      if (raw["type"] === "browser.open" || raw["type"] === "callback.port" || raw["type"] === "localhost.url") o.log(`${link.target.name}: ignored a malformed ${String(raw["type"])} event from the workspace`);
      return;
    }
    const e = parsed.data;
    const f = forwards.get(link.target.id);
    switch (e.type) {
      case "port.open":
        link.ports.add(e.port);
        if (f?.port === e.port) sawListener(f);
        return;
      case "port.close":
        link.ports.delete(e.port);
        if (f?.port === e.port && f.listener) closeForward(f, "the workspace stopped listening");
        return;
      case "browser.open":
        if (autoOpen(link.target.id, e.url, e.port)) {
          const returns = e.port !== undefined ? "; it returns to the machine on its own" : "";
          void o.openUrl(e.url).then(ok =>
            o.log(ok ? `${link.target.name}: opened a sign-in page in your browser${returns}` : `${link.target.name}: could not open your browser for a sign-in page`),
          );
        } else {
          // isHttpUrl parsed the URL already; the second wall for a guest that skipped the socket.
          const host = hostOf(e.url);
          if (host === undefined) {
            o.log(`${link.target.name}: ignored a sign-in page that is not an http(s) link`);
            return;
          }
          o.log(openLine(link.target.name, host, e.url));
        }
        // The forward arms now, so the port is ready by the time the person clicks.
        if (e.port !== undefined) tryForward(link, e.port, "callback");
        return;
      case "callback.port":
        tryForward(link, e.port, "callback");
        return;
      case "localhost.url":
        tryForward(link, e.port, "url");
        return;
      case "tunnel.data":
      case "tunnel.end":
        // One counter mints every tunnel id here, so a frame belongs to at most one forward and the first that
        // holds it is the one it is for.
        for (const fw of allForwards(link.target.id)) if (tunnelFrame(fw.conns, e, () => touch(fw))) return;
        return;
      default:
        return;
    }
  };

  const run = async (link: Link): Promise<void> => {
    let attempt = 0;
    while (!link.stopped) {
      let sock: DaemonSocket | undefined;
      try {
        const reach = await link.target.reach();
        if (reach.daemonToken === undefined) throw new Error("no daemon token");
        sock = await connect({
          url: reach.url,
          token: reach.daemonToken,
          onEvent: raw => onEvent(link, raw),
          onEventError: e => o.log(`${link.target.name}: an event from the workspace could not be handled (${e instanceof Error ? e.message : String(e)})`),
        });
        if (link.stopped) {
          sock.close();
          return;
        }
        link.sock = sock;
        // Starts the daemon's port watcher (its listener heuristic reads it) and seeds what the guest listens on now.
        const watched = await sock.op("ports.watch");
        link.ports = new Set(portsOf(watched["ports"]));
        attempt = 0;
        resume(link, sock);
        await sock.closed;
        // Every forward stays bound here across the redial; only its tunnels died with the socket.
        for (const f of allForwards(link.target.id)) {
          for (const c of f.conns.values()) c.destroy();
          f.conns.clear();
        }
      } catch {
        sock?.close();
      }
      link.sock = undefined;
      attempt++;
      if (!link.stopped) {
        const base = Math.min(REDIAL_CEILING_MS, retryMs * 2 ** (attempt - 1));
        await sleep(Math.round(base * (1 + jitter() / 2)), link);
      }
    }
  };

  /** After ports.watch on a fresh socket. A redial keeps every forward with its clocks as they ran; a callback forward
   * closes only when the listener it was keyed on is gone, and the callbacks it held ride the new link. url forwards
   * paused by a nap pick their idle clock back up, or close when the workspace no longer listens on the port. One line per link. */
  const resume = (link: Link, sock: DaemonSocket): void => {
    const all = allForwards(link.target.id);
    if (all.length === 0) return;
    const kept: number[] = [];
    let back: string | undefined;
    for (const f of all) {
      f.unreachableLogged = false;
      if (f.kind === "callback") {
        if (f.listener && !link.ports.has(f.port)) {
          closeForward(f, "the workspace stopped listening while the daemon link was down");
          continue;
        }
        if (link.ports.has(f.port)) sawListener(f);
        for (const [c, h] of f.held) {
          h.cancel();
          c.off("data", h.onData);
          c.pause();
          for (const d of h.chunks.reverse()) c.unshift(d);
          plumb(f, sock, c);
        }
        f.held.clear();
      } else if (f.paused !== undefined) {
        back = f.pausedBack;
        if (!link.ports.has(f.port)) {
          closeForward(f, `not listening on the workspace after ${f.pausedBack}`);
          continue;
        }
        f.expiresAt = clock.now() + f.paused;
        delete f.paused;
        delete f.pausedBack;
        arm(f);
      }
      kept.push(f.port);
    }
    const how = back === undefined ? "the daemon link is back" : back === "the wake" ? "awake again" : "back on a new machine";
    if (kept.length > 0) o.log(`${link.target.name}: ${how}; ${kept.map(p => `localhost:${p}`).join(", ")} still forwarded`);
  };

  const add = (target: Target): void => {
    if (closed || links.has(target.id)) return;
    const link: Link = { target, ports: new Set(), stopped: false, done: Promise.resolve() };
    link.done = run(link);
    links.set(target.id, link);
  };

  /** why closes the callback forward; url forwards pause across a nap or a new machine (their servers stay
   * bound here, the idle clock stops) and close for good only when the workspace or the host goes. */
  const drop = (id: string, why: string, urls: "pause" | "close", back = "the wake"): Promise<void> => {
    const link = links.get(id);
    if (!link) return Promise.resolve();
    links.delete(id);
    link.stopped = true;
    for (const f of allForwards(id)) {
      if (f.kind === "callback" || urls === "close") {
        closeForward(f, why);
        continue;
      }
      for (const c of f.conns.values()) c.destroy();
      f.conns.clear();
      if (f.paused === undefined) {
        f.cancel();
        f.paused = Math.max(0, f.expiresAt - clock.now());
        f.pausedBack = back;
      }
    }
    link.sock?.close();
    link.wake?.();
    return link.done;
  };

  const workspaceTarget = (id: string, name: string): Target => ({ id, name, reach: () => rt.workspaces.daemonReach(id) });

  /** The workspace was named: every row and every log line for it reads the name it carries now. The link's target
   * and a url forward's are two objects once that forward has outlived a nap, so both are named, and each open
   * forward is announced again so a client's row follows without waiting for the next open or close. */
  const rename = (id: string, name: string): void => {
    const link = links.get(id);
    if (link) link.target.name = name;
    for (const f of allForwards(id)) {
      f.target.name = name;
      emit({ type: "forward.open", forward: viewOf(f) });
    }
  };

  const onRuntimeEvent = (e: EventUnion): void => {
    switch (e.type) {
      case "workspace.created":
        if (e.workspace.phase === "running") add(workspaceTarget(e.workspace.id, e.workspace.name));
        return;
      case "workspace.woken":
      case "workspace.upgraded":
        // A fresh machine or a fresh edge route: redial through a new reach.
        void drop(e.workspaceId, e.type === "workspace.woken" ? "the workspace woke" : "the workspace moved to a new machine", "pause", e.type === "workspace.woken" ? "the wake" : "it moved to a new machine").then(() =>
          rt.workspaces.get(e.workspaceId).then(w => add(workspaceTarget(w.id, w.name)), () => {}),
        );
        return;
      case "workspace.renamed":
        rename(e.workspaceId, e.name);
        return;
      case "workspace.napped":
        void drop(e.workspaceId, "the workspace napped", "pause");
        return;
      case "workspace.gone":
        // The forwards wait like a nap's: a rebuild lands as workspace.upgraded and redials them.
        void drop(e.workspaceId, "the machine is gone", "pause", "the rebuild");
        return;
      case "workspace.deleted":
        void drop(e.workspaceId, "the workspace was deleted", "close");
        return;
      default:
        return;
    }
  };

  detaches.push(rt.events.on("*", onRuntimeEvent));
  void rt.workspaces.list().then(
    list => {
      for (const w of list) if (w.phase === "running") add(workspaceTarget(w.id, w.name));
    },
    () => {},
  );
  if (o.builder !== undefined) {
    const b = o.builder;
    add({ id: b.id, name: `${b.name} (builder)`, reach: () => rt.golden.builderReach(b.id) });
  }

  const every = (): Forward[] => [...forwards.values(), ...urlForwards.values()];

  return {
    forwards: () => every().map(f => ({ targetId: f.target.id, port: f.port, kind: f.kind, listener: f.listener, expiresAt: f.expiresAt })),
    list: () => every().map(viewOf),
    stop: (targetId, port) => {
      const f = forwardOn(targetId, port);
      if (!f) return false;
      closeForward(f, "stopped from the app");
      return true;
    },
    on,
    close: async () => {
      closed = true;
      for (const un of detaches) un();
      await Promise.all([...links.keys()].map(id => drop(id, "the host is closing", "close")));
    },
  };
}
