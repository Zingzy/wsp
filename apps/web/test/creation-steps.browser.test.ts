// SPDX-License-Identifier: AGPL-3.0-only
// The creating page in a real Chromium, at the desktop and the phone widths:
// unfolded, in flight and refused, the question stays and every step from the
// first stands whole in the room above it, none half under an edge; and when
// the create lands, the question and the composer stand where they stood. Vite serves test/wireframe to Playwright's
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
      it(`${screen} at ${width}: the question stays, and every step from the first stands whole in the room above it`, async () => {
        const page = await browser!.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
        await page.goto(`${vite!.base}/test/wireframe/index.html?screen=${screen}&theme=dark`);
        await page.locator("[data-k=setting-up]").click();
        const read = await page.evaluate(() => {
          const box = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
          const list = document.querySelector("ol[aria-label='Setting up']")!;
          const question = document.querySelector("[data-testid=workspace-creation] h1");
          return {
            scroller: box(list.parentElement!),
            room: box(list.parentElement!.parentElement!),
            steps: [...list.querySelectorAll("li")].map(box),
            buttons: [...document.querySelectorAll("[data-creation-refusal] button")].map(box),
            questionTop: question === null ? null : box(question.parentElement!).top,
          };
        });
        // A step is seen through the scroller that holds it; a refusal's buttons stand on its row, above the room.
        const cutBy = (edge: { top: number; bottom: number }) => (r: { top: number; bottom: number }) =>
          (r.top < edge.top - 0.5 && r.bottom > edge.top + 0.5) || (r.top < edge.bottom - 0.5 && r.bottom > edge.bottom + 0.5);
        const within = (edge: { top: number; bottom: number }) => (r: { top: number; bottom: number }) => r.top >= edge.top - 0.5 && r.bottom <= edge.bottom + 0.5;
        expect(read.steps.filter(cutBy(read.scroller))).toEqual([]);
        expect(read.steps[0]!.top).toBeGreaterThanOrEqual(read.scroller.top - 0.5);
        for (const b of read.buttons) expect(b.bottom).toBeLessThanOrEqual(read.room.top + 0.5);
        expect(read.steps.filter(within(read.scroller)).length).toBeGreaterThanOrEqual(3);
        expect(read.questionTop).not.toBeNull();
        expect(read.room.bottom).toBeLessThanOrEqual(read.questionTop!);
        await page.close();
      });
    }
  }

  for (const width of [1440, 390]) {
    it(`creating-refused at ${width}, unfolded on a five-step log: Retry and Dismiss stand whole on the Could not start row, never scrolled away`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
      await page.goto(`${vite!.base}/test/wireframe/index.html?screen=creating-refused&theme=dark`);
      await page.locator("[data-k=setting-up]").click();
      const read = await page.evaluate(() => {
        const box = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        const list = document.querySelector("ol[aria-label='Setting up']")!;
        const retry = [...document.querySelectorAll("button")].find(b => b.textContent === "Retry")!;
        const dismiss = [...document.querySelectorAll("button")].find(b => b.textContent === "Dismiss")!;
        // Whatever box scrolls the steps, the buttons are seen only where they sit inside it and inside the page.
        const clip = (el: Element): { top: number; bottom: number } => {
          let top = -Infinity, bottom = Infinity;
          for (let at = el.parentElement; at !== null; at = at.parentElement) {
            const style = getComputedStyle(at);
            if (style.overflowY !== "visible") { const r = at.getBoundingClientRect(); top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
          }
          return { top, bottom };
        };
        const row = document.querySelector("[data-k=setting-up]")!.getBoundingClientRect();
        return {
          steps: list.querySelectorAll("li").length,
          row: (row.top + row.bottom) / 2,
          buttons: [retry, dismiss].map(b => ({ ...box(b), clip: clip(b) })),
          questionTop: box(document.querySelector("[data-testid=workspace-creation] h1")!.parentElement!).top,
        };
      });
      expect(read.steps).toBeGreaterThanOrEqual(5);
      for (const b of read.buttons) {
        expect(Math.abs((b.top + b.bottom) / 2 - read.row)).toBeLessThanOrEqual(1);
        expect(b.top).toBeGreaterThanOrEqual(b.clip.top - 0.5);
        expect(b.bottom).toBeLessThanOrEqual(b.clip.bottom + 0.5);
        expect(b.bottom).toBeLessThanOrEqual(read.questionTop);
      }
      await page.close();
    });

    it(`creating-refused at ${width}, folded: the reason from its first word and both buttons stand whole above the question`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
      await page.goto(`${vite!.base}/test/wireframe/index.html?screen=creating-refused&theme=dark`);
      await page.locator("[data-creation-refusal]").waitFor();
      const read = await page.evaluate(() => {
        const box = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        const reason = document.querySelector("[data-creation-reason]")!;
        return {
          room: box(reason.parentElement!.parentElement!),
          reason: box(reason),
          buttons: [...document.querySelectorAll("[data-creation-refusal] button")].map(box),
          questionTop: box(document.querySelector("[data-testid=workspace-creation] h1")!.parentElement!).top,
        };
      });
      expect(read.reason.top).toBeGreaterThanOrEqual(read.room.top - 0.5);
      expect(read.reason.bottom).toBeLessThanOrEqual(read.room.bottom + 0.5);
      for (const b of read.buttons) expect(b.bottom).toBeLessThanOrEqual(read.room.top + 0.5);
      expect(read.room.bottom).toBeLessThanOrEqual(read.questionTop);
      await page.close();
    });

    it(`at ${width} the question and the composer stand where they stood across workspace.created`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
      await page.goto(`${vite!.base}/test/wireframe/index.html?screen=creating&theme=dark`);
      await page.locator("[data-testid=workspace-creation]").waitFor();
      const measure = () =>
        page.evaluate(() => {
          const box = (el: Element | null) => { if (el === null) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
          return { question: box(document.querySelector("h1")), composer: box(document.querySelector("[data-chat-composer-form]")), dock: box(document.querySelector("[data-chat-composer-dock]")) };
        });
      await page.waitForTimeout(300);
      const before = await measure();
      await page.evaluate(() => (window as unknown as { landCreate: () => void }).landCreate());
      await page.locator("[data-testid=workspace-creation]").waitFor({ state: "detached" });
      await page.waitForTimeout(300);
      const after = await measure();
      expect(before.question).not.toBeNull();
      expect(after).toEqual(before);
      await page.close();
    });
  }
});
