// SPDX-License-Identifier: AGPL-3.0-only
// The workspace pane's one rule, measured in a real Chromium at both allowed
// windows and in both themes, since jsdom lays nothing out: every value in the
// pane ends 20 px from the panel's edge, clear of the scroll bar. The settings
// region and the one-field sheet are measured in the wireframe render test.
// Runs only when asked for (WSP_RENDER=1) and skips without Playwright's
// Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(tmpdir(), "wsp-render");
/** The window's default and its smallest, the two the spec allows a judge to photograph. */
const WINDOWS = [
  { name: "1280 by 800", width: 1280, height: 800 },
  { name: "1024 by 700", width: 1024, height: 700 },
] as const;
/** The inset every pane row leaves at the right, which the 6 px scroll bar rides inside. */
const PANE_RIGHT_INSET = 20;

if (renderSkipped !== undefined) console.info(`pane render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the workspace pane", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const open = async (window: { width: number; height: number }, query: string): Promise<Page> => {
    await page?.close();
    page = await browser!.newPage({ viewport: { width: window.width, height: window.height } });
    await page.goto(`${base}?${query}`);
    return page;
  };
  const box = async (selector: string) => page!.locator(selector).first().evaluate(el => {
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) };
  });
  it.each(WINDOWS.flatMap(w => (["dark", "light"] as const).map(theme => ({ ...w, theme }))))(
    "at $name in the $theme theme every pane value ends 20 px from the panel's edge",
    async window => {
      await open(window, `theme=${window.theme}&ws=ws_a&panel=machine&places=1`);
      await page!.waitForSelector("[data-k=state]");
      const panel = await box("[data-preview-panel-mode]");
      const values = await page!.locator("[data-k=state], [data-k=where], [data-k=size], [data-k=machine-id]").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().right)));
      console.info(`pane at ${window.name} ${window.theme}: panel right ${panel.right}, values end ${values.join(", ")}`);
      expect(values.length).toBeGreaterThan(2);
      for (const right of values) expect(panel.right - right).toBeGreaterThanOrEqual(PANE_RIGHT_INSET);
      // The rows' own box stops at the inset; the hairlines under them still run edge to edge.
      const section = await page!.locator("[data-k=state]").evaluate(el => {
        const row = el.closest("section")!;
        const b = row.getBoundingClientRect();
        return { right: Math.round(b.right), padding: getComputedStyle(row).paddingRight, left: getComputedStyle(row).paddingLeft };
      });
      expect(section.padding).toBe("20px");
      expect(section.left).toBe("12px");
      expect(section.right).toBe(panel.right);
      await page!.screenshot({ path: join(SHOTS, `pane-inset-${window.width}-${window.theme}.png`) });
    },
    60_000,
  );

});
