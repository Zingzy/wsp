// SPDX-License-Identifier: AGPL-3.0-only
// Drives the packaged app (pnpm --filter @wsp/desktop build first). Gated on
// WSP_DESKTOP_SMOKE=1 so the unit suite stays free of a 200 MB binary.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHost, type HostHandle } from "@wsp/host";
import { createRuntime, memoryStore } from "@wsp/runtime";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
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

async function launch(env: Record<string, string>, prepare: (home: string) => void = () => {}): Promise<Launched> {
  const home = mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-"));
  const cwd = join(home, "cwd");
  mkdirSync(cwd);
  prepare(home);
  const clean = { ...process.env };
  delete clean["SOLARI_API_KEY"];
  delete clean["ANTHROPIC_API_KEY"];
  const app = await electron.launch({
    executablePath: builtApp(),
    cwd,
    env: { ...clean, WSP_HOME: home, WSP_PORT: "0", WSP_WS_PORT: "0", ...env },
  });
  return { app, home };
}

async function bootOf(page: Page): Promise<{ wsPort: number; token: string }> {
  await page.waitForLoadState("domcontentloaded");
  return page.evaluate(() => (window as unknown as { __WSP__: { wsPort: number; token: string } }).__WSP__);
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

  it("shows the setup screen without a key or golden, and opens the app once retry finds both", async () => {
    launched = await launch({});
    const setup = await launched.app.firstWindow();
    await setup.waitForLoadState("domcontentloaded");
    expect(setup.url()).toMatch(/setup\.html$/);
    expect(await setup.title()).toBe("wsp");
    expect(await setup.innerText("main")).toContain("run wsp init in a terminal");
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

  it("attaches to a host already on the port and leaves it running after quit", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const webDir = mkdtempSync(join(tmpdir(), "wsp-desktop-smoke-web-"));
    writeFileSync(
      join(webDir, "index.html"),
      `<!doctype html><html><head><title>wsp</title></head><body><script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script></body></html>`,
    );
    existing = await startHost({ runtime: rt, webDir, keys: { anthropic: false }, port: 0, wsPort: 0 });
    launched = await launch({ SOLARI_API_KEY: FAKE_SOLARI, WSP_PORT: String(existing.port) }, seedGolden);
    const win = await launched.app.firstWindow();
    const boot = await bootOf(win);
    expect(win.url()).toBe(`http://127.0.0.1:${existing.port}/`);
    expect(boot.token).toBe(existing.authToken);
    await launched.app.close();
    expect(await refused(`http://127.0.0.1:${existing.port}/`)).toBe(false);
  });
});
