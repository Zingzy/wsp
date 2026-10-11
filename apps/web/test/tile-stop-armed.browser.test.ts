// SPDX-License-Identifier: AGPL-3.0-only
// A working tile's Stop armed, in a real Chromium: row one's words give up the
// room the word Stop takes, so no letter stands under it, with no fill under the
// word, in Graphite and in Paper; nothing else on the tile moves and it keeps its
// height. Like the other render tests it runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`tile stop render test skipped: ${renderSkipped}`);

/** The running thread's tile, and the item that holds it and its act. */
const TILE = "[data-row-id='thread:s1']";
const WAIT_MS = 8_000;

interface Box {
  left: number;
  right: number;
  top: number;
  height: number;
}

interface Geometry {
  where: Box;
  title: Box;
  tile: Box;
  stop: Box;
  armed: boolean;
  ground: string;
}

describe.skipIf(renderSkipped !== undefined)("a tile's armed Stop, in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
    page.setDefaultTimeout(WAIT_MS);
    mkdirSync(SHOTS, { recursive: true });
    // Vite bundles the page's imports on the first load, which takes longer than a case may.
    await page.goto(`${base}?stop=1`, { timeout: 60_000 });
    await page.waitForSelector(TILE, { timeout: 60_000 });
  }, 90_000);

  afterAll(() => stopRender(browser, vite?.child));

  const measure = (): Promise<Geometry> =>
    page!.evaluate(`(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, height: r.height }; };
      const tile = document.querySelector(${JSON.stringify(TILE)});
      const stop = tile.parentElement.querySelector(":scope > [data-stop-act]");
      return {
        where: rect(tile.querySelector("[data-tile-where]")),
        title: rect(tile.querySelector("[data-thread-title]")),
        tile: rect(tile),
        stop: rect(stop),
        armed: stop.hasAttribute("data-armed"),
        ground: getComputedStyle(stop).backgroundColor,
      };
    })()`) as Promise<Geometry>;

  it.each(["dark", "light"] as const)("row one's words end before the armed word starts, with no fill under it, in the %s theme", async theme => {
    await page!.goto(`${base}?stop=1&theme=${theme}`);
    await page!.waitForSelector(TILE);
    const rest = await measure();
    const item = page!.locator(TILE).locator("xpath=..");
    await item.hover();
    await page!.locator(`${TILE} ~ [data-stop-act]`).click();
    await page!.waitForSelector(`${TILE} ~ [data-stop-act][data-armed]`);
    // The pointer still rests on the word, as it does between the two presses.
    await page!.locator(`${TILE} ~ [data-stop-act]`).hover();
    const armed = await measure();
    await item.screenshot({ path: join(SHOTS, `tile-stop-armed-${theme}.png`) });

    expect(armed.armed).toBe(true);
    expect(armed.where.right).toBeLessThanOrEqual(armed.stop.left);
    expect(armed.where.right).toBeLessThan(rest.where.right);
    expect(armed.ground).toBe("rgba(0, 0, 0, 0)");
    // Row two and the tile stand where they stood.
    expect(armed.title).toEqual(rest.title);
    expect(armed.tile).toEqual(rest.tile);
    expect(armed.tile.height).toBe(52);
  });
});
