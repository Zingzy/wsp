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
});
