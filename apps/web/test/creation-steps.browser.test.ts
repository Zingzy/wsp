// SPDX-License-Identifier: AGPL-3.0-only
// The creating page in a real Chromium, at the desktop and the phone widths:
// in flight and refused, no question stands on it, the setup's card stands
// whole in the middle of the room above the composer, and the composer is
// docked at the foot of the pane as in a conversation. Vite serves
// test/wireframe to Playwright's browser, so like the other layout tests this
// runs only when asked for (WSP_RENDER=1) and skips without Playwright's
// Chromium on the machine.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (renderSkipped !== undefined) console.info(`creation steps render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the creating page in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    browser = await launchRender();
  }, 120_000);
  afterAll(() => stopRender(browser, vite?.child));

  for (const screen of ["creating", "creating-refused"]) {
    for (const width of [1440, 390]) {
      it(`${screen} at ${width}: no question, the setup's card whole in the middle of the room, the composer at the pane's foot`, async () => {
        const page = await browser!.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
        await page.goto(`${vite!.base}/test/wireframe/index.html?screen=${screen}&theme=dark`);
        await page.locator("[data-settings-card=setting-up]").waitFor();
        await page.waitForTimeout(200);
        const read = await page.evaluate(() => {
          const box = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
          const pane = document.querySelector("[data-testid=workspace-creation]")!;
          return {
            question: pane.querySelector("h1") !== null,
            pane: box(pane),
            room: box(pane.querySelector("[data-k=setting-up-room]")!),
            card: box(pane.querySelector("[data-settings-card=setting-up]")!),
            dock: box(pane.querySelector("[data-chat-composer-dock]")!),
            form: box(pane.querySelector("[data-chat-composer-form]")!),
            buttons: [...pane.querySelectorAll("[data-settings-card=setting-up] button")].map(box),
          };
        });
        expect(read.question).toBe(false);
        // The composer is the foot of the pane and the room ends on it.
        expect(Math.abs(read.dock.bottom - read.pane.bottom)).toBeLessThanOrEqual(1);
        expect(Math.abs(read.room.bottom - read.dock.top)).toBeLessThanOrEqual(1);
        // The card stands whole inside the room, its middle at the room's middle, give or take the room's own padding.
        expect(read.card.top).toBeGreaterThanOrEqual(read.room.top - 0.5);
        expect(read.card.bottom).toBeLessThanOrEqual(read.room.bottom + 0.5);
        expect(read.card.left).toBeGreaterThanOrEqual(read.room.left - 0.5);
        expect(read.card.right).toBeLessThanOrEqual(read.room.right + 0.5);
        expect(Math.abs((read.card.top + read.card.bottom) / 2 - (read.room.top + read.room.bottom) / 2)).toBeLessThanOrEqual(24);
        // The card stands in the conversation's column: the composer's width, edge to edge.
        expect(Math.abs(read.card.left - read.form.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(read.card.right - read.form.right)).toBeLessThanOrEqual(1);
        for (const b of read.buttons) {
          expect(b.top).toBeGreaterThanOrEqual(read.card.top - 0.5);
          expect(b.bottom).toBeLessThanOrEqual(read.card.bottom + 0.5);
        }
        if (screen === "creating-refused") expect(read.buttons.length).toBe(2);
        await page.close();
        // The first page vite serves waits on its dependency prebundle.
      }, 60_000);
    }
  }

  for (const width of [1440, 390]) {
    it(`at ${width} the composer stands where it stood across workspace.created, under the finished setup card`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
      await page.goto(`${vite!.base}/test/wireframe/index.html?screen=creating&theme=dark`);
      await page.locator("[data-testid=workspace-creation]").waitFor();
      const measure = () =>
        page.evaluate(() => {
          const r = document.querySelector("[data-chat-composer-form]")!.getBoundingClientRect();
          return {
            composer: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
            card: document.querySelector("[data-settings-card=setting-up]") !== null,
            question: document.querySelector("h1") !== null,
            steps: [...document.querySelectorAll("[data-step-row]")].map(row => row.getAttribute("data-state")),
          };
        });
      await page.waitForTimeout(300);
      const before = await measure();
      await page.evaluate(() => (window as unknown as { landCreate: () => void }).landCreate());
      await page.locator("[data-testid=workspace-creation]").waitFor({ state: "detached" });
      // Past the dock's own glide, so a composer that moves is caught where it lands.
      await page.waitForTimeout(600);
      const after = await measure();
      expect(after.composer).toEqual(before.composer);
      expect(after.card).toBe(true);
      expect(after.question).toBe(false);
      expect(new Set(after.steps)).toEqual(new Set(["done"]));
      await page.close();
    }, 60_000);
  }
});
