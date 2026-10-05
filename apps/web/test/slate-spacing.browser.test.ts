// SPDX-License-Identifier: AGPL-3.0-only
// The old design's spacing and tables, and the bar lists' switch, measured in Chromium since jsdom lays nothing out
// (the owner's word of 2026-10-05): reach check's spoo live traffic as its agent wrote it, at the panel's 400 px and
// widened to 640 and 960. A section stands 32 px from what is beside it and pieces 12; a table's header words sit on
// their columns, 11 px over the card; the log's last column ends on the card's right inset however wide the panel;
// and the bar lists' switch never moves the page. Like the other render tests it runs only when asked for
// (WSP_RENDER=1).
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { serveHarness, type Harness } from "./slate-render/serve";

if (renderSkipped !== undefined) console.info(`slate spacing render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the slate's spacing, tables and bar lists laid out in Chromium", () => {
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

  const open = async (width: number): Promise<Page> => {
    const page = await browser!.newPage({ viewport: { width: width + 40, height: 1200 } });
    await page.goto(`${harness!.base}?w=${width}`);
    await page.waitForSelector("[data-slate-bar-switch]");
    return page;
  };

  for (const width of [400, 640, 960]) {
    it(`spaces a section 32 px from what is beside it and pieces 12, at ${width}`, async () => {
      const page = await open(width);
      const gaps = await page.evaluate(() => {
        const kids = [...document.querySelector("[data-slate-group]")!.children].filter(k => k.getBoundingClientRect().height > 0);
        return kids.slice(1).map((k, i) => [k.getAttribute("data-slate-type") ?? "switch", Math.round(k.getBoundingClientRect().top - kids[i]!.getBoundingClientRect().bottom)]);
      });
      // The strip, the switch, then the log's section.
      expect(gaps).toEqual([["switch", 12], ["section", 32]]);
      await page.close();
    });

    it(`sets the log's header words on their columns 11 px over the card, its last column on the right inset, at ${width}`, async () => {
      const page = await open(width);
      const layout = await page.evaluate(() => {
        const box = (el: Element) => el.getBoundingClientRect();
        const text = (el: Element) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect();
        };
        const head = document.querySelector("[data-slate-head]")!;
        const card = head.nextElementSibling!;
        const heads = [...head.querySelectorAll("[role=columnheader]")];
        const cells = [...card.querySelector("[role=row]")!.querySelectorAll("[role=cell]")];
        return {
          gap: Math.round(box(card).top - Math.max(...heads.map(h => text(h).bottom))),
          offsets: heads.map((h, i) => (cells[i]!.className.includes("text-right") ? Math.round(box(h).right - box(cells[i]!).right) : Math.round(text(h).left - text(cells[i]!).left))),
          inset: Math.round(box(card).right - box(cells.at(-1)!).right),
          slack: [...cells].map(cell => Math.round(box(cell).width)).indexOf(Math.max(...cells.map(cell => Math.round(box(cell).width)))),
        };
      });
      expect(layout.gap).toBe(11);
      expect(layout.offsets).toEqual([0, 0, 0, 0, 0, 0]);
      // The card's 1 px border and its 16 px inset; the path, the third column, holds the slack.
      expect(layout.inset).toBe(17);
      expect(layout.slack).toBe(2);
      await page.close();
    });

    it(`keeps the bar lists' card and segments still across every switch and a value push, at ${width}`, async () => {
      const page = await open(width);
      const measure = () =>
        page.evaluate(() => {
          const sw = document.querySelector("[data-slate-bar-switch]")!;
          const card = sw.children[1]!.getBoundingClientRect();
          return {
            card: [Math.round(card.top), Math.round(card.height)],
            segments: [...sw.querySelectorAll("[data-segment]")].map(s => Math.round(s.getBoundingClientRect().width)),
            shown: [...sw.querySelectorAll("[data-slate-bar-list]")].filter(l => getComputedStyle(l).visibility === "visible").map(l => l.getAttribute("data-slate-bar-list")),
            page: Math.round(document.querySelector("[data-panel]")!.getBoundingClientRect().height),
          };
        });
      const first = await measure();
      expect(first.shown).toEqual(["countries"]);
      const segments = page.locator("[data-slate-bar-switch] [data-segment]");
      for (const [at, list] of ["countries", "codes", "routes", "links", "events"].entries()) {
        await segments.nth(at).click();
        const now = await measure();
        expect(now.shown).toEqual([list]);
        expect(now.card).toEqual(first.card);
        expect(now.segments).toEqual(first.segments);
        expect(now.page).toBe(first.page);
      }
      await page.evaluate(() => (window as unknown as { slateEngine: { applyValues(v: Record<string, unknown>, r: number): void } }).slateEngine.applyValues({ $events: [{ n: "request_completed", v: 4100 }] }, 9));
      await page.waitForTimeout(100);
      expect((await measure()).shown).toEqual(["events"]);
      await page.close();
    });
  }
});
