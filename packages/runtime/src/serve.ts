// Protocol server over WS. Auth model: the long-lived authToken travels only
// in an `auth` frame on an already-open socket (never in a URL, where it would
// land in logs); anything else that needs to authenticate a NEW socket uses a
// 5-minute single-use ticket minted over an authed socket (`ticket.issue`) and
// redeemed as `?ticket=...` on the next connect.

import { randomBytes } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { RuntimeRequest } from "@wsp/protocol";
import type { Runtime } from "./runtime.js";

export interface ServeOptions {
  port: number;
  authToken: string;
  host?: string;
  ticketTtlMs?: number;
  /** Injectable clock for ticket-expiry tests. */
  now?: () => number;
}

export interface RuntimeServer {
  port: number;
  close(): Promise<void>;
}

interface Ticket {
  purpose: string;
  expiresAt: number;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function serveRuntime(rt: Runtime, opts: ServeOptions): Promise<RuntimeServer> {
  if (!opts.authToken) throw new Error("serveRuntime refuses to start without an auth token");
  const now = opts.now ?? Date.now;
  const ticketTtlMs = opts.ticketTtlMs ?? 300_000;
  const tickets = new Map<string, Ticket>();

  const wss = new WebSocketServer({ host: opts.host ?? "127.0.0.1", port: opts.port });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", "ws://localhost");
    const ticketParam = url.searchParams.get("ticket");
    let authed = false;
    if (ticketParam !== null) {
      const ticket = tickets.get(ticketParam);
      tickets.delete(ticketParam); // single-use, spent even when expired
      if (!ticket || ticket.purpose !== "connect" || now() > ticket.expiresAt) {
        ws.close(4401, "unauthorized");
        return;
      }
      authed = true;
    }

    const detaches: (() => void)[] = [];
    ws.on("close", () => {
      for (const un of detaches) un();
      detaches.length = 0;
    });

    const send = (payload: Record<string, unknown>): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    ws.on("message", raw => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          send({ id: null, ok: false, error: "invalid json" });
          if (!authed) ws.close(4401, "unauthorized");
          return;
        }
        const req2 = RuntimeRequest.safeParse(parsed);
        if (!req2.success) {
          send({ id: (parsed as { id?: string | number }).id ?? null, ok: false, error: req2.error.message });
          if (!authed) ws.close(4401, "unauthorized");
          return;
        }
        const msg = req2.data;

        if (!authed) {
          if (msg.op !== "auth" || !safeEqual(msg.token, opts.authToken)) {
            send({ id: msg.id, ok: false, error: "unauthorized" });
            ws.close(4401, "unauthorized");
            return;
          }
          authed = true;
          send({ id: msg.id, ok: true });
          return;
        }

        try {
          switch (msg.op) {
            case "auth":
              send({ id: msg.id, ok: true });
              return;
            case "ticket.issue": {
              const ticket = randomBytes(24).toString("base64url");
              const expiresAt = now() + ticketTtlMs;
              tickets.set(ticket, { purpose: msg.purpose, expiresAt });
              send({ id: msg.id, ok: true, ticket, expiresAt });
              return;
            }
            case "events.subscribe":
              detaches.push(rt.events.on("*", e => send(e as unknown as Record<string, unknown>)));
              send({ id: msg.id, ok: true });
              return;
            case "status.subscribe":
              // Watch before the snapshot so no change falls between them;
              // socket close releases the watcher via detaches.
              detaches.push(rt.status.watch());
              send({ id: msg.id, ok: true, statuses: await rt.status.list() });
              return;
            case "workspaces.create": {
              const { id, op, ...rest } = msg;
              void op;
              send({ id, ok: true, workspace: await rt.workspaces.create(rest) });
              return;
            }
            case "workspaces.list":
              send({ id: msg.id, ok: true, workspaces: await rt.workspaces.list() });
              return;
            case "workspaces.get":
              send({ id: msg.id, ok: true, workspace: await rt.workspaces.get(msg.workspaceId) });
              return;
            case "workspaces.nap":
              send({ id: msg.id, ok: true, workspace: await rt.workspaces.nap(msg.workspaceId) });
              return;
            case "workspaces.wake":
              send({ id: msg.id, ok: true, workspace: await rt.workspaces.wake(msg.workspaceId) });
              return;
            case "workspaces.upgrade": {
              const spec = {
                ...(msg.cpu !== undefined ? { cpu: msg.cpu } : {}),
                ...(msg.memMb !== undefined ? { memMb: msg.memMb } : {}),
              };
              send({ id: msg.id, ok: true, workspace: await rt.workspaces.upgrade(msg.workspaceId, spec) });
              return;
            }
            case "workspaces.delete":
              await rt.workspaces.delete(msg.workspaceId);
              send({ id: msg.id, ok: true });
              return;
            case "workspaces.daemonReach":
              send({ id: msg.id, ok: true, reach: await rt.workspaces.daemonReach(msg.workspaceId) });
              return;
            case "sessions.start": {
              const handle = await rt.sessions.start(msg.workspaceId, {
                prompt: msg.prompt,
                ...(msg.harness !== undefined ? { harness: msg.harness } : {}),
                ...(msg.resume !== undefined ? { resume: msg.resume } : {}),
                ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
              });
              send({ id: msg.id, ok: true, session: handle.view() });
              return;
            }
            case "sessions.list":
              send({ id: msg.id, ok: true, sessions: rt.sessions.list(msg.workspaceId) });
              return;
            case "sessions.history":
              send({ id: msg.id, ok: true, events: await rt.sessions.history(msg.workspaceId) });
              return;
            case "golden.get":
              send({ id: msg.id, ok: true, manifest: await rt.golden.get(msg.name) });
              return;
            case "capabilities.get":
              send({ id: msg.id, ok: true, capabilities: rt.backend.capabilities });
              return;
          }
        } catch (e) {
          send({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const addr = wss.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;

  return {
    port,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => wss.close(err => (err ? reject(err) : resolve())));
    },
  };
}
