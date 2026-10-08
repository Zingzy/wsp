// SPDX-License-Identifier: AGPL-3.0-only
// Each chart kind past one line, and the diagram tinted by shape, drawn from the slate text an agent writes at the
// panel's two widths in graphite and paper: no mark of a piece may sit past the piece's own box. With SLATE_VIZ_OUT set
// each case is also shot into that folder. Like the other render tests it runs only when asked for (WSP_RENDER=1).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { serveHarness, type Harness } from "./slate-render/serve";

if (renderSkipped !== undefined) console.info(`slate viz render test skipped: ${renderSkipped}`);

const OUT = process.env["SLATE_VIZ_OUT"];
/** Each case of slate-render/viz.ts by the kind it shows, and the piece id it draws. */
const KINDS: ReadonlyArray<{ kind: string; doc: string; id: string }> = [
  { kind: "multi-line", doc: "viz-lines", id: "lat" },
  { kind: "stacked-area", doc: "viz-stacked", id: "status" },
  { kind: "donut", doc: "viz-donut", id: "countries" },
  { kind: "timeline-ci", doc: "viz-timeline-ci", id: "ci" },
  { kind: "timeline-deploy", doc: "viz-timeline-deploy", id: "deploy" },
  { kind: "treemap", doc: "viz-treemap", id: "bundle" },
  { kind: "diagram-tinted", doc: "viz-diagram", id: "flow" },
];

describe.skipIf(renderSkipped !== undefined)("the slate's chart kinds in Chromium", () => {
  let harness: Harness | undefined;
  let browser: Browser | undefined;
  beforeAll(async () => {
    harness = await serveHarness();
    browser = await launchRender();
    if (OUT !== undefined) mkdirSync(OUT, { recursive: true });
  }, 120_000);
  afterAll(async () => {
    await stopRender(browser, undefined);
    harness?.stop();
  });

  // A start written in unix seconds reads as January 1970 beside an ISO end; ticks on a fixed step ran the renderer
  // out of heap there, and a two-day span drew 25 clock words into a 200 px track.
  for (const { doc, id } of [{ doc: "viz-timeline-seconds", id: "secs" }, { doc: "viz-timeline-days", id: "days" }, { doc: "viz-timeline-ci", id: "ci" }])
    it(`${doc} draws at most four clock words, none over another`, async () => {
      const page = await browser!.newPage({ viewport: { width: 440, height: 1000 } });
      try {
        await page.goto(`${harness!.base}?w=400&doc=${doc}`);
        await page.waitForSelector(`[data-slate-piece="${id}"] [data-slate-span]`, { timeout: 10_000 });
        const clock = page.locator(`[data-slate-piece="${id}"] [data-slate-timeline] > div > span.relative.h-4 > span`);
        const words = await clock.allTextContents();
        expect(words.length, words.join(" ")).toBeGreaterThan(0);
        expect(words.length, words.join(" ")).toBeLessThanOrEqual(4);
        const boxes = (await Promise.all((await clock.all()).map(w => w.boundingBox()))).map(b => b!).sort((a, b) => a.x - b.x);
        expect(boxes.slice(1).filter((b, i) => b.x < boxes[i]!.x + boxes[i]!.width + 4), words.join(" ")).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);

  it("folds a donut of six parts to five and Other, every segment and swatch in a colour the browser takes", async () => {
    const page = await browser!.newPage({ viewport: { width: 440, height: 1000 } });
    try {
      await page.goto(`${harness!.base}?w=400&doc=viz-donut-six`);
      await page.waitForSelector('[data-slate-piece="six"] [data-slate-part]');
      const drawn = await page.evaluate(() => {
        const piece = document.querySelector('[data-slate-piece="six"]')!;
        return {
          names: [...piece.querySelectorAll("[data-slate-part]")].map(li => li.querySelector(".truncate")?.textContent),
          inks: [...piece.querySelectorAll<SVGCircleElement>("svg circle[stroke-dasharray]")].map(c => c.style.stroke).concat([...piece.querySelectorAll<HTMLElement>("[data-slate-part] > span:first-child")].map(s => s.style.background)),
        };
      });
      expect(drawn.names).toEqual(["India", "United States", "Brazil", "Germany", "Indonesia", "Other"]);
      expect(drawn.inks).toHaveLength(12);
      expect(await page.evaluate(inks => inks.filter(ink => !CSS.supports("color", ink)), drawn.inks)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  for (const { kind, doc, id } of KINDS)
    for (const w of [400, 640])
      for (const theme of ["graphite", "paper"])
        it(`${kind} at ${w} in ${theme} keeps every mark inside its box`, async () => {
          const page = await browser!.newPage({ viewport: { width: w + 40, height: 1000 }, deviceScaleFactor: OUT === undefined ? 1 : 2, reducedMotion: "reduce" });
          try {
            await page.goto(`${harness!.base}?w=${w}&doc=${doc}&theme=${theme}`);
            await page.waitForSelector(`[data-slate-piece="${id}"]`);
            if (kind.startsWith("diagram")) await page.waitForSelector(`[data-slate-piece="${id}"] [data-mermaid] svg g.node`, { timeout: 15_000 });
            else await page.waitForSelector(`[data-slate-piece="${id}"] svg, [data-slate-piece="${id}"] [data-slate-tile], [data-slate-piece="${id}"] [data-slate-span]`);
            await page.waitForTimeout(300);
            const found = await page.evaluate(pieceId => {
              const piece = document.querySelector(`[data-slate-piece="${pieceId}"]`)!;
              const box = piece.getBoundingClientRect();
              // A frame that clips, the diagram's zoom frame, is a mark itself; what it holds cannot paint past it.
              const clipped = (el: Element): boolean => {
                for (let up = el.parentElement; up !== null && up !== piece; up = up.parentElement) if (getComputedStyle(up).overflow !== "visible") return true;
                return false;
              };
              const marks = [...piece.querySelectorAll("*")].filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !clipped(el);
              });
              const out = marks
                .map(el => ({ el, r: el.getBoundingClientRect() }))
                .filter(({ r }) => r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)
                .map(({ el, r }) => `${el.tagName.toLowerCase()}${el.getAttribute("data-slate-tile") !== null ? "[tile]" : ""} "${(el.textContent ?? "").trim().slice(0, 24)}" ${Math.round(r.left - box.left)}..${Math.round(r.right - box.left)} of ${Math.round(box.width)}`);
              return { marks: marks.length, out };
            }, id);
            if (OUT !== undefined) await page.locator("[data-panel]").screenshot({ path: join(OUT, `${kind}-${w}-${theme}.png`) });
            expect(found.marks, "marks drawn").toBeGreaterThan(5);
            expect(found.out).toEqual([]);
          } finally {
            await page.close();
          }
        }, 30_000);
});
