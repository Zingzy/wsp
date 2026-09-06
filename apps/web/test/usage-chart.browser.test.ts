// SPDX-License-Identifier: AGPL-3.0-only
// The usage chart laid out in a real Chromium over two metered days: the
// whole life by default, the hour and day ranges on their toggles, the empty
// state holding the same height, photographed in both themes. Runs only when
// asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast } from "./contrast";
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

if (skipped !== undefined) console.info(`usage chart render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the usage chart laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/usage-chart/index.html");
    base = `${vite.base}/test/usage-chart/index.html`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the line spans the metered life, the ranges re-read the axis, and the empty box keeps the height", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-usage-line]");
    await page!.waitForFunction(() => document.querySelector("[data-k=accrued]")?.textContent !== "$0.0000");
    const chart = page!.locator("[data-usage-chart]");
    const loaded = (await chart.boundingBox())!;
    expect(await page!.locator("[data-usage-chart] rect").count()).toBe(0);
    const xAxis = await page!.locator("[data-usage-axis=x] span").allTextContents();
    expect(xAxis).toHaveLength(3);
    for (const label of xAxis) expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}/);
    const yAxis = await page!.locator("[data-usage-axis=y] span").allTextContents();
    expect(yAxis.at(-1)).toBe("$0.00");
    expect(yAxis.length).toBeGreaterThanOrEqual(3);
    // The line, the fill and the newest point share one colour: the spend orange the palette reserves for cost.
    const lineColor = await page!.locator("[data-usage-line]").evaluate(el => getComputedStyle(el).stroke);
    const dotColor = await page!.locator("[data-k=usage-end]").evaluate(el => getComputedStyle(el).backgroundColor);
    expect(lineColor).toBe(dotColor);
    // Both axes and the toggles are mono with tabular numerals.
    for (const selector of ["[data-usage-axis=x] span", "[data-usage-axis=y] span", "[data-k=usage-range] button"]) {
      const font = await page!.locator(selector).first().evaluate(el => getComputedStyle(el).fontFamily);
      expect(font).toMatch(/mono/i);
    }
    // Metadata text reads at AA or better: the axis labels and the unselected range words are the muted token with no alpha.
    for (const selector of ["[data-usage-axis=x] span", "[data-usage-axis=y] span", "[data-k=usage-range] button[aria-pressed=false]"]) {
      const ratios = await textContrast(page!, selector);
      console.info(`${theme}: ${selector} reads at ${ratios.join(", ")} to 1`);
      expect(ratios.length).toBeGreaterThan(0);
      for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `usage-chart-${theme}.png`) });

    await page!.getByRole("button", { name: "hour" }).click();
    const hourAxis = await page!.locator("[data-usage-axis=x] span").allTextContents();
    expect(hourAxis).toHaveLength(4);
    for (const label of hourAxis) expect(label).toMatch(/^\d{2}:\d{2}/);
    expect((await chart.boundingBox())!.height).toBe(loaded.height);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `usage-chart-hour-${theme}.png`) });

    await page!.getByRole("button", { name: "day" }).click();
    expect(await page!.locator("[data-usage-axis=x] span").count()).toBe(4);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `usage-chart-day-${theme}.png`) });

    const svg = (await page!.locator("[data-usage-chart] svg").boundingBox())!;
    await page!.mouse.move(svg.x + svg.width * 0.6, svg.y + svg.height / 2);
    await page!.waitForSelector("[data-usage-hover]", { state: "attached" });
    expect(await page!.locator("[data-k=usage-readout]").textContent()).toMatch(/^\$\d+\.\d{4} · \$\d\.\d{3}\/hr · /);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `usage-chart-hover-${theme}.png`) });

    await page!.goto(`${base}?theme=${theme}&empty=1`);
    await page!.waitForSelector("[data-usage-chart]");
    await page!.waitForSelector("[data-k=rate]");
    expect(await page!.locator("[data-usage-chart]").textContent()).toBe("No cost yet");
    expect(await page!.locator("[data-usage-chart] svg").count()).toBe(0);
    const empty = await textContrast(page!, "[data-k=usage-empty]");
    console.info(`${theme}: the empty state reads at ${empty.join(", ")} to 1`);
    expect(empty).toHaveLength(1);
    expect(empty[0]).toBeGreaterThanOrEqual(4.5);
    const emptyBox = (await page!.locator("[data-usage-chart]").boundingBox())!;
    expect(emptyBox.height).toBe(loaded.height);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `usage-chart-empty-${theme}.png`) });
  }, 45_000);
});
