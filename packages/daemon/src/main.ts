import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { PtyManager } from "./pty-manager.js";

export const DEFAULT_PORT = 7070;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_TOKEN_PATH = "/root/.wsp-daemon-token";

export interface DaemonOptions {
  host?: string;
  port?: number;
  token?: string;
  tokenPath?: string;
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
      try {
        handle(ws, state, ptys, msg);
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id ?? null, ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
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
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())));
      ptys.destroyAll();
    },
  };
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

function handle(ws: WebSocket, state: ConnState, ptys: PtyManager, msg: Request): void {
  switch (msg.op) {
    case "pty.create": {
      const s = ptys.create({
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
      const s = requirePty(ptys, msg);
      const unData = s.attach(data => push(ws, { type: "pty.data", ptyId: s.id, data }));
      const unExit = s.onExit(e => push(ws, { type: "pty.exit", ptyId: s.id, exitCode: e.exitCode, signal: e.signal }));
      state.detaches.push(unData, unExit);
      reply(ws, msg.id, { ptyId: s.id });
      return;
    }
    case "pty.write": {
      const s = requirePty(ptys, msg);
      s.write(String(msg["data"] ?? ""));
      reply(ws, msg.id, {});
      return;
    }
    case "pty.resize": {
      const s = requirePty(ptys, msg);
      s.resize(Number(msg["cols"]), Number(msg["rows"]));
      reply(ws, msg.id, {});
      return;
    }
    case "pty.kill": {
      const s = requirePty(ptys, msg);
      ptys.destroy(s.id);
      reply(ws, msg.id, {});
      return;
    }
    case "pty.list": {
      reply(ws, msg.id, { ptys: ptys.list() });
      return;
    }
    default:
      fail(ws, msg.id, `unknown op: ${String(msg.op)}`);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startDaemon()
    .then(d => console.log(`wsp-daemon listening on ${DEFAULT_HOST}:${d.port}`))
    .catch(e => {
      console.error("wsp-daemon failed to start:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
