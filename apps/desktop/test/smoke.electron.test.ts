// SPDX-License-Identifier: AGPL-3.0-only
// Drives the packaged app (pnpm --filter @wsp/desktop build first). Gated on
// WSP_DESKTOP_SMOKE=1 so the unit suite stays free of a 200 MB binary.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { LAUNCHD_PATH, placeWiring, serve, shimPath, startHost, workspaceAsset, type CliIO, type HostHandle, type InstallReport } from "@wsp/host";
import { GET_THE_APP_WORD, HOST_WORDS, PLACES_WORDS, WS_PATH, hereWord, pairToken } from "@wsp/protocol";
import { createRuntime, memoryStore, tokenDigest, type Runtime } from "@wsp/runtime";
import { _electron as electron, type ElectronApplication, type Frame, type Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { WORKSPACE_WORDS } from "../../web/src/actions/format.js";
import { LOCKUP_OPTICAL_CENTRE } from "../../web/src/brand/optical.js";
import { SETTINGS_WORDS } from "../../web/src/settings/format.js";
import { workspaceRowId } from "../../web/src/sidebar/rowGrammar.js";
import { FIRST_RUN_WORDS } from "../../web/src/sidebar/words.js";
import { VERSION } from "../../../packages/host/src/version.js";
import { executableIn, treeHere } from "./packaged.js";
import { menuShapeOf, workspaceMenuShape } from "./workspace-menu.js";
import { notForThisPage } from "../src/origin.js";

const SMOKE = process.env["WSP_DESKTOP_SMOKE"] === "1";
const FAKE_SOLARI = "slr_live_fake_desktop_smoke";
/** What the loopback page carries of the host's token: its sha256, hex. The token itself is in no page. */
const DIGEST = /^[0-9a-f]{64}$/;

function builtApp(): string {
  const fromEnv = process.env["WSP_DESKTOP_APP"];
  if (fromEnv !== undefined) return fromEnv;
  const tree = treeHere();
  if (tree === undefined) throw new Error(`no packaged tree for ${process.platform}-${process.arch}`);
  return executableIn(tree);
}

const GOLDEN = {
  head: 1,
  versions: [
    { version: 1, snapshotId: "snap_gold", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } },
  ],
};

/** What wsp init leaves behind once a golden is sealed, in the store's on-disk shape. */
function seedGolden(home: string): void {
  writeFileSync(join(home, "state.json"), JSON.stringify({ goldens: { default: GOLDEN } }));
}

/** One local workspace record as wsp add and wsp new --local leave it, in the store's on-disk shape: a project of
 * this computer and the workspace working it in place, which is the whole of what a computer that never held a
 * provider key has. */
const LOCAL_WORKSPACE = {
  id: "ws_1",
  name: "seeded-mac",
  kind: "local",
  machineId: "local",
  phase: "running",
  golden: "",
  createdAt: "2026-09-01T00:00:00.000Z",
  project: "pr_1",
  spec: {},
  size: { cpu: 8, memMb: 16384 },
  firstLife: false,
  idleWindowMs: null,
};

function seedLocalWorkspace(home: string): void {
  const folder = join(home, "work", LOCAL_WORKSPACE.name);
  mkdirSync(folder, { recursive: true });
  const project = {
    id: LOCAL_WORKSPACE.project,
    name: LOCAL_WORKSPACE.name,
    computer: "here",
    source: { kind: "folder", path: folder },
    path: folder,
    defaultBranch: "main",
    createdAt: LOCAL_WORKSPACE.createdAt,
  };
  const workspace = { ...LOCAL_WORKSPACE, copy: { road: "clonefile", path: `${folder}-first`, source: folder, base: "", branch: "main", carried: "deps-and-config" }, portBase: 3100 };
  writeFileSync(join(home, "state.json"), JSON.stringify({ projects: { [project.id]: project }, workspaces: { [LOCAL_WORKSPACE.id]: workspace } }));
}

/** The project a fixture host's workspaces are copies of: a repo on the provider computer that host serves, which
 * is what wsp add records. A workspace is one project's copy, so a host holding none refuses to make one. */
async function seedProject(host: HostHandle): Promise<void> {
  await host.addProject("https://github.com/dev/first.git", "default");
}

/** A saved host record under the launch's own wsp home, as wsp host connect leaves one: the list the shell reads
 * has a host in it the window is not on, which is what a page on a host somewhere else may not learn. */
function seedSavedHost(home: string, alias: string, label: string): void {
  mkdirSync(join(home, "hosts"), { recursive: true });
  writeFileSync(join(home, "hosts", `${alias}.json`), JSON.stringify({ url: `http://${label}`, deviceId: "d_seed", deviceToken: "tok-seed", pairedAt: "2026-09-01T00:00:00.000Z", label, road: "direct" }));
}

/** The lock and the token file a host serving this home left beside its state, which is what the window reads to
 * attach to it: a page on a port is no reason to, whoever is serving there. */
function seedServingLock(home: string, at: { port: number; token: string }): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: at.port, wsPort: 0, startedAt: new Date().toISOString() }));
  writeFileSync(join(home, "host-token"), `${at.token}\n`);
}

interface Launched {
  app: ElectronApplication;
  home: string;
}

const APP_URL = /^http:\/\/127\.0\.0\.1:\d+\/$/;
const ONBOARDING_URL = /onboarding\.html/;
/** Where the photographed states go, beside the render tests' own. */
const SHOTS = join(tmpdir(), "wsp-render");
const DEVTOOLS_URL = /^devtools:\/\//;

/** The windows the app opened: a devtools window is Chromium's own, enumerated alongside them and able to come first. */
function appWindows(app: ElectronApplication): Page[] {
  return app.windows().filter(w => !DEVTOOLS_URL.test(w.url()));
}

/** The window showing a page, picked by its URL and never by the order the windows were made in. */
function windowAt(app: ElectronApplication, url: RegExp): Promise<Page> {
  return vi.waitFor(
    () => {
      const page = appWindows(app).find(w => url.test(w.url()));
      if (page === undefined) throw new Error(`no window at ${url}, saw ${JSON.stringify(app.windows().map(w => w.url()))}`);
      return page;
    },
    { timeout: 30_000, interval: 50 },
  );
}

const PAGE = `<!doctype html><html><head><title>wsp</title></head><body><script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script></body></html>`;

function fakeWebDir(): string {
  const webDir = mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-web-"));
  writeFileSync(join(webDir, "index.html"), PAGE);
  return webDir;
}

/** The environment a fixture host's runtime is given, said here rather than inherited from the shell that started
 * the run. The settings page is one of the surfaces behind labs, so a case that opens it turns labs on. */
const LABS_ON = { WSP_LABS: "1" };

function testRuntime(seedGolden = false, env: Record<string, string> = {}): Runtime {
  const store = memoryStore();
  if (seedGolden) void store.put("goldens", "default", GOLDEN);
  // The place wiring every host a person starts has: the key it proves is what a pairing code names and what the
  // computer taking that code holds it to, so a fixture host without one hands out a code nothing can spend.
  const statePath = join(mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-state-")), "state.json");
  return createRuntime({ backend: stubBackend(), store, adapters: {}, env, placeLinks: placeWiring(statePath, {}) });
}

function fixtureHost(): Promise<HostHandle> {
  return startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
}

/** A pid that was real a moment ago and is not alive now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

/** This launch's login shell: a script printing the fixture's own bin folder in front of the four folders launchd
 * gives an app, which is what a person's shell prints on their Mac. A launch handed launchd's set reads it, so this
 * is what decides which agents the app finds; a launch handed a fuller PATH never runs it. Without one the app
 * would read the shell of the Mac running the suite and find its agents instead of the fixture's. */
function loginShellIn(home: string): string {
  const bin = join(home, "bin");
  mkdirSync(bin);
  const shell = join(home, "login-shell");
  writeFileSync(shell, `#!/bin/sh\nprintf %s ${JSON.stringify(`${bin}:${LAUNCHD_PATH.join(":")}`)}\n`);
  chmodSync(shell, 0o755);
  return shell;
}

/** HOME is the temp dir too, so the app's ~/.wsp (and the pointer a host it
 * starts would write there) never touch this machine's. A value of undefined
 * removes that variable, the way a Finder launch has no WSP_HOME. */
async function launch(env: Record<string, string | undefined>, prepare: (home: string) => void = () => {}): Promise<Launched> {
  const home = mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-"));
  const cwd = join(home, "cwd");
  mkdirSync(cwd);
  prepare(home);
  const inherited = { ...process.env };
  delete inherited["SOLARI_API_KEY"];
  delete inherited["ANTHROPIC_API_KEY"];
  // The app reads WSP_DESKTOP_SMOKE to know it is driven: the bundle runs out of dist, and the move to Applications
  // it would otherwise offer has nobody to press a button.
  const merged = { ...inherited, HOME: home, WSP_HOME: home, WSP_PORT: "0", WSP_WS_PORT: "0", WSP_DESKTOP_SMOKE: "1", SHELL: loginShellIn(home), ...env };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
  // Playwright emulates a light prefers-color-scheme in the renderer unless told not to; the page's system theme has to
  // read the Mac's own appearance, the one the window's glass is drawn from, or the two sides split in the shot.
  const app = await electron.launch({ executablePath: builtApp(), cwd, env: clean, colorScheme: null });
  return { app, home };
}

/** A host of another release, as an app attached to one it did not start meets it. The real host serves the page and
 * runs the runtime; this stands in front of it on its own port and rewrites the one version in the boot object, so
 * the window is a real window on a real host that happens to have been built apart from it. Faking the app's half
 * instead would need a lever in the shipped shell, since a packaged bundle's own version cannot be moved. */
async function hostOfVersion(upstream: HostHandle, version: string): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(await collect(req));
      const from = await fetch(`http://127.0.0.1:${upstream.port}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        ...(body !== undefined ? { body } : {}),
      });
      const type = from.headers.get("content-type") ?? "application/octet-stream";
      const bytes = type.startsWith("text/html")
        ? Buffer.from((await from.text()).replace(`"version":"${VERSION}"`, `"version":"${version}"`))
        : Buffer.from(await from.arrayBuffer());
      res.writeHead(from.status, { "content-type": type, "content-length": bytes.length });
      res.end(bytes);
    })().catch(() => res.writeHead(502).end());
  });
  // The page dials the runtime on its own origin's /ws, so the stand-in carries the upgrade through to the real host
  // byte for byte; without it the window is a page with a toast and no runtime behind it.
  server.on("upgrade", (req, socket, head) => {
    const through = connect(upstream.port, "127.0.0.1", () => {
      const line = [`${req.method} ${req.url} HTTP/${req.httpVersion}`, ...req.rawHeaders.map((h, i) => (i % 2 === 0 ? `${h}: ${req.rawHeaders[i + 1]}` : undefined)).filter(h => h !== undefined), "", ""].join("\r\n");
      through.write(line);
      if (head.length > 0) through.write(head);
      socket.pipe(through).pipe(socket);
    });
    through.on("error", () => socket.destroy());
    socket.on("error", () => through.destroy());
  });
  return { port: await listenOn(server), server };
}

function collect(req: NodeJS.ReadableStream): Promise<Buffer[]> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(chunks));
  });
}

function listenOn(server: Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

/** A page served on a loopback port the way a process inside a workspace serves one: it asks for a service worker on
 * its own origin when the test says so, and answers on either spelling of loopback, so the frame on one holds a
 * frame on the other. */
function workerPage(): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end("self.addEventListener('fetch', () => {});");
      return;
    }
    const port = Number((req.headers.host ?? "").split(":")[1] ?? 0);
    const nested = path === "/nested" ? "" : `<iframe src="http://127.0.0.1:${port}/nested"></iframe>`;
    const asks = '<script>window.registerWorker = () => navigator.serviceWorker.register("/sw.js").then(() => "registered", e => "refused: " + e.name);</script>';
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${nested}${asks}</body></html>`);
  });
  return listenOn(server).then(port => ({ port, server }));
}

/** A frame the window holds, by the url it is on. */
function frameAt(win: Page, url: string): Promise<Frame> {
  return vi.waitFor(
    () => {
      const frame = win.frames().find(f => f.url() === url);
      if (frame === undefined) throw new Error(`no frame at ${url}, saw ${JSON.stringify(win.frames().map(f => f.url()))}`);
      return frame;
    },
    { timeout: 30_000, interval: 50 },
  );
}

/** What the page inside a frame made of the worker it asked for. */
const registerWorker = (frame: Frame): Promise<string> => frame.evaluate(() => (window as unknown as { registerWorker(): Promise<string> }).registerWorker());

async function bootOf(page: Page): Promise<{ wsPort: number; tokenHash: string; token?: string }> {
  await page.waitForLoadState("domcontentloaded");
  return page.evaluate(() => (window as unknown as { __WSP__: { wsPort: number; tokenHash: string; token?: string } }).__WSP__);
}

interface DesktopWindow {
  wsp: { capturePreview(workspaceId: string): Promise<void>; workspacePreview(workspaceId: string): Promise<string | undefined>; setTheme(theme: string): void };
}

function readPreview(page: Page, workspaceId: string): Promise<string | undefined> {
  return page.evaluate(id => (window as unknown as DesktopWindow).wsp.workspacePreview(id), workspaceId);
}

/** A page in both themes: the shell's theme source is flipped, since the onboarding page follows the system's. */
async function photograph(app: ElectronApplication, page: Page, name: string): Promise<string[]> {
  mkdirSync(SHOTS, { recursive: true });
  const files: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    await app.evaluate(({ nativeTheme }, t) => {
      nativeTheme.themeSource = t;
    }, theme);
    await page.waitForFunction(t => window.matchMedia("(prefers-color-scheme: dark)").matches === (t === "dark") && document.documentElement.classList.contains("dark") === (t === "dark"), theme);
    // The page holds transitions off for one frame across the flip, as the app does; the shot waits past that frame and
    // any hover fade, and shows the screen at rest, without the focus ring of the button Enter would press.
    await page.waitForTimeout(400);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const file = join(SHOTS, `${name}-${theme}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  }
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = "system";
  });
  return files;
}

/** The app window as the screen shows it, over a backdrop of one colour: its sidebar is the window's glass, which a
 * page capture paints white, so the file has to come from the screen. Off macOS the page capture stands in. */
async function photographWindow(app: ElectronApplication, win: Page, file: string, backdrop: string): Promise<string> {
  mkdirSync(SHOTS, { recursive: true });
  if (process.platform !== "darwin") {
    await win.screenshot({ path: file });
    return file;
  }
  const ids = await app.evaluate(({ BrowserWindow, app: electronApp, screen }, color) => {
    const target = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith("http://127.0.0.1"))!;
    const behind = new BrowserWindow({ ...screen.getPrimaryDisplay().bounds, frame: false, show: false, focusable: false, backgroundColor: color });
    behind.showInactive();
    // The app under test takes activation so the window is key; the backdrop floats over every other window and the
    // app one step above it, so nothing else sits between them.
    electronApp.focus({ steal: true });
    behind.setAlwaysOnTop(true, "floating", 0);
    target.setAlwaysOnTop(true, "floating", 1);
    target.focus();
    return { target: target.id, behind: behind.id, bounds: target.getBounds() };
  }, backdrop);
  // The glass repaints over the new backdrop a few frames later.
  await win.waitForTimeout(800);
  const b = ids.bounds;
  expect(spawnSync("screencapture", ["-R", `${b.x},${b.y},${b.width},${b.height}`, "-x", file]).status).toBe(0);
  await app.evaluate(({ BrowserWindow }, ids) => {
    BrowserWindow.fromId(ids.behind)!.close();
    BrowserWindow.fromId(ids.target)!.setAlwaysOnTop(false);
  }, ids);
  return file;
}

/** The onboarding page's two-agent fixture: Claude Code and Codex by their config alone and a PATH with none, so what
 * the screen finds is what was put here. */
function twoAgents(home: string): void {
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), "");
}

async function refused(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
}

/** The word wsp host pair prints off a host, the way it gets one: one socket with the host's own token, one
 * pair.issue. It is the code and the fingerprint of the key that host proves, which is what a person copies. */
async function pairingCodeOf(host: HostHandle): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}${WS_PATH}`);
  await new Promise<void>((done, fail) => {
    ws.addEventListener("open", () => done());
    ws.addEventListener("error", () => fail(new Error("the fixture host refused the socket")));
  });
  const ask = (frame: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise(done => {
      ws.addEventListener("message", e => done(JSON.parse(String((e as MessageEvent).data)) as Record<string, unknown>), { once: true });
      ws.send(JSON.stringify(frame));
    });
  await ask({ id: 1, op: "auth", token: host.authToken });
  const issued = await ask({ id: 2, op: "pair.issue" });
  ws.close();
  return pairToken(issued["code"] as string, issued["hostKey"] as string);
}

interface MenuRow {
  label: string;
  checked: boolean;
  enabled: boolean;
}

/** The rows of the menu bar's Hosts menu as the shell built them. */
function hostsMenuRows(app: ElectronApplication): Promise<MenuRow[]> {
  return app.evaluate(({ Menu }, word) => {
    const hosts = Menu.getApplicationMenu()?.items.find(item => item.label === word)?.submenu;
    if (hosts === undefined) throw new Error(`no ${word} menu`);
    return hosts.items.filter(item => item.type !== "separator").map(item => ({ label: item.label, checked: item.checked, enabled: item.enabled }));
  }, HOST_WORDS.hosts);
}

/** Clicks one row of the Hosts menu, as a person would from the menu bar. */
function hostsMenu(app: ElectronApplication, label: string): Promise<void> {
  return app.evaluate(({ Menu }, [word, row]) => {
    const hosts = Menu.getApplicationMenu()?.items.find(item => item.label === word)?.submenu;
    const item = hosts?.items.find(i => i.label === row);
    if (item === undefined) throw new Error(`no row ${row} in the ${word} menu`);
    item.click();
  }, [HOST_WORDS.hosts, label] as const);
}

// Each launch boots Electron and a host; the default 5s test timeout is too tight.
describe.runIf(SMOKE)("desktop app (built)", { timeout: 60_000 }, () => {
  let launched: Launched | undefined;
  let existing: HostHandle | undefined;
  let standIn: Server | undefined;
  afterEach(async () => {
    await launched?.app.close().catch(() => {});
    if (launched) rmSync(launched.home, { recursive: true, force: true });
    launched = undefined;
    await existing?.close();
    existing = undefined;
    if (standIn !== undefined) await new Promise<void>(resolve => standIn!.close(() => resolve()));
    standIn = undefined;
    vi.unstubAllEnvs();
  });

  it("is built", () => {
    expect(existsSync(builtApp())).toBe(true);
  });

  it("opens one window on the host it started, titled wsp, with the token's digest in the boot object and never the token, and stops the host on quit", async () => {
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
    const win = await windowAt(launched.app, APP_URL);
    const boot = await bootOf(win);
    const url = win.url();
    expect(url).toMatch(APP_URL);
    expect(await win.title()).toBe("wsp");
    expect(boot.tokenHash).toMatch(DIGEST);
    expect(boot.token).toBeUndefined();
    expect(boot.wsPort).toBeGreaterThan(0);
    expect(appWindows(launched.app)).toHaveLength(1);
    await launched.app.close();
    expect(await refused(url)).toBe(true);
  });

  it("the window's theme source follows the page, which draws the side this computer is set to", async () => {
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
    const win = await windowAt(launched.app, APP_URL);
    await bootOf(win);
    const source = () => launched!.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    // The one value the page ever says, whatever a pin before it was: no screen picks a side, so the frame and the
    // page cannot draw two.
    await vi.waitFor(async () => expect(await source()).toBe("system"));
    await launched.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await win.reload();
    await vi.waitFor(async () => expect(await source()).toBe("system"));
  });

  it("photographs its own page for a workspace and hands the picture back to the page", async () => {
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
    const win = await windowAt(launched.app, APP_URL);
    await bootOf(win);
    expect(await readPreview(win, "ws_a")).toBeUndefined();
    await win.evaluate(id => (window as unknown as DesktopWindow).wsp.capturePreview(id), "ws_a");
    expect(await readPreview(win, "ws_a")).toMatch(/^data:image\/png;base64,\w/);
    expect(await readPreview(win, "ws_b")).toBeUndefined();
  });

  it("puts the picture of the workspace the person left on that workspace's switcher card", async () => {
    // A host over the stub backend with two workspaces, serving the built web app, so the switcher has cards to
    // draw. The app attaches to it rather than starting its own, so nothing here needs a provider key or a golden
    // on disk, and the workspaces are made through the runtime's own road instead of written into the store.
    existing = await startHost({ runtime: testRuntime(true), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    await seedProject(existing);
    const api = await existing.createWorkspace("api");
    const web = await existing.createWorkspace("web");
    launched = await launch({ WSP_HOME: undefined }, home => seedServingLock(join(home, ".wsp"), { port: existing!.port, token: existing!.authToken }));
    const win = await windowAt(launched.app, APP_URL);
    await win.waitForSelector(`[data-row-id='ws:${api.id}']`);
    await win.waitForSelector(`[data-row-id='ws:${web.id}']`);

    // A tap: the chord's step and its release, which is what asks for a picture of the workspace being left.
    await win.keyboard.down("Control");
    await win.keyboard.press("Tab");
    await win.keyboard.up("Control");
    await win.waitForSelector("[data-workspace-switcher]", { state: "detached" });
    // The capture is an ipc round trip the tap only started, and the overlay reads the pictures once, when it
    // opens. Which workspace the tap left is the sidebar's order to decide, so the picture names it.
    const left = await vi.waitFor(
      async () => {
        for (const id of [api.id, web.id]) if ((await readPreview(win, id)) !== undefined) return id;
        throw new Error("no picture yet");
      },
      { timeout: 30_000, interval: 100 },
    );

    await win.keyboard.down("Control");
    await win.keyboard.press("Tab");
    await win.waitForSelector("[data-workspace-switcher]");
    const shot = win.locator(`[data-workspace-card='${left}'] [data-card-preview] img`);
    await shot.waitFor();
    expect(await shot.getAttribute("src")).toMatch(/^data:image\/png;base64,\w/);
    // The picture decodes off the main thread; its size is a fact only once it has.
    expect(await shot.evaluate((img: HTMLImageElement) => img.decode().then(() => img.naturalWidth))).toBeGreaterThan(0);
    await win.keyboard.up("Control");
  });

  it("first launch with no key: the welcome, then the agents found here ticked, Open wsp gives them the tools and opens the app on the first run, whose Add a project holds the door to another computer, and the shim runs", async () => {
    // Labs on, since the settings page the door to another computer opens is a labs surface. The PATH is launchd's
    // own, what a Finder or Dock launch is handed, so this run is the one a tester's Mac makes.
    launched = await launch({ PATH: LAUNCHD_PATH.join(":"), WSP_LABS: "1" }, twoAgents);
    const { app, home } = launched;
    const shim = shimPath(home);
    // The command is installed before any window, so an agent configured on the next screen has something to run.
    expect(existsSync(shim)).toBe(true);
    const page = await windowAt(app, ONBOARDING_URL);
    await page.waitForLoadState("domcontentloaded");
    expect(await page.title()).toBe("wsp");
    // Nothing scrolls, on any screen.
    const fits = (): Promise<boolean> => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.body.scrollHeight <= window.innerHeight);
    // The page draws with the app's stylesheet: its tokens resolve here, and the dark class is the app's own switch.
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return { background: style.getPropertyValue("--background").trim(), mono: style.getPropertyValue("--font-mono").trim(), primary: style.getPropertyValue("--primary").trim() };
    });
    expect(tokens.background).not.toBe("");
    expect(tokens.primary).not.toBe("");
    expect(tokens.mono).toContain("ui-monospace");
    // The app's stylesheet clears html and body under the desktop class for the glass; this page paints its own ground.
    expect(await page.$eval(".ground", el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    // The welcome is the mark and one button, and nothing behind it: a Mac is never a place, so no join screen.
    expect(await page.$$eval("#welcome h1, #welcome p", els => els.length)).toBe(0);
    expect(await page.$$eval("#welcome button", els => els.map(el => el.id))).toEqual(["start"]);
    expect(await page.textContent("#start")).toContain("Get started");
    expect(await page.$("#computer")).toBeNull();
    expect(await page.$$eval(".setup", els => els.map(el => `${el.id}:${(el as HTMLElement).hidden}`))).toEqual(["welcome:false", "agents:true"]);
    expect(await fits()).toBe(true);
    await page.waitForFunction(() => document.getAnimations().length === 0);
    expect(await page.$$eval(":focus-visible", els => els.length)).toBe(0);
    console.info(`welcome: ${(await photograph(app, page, "onboarding-welcome")).join(" ")}`);
    // The scan is the recipe scan's own: one row per catalog agent, the two on this fixture's PATH ticked and the
    // rest held, and the line under the card says where agents installed later get the tools.
    const here = CATALOG_AGENTS.filter(a => a.id === "claude" || a.id === "codex");
    await page.waitForFunction(() => (document.querySelector("#line")?.textContent ?? "") !== "", undefined, { timeout: 30_000 });
    await page.click("#start");
    expect(await page.$$eval(".setup", els => els.map(el => `${el.id}:${(el as HTMLElement).hidden}`))).toEqual(["welcome:true", "agents:false"]);
    expect(await page.$$eval("#rows .row", els => els.length)).toBe(CATALOG_AGENTS.length);
    expect(await page.$$eval("#rows input:checked", els => els.map(el => (el as HTMLInputElement).value))).toEqual(here.map(a => a.id));
    expect(await page.$$eval("#rows input:disabled", els => els.length)).toBe(CATALOG_AGENTS.length - here.length);
    expect(await page.textContent("#line")).toBe("Agents you install later get the tools from Settings.");
    expect(await page.textContent("#open")).toContain("Open wsp");
    // The column is the SetupScreen's, and nothing scrolls.
    expect(await page.$eval("#agents", el => el.getBoundingClientRect().width)).toBe(560);
    expect(await fits()).toBe(true);
    await page.waitForFunction(() => document.getAnimations().length === 0);
    expect(await page.$$eval(":focus-visible", els => els.length)).toBe(0);
    console.info(`agents: ${(await photograph(app, page, "onboarding-agents")).join(" ")}`);

    // Enter is the keycap: the tools into both agents found here, then the app. An event asked for after it has
    // fired never arrives, and the finish closes this window while the key is in flight.
    const closed = page.waitForEvent("close");
    await page.keyboard.press("Enter");
    const win = await windowAt(app, APP_URL);
    const boot = await bootOf(win);
    expect(boot.tokenHash).toMatch(DIGEST);
    await closed;
    await vi.waitFor(() => expect(appWindows(app)).toHaveLength(1), { timeout: 10_000, interval: 50 });
    // A workspace is one project's copy, so this press records neither: the app opens on the first run, whose one
    // button opens Add a project. The screen standing is what says the host read the state back, so the file holds
    // everything the launch wrote by then.
    await win.waitForSelector("[data-k=first-run]");
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as { workspaces?: Record<string, unknown>; projects?: Record<string, unknown> };
    expect(Object.keys(state.workspaces ?? {})).toEqual([]);
    expect(Object.keys(state.projects ?? {})).toEqual([]);
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(await win.locator("[data-workspace-name]").count()).toBe(0);
    // The tick was live, so both agents found here carry the wsp server and its skill, with the shim as the command.
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({ mcpServers: { wsp: { command: shim, args: ["mcp", "--state", join(home, "state.json")] } } });
    expect(existsSync(join(home, ".claude", "skills", "wsp", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.wsp]");

    // The first run's one button opens Add a project, whose computers column holds the door for the person who came
    // for a box.
    const add = win.locator("[data-k=first-run] [data-k=add-project]");
    await add.waitFor();
    expect(await add.textContent()).toBe(FIRST_RUN_WORDS.add);
    const shots: string[] = [];
    // The shots show the shell at rest: no focus ring from the click that just happened, and the theme painted. One
    // side only: the page says system and nothing else, so the app draws the side this computer is set to and a shot
    // of the other one is this Mac's appearance to change, not this run's.
    const rest = async (): Promise<void> => {
      await win.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        return new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      });
    };
    await rest();
    shots.push(await photographWindow(app, win, join(SHOTS, "app-first-run.png"), "#101010"));
    await add.click();
    const door = win.locator("[role=dialog] [data-k=add-computer]");
    await door.click();
    const dialog = win.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain(PLACES_WORDS.sheet.description);
    expect(await dialog.textContent()).not.toMatch(/wsp init|terminal/i);
    shots.push(await photographWindow(app, win, join(SHOTS, "app-add-computer-sheet.png"), "#101010"));
    await win.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    // The sheet took the settings page with it on the way in, and Escape leaves that page too.
    await win.keyboard.press("Escape");
    await win.locator("[data-k=first-run]").waitFor();
    console.info(`the app on first launch: ${shots.join(" ")}`);

    // The shim is the wsp command: it runs the bundled host as node, and an install through it writes the shim too.
    const env = { ...process.env, HOME: home, WSP_HOME: home };
    const version = spawnSync(shim, ["--version"], { encoding: "utf8", env });
    expect(version.stderr).toBe("");
    expect(version.stdout).toBe(`wsp ${VERSION}\n`);
    const installed = spawnSync(shim, ["mcp", "install", "--agent", "codex", "--json", "--state", join(home, "state.json")], { encoding: "utf8", env, cwd: join(home, "cwd") });
    expect(installed.status).toBe(0);
    const report = JSON.parse(installed.stdout) as InstallReport;
    expect(report.server).toEqual({ command: shim, args: ["mcp", "--state", join(home, "state.json")] });
    expect(report.installed.map(p => p.id)).toEqual(["codex"]);
  });

  it("with every tick taken off Open wsp is held, says why, and leaves every agent's config alone", async () => {
    launched = await launch({ PATH: "/usr/bin:/bin" }, twoAgents);
    const { app, home } = launched;
    const page = await windowAt(app, ONBOARDING_URL);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => (document.querySelector("#line")?.textContent ?? "") !== "", undefined, { timeout: 30_000 });
    await page.click("#start");
    for (const id of ["claude", "codex"]) await page.click(`#rows input[value=${id}]`);
    expect(await page.$$eval("#rows input:checked", els => els.length)).toBe(0);
    expect(await page.isDisabled("#open")).toBe(true);
    expect(await page.textContent("#line")).toBe("Tick at least one agent. wsp works through the agents you give it.");
    expect(appWindows(app).filter(w => APP_URL.test(w.url()))).toHaveLength(0);
    // The fixture's own files are what the scan found the two agents by; neither gained the wsp server.
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe("");
    expect(existsSync(join(home, ".claude", "skills", "wsp"))).toBe(false);
    const stateFile = join(home, "state.json");
    const state = (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {}) as { workspaces?: Record<string, unknown> };
    expect(Object.keys(state.workspaces ?? {})).toEqual([]);
  });

  it("with no provider key the welcome opens while nothing is recorded, and a recorded local workspace opens the app on it instead", async () => {
    // The two launches differ by the seed alone, so what decides the window is the record and not the missing key.
    launched = await launch({});
    const welcome = await windowAt(launched.app, ONBOARDING_URL);
    await welcome.waitForLoadState("domcontentloaded");
    expect(await welcome.textContent("#start")).toContain("Get started");
    expect(appWindows(launched.app).filter(w => APP_URL.test(w.url()))).toHaveLength(0);
    await launched.app.close();
    rmSync(launched.home, { recursive: true, force: true });

    launched = await launch({}, seedLocalWorkspace);
    const win = await windowAt(launched.app, APP_URL);
    const boot = await bootOf(win);
    expect(boot.tokenHash).toMatch(DIGEST);
    const row = win.locator(`[data-row-id='${workspaceRowId(LOCAL_WORKSPACE.id)}']`);
    await row.waitFor();
    expect(await row.locator("[data-workspace-name]").textContent()).toBe(LOCAL_WORKSPACE.name);
    // Line two is the branch the seeded copy stands on.
    expect(await row.locator("[data-workspace-meta]").textContent()).toBe("main");
    // The seeded record is the whole list: nothing was recorded on the way in.
    expect(await win.locator("[data-workspace-name]").count()).toBe(1);
    expect(appWindows(launched.app).filter(w => ONBOARDING_URL.test(w.url()))).toHaveLength(0);
    expect(existsSync(join(launched.home, ".env"))).toBe(false);
  });

  it("no frame in the window registers a service worker on a loopback origin, and a host page loads into a session holding none", async () => {
    const served = await workerPage();
    standIn = served.server;
    launched = await launch({}, seedLocalWorkspace);
    const win = await windowAt(launched.app, APP_URL);
    const row = `[data-row-id='${workspaceRowId(LOCAL_WORKSPACE.id)}']`;
    await win.click(row);
    // The preview pane on this computer's own workspace frames this computer's port, which is the pane a person types one into.
    await win.keyboard.press("Meta+k");
    await win.locator("[data-command-palette]").getByText(WORKSPACE_WORDS.openBrowser, { exact: true }).click();
    await win.fill("[data-preview-url-input]", `localhost:${served.port}`);
    await win.press("[data-preview-url-input]", "Enter");
    const framed = await frameAt(win, `http://localhost:${served.port}/`);
    const nested = await frameAt(win, `http://127.0.0.1:${served.port}/nested`);
    // The road the finding names is the 127.0.0.1 frame, which is the nested one; the localhost frame is the same
    // rule read on the other spelling, and neither may plant a worker on a port the kernel hands out again.
    expect(await registerWorker(framed)).toMatch(/^refused/);
    expect(await registerWorker(nested)).toMatch(/^refused/);
    // The rule is the worker's alone: the framed page keeps its own storage, which a sandbox attribute would have taken.
    expect(await framed.evaluate(() => {
      localStorage.setItem("wsp-smoke", "kept");
      return localStorage.getItem("wsp-smoke");
    })).toBe("kept");
    // And the move a person makes through the Hosts menu loads the host page with the session swept first.
    await hostsMenu(launched.app, hereWord(process.platform === "darwin"));
    await win.waitForURL(APP_URL);
    expect(await launched.app.evaluate(({ session }) => Object.keys(session.defaultSession.serviceWorkers.getAllRunning()).length)).toBe(0);
  });

  it("does not attach to a host on the port that no lock beside the resolved home names: the first launch runs", async () => {
    // Any login on this computer can bind a port and answer with the boot line; the lock beside the state file of
    // the home this launch resolved is what says a host of the owner's is serving, and there is none here.
    existing = await fixtureHost();
    launched = await launch({ WSP_HOME: undefined, WSP_PORT: String(existing.port) });
    const page = await windowAt(launched.app, ONBOARDING_URL);
    await page.waitForLoadState("domcontentloaded");
    expect(await page.textContent("#start")).toContain("Get started");
    expect(appWindows(launched.app).filter(w => APP_URL.test(w.url()))).toHaveLength(0);
    await launched.app.close();
    // The host on that port was never touched: it is still serving, with the page it was serving before.
    expect(await refused(`http://127.0.0.1:${existing.port}/`)).toBe(false);
  });

  it("attached to a host of a later release, says so in the sidebar's own sentence with the releases page behind its button", async () => {
    existing = await startHost({ runtime: testRuntime(true, LABS_ON), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    const stand = await hostOfVersion(existing, "9.9.9");
    standIn = stand.server;
    launched = await launch({ WSP_HOME: undefined }, home => seedServingLock(join(home, ".wsp"), { port: stand.port, token: existing!.authToken }));
    const win = await windowAt(launched.app, APP_URL);
    const line = win.locator("[role=status]");
    await line.waitFor();
    expect(await line.textContent()).toContain(`this app is ${VERSION}, the host is 9.9.9: get the new app`);
    expect(await win.locator("[data-toast-action]").textContent()).toBe(GET_THE_APP_WORD);
    // The settings page names both halves as well, on About, so the line is never the only place the numbers are.
    // The palette's Settings row is the road through it.
    await win.keyboard.press("Meta+k");
    await win.locator("[data-command-palette]").getByText(SETTINGS_WORDS.title, { exact: true }).click();
    await win.waitForSelector("[data-settings-page]");
    await win.locator("[data-k=settings-about]").click();
    await win.waitForSelector("[data-settings-at=about]");
    expect(await win.locator("[data-k=app-version] [data-settings-word]").textContent()).toBe(VERSION);
    expect(await win.locator("[data-k=host-version] [data-settings-word]").textContent()).toBe("9.9.9");
  });

  it("attached to a host of an earlier release, asks for the app's own host and offers nothing to download", async () => {
    existing = await startHost({ runtime: testRuntime(true), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    const stand = await hostOfVersion(existing, "0.0.1");
    standIn = stand.server;
    launched = await launch({ WSP_HOME: undefined }, home => seedServingLock(join(home, ".wsp"), { port: stand.port, token: existing!.authToken }));
    const win = await windowAt(launched.app, APP_URL);
    const line = win.locator("[role=status]");
    await line.waitFor();
    expect(await line.textContent()).toContain(`this app is ${VERSION}, the host is 0.0.1: run the app's own host`);
    expect(await win.locator("[data-toast-action]").count()).toBe(0);
  });

  it("attached to a host of its own release, says nothing at all", async () => {
    existing = await startHost({ runtime: testRuntime(true), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    launched = await launch({ WSP_HOME: undefined }, home => seedServingLock(join(home, ".wsp"), { port: existing!.port, token: existing!.authToken }));
    const win = await windowAt(launched.app, APP_URL);
    await win.waitForSelector("[data-slot=sidebar-container]");
    expect(await win.locator("[role=status]").count()).toBe(0);
  });

  it("attaches to a host serving a custom home when that home is named on its launch, with no port hint", async () => {
    const user = mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-user-"));
    const custom = join(user, "custom-home");
    const quiet: CliIO = { log: () => {}, error: () => {}, ask: () => Promise.reject(new Error("prompt")), askSecret: () => Promise.reject(new Error("prompt")) };
    vi.stubEnv("SOLARI_API_KEY", FAKE_SOLARI);
    vi.stubEnv("HOME", user);
    vi.stubEnv("WSP_HOME", custom);
    existing = await serve(quiet, { port: 0, wsPort: 0, statePath: join(custom, "state.json"), webDir: fakeWebDir(), runtime: testRuntime() });
    vi.unstubAllEnvs();
    // The host wrote every file of its own under the home it serves and nothing under the person's own.
    expect(existsSync(join(custom, "host.lock"))).toBe(true);
    expect(existsSync(join(user, ".wsp"))).toBe(false);

    launched = await launch({ HOME: user, WSP_HOME: custom });
    const win = await windowAt(launched.app, APP_URL);
    const boot = await bootOf(win);
    expect(win.url()).toBe(`http://127.0.0.1:${existing.port}/`);
    expect(boot.tokenHash).toBe(tokenDigest(existing.authToken));
    await launched.app.close();
    expect(await refused(`http://127.0.0.1:${existing.port}/`)).toBe(false);
    rmSync(user, { recursive: true, force: true });
  });

  it("a right-click on a workspace row builds the native menu from the workspace registry through the bridge", async () => {
    // A host over the stub backend with one workspace, serving the built web app, so the sidebar has a row to right-click.
    existing = await startHost({ runtime: testRuntime(true), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    await seedProject(existing);
    const first = await existing.createWorkspace("first");
    launched = await launch({ WSP_HOME: undefined }, home => seedServingLock(join(home, ".wsp"), { port: existing!.port, token: existing!.authToken }));
    const win = await windowAt(launched.app, APP_URL);
    const row = `[data-row-id='ws:${first.id}']`;
    await win.waitForSelector(row);
    // A native menu blocks until it is dismissed, so the main process keeps the template it would have shown and closes on nothing.
    await launched.app.evaluate(({ Menu }) => {
      type Kept = { type?: string; label?: string; enabled?: boolean; toolTip?: string; accelerator?: string | null };
      const kept: Kept[][] = [];
      (globalThis as { __menus?: Kept[][] }).__menus = kept;
      const build = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = template => {
        kept.push(template.map(({ type, label, enabled, toolTip, accelerator }) => ({ type, label, enabled, toolTip, accelerator })));
        const menu = build(template);
        menu.popup = options => options?.callback?.();
        return menu;
      };
    });
    await win.click(row, { button: "right" });
    await win.waitForFunction(() => true);
    const menus = await launched.app.evaluate(() => (globalThis as { __menus?: { type?: string; label?: string; enabled?: boolean; toolTip?: string; accelerator?: string | null }[][] }).__menus ?? []);
    expect(menus).toHaveLength(1);
    const rows = menus[0]!;
    // The rows the registry says, in its order and parted where its groups part, so an action added to the registry
    // never brings this case with it. Labels and separator places are read as one list: a separator that moved is a
    // failure here, not only a wrong count.
    expect(menuShapeOf(rows)).toEqual(workspaceMenuShape(first));
    expect(rows.find(r => r.label === WORKSPACE_WORDS.rename)).toMatchObject({ enabled: true });
    expect(rows.find(r => r.label === WORKSPACE_WORDS.openTerminal)).toMatchObject({ enabled: true, accelerator: "CommandOrControl+J" });
    // The shell's page got the native menu, not the in-app one.
    expect(await win.locator("[data-context-menu]").count()).toBe(0);
  });

  it("connects to a second host by its address and a code, the Hosts menu lists both with the current one marked, and This Mac takes the window back", async () => {
    existing = await fixtureHost();
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, home => {
      seedGolden(home);
      seedSavedHost(home, "attic", "attic.example:4400");
    });
    const win = await windowAt(launched.app, APP_URL);
    const home = win.url();
    await win.waitForSelector("[data-host-foot]");
    const here = hereWord(process.platform === "darwin");
    expect(await win.locator("[data-host-label]").textContent()).toBe(here);
    // The word wsp host pair prints, over the second host's own socket with its own token: the code and the
    // fingerprint of the key that host proves, both of which the field carries through to the command line.
    const code = await pairingCodeOf(existing);
    // The menu bar's Hosts menu opens the sheet, the road a person takes.
    await hostsMenu(launched.app, HOST_WORDS.connectMenu);
    const dialog = win.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator("#connect-url").fill(`http://127.0.0.1:${existing.port}`);
    // Typed as a person types a code, in lower case; the fingerprint is pasted as it was printed, since base64 is
    // case sensitive and a shaped one would name a key no host proves.
    await dialog.locator("#connect-code").fill(code.replace(/^[^.]*/, half => half.toLowerCase()));
    expect(await dialog.locator("#connect-code").inputValue()).toBe(code);
    await dialog.locator("[data-k=primary]").click();
    await win.waitForURL(`http://127.0.0.1:${existing.port}/`);
    // The shell's own menu lists every saved host, so the owner still moves from one to another while the window
    // stands on a host somewhere else. It is rebuilt once the page is up, which is a beat after the window moved.
    await vi.waitFor(async () => {
      expect(await hostsMenuRows(launched!.app)).toEqual([
        { label: here, checked: false, enabled: true },
        { label: `127.0.0.1:${existing!.port}`, checked: true, enabled: true },
        { label: "attic.example:4400", checked: false, enabled: true },
        { label: HOST_WORDS.connectMenu, checked: false, enabled: true },
        { label: HOST_WORDS.disconnect(`127.0.0.1:${existing!.port}`), checked: false, enabled: true },
      ]);
    }, { timeout: 30_000, interval: 100 });
    // The page that host serves is shown this computer and that host alone, and what it asks of this computer is
    // refused in one sentence naming the channel, before anything on this computer is read or written.
    const asked = await win.evaluate(async () => {
      const wsp = (
        window as unknown as {
          wsp: {
            hosts(): Promise<{ here: string; current: string | null; hosts: { label: string }[] }>;
            localFonts(family: string): Promise<unknown>;
            connectHost(ask: unknown): Promise<unknown>;
            disconnectHost(alias: string): Promise<unknown>;
            switchHost(alias: string | null): Promise<unknown>;
          };
        }
      ).wsp;
      const said = async (call: () => Promise<unknown>): Promise<string> => {
        try {
          await call();
          return "answered";
        } catch (e) {
          return (e as Error).message;
        }
      };
      return {
        hosts: await wsp.hosts(),
        fonts: await said(() => wsp.localFonts("Menlo")),
        connect: await said(() => wsp.connectHost({ road: "direct", url: "http://127.0.0.1:1", code: "AAAAAAAA.k" })),
        disconnect: await said(() => wsp.disconnectHost("attic")),
        elsewhere: await said(() => wsp.switchHost("attic")),
      };
    });
    expect(asked.hosts.hosts.map(h => h.label)).toEqual([`127.0.0.1:${existing.port}`]);
    expect(asked.hosts.here).toBe(here);
    expect(asked.fonts).toContain(notForThisPage("fonts:local"));
    expect(asked.connect).toContain(notForThisPage("hosts:connect"));
    expect(asked.disconnect).toContain(notForThisPage("hosts:disconnect"));
    expect(asked.elsewhere).toContain(notForThisPage("hosts:switch"));
    // The move home is the one move that page may ask for, and the record it could not read still stands after it.
    await win.evaluate(() => {
      void (window as unknown as { wsp: { switchHost(alias: string | null): Promise<unknown> } }).wsp.switchHost(null);
    });
    await win.waitForURL(home);
    expect(existsSync(join(launched.home, "hosts", "attic.json"))).toBe(true);
    await hostsMenu(launched.app, `127.0.0.1:${existing.port}`);
    await win.waitForURL(`http://127.0.0.1:${existing.port}/`);
    // The record is the one wsp host connect writes, under the launch's own wsp home, with what the desktop adds.
    const record = JSON.parse(readFileSync(join(launched.home, "hosts", "127.0.0.1.json"), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ url: `http://127.0.0.1:${existing.port}`, label: `127.0.0.1:${existing.port}`, road: "direct" });
    expect(typeof record["deviceToken"]).toBe("string");
    await hostsMenu(launched.app, here);
    await win.waitForURL(home);
    await vi.waitFor(async () => {
      expect((await hostsMenuRows(launched!.app)).map(r => r.checked)).toEqual([true, false, false, false, false]);
    }, { timeout: 30_000, interval: 100 });
    expect(await win.locator("[data-host-label]").textContent()).toBe(here);
    // The app's own host was never stopped by the move.
    await launched.app.close();
    expect(await refused(home)).toBe(true);
  });

  it("a host under some other home is nothing to a launch that names none: the first launch runs on ~/.wsp", async () => {
    launched = await launch({ WSP_HOME: undefined }, home => {
      const custom = join(home, "old-home");
      mkdirSync(custom);
      writeFileSync(join(custom, "host.lock"), JSON.stringify({ pid: deadPid(), port: 1, wsPort: 2, startedAt: "2026-09-01T00:00:00.000Z" }));
    });
    const page = await windowAt(launched.app, ONBOARDING_URL);
    await page.waitForLoadState("domcontentloaded");
    expect(await page.textContent("#start")).toContain("Get started");
    expect(existsSync(shimPath(join(launched.home, ".wsp")))).toBe(true);
    expect(existsSync(join(launched.home, "old-home", "bin"))).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "on macOS the header row is the frame: the lights sit inside it, the sidebar shows the window's glass and its text keeps AA contrast over a light and a dark desktop",
    async () => {
      launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
      const win = await windowAt(launched.app, APP_URL);
      await win.waitForSelector("[data-slot=sidebar-container]");
      const app = launched.app;

      const frame = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]!;
        return { id: w.id, buttons: w.getWindowButtonPosition(), bounds: w.getBounds(), content: w.getContentBounds(), title: w.getTitle() };
      });
      expect(frame.buttons).toEqual({ x: 16, y: 19 });
      expect(frame.content.height).toBe(frame.bounds.height);
      expect(frame.title).toBe("wsp");

      const page = await win.evaluate((opticalCentre: number) => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const region = (selector: string) => (style(selector) as unknown as { webkitAppRegion: string }).webkitAppRegion;
        const buttons = (selector: string) => Array.from(document.querySelector(selector)!.querySelectorAll("button")).map(b => (getComputedStyle(b) as unknown as { webkitAppRegion: string }).webkitAppRegion);
        // Chromium reports mixed colours as color(srgb ...); a canvas pixel reads any of them as 8-bit rgb.
        const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d")!;
        // rgba, the alpha as a fraction: the chord and the counts paint at part opacity and read as what they composite to.
        const rgb = (color: string): number[] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r!, g!, b!, a! / 255];
        };
        const text = (cls: string): number[] => {
          const span = document.createElement("span");
          span.className = cls;
          document.querySelector("[data-slot=sidebar-inner]")!.append(span);
          const color = rgb(getComputedStyle(span).color);
          span.remove();
          return color;
        };
        const colorOf = (selector: string): number[] => rgb(style(selector).color);
        const lockup = document.querySelector("[data-slot=sidebar-header] [role=img][aria-label=wsp]")!.getBoundingClientRect();
        const toggle = document.querySelector("[data-slot=sidebar-header] [data-slot=sidebar-trigger]")!.getBoundingClientRect();
        // The toggle's ink is its icon box: the panel glyph fills the box edge to edge, so the box centre is the ink's.
        const glyph = document.querySelector("[data-slot=sidebar-header] [data-slot=sidebar-trigger] svg")!.getBoundingClientRect();
        const searchRow = document.querySelector("button[aria-label='Search']")!.getBoundingClientRect();
        return {
          toggleLeft: toggle.left,
          toggleRight: toggle.right,
          toggleCentre: { x: toggle.left + toggle.width / 2, y: toggle.top + toggle.height / 2 },
          glyphCentreY: glyph.top + glyph.height / 2,
          lockupOpticalY: lockup.top + lockup.height * opticalCentre,
          searchRow: { x: searchRow.left + searchRow.width * 0.6, y: searchRow.top + searchRow.height / 2 },
          searchText: colorOf("button[aria-label='Search']"),
          pageToggles: document.querySelectorAll("header [data-slot=sidebar-trigger]").length,
          htmlClass: document.documentElement.className,
          container: style("[data-slot=sidebar-container]").backgroundColor,
          inner: style("[data-slot=sidebar-inner]").backgroundColor,
          main: style("[data-slot=sidebar-inset]").backgroundColor,
          mainRgb: rgb(style("[data-slot=sidebar-inset]").backgroundColor),
          headerHeight: document.querySelector("[data-slot=sidebar-header]")!.getBoundingClientRect().height,
          lockupLeft: lockup.left,
          sidebarHeader: region("[data-slot=sidebar-header]"),
          pageHeader: region("header [data-header-row]"),
          sidebarButtons: buttons("[data-slot=sidebar-header]"),
          pageButtons: buttons("header"),
          foreground: text("text-sidebar-foreground"),
          muted: text("text-sidebar-muted-foreground"),
          quiet: text("text-muted-foreground"),
          // One icon ink for the sidebar: the search glyph and a section row's chevron both draw in
          // --sidebar-icon-color, and a section row stands only over a project, which this launch records none of.
          icon: colorOf("[data-sidebar-search] button svg"),
          sidebarWidth: document.querySelector("[data-slot=sidebar-container]")!.getBoundingClientRect().width,
        };
      }, LOCKUP_OPTICAL_CENTRE);
      expect(page.htmlClass.split(" ")).toContain("desktop-mac");
      expect(page.container).toBe("rgba(0, 0, 0, 0)");
      expect(page.inner).toBe("rgba(0, 0, 0, 0)");
      expect(page.main).not.toBe("rgba(0, 0, 0, 0)");
      expect(page.headerHeight).toBe(52);
      expect(page.pageToggles).toBe(0);
      expect(page.sidebarHeader).toBe("drag");
      expect(page.pageHeader).toBe("drag");
      expect(page.pageButtons.length).toBeGreaterThan(1);
      expect([...page.sidebarButtons, ...page.pageButtons].every(r => r === "no-drag")).toBe(true);

      const captured = await app.evaluate(async ({ BrowserWindow }, args) => {
        const image = await BrowserWindow.fromId(args.id)!.webContents.capturePage();
        const { width, height } = image.getSize();
        const bitmap = image.toBitmap();
        const alphaAt = (x: number, y: number) => bitmap[(y * width + x) * 4 + 3]!;
        const scale = width / args.bounds.width;
        return { sidebar: alphaAt(Math.round(args.sidebarWidth * scale) >> 1, Math.round(height * 0.7)), main: alphaAt(Math.round((args.sidebarWidth + 200) * scale), Math.round(height * 0.7)) };
      }, { id: frame.id, bounds: frame.bounds, sidebarWidth: page.sidebarWidth });
      expect(captured.sidebar).toBe(0);
      expect(captured.main).toBe(255);

      // The desktop behind the window is a full-screen window of one colour, so the glass is measured over a known backdrop.
      const shots = join(tmpdir(), "wsp-render");
      mkdirSync(shots, { recursive: true });
      const contrast = (text: number[], glass: number[]): number => {
        const alpha = text[3] ?? 1;
        const painted = [0, 1, 2].map(i => text[i]! * alpha + glass[i]! * (1 - alpha));
        const lum = (c: number[]) => {
          const [r, g, b] = c.map(v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const [hi, lo] = [lum(painted), lum(glass)].sort((x, y) => y - x) as [number, number];
        return (hi + 0.05) / (lo + 0.05);
      };
      const backdropId = await app.evaluate(({ BrowserWindow, app: electronApp, screen }, id) => {
        const w = BrowserWindow.fromId(id)!;
        const backdrop = new BrowserWindow({ ...screen.getPrimaryDisplay().bounds, frame: false, show: false, focusable: false, backgroundColor: "#ffffff" });
        backdrop.showInactive();
        // The app under test is not the active application: it takes activation so the window is key (coloured lights,
        // active glass); the backdrop floats over every other window and the app one step above it, so nothing else sits
        // between them, and both follow whichever Space the screen shows.
        electronApp.focus({ steal: true });
        backdrop.setAlwaysOnTop(true, "floating", 0);
        w.setAlwaysOnTop(true, "floating", 1);
        w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        backdrop.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        w.focus();
        return backdrop.id;
      }, frame.id);
      const lights = async (file: string) => {
        const b = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getBounds(), frame.id);
        expect(spawnSync("screencapture", ["-R", `${b.x},${b.y},${b.width},${b.height}`, "-x", file]).status).toBe(0);
        return app.evaluate(({ nativeImage }, args) => {
          const image = nativeImage.createFromPath(args.file);
          const { width, height } = image.getSize();
          const bitmap = image.toBitmap();
          const scale = width / args.width;
          const at = (x: number, y: number): number[] => {
            const i = (y * width + x) * 4;
            return [bitmap[i + 2]!, bitmap[i + 1]!, bitmap[i]!];
          };
          // The red light is the leftmost and the green the rightmost; each centre is the middle of its hue's extent in the
          // top-left corner (the extent, not the mean: the highlight on a light's crown is not its hue and would pull a
          // mean down). Hue, not absolute values: the display's tone mapping shifts every pixel while a video plays.
          const reds: number[][] = [];
          const greens: number[][] = [];
          for (let y = 0; y < 80 * scale; y++)
            for (let x = 0; x < 80 * scale; x++) {
              const [r, g, bl] = at(x, y);
              // The yellow light is red-heavy too (its red leads green by about 65); the red light's lead is over 150.
              if (r! > 150 && r! - g! > 100 && r! - bl! > 60) reds.push([x, y]);
              if (g! > 120 && g! - r! > 50 && g! - bl! > 50) greens.push([x, y]);
            }
          const middle = (values: number[]) => (Math.min(...values) + Math.max(...values) + 1) / 2 / scale;
          const centre = (pts: number[][]) => ({ x: middle(pts.map(p => p[0]!)), y: middle(pts.map(p => p[1]!)) });
          return {
            scale,
            height: height / scale,
            reds: reds.length,
            greens: greens.length,
            red: centre(reds),
            green: centre(greens),
            glass: at(Math.round(30 * scale), Math.round(height * 0.7)),
            searchRow: at(Math.round(args.searchRow.x * scale), Math.round(args.searchRow.y * scale)),
            main: at(Math.round(width * 0.75), Math.round(height * 0.7)),
            probe: at(Math.round(args.probeX * scale), Math.round(8 * scale)),
          };
        }, { file, width: b.width, probeX: page.lockupLeft + 2, searchRow: page.searchRow });
      };
      const near = (px: number[], to: number[], within: number) => px.every((v, i) => Math.abs(v - to[i]!) <= within);
      const mainColour = (px: number[]) => near(px, page.mainRgb, 6);
      // The screen is shared: a shot counts once it shows this window, key, where its frame puts it, over a backdrop unlike
      // every one measured before (a backdrop that has not repainted yet leaves the glass as the last one did).
      type Shot = Awaited<ReturnType<typeof lights>>;
      const inFrame = (shot: Shot, state: "open" | "collapsed", unlike: number[][]) =>
        mainColour(shot.main) &&
        shot.reds > 20 &&
        shot.greens > 20 &&
        shot.red.x > 18 &&
        shot.red.x < 26 &&
        shot.red.y > 20 &&
        shot.red.y < 32 &&
        (state === "collapsed" ? mainColour(shot.probe) : near(shot.probe, shot.glass, 4)) &&
        unlike.every(glass => !near(shot.glass, glass, 2));
      // Bounded by time, not tries: the last shot comes back either way, so the assertions after it name what was seen.
      const retake = async (file: string, state: "open" | "collapsed", unlike: number[][] = []): Promise<Shot> => {
        const deadline = Date.now() + 20_000;
        let shot = await lights(file);
        while (!inFrame(shot, state, unlike) && Date.now() < deadline) {
          // A click elsewhere on this Mac takes the key status back; the window asks for it again before each retake.
          await app.evaluate(({ BrowserWindow, app: electronApp }, id) => {
            electronApp.focus({ steal: true });
            BrowserWindow.fromId(id)!.focus();
          }, frame.id);
          await win.waitForTimeout(500);
          shot = await lights(file);
        }
        return shot;
      };
      // The sidebar slides for 200 ms; its container's left edge holding still across two frames, at rest for the state, is
      // the end. The poll runs once a frame, so the edge it saw last time is the frame before.
      const slid = (state: "open" | "collapsed") =>
        win.waitForFunction((want: string) => {
          const { left, width } = document.querySelector("[data-slot=sidebar-container]")!.getBoundingClientRect();
          const seen = window as unknown as { __sidebarLeft?: number };
          const before = seen.__sidebarLeft;
          seen.__sidebarLeft = left;
          return before === left && (want === "open" ? left === 0 : left <= 1 - width);
        }, state);
      // One gap: the third light's centre to the toggle's centre, and the toggle's centre to the first glyph after it. One
      // vertical centre, measured on ink: the lights' hue extent, the toggle glyph's icon box, the wordmark's optical centre.
      // The display's tone mapping moves the edge pixels of that hue extent, carrying the light's centre by up to 1 px
      // at 1x on either axis, so 1 px of drift is that and not a layout change.
      const CENTRED = 1;
      const gaps = (shot: Shot, toggleCentre: { x: number; y: number }, contentLeft: number, glyphCentreY: number) => ({
        lightsToToggle: toggleCentre.x - shot.green.x,
        toggleToContent: contentLeft - toggleCentre.x,
        drop: glyphCentreY - shot.green.y,
      });
      const expectOneGap = (g: ReturnType<typeof gaps>) => {
        expect(Math.abs(g.lightsToToggle - g.toggleToContent)).toBeLessThan(2);
        expect(g.lightsToToggle).toBeGreaterThanOrEqual(28);
        expect(g.lightsToToggle).toBeLessThanOrEqual(32);
        expect(Math.abs(g.drop)).toBeLessThanOrEqual(CENTRED);
      };
      const glass: Record<string, number[]> = {};
      for (const [desktop, color] of [["light", "#ffffff"], ["dark", "#101010"]] as const) {
        const file = join(shots, `desktop-mac-${desktop}.png`);
        await app.evaluate(({ BrowserWindow }, args) => BrowserWindow.fromId(args.backdropId)!.setBackgroundColor(args.color), { backdropId, color });
        const shot = await retake(file, "open", Object.values(glass));
        console.info(`desktop-mac over a ${desktop} desktop: ${file} ${JSON.stringify(shot)}`);
        expect(shot.reds).toBeGreaterThan(20);
        expect(shot.red.y).toBeGreaterThan(20);
        expect(shot.red.y).toBeLessThan(32);
        expect(shot.red.x).toBeGreaterThan(18);
        expect(shot.red.x).toBeLessThan(26);
        const openGaps = gaps(shot, page.toggleCentre, page.lockupLeft, page.glyphCentreY);
        const wordmarkDrop = page.lockupOpticalY - shot.green.y;
        console.info(`open header gaps at 1x: ${JSON.stringify({ ...openGaps, wordmarkDrop, lightsY: { red: shot.red.y, green: shot.green.y }, glyphY: page.glyphCentreY, wordmarkY: page.lockupOpticalY })}`);
        glass[desktop] = shot.glass;
        const ratios = {
          foreground: contrast(page.foreground, shot.glass),
          muted: contrast(page.muted, shot.glass),
          quiet: contrast(page.quiet, shot.glass),
          icon: contrast(page.icon, shot.glass),
          search: contrast(page.searchText, shot.searchRow),
        };
        console.info(`over a ${desktop} desktop the glass is rgb(${shot.glass.join(", ")}) and the search row rgb(${shot.searchRow.join(", ")}): ${Object.entries(ratios).map(([k, v]) => `${k} ${v.toFixed(2)}:1`).join(", ")}`);
        expectOneGap(openGaps);
        expect(Math.abs(wordmarkDrop)).toBeLessThanOrEqual(CENTRED);
        // The search row is a plain row on the glass, no fill of its own, and the word Search is AA on it.
        expect(shot.searchRow).toEqual(shot.glass);
        for (const ratio of Object.values(ratios)) expect(ratio).toBeGreaterThanOrEqual(4.5);

        // Collapsed, the page header is the frame row: the toggle lands where the sidebar's was, the breadcrumb after it, the row still drags.
        await win.click("[data-slot=sidebar-header] [data-slot=sidebar-trigger]");
        await win.waitForSelector("[data-sidebar-state=collapsed]");
        await win.waitForFunction(x => Math.abs(document.querySelector("header [data-slot=sidebar-trigger]")!.getBoundingClientRect().left - x) < 0.01, page.toggleLeft);
        await slid("collapsed");
        const collapsed = await win.evaluate(() => {
          const row = document.querySelector("header [data-header-row]")!;
          const toggle = row.querySelector("[data-slot=sidebar-trigger]")!.getBoundingClientRect();
          const glyph = row.querySelector("[data-slot=sidebar-trigger] svg")!.getBoundingClientRect();
          const crumb = row.querySelector("[data-thread-breadcrumb]")!;
          return {
            toggleLeft: toggle.left,
            toggleCentre: { x: toggle.left + toggle.width / 2, y: toggle.top + toggle.height / 2 },
            glyphCentreY: glyph.top + glyph.height / 2,
            crumbLeft: crumb.getBoundingClientRect().left,
            crumb: crumb.textContent,
            region: (getComputedStyle(row) as unknown as { webkitAppRegion: string }).webkitAppRegion,
            lockups: document.querySelectorAll("header [role=img][aria-label=wsp]").length,
          };
        });
        expect(collapsed.toggleLeft).toBeCloseTo(page.toggleLeft, 1);
        expect(collapsed.crumbLeft).toBeCloseTo(page.lockupLeft, 1);
        // Over the first run the header says nothing: that screen's own title says what is being made.
        expect(collapsed.crumb).toBe("");
        expect(collapsed.region).toBe("drag");
        expect(collapsed.lockups).toBe(0);
        const collapsedFile = join(shots, `desktop-mac-collapsed-${desktop}.png`);
        const collapsedShot = await retake(collapsedFile, "collapsed");
        expect(collapsedShot.reds).toBeGreaterThan(20);
        expect(Math.abs(collapsedShot.red.y - shot.red.y)).toBeLessThanOrEqual(CENTRED);
        expect(Math.abs(collapsedShot.red.x - shot.red.x)).toBeLessThanOrEqual(CENTRED);
        const collapsedGaps = gaps(collapsedShot, collapsed.toggleCentre, collapsed.crumbLeft, collapsed.glyphCentreY);
        console.info(`desktop-mac collapsed over a ${desktop} desktop: ${collapsedFile}; header gaps at 1x: ${JSON.stringify(collapsedGaps)}`);
        expectOneGap(collapsedGaps);
        await win.click("header [data-slot=sidebar-trigger]");
        await win.waitForSelector("[data-sidebar-state=expanded]");
        await win.waitForFunction(x => Math.abs(document.querySelector("[data-slot=sidebar-header] [data-slot=sidebar-trigger]")!.getBoundingClientRect().left - x) < 0.01, page.toggleLeft);
        await slid("open");
      }
      // The glass shows what is behind it: the two desktops leave two different tints.
      expect(glass["light"]).not.toEqual(glass["dark"]);
      await app.evaluate(({ BrowserWindow }, args) => {
        BrowserWindow.fromId(args.backdropId)!.close();
        BrowserWindow.fromId(args.id)!.setAlwaysOnTop(false);
      }, { id: frame.id, backdropId });
    },
    90_000,
  );
});
