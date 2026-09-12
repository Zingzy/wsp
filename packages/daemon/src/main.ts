import { timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import {
  AUTH_DEADLINE_MS,
  DAEMON_AUTH_DEADLINE_PASSED,
  DAEMON_DEFAULT_HOST,
  DAEMON_DEFAULT_PORT,
  DAEMON_FIRST_FRAME_NOT_AUTH,
  DAEMON_INVALID_JSON,
  DAEMON_NO_TOKEN,
  DAEMON_PRE_AUTH_BYTES_EXCEEDED,
  DAEMON_ROOTS_PATH,
  DAEMON_TOKEN_PATH,
  DAEMON_TOKEN_REFUSED,
  DAEMON_VERSION,
  DaemonAuthRequest,
  EXEC_TIMEOUT_DEFAULT_MS,
  GUEST_INBOX_DIR,
  GUEST_MANIFEST_PATH,
  MachineErrorKind,
  NOT_ON_THIS_ROAD,
  PID_MAX,
  PRE_AUTH_MAX_BYTES,
  TUNNEL_CAP,
  callbackPortOf,
  portScopeRefusal,
  unknownOpLine,
  type DaemonEvent,
  type WorkspaceKind,
} from "@wsp/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { runExec } from "./exec.js";
import { listDir, readFileBounded, type FsReadEncoding } from "./fs-ops.js";
import { PlaceLink, type LinkOps, type PlaceLinkOptions } from "./link.js";
import { gitDiff, gitStatus, type GitDiffScope } from "./git-ops.js";
import { InboxWatcher } from "./inbox.js";
import { ProcessManifest, type ManifestOptions } from "./manifest.js";
import { linuxModeProbe, ModeWatcher, type ModeProbe } from "./mode.js";
import { PortWatcher, portSourceFor, procNetTcpSource, type PortOpenEvent, type PortSnapshotSource } from "./ports.js";
import { killProcess, ProcSampler } from "./proc.js";
import { readingsFor, type ReadingsOptions } from "./readings.js";
import { PtyManager } from "./pty-manager.js";
import { SysSampler, type SysSource } from "./sys.js";
import { localhostPortOf, settledLocalPorts } from "./local-urls.js";
import { CallbackSpotter, TerminalUrlScanner, listenOpenSocket, type OpenSocket } from "./relay.js";
import { OpError, resolveInside } from "./workspace-paths.js";

/** What starts a daemon in this process. The bin reads the same set off its flags (DaemonArgs in args.ts), one
 * flag per option here, and the test harness hands one set to whichever daemon it drives. The three readings a
 * caller may hand in as functions (portsSource, sysSource, modeProbe) have no flag: the daemon's own suite drives
 * every daemon by files under procRoot instead, and they stay for the harnesses of other packages that stand a
 * daemon in for a guest. */
export interface DaemonOptions {
  host?: string;
  port?: number;
  /** A fixed token (local runs, tests); without it every auth frame is checked against tokenPath as it is then. */
  token?: string;
  tokenPath?: string;
  /** How long a fresh socket has to send its auth frame. */
  authDeadlineMs?: number;
  /** This machine's listening ports, when a caller reads them itself; the platform's road otherwise, or the fake
   * /proc under procRoot. */
  portsSource?: PortSnapshotSource;
  portsIntervalMs?: number;
  /** Which kind of machine this daemon serves, which picks the modules its Live rows and Processes tab read: a
   * guest wsp forked by default, the host itself where this computer's own workspace runs it in process. */
  kind?: WorkspaceKind;
  /** The folder turns write in, whose volume this computer's disk row reads; the daemon's own root by default,
   * which for a guest is the workspace folder and for this computer is the person's home. */
  workFolder?: string;
  inboxDir?: string;
  inboxQuietMs?: number;
  inboxPollMs?: number;
  manifest?: ManifestOptions;
  /** A caller's own reading of the pty modes; the stty probe over procRoot otherwise. */
  modeProbe?: ModeProbe;
  modeIntervalMs?: number;
  /** A caller's own reading of this machine's load; the kind's module over procRoot otherwise. */
  sysSource?: SysSource;
  sysIntervalMs?: number;
  /** A directory laid out like /proc, which every /proc reading takes: the ports, the load, the processes and the
   * pty modes. For tests on darwin; the real one otherwise. */
  procRoot?: string;
  procPasswdPath?: string;
  procIntervalMs?: number;
  /** Every fs.* and git.* path must resolve inside this directory or a folder the roots file names; HOME by default. */
  root?: string;
  /** The file naming the imported project folders, one absolute path per line, read on every fs.* and git.* op. */
  rootsPath?: string;
  /** Unix socket the browser shim posts URLs to; absent means no shim socket (local and test daemons). */
  openSocketPath?: string;
  /** Where the bound port is written once the listener is up: the one fact a caller that asked for port 0 cannot
   * know before, and the file the host reads it back off on a machine somebody owns. */
  portFile?: string;
  /** The host this daemon dials instead of waiting to be dialled: a computer somebody joined as a place. The link
   * opens one socket outward and hands it to the same serve every inbound socket gets, so a joined computer speaks
   * what a fork speaks. Absent leaves the daemon inbound only, which is every other kind. */
  link?: Omit<PlaceLinkOptions, "daemonPort">;
  /** One line per event of the daemon's own, in the sentences the protocol names: the bin writes them to stderr,
   * a place agent to its log, a test to its lines. Nothing by default. */
  log?: (line: string) => void;
}

export interface DaemonHandle {
  port: number;
  /** The ptys this daemon holds, for a harness that stands it in for a guest; a client asks pty.list. */
  ptys: PtyManager;
  /** The link this daemon holds outward, on a place; absent on every other kind. */
  link?: PlaceLink;
  close(): Promise<void>;
}

interface Request {
  id?: string | number;
  op?: string;
  [k: string]: unknown;
}

interface ConnState {
  detaches: (() => void)[];
  tunnels: Map<string, Socket>;
  /** The ops the road that opened this socket answers itself; read before the switch, so an act that belongs to a
   * road rather than to the daemon lives with that road. Only the outbound link registers any. */
  ops?: LinkOps;
  /** Set when the auth frame named a port: only tunnel ops on it and ping are answered. */
  port?: number;
  /** This socket's proc.watch, so proc.unwatch can end it before the socket does. */
  unwatchProcs?: () => void;
  /** Set when the socket went, so an op that awaited something takes nothing on for a client that has left: the
   * close drains what this socket holds once, and a subscription made after that drain is one nothing removes. */
  closed?: boolean;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  // Read per auth frame, not once: the host rotates the file on every start and the daemon keeps running.
  const currentToken = (): string => (opts.token ?? readFileSync(opts.tokenPath ?? DAEMON_TOKEN_PATH, "utf8")).trim();
  if (!currentToken()) throw new Error(DAEMON_NO_TOKEN);
  const authDeadlineMs = opts.authDeadlineMs ?? AUTH_DEADLINE_MS;
  const log = opts.log ?? (() => {});

  const ptys = new PtyManager();
  const manifest = new ProcessManifest({ path: GUEST_MANIFEST_PATH, ...opts.manifest });
  const spotter = new CallbackSpotter();
  // Watchers are created on first watch op so darwin tests never touch /proc.
  let portWatcher: PortWatcher | null = null;
  let inboxWatcher: InboxWatcher | null = null;
  let sysSampler: SysSampler | null = null;
  let procSampler: ProcSampler | null = null;

  // A fake /proc stands in for the whole machine, ports included, so a test on darwin drives the Linux road.
  const portsSource = opts.portsSource ?? (opts.procRoot !== undefined ? procNetTcpSource(opts.procRoot) : portSourceFor(platform()));
  const getPortWatcher = () => {
    if (!portWatcher) {
      portWatcher = new PortWatcher(portsSource, {
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
        dir: opts.inboxDir ?? GUEST_INBOX_DIR,
        ...(opts.inboxQuietMs !== undefined ? { quietMs: opts.inboxQuietMs } : {}),
        ...(opts.inboxPollMs !== undefined ? { pollMs: opts.inboxPollMs } : {}),
      });
      inboxWatcher.start();
    }
    return inboxWatcher;
  };

  const root = resolve(opts.root ?? process.env["HOME"] ?? homedir());
  const rootsPath = opts.rootsPath ?? DAEMON_ROOTS_PATH;
  // Read per op, not once: the host writes the file when a project lands and the daemon keeps running.
  const roots = async (): Promise<string[]> => {
    let named = "";
    try {
      named = await readFile(rootsPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const extra = named.split("\n").map(line => line.trim()).filter(line => line.startsWith("/"));
    return [...new Set([root, ...extra])];
  };
  /** Which kind of machine this daemon answers for; a guest wsp forked unless the host that started it says otherwise. */
  const kind = opts.kind ?? "cloud";
  /** What this machine's own two modules are built from; the kind picks which modules those are. */
  const readingsOptions = (): ReadingsOptions => ({
    root,
    workFolder: opts.workFolder ?? root,
    ports: portsSource,
    platform: platform(),
    ...(opts.procRoot !== undefined ? { procRoot: opts.procRoot } : {}),
    ...(opts.procPasswdPath !== undefined ? { passwdPath: opts.procPasswdPath } : {}),
  });
  const getSysSampler = () => {
    sysSampler ??= new SysSampler(opts.sysSource ?? readingsFor(kind).metrics(readingsOptions()), {
      log,
      ...(opts.sysIntervalMs !== undefined ? { intervalMs: opts.sysIntervalMs } : {}),
    });
    return sysSampler;
  };
  const getProcSampler = () => {
    procSampler ??= new ProcSampler(readingsFor(kind).processes(readingsOptions()), {
      log,
      // An exited pty's pid can be reused by a stranger; only live shells carry the label.
      ptys: () => ptys.list().filter(p => !p.exited),
      ...(opts.procIntervalMs !== undefined ? { intervalMs: opts.procIntervalMs } : {}),
    });
    return procSampler;
  };

  // Inert until a pty.attach; the probe reads /proc and fails silently where there is none, so an attach on darwin
  // without a fake tree still passes.
  const modes = new ModeWatcher(opts.modeProbe ?? linuxModeProbe(opts.procRoot), {
    ...(opts.modeIntervalMs !== undefined ? { intervalMs: opts.modeIntervalMs } : {}),
  });

  const wss = new WebSocketServer({ host: opts.host ?? DAEMON_DEFAULT_HOST, port: opts.port ?? DAEMON_DEFAULT_PORT });
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
  // Every op that belongs to the link a place opens outward, so one sentence refuses all of them on a socket that
  // is not that link. The leave op is always one of them, whether or not this process is holding a link: which ops
  // belong to that road is a fact of the wire, and a daemon with no link must still refuse it rather than call it
  // an op it has never heard of. The rest are whatever the road that dialled out registered.
  const linkOnly = new Set(["place.leave", ...Object.keys(opts.link?.ops ?? {})]);
  const ctx: Ctx = { ptys, manifest, modes, root, roots, getPortWatcher, getInboxWatcher, getSysSampler, getProcSampler, spotter, broadcast, linkOnly };
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
      if (ws.readyState === ws.OPEN) ws.close(4401, DAEMON_PRE_AUTH_BYTES_EXCEEDED);
      else wire.destroy();
    };
    wire.prependListener("data", countPreAuth);
    // With the server on 0.0.0.0 the first frame is the only gate: no handler exists until it passes.
    const deadline = setTimeout(() => ws.close(4401, DAEMON_AUTH_DEADLINE_PASSED), authDeadlineMs);
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
        ws.close(4401, DAEMON_FIRST_FRAME_NOT_AUTH);
        return;
      }
      let expected = "";
      try {
        expected = currentToken();
      } catch {
        expected = "";
      }
      if (expected === "" || !safeEqual(auth.data.token, expected)) {
        ws.close(4401, DAEMON_TOKEN_REFUSED);
        return;
      }
      wire.off("data", countPreAuth);
      reply(ws, auth.data.id, {});
      serve(ws, auth.data.port);
    });
  });

  const serve = (ws: WebSocket, port: number | undefined, ops?: LinkOps): void => {
    // A port-scoped socket is there to tunnel one port; the guest's pages and callback ports are not its business.
    if (port === undefined) authed.add(ws);
    push(ws, { type: "daemon.hello", root, version: DAEMON_VERSION });
    const state: ConnState = { detaches: [], tunnels: new Map(), ...(port !== undefined ? { port } : {}), ...(ops !== undefined ? { ops } : {}) };
    ws.on("close", () => {
      // Client is gone; ptys keep running. Only this socket's subscriptions and tunnels die.
      state.closed = true;
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
        ws.send(JSON.stringify({ id: null, ok: false, error: DAEMON_INVALID_JSON }));
        return;
      }
      handle(ws, state, ctx, msg).catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        ws.send(JSON.stringify({ id: msg.id ?? null, ok: false, error, ...(e instanceof OpError ? { code: e.code } : {}), ...refusedAs(e) }));
      });
    });
  };

  await listening;
  const addr = wss.address();
  const boundPort = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? DAEMON_DEFAULT_PORT);
  if (opts.portFile !== undefined) writeFileSync(opts.portFile, `${boundPort}\n`, { mode: 0o600 });

  // The port goes into the report here, since only this call knows it, and the socket the link proves is handed to
  // the same serve an inbound one gets: a joined computer speaks what a fork speaks.
  const link = opts.link === undefined ? undefined : new PlaceLink({ log, ...opts.link, daemonPort: boundPort }, (ws, ops) => serve(ws, undefined, ops));

  return {
    port: boundPort,
    ptys,
    ...(link !== undefined ? { link } : {}),
    close: async () => {
      await link?.close();
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
  roots(): Promise<string[]>;
  getPortWatcher(): PortWatcher;
  getInboxWatcher(): InboxWatcher;
  getSysSampler(): SysSampler;
  getProcSampler(): ProcSampler;
  spotter: CallbackSpotter;
  broadcast(event: DaemonEvent): void;
  /** The op names the outbound link's own table answers, so a socket that is not that link is refused them by
   * name rather than answered with the daemon's own words for an op it does not know. */
  linkOnly: ReadonlySet<string>;
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

/** What a backend's own refusal carries across the wire: its kind and the status it came from, so a machine the
 * far side lost reads missing on the asking computer exactly as it reads here. Only an error that already carries
 * an engine kind has them; every other failure is its sentence alone. */
function refusedAs(e: unknown): { kind?: string; status?: number } {
  const kind = MachineErrorKind.safeParse((e as { kind?: unknown } | undefined)?.kind);
  const status = (e as { status?: unknown } | undefined)?.status;
  return {
    ...(kind.success ? { kind: kind.data } : {}),
    ...(typeof status === "number" ? { status } : {}),
  };
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
    throw new OpError("forbidden", portScopeRefusal(state.port));
  }
  // The road that opened this socket answers its own ops before the daemon's switch sees them, so an act that
  // belongs to a road lives with that road and no other socket can reach it.
  const own = typeof msg.op === "string" ? state.ops?.[msg.op] : undefined;
  if (own !== undefined) {
    reply(ws, msg.id, await own(msg as Record<string, unknown>));
    return;
  }
  // An op the outbound link answers, asked on a socket that is not it: a client holding this daemon's token is a
  // client on this machine, and a client on this machine does not drive the computer's own Docker daemon.
  if (typeof msg.op === "string" && ctx.linkOnly.has(msg.op)) throw new OpError("forbidden", NOT_ON_THIS_ROAD);
  switch (msg.op) {
    case "pty.create": {
      const s = await ctx.ptys.create({
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
      // One read before the watch is taken: a machine whose module cannot read it refuses here, where the pane can
      // say so, rather than accepting a stream it will never send and leaving the rows at pending. The read is
      // awaited, so the socket may go while it runs, and a subscription made after the close drained this socket is
      // one nothing ever removes: the sampler would then read the machine every two seconds for the life of the
      // daemon, once per socket lost that way.
      const sampler = ctx.getSysSampler();
      await sampler.probe();
      if (state.closed) return;
      state.detaches.push(sampler.subscribe(s => push(ws, s)));
      reply(ws, msg.id, {});
      return;
    }
    case "proc.watch": {
      const procs = ctx.getProcSampler();
      await procs.probe();
      if (state.closed) return;
      if (state.unwatchProcs === undefined) {
        const un = procs.subscribe(e => push(ws, e));
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
      const dir = await resolveInside(await ctx.roots(), requireString(msg, "path"));
      reply(ws, msg.id, await listDir(dir, { gitignore: msg["gitignore"] === true }));
      return;
    }
    case "fs.read": {
      const encoding = optionalEnum<FsReadEncoding>(msg, "encoding", ["utf8", "base64"]);
      const file = await resolveInside(await ctx.roots(), requireString(msg, "path"));
      reply(ws, msg.id, await readFileBounded(file, encoding));
      return;
    }
    case "git.status": {
      const cwd = await resolveInside(await ctx.roots(), requireString(msg, "cwd"));
      reply(ws, msg.id, await gitStatus(cwd));
      return;
    }
    case "git.diff": {
      const scope = optionalEnum<GitDiffScope>(msg, "scope", ["branch", "unstaged", "staged"]);
      if (scope === undefined) throw new OpError("bad-request", "scope is required");
      const path = msg["path"];
      if (path !== undefined && typeof path !== "string") throw new OpError("bad-request", "path must be a string");
      const cwd = await resolveInside(await ctx.roots(), requireString(msg, "cwd"));
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
    case "exec": {
      const cmd = requireString(msg, "cmd");
      const asked = msg["timeoutMs"];
      if (asked !== undefined && (!Number.isInteger(asked) || (asked as number) < 1)) throw new OpError("bad-request", "timeoutMs must be a positive integer");
      const stdin = msg["stdin"];
      if (stdin !== undefined && typeof stdin !== "string") throw new OpError("bad-request", "stdin must be base64 bytes as a string");
      reply(
        ws,
        msg.id,
        await runExec(ctx.root, process.env, cmd, {
          timeoutMs: (asked as number | undefined) ?? EXEC_TIMEOUT_DEFAULT_MS,
          ...(stdin !== undefined ? { stdin: Buffer.from(stdin, "base64") } : {}),
        }),
      );
      return;
    }
    case "ping": {
      // App-level heartbeat: the previewUrl edge sweeps idle connections and
      // browser clients cannot send protocol pings.
      reply(ws, msg.id, {});
      return;
    }
    default:
      fail(ws, msg.id, unknownOpLine(String(msg.op)));
  }
}

