// SPDX-License-Identifier: AGPL-3.0-only
// The rule every pane obeys, in a real Chromium: a slot says pending only
// while a module that will answer has not yet, and a kind whose machines read
// no metrics says so instead, from the first paint. Both tabs are photographed
// in both themes for review. Like the other render tests it runs only when
// asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOT_ON_THIS_KIND } from "@wsp/protocol";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");
const ROWS = ["cpu", "mem", "disk"] as const;

if (renderSkipped !== undefined) console.info(`live pending render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("what a Live row says while it waits", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  const slot = (tab: string, k: string) => page!.locator(`[data-testid=${tab}-tab] [data-live-row=${k}] [data-k=${k}]`);

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/live-pending/index.html");
    base = `${vite.base}/test/live-pending/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme a machine over ssh says what it is in every slot, never pending", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-testid=ssh-tab] [data-live-row=cpu]");
    for (const k of ROWS) {
      expect(await slot("ssh", k).textContent()).toBe(NOT_ON_THIS_KIND);
      // Muted mono metadata, the same slot every other word sits in: no chip, no colour of its own.
      const skin = await slot("ssh", k).evaluate(el => {
        const s = getComputedStyle(el);
        return { background: s.backgroundColor, border: s.borderTopWidth, font: s.fontFamily };
      });
      expect(skin.background).toBe("rgba(0, 0, 0, 0)");
      expect(skin.border).toBe("0px");
      expect(skin.font.toLowerCase()).toMatch(/mono/);
    }
    expect(await page!.locator("[data-testid=ssh-tab] [data-stale]").count()).toBe(0);
    const shot = join(SHOTS, `live-not-on-this-kind-${theme}.png`);
    await page!.locator("[data-testid=ssh-tab]").screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);
  }, 30_000);

  it("this computer's rows read pending while its module has not answered, then the figures, at one height throughout", async () => {
    await page!.goto(base);
    await page!.waitForSelector("[data-testid=local-tab] [data-live-row=cpu]");
    for (const k of ROWS) expect(await slot("local", k).textContent()).toBe("pending");
    const heights = () => page!.locator("[data-testid=local-tab] [data-live-row]").evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
    const pendingHeights = await heights();
    const shot = join(SHOTS, "live-pending.png");
    await page!.locator("[data-testid=local-tab]").screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);

    await page!.evaluate(() => (window as unknown as { landSample: () => void }).landSample());
    await expect.poll(() => slot("local", "cpu").textContent(), { timeout: 10_000 }).toBe("33%");
    expect(await slot("local", "mem").textContent()).toBe("6.0 GB of 16.0 GB");
    expect(await slot("local", "disk").textContent()).toBe("200.0 GB of 500.0 GB");
    expect(await heights()).toEqual(pendingHeights);
    const filled = join(SHOTS, "live-filled.png");
    await page!.locator("[data-testid=local-tab]").screenshot({ path: filled });
    expect(existsSync(filled)).toBe(true);
  }, 30_000);
});
