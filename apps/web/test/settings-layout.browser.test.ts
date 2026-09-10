// SPDX-License-Identifier: AGPL-3.0-only
// The settings page in a real Chromium, both themes: one column in the
// shell's centre, a caps mono zone label over each section, one
// hairline-separated row per pick with its label at the left and its control
// at the right edge, the picks as segmented controls with no sentence under
// any of them, the sidebar width as a mono number field with a stepper, the
// resolved text size in mono beside its pick, the about row standing as tall
// as a row with a control, the page never scrolling sideways, and the theme
// pick moving the page's theme at once, with no
// reload, the sidebar and the centre following. Photographed in each theme
// and after the switch. Runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(tmpdir(), "wsp-render");

if (renderSkipped !== undefined) console.info(`settings layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the settings page laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    // Wide enough for the centre column to hold a label and its control on one line beside the open panel.
    page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const ROWS = "[data-settings-page] [data-settings-row]";
  const open = async (theme: "dark" | "light"): Promise<void> => {
    await page!.goto(`${base}?theme=${theme}&settings=1&sidebar=312`);
    await page!.waitForSelector(ROWS);
    await page!.waitForSelector("[data-sidebar-row]");
  };
  const shot = async (name: string): Promise<void> => {
    const path = join(SHOTS, `settings-${name}.png`);
    await page!.screenshot({ path });
    console.info(`settings screenshot: ${path}`);
  };

  it.each(["dark", "light"] as const)("in the %s theme: one column, caps mono zone labels, hairline rows with the label left and the control right, segments and a stepper, mono facts at AA, nothing loud, no sideways scroll", async theme => {
    await open(theme);
    expect(await page!.locator("[data-thread-breadcrumb]").textContent()).toBe("Settings");
    const zones = await page!.locator("[data-settings-page] h2").evaluateAll(els => els.map(el => ({ transform: getComputedStyle(el).textTransform, font: getComputedStyle(el).fontFamily, text: el.textContent })));
    expect(zones.map(z => z.text)).toEqual(["Appearance", "Terminal", "About"]);
    for (const z of zones) {
      expect(z.transform).toBe("uppercase");
      expect(z.font.toLowerCase()).toMatch(/mono/);
    }
    const rows = await page!.locator(ROWS).evaluateAll(els =>
      els.map(el => {
        const s = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const label = el.firstElementChild!.getBoundingClientRect();
        const control = el.lastElementChild!.getBoundingClientRect();
        return {
          label: el.firstElementChild!.textContent ?? "",
          x: Math.round(box.x),
          width: Math.round(box.width),
          height: Math.round(box.height),
          hairline: s.borderBottomWidth,
          background: s.backgroundColor,
          labelLeft: Math.round(label.x - box.x),
          controlRight: Math.round(box.right - control.right),
          // A sentence under a pick would be a second line in the label's slot.
          labelLines: Math.round(label.height / parseFloat(getComputedStyle(el.firstElementChild!).lineHeight)),
        };
      }),
    );
    console.info(`settings rows ${theme}: ${JSON.stringify(rows)}`);
    expect(rows.map(r => r.label)).toEqual(["Theme", "Sidebar", "Sidebar width", "Text size", "Version"]);
    expect(new Set(rows.map(r => r.x)).size).toBe(1);
    expect(new Set(rows.map(r => r.width)).size).toBe(1);
    expect(rows[0]!.width).toBeLessThanOrEqual(576);
    // Every row is one line, the same height, a hairline under all but the last of its section, no fill of its own.
    for (const r of rows) {
      expect(r.labelLines).toBe(1);
      expect(r.background).toBe("rgba(0, 0, 0, 0)");
      expect(r.labelLeft).toBe(0);
      expect(r.controlRight).toBe(0);
    }
    expect(new Set(rows.map(r => r.height)).size).toBe(1);
    expect(rows.slice(0, 2).map(r => r.hairline)).toEqual(["1px", "1px"]);
    expect(await page!.locator("[data-settings-page] [data-slot=badge], [data-settings-page] [data-slot=radio]").count()).toBe(0);
    expect(await page!.locator("[data-settings-page] [data-slot=segmented-control]").count()).toBe(3);
    expect(await page!.locator(`${ROWS} [role=radio]`).evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(theme === "dark" ? ["false", "false", "true", "true", "false", "true", "false"] : ["false", "true", "false", "true", "false", "true", "false"]);
    // The chosen segment sits on the control surface in the foreground ink; the rest carry no fill.
    const segments = await page!.locator(`${ROWS} [role=radio]`).evaluateAll(els => els.map(el => ({ checked: el.getAttribute("aria-checked"), background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color })));
    for (const seg of segments) expect(seg.background === "rgba(0, 0, 0, 0)").toBe(seg.checked === "false");
    expect(new Set(segments.filter(s => s.checked === "true").map(s => s.color)).size).toBe(1);
    // The width and the resolved size read in mono; the reset is offered since the record names a width.
    const mono = await page!.locator("[data-k=sidebar-width], [data-k=terminal-size], [data-k=version]").evaluateAll(els => els.map(el => ({ font: getComputedStyle(el).fontFamily, value: (el as HTMLInputElement).value ?? el.textContent })));
    // The about row says what this page can know: a dev page was served by no host and is held by no shell.
    expect(mono.map(m => m.value)).toEqual(["312", "14 px", "host unknown"]);
    for (const m of mono) expect(m.font.toLowerCase()).toMatch(/mono/);
    expect(await page!.getByRole("button", { name: "Reset" }).count()).toBe(1);
    // Nothing scrolls sideways.
    const scroll = await page!.locator("[data-settings-page]").evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, viewport: el.closest("[data-slot=scroll-area-viewport]")!.scrollWidth, viewportClient: el.closest("[data-slot=scroll-area-viewport]")!.clientWidth }));
    expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth);
    expect(scroll.viewport).toBeLessThanOrEqual(scroll.viewportClient);
    const ratios = await textContrast(page!, "[data-settings-page] .text-muted-foreground");
    console.info(`${theme}: muted text reads at ${ratios.map(r => r.toFixed(2)).join(", ")} to 1`);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await shot(theme);
  }, 30_000);

  it("the stepper moves the width by eight and the reset takes it back to the default and leaves", async () => {
    await open("dark");
    await page!.getByRole("button", { name: "Wider" }).click();
    await page!.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-k=sidebar-width]")?.value === "320");
    await page!.waitForFunction(() => Math.abs(document.querySelector("[data-slot=sidebar]")!.getBoundingClientRect().width - 320) < 1);
    await page!.getByRole("button", { name: "Reset" }).click();
    await page!.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-k=sidebar-width]")?.value === "256");
    expect(await page!.getByRole("button", { name: "Reset" }).count()).toBe(0);
  }, 30_000);

  it("the Light segment moves the page's theme at once with no reload, the sidebar and the centre following, and Dark moves it back", async () => {
    await open("dark");
    const state = () =>
      page!.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        body: getComputedStyle(document.body).backgroundColor,
        sidebar: getComputedStyle(document.querySelector("[data-slot=sidebar-inner]")!).backgroundColor,
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
    expect(await page!.evaluate(() => document.documentElement.classList.contains("no-transitions"))).toBe(false);
    expect(await page!.locator(`${ROWS} [role=radio]`).evaluateAll(els => els.slice(0, 3).map(el => el.getAttribute("aria-checked")))).toEqual(["false", "true", "false"]);
    await shot("switched-to-light");
    await page!.getByRole("radio", { name: "Dark" }).click();
    await page!.waitForFunction(() => document.documentElement.classList.contains("dark"));
    expect((await state()).body).toBe(before.body);
  }, 30_000);
});
