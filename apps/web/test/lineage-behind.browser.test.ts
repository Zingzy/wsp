// SPDX-License-Identifier: AGPL-3.0-only
// The Lineage section in a real Chromium for a workspace still on an older
// version: its row carries the state in words and the button that moves it,
// the version's retired rows sit under it, and neither pushes the tab wide, in
// both themes. Like the missing-tools render test it runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startVite, stopRender, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");
const browserPath = ((): string | undefined => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();
const hasBrowser = browserPath !== undefined && existsSync(browserPath);
const skipped = process.env["WSP_RENDER"] !== "1" ? "WSP_RENDER is not 1" : !hasBrowser ? "Playwright's Chromium is not installed" : undefined;

if (skipped !== undefined) console.info(`lineage behind-head render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the offer to a workspace behind the head, laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/lineage-behind/index.html");
    base = `${vite.base}/test/lineage-behind/index.html`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the forked version says what it is on and what is available, its button sits on that row, the retired rows sit under it, and nothing leaves the tab", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-k=retired-rows] li");
    const v11 = await page!.locator("[data-k=v11]").boundingBox();
    const v12 = await page!.locator("[data-k=v12]").boundingBox();
    const row = page!.locator("[data-k=v11]").locator("xpath=ancestor::li[1]");
    expect(await row.textContent()).toContain("on image v11, v12 available");
    const button = page!.getByRole("button", { name: "update api to v12" });
    // The offer is on the row it belongs to, below v12 and beside v11's own line.
    const box = (await button.boundingBox())!;
    expect(box.y).toBeGreaterThan(v12!.y);
    expect(Math.abs(box.y + box.height / 2 - (v11!.y + v11!.height / 2))).toBeLessThan(box.height);
    expect(await page!.getByRole("button", { name: "roll back to v11" }).count()).toBe(0);

    const label = await page!.locator("[data-k=retired-rows] p").boundingBox();
    expect(await page!.locator("[data-k=retired-rows] p").textContent()).toBe("retired, still on this image");
    expect(label!.y).toBeGreaterThan(v11!.y);
    expect(await page!.locator("[data-k=retired-row]").allTextContents()).toEqual(["yq", "~/.zshrc", "diskbloom"]);

    const tab = (await page!.locator("[data-testid=machine-tab]").boundingBox())!;
    for (const el of [box, label!, (await page!.locator("[data-k=retired-row]").last().boundingBox())!]) {
      expect(el.x + el.width).toBeLessThanOrEqual(tab.x + tab.width);
    }
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `lineage-behind-${theme}.png`) });
    expect(existsSync(join(SHOTS, `lineage-behind-${theme}.png`))).toBe(true);
  }, 30_000);
});
