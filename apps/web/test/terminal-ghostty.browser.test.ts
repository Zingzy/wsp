// SPDX-License-Identifier: AGPL-3.0-only
// The terminal surface on a Ghostty config in a real Chromium, one known theme
// per app scheme with a translucent background: the canvas keeps the theme's
// background at the file's alpha where nothing is drawn, the palette colors
// what a program asks for, and the underline cursor is the file's; a
// screenshot per scheme shows the page behind the terminal. Vite serves
// test/terminal-theme to Playwright's browser, so like the glyph test it runs
// only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appTerminalFontSize } from "../src/terminal/ghostty/surface";
import type { Probe } from "./terminal-theme/main";
import { startVite, stopRender, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
const browserPath = ((): string | undefined => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();
const hasBrowser = browserPath !== undefined && existsSync(browserPath);
const skipped = process.env["WSP_RENDER"] !== "1" ? "WSP_RENDER is not 1" : !hasBrowser ? "Playwright's Chromium is not installed" : undefined;

if (skipped !== undefined) console.info(`terminal theme render test skipped: ${skipped}`);

/** The theme backgrounds the page's two configs set, as the canvas must hold them at 0.85 alpha. */
const BACKGROUNDS = { dark: [30, 30, 46], light: [239, 241, 245] } as const;

describe.skipIf(skipped !== undefined)("a translucent Ghostty theme on the surface in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/terminal-theme/index.html");
    base = `${vite.base}/test/terminal-theme/index.html`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 720, height: 360 } });
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("%s: the padding holds the theme background at the file's alpha, slot one colors the red word, the cursor is an underline, and the text draws at the app's own text size", async scheme => {
    await page!.goto(`${base}?theme=${scheme}`);
    const probe = await page!.evaluate(() => (window as unknown as { probe: () => Promise<Probe> }).probe());
    const [r, g, b, a] = probe.corner;
    // Reading a translucent pixel back undoes the premultiplied store, which costs a unit per channel.
    for (const [channel, want] of [r, g, b].map((v, i) => [v, BACKGROUNDS[scheme][i]!] as const)) expect(Math.abs(channel - want)).toBeLessThanOrEqual(2);
    expect(Math.abs(a - Math.round(0.85 * 255))).toBeLessThanOrEqual(2);
    expect(probe.paletteOne, `slot one of the palette painted nothing: ${JSON.stringify(probe)}`).toBe(true);
    expect(probe.underline, `no underline cursor at the prompt: ${JSON.stringify(probe)}`).toBe(true);
    expect(probe.cols).toBeGreaterThan(40);
    // The pane draws at the app's text size, whatever the file asks for, and reads taller than the meta-label size.
    expect(probe.textSize).toBe(appTerminalFontSize());
    expect(probe.metaSize).toBeLessThan(probe.textSize);
    expect(probe.cellHeight, `the cell at ${probe.textSize} is no taller than the one at ${probe.metaSize}: ${JSON.stringify(probe)}`).toBeGreaterThan(probe.metaCellHeight);
    const path = join(SHOTS_DIR, `terminal-ghostty-${scheme}.png`);
    await page!.locator("#page").screenshot({ path });
    console.info(`terminal theme screenshot: ${path}`);
  }, 30_000);
});
