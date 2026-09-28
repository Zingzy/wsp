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
            room: box(list.parentElement!),
            rows: [...list.querySelectorAll("li"), ...document.querySelectorAll("[data-creation-refusal] button")].map(box),
            questionTop: question === null ? null : box(question.parentElement!).top,
          };
        });
        const cut = read.rows.filter(r => (r.top < read.room.top - 0.5 && r.bottom > read.room.top + 0.5) || (r.top < read.room.bottom - 0.5 && r.bottom > read.room.bottom + 0.5));
        const whole = read.rows.filter(r => r.top >= read.room.top - 0.5 && r.bottom <= read.room.bottom + 0.5);
        expect(cut).toEqual([]);
        expect(whole.length).toBeGreaterThanOrEqual(3);
        expect(read.questionTop).not.toBeNull();
        expect(read.room.bottom).toBeLessThanOrEqual(read.questionTop!);
        await page.close();
      });
    }
  }

  for (const width of [1440, 390]) {
    it(`creating-refused at ${width}, folded: the reason from its first word and both buttons stand whole above the question`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
      await page.goto(`${vite!.base}/test/wireframe/index.html?screen=creating-refused&theme=dark`);
      await page.locator("[data-creation-refusal]").waitFor();
      const read = await page.evaluate(() => {
        const box = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        const refusal = document.querySelector("[data-creation-refusal]")!;
        return {
          room: box(refusal.parentElement!),
          reason: box(refusal.querySelector("p")!),
          buttons: [...refusal.querySelectorAll("button")].map(box),
          questionTop: box(document.querySelector("[data-testid=workspace-creation] h1")!.parentElement!).top,
        };
      });
      expect(read.reason.top).toBeGreaterThanOrEqual(read.room.top - 0.5);
      for (const b of read.buttons) expect(b.bottom).toBeLessThanOrEqual(read.room.bottom + 0.5);
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
