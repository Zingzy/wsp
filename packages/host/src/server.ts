// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import type { SparedBuilder } from "@wsp/engine";
import { serveRuntime, type GoldenBuilderView, type Runtime } from "@wsp/runtime";

// The enriched status now lives in @wsp/runtime (every client reads one
// implementation); re-exported so host consumers keep their imports.
export type { ReachState, ReachStatus, WorkspaceStatus } from "@wsp/runtime";

/** Which keys the host loaded. Flags only: the page never sees a value. */
export interface KeyFlags {
  anthropic: boolean;
}

export interface HostOptions {
  runtime: Runtime;
  /** The built web app: index.html plus its assets. */
  webDir: string;
  keys: KeyFlags;
  /** The builder wsp init prepared; the page opens on its terminal for the sign-ins and the save. */
  builder?: GoldenBuilderView;
  /** The sign-ins the person chose to do on that machine, each with its command. */
  checklist?: { label: string; command: string }[];
  /** HTTP port for the app (0 picks a free one). Default 4400. */
  port?: number;
  /** Port for serveRuntime's WS (0 picks a free one). Default 4410. */
  wsPort?: number;
  /** Auth token for the runtime WS; generated when omitted. */
  authToken?: string;
  /** Envs baked into workspaces created from the JSON route. */
  workspaceEnvs?: Record<string, string>;
  probeTimeoutMs?: number;
  /** Receives one line per machine a sweep killed, one per running builder the first sweep left alone, and one when a sweep fails. */
  log?: (line: string) => void;
}

export interface HostHandle {
  port: number;
  wsPort: number;
  authToken: string;
  close(): Promise<void>;
}

/** Orphan sweep period after the one at start. Matches the age a stray
 * workspace machine must reach before reap treats it as abandoned. */
export const REAP_INTERVAL_MS = 10 * 60_000;

// The dev default apps/web/index.html ships; the host swaps it for the real
// boot object so the page carries exactly one inline script.
const BOOT_SCRIPT = /<script>window\.__WSP__ = [^<]*<\/script>/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

interface Boot {
  wsPort: number;
  token: string;
  keys: KeyFlags;
  builder?: GoldenBuilderView;
  checklist?: { label: string; command: string }[];
}

function loadPage(webDir: string, boot: Boot): string {
  const path = join(webDir, "index.html");
  if (!existsSync(path)) throw new Error(`web app not built: ${path} is missing (pnpm --filter @wsp/web build)`);
  const html = readFileSync(path, "utf8");
  if (!BOOT_SCRIPT.test(html)) throw new Error(`${path} has no window.__WSP__ boot line to replace`);
  return html.replace(BOOT_SCRIPT, `<script>window.__WSP__ = ${JSON.stringify(boot)};</script>`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendAsset(res: ServerResponse, webDir: string, path: string): boolean {
  const file = resolvePath(webDir, `.${decodeURIComponent(path)}`);
  if (!file.startsWith(webDir + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
  const body = readFileSync(file);
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "content-length": body.length });
  res.end(body);
  return true;
}

function describeLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return "";
  return ` (${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(" ")})`;
}

function describeAge(ms: number | undefined): string {
  if (ms === undefined) return "age unknown";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s old`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min old`;
  return `${(ms / 3_600_000).toFixed(1)} h old`;
}

function describeSpared(b: SparedBuilder): string {
  const whose = b.owner !== undefined ? `another host's builder (${b.owner})` : "builder with no owner, inside its idle window";
  return `reap: left alone ${b.id}${describeLabels(b.labels)}: ${whose}, ${describeAge(b.ageMs)}, $${b.rateUsdPerHour.toFixed(2)}/h`;
}

/** Kills what this host owns and nothing claims, says which machines went,
 * labels included, and on the first sweep names the running builders it
 * left alone. The listing is only for the log line: reap decides on its own listing. */
async function sweepOrphans(rt: Runtime, log: (line: string) => void, listSpared: boolean): Promise<void> {
  try {
    const labels = new Map((await rt.backend.list()).map(m => [m.id, m.labels]));
    const { reaped, spared } = await rt.reap();
    for (const id of reaped) log(`reap: killed ${id}${describeLabels(labels.get(id))}`);
    if (listSpared) for (const b of spared) log(describeSpared(b));
  } catch (e) {
    log(`reap: sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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
  const webDir = resolvePath(opts.webDir);
  const log = opts.log ?? (() => {});

  const rtServer = await serveRuntime(rt, { port: opts.wsPort ?? 4410, authToken });
  let page: string;
  try {
    page = loadPage(webDir, {
      wsPort: rtServer.port,
      token: authToken,
      keys: opts.keys,
      ...(opts.builder !== undefined ? { builder: opts.builder } : {}),
      ...(opts.checklist !== undefined ? { checklist: opts.checklist } : {}),
    });
  } catch (e) {
    await rtServer.close();
    throw e;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
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
      if (req.method === "GET" && sendAsset(res, webDir, path)) return;
      sendJson(res, 404, { error: `no route: ${req.method} ${path}` });
    })().catch((e: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // The app carries the runtime token; never expose it beyond loopback.
      server.listen(opts.port ?? 4400, "127.0.0.1", resolve);
    });
  } catch (e) {
    await rtServer.close();
    throw e;
  }
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : (opts.port ?? 4400);

  // A sweep that outlives its period (a slow provider listing) must not be
  // joined by the next one: two sweeps would race to kill the same machines.
  let sweeping: Promise<void> | undefined;
  const sweep = (listSpared: boolean): Promise<void> =>
    (sweeping ??= sweepOrphans(rt, log, listSpared).finally(() => (sweeping = undefined)));
  await sweep(true);
  const reapTimer = setInterval(() => void sweep(false), REAP_INTERVAL_MS);

  return {
    port,
    wsPort: rtServer.port,
    authToken,
    close: async () => {
      clearInterval(reapTimer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
      await rtServer.close();
      // Last: with the servers gone nothing can record another event, so the
      // flush this waits on is the final word in the store.
      await rt.close();
    },
  };
}
