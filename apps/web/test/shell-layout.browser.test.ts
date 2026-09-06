// SPDX-License-Identifier: AGPL-3.0-only
// The shell's chrome in a real Chromium: the sidebar's brand lockup starts
// where the search box does, a thread row's title keeps its room at the
// default width, a status toast holds a long token inside its box, and
// collapsing the sidebar leaves the page header's left padding alone. Vite
// serves test/shell to Playwright's browser, so like the glyph test it runs
// only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium
// on the machine.
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startVite, stopRender, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
const browserPath = ((): string | undefined => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();
const hasBrowser = browserPath !== undefined && existsSync(browserPath);
const skipped = process.env["WSP_RENDER"] !== "1" ? "WSP_RENDER is not 1" : !hasBrowser ? "Playwright's Chromium is not installed" : undefined;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

if (skipped !== undefined) console.info(`shell layout render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the shell's chrome laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  async function open(theme: "dark" | "light"): Promise<void> {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-sidebar-row]");
  }
  const box = async (selector: string): Promise<Box> => {
    const b = await page!.locator(selector).first().boundingBox();
    if (!b) throw new Error(`${selector} has no box`);
    return b;
  };
  const paddingLeft = (selector: string): Promise<string> => page!.locator(selector).first().evaluate(el => getComputedStyle(el).paddingLeft);

  it("the brand lockup starts where the search box does, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const lockup = await box("[data-slot=sidebar-header] [role=img][aria-label=wsp]");
      const search = await box("[data-slot=input-control]:has(input[aria-label='Search threads'])");
      expect(Math.abs(lockup.x - search.x)).toBeLessThan(1);
      const path = join(SHOTS_DIR, `sidebar-header-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar header screenshot: ${path}`);
    }
  }, 30_000);

  it("a thread row keeps twelve characters of a long title at the default width, the agent and opener whole under it, rows one height", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const rows = await page!.locator("[data-row-id^='thread:']").evaluateAll(els =>
        els.map(el => {
          const title = el.querySelector<HTMLElement>("[data-thread-title]");
          const meta = el.querySelector<HTMLElement>("[data-thread-meta]");
          if (!title || !meta) return null;
          const font = getComputedStyle(title);
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
          return {
            height: el.getBoundingClientRect().height,
            titleWidth: title.clientWidth,
            twelveChars: ctx.measureText((title.textContent ?? "").slice(0, 12)).width,
            metaClipped: [meta, ...meta.querySelectorAll("*")].some(e => e.scrollWidth > e.clientWidth),
            meta: `${meta.textContent ?? ""} (${meta.querySelector("[data-thread-provenance]")?.getAttribute("aria-label")})`,
          };
        }),
      );
      console.info(`thread rows at ${theme}: ${JSON.stringify(rows)}`);
      expect(rows.map(r => r?.meta)).toEqual(["Working·you (Claude Code · you)", "cli (Claude Code · cli)"]);
      for (const row of rows) {
        expect(row!.titleWidth).toBeGreaterThanOrEqual(row!.twelveChars);
        expect(row!.metaClipped).toBe(false);
      }
      expect(new Set(rows.map(r => r!.height)).size).toBe(1);
      const path = join(SHOTS_DIR, `sidebar-threads-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar thread rows screenshot: ${path}`);
    }
  }, 30_000);

  it("a status toast with a 200-character token stays inside the sidebar's width, in both themes", async () => {
    const token = "ZGVza3RvcC1wb29s".repeat(13).slice(0, 200);
    const toast = encodeURIComponent(`Stopped the builder ${token} to make room at the machine cap.`);
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&toast=${toast}`);
      const status = page!.locator("[data-slot=sidebar-footer] [role=status]").first();
      await status.waitFor();
      const sidebar = await box("[data-slot=sidebar]");
      const b = await box("[data-slot=sidebar-footer] [role=status]");
      expect(b.x).toBeGreaterThanOrEqual(sidebar.x);
      expect(b.x + b.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
      expect(await status.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      const path = join(SHOTS_DIR, `sidebar-toast-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar toast screenshot: ${path}`);
    }
  }, 30_000);

  it("collapsing the sidebar leaves the page header's left padding alone", async () => {
    await open("dark");
    const before = await paddingLeft("header");
    await page!.locator("header button[aria-label='Toggle main sidebar']").click();
    await page!.waitForSelector("[data-sidebar-state=collapsed]");
    // The header animates padding-left; let a 200 ms transition run out.
    await page!.waitForTimeout(400);
    expect(await paddingLeft("header")).toBe(before);
  }, 30_000);
});
