// SPDX-License-Identifier: AGPL-3.0-only
// The machine tab of a local workspace in a real Chromium: this computer's CPU
// and memory read where a fork's size does, the header wears the kind's glyph
// in place of the phase dot, nothing about spend or naps is on the tab, and the
// lineage is one row saying what the machine is, in both themes, with the tab
// photographed for review. Like the other render tests it runs only when asked
// for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { THIS_COMPUTER } from "@wsp/protocol";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`local machine tab render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the machine tab of this computer laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/machine-local/index.html");
    base = `${vite.base}/test/machine-local/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the tab reads this computer's shape and says what the machine is, with no spend, no nap and no image", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-k=machine]");
    expect(await page!.locator("[data-k=size]").textContent()).toBe("10 vCPU · 16 GB");
    expect(await page!.locator("[data-k=state]").textContent()).toBe("Running");
    expect(await page!.locator("[data-k=reach]").textContent()).toBe("reachable");
    // The header's lead is the kind's glyph, at the size of the row's own text, not a coloured phase dot.
    const lead = page!.locator("[data-k=machine-id]").locator("xpath=ancestor::div[1]").locator(":scope > *").first();
    expect(await lead.evaluate(el => el.tagName.toLowerCase())).toBe("svg");
    // Nothing wsp does not drive: no awake meter, no auto-nap row, no rate, no accrued, no chart.
    for (const k of ["awake", "idle", "rate", "accrued"]) expect(await page!.locator(`[data-k=${k}]`).count()).toBe(0);
    expect(await page!.locator("text=Usage").count()).toBe(0);
    // The lineage is one row and it says what the machine is; the host's sealed golden is not on this tab.
    expect(await page!.locator("[data-k=machine]").textContent()).toBe(THIS_COMPUTER);
    expect(await page!.locator("[data-k=v12]").count()).toBe(0);
    expect(await page!.locator("[data-slot=badge]").count()).toBe(0);
    // The word is muted mono metadata like every other state word on a lineage row, not a chip of its own.
    const mark = page!.locator("[data-k=machine]").locator("xpath=ancestor::li[1]").locator("[data-mark]").first();
    expect(await mark.textContent()).toBe("now");
    const skin = await mark.evaluate(el => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, border: s.borderTopWidth, font: s.fontFamily };
    });
    expect(skin.background).toBe("rgba(0, 0, 0, 0)");
    expect(skin.border).toBe("0px");
    expect(skin.font.toLowerCase()).toMatch(/mono/);
    const shot = join(SHOTS, `machine-local-${theme}.png`);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);
  }, 30_000);
});
