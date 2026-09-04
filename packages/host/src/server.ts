// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import type { ChecklistItem } from "@wsp/protocol";
import { describeAge, serveRuntime, type GoldenBuilderView, type GoldenVersion, type ReapedMachine, type Runtime, type RuntimeServer, type SparedMachine } from "@wsp/runtime";
import { startCallbackRelay, systemOpener, type UrlOpener } from "./relay.js";

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
  /** The sign-ins still to do on that machine, each with its command; a function is read on every page load. */
  checklist?: ChecklistItem[] | (() => ChecklistItem[]);
  /** HTTP port for the app (0 picks a free one). Default 4400. */
  port?: number;
  /** Port for serveRuntime's WS (0 picks a free one). Default 4410. */
  wsPort?: number;
  /** Auth token for the runtime WS; generated when omitted. */
  authToken?: string;
  /** Envs baked into a workspace created from the JSON route, given the golden version it forks. */
  workspaceEnvs?: (golden: GoldenVersion) => Record<string, string>;
  probeTimeoutMs?: number;
  /** Receives one line per machine a sweep killed, one per running machine the first sweep left alone, and one when a sweep fails;
   * also one per sign-in page opened and per port forwarded, refused or closed. */
  log?: (line: string) => void;
  /** Opens a guest tool's sign-in URL on this computer; the platform opener by default (the desktop app passes its own). */
  openUrl?: UrlOpener;
  /** Whether a workspace's sign-in page opens here without a click; off by default, the app shows it instead. */
  autoOpen?: (workspaceId: string, url: string) => boolean;
  /** The line logged when a sign-in page arrives and nothing opens, given the workspace name and the page's hostname. */
  openLine?: (workspace: string, hostname: string, url: string) => string;
  /** The saved recipe file, named as the way to reuse a kept builder. */
  recipePath?: string;
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
  checklist?: ChecklistItem[];
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

function describeCost(rateUsdPerHour: number, ageMs: number | undefined): string {
  const rate = `$${rateUsdPerHour.toFixed(2)}/h`;
  return ageMs === undefined ? rate : `${rate} (about $${((Math.max(0, ageMs) / 3_600_000) * rateUsdPerHour).toFixed(2)} so far)`;
}

function kindOf(labels: Record<string, string> | undefined, builder: boolean): string {
  if (builder) return "builder";
  return labels?.["wsp-smoke"] === "1" ? "smoke fork" : "workspace";
}

function describeReaped(r: ReapedMachine): string {
  const kind = kindOf(r.labels, r.builder);
  if (r.reason === "recorded") return `reap: stopped ${r.id}: your earlier builder from this setup; a builder cannot be sealed after a restart`;
  if (r.reason === "unfinished") return `reap: stopped ${r.id}: your earlier builder from this setup; its setup never finished`;
  if (r.reason === "expired" && r.ageMs === undefined) return `reap: stopped ${r.id}: your earlier builder from this setup, age unknown; a kept builder with no readable age is stopped at once`;
  if (r.reason === "expired") return `reap: stopped ${r.id}: your earlier builder from this setup, ${describeAge(r.ageMs)}; a kept builder is stopped at six hours`;
  const why = r.reason === "own" ? `${kind} from this setup that no record claims` : `${kind} with no owner`;
  return `reap: stopped ${r.id}${describeLabels(r.labels)}: ${why}, ${describeAge(r.ageMs)}`;
}

function describeSpared(m: SparedMachine): string {
  const kind = kindOf(m.labels, m.builder);
  const cost = describeCost(m.rateUsdPerHour, m.ageMs);
  if (m.whose === "foreign") {
    return `reap: left alone ${m.id}: ${kind} from another wsp setup (owner ${m.owner}), ${describeAge(m.ageMs)}, ${cost}; kill it from the Solari console if it is yours and forgotten`;
  }
  const who = m.whose === "own" ? `${kind} from this setup that no record claims` : `${kind} with no owner`;
  const claim = m.whose === "own" ? " unless a record claims it first" : "";
  const then = m.ageMs === undefined ? "never reaped by this host" : `reaped once it is ${describeAge(m.backstopMs)}${claim}`;
  return `reap: left alone ${m.id}: ${who}, ${describeAge(m.ageMs)}, ${cost}; ${then}`;
}

/** A first-life builder from an earlier run is claimed, so the sweep never names it; the person still sees what bills. */
function describeKept(b: GoldenBuilderView, rateUsdPerHour: number, recipePath: string | undefined): string {
  const ageMs = Date.now() - Date.parse(b.createdAt);
  const reuse = recipePath === undefined ? "wsp init" : `wsp init --manifest ${recipePath}`;
  return `reap: left alone ${b.id}: your earlier builder from this setup, still first-life, ${describeAge(ageMs)}, ${describeCost(rateUsdPerHour, ageMs)}; reuse it with ${reuse}, or it is stopped at six hours`;
}

/** Kills what this host owns and nothing claims, says which machines went and
 * why, and on the first sweep names the running machines it left alone. */
async function sweepOrphans(rt: Runtime, log: (line: string) => void, listSpared: boolean): Promise<void> {
  try {
    const { reaped, spared, failed } = await rt.reap();
    for (const r of reaped) log(describeReaped(r));
    if (listSpared) for (const m of spared) log(describeSpared(m));
    for (const f of failed ?? []) log(f.id !== undefined ? `reap: could not stop ${f.id} (${f.message})` : `reap: sweep failed: ${f.message}`);
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

  // Before the runtime socket: the app lists and stops the relay's forwards through it.
  const relay = startCallbackRelay({
    runtime: rt,
    openUrl: opts.openUrl ?? systemOpener(),
    log,
    ...(opts.autoOpen !== undefined ? { autoOpen: opts.autoOpen } : {}),
    ...(opts.openLine !== undefined ? { openLine: opts.openLine } : {}),
    ...(opts.builder !== undefined ? { builder: opts.builder } : {}),
  });
  let rtServer: RuntimeServer;
  try {
    rtServer = await serveRuntime(rt, { port: opts.wsPort ?? 4410, authToken, forwards: relay });
  } catch (e) {
    await relay.close();
    throw e;
  }
  // Rendered per request: the checklist can change while the host runs (wsp init's sign-in stage).
  const page = (): string => {
    const checklist = typeof opts.checklist === "function" ? opts.checklist() : opts.checklist;
    return loadPage(webDir, {
      wsPort: rtServer.port,
      token: authToken,
      keys: opts.keys,
      ...(opts.builder !== undefined ? { builder: opts.builder } : {}),
      ...(checklist !== undefined ? { checklist } : {}),
    });
  };
  try {
    page();
  } catch (e) {
    await relay.close();
    await rtServer.close();
    throw e;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page());
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
          ...(opts.workspaceEnvs !== undefined ? { envs: opts.workspaceEnvs(head) } : {}),
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
    await relay.close();
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
  for (const b of await rt.golden.builders()) {
    if (b.foreignOwner !== undefined) log(`reap: left alone ${b.id}: recorded builder wearing another setup's owner label (${b.foreignOwner}); never touched by this host`);
    else if (b.heldBy !== undefined) log(`reap: left alone ${b.id}: your earlier builder from this setup, in use by another wsp process (pid ${b.heldBy.pid}); never touched by this host`);
    else if (b.building === true) log(`reap: left alone ${b.id}: your earlier builder from this setup; its setup never finished; the next sweep stops it`);
    else if (b.firstLife === true && b.id !== opts.builder?.id) log(describeKept(b, rt.backend.pricing.rateUsdPerHour(b.size), opts.recipePath));
  }
  const reapTimer = setInterval(() => void sweep(false), REAP_INTERVAL_MS);

  return {
    port,
    wsPort: rtServer.port,
    authToken,
    close: async () => {
      clearInterval(reapTimer);
      await relay.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
      await rtServer.close();
      // Last: with the servers gone nothing can record another event, so the
      // flush this waits on is the final word in the store.
      await rt.close();
    },
  };
}
