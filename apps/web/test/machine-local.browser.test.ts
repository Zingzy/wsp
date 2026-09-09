// SPDX-License-Identifier: AGPL-3.0-only
// The machine tab of a local workspace in a real Chromium: this computer's CPU
// and memory read where a fork's size does, its cost reads free, the system it
// runs, its uptime and its folder read as fact rows in mono, the Live rows
// carry the figures its own modules read, the header wears the kind's glyph, nothing
// about spend, naps, containers or an image is on the tab, and the tab ends at
// its facts, in both themes, with the tab photographed for review. Like the
// other render tests it runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FREE_WORD } from "@wsp/protocol";
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

  it.each(["dark", "light"] as const)("in the %s theme the tab reads this computer's shape and what is true of it, with no spend, no nap, no image and no helper sentence", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-k=folder]");
    expect(await page!.locator("[data-k=size]").textContent()).toBe("10 cores · 16 GB");
    expect(await page!.locator("[data-k=state]").textContent()).toBe("Running");
    expect(await page!.locator("[data-k=reach]").textContent()).toBe("reachable");
    expect(await page!.locator("[data-k=cost]").textContent()).toBe(FREE_WORD);
    expect(await page!.locator("[data-k=os]").textContent()).toBe("macOS 15.5");
    expect(await page!.locator("[data-k=uptime]").textContent()).toBe("3d 4h");
    expect(await page!.locator("[data-k=folder]").textContent()).toBe("/Users/zingzy/wsp");
    // Every fact value is muted mono text, one per row, all flush right in one column, on nothing.
    const values = await page!.locator("[data-k=cost], [data-k=os], [data-k=uptime], [data-k=folder]").evaluateAll(els =>
      els.map(el => {
        const s = getComputedStyle(el);
        return { right: el.getBoundingClientRect().right, mono: /mono/i.test(s.fontFamily), background: s.backgroundColor, border: s.borderTopWidth };
      }),
    );
    for (const value of values) {
      expect(value.mono).toBe(true);
      expect(value.background).toBe("rgba(0, 0, 0, 0)");
      expect(value.border).toBe("0px");
      expect(Math.abs(value.right - values[0]!.right)).toBeLessThan(0.5);
    }
    // The header's lead is the kind's glyph, at the size of the row's own text, not a coloured phase dot.
    const lead = page!.locator("[data-k=machine-id]").locator("xpath=ancestor::div[1]").locator(":scope > *").first();
    expect(await lead.evaluate(el => el.tagName.toLowerCase())).toBe("svg");
    // Nothing wsp does not drive: no awake meter, no auto-nap row, no rate, no accrued, no chart, no lineage.
    for (const k of ["awake", "idle", "rate", "accrued", "machine", "golden"]) expect(await page!.locator(`[data-k=${k}]`).count()).toBe(0);
    for (const word of ["Usage", "Lineage", "forks from no image", "containers", "idle window", "cannot resize"]) expect(await page!.locator(`text=${word}`).count()).toBe(0);
    expect(await page!.locator("[data-slot=badge]").count()).toBe(0);
    expect(await page!.locator("footer").count()).toBe(0);
    // The Live rows read this computer's own modules, so the figures sit in the slot the kind's word used to hold,
    // in the same ink.
    const figures = ["33%", "6.0 GB of 16.0 GB", "200.0 GB of 500.0 GB"];
    for (const [i, k] of ["cpu", "mem", "disk"].entries()) {
      const slot = page!.locator(`[data-k=${k}]`);
      expect(await slot.textContent()).toBe(figures[i]);
      expect(await slot.evaluate(el => /mono/i.test(getComputedStyle(el).fontFamily))).toBe(true);
      expect(await page!.locator(`[data-live-row=${k}][data-kind-word]`).count()).toBe(0);
    }
    // The panel ends where its content ends: the last section's bottom edge is the tab's last painted line.
    const tab = await page!.locator("[data-testid=machine-tab]").boundingBox();
    const last = await page!.locator("section").last().boundingBox();
    expect(last!.y + last!.height).toBeLessThanOrEqual(tab!.y + tab!.height);
    const shot = join(SHOTS, `machine-local-${theme}.png`);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);
  }, 30_000);
});
