// SPDX-License-Identifier: AGPL-3.0-only
// Drives the packaged app (pnpm --filter @wsp/desktop build first). Gated on
// WSP_DESKTOP_SMOKE=1 so the unit suite stays free of a 200 MB binary.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, startHost, workspaceAsset, type CliIO, type HostHandle } from "@wsp/host";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { WORKSPACE_WORDS } from "../../web/src/actions/format.js";
import { LOCKUP_OPTICAL_CENTRE } from "../../web/src/brand/optical.js";

const SMOKE = process.env["WSP_DESKTOP_SMOKE"] === "1";
const FAKE_SOLARI = "slr_live_fake_desktop_smoke";
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

function builtApp(): string {
  const fromEnv = process.env["WSP_DESKTOP_APP"];
  if (fromEnv !== undefined) return fromEnv;
  const dir = process.arch === "arm64" ? "mac-arm64" : "mac";
  return fileURLToPath(new URL(`../dist/${dir}/wsp.app/Contents/MacOS/wsp`, import.meta.url));
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
  const app = await electron.launch({ executablePath: builtApp(), cwd, env: clean });
  return { app, home };
}

async function bootOf(page: Page): Promise<{ wsPort: number; token: string }> {
  await page.waitForLoadState("domcontentloaded");
  return page.evaluate(() => (window as unknown as { __WSP__: { wsPort: number; token: string } }).__WSP__);
}

interface DesktopWindow {
  wsp: { capturePreview(workspaceId: string): Promise<void>; workspacePreview(workspaceId: string): Promise<string | undefined> };
}

function readPreview(page: Page, workspaceId: string): Promise<string | undefined> {
  return page.evaluate(id => (window as unknown as DesktopWindow).wsp.workspacePreview(id), workspaceId);
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
    const win = await launched.app.firstWindow();
    const boot = await bootOf(win);
    const url = win.url();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await win.title()).toBe("wsp");
    expect(boot.token).toMatch(TOKEN);
    expect(boot.wsPort).toBeGreaterThan(0);
    expect(launched.app.windows()).toHaveLength(1);
    await launched.app.close();
    expect(await refused(url)).toBe(true);
  });

  it("photographs its own page for a workspace and hands the picture back to the page", async () => {
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
    const win = await launched.app.firstWindow();
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
    const win = await launched.app.firstWindow();
    await win.waitForSelector(`[data-row-id='ws:${api.id}']`);
    await win.waitForSelector(`[data-row-id='ws:${web.id}']`);

    // A tap: the chord's step and its release, which is what asks for a picture of the workspace being left.
    await win.keyboard.down("Control");
    await win.keyboard.press("Tab");
    await win.keyboard.up("Control");
    await win.waitForSelector("[data-workspace-switcher]", { state: "detached" });
    // The capture is an ipc round trip the tap only started, and the overlay reads the pictures once, when it
    // opens. Which workspace the tap left is the sidebar's order to decide, so the picture names it.
    const photographed = await win.waitForFunction(
      async ids => {
        const bridge = (window as unknown as DesktopWindow).wsp;
        for (const id of ids) if ((await bridge.workspacePreview(id)) !== undefined) return id;
        return null;
      },
      [api.id, web.id],
    );
    const left = await photographed.jsonValue();
    expect([api.id, web.id]).toContain(left);

    await win.keyboard.down("Control");
    await win.keyboard.press("Tab");
    await win.waitForSelector("[data-workspace-switcher]");
    const shot = win.locator(`[data-workspace-card='${left}'] [data-card-preview] img`);
    await shot.waitFor();
    expect(await shot.getAttribute("src")).toMatch(/^data:image\/png;base64,\w/);
    expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await win.keyboard.up("Control");
  });

  it("shows the setup screen without a key or golden, and opens the app once retry finds both", async () => {
    launched = await launch({});
    const setup = await launched.app.firstWindow();
    await setup.waitForLoadState("domcontentloaded");
    expect(setup.url()).toMatch(/setup\.html\?/);
    expect(await setup.title()).toBe("wsp");
    expect(await setup.innerText("main")).toContain("run wsp init in a terminal");
    expect(await setup.innerText("main")).toContain(`Looked for keys and a golden in ${launched.home}.`);
    expect(await setup.isHidden("#stale")).toBe(true);
    expect(await setup.textContent("#command")).toBe("wsp init");
    await setup.click("#retry");
    await setup.waitForFunction(() => document.getElementById("status")?.textContent === "not set up yet");
    expect(launched.app.windows()).toHaveLength(1);
    expect(existsSync(join(launched.home, ".env"))).toBe(false);

    writeFileSync(join(launched.home, ".env"), `SOLARI_API_KEY=${FAKE_SOLARI}\n`, { mode: 0o600 });
    seedGolden(launched.home);
    const opened = launched.app.waitForEvent("window");
    await setup.click("#retry");
    const win = await opened;
    const boot = await bootOf(win);
    expect(win.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(boot.token).toMatch(TOKEN);
    await setup.waitForEvent("close").catch(() => {});
    expect(launched.app.windows()).toHaveLength(1);
  });

  it("attaches to a host already on the port with an empty ~/.wsp and no key, skipping the gate, and leaves it running after quit", async () => {
    existing = await fixtureHost();
    launched = await launch({ WSP_HOME: undefined, WSP_PORT: String(existing.port) });
    const win = await launched.app.firstWindow();
    const boot = await bootOf(win);
    expect(win.url()).toBe(`http://127.0.0.1:${existing.port}/`);
    expect(boot.token).toBe(existing.authToken);
    expect(existsSync(join(launched.home, ".wsp"))).toBe(false);
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
    const win = await launched.app.firstWindow();
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
    const win = await launched.app.firstWindow();
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
    expect(rows.filter(r => r.type !== "separator").map(r => r.label)).toEqual([
      WORKSPACE_WORDS.pause,
      WORKSPACE_WORDS.rebuild,
      WORKSPACE_WORDS.newThread,
      WORKSPACE_WORDS.openTerminal,
      WORKSPACE_WORDS.openBrowser,
      WORKSPACE_WORDS.openMachine,
      WORKSPACE_WORDS.rename,
      WORKSPACE_WORDS.fork,
      WORKSPACE_WORDS.copyId,
      WORKSPACE_WORDS.forget,
    ]);
    expect(rows.filter(r => r.type === "separator")).toHaveLength(4);
    expect(rows.find(r => r.label === WORKSPACE_WORDS.rename)).toMatchObject({ enabled: false, toolTip: "Renaming is not in the runtime yet" });
    expect(rows.find(r => r.label === WORKSPACE_WORDS.openTerminal)).toMatchObject({ enabled: true, accelerator: "CommandOrControl+J" });
    // The shell's page got the native menu, not the in-app one.
    expect(await win.locator("[data-context-menu]").count()).toBe(0);
  });

  it("shows the setup screen naming ~/.wsp and the pointer whose host is gone", async () => {
    launched = await launch({ WSP_HOME: undefined }, home => {
      const custom = join(home, "old-home");
      mkdirSync(custom);
      writeFileSync(join(custom, "host.lock"), JSON.stringify({ pid: deadPid(), port: 1, wsPort: 2, startedAt: "2026-09-01T00:00:00.000Z" }));
      mkdirSync(join(home, ".wsp"));
      writeFileSync(join(home, ".wsp", "current-home"), `${custom}\n`);
    });
    const setup = await launched.app.firstWindow();
    await setup.waitForLoadState("domcontentloaded");
    expect(setup.url()).toMatch(/setup\.html/);
    const text = await setup.innerText("main");
    expect(text).toContain(`Looked for keys and a golden in ${join(launched.home, ".wsp")}.`);
    expect(text).toContain(`~/.wsp/current-home names ${join(launched.home, "old-home")}, but no host is serving it.`);
  });

  it.runIf(process.platform === "darwin")(
    "on macOS the header row is the frame: the lights sit inside it, the sidebar shows the window's glass and its text keeps AA contrast over a light and a dark desktop",
    async () => {
      launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI }, seedGolden);
      const win = await launched.app.firstWindow();
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
      const staged = await app.evaluate(async ({ BrowserWindow, app: electronApp, screen }, id) => {
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
        await new Promise(r => setTimeout(r, 800));
        return { b: w.getBounds(), backdropId: backdrop.id };
      }, frame.id);
      const { b } = staged;
      const capture = (file: string) => expect(spawnSync("screencapture", ["-R", `${b.x},${b.y},${b.width},${b.height}`, "-x", file]).status).toBe(0);
      const lights = async (file: string) => {
        capture(file);
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
      const mainColour = (px: number[]) => px.every((v, i) => Math.abs(v - page.mainRgb[i]!) <= 6);
      // The window is in the frame when the main column shows its own opaque background and the lights are coloured (key);
      // the header pixel at the wordmark's x tells the two states apart, so a frame saved mid-slide is retaken.
      type Shot = Awaited<ReturnType<typeof lights>>;
      const inFrame = (shot: Shot, state: "open" | "collapsed") =>
        mainColour(shot.main) && shot.reds > 20 && shot.greens > 20 && (state === "collapsed" ? mainColour(shot.probe) : !mainColour(shot.probe));
      const retake = async (file: string, state: "open" | "collapsed"): Promise<Shot> => {
        let shot = await lights(file);
        for (let attempt = 0; !inFrame(shot, state) && attempt < 12; attempt++) {
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
      // The sidebar slides for 200 ms; its container's left edge holding still across two frames, at rest for the state, is the end.
      const slid = (state: "open" | "collapsed") =>
        win.waitForFunction(
          (want: string) =>
            new Promise<boolean>(resolve => {
              const el = document.querySelector("[data-slot=sidebar-container]")!;
              const before = el.getBoundingClientRect().left;
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const { left, width } = el.getBoundingClientRect();
                  resolve(left === before && (want === "open" ? left === 0 : left <= 1 - width));
                }),
              );
            }),
          state,
          { timeout: 5_000 },
        );
      // One gap: the third light's centre to the toggle's centre, and the toggle's centre to the first glyph after it. One
      // vertical centre, measured on ink: the lights' hue extent, the toggle glyph's icon box, the wordmark's optical centre.
      const gaps = (shot: Shot, toggleCentre: { x: number; y: number }, contentLeft: number, glyphCentreY: number) => ({
        lightsToToggle: toggleCentre.x - shot.green.x,
        toggleToContent: contentLeft - toggleCentre.x,
        drop: glyphCentreY - shot.green.y,
      });
      const expectOneGap = (g: ReturnType<typeof gaps>) => {
        expect(Math.abs(g.lightsToToggle - g.toggleToContent)).toBeLessThan(2);
        expect(g.lightsToToggle).toBeGreaterThanOrEqual(28);
        expect(g.lightsToToggle).toBeLessThanOrEqual(32);
        expect(Math.abs(g.drop)).toBeLessThan(0.5);
      };
      const glass: Record<string, number[]> = {};
      for (const [desktop, color] of [["light", "#ffffff"], ["dark", "#101010"]] as const) {
        const file = join(shots, `desktop-mac-${desktop}.png`);
        await app.evaluate(async ({ BrowserWindow }, args) => {
          BrowserWindow.fromId(args.backdropId)!.setBackgroundColor(args.color);
          await new Promise(r => setTimeout(r, 600));
        }, { backdropId: staged.backdropId, color });
        const shot = await retake(file, "open");
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
        expect(Math.abs(wordmarkDrop)).toBeLessThan(0.5);
        // The search row's tint: darker than the bare glass beside it in every channel, and the word Search still AA on it.
        expect(shot.searchRow.every((v, i) => v <= shot.glass[i]!)).toBe(true);
        expect(shot.searchRow.some((v, i) => v < shot.glass[i]!)).toBe(true);
        for (const ratio of Object.values(ratios)) expect(ratio).toBeGreaterThanOrEqual(4.5);

        // Collapsed, the page header is the frame row: the toggle lands where the sidebar's was, the breadcrumb after it, the row still drags.
        await win.click("[data-slot=sidebar-header] [data-slot=sidebar-trigger]");
        await win.waitForSelector("[data-sidebar-state=collapsed]");
        await win.waitForFunction(x => Math.abs(document.querySelector("header [data-slot=sidebar-trigger]")!.getBoundingClientRect().left - x) < 0.01, page.toggleLeft, { timeout: 5_000 });
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
        expect(collapsedShot.red.y).toBeCloseTo(shot.red.y, 0);
        expect(collapsedShot.red.x).toBeCloseTo(shot.red.x, 0);
        const collapsedGaps = gaps(collapsedShot, collapsed.toggleCentre, collapsed.crumbLeft, collapsed.glyphCentreY);
        console.info(`desktop-mac collapsed over a ${desktop} desktop: ${collapsedFile}; header gaps at 1x: ${JSON.stringify(collapsedGaps)}`);
        expectOneGap(collapsedGaps);
        await win.click("header [data-slot=sidebar-trigger]");
        await win.waitForSelector("[data-sidebar-state=expanded]");
        await win.waitForFunction(x => Math.abs(document.querySelector("[data-slot=sidebar-header] [data-slot=sidebar-trigger]")!.getBoundingClientRect().left - x) < 0.01, page.toggleLeft, { timeout: 5_000 });
        await slid("open");
      }
      // The glass shows what is behind it: the two desktops leave two different tints.
      expect(glass["light"]).not.toEqual(glass["dark"]);
      await app.evaluate(({ BrowserWindow }, args) => {
        BrowserWindow.fromId(args.backdropId)!.close();
        BrowserWindow.fromId(args.id)!.setAlwaysOnTop(false);
      }, { id: frame.id, backdropId: staged.backdropId });
    },
    90_000,
  );
});
