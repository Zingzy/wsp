// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog in a real Chromium, both themes: the size rows
// share one height with each other, read in the muted mono voice the start
// details use, carry no border or fill of their own, and the rates read at AA.
// Photographed open in each theme. Runs only when asked for (WSP_RENDER=1)
// and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, startVite, stopRender, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`new workspace layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the new-workspace dialog laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/new-workspace/index.html");
    base = `${vite.base}/test/new-workspace/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const SIZE_ROWS = "[aria-labelledby=new-workspace-size] label";
  const styles = (selector: string) =>
    page!.locator(selector).evaluateAll(els =>
      els.map(el => {
        const s = getComputedStyle(el);
        return { height: Math.round(el.getBoundingClientRect().height), color: s.color, font: s.fontFamily, border: s.borderTopWidth, background: s.backgroundColor };
      }),
    );

  it.each(["dark", "light"] as const)("in the %s theme the size rows are uniform muted mono text with nothing loud, the golden's checked", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector(SIZE_ROWS);
    const rows = await styles(SIZE_ROWS);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.height)).size).toBe(1);
    expect(new Set(rows.map(r => r.color)).size).toBe(1);
    for (const r of rows) {
      expect(r.font.toLowerCase()).toMatch(/mono/);
      expect(r.border).toBe("0px");
      expect(r.background).toBe("rgba(0, 0, 0, 0)");
    }
    // The same muted voice as the start-from details.
    const [detail] = await styles("[aria-label='Start from'] label span span:nth-child(2)");
    expect(rows[0]!.color).toBe(detail!.color);
    expect(await page!.locator(`${SIZE_ROWS} [role=radio]`).evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(["true", "false"]);
    expect(await page!.locator(SIZE_ROWS).allTextContents()).toEqual(["2 vCPU · 4 GB$0.11/hr", "2 vCPU · 8 GB$0.15/hr"]);
    const ratios = await textContrast(page!, `${SIZE_ROWS} > span`);
    console.info(`${theme}: size rows read at ${ratios.map(r => r.toFixed(2)).join(", ")} to 1`);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `new-workspace-open-${theme}.png`) });
  });
});
