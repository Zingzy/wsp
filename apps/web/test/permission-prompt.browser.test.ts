// SPDX-License-Identifier: AGPL-3.0-only
// The relayed permission prompt row in a real Chromium: a uniform chat row
// whose lead reads what the tool wants, whose input is the muted mono every
// tool row wears, and whose options are plain buttons while the turn waits on
// them, replaced by one muted line once the prompt is closed. No chip, no
// badge and no colour of its own on either state, in both themes, with the
// rows photographed for review. Like the other render tests it runs only when
// asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
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

if (skipped !== undefined) console.info(`permission prompt render test skipped: ${skipped}`);

/** The tokens a chip or a badge would bring: a row that carries none of them is drawn like every other chat row. */
const skinOf = (selector: string) => `(() => {
  const el = document.querySelector('${selector}');
  const s = getComputedStyle(el);
  return { background: s.backgroundColor, border: s.borderTopWidth, radius: s.borderTopLeftRadius, font: s.fontFamily, color: s.color };
})()`;

describe.skipIf(skipped !== undefined)("the relayed permission prompt row laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html?local=1&ws=ws_m&perm=1`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the open prompt offers its options and the closed one states its outcome, neither as a chip", async theme => {
    await page!.goto(`${base}&theme=${theme}`);
    const open = '[data-permission-prompt="ask_open"]';
    const closed = '[data-permission-prompt="ask_done"]';
    await page!.waitForSelector(open);

    // The open prompt: what the tool wants, its input, and every option the harness offered as a plain button.
    expect(await page!.locator(open).getAttribute("data-permission-open")).toBe("true");
    expect(await page!.locator(`${open} >> text=Permission for Bash: pnpm exec vitest run`).count()).toBe(1);
    expect(await page!.locator(`${open} [data-permission-option]`).allTextContents()).toEqual(["Allow", "Deny", "Allow, then Accept edits"]);

    // The closed one has no option left and says what closed it, in one muted mono line.
    expect(await page!.locator(closed).getAttribute("data-permission-open")).toBe("false");
    expect(await page!.locator(`${closed} [data-permission-option]`).count()).toBe(0);
    expect(await page!.locator(`${closed} [data-permission-outcome]`).textContent()).toBe("Allowed: Allow");
    const outcome = await page!.evaluate(skinOf(`${closed} [data-permission-outcome]`));
    expect(outcome).toMatchObject({ background: "rgba(0, 0, 0, 0)", border: "0px", radius: "0px" });
    expect(String((outcome as { font: string }).font).toLowerCase()).toMatch(/mono/);

    // Both rows sit in the timeline at the same width and wear the same rule under them as the rows around them.
    const widths = await page!.evaluate(`[document.querySelector('${open}').getBoundingClientRect().width, document.querySelector('${closed}').getBoundingClientRect().width]`);
    expect((widths as number[])[0]).toBe((widths as number[])[1]);
    for (const selector of [open, closed]) {
      const row = await page!.evaluate(skinOf(selector));
      expect(row).toMatchObject({ background: "rgba(0, 0, 0, 0)", radius: "0px" });
    }

    const shot = join(SHOTS, `permission-prompt-${theme}.png`);
    await page!.locator(open).locator("xpath=ancestor::div[@data-timeline-root][1]").screenshot({ path: shot });
    expect(existsSync(shot)).toBe(true);
  }, 45_000);
});
