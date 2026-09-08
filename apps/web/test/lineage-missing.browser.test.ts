// SPDX-License-Identifier: AGPL-3.0-only
// The Lineage section in a real Chromium: the forked version lists every tool
// missing from its golden with the reason and its outcome as a muted mono word
// in one column, a long reason wraps inside the row, in both themes, and the machine tab is
// photographed for review. Like the creation layout test it runs only when
// asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, startVite, stopRender, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`lineage missing-tools render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the lineage's missing tools laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/lineage/index.html");
    base = `${vite.base}/test/lineage/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 1400 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme every missing tool is a visible row under the forked version's label, a long reason wraps inside the tab, and nothing sits under the others", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-k=missing-tools] li");
    expect(await page!.locator("[data-k=missing-tools]").count()).toBe(1);
    expect(await page!.locator("[data-k=missing-tools] p").textContent()).toBe("not on this image");
    const names = await page!.locator("[data-k=missing-tool]").allTextContents();
    const notes = await page!.locator("[data-k=missing-note]").allTextContents();
    expect(names).toEqual(["gopls", "diskbloom", "Homebrew", "Docker engine and compose"]);
    expect(notes[0]).toBe("no Linux bottle");
    expect(notes[2]).toMatch(/^exit 1: git: not found/);
    expect(notes[3]).toBe("E: Unable to locate package docker-compose-v2");
    expect(await page!.locator("[data-k=missing-tools] [data-mark]").allTextContents()).toEqual(["skipped", "skipped", "failed", "failed"]);
    expect(await page!.locator("[data-slot=badge]").count()).toBe(0);
    const tab = await page!.locator("[data-testid=machine-tab]").boundingBox();
    const v12 = await page!.locator("[data-k=v12]").boundingBox();
    const v11 = await page!.locator("[data-k=v11]").boundingBox();
    const label = await page!.locator("[data-k=missing-tools] p").boundingBox();
    const short = await page!.locator("[data-k=missing-note]").first().boundingBox();
    const long = await page!.locator("[data-k=missing-note]").nth(2).boundingBox();
    const last = await page!.locator("[data-k=missing-note]").last().boundingBox();
    expect(label!.y).toBeGreaterThan(v12!.y + v12!.height);
    expect(last!.y + last!.height).toBeLessThanOrEqual(v11!.y);
    // Height is the wrap proof: the grid clamps the span's box whether or not its glyphs overflow it.
    expect(long!.height).toBeGreaterThan(short!.height * 1.8);
    expect(long!.x + long!.width).toBeLessThanOrEqual(tab!.x + tab!.width);
    // The marks are one column: every word starts at the same x, at one height, and ends inside the tab.
    const words = await Promise.all((await page!.locator("[data-k=missing-tools] [data-mark]").all()).map(w => w.boundingBox()));
    for (const w of words) {
      expect(Math.abs(w!.x - words[0]!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(w!.height - words[0]!.height)).toBeLessThanOrEqual(1);
      expect(w!.x + w!.width).toBeLessThanOrEqual(tab!.x + tab!.width);
      expect(w!.x).toBeGreaterThanOrEqual(long!.x + long!.width);
    }
    // The version rows carry their states the same way, words in a column beside the title.
    const head = await page!.locator("[data-k=v12]").locator("xpath=ancestor::li[1]").locator(":scope > span [data-mark]").allTextContents();
    expect(head).toEqual(["head", "this fork"]);
    expect(await page!.locator("text=Raycast").count()).toBe(0);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `lineage-missing-${theme}.png`) });
    expect(existsSync(join(SHOTS, `lineage-missing-${theme}.png`))).toBe(true);
  }, 30_000);
});
