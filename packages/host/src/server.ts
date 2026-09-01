// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  DAEMON_PORT,
  previewIsFresh,
  type MachineState,
  type PreviewReach,
} from "@wsp/engine";
import { serveRuntime, type Runtime, type WorkspaceView } from "@wsp/runtime";
import { SHELL_HTML } from "./shell.js";

export type ReachState = "reachable" | "no-daemon" | "unreachable" | "napping" | "unsupported" | "gone";

export interface ReachStatus {
  state: ReachState;
  url?: string;
  expiresAt?: number;
}

export interface WorkspaceStatus extends WorkspaceView {
  machineState: MachineState;
  reach: ReachStatus;
}

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

/** One HTTP round trip against the minted URL. 502 means the edge dialed the
 * guest and nothing listens on the daemon port; any other response came from
 * inside the guest (the daemon's ws server answers plain HTTP with 426). */
async function probe(url: string, timeoutMs: number): Promise<ReachState> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.text().catch(() => "");
    return res.status === 502 ? "no-daemon" : "reachable";
  } catch {
    return "unreachable";
  }
}

async function workspaceStatuses(
  rt: Runtime,
  reachCache: Map<string, PreviewReach>,
  probeTimeoutMs: number,
): Promise<WorkspaceStatus[]> {
  const views = await rt.workspaces.list();
  if (views.length === 0) return [];
  // One list() call covers machine states for every workspace.
  const machineStates = new Map((await rt.backend.list()).map(m => [m.id, m.state]));

  return Promise.all(
    views.map(async (view): Promise<WorkspaceStatus> => {
      const machineState = machineStates.get(view.machineId) ?? "gone";
      if (machineState === "gone") {
        reachCache.delete(view.machineId);
        return { ...view, machineState, reach: { state: "gone" } };
      }
      if (view.phase === "napping" || machineState !== "running") {
        // Measured: the reach goes dark only while paused and works again on
        // wake, so the cached entry stays for the next running poll.
        return { ...view, machineState, reach: { state: "napping" } };
      }

      let reach = reachCache.get(view.machineId);
      if (!reach || !previewIsFresh(reach)) {
        try {
          const machine = await rt.backend.get(view.machineId);
          if (!machine.previewUrl) return { ...view, machineState, reach: { state: "unsupported" } };
          reach = await machine.previewUrl(DAEMON_PORT);
          reachCache.set(view.machineId, reach);
        } catch {
          return { ...view, machineState, reach: { state: "unreachable" } };
        }
      }
      const state = await probe(reach.url, probeTimeoutMs);
      return { ...view, machineState, reach: { state, url: reach.url, expiresAt: reach.expiresAt } };
    }),
  );
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
  const reachCache = new Map<string, PreviewReach>();

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
        sendJson(res, 200, { workspaces: await workspaceStatuses(rt, reachCache, probeTimeoutMs) });
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
