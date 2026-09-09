// SPDX-License-Identifier: AGPL-3.0-only
// The labs surfaces the owner reviews by eye, in a real Chromium and both
// themes: the space bar with every kind's own glyph and one picked icon, the
// space icon's context menu, the icon popover and the theme popover anchored
// to it, the sidebar's surface following the picker live through three
// presets, the grain at none and at most, the opacity at its least and the
// pinned side, and the rows scrolling over the grain at speed. Photographed
// at each state. Runs only when asked for (WSP_RENDER=1) and skips without
// Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { THEME_PRESETS } from "@wsp/protocol";
import { WORKSPACE_WORDS } from "../src/actions/format";
import { THEME_WORDS } from "../src/components/look/ThemePopover";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(tmpdir(), "wsp-render");

if (renderSkipped !== undefined) console.info(`labs layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the labs surfaces laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const shot = async (name: string, selector = "[data-slot=sidebar]"): Promise<void> => {
    const path = join(SHOTS, `labs-${name}.png`);
    if (selector === "page") await page!.screenshot({ path });
    else await page!.locator(selector).first().screenshot({ path });
    console.info(`labs screenshot: ${path}`);
  };
  const open = async (theme: "dark" | "light", query = ""): Promise<void> => {
    await page!.goto(`${base}?theme=${theme}&spaces=1&look=1&local=1&ssh=1${query}`);
    await page!.waitForSelector("[data-space-bar]");
    await page!.waitForFunction(() => document.querySelectorAll("[data-space-icon]").length === 5);
  };
  const look = () =>
    page!.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>("[data-app-sidebar]")!;
      const inner = document.querySelector<HTMLElement>("[data-app-sidebar] > [data-slot='sidebar-inner']")!;
      return {
        gradient: getComputedStyle(inner).backgroundImage,
        grain: getComputedStyle(inner, "::before").opacity,
        grainVar: getComputedStyle(sidebar).getPropertyValue("--space-grain").trim(),
        scheme: sidebar.getAttribute("data-space-scheme"),
        surfaceToken: getComputedStyle(inner).getPropertyValue("--sidebar").trim(),
        ink: getComputedStyle(sidebar).getPropertyValue("--space-tint").trim(),
      };
    });
  const menuItem = (label: string) => page!.locator("[data-context-menu] [role=menuitem]").filter({ hasText: label }).first();

  it.each(["dark", "light"] as const)("in the %s theme the space bar holds every kind's glyph and one picked icon at one size, centred, the current in the ink; its menu is the workspace's menu and the two pickers open anchored to the icon", async theme => {
    await open(theme);
    const bar = await page!.evaluate(() => {
      const icons = Array.from(document.querySelectorAll<HTMLElement>("[data-space-icon]")).map(icon => {
        const b = icon.getBoundingClientRect();
        const svg = icon.querySelector("svg")!;
        return { label: icon.getAttribute("aria-label") ?? "", current: icon.hasAttribute("data-space-icon-current"), text: icon.textContent ?? "", x: b.x, width: b.width, height: b.height, y: b.y, glyph: svg.getAttribute("data-space-glyph") ?? [...svg.classList].find(c => c.startsWith("lucide-") && c !== "lucide") ?? "", glyphSize: svg.getBoundingClientRect().width, color: getComputedStyle(icon).color, glyphColor: getComputedStyle(svg).color };
      });
      const sidebar = document.querySelector<HTMLElement>("[data-slot=sidebar]")!.getBoundingClientRect();
      const plus = document.querySelector<HTMLElement>("[data-space-new]")!.getBoundingClientRect();
      return { icons, sidebar: { x: sidebar.x, right: sidebar.right }, plus: { x: plus.x, right: plus.right }, ink: getComputedStyle(document.querySelector<HTMLElement>("[data-app-sidebar]")!).getPropertyValue("--space-tint").trim() };
    });
    console.info(`space bar ${theme}: ${JSON.stringify(bar)}`);
    // The three kinds by their own glyphs, this computer and the machine over ssh among the cloud forks, and the one
    // picked icon; every one the same box and the same glyph size, no name on any.
    expect(bar.icons.map(i => i.glyph)).toEqual(["flask", "lucide-laptop", "lucide-server", "lucide-cloud", "lucide-cloud"]);
    expect(bar.icons.map(i => i.label)).toEqual(["api", "zingzy-mac", "build-box", "web", "old"]);
    expect(bar.icons.map(i => i.text)).toEqual(["", "", "", "", ""]);
    expect(new Set(bar.icons.map(i => Math.round(i.width))).size).toBe(1);
    expect(new Set(bar.icons.map(i => Math.round(i.height))).size).toBe(1);
    expect(new Set(bar.icons.map(i => Math.round(i.glyphSize))).size).toBe(1);
    expect(new Set(bar.icons.map(i => Math.round(i.y))).size).toBe(1);
    expect(bar.icons.map(i => i.current)).toEqual([true, false, false, false, false]);
    expect(Math.abs((bar.icons[0]!.x + bar.plus.right) / 2 - (bar.sidebar.x + bar.sidebar.right) / 2)).toBeLessThan(2);
    expect(bar.icons[0]!.color).toBe(bar.ink.replace(/rgb\((\d+) (\d+) (\d+)\)/, "rgb($1, $2, $3)"));
    expect(new Set(bar.icons.slice(1).map(i => i.color)).size).toBe(1);
    // The bar's colour is the space's own: no glyph wears the row's running green, whatever its machine is doing.
    for (const icon of bar.icons) expect(icon.glyphColor).toBe(icon.color);
    await page!.mouse.move(600, 700);
    await shot(`space-bar-${theme}`);

    // The icon's own menu is the workspace's: the same entries its row carries, the two pickers among them.
    await page!.locator("[data-space-icon][aria-label=api]").click({ button: "right" });
    await page!.waitForSelector("[data-context-menu]");
    const labels = await page!.locator("[data-context-menu] [data-menu-label]").allTextContents();
    for (const word of [WORKSPACE_WORDS.pause, WORKSPACE_WORDS.newThread, WORKSPACE_WORDS.rename, WORKSPACE_WORDS.icon, WORKSPACE_WORDS.theme, WORKSPACE_WORDS.forget]) expect(labels).toContain(word);
    const menuBox = (await page!.locator("[data-context-menu]").boundingBox())!;
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1200);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(800);
    await shot(`space-menu-${theme}`, "page");

    // Change icon: a popover hanging off the icon, the search field over the set, the current one marked.
    await menuItem(WORKSPACE_WORDS.icon).click();
    await page!.waitForSelector("[data-icon-picker]");
    const iconBox = (await page!.locator("[data-space-icon][aria-label=api]").boundingBox())!;
    const pickerBox = (await page!.locator("[data-icon-picker]").boundingBox())!;
    expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(iconBox.y + 1);
    expect(Math.abs(pickerBox.x - iconBox.x)).toBeLessThan(iconBox.width + 8);
    expect(await page!.locator("[data-icon-picker] [aria-pressed=true]").getAttribute("aria-label")).toBe("Icon: Flask");
    expect(await page!.locator("[data-icon-picker] input[type=search]").count()).toBe(1);
    const cells = await page!.locator("[data-icon-picker] [aria-label^='Icon:']").evaluateAll(els => els.map(el => el.getBoundingClientRect().width));
    expect(new Set(cells.map(Math.round)).size).toBe(1);
    await shot(`icon-popover-${theme}`, "page");
    await page!.keyboard.press("Escape");
    await page!.waitForSelector("[data-icon-picker]", { state: "detached" });

    // Edit theme colour: the picker in Zen's shape, anchored the same way.
    await page!.locator("[data-space-icon][aria-label=api]").click({ button: "right" });
    await page!.waitForSelector("[data-context-menu]");
    await menuItem(WORKSPACE_WORDS.theme).click();
    await page!.waitForSelector("[data-theme-picker]");
    const themeBox = (await page!.locator("[data-theme-picker]").boundingBox())!;
    expect(themeBox.y + themeBox.height).toBeLessThanOrEqual(iconBox.y + 1);
    expect(await page!.locator("[data-theme-picker] [data-theme-mode] [role=radio]").allTextContents()).toEqual([THEME_WORDS.mode.auto, THEME_WORDS.mode.light, THEME_WORDS.mode.dark]);
    const wheel = (await page!.locator("[data-theme-wheel]").boundingBox())!;
    expect(Math.round(wheel.width)).toBe(Math.round(wheel.height));
    expect(await page!.locator("[data-theme-picker] [data-theme-dot]").count()).toBe(THEME_PRESETS[1]!.dots.length);
    expect(await page!.locator("[data-theme-picker] [data-theme-preset]").count()).toBe(THEME_PRESETS.length);
    expect(await page!.locator("[data-theme-picker] input[type=range]").count()).toBe(2);
    expect(await page!.locator("[data-theme-picker] [data-slot=badge]").count()).toBe(0);
    await shot(`theme-popover-${theme}`, "page");
    await page!.keyboard.press("Escape");
    await page!.waitForSelector("[data-theme-picker]", { state: "detached" });
  }, 90_000);

  it.each(["dark", "light"] as const)("in the %s theme a bar with more icons than the footer holds scrolls its group, keeps the icon on screen in view and never cuts the plus", async theme => {
    await page!.goto(`${base}?theme=${theme}&spaces=1&look=1&local=1&ssh=1&many=8&sidebar=220`);
    await page!.waitForFunction(() => document.querySelectorAll("[data-space-icon]").length === 13);
    await page!.waitForFunction(() => Math.abs(document.querySelector("[data-slot=sidebar]")!.getBoundingClientRect().width - 220) < 1);
    // The last icon is far outside the group; going there scrolls it into view.
    await page!.locator("[data-space-icon][aria-label=extra-7]").evaluate(el => el.scrollIntoView({ inline: "nearest" }));
    await page!.locator("[data-space-icon][aria-label=extra-7]").click();
    await page!.waitForFunction(() => document.querySelector("[data-space-icon-current]")?.getAttribute("aria-label") === "extra-7");
    const read = await page!.evaluate(() => {
      const group = document.querySelector<HTMLElement>("[data-space-icons]")!;
      const sidebar = document.querySelector<HTMLElement>("[data-slot=sidebar]")!.getBoundingClientRect();
      const g = group.getBoundingClientRect();
      const plus = document.querySelector<HTMLElement>("[data-space-new]")!.getBoundingClientRect();
      const current = document.querySelector<HTMLElement>("[data-space-icon-current]")!.getBoundingClientRect();
      const first = document.querySelector<HTMLElement>("[data-space-icon]")!.getBoundingClientRect();
      return { overflow: group.scrollWidth - group.clientWidth, groupRight: g.right, groupLeft: g.x, plus: { x: plus.x, right: plus.right, width: plus.width }, sidebar: { x: sidebar.x, right: sidebar.right }, current: { x: current.x, right: current.right }, first: { x: first.x, right: first.right }, barHeight: document.querySelector<HTMLElement>("[data-space-bar]")!.getBoundingClientRect().height };
    });
    console.info(`overflowing bar ${theme}: ${JSON.stringify(read)}`);
    expect(read.overflow).toBeGreaterThan(0);
    // The plus is whole, outside the group and inside the sidebar; the group ends before it.
    expect(read.plus.width).toBe(28);
    expect(read.plus.x).toBeGreaterThanOrEqual(read.groupRight);
    expect(read.plus.right).toBeLessThanOrEqual(read.sidebar.right);
    // The icon on screen is in view; the first one has scrolled out to the left and is not cut in half over the edge.
    expect(read.current.x).toBeGreaterThanOrEqual(read.groupLeft - 1);
    expect(read.current.right).toBeLessThanOrEqual(read.groupRight + 1);
    expect(read.first.right).toBeLessThanOrEqual(read.groupLeft + 1);
    expect(read.barHeight).toBe(28);
    await shot(`space-bar-overflow-${theme}`);
  }, 60_000);

  it.each(["dark", "light"] as const)("in the %s theme the sidebar follows the picker live: three presets, the grain at none and at most, the opacity at its least, and a pinned side", async theme => {
    await open(theme);
    await page!.locator("[data-space-icon][aria-label=api]").click({ button: "right" });
    await page!.waitForSelector("[data-context-menu]");
    await menuItem(WORKSPACE_WORDS.theme).click();
    await page!.waitForSelector("[data-theme-picker]");
    const gradients = new Set<string>();
    for (const preset of THEME_PRESETS.slice(0, 3)) {
      await page!.locator(`[data-theme-preset='${preset.id}']`).click();
      await page!.waitForFunction(id => document.querySelector(`[data-theme-preset='${id}']`)?.getAttribute("aria-pressed") === "true", preset.id);
      const read = await look();
      expect(read.gradient).toMatch(/gradient\(/);
      gradients.add(read.gradient);
      expect(await page!.locator("[data-theme-picker] [data-theme-dot]").count()).toBe(preset.dots.length);
      await shot(`preset-${preset.id}-${theme}`, "page");
    }
    expect(gradients.size).toBe(3);

    // The grain slider from the keyboard: End is the most, Home none; the tile's opacity follows the slider.
    const grain = page!.locator("[data-theme-picker] [data-theme-slider=grain] input[type=range]");
    expect((await look()).grain).toBe("0");
    await grain.focus();
    await page!.keyboard.press("End");
    await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-app-sidebar]")!).getPropertyValue("--space-grain").trim() === "1");
    expect((await look()).grain).toBe("1");
    expect(await page!.locator("[data-theme-slider=grain]").textContent()).toContain("100%");
    await shot(`grain-max-${theme}`, "page");
    await page!.keyboard.press("Home");
    await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-app-sidebar]")!).getPropertyValue("--space-grain").trim() === "0");
    await shot(`grain-none-${theme}`, "page");

    // The opacity slider at its least: the colour nearly leaves and the surface reads through.
    const opacity = page!.locator("[data-theme-picker] [data-theme-slider=opacity] input[type=range]");
    const full = (await look()).gradient;
    await opacity.focus();
    await page!.keyboard.press("Home");
    await page!.waitForFunction(full => getComputedStyle(document.querySelector("[data-app-sidebar] > [data-slot='sidebar-inner']")!).backgroundImage !== full, full);
    expect((await look()).gradient).toMatch(/rgba\(\d+, \d+, \d+, 0\.1\)/);
    expect(await page!.locator("[data-theme-slider=opacity]").textContent()).toContain("10%");
    await shot(`opacity-min-${theme}`, "page");
    await page!.keyboard.press("End");

    // A pinned side flips the sidebar's tokens whatever the app draws, and Auto hands them back.
    const other = theme === "dark" ? THEME_WORDS.mode.light : THEME_WORDS.mode.dark;
    const before = await look();
    await page!.locator("[data-theme-mode] [role=radio]").filter({ hasText: other }).click();
    await page!.waitForFunction(scheme => document.querySelector("[data-app-sidebar]")?.getAttribute("data-space-scheme") === scheme, other.toLowerCase());
    // The rows transition their colours over 150 ms; the reading waits that out so it sees the side landed on.
    await page!.waitForTimeout(300);
    const pinned = await look();
    expect(pinned.surfaceToken).not.toBe(before.surfaceToken);
    expect(pinned.ink).not.toBe(before.ink);
    expect(await page!.locator("[data-theme-mode] [role=radio][aria-checked=true]").textContent()).toBe(other);
    // The words follow the pinned side and stay readable on the colour itself, not only on the token under it: the
    // painted colour is the first stop laid over the surface token, and the header's name has to read on it at AA.
    // The opacity slider ends at the cap that keeps them there, so it cannot be pushed past.
    const painted = await page!.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>("[data-app-sidebar]")!;
      const inner = document.querySelector<HTMLElement>("[data-app-sidebar] > [data-slot=sidebar-inner]")!;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const bytes = (css: string): [number, number, number, number] => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
      };
      const stop = /rgba?\([^)]*\)/.exec(getComputedStyle(inner).backgroundImage)![0];
      const [r, g, b, a] = bytes(stop);
      const ground = bytes(getComputedStyle(inner).getPropertyValue("--sidebar"));
      const surface = [0, 1, 2].map(i => Math.round([r, g, b][i]! * a + ground[i]! * (1 - a))) as [number, number, number];
      const ink = (selector: string) => bytes(getComputedStyle(document.querySelector(selector)!).color).slice(0, 3) as [number, number, number];
      return { alpha: a, surface, name: ink("[data-space-name]"), search: ink("[data-search-row]"), sliderMax: document.querySelector("[data-theme-slider=opacity] input[type=range]")!.getAttribute("max"), scheme: sidebar.getAttribute("data-space-scheme") };
    });
    const lum = (c: [number, number, number]): number => { const f = (v: number) => { const u = v / 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a: [number, number, number], b: [number, number, number]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    console.info(`pinned ${other} on ${theme}: painted ${JSON.stringify(painted)}, name ${ratio(painted.name, painted.surface).toFixed(2)}, search ${ratio(painted.search, painted.surface).toFixed(2)}`);
    expect(ratio(painted.name, painted.surface)).toBeGreaterThanOrEqual(4.5);
    expect(Number(painted.sliderMax)).toBeLessThanOrEqual(1);
    expect(painted.alpha).toBeLessThanOrEqual(Number(painted.sliderMax) + 0.001);
    await shot(`pinned-${other.toLowerCase()}-on-${theme}`, "page");
    await page!.locator("[data-theme-mode] [role=radio]").filter({ hasText: THEME_WORDS.mode.auto }).click();
    await page!.waitForFunction(scheme => document.querySelector("[data-app-sidebar]")?.getAttribute("data-space-scheme") === scheme, theme);
    expect((await look()).surfaceToken).toBe(before.surfaceToken);
  }, 120_000);

  it("the rows scroll over the grain at most without dropping frames: the tile is one still layer under them", async () => {
    // The second space's theme carries grain already; the slider takes it to the most, then a short window makes
    // the four rows overflow so there is something to scroll.
    await open("dark", "&ws=ws_b&archived=1");
    await page!.locator("[data-space-icon][aria-label=web]").click();
    await page!.waitForFunction(() => document.querySelector("[data-app-sidebar]")?.getAttribute("data-space-scheme") === "dark");
    await page!.locator("[data-space-icon][aria-label=web]").click({ button: "right" });
    await page!.waitForSelector("[data-context-menu]");
    await menuItem(WORKSPACE_WORDS.theme).click();
    await page!.waitForSelector("[data-theme-picker]");
    await page!.locator("[data-theme-picker] [data-theme-slider=grain] input[type=range]").focus();
    await page!.keyboard.press("End");
    await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-app-sidebar]")!).getPropertyValue("--space-grain").trim() === "1");
    await page!.keyboard.press("Escape");
    await page!.waitForSelector("[data-theme-picker]", { state: "detached" });
    await page!.setViewportSize({ width: 1000, height: 320 });
    try {
      const measure = () =>
        page!.evaluate(
          () =>
            new Promise<{ frames: number; ms: number; overflow: number; longest: number }>(resolve => {
              const viewport = document.querySelector<HTMLElement>("[data-app-sidebar] [data-slot=scroll-area-viewport]")!;
              const overflow = viewport.scrollHeight - viewport.clientHeight;
              let frames = 0;
              let longest = 0;
              let last = performance.now();
              const start = last;
              const tick = (now: number): void => {
                frames++;
                longest = Math.max(longest, now - last);
                last = now;
                viewport.scrollTop = (frames * 7) % Math.max(1, overflow);
                if (now - start < 1000) requestAnimationFrame(tick);
                else resolve({ frames, ms: now - start, overflow, longest });
              };
              requestAnimationFrame(tick);
            }),
        );
      await page!.waitForFunction(() => {
        const viewport = document.querySelector<HTMLElement>("[data-app-sidebar] [data-slot=scroll-area-viewport]")!;
        return viewport.scrollHeight > viewport.clientHeight;
      });
      const withGrain = await measure();
      console.info(`scroll with grain at most: ${JSON.stringify(withGrain)}`);
      expect(withGrain.overflow).toBeGreaterThan(0);
      expect((await look()).grain).toBe("1");
      // Sixty frames a second is one every 16.7 ms; a dropped frame reads as a gap over 34 ms.
      expect(withGrain.frames / (withGrain.ms / 1000)).toBeGreaterThanOrEqual(55);
      expect(withGrain.longest).toBeLessThan(34);
      await shot("grain-scroll-dark");
    } finally {
      await page!.setViewportSize({ width: 1200, height: 800 });
    }
  }, 90_000);
});
