// SPDX-License-Identifier: AGPL-3.0-only
// The layout faults a judge found across the matrix's screenshots, each held here in Chromium on the smallest slate that
// shows it (cases.ts), since jsdom lays nothing out. Like the other render tests it runs only when asked for
// (WSP_RENDER=1).
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { serveHarness, type Harness } from "./slate-render/serve";

if (renderSkipped !== undefined) console.info(`slate layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the slate's layout in Chromium", () => {
  let harness: Harness | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    harness = await serveHarness();
    browser = await launchRender();
  }, 120_000);
  afterAll(async () => {
    await stopRender(browser, undefined);
    harness?.stop();
  });

  const open = async (doc: string, w = 400): Promise<Page> => {
    const page = await browser!.newPage({ viewport: { width: w + 40, height: 900 } });
    await page.goto(`${harness!.base}?w=${w}&doc=${doc}`);
    await page.waitForSelector("[data-slate]");
    return page;
  };

  it("cuts neither a section's title nor its note: the note wraps beside a title that keeps every word", async () => {
    const page = await open("long-head");
    const heads = await page.evaluate(() =>
      ["retail", "folded"].map(id => {
        const head = document.querySelector(`[data-slate-piece="${id}"] [role=heading]`) as HTMLElement;
        const note = head.parentElement!.querySelector("[data-slate-section-note]") as HTMLElement;
        const line = parseFloat(getComputedStyle(note).lineHeight) || 20;
        return { title: head.textContent, titleCut: head.scrollWidth > head.clientWidth + 1, noteCut: note.scrollWidth > note.clientWidth + 1, noteLines: Math.round(note.getBoundingClientRect().height / line) };
      }),
    );
    expect(heads[0]).toMatchObject({ title: "Bengaluru retail", titleCut: false, noteCut: false });
    expect(heads[0]!.noteLines).toBeGreaterThan(1);
    expect(heads[1]).toMatchObject({ title: "Sources and how each is read", titleCut: false, noteCut: false });
    await page.close();
  });

  it("opens a chart's hover beside its line inside the plot, never over the legend or past the panel's edge", async () => {
    const page = await open("rate-chart");
    const points = page.locator('[data-slate-piece="rate"] [data-k=point]');
    for (const at of [0, 29]) {
      await points.nth(at).hover();
      const popup = page.locator("[data-slot=tooltip-popup]");
      await popup.waitFor();
      const box = await page.evaluate(() => {
        const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        const pop = r("[data-slot=tooltip-popup]");
        return { pop: { left: pop.left, right: pop.right, top: pop.top }, legend: r('[data-slate-piece="rate"] figcaption').bottom, panel: r("[data-panel]"), plot: r('[data-slate-piece="rate"] canvas') };
      });
      expect(box.pop.top, `point ${at}`).toBeGreaterThanOrEqual(box.legend);
      expect(box.pop.top, `point ${at}`).toBeGreaterThanOrEqual(box.plot.top - 1);
      expect(box.pop.left, `point ${at}`).toBeGreaterThanOrEqual(box.panel.left);
      expect(box.pop.right, `point ${at}`).toBeLessThanOrEqual(box.panel.right);
      await page.mouse.move(0, 0);
      await popup.waitFor({ state: "detached" });
    }
    await page.close();
  });
});
