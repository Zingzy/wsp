// SPDX-License-Identifier: AGPL-3.0-only
// The creation screen in a real Chromium: the log box keeps one height from
// two lines to twenty, the newest line sits inside the box's viewport, and the
// text column is centred. Vite serves test/creation to Playwright's browser, so
// like the glyph test it runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium on the machine.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startVite, stopRender, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = ((): string | undefined => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();
const hasBrowser = browserPath !== undefined && existsSync(browserPath);
const skipped = process.env["WSP_RENDER"] !== "1" ? "WSP_RENDER is not 1" : !hasBrowser ? "Playwright's Chromium is not installed" : undefined;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

if (skipped !== undefined) console.info(`creation layout render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the creation screen laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/creation/index.html");
    base = `${vite.base}/test/creation/index.html`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  async function open(lines: number, theme: "dark" | "light"): Promise<void> {
    await page!.goto(`${base}?lines=${lines}&theme=${theme}`);
    await page!.waitForSelector("[data-testid=creation-log] li");
  }
  const box = async (selector: string): Promise<Box> => {
    const b = await page!.locator(selector).first().boundingBox();
    if (!b) throw new Error(`${selector} has no box`);
    return b;
  };

  it("the log box is the same height with two lines and with twenty", async () => {
    await open(2, "dark");
    const two = await box("[data-testid=creation-log]");
    await open(20, "dark");
    const twenty = await box("[data-testid=creation-log]");
    expect(twenty.height).toBe(two.height);
    expect(twenty.width).toBe(two.width);
  }, 30_000);

  it("with twenty lines the newest line is inside the box's viewport and the first has scrolled out", async () => {
    await open(20, "dark");
    const viewport = await box("[data-testid=creation-log] [data-slot=scroll-area-viewport]");
    const newest = await box("[data-testid=creation-log] li:last-child");
    const first = await box("[data-testid=creation-log] li:first-child");
    expect(newest.y).toBeGreaterThanOrEqual(viewport.y);
    expect(newest.y + newest.height).toBeLessThanOrEqual(viewport.y + viewport.height + 0.5);
    expect(first.y + first.height).toBeLessThan(viewport.y);
    expect(await page!.locator("[data-testid=creation-log] li:last-child").textContent()).toContain("both machine slots are in use: first, t-cap. Pause one or wait for a nap.");
  }, 30_000);

  it("the eyebrow, the name, the wave, the buttons and the box share one centre in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(2, theme);
      const centre = (b: Box) => b.x + b.width / 2;
      const log = await box("[data-testid=creation-log]");
      const wave = await box("[role=progressbar]");
      const eyebrow = await box("[data-testid=workspace-creation] p");
      const name = await box("h1");
      const retry = await box("button:has-text('Retry')");
      const dismiss = await box("button:has-text('Dismiss')");
      expect(wave.width).toBe(log.width);
      expect(Math.abs(centre(wave) - centre(log))).toBeLessThan(1);
      expect(Math.abs(centre(eyebrow) - centre(log))).toBeLessThan(1);
      expect(Math.abs(centre(name) - centre(log))).toBeLessThan(1);
      const buttons = { x: retry.x, width: dismiss.x + dismiss.width - retry.x, y: 0, height: 0 };
      expect(Math.abs(centre(buttons) - centre(log))).toBeLessThan(1);
    }
  }, 30_000);
});
