// SPDX-License-Identifier: AGPL-3.0-only
// The machine tab of a workspace the host is still asking the provider to
// resume, in a real Chromium: the state reads Waking, the row carries the ask
// it is on in the protocol's own words, and the phase slot offers the stop and
// nothing else. Then the tab the asking left behind: the machine is paused, the
// row names the road, and the rebuild stands beside a wake that can be tried
// again. Both in both themes, photographed for review. Like the other render
// tests it runs only when asked for (WSP_RENDER=1) and skips without
// Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wakeAskingAgainLine, wakeAsksIn, wakeGaveUpLine } from "@wsp/protocol";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

/** The cloud provider's asking as the fixture plays it: half an hour once a minute, each call capped at half a minute. */
const ASKING_MS = 30 * 60_000;
const RESUME_CAP_MS = 30_000;
/** The asks that half hour holds, which is what the fixture's row counts against. */
const ASKS = wakeAsksIn(ASKING_MS, 60_000);

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`waking machine tab render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the machine tab of a wake the provider has not taken, laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/machine-waking/index.html");
    base = `${vite.base}/test/machine-waking/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the tab reads Waking, says which ask the host is on, and offers the stop", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-k=wake-ask]");
    expect(await page!.locator("[data-k=state]").textContent()).toBe("Waking");
    // The tab has a line to spend, so it reads the ask at its full length; the sidebar row reads the same two
    // numbers as "asking 3/30" beside the spend.
    expect(await page!.locator("[data-k=wake-ask]").textContent()).toBe(wakeAskingAgainLine(3, ASKS));
    expect(wakeAskingAgainLine(3, ASKS, "short")).toBe("asking 3/30");
    // The sentence is a muted line, not a badge and not an alarm: nothing about it is coloured.
    const reason = await page!.locator("[data-k=wake-ask]").evaluate(el => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, border: s.borderTopWidth };
    });
    expect(reason).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px" });
    // One phase button, and its word is the stop; neither verb of a settled machine is offered beside it.
    const stop = page!.locator("footer button", { hasText: "Stop" });
    expect(await stop.count()).toBe(1);
    expect(await stop.getAttribute("title")).toBe("Stop asking the provider to resume this machine");
    expect(await stop.isDisabled()).toBe(false);
    for (const word of ["Wake", "Pause"]) expect(await page!.locator("footer button", { hasText: word }).count()).toBe(0);
    const shot = join(SHOTS, `machine-waking-${theme}.png`);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);
  }, 30_000);

  it.each(["dark", "light"] as const)("in the %s theme the tab the asking left behind reads Paused, names the road, and offers the rebuild beside the wake", async theme => {
    await page!.goto(`${base}?gave-up&theme=${theme}`);
    await page!.waitForSelector("[data-k=reason]");
    expect(await page!.locator("[data-k=state]").textContent()).toBe("Paused");
    const words = wakeGaveUpLine(ASKS, ASKING_MS - RESUME_CAP_MS);
    expect(await page!.locator("[data-k=reason]").textContent()).toBe(words);
    // Both roads stand: the rebuild the sentence names, and the wake, since the fault is the provider's and may pass.
    const rebuild = page!.locator("button", { hasText: "Rebuild" });
    expect(await rebuild.count()).toBe(1);
    expect(await rebuild.isDisabled()).toBe(false);
    expect(await rebuild.getAttribute("title")).toBe(words);
    const wake = page!.locator("footer button", { hasText: "Wake" });
    expect(await wake.count()).toBe(1);
    expect(await wake.isDisabled()).toBe(false);
    const shot = join(SHOTS, `machine-wake-gave-up-${theme}.png`);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);
  }, 30_000);
});
