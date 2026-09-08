// SPDX-License-Identifier: AGPL-3.0-only
// The settings page in a real Chromium, both themes: one column in the
// shell's centre, a caps mono zone label over each section, sentence-case
// labels over the picks, choice rows of one height with no border, fill or
// badge of their own, the facts in the muted mono voice reading at AA, and
// the theme pick moving the page's theme at once, with no reload, the sidebar
// and the centre following. Photographed in each theme and after the switch.
// Runs only when asked for (WSP_RENDER=1) and skips without Playwright's
// Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast } from "./contrast";
import { startVite, stopRender, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(tmpdir(), "wsp-render");
const browserPath = ((): string | undefined => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();
const hasBrowser = browserPath !== undefined && existsSync(browserPath);
const skipped = process.env["WSP_RENDER"] !== "1" ? "WSP_RENDER is not 1" : !hasBrowser ? "Playwright's Chromium is not installed" : undefined;

if (skipped !== undefined) console.info(`settings layout render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the settings page laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const ROWS = "[data-settings-page] [data-settings-row]";
  const open = async (theme: "dark" | "light"): Promise<void> => {
    await page!.goto(`${base}?theme=${theme}&settings=1&sidebar=312`);
    await page!.waitForSelector(ROWS);
    await page!.waitForSelector("[data-sidebar-row]");
  };
  const paint = (selector: string) =>
    page!.locator(selector).evaluateAll(els =>
      els.map(el => {
        const s = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return { x: Math.round(box.x), width: Math.round(box.width), height: Math.round(box.height), border: s.borderTopWidth, background: s.backgroundColor, font: s.fontFamily, transform: s.textTransform, color: s.color };
      }),
    );
  const shot = async (name: string): Promise<void> => {
    const path = join(SHOTS, `settings-${name}.png`);
    await page!.screenshot({ path });
    console.info(`settings screenshot: ${path}`);
  };

  it.each(["dark", "light"] as const)("in the %s theme: one column, caps mono zone labels, rows of one height with nothing loud, mono facts at AA, the record's values checked", async theme => {
    await open(theme);
    expect(await page!.locator("[data-thread-breadcrumb]").textContent()).toBe("Settings");
    const zones = await paint("[data-settings-page] h2");
    expect(zones.map(z => z.transform)).toEqual(["uppercase", "uppercase"]);
    for (const z of zones) expect(z.font.toLowerCase()).toMatch(/mono/);
    expect(await page!.locator("[data-settings-page] h2").allTextContents()).toEqual(["Appearance", "Terminal"]);
    expect(await page!.locator("[data-settings-page] [data-slot=label]").allTextContents()).toEqual(["Theme", "Sidebar", "Sidebar width", "Text size"]);
    const rows = await paint(ROWS);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map(r => r.height)).size).toBe(1);
    expect(new Set(rows.map(r => r.x)).size).toBe(1);
    expect(new Set(rows.map(r => r.width)).size).toBe(1);
    expect(rows[0]!.width).toBeLessThanOrEqual(576);
    for (const r of rows) {
      expect(r.border).toBe("0px");
      expect(r.background).toBe("rgba(0, 0, 0, 0)");
    }
    expect(await page!.locator("[data-settings-page] [data-slot=badge]").count()).toBe(0);
    const facts = await paint("[data-settings-page] .font-mono.tabular-nums");
    expect(facts.length).toBeGreaterThanOrEqual(3);
    for (const f of facts) expect(f.font.toLowerCase()).toMatch(/mono/);
    expect(await page!.locator("[data-k=sidebar-width]").textContent()).toBe("312 px");
    expect(await page!.locator(`${ROWS} [role=radio]`).evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(theme === "dark" ? ["false", "false", "true", "true", "false", "true", "false"] : ["false", "true", "false", "true", "false", "true", "false"]);
    const ratios = await textContrast(page!, "[data-settings-page] .text-muted-foreground");
    console.info(`${theme}: muted text reads at ${ratios.map(r => r.toFixed(2)).join(", ")} to 1`);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await shot(theme);
  }, 30_000);

  it("the Light pick moves the page's theme at once with no reload, the sidebar and the centre following, and Dark moves it back", async () => {
    await open("dark");
    const state = () =>
      page!.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        body: getComputedStyle(document.body).backgroundColor,
        sidebar: getComputedStyle(document.querySelector("[data-slot=sidebar-inner]")!).backgroundColor,
        card: getComputedStyle(document.querySelector("[aria-label='Open a surface'] button")!).backgroundColor,
        marker: (window as unknown as { __settingsMark?: number }).__settingsMark,
      }));
    await page!.evaluate(() => {
      (window as unknown as { __settingsMark?: number }).__settingsMark = 1;
    });
    const before = await state();
    expect(before.dark).toBe(true);
    await page!.getByRole("radio", { name: "Light" }).click();
    await page!.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    const after = await state();
    expect(after).toMatchObject({ dark: false, marker: 1 });
    expect(after.body).not.toBe(before.body);
    expect(after.sidebar).not.toBe(before.sidebar);
    // The surface cards transition their colours; the switch holds transitions off, so the shot is the light side whole.
    expect(after.card).not.toBe(before.card);
    expect(await page!.evaluate(() => document.documentElement.classList.contains("no-transitions"))).toBe(false);
    expect(await page!.locator(`${ROWS} [role=radio]`).evaluateAll(els => els.slice(0, 3).map(el => el.getAttribute("aria-checked")))).toEqual(["false", "true", "false"]);
    await shot("switched-to-light");
    await page!.getByRole("radio", { name: "Dark" }).click();
    await page!.waitForFunction(() => document.documentElement.classList.contains("dark"));
    expect((await state()).body).toBe(before.body);
  }, 30_000);
});
