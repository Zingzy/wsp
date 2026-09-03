// SPDX-License-Identifier: AGPL-3.0-only
// The laptop half of the sign-in callback relay. One daemon link per running
// workspace (and the init builder): a browser.open from the guest is shown by
// the app (opened here only when autoOpen says so), and the flow's callback
// port is listened on locally and tunnelled back over that link for a bounded
// window. The URL is never logged.

import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { platform } from "node:os";
import { DaemonEvent, hostOf, isHttpUrl, type DaemonReachView, type GoldenBuilderView } from "@wsp/protocol";
import { realClock, type Clock, type EventUnion, type Runtime } from "@wsp/runtime";
import { connectDaemonSocket, type ConnectOptions, type DaemonSocket } from "./doctor.js";

export type UrlOpener = (url: string) => Promise<boolean>;

/** Runs the platform opener and reports whether it exited clean. */
export function systemOpener(os: NodeJS.Platform = platform()): UrlOpener {
  const cmd = os === "darwin" ? "open" : os === "win32" ? "explorer" : "xdg-open";
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
   * inside openUrl is one-shot without a race. */
  autoOpen?: (targetId: string) => boolean;
  /** The one line logged when a page arrives and nothing opens, given the workspace name and the URL's hostname; the TUI supplies its own. */
  openLine?: (workspace: string, hostname: string) => string;
  /** One line per open, forward, refusal and close; never the URL. */
  log: (line: string) => void;
  builder?: GoldenBuilderView;
  clock?: Clock;
  /** A forward whose port the guest was never seen listening on closes after this. Default 3 min. */
  windowMs?: number;
  /** No forward lives longer than this, listener or not. Default 15 min. */
  capMs?: number;
  connect?: (opts: ConnectOptions) => Promise<DaemonSocket>;
  /** First redial pause after a link drops; doubles per failed attempt up to 30 s. Default 2 s. */
  retryMs?: number;
  /** Laptop addresses to listen on; both loopback families by default. Tests bind one so the fake guest can hold the other. */
  listenHosts?: string[];
  /** A fraction in [0, 1) added to each redial wait (up to half again), so links through one edge do not redial in lockstep. */
  jitter?: () => number;
}

export interface ForwardView {
  targetId: string;
  port: number;
  /** The guest has been seen listening on the port; the forward then lives until that listener closes or the cap. */
  listener: boolean;
  expiresAt: number;
}

export interface CallbackRelay {
  forwards(): ForwardView[];
  close(): Promise<void>;
}

/** Below this the laptop would need root; no measured tool uses one. */
export const RELAY_MIN_PORT = 1024;
/** Floor for a forward with no listener spotted; a spotted listener keys the window on its own lifetime. */
export const RELAY_WINDOW_MS = 3 * 60_000;
export const RELAY_CAP_MS = 15 * 60_000;

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

interface Forward {
  target: Target;
  port: number;
  listener: boolean;
  servers: Server[];
  conns: Map<string, Socket>;
  startedAt: number;
  expiresAt: number;
  cancel: () => void;
}

/** What a laptop connection hears when the guest side refused the tunnel. */
function refusedResponse(name: string, port: number): string {
  const body = `The sign-in callback reached this computer, but nothing on workspace ${name} answered on port ${port}.\n`;
  return `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
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
  const connect = o.connect ?? connectDaemonSocket;
  const retryMs = o.retryMs ?? 2_000;
  const listenHosts = o.listenHosts ?? ["127.0.0.1", "::1"];
  const autoOpen = o.autoOpen ?? (() => false);
  const openLine = o.openLine ?? ((workspace: string, hostname: string) => `${workspace}: a sign-in page for ${hostname} is ready; open it from the app`);
  const jitter = o.jitter ?? Math.random;
  /** Forwards whose binds are in flight, by target and port, so a second event for the same port joins the first. */
  const binding = new Set<string>();
  const links = new Map<string, Link>();
  const forwards = new Map<string, Forward>();
  let seq = 0;
  let closed = false;
  const detaches: (() => void)[] = [];

  if (!rt.backend.capabilities.callbackRelay) return { forwards: () => [], close: async () => {} };

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
    if (forwards.get(f.target.id) !== f) return;
    forwards.delete(f.target.id);
    f.cancel();
    for (const c of f.conns.values()) c.destroy();
    f.conns.clear();
    for (const s of f.servers) s.close();
    o.log(`${f.target.name}: stopped forwarding localhost:${f.port} (${why})`);
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
    const tunnelId = `t${++seq}`;
    f.conns.set(tunnelId, c);
    c.pause();
    c.on("error", () => {});
    c.on("close", () => {
      f.conns.delete(tunnelId);
      sock.op("tunnel.close", { tunnelId }).catch(() => {});
    });
    sock.op("tunnel.open", { tunnelId, port: f.port }).then(
      () => {
        c.on("data", (d: Buffer) => {
          sock.op("tunnel.write", { tunnelId, data: d.toString("base64") }).catch(() => c.destroy());
        });
        c.resume();
      },
      () => {
        // The browser was redirected here, so it gets an answer it can show, not a reset.
        c.end(refusedResponse(f.target.name, f.port));
        o.log(`${f.target.name}: the sign-in callback on port ${f.port} reached this computer but nothing on the workspace answered`);
      },
    );
  };

  /** Never throws: an event from the machine must not end the host process. */
  const forward = async (link: Link, port: number): Promise<void> => {
    const { target } = link;
    const sock = link.sock;
    if (!sock) return;
    if (!Number.isInteger(port) || port < RELAY_MIN_PORT || port > 65535) {
      o.log(`${target.name}: not forwarding port ${port} (outside ${RELAY_MIN_PORT}..65535)`);
      return;
    }
    if (forwards.get(target.id)?.port === port) return;
    // The in-flight set, not the forwards map: a second event for the same port joins the bind,
    // and the forward that works stays in place until the newcomer's servers are listening.
    const key = `${target.id}:${port}`;
    if (binding.has(key)) return;
    binding.add(key);
    const startedAt = clock.now();
    const f: Forward = { target, port, listener: false, servers: [], conns: new Map(), startedAt, expiresAt: startedAt + windowMs, cancel: () => {} };
    const onConn = (c: Socket): void => plumb(f, sock, c);
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
      o.log(`${target.name}: port ${port} is ${why}; the sign-in callback is not forwarded`);
      return;
    }
    if (closed || link.sock !== sock) {
      for (const s of f.servers) s.close();
      return;
    }
    const previous = forwards.get(target.id);
    if (previous?.port === port) {
      for (const s of f.servers) s.close();
      return;
    }
    if (previous) closeForward(previous, `port ${port} replaces it`);
    forwards.set(target.id, f);
    if (link.ports.has(port)) sawListener(f);
    arm(f);
    o.log(`${target.name}: forwarding localhost:${port} on this computer to the workspace for the sign-in callback (while the workspace listens, ${minutes(capMs)} at most)`);
  };

  const tryForward = (link: Link, port: number): void => {
    forward(link, port).catch((e: unknown) => o.log(`${link.target.name}: not forwarding port ${port} (${e instanceof Error ? e.message : String(e)})`));
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
      if (raw["type"] === "browser.open" || raw["type"] === "callback.port") o.log(`${link.target.name}: ignored a malformed ${String(raw["type"])} event from the workspace`);
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
        if (autoOpen(link.target.id)) {
          void o.openUrl(e.url).then(ok =>
            o.log(ok ? `${link.target.name}: opened a sign-in page in your browser` : `${link.target.name}: could not open your browser for a sign-in page`),
          );
        } else {
          // isHttpUrl parsed the URL already; the second wall for a guest that skipped the socket.
          const host = hostOf(e.url);
          if (host === undefined) {
            o.log(`${link.target.name}: ignored a sign-in page that is not an http(s) link`);
            return;
          }
          o.log(openLine(link.target.name, host));
        }
        // The forward arms now, so the port is ready by the time the person clicks.
        if (e.port !== undefined) tryForward(link, e.port);
        return;
      case "callback.port":
        tryForward(link, e.port);
        return;
      case "tunnel.data":
        f?.conns.get(e.tunnelId)?.write(Buffer.from(e.data, "base64"));
        return;
      case "tunnel.end":
        f?.conns.get(e.tunnelId)?.end();
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
        await sock.closed;
        const f = forwards.get(link.target.id);
        if (f) closeForward(f, "the daemon link dropped");
      } catch {
        sock?.close();
      }
      link.sock = undefined;
      attempt++;
      if (!link.stopped) {
        const base = Math.min(30_000, retryMs * 2 ** (attempt - 1));
        await sleep(Math.round(base * (1 + jitter() / 2)), link);
      }
    }
  };

  const add = (target: Target): void => {
    if (closed || links.has(target.id)) return;
    const link: Link = { target, ports: new Set(), stopped: false, done: Promise.resolve() };
    link.done = run(link);
    links.set(target.id, link);
  };

  const drop = (id: string): Promise<void> => {
    const link = links.get(id);
    if (!link) return Promise.resolve();
    links.delete(id);
    link.stopped = true;
    const f = forwards.get(id);
    if (f) closeForward(f, "the workspace went away");
    link.sock?.close();
    link.wake?.();
    return link.done;
  };

  const workspaceTarget = (id: string, name: string): Target => ({ id, name, reach: () => rt.workspaces.daemonReach(id) });

  const onRuntimeEvent = (e: EventUnion): void => {
    switch (e.type) {
      case "workspace.created":
        if (e.workspace.phase === "running") add(workspaceTarget(e.workspace.id, e.workspace.name));
        return;
      case "workspace.woken":
      case "workspace.upgraded":
        // A fresh machine or a fresh edge route: redial through a new reach.
        void drop(e.workspaceId).then(() => rt.workspaces.get(e.workspaceId).then(w => add(workspaceTarget(w.id, w.name)), () => {}));
        return;
      case "workspace.napped":
      case "workspace.deleted":
        void drop(e.workspaceId);
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

  return {
    forwards: () => [...forwards.values()].map(f => ({ targetId: f.target.id, port: f.port, listener: f.listener, expiresAt: f.expiresAt })),
    close: async () => {
      closed = true;
      for (const un of detaches) un();
      await Promise.all([...links.keys()].map(drop));
    },
  };
}
