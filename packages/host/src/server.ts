// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { serveRuntime, type Runtime } from "@wsp/runtime";
import { SHELL_HTML } from "./shell.js";

// The enriched status now lives in @wsp/runtime (every client reads one
// implementation); re-exported so host consumers keep their imports.
export type { ReachState, ReachStatus, WorkspaceStatus } from "@wsp/runtime";

export interface HostOptions {
  runtime: Runtime;
  /** HTTP port for the status shell (0 picks a free one). Default 4400. */
  port?: number;
  /** Port for serveRuntime's WS (0 picks a free one). Default 4410. */
  wsPort?: number;
  /** Auth token for the runtime WS; generated when omitted. */
  authToken?: string;
  /** Envs baked into workspaces created from the shell. */
  workspaceEnvs?: Record<string, string>;
  probeTimeoutMs?: number;
}

export interface HostHandle {
  port: number;
  wsPort: number;
  authToken: string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function startHost(opts: HostOptions): Promise<HostHandle> {
  const rt = opts.runtime;
  const authToken = opts.authToken ?? randomBytes(24).toString("base64url");
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2500;

  const rtServer = await serveRuntime(rt, { port: opts.wsPort ?? 4410, authToken });
  const shell = SHELL_HTML.replace("__WS_ENDPOINT__", `ws://127.0.0.1:${rtServer.port}`);

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(shell);
        return;
      }
      if (req.method === "GET" && path === "/api/workspaces") {
        sendJson(res, 200, { workspaces: await rt.status.list({ probeTimeoutMs }) });
        return;
      }
      if (req.method === "POST" && path === "/api/workspaces") {
        const body = (await readJsonBody(req)) as { name?: unknown };
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) {
          sendJson(res, 400, { error: "a workspace needs a name" });
          return;
        }
        const manifest = await rt.golden.get();
        const head = manifest?.versions.find(v => v.version === manifest.head);
        if (!head) {
          sendJson(res, 409, { error: "no golden image yet; build one first (wspx golden build)" });
          return;
        }
        const workspace = await rt.workspaces.create({
          golden: head.snapshotId,
          name,
          ...(opts.workspaceEnvs !== undefined ? { envs: opts.workspaceEnvs } : {}),
          labels: { wsp: "1", "wsp-host": "1", createdAt: new Date().toISOString() },
        });
        sendJson(res, 200, { workspace });
        return;
      }
      sendJson(res, 404, { error: `no route: ${req.method} ${path}` });
    })().catch((e: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The shell is a local status page; never expose it beyond loopback.
    server.listen(opts.port ?? 4400, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? 4400);

  return {
    port,
    wsPort: rtServer.port,
    authToken,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
      await rtServer.close();
    },
  };
}
