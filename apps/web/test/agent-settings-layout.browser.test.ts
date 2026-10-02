// SPDX-License-Identifier: AGPL-3.0-only
// The Agents page, an agent's own page and a project's New threads, drawn in a
// real Chromium at the window's 1280 and a phone's 390 in both themes, since
// jsdom lays nothing out: every row's words and control stand inside the row
// and the page never scrolls sideways. Each screen is photographed into the
// render folder under the temp dir to be held against the locked design. Runs only when asked for (WSP_RENDER=1) and skips without
// Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");

if (renderSkipped !== undefined) console.info(`agent settings render test skipped: ${renderSkipped}`);

/** Each screen by the card it waits on and the rows it must draw. */
const SCREENS = [
  { screen: "settings-agents", ready: "[data-agent-row='claude']", rows: ["default-agent", "claude", "codex", "opencode"] },
  { screen: "settings-agent", ready: "[data-settings-row='agent-env']", rows: ["agent-model", "agent-access", "agent-models", "agent-program", "agent-config", "agent-args", "agent-env"] },
  { screen: "settings-project-overrides", ready: "[data-settings-row='project-access']", rows: ["project-agent", "project-model", "project-access"] },
] as const;

describe.skipIf(renderSkipped !== undefined)("the agents settings pages in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let base = "";

  beforeAll(async () => {
    mkdirSync(SHOTS_DIR, { recursive: true });
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    base = `${vite.base}/test/wireframe/index.html`;
    browser = await launchRender();
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  /** The rows a screen draws, and every word or control that stands past its row's box, and how far the page scrolls
   * sideways. */
  const measure = (page: Page) =>
    page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("[data-settings-page]")!;
      const rows = [...root.querySelectorAll<HTMLElement>("[data-settings-row]")];
      return {
        ids: rows.map(row => row.dataset["settingsRow"] ?? ""),
        cut: rows.flatMap(row => {
          const box = row.getBoundingClientRect();
          return [...row.querySelectorAll<HTMLElement>("[data-settings-title], [data-settings-description], [data-settings-slot]")]
            .filter(el => {
              const b = el.getBoundingClientRect();
              return b.width > 0 && (b.left < box.left - 0.5 || b.right > box.right + 0.5);
            })
            .map(el => `${row.dataset["settingsRow"]}: ${el.textContent}`);
        }),
        sideways: root.scrollWidth - root.clientWidth,
      };
    });

  for (const sheet of ["env", "models"] as const) {
    for (const width of [1280, 390] as const) {
      it.each(["dark", "light"] as const)(`the ${sheet} sheet at ${width} in the %s theme stands inside the window`, async theme => {
        const page = await browser!.newPage({ viewport: { width, height: 900 } });
        try {
          await page.emulateMedia({ colorScheme: theme });
          await page.goto(`${base}?screen=settings-agent&theme=${theme}`);
          await page.click(`[data-k='agent-${sheet}-edit']`);
          const dialog = await page.waitForSelector(`[data-k='agent-${sheet}']`);
          const box = (await dialog.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
          await page.waitForTimeout(250);
          await page.screenshot({ path: join(SHOTS_DIR, `settings-agent-${sheet}-${width}-${theme}.png`), animations: "disabled" });
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }

  for (const { screen, ready, rows } of SCREENS) {
    for (const width of [1280, 390] as const) {
      it.each(["dark", "light"] as const)(`${screen} at ${width} in the %s theme stands whole`, async theme => {
        const page = await browser!.newPage({ viewport: { width, height: 900 } });
        try {
          await page.emulateMedia({ colorScheme: theme });
          await page.goto(`${base}?screen=${screen}&theme=${theme}`);
          await page.waitForSelector(ready);
          const got = await measure(page);
          expect(got.ids).toEqual(expect.arrayContaining([...rows]));
          expect(got.cut).toEqual([]);
          expect(got.sideways).toBeLessThanOrEqual(1);
          await page.screenshot({ path: join(SHOTS_DIR, `${screen}-${width}-${theme}.png`), fullPage: true, animations: "disabled" });
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }
});
