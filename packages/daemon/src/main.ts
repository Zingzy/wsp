import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DaemonAuthRequest, type DaemonEvent } from "@wsp/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { listDir, readFileBounded, type FsReadEncoding } from "./fs-ops.js";
import { gitDiff, gitStatus, type GitDiffScope } from "./git-ops.js";
import { InboxWatcher } from "./inbox.js";
import { ProcessManifest, type ManifestOptions } from "./manifest.js";
import { linuxModeProbe, ModeWatcher, type ModeProbe } from "./mode.js";
import { PortWatcher, procNetTcpSource, type PortOpenEvent, type PortSnapshotSource } from "./ports.js";
import { killProcess, ProcSampler } from "./proc.js";
import { PtyManager } from "./pty-manager.js";
import { procSysSource, SysSampler, type SysSource } from "./sys.js";
import { localhostPortOf, settledLocalPorts } from "./local-urls.js";
import { CallbackSpotter, TerminalUrlScanner, callbackPortOf, listenOpenSocket, type OpenSocket } from "./relay.js";
import { OpError, resolveInside } from "./workspace-paths.js";

export const DEFAULT_PORT = 7070;
// 0.0.0.0, not loopback: the previewUrl edge dials the guest's eth0 (loopback answers 502).
export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_TOKEN_PATH = "/root/.wsp-daemon-token";
export const DEFAULT_INBOX_DIR = "/root/inbox";
export const DEFAULT_MANIFEST_PATH = "/root/.wsp/manifest.json";

export interface DaemonOptions {
  host?: string;
  port?: number;
  /** A fixed token (local runs, tests); without it every auth frame is checked against tokenPath as it is then. */
  token?: string;
  tokenPath?: string;
  /** How long a fresh socket has to send its auth frame. */
  authDeadlineMs?: number;
  portsSource?: PortSnapshotSource;
  portsIntervalMs?: number;
  inboxDir?: string;
  inboxQuietMs?: number;
  inboxPollMs?: number;
  manifest?: ManifestOptions;
  modeProbe?: ModeProbe;
  modeIntervalMs?: number;
  sysSource?: SysSource;
  sysIntervalMs?: number;
  /** A directory laid out like /proc, for tests on darwin; the real one otherwise. */
  procRoot?: string;
  procPasswdPath?: string;
  procIntervalMs?: number;
  /** Every fs.* and git.* path must resolve inside this directory; HOME by default. */
  root?: string;
  /** Unix socket the browser shim posts URLs to; absent means no shim socket (local and test daemons). */
  openSocketPath?: string;
  spotter?: CallbackSpotter;
}

export interface DaemonHandle {
  port: number;
  ptys: PtyManager;
  close(): Promise<void>;
}

/** CLI flags for the bin: --host matters for LOCAL runs (bind 127.0.0.1 so
 * macOS/Windows firewalls stay quiet); in-guest keeps the 0.0.0.0 default
 * because the previewUrl edge dials eth0. */
export function parseDaemonArgs(argv: string[]): Pick<DaemonOptions, "host" | "port" | "tokenPath" | "root"> {
  const out: { host?: string; port?: number; tokenPath?: string; root?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (flag === "--host") {
      if (!value) throw new Error("--host needs a value (e.g. --host 127.0.0.1)");
      out.host = value;
      i++;
    } else if (flag === "--port") {
      const port = Number(value);
      if (!value || !Number.isInteger(port)) throw new Error("--port needs an integer value");
      out.port = port;
      i++;
    } else if (flag === "--token-path") {
      if (!value) throw new Error("--token-path needs a file path");
      out.tokenPath = value;
      i++;
    } else if (flag === "--root") {
      if (!value) throw new Error("--root needs a directory path");
      out.root = value;
      i++;
    } else {
      throw new Error(`unknown flag ${flag} (known: --host, --port, --token-path, --root)`);
    }
  }
  return out;
}

interface Request {
  id?: string | number;
  op?: string;
  [k: string]: unknown;
}

interface ConnState {
  detaches: (() => void)[];
  tunnels: Map<string, Socket>;
  /** Set when the auth frame named a port: only tunnel ops on it and ping are answered. */
  port?: number;
  /** This socket's proc.watch, so proc.unwatch can end it before the socket does. */
  unwatchProcs?: () => void;
}

/** Laptop connections one socket may hold open through the forward at once. */
const TUNNEL_CAP = 64;
const AUTH_DEADLINE_MS = 5_000;
/** Wire bytes a peer may send before its auth frame passes; an auth frame is under 200. */
const PRE_AUTH_MAX_BYTES = 4096;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  // Read per auth frame, not once: the host rotates the file on every start and the daemon keeps running.
  const currentToken = (): string => (opts.token ?? readFileSync(opts.tokenPath ?? DEFAULT_TOKEN_PATH, "utf8")).trim();
  if (!currentToken()) throw new Error("daemon refuses to start without an auth token");
  const authDeadlineMs = opts.authDeadlineMs ?? AUTH_DEADLINE_MS;

  const ptys = new PtyManager();
  const manifest = new ProcessManifest(opts.manifest ?? { path: DEFAULT_MANIFEST_PATH });
  const spotter = opts.spotter ?? new CallbackSpotter();
  // Watchers are created on first watch op so darwin tests never touch /proc.
  let portWatcher: PortWatcher | null = null;
  let inboxWatcher: InboxWatcher | null = null;
  let sysSampler: SysSampler | null = null;
  let procSampler: ProcSampler | null = null;

  const getPortWatcher = () => {
    if (!portWatcher) {
      portWatcher = new PortWatcher(opts.portsSource ?? procNetTcpSource(), {
        intervalMs: opts.portsIntervalMs ?? 1000,
      });
      portWatcher.on("port.open", (e: PortOpenEvent) => spotter.noteOpen(e.port, e.loopback === true));
      portWatcher.start();
    }
    return portWatcher;
  };
  const getInboxWatcher = () => {
    if (!inboxWatcher) {
      inboxWatcher = new InboxWatcher({
        dir: opts.inboxDir ?? DEFAULT_INBOX_DIR,
        ...(opts.inboxQuietMs !== undefined ? { quietMs: opts.inboxQuietMs } : {}),
        ...(opts.inboxPollMs !== undefined ? { pollMs: opts.inboxPollMs } : {}),
      });
      inboxWatcher.start();
    }
    return inboxWatcher;
  };

  const root = resolve(opts.root ?? process.env["HOME"] ?? homedir());
  const getSysSampler = () => {
    sysSampler ??= new SysSampler(opts.sysSource ?? procSysSource(root), {
      ...(opts.sysIntervalMs !== undefined ? { intervalMs: opts.sysIntervalMs } : {}),
    });
    return sysSampler;
  };
  const getProcSampler = () => {
    procSampler ??= new ProcSampler({
      // An exited pty's pid can be reused by a stranger; only live shells carry the label.
      ptys: () => ptys.list().filter(p => !p.exited),
      ...(opts.procRoot !== undefined ? { procRoot: opts.procRoot } : {}),
      ...(opts.procPasswdPath !== undefined ? { passwdPath: opts.procPasswdPath } : {}),
      ...(opts.procIntervalMs !== undefined ? { intervalMs: opts.procIntervalMs } : {}),
    });
    return procSampler;
  };

  // Inert until a pty.attach; the Linux-only default probe fails silently on
  // darwin, so attach tests without a fake probe still pass.
  const modes = new ModeWatcher(opts.modeProbe ?? linuxModeProbe(), {
    ...(opts.modeIntervalMs !== undefined ? { intervalMs: opts.modeIntervalMs } : {}),
  });

  const wss = new WebSocketServer({ host: opts.host ?? DEFAULT_HOST, port: opts.port ?? DEFAULT_PORT });
  // Armed before any await: the listening event fires as soon as the loop turns.
  const listening = new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  const authed = new Set<WebSocket>();
  // Pushed to every authed socket, not to subscribers: the host's link
  // reconnects through the edge and would lose a subscription with it.
  const broadcast = (event: DaemonEvent): void => {
    for (const client of authed) push(client, event);
  };
  const relay = {
    /** A tool asked for a browser: open on the laptop now, name the callback port when the URL or a new loopback listener gives one. */
    open(url: string): void {
      const port = callbackPortOf(url);
      const local = localhostPortOf(url);
      // A local page with no callback port (a dev server opening itself) is not a sign-in: forwarded and listed, no page announced.
      // A local authorize page whose redirect_uri names a port (a local Supabase or Keycloak) is both: the page to click and a local URL.
      if (port !== undefined || local === undefined) broadcast({ type: "browser.open", url, ...(port !== undefined ? { port } : {}) });
      if (local !== undefined) broadcast({ type: "localhost.url", port: local });
      else if (port === undefined) spotter.spot(p => broadcast({ type: "callback.port", port: p }));
    },
  };
  const ctx: Ctx = { ptys, manifest, modes, root, getPortWatcher, getInboxWatcher, getSysSampler, getProcSampler, spotter, broadcast };
  let openSocket: OpenSocket | undefined;
  if (opts.openSocketPath !== undefined) {
    try {
      openSocket = await listenOpenSocket(opts.openSocketPath);
    } catch (e) {
      await new Promise<void>(resolve => wss.close(() => resolve()));
      throw e;
    }
    openSocket.on("url", url => relay.open(url));
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // A malformed frame from any peer, authed or not, ends that socket and nothing else: without a listener ws throws.
    ws.on("error", () => {});
    // ws assembles a whole message (up to its 100 MiB cap) before it emits one, so the pre-auth cap counts the bytes
    // on the wire instead; it stays armed through the close handshake, where a refused peer could still stream.
    const wire = req.socket;
    let preAuthBytes = 0;
    const countPreAuth = (chunk: Buffer): void => {
      preAuthBytes += chunk.length;
      if (preAuthBytes <= PRE_AUTH_MAX_BYTES) return;
      if (ws.readyState === ws.OPEN) ws.close(4401, "too many bytes before the auth frame");
      else wire.destroy();
    };
    wire.prependListener("data", countPreAuth);
    // With the server on 0.0.0.0 the first frame is the only gate: no handler exists until it passes.
    const deadline = setTimeout(() => ws.close(4401, "no auth frame arrived in time"), authDeadlineMs);
    ws.once("close", () => clearTimeout(deadline));
    ws.once("message", raw => {
      clearTimeout(deadline);
      if (preAuthBytes > PRE_AUTH_MAX_BYTES) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        frame = undefined;
      }
      const auth = DaemonAuthRequest.safeParse(frame);
      if (!auth.success) {
        ws.close(4401, "the first frame must be auth");
        return;
      }
      let expected = "";
      try {
        expected = currentToken();
      } catch {
        expected = "";
      }
      if (expected === "" || !safeEqual(auth.data.token, expected)) {
        ws.close(4401, "daemon token refused; the host holds the current one");
        return;
      }
      wire.off("data", countPreAuth);
      reply(ws, auth.data.id, {});
      serve(ws, auth.data.port);
    });
  });

  const serve = (ws: WebSocket, port: number | undefined): void => {
    // A port-scoped socket is there to tunnel one port; the guest's pages and callback ports are not its business.
    if (port === undefined) authed.add(ws);
    push(ws, { type: "daemon.hello", root });
    const state: ConnState = { detaches: [], tunnels: new Map(), ...(port !== undefined ? { port } : {}) };
    ws.on("close", () => {
      // Client is gone; ptys keep running. Only this socket's subscriptions and tunnels die.
      authed.delete(ws);
      for (const un of state.detaches) un();
      state.detaches = [];
      for (const t of state.tunnels.values()) t.destroy();
      state.tunnels.clear();
    });
    ws.on("message", raw => {
      let msg: Request;
      try {
        msg = JSON.parse(String(raw)) as Request;
      } catch {
        ws.send(JSON.stringify({ id: null, ok: false, error: "invalid json" }));
        return;
      }
      handle(ws, state, ctx, msg).catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        ws.send(JSON.stringify({ id: msg.id ?? null, ok: false, error, ...(e instanceof OpError ? { code: e.code } : {}) }));
      });
    });
  };

  await listening;
  const addr = wss.address();
  const boundPort = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? DEFAULT_PORT);

  return {
    port: boundPort,
    ptys,
    close: async () => {
      portWatcher?.stop();
      inboxWatcher?.stop();
      sysSampler?.stop();
      procSampler?.stop();
      modes.stop();
      await openSocket?.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())));
      ptys.destroyAll();
    },
  };
}

interface Ctx {
  ptys: PtyManager;
  manifest: ProcessManifest;
  modes: ModeWatcher;
  root: string;
  getPortWatcher(): PortWatcher;
  getInboxWatcher(): InboxWatcher;
  getSysSampler(): SysSampler;
  getProcSampler(): ProcSampler;
  spotter: CallbackSpotter;
  broadcast(event: DaemonEvent): void;
}

/** 127.0.0.1 first, then ::1: a Node 22 tool listening on "localhost" binds [::1] only (measured, wrangler). */
function connectLoopback(port: number): Promise<Socket> {
  const dial = (host: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const s = connectTcp({ host, port });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  return dial("127.0.0.1").catch(() => dial("::1"));
}

function requireTunnel(state: ConnState, msg: Request): Socket {
  const id = String(msg["tunnelId"] ?? "");
  const s = state.tunnels.get(id);
  if (!s) throw new OpError("not-found", `no such tunnel: ${id}`);
  return s;
}

function reply(ws: WebSocket, id: Request["id"], payload: object): void {
  ws.send(JSON.stringify({ id: id ?? null, ok: true, ...payload }));
}

function fail(ws: WebSocket, id: Request["id"], error: string): void {
  ws.send(JSON.stringify({ id: id ?? null, ok: false, error }));
}

function push(ws: WebSocket, event: DaemonEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function requirePty(ptys: PtyManager, msg: Request) {
  const ptyId = String(msg["ptyId"] ?? "");
  const s = ptys.get(ptyId);
  if (!s) throw new Error(`no such pty: ${ptyId}`);
  return s;
}

function requireString(msg: Request, key: string): string {
  const v = msg[key];
  if (typeof v !== "string") throw new OpError("bad-request", `${key} must be a string`);
  return v;
}

// Linux pid_max ceiling; above int32 process.kill throws instead of ESRCH, so both proc ops refuse alike.
const PID_MAX = 4_194_304;
function requirePid(msg: Request): number {
  const pid = msg["pid"];
  if (!Number.isInteger(pid) || (pid as number) < 1 || (pid as number) > PID_MAX) {
    throw new OpError("bad-request", `pid must be an integer between 1 and ${PID_MAX}`);
  }
  return pid as number;
}

function optionalEnum<T extends string>(msg: Request, key: string, allowed: readonly T[]): T | undefined {
  const v = msg[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new OpError("bad-request", `${key} must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

function subscribe(state: ConnState, ws: WebSocket, emitter: NodeJS.EventEmitter, events: DaemonEvent["type"][]): void {
  for (const name of events) {
    const forward = (e: DaemonEvent) => push(ws, e);
    emitter.on(name, forward);
    state.detaches.push(() => emitter.off(name, forward));
  }
}

function inPortScope(port: number, msg: Request): boolean {
  switch (msg.op) {
    case "ping":
    case "tunnel.write":
    case "tunnel.close":
      return true;
    case "tunnel.open":
      return msg["port"] === port;
    default:
      return false;
  }
}

async function handle(ws: WebSocket, state: ConnState, ctx: Ctx, msg: Request): Promise<void> {
  if (state.port !== undefined && !inPortScope(state.port, msg)) {
    throw new OpError("forbidden", `this socket is scoped to port ${state.port}: only tunnel ops on it and ping are allowed`);
  }
  switch (msg.op) {
    case "pty.create": {
      const s = ctx.ptys.create({
        cols: msg["cols"] as number | undefined,
        rows: msg["rows"] as number | undefined,
        shell: msg["shell"] as string | undefined,
        cwd: msg["cwd"] as string | undefined,
        env: msg["env"] as Record<string, string> | undefined,
      });
      // The forward's fallback: a printed sign-in URL names its callback port even when no shim ran.
      const scanner = new TerminalUrlScanner(undefined, () => s.cols);
      const local = new TerminalUrlScanner(settledLocalPorts, () => s.cols);
      s.attach(data => {
        for (const port of scanner.feed(data)) ctx.broadcast({ type: "callback.port", port });
        for (const port of local.feed(data)) ctx.broadcast({ type: "localhost.url", port });
      });
      reply(ws, msg.id, { ptyId: s.id, pid: s.pid });
      return;
    }
    case "pty.attach": {
      const s = requirePty(ctx.ptys, msg);
      const unData = s.attach(data => push(ws, { type: "pty.data", ptyId: s.id, data }));
      const unExit = s.onExit(e => {
        ctx.modes.remove(s.id);
        push(ws, { type: "pty.exit", ptyId: s.id, exitCode: e.exitCode, signal: e.signal });
      });
      // onExit fires synchronously for an already-dead pty; never start polling one.
      const unMode = s.exited ? () => {} : ctx.modes.attach(s.id, s.pid, e => push(ws, e));
      state.detaches.push(unData, unExit, unMode);
      reply(ws, msg.id, { ptyId: s.id });
      return;
    }
    case "pty.write": {
      requirePty(ctx.ptys, msg).write(String(msg["data"] ?? ""));
      reply(ws, msg.id, {});
      return;
    }
    case "pty.resize": {
      requirePty(ctx.ptys, msg).resize(Number(msg["cols"]), Number(msg["rows"]));
      reply(ws, msg.id, {});
      return;
    }
    case "pty.kill": {
      const id = requirePty(ctx.ptys, msg).id;
      ctx.modes.remove(id);
      ctx.ptys.destroy(id);
      reply(ws, msg.id, {});
      return;
    }
    case "pty.list": {
      reply(ws, msg.id, { ptys: ctx.ptys.list() });
      return;
    }
    case "ports.watch": {
      const w = ctx.getPortWatcher();
      subscribe(state, ws, w, ["port.open", "port.close"]);
      await w.poll();
      reply(ws, msg.id, { ports: w.current() });
      return;
    }
    case "manifest.get": {
      reply(ws, msg.id, { entries: ctx.manifest.entries() });
      return;
    }
    case "manifest.record": {
      const entry = ctx.manifest.record({
        cmd: String(msg["cmd"] ?? ""),
        cwd: String(msg["cwd"] ?? "/root"),
        ...(msg["port"] !== undefined ? { port: Number(msg["port"]) } : {}),
      });
      reply(ws, msg.id, { entry });
      return;
    }
    case "manifest.restartScript": {
      reply(ws, msg.id, { script: ctx.manifest.toRestartScript() });
      return;
    }
    case "inbox.watch": {
      subscribe(state, ws, ctx.getInboxWatcher(), ["inbox.file"]);
      reply(ws, msg.id, {});
      return;
    }
    case "inbox.rescan": {
      const files = await ctx.getInboxWatcher().rescan();
      for (const e of files) push(ws, e);
      reply(ws, msg.id, { count: files.length });
      return;
    }
    case "sys.watch": {
      state.detaches.push(ctx.getSysSampler().subscribe(s => push(ws, s)));
      reply(ws, msg.id, {});
      return;
    }
    case "proc.watch": {
      if (state.unwatchProcs === undefined) {
        const un = ctx.getProcSampler().subscribe(e => push(ws, e));
        state.unwatchProcs = un;
        state.detaches.push(un);
      }
      reply(ws, msg.id, {});
      return;
    }
    case "proc.unwatch": {
      const un = state.unwatchProcs;
      if (un !== undefined) {
        un();
        state.detaches = state.detaches.filter(d => d !== un);
        state.unwatchProcs = undefined;
      }
      reply(ws, msg.id, {});
      return;
    }
    case "proc.inspect": {
      reply(ws, msg.id, await ctx.getProcSampler().inspect(requirePid(msg)));
      return;
    }
    case "proc.kill": {
      const signal = optionalEnum(msg, "signal", ["TERM", "KILL"] as const);
      if (signal === undefined) throw new OpError("bad-request", "signal is required");
      killProcess(requirePid(msg), signal, { self: process.pid, parent: process.ppid });
      reply(ws, msg.id, {});
      return;
    }
    case "fs.list": {
      const dir = await resolveInside(ctx.root, requireString(msg, "path"));
      reply(ws, msg.id, await listDir(dir, { gitignore: msg["gitignore"] === true }));
      return;
    }
    case "fs.read": {
      const encoding = optionalEnum<FsReadEncoding>(msg, "encoding", ["utf8", "base64"]);
      const file = await resolveInside(ctx.root, requireString(msg, "path"));
      reply(ws, msg.id, await readFileBounded(file, encoding));
      return;
    }
    case "git.status": {
      const cwd = await resolveInside(ctx.root, requireString(msg, "cwd"));
      reply(ws, msg.id, await gitStatus(cwd));
      return;
    }
    case "git.diff": {
      const scope = optionalEnum<GitDiffScope>(msg, "scope", ["branch", "unstaged", "staged"]);
      if (scope === undefined) throw new OpError("bad-request", "scope is required");
      const path = msg["path"];
      if (path !== undefined && typeof path !== "string") throw new OpError("bad-request", "path must be a string");
      const cwd = await resolveInside(ctx.root, requireString(msg, "cwd"));
      reply(ws, msg.id, await gitDiff(cwd, scope, path));
      return;
    }
    case "tunnel.open": {
      const tunnelId = requireString(msg, "tunnelId");
      const port = msg["port"];
      if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
        throw new OpError("bad-request", "port must be an integer in 1..65535");
      }
      if (state.tunnels.has(tunnelId)) throw new OpError("bad-request", `tunnel ${tunnelId} is already open`);
      if (state.tunnels.size >= TUNNEL_CAP) throw new OpError("bad-request", `too many tunnels open (${TUNNEL_CAP})`);
      const sock = await connectLoopback(port as number);
      if (ws.readyState !== ws.OPEN) {
        sock.destroy();
        throw new Error("client went away while the guest port was dialled");
      }
      state.tunnels.set(tunnelId, sock);
      sock.on("data", (d: Buffer) => push(ws, { type: "tunnel.data", tunnelId, data: d.toString("base64") }));
      sock.on("error", () => {});
      sock.on("close", () => {
        if (state.tunnels.get(tunnelId) === sock) state.tunnels.delete(tunnelId);
        push(ws, { type: "tunnel.end", tunnelId });
      });
      reply(ws, msg.id, {});
      return;
    }
    case "tunnel.write": {
      requireTunnel(state, msg).write(Buffer.from(requireString(msg, "data"), "base64"));
      reply(ws, msg.id, {});
      return;
    }
    case "tunnel.close": {
      const id = String(msg["tunnelId"] ?? "");
      state.tunnels.get(id)?.destroy();
      state.tunnels.delete(id);
      reply(ws, msg.id, {});
      return;
    }
    case "ping": {
      // App-level heartbeat: the previewUrl edge sweeps idle connections and
      // browser clients cannot send protocol pings.
      reply(ws, msg.id, {});
      return;
    }
    default:
      fail(ws, msg.id, `unknown op: ${String(msg.op)}`);
  }
}

