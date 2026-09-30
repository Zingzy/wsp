// SPDX-License-Identifier: AGPL-3.0-only
// The Mac window hands the page a transparent ground over macOS's own vibrancy, and the page draws no blur of its
// own: a pane that sits over text stands on its material instead. Photographs the glass page on a transparent ground
// in a real Chromium, reads that no pane carries a backdrop filter, and compares the pixel-to-pixel contrast under
// each pane with the bare text beside it. Runs only when asked for (WSP_RENDER=1) and skips without
// Playwright's Chromium.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (renderSkipped !== undefined) console.info(`glass blur render test skipped: ${renderSkipped}`);

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe.skipIf(renderSkipped !== undefined)("frosted panes over a transparent page", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/glass/index.html");
    base = `${vite.base}/test/glass/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 960, height: 400 } });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  /** Mean absolute step between horizontal neighbours inside the box, over the alpha and green channels of a shot
   * taken with no page ground, so sharp glyphs score high and a blur or an even fill scores near zero. */
  async function edgeEnergy(png: Buffer, box: Box): Promise<number> {
    return page!.evaluate(
      async ({ b64, box }) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        const { data } = ctx.getImageData(box.x, box.y, box.width + 1, box.height);
        const row = (box.width + 1) * 4;
        let sum = 0;
        for (let y = 0; y < box.height; y++)
          for (let x = 0; x < box.width; x++) {
            const i = y * row + x * 4;
            sum += Math.abs(data[i + 3]! - data[i + 7]!) + Math.abs(data[i + 1]! - data[i + 5]!);
          }
        return sum / (box.width * box.height);
      },
      { b64: png.toString("base64"), box },
    );
  }

  it.each(["dark", "light"] as const)("in the %s theme no pane draws a blur of its own, and the text under the composer and a surface-glass pane stays out of sight", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-glass=surface]");
    const shot = await page!.screenshot({ omitBackground: true });
    // Inset past the rounded corners and the blur's edge, where the pane meets the unblurred page.
    const inner = (left: number): Box => ({ x: left + 30, y: 130, width: 260, height: 100 });
    const bare = await edgeEnergy(shot, { x: 30, y: 280, width: 900, height: 100 });
    const composer = await edgeEnergy(shot, inner(100));
    const surface = await edgeEnergy(shot, inner(500));
    const filters = await page!.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-glass], [data-glass] *")].flatMap(el => [getComputedStyle(el).backdropFilter, getComputedStyle(el, "::before").backdropFilter]).filter(f => f !== "none" && f !== ""),
    );
    expect(filters).toEqual([]);
    // Standing whole, the composer takes a ground, never its tint: the card in the light, the raised material in the dark.
    const composerGround = await page!.evaluate(ground => {
      const probe = document.createElement("div");
      probe.style.background = `color-mix(in srgb, var(${ground}) 100%, transparent)`;
      document.body.append(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { want, got: getComputedStyle(document.querySelector("[data-glass=composer] [data-slot=composer-shell]")!, "::before").backgroundColor };
    }, theme === "dark" ? "--material-raised" : "--card");
    expect(composerGround.got).toBe(composerGround.want);
    expect(bare).toBeGreaterThan(10);
    expect({ composer: composer / bare < 0.02, surface: surface / bare < 0.02 }, JSON.stringify({ bare, composer, surface })).toEqual({ composer: true, surface: true });
  });

  it("off the Mac the composer and a surface-glass pane still frost what is under them, since no window glass stands in", async () => {
    await page!.goto(`${base}?theme=dark&mac=0`);
    await page!.waitForSelector("[data-glass=surface]");
    const filters = await page!.evaluate(() => ({
      composer: getComputedStyle(document.querySelector("[data-glass=composer] [data-slot=composer-shell]")!, "::before").backdropFilter,
      surface: getComputedStyle(document.querySelector("[data-glass=surface]")!).backdropFilter,
    }));
    expect(filters.composer).toContain("blur(");
    expect(filters.surface).toContain("blur(");
  });
});
