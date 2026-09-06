// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import { agentHomes } from "@wsp/engine";
import type { BootPayload, ProjectImportResult, ProjectPlan } from "@wsp/protocol";
import { describeAge, goldenHead, serveRuntime, type CreatedWorkspace, type GoldenBuilderView, type GoldenVersion, type ProjectImportOptions, type ReapedMachine, type Runtime, type RuntimeServer, type SparedMachine } from "@wsp/runtime";
import { projectBundler } from "./project-bundle.js";
import { projectLander } from "./project-export.js";
import { startCallbackRelay, systemOpener, type UrlOpener } from "./relay.js";
import { describeStorage } from "./storage.js";

// The enriched status now lives in @wsp/runtime (every client reads one
// implementation); re-exported so host consumers keep their imports.
export type { ReachState, ReachStatus, WorkspaceStatus } from "@wsp/runtime";

export interface HostOptions {
  runtime: Runtime;
  /** The built web app: index.html plus its assets. */
  webDir: string;
  /** The builder wsp init prepared; the callback relay links to it for the sign-ins run there. */
  builder?: GoldenBuilderView;
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
  autoOpen?: (workspaceId: string, url: string, port?: number) => boolean;
  /** The line logged when a sign-in page arrives and nothing opens, given the workspace name and the page's hostname. */
  openLine?: (workspace: string, hostname: string, url: string) => string;
  /** The saved recipe file, read for the terminal font its ticks name. */
  recipePath?: string;
}

export interface HostHandle {
  port: number;
  wsPort: number;
  authToken: string;
  /** Forks the golden's head into a new workspace, with the envs and labels the app's own create gives it. */
  createWorkspace(name: string): Promise<CreatedWorkspace>;
  /** Reads a folder on this computer as the app's import dialog reads it; nothing is packed or uploaded. */
  planProject(source: string): Promise<ProjectPlan>;
  /** Lands that folder on a workspace's machine through the bundler the app's import goes through. */
  importProject(opts: Omit<ProjectImportOptions, "bundler">): Promise<ProjectImportResult>;
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

/** The ticked shell row's font from the saved recipe; nothing when the file is missing, unreadable or names none. */
function terminalFontOf(recipePath: string | undefined): string | undefined {
  if (recipePath === undefined) return undefined;
  try {
    const data = JSON.parse(readFileSync(recipePath, "utf8")) as { entries?: { rung?: unknown; bring?: unknown; font?: unknown }[] };
    const row = data.entries?.find(e => e.rung === "shell" && e.bring === true && typeof e.font === "string" && e.font !== "");
    return row?.font as string | undefined;
  } catch {
    return undefined;
  }
}

/** JSON fit for an inline script: the font family comes from a config file, so `<` and the line terminators JSON allows
 * but a script does not are written as escapes, and no value can end the script or the page. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function loadPage(webDir: string, boot: BootPayload): string {
  const path = join(webDir, "index.html");
  if (!existsSync(path)) throw new Error(`web app not built: ${path} is missing (pnpm --filter @wsp/web build)`);
  const html = readFileSync(path, "utf8");
  if (!BOOT_SCRIPT.test(html)) throw new Error(`${path} has no window.__WSP__ boot line to replace`);
  return html.replace(BOOT_SCRIPT, `<script>window.__WSP__ = ${inlineJson(boot)};</script>`);
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
  if (r.reason === "grace") return `reap: stopped ${r.id}: the builder kept after the save for one more change; its ten-minute window is over`;
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
function describeKept(b: GoldenBuilderView, rateUsdPerHour: number): string {
  const ageMs = Date.now() - Date.parse(b.createdAt);
  return `reap: left alone ${b.id}: your earlier builder from this setup, still first-life, ${describeAge(ageMs)}, ${describeCost(rateUsdPerHour, ageMs)}; reuse it with wsp init, or it is stopped at six hours`;
}

/** A builder kept after its save is claimed, so the sweep never names it; the person still sees what bills and why. */
function describeSealed(b: GoldenBuilderView, sealed: { at: string; version: number }, rateUsdPerHour: number): string {
  const ageMs = Date.now() - Date.parse(b.createdAt);
  const since = describeAge(Date.now() - Date.parse(sealed.at)).replace(/ old$/, "");
  return `reap: left alone ${b.id}: your builder saved as golden v${sealed.version}, kept ${since} since the save and holding one of the account's machine slots, ${describeCost(rateUsdPerHour, ageMs)}; wsp init updates the golden on it, or it is stopped ten minutes after the save`;
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

class NoGoldenError extends Error {
  constructor() {
    super("no golden image yet; run wsp init first");
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

  // One bundler road for the app's import op and the handle's own: a folder is read and packed the same either way.
  const homes = agentHomes(homedir());
  const bundlerFor = (source: string) => projectBundler(source, homes);

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
    rtServer = await serveRuntime(rt, { port: opts.wsPort ?? 4410, authToken, forwards: relay, projects: bundlerFor, landing: projectLander(homes) });
  } catch (e) {
    await relay.close();
    throw e;
  }
  // Rendered per request: wsp init saves the recipe while a host may already be serving.
  const page = (): string => {
    const terminalFont = terminalFontOf(opts.recipePath);
    return loadPage(webDir, { wsPort: rtServer.port, token: authToken, ...(terminalFont !== undefined ? { terminalFont } : {}) });
  };
  try {
    page();
  } catch (e) {
    await relay.close();
    await rtServer.close();
    throw e;
  }

  const planProject = (source: string): Promise<ProjectPlan> => bundlerFor(source).plan();

  const importProject = (o: Omit<ProjectImportOptions, "bundler">): Promise<ProjectImportResult> => rt.projects.import({ ...o, bundler: bundlerFor(o.source) });

  const createWorkspace = async (name: string): Promise<CreatedWorkspace> => {
    const head = goldenHead(await rt.golden.get());
    if (!head) throw new NoGoldenError();
    return rt.workspaces.create({
      golden: head.snapshotId,
      name,
      ...(opts.workspaceEnvs !== undefined ? { envs: opts.workspaceEnvs(head) } : {}),
      labels: { wsp: "1", "wsp-host": "1", createdAt: new Date().toISOString() },
    });
  };

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
        let created: CreatedWorkspace;
        try {
          created = await createWorkspace(name);
        } catch (e) {
          if (!(e instanceof NoGoldenError)) throw e;
          sendJson(res, 409, { error: e.message });
          return;
        }
        const { notice, ...workspace } = created;
        sendJson(res, 200, { workspace, ...(notice !== undefined ? { notice } : {}) });
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
    else if (b.sealed !== undefined) log(describeSealed(b, b.sealed, rt.backend.pricing.rateUsdPerHour(b.size)));
    else if (b.firstLife === true && b.id !== opts.builder?.id) log(describeKept(b, rt.backend.pricing.rateUsdPerHour(b.size)));
  }
  try {
    const storage = await rt.golden.storage();
    if (storage !== undefined && storage.count > 0) log(describeStorage(storage));
  } catch (e) {
    log(`storage: snapshot listing failed (${e instanceof Error ? e.message : String(e)})`);
  }
  const reapTimer = setInterval(() => void sweep(false), REAP_INTERVAL_MS);

  return {
    port,
    wsPort: rtServer.port,
    authToken,
    createWorkspace,
    planProject,
    importProject,
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
