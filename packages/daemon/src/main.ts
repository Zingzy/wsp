import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { InboxWatcher } from "./inbox.js";
import { ProcessManifest, type ManifestOptions } from "./manifest.js";
import { PortWatcher, procNetTcpSource, type PortSnapshotSource } from "./ports.js";
import { PtyManager } from "./pty-manager.js";

export const DEFAULT_PORT = 7070;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_TOKEN_PATH = "/root/.wsp-daemon-token";
export const DEFAULT_INBOX_DIR = "/root/inbox";
export const DEFAULT_MANIFEST_PATH = "/root/.wsp/manifest.json";

export interface DaemonOptions {
  host?: string;
  port?: number;
  token?: string;
  tokenPath?: string;
  portsSource?: PortSnapshotSource;
  portsIntervalMs?: number;
  inboxDir?: string;
  inboxQuietMs?: number;
  inboxPollMs?: number;
  manifest?: ManifestOptions;
}

export interface DaemonHandle {
  port: number;
  ptys: PtyManager;
  close(): Promise<void>;
}

interface Request {
  id?: string | number;
  op?: string;
  [k: string]: unknown;
}

interface ConnState {
  detaches: (() => void)[];
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const token = opts.token ?? readFileSync(opts.tokenPath ?? DEFAULT_TOKEN_PATH, "utf8").trim();
  if (!token) throw new Error("daemon refuses to start without an auth token");

  const ptys = new PtyManager();
  const manifest = new ProcessManifest(opts.manifest ?? { path: DEFAULT_MANIFEST_PATH });
  // Watchers are created on first watch op so darwin tests never touch /proc.
  let portWatcher: PortWatcher | null = null;
  let inboxWatcher: InboxWatcher | null = null;

  const getPortWatcher = () => {
    if (!portWatcher) {
      portWatcher = new PortWatcher(opts.portsSource ?? procNetTcpSource(), {
        intervalMs: opts.portsIntervalMs ?? 1000,
      });
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

  const ctx: Ctx = { ptys, manifest, getPortWatcher, getInboxWatcher };
  const wss = new WebSocketServer({ host: opts.host ?? DEFAULT_HOST, port: opts.port ?? DEFAULT_PORT });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", "ws://localhost");
    if (url.searchParams.get("token") !== token) {
      ws.close(4401, "unauthorized");
      return;
    }
    const state: ConnState = { detaches: [] };
    ws.on("close", () => {
      // Client is gone; ptys keep running. Only this socket's subscriptions die.
      for (const un of state.detaches) un();
      state.detaches = [];
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
        ws.send(JSON.stringify({ id: msg.id ?? null, ok: false, error: e instanceof Error ? e.message : String(e) }));
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const addr = wss.address();
  const boundPort = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? DEFAULT_PORT);

  return {
    port: boundPort,
    ptys,
    close: async () => {
      portWatcher?.stop();
      inboxWatcher?.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())));
      ptys.destroyAll();
    },
  };
}

interface Ctx {
  ptys: PtyManager;
  manifest: ProcessManifest;
  getPortWatcher(): PortWatcher;
  getInboxWatcher(): InboxWatcher;
}

function reply(ws: WebSocket, id: Request["id"], payload: Record<string, unknown>): void {
  ws.send(JSON.stringify({ id: id ?? null, ok: true, ...payload }));
}

function fail(ws: WebSocket, id: Request["id"], error: string): void {
  ws.send(JSON.stringify({ id: id ?? null, ok: false, error }));
}

function push(ws: WebSocket, event: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function requirePty(ptys: PtyManager, msg: Request) {
  const ptyId = String(msg["ptyId"] ?? "");
  const s = ptys.get(ptyId);
  if (!s) throw new Error(`no such pty: ${ptyId}`);
  return s;
}

function subscribe(state: ConnState, ws: WebSocket, emitter: NodeJS.EventEmitter, events: string[]): void {
  for (const name of events) {
    const forward = (e: Record<string, unknown>) => push(ws, e);
    emitter.on(name, forward);
    state.detaches.push(() => emitter.off(name, forward));
  }
}

async function handle(ws: WebSocket, state: ConnState, ctx: Ctx, msg: Request): Promise<void> {
  switch (msg.op) {
    case "pty.create": {
      const s = ctx.ptys.create({
        cols: msg["cols"] as number | undefined,
        rows: msg["rows"] as number | undefined,
        shell: msg["shell"] as string | undefined,
        cwd: msg["cwd"] as string | undefined,
        env: msg["env"] as Record<string, string> | undefined,
      });
      reply(ws, msg.id, { ptyId: s.id, pid: s.pid });
      return;
    }
    case "pty.attach": {
      const s = requirePty(ctx.ptys, msg);
      const unData = s.attach(data => push(ws, { type: "pty.data", ptyId: s.id, data }));
      const unExit = s.onExit(e => push(ws, { type: "pty.exit", ptyId: s.id, exitCode: e.exitCode, signal: e.signal }));
      state.detaches.push(unData, unExit);
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
      ctx.ptys.destroy(requirePty(ctx.ptys, msg).id);
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
    default:
      fail(ws, msg.id, `unknown op: ${String(msg.op)}`);
  }
}

