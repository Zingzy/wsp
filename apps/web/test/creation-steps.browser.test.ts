// SPDX-License-Identifier: AGPL-3.0-only
// The creating page's unfolded steps in a real Chromium, at the desktop and the
// phone widths, in flight and refused: every row from the first stands whole,
// none sits half under an edge, a phone still shows rows under a refusal, and
// nothing reaches the composer. Vite serves test/wireframe to Playwright's
// browser, so like the other layout tests this runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium on the machine.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (renderSkipped !== undefined) console.info(`creation steps render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the creating page's unfolded steps in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    browser = await launchRender();
  }, 120_000);
  afterAll(() => stopRender(browser, vite?.child));

  for (const screen of ["creating", "creating-refused"]) {
    for (const width of [1440, 390]) {
      it(`${screen} at ${width}: every row from the first whole, none cut, and clear of the composer`, async () => {
        const page = await browser!.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
        await page.goto(`${vite!.base}/test/wireframe/index.html?screen=${screen}&theme=dark`);
        await page.locator("[data-k=setting-up]").click();
        const read = await page.evaluate(() => {
          const list = document.querySelector("ol[aria-label='Setting up']")!.getBoundingClientRect();
          const rows = [...document.querySelectorAll("ol[aria-label='Setting up'] > li")].map(li => li.getBoundingClientRect());
          const dock = document.querySelector("[data-chat-composer-dock]")!.getBoundingClientRect();
          return {
            list: { top: list.top, bottom: list.bottom },
            rows: rows.map(r => ({ top: r.top, bottom: r.bottom })),
            dockTop: dock.top,
            question: document.querySelector("[data-testid=workspace-creation] h1") !== null,
          };
        });
        const whole = read.rows.filter(r => r.top >= read.list.top - 0.5 && r.bottom <= read.list.bottom + 0.5);
        const cut = read.rows.filter(r => r.top < read.list.bottom - 0.5 && r.bottom > read.list.bottom + 0.5);
        expect(cut).toEqual([]);
        expect(read.rows[0]!.top).toBeGreaterThanOrEqual(read.list.top - 0.5);
        expect(whole.length).toBeGreaterThanOrEqual(Math.min(read.rows.length, 3));
        expect(read.list.bottom).toBeLessThanOrEqual(read.dockTop);
        expect(read.question).toBe(false);
        await page.close();
      });
    }
  }
});
