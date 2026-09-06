// SPDX-License-Identifier: AGPL-3.0-only
// The machine tab over a daemon behind the app, in a real Chromium: the live
// rows read unavailable, one line under them names what the daemon predates
// with the update keycap at its right edge inside the tab, the rows and the
// line keep their height through the update, and the tab is photographed in
// both themes. Runs only when asked for (WSP_RENDER=1) and skips without
// Playwright's Chromium.
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

if (skipped !== undefined) console.info(`daemon update render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the machine tab over an old daemon laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/daemon-update/index.html");
    base = `${vite.base}/test/daemon-update/index.html`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the rows read unavailable, the line and its keycap sit inside the tab, and nothing moves through the update", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-k=daemon-update]");
    expect(await page!.locator("[data-live-row] [data-k]").allTextContents()).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(await page!.locator("[data-k=daemon-update] span").textContent()).toBe("daemon v1 predates Live and Processes");
    const tab = (await page!.locator("[data-testid=machine-tab]").boundingBox())!;
    const line = (await page!.locator("[data-k=daemon-update]").boundingBox())!;
    const button = (await page!.locator("[data-k=daemon-update] button").boundingBox())!;
    const rowBefore = (await page!.locator("[data-live-row=disk]").boundingBox())!;
    expect(line.x).toBeGreaterThanOrEqual(tab.x);
    expect(line.x + line.width).toBeLessThanOrEqual(tab.x + tab.width);
    expect(button.x + button.width).toBeLessThanOrEqual(tab.x + tab.width);
    expect(line.y).toBeGreaterThanOrEqual(rowBefore.y + rowBefore.height);
    // No colour for state: the word and the line are the muted text tone, the same grey the labels use.
    const color = (selector: string): Promise<string> => page!.locator(selector).first().evaluate(el => getComputedStyle(el).color);
    const labelColor = await color("[data-live-row=cpu] > span:first-child");
    expect(await color("[data-k=daemon-update]")).toBe(labelColor);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `daemon-update-${theme}.png`) });

    // The keycap's help is the app's standard tooltip: hover opens it with one dry sentence.
    await page!.locator("[data-k=daemon-update] button").hover();
    const tooltip = page!.locator("[data-slot=tooltip-popup]");
    await tooltip.waitFor({ state: "visible" });
    expect(await tooltip.textContent()).toBe("Restarts the daemon on the machine. Open terminals end, chat threads keep running.");
    await page!.screenshot({ path: join(SHOTS, `daemon-update-tooltip-${theme}.png`), clip: { x: tab.x, y: tab.y, width: 720, height: 480 } });

    await page!.locator("[data-k=daemon-update] button").click();
    await page!.waitForFunction(() => document.querySelector("[data-k=daemon-update] button")?.textContent === "updating");
    const rowDuring = (await page!.locator("[data-live-row=disk]").boundingBox())!;
    const lineDuring = (await page!.locator("[data-k=daemon-update]").boundingBox())!;
    expect(rowDuring).toEqual(rowBefore);
    expect(lineDuring.height).toBe(line.height);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `daemon-updating-${theme}.png`) });

    // The runtime's op has resolved by now and the hello has not come: the keycap is still busy, the line still v1.
    await page!.waitForTimeout(1_200);
    expect(await page!.locator("[data-k=daemon-update] button").textContent()).toBe("updating");
    expect(await page!.locator("[data-k=daemon-update] button").isDisabled()).toBe(true);
    expect(await page!.locator("[data-k=daemon-update] span").textContent()).toBe("daemon v1 predates Live and Processes");

    await page!.waitForSelector("[data-k=daemon-update]", { state: "detached" });
    expect(await page!.locator("[data-live-row=cpu] [data-k]").textContent()).toBe("12%");
    const rowAfter = (await page!.locator("[data-live-row=disk]").boundingBox())!;
    expect(rowAfter).toEqual(rowBefore);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `daemon-updated-${theme}.png`) });
    expect(existsSync(join(SHOTS, `daemon-update-${theme}.png`))).toBe(true);
  }, 30_000);
});
