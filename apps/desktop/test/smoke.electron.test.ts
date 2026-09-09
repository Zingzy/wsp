// SPDX-License-Identifier: AGPL-3.0-only
// Drives the packaged app (pnpm --filter @wsp/desktop build first). Gated on
// WSP_DESKTOP_SMOKE=1 so the unit suite stays free of a 200 MB binary.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { serve, shimPath, startHost, workspaceAsset, type CliIO, type HostHandle, type InstallReport } from "@wsp/host";
import { CLOUD_SETUP_WORDS } from "@wsp/protocol";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { WORKSPACE_WORDS } from "../../web/src/actions/format.js";
import { LOCKUP_OPTICAL_CENTRE } from "../../web/src/brand/optical.js";
import { THEME_WORDS } from "../../web/src/settings/format.js";
import { VERSION } from "../../../packages/host/src/version.js";
import { executableIn, treeHere } from "./packaged.js";
import { menuShapeOf, workspaceMenuShape } from "./workspace-menu.js";

const SMOKE = process.env["WSP_DESKTOP_SMOKE"] === "1";
const FAKE_SOLARI = "slr_live_fake_desktop_smoke";
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

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

function testRuntime(seedGolden = false): Runtime {
  const store = memoryStore();
  if (seedGolden) void store.put("goldens", "default", GOLDEN);
  return createRuntime({ backend: stubBackend(), store, adapters: {} });
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
  const merged = { ...inherited, HOME: home, WSP_HOME: home, WSP_PORT: "0", WSP_WS_PORT: "0", ...env };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = v;
  // Playwright emulates a light prefers-color-scheme in the renderer unless told not to; the page's system theme has to
  // read the Mac's own appearance, the one the window's glass is drawn from, or the two sides split in the shot.
  const app = await electron.launch({ executablePath: builtApp(), cwd, env: clean, colorScheme: null });
  return { app, home };
}

async function bootOf(page: Page): Promise<{ wsPort: number; token: string }> {
  await page.waitForLoadState("domcontentloaded");
  return page.evaluate(() => (window as unknown as { __WSP__: { wsPort: number; token: string } }).__WSP__);
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

// Each launch boots Electron and a host; the default 5s test timeout is too tight.
describe.runIf(SMOKE)("desktop app (built)", { timeout: 60_000 }, () => {
  let launched: Launched | undefined;
  let existing: HostHandle | undefined;
  afterEach(async () => {
    await launched?.app.close().catch(() => {});
    if (launched) rmSync(launched.home, { recursive: true, force: true });
    launched = undefined;
    await existing?.close();
    existing = undefined;
    vi.unstubAllEnvs();
  });

  it("is built", () => {
    expect(existsSync(builtApp())).toBe(true);
  });

  it("opens one window on the host it started, titled wsp, with a boot token, and stops the host on quit", async () => {
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
    const win = await windowAt(launched.app, APP_URL);
    const boot = await bootOf(win);
    const url = win.url();
    expect(url).toMatch(APP_URL);
    expect(await win.title()).toBe("wsp");
    expect(boot.token).toMatch(TOKEN);
    expect(boot.wsPort).toBeGreaterThan(0);
    expect(appWindows(launched.app)).toHaveLength(1);
    await launched.app.close();
    expect(await refused(url)).toBe(true);
  });

  it("the window's theme source follows the page: the record's system once the page has read it, light after a Light pick on the settings page, and light again on a reload from a dark pin", async () => {
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI, WSP_LABS: "1" }, seedGolden);
    const win = await windowAt(launched.app, APP_URL);
    await bootOf(win);
    const source = () => launched!.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    // The page's first word is the record's default; the pin before it is not a fact the page can be asked about.
    await vi.waitFor(async () => expect(await source()).toBe("system"));
    // The chord reaches the shell once the store is ready, which the sidebar's empty state says; the page is on screen
    // before the pick, so the click waits on a fact and not on a guess about React's timing.
    await win.waitForSelector("text=No workspaces yet");
    await win.keyboard.press("Meta+,");
    await win.waitForSelector("[data-settings-page]");
    await win.getByRole("radio", { name: THEME_WORDS.light.title }).click();
    await vi.waitFor(async () => expect(await source()).toBe("light"));
    expect(await win.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);
    // Pinned dark again by hand, a reload has to say light on its own: the record on the host, and the page's cache before it.
    await launched.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await win.reload();
    await vi.waitFor(async () => expect(await source()).toBe("light"));
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
    const api = await existing.createWorkspace("api");
    const web = await existing.createWorkspace("web");
    launched = await launch({ WSP_HOME: undefined, WSP_PORT: String(existing.port) });
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

  it("first launch with no key: the welcome, the agents found here with an install, Esc to the recap, the recap's own install, then the app on this computer with the cloud row, and the shim runs", async () => {
    // Labs on, since the settings page that picks the light side for the photograph is a labs surface.
    launched = await launch({ PATH: "/usr/bin:/bin", WSP_LABS: "1" }, twoAgents);
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
    expect(await page.textContent("#welcome h1")).toBe("Welcome to wsp");
    expect(await page.textContent("#start")).toContain("Get started");
    if (process.platform === "darwin") expect(await page.textContent("#computer")).toMatch(/^[^.]+ · macOS \d+$/);
    expect(await page.isHidden("#agents")).toBe(true);
    expect(await fits()).toBe(true);
    console.info(`welcome: ${(await photograph(app, page, "onboarding-welcome")).join(" ")}`);

    // Enter advances.
    await page.keyboard.press("Enter");
    await page.waitForSelector("#agents:not([hidden])");
    expect(await page.isHidden("#welcome")).toBe(true);
    expect(await page.textContent("#agents h1")).toBe("Let your agents drive wsp");
    // Every catalog agent is a row, in catalog order: the two found with a keycap, the rest with the state word.
    const rows = await page.$$eval("#rows li", rows => rows.map(r => [r.getAttribute("data-agent"), r.querySelector(".name")?.textContent, r.querySelector(".slot")?.textContent]));
    expect(rows).toEqual(CATALOG_AGENTS.map(a => [a.id, a.name, a.id === "claude" || a.id === "codex" ? "Install" : "not found"]));
    // The marks are the web app's vendored svgs, masked in the current colour; an agent without one gets its initial.
    expect(await page.$eval("#rows li[data-agent=claude] .glyph", el => (el as HTMLElement).style.getPropertyValue("--mark"))).toContain("agents/claude.svg");
    expect(await page.$eval("#rows li[data-agent=hermes] .initial", el => el.textContent)).toBe("H");
    // The session counts land after the rows, read off the stores, which here are empty.
    await page.waitForFunction(() => /sessions$/.test(document.querySelector("#rows li[data-agent=claude] .meta")?.textContent ?? ""), undefined, { timeout: 30_000 });
    expect(await page.textContent("#rows li[data-agent=claude] .meta")).toBe("0 sessions");
    expect(await page.textContent("#skip")).toBe("Skip");
    expect(await page.isEnabled("#all")).toBe(true);
    // Every row one height, whatever its slot holds.
    const heights = await page.$$eval("#rows li", rows => rows.map(r => r.getBoundingClientRect().height));
    expect(new Set(heights).size).toBe(1);
    expect(await fits()).toBe(true);
    console.info(`agents: ${(await photograph(app, page, "onboarding-agents")).join(" ")}`);

    await page.click("#rows li[data-agent=claude] button");
    await page.waitForFunction(() => document.querySelector("#rows li[data-agent=claude] .state")?.textContent === "MCP added");
    expect(await page.$$eval("#rows li", rows => rows.map(r => r.getBoundingClientRect().height))).toEqual(heights);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({ mcpServers: { wsp: { command: shim, args: ["mcp", "--state", join(home, "state.json")] } } });
    expect(existsSync(join(home, ".claude", "skills", "wsp", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".codex", "skills"))).toBe(false);

    // Esc is Skip: the recap, with the install that was skipped still offered on its row.
    await page.keyboard.press("Escape");
    await page.waitForSelector("#recap:not([hidden])");
    expect(await page.textContent("#recap h1")).toBe("This computer is your first workspace");
    expect(await page.textContent("#open")).toContain("Open wsp");
    if (process.platform === "darwin") expect(await page.textContent("#thread-key")).toBe("⌘N");
    expect(await page.textContent("#recap-agents button")).toBe("Install");
    expect(await page.textContent("#next li:nth-child(3) .state")).toBe("in the sidebar");
    expect(await fits()).toBe(true);
    console.info(`recap: ${(await photograph(app, page, "onboarding-recap")).join(" ")}`);
    await page.click("#recap-agents button");
    await page.waitForFunction(() => document.querySelector("#recap-agents .state")?.textContent === "MCP added");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.wsp]");
    expect(existsSync(join(home, ".codex", "skills", "wsp", "SKILL.md"))).toBe(true);

    // Enter opens the app. An event asked for after it has fired never arrives, and the finish closes this window while the key is in flight.
    const closed = page.waitForEvent("close");
    await page.keyboard.press("Enter");
    const win = await windowAt(app, APP_URL);
    const boot = await bootOf(win);
    expect(boot.token).toMatch(TOKEN);
    await closed;
    await vi.waitFor(() => expect(appWindows(app)).toHaveLength(1), { timeout: 10_000, interval: 50 });
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as { workspaces?: Record<string, { kind?: string }> };
    expect(Object.values(state.workspaces ?? {}).filter(w => w.kind === "local")).toHaveLength(1);
    expect(existsSync(join(home, ".env"))).toBe(false);

    // The app opens on this computer, and the cloud row waits at the sidebar's bottom.
    const row = win.locator("[data-cloud-setup-row]");
    await row.waitFor();
    expect(await row.textContent()).toBe(CLOUD_SETUP_WORDS.row);
    const shots: string[] = [];
    // The shots show the shell at rest: no focus ring from the click that just happened, and the theme painted.
    const rest = async (): Promise<void> => {
      await win.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        return new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      });
    };
    await rest();
    shots.push(await photographWindow(app, win, join(SHOTS, "app-cloud-row-dark.png"), "#101010"));
    await row.click();
    const dialog = win.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain(CLOUD_SETUP_WORDS.choice.headline);
    expect(await dialog.textContent()).not.toMatch(/wsp init|terminal/i);
    shots.push(await photographWindow(app, win, join(SHOTS, "app-cloud-dialog-dark.png"), "#101010"));
    await win.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    // The page follows the record's theme and tells the shell, so the light side is picked where the record is written:
    // the settings page. The main's colour changing is the paint; the class alone is not.
    const insetColour = (): Promise<string> => win.evaluate(() => getComputedStyle(document.querySelector("[data-slot=sidebar-inset]")!).backgroundColor);
    const darkInset = await insetColour();
    await win.keyboard.press("Meta+,");
    await win.waitForSelector("[data-settings-page]");
    await win.getByRole("radio", { name: THEME_WORDS.light.title }).click();
    await win.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    await vi.waitFor(async () => expect(await insetColour()).not.toBe(darkInset));
    await win.keyboard.press("Meta+,");
    await win.waitForSelector("[data-settings-page]", { state: "detached" });
    await win.waitForTimeout(500);
    await rest();
    shots.push(await photographWindow(app, win, join(SHOTS, "app-cloud-row-light.png"), "#ffffff"));
    console.info(`cloud row: ${shots.join(" ")}`);

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

  it("Enter on the agents screen installs every agent found here and advances to the recap", async () => {
    launched = await launch({ PATH: "/usr/bin:/bin" }, twoAgents);
    const { app, home } = launched;
    const page = await windowAt(app, ONBOARDING_URL);
    await page.waitForLoadState("domcontentloaded");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#agents:not([hidden])");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#recap:not([hidden])");
    expect(await page.$$eval("#rows li .state", els => els.map(e => e.textContent))).toEqual(CATALOG_AGENTS.map(a => (a.id === "claude" || a.id === "codex" ? "MCP added" : "not found")));
    expect(await page.textContent("#recap-agents .state")).toBe("MCP added");
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.wsp.command).toBe(shimPath(home));
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.wsp]");
  });

  it("attaches to a host already on the port with an empty ~/.wsp and no key, skipping the gate, and leaves it running after quit", async () => {
    existing = await fixtureHost();
    launched = await launch({ WSP_HOME: undefined, WSP_PORT: String(existing.port) });
    const win = await windowAt(launched.app, APP_URL);
    const boot = await bootOf(win);
    expect(win.url()).toBe(`http://127.0.0.1:${existing.port}/`);
    expect(boot.token).toBe(existing.authToken);
    // Nothing of a host's lands in ~/.wsp; the wsp command the app installs on every launch is all that is there.
    expect(readdirSync(join(launched.home, ".wsp"))).toEqual(["bin"]);
    await launched.app.close();
    expect(await refused(`http://127.0.0.1:${existing.port}/`)).toBe(false);
  });

  it("follows ~/.wsp/current-home to a host serving a custom home, with no WSP_HOME and no port hint", async () => {
    const user = mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-user-"));
    const custom = join(user, "custom-home");
    const quiet: CliIO = { log: () => {}, error: () => {}, ask: () => Promise.reject(new Error("prompt")), askSecret: () => Promise.reject(new Error("prompt")) };
    vi.stubEnv("SOLARI_API_KEY", FAKE_SOLARI);
    vi.stubEnv("HOME", user);
    vi.stubEnv("WSP_HOME", custom);
    existing = await serve(quiet, { port: 0, wsPort: 0, statePath: join(custom, "state.json"), webDir: fakeWebDir(), runtime: testRuntime() });
    vi.unstubAllEnvs();
    expect(existsSync(join(user, ".wsp", "current-home"))).toBe(true);

    launched = await launch({ HOME: user, WSP_HOME: undefined });
    const win = await windowAt(launched.app, APP_URL);
    const boot = await bootOf(win);
    expect(win.url()).toBe(`http://127.0.0.1:${existing.port}/`);
    expect(boot.token).toBe(existing.authToken);
    await launched.app.close();
    expect(await refused(`http://127.0.0.1:${existing.port}/`)).toBe(false);
    rmSync(user, { recursive: true, force: true });
  });

  it("a right-click on a workspace row builds the native menu from the workspace registry through the bridge", async () => {
    // A host over the stub backend with one workspace, serving the built web app, so the sidebar has a row to right-click.
    existing = await startHost({ runtime: testRuntime(true), webDir: workspaceAsset("web"), port: 0, wsPort: 0 });
    const first = await existing.createWorkspace("first");
    launched = await launch({ WSP_HOME: undefined, WSP_PORT: String(existing.port) });
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

  it("a pointer whose host is gone is not followed: the first launch runs on ~/.wsp", async () => {
    launched = await launch({ WSP_HOME: undefined }, home => {
      const custom = join(home, "old-home");
      mkdirSync(custom);
      writeFileSync(join(custom, "host.lock"), JSON.stringify({ pid: deadPid(), port: 1, wsPort: 2, startedAt: "2026-09-01T00:00:00.000Z" }));
      mkdirSync(join(home, ".wsp"));
      writeFileSync(join(home, ".wsp", "current-home"), `${custom}\n`);
    });
    const page = await windowAt(launched.app, ONBOARDING_URL);
    await page.waitForLoadState("domcontentloaded");
    expect(await page.textContent("#welcome h1")).toBe("Welcome to wsp");
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
          icon: colorOf("[data-sidebar-search] button svg"),
          chevron: colorOf("button[aria-label='Workspaces'] svg"),
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
          chevron: contrast(page.chevron, shot.glass),
          search: contrast(page.searchText, shot.searchRow),
        };
        console.info(`over a ${desktop} desktop the glass is rgb(${shot.glass.join(", ")}) and the search row rgb(${shot.searchRow.join(", ")}): ${Object.entries(ratios).map(([k, v]) => `${k} ${v.toFixed(2)}:1`).join(", ")}`);
        expectOneGap(openGaps);
        expect(Math.abs(wordmarkDrop)).toBeLessThanOrEqual(CENTRED);
        // The search row sits on the selected row's surface, so it reads apart from the bare glass beside it, and the word
        // Search is still AA on it.
        expect(shot.searchRow).not.toEqual(shot.glass);
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
        expect(collapsed.crumb).toBe("No workspace selected");
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
