// SPDX-License-Identifier: AGPL-3.0-only
// A computer's grid row, measured in a real Chromium at the 390 px sheet in
// both themes, since jsdom lays nothing out: every cell that stands at that
// width stands wholly inside the row, the cores and memory having given way
// and the state cell kept, on the Computers list; and a computer's Levels deep
// row standing whole in its card, its words read at AA. Runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (renderSkipped !== undefined) console.info(`computer row render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("a computer's row at 390", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    base = `${vite.base}/test/wireframe/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  /** Every grid row under `scope` with a cell that stands past the row's own box, and how many cells stand. */
  const cut = (scope: string) =>
    page!.evaluate(scope => {
      const rows = [...document.querySelectorAll<HTMLElement>(`${scope} [data-grid-row][data-place-row]`)];
      return {
        rows: rows.length,
        standing: rows.map(row => [...row.children].filter(cell => getComputedStyle(cell).display !== "none").length),
        states: rows.map(row => {
          const cell = row.querySelector<HTMLElement>("[data-state-cell]");
          return cell === null || getComputedStyle(cell).display === "none" ? "" : "shown";
        }),
        cut: rows.flatMap(row => {
          const box = row.getBoundingClientRect();
          return [...row.children]
            .filter(cell => getComputedStyle(cell).display !== "none")
            .filter(cell => {
              const b = cell.getBoundingClientRect();
              return b.top < box.top || b.bottom > box.bottom || b.left < box.left - 0.5 || b.right > box.right + 0.5;
            })
            .map(cell => `${row.dataset["placeRow"]}: ${cell.textContent}`);
        }),
      };
    }, scope);

  it.each(["dark", "light"] as const)("in the %s theme every row on the Computers list stands whole with its name, one load, its state cell and the chevron", async theme => {
    await page!.emulateMedia({ colorScheme: theme });
    await page!.goto(`${base}?screen=settings-computers&theme=${theme}`);
    await page!.waitForSelector("[data-settings-card='computers'] [data-place-row]");
    const got = await cut("[data-settings-page]");
    expect(got.rows).toBeGreaterThan(0);
    expect(new Set(got.standing)).toEqual(new Set([4]));
    expect(got.states.filter(state => state === "")).toEqual([]);
    expect(got.cut).toEqual([]);
  }, 60_000);

  it.each(["dark", "light"] as const)("in the %s theme at 390 each computer's version fact stands whole, broken between its parts at most and never inside one", async theme => {
    await page!.emulateMedia({ colorScheme: theme });
    await page!.goto(`${base}?screen=settings-computers&theme=${theme}`);
    await page!.waitForSelector("[data-settings-page] [data-grid-fact]");
    const lines = await page!.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-grid-fact] [data-version-part]")].map(el => el.getClientRects().length),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines)).toEqual(new Set([1]));
    // And nothing of it is cut off: its box holds all it says.
    const cut = await page!.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-grid-fact]")].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent));
    expect(cut).toEqual([]);
  }, 60_000);

  it.each(["dark", "light"] as const)("in the %s theme a computer's Levels deep row stands whole in its card under the agents switch, its words at AA", async theme => {
    await page!.emulateMedia({ colorScheme: theme });
    await page!.goto(`${base}?screen=settings-computer&theme=${theme}`);
    const row = "[data-settings-card='computer-spawn'] [data-settings-row='levels-deep']";
    await page!.waitForSelector(row);
    const got = await page!.evaluate(row => {
      const el = document.querySelector<HTMLElement>(row)!;
      const card = el.closest<HTMLElement>("[data-settings-card]")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const stepper = el.querySelector<HTMLElement>("[data-k='levels-deep']")!.getBoundingClientRect();
      const inside = (b: DOMRect, o: DOMRect): boolean => b.left >= o.left - 0.5 && b.right <= o.right + 0.5 && b.top >= o.top - 0.5 && b.bottom <= o.bottom + 0.5;
      const above = document.querySelector<HTMLElement>("[data-settings-row='agents-start-agents']")!.getBoundingClientRect();
      return { title: el.querySelector("[data-settings-title]")?.textContent, value: el.querySelector("[data-k='levels-deep-value']")?.textContent, inCard: inside(box, card), stepperInRow: inside(stepper, box), under: box.top >= above.bottom - 0.5 };
    }, row);
    expect(got).toEqual({ title: "Levels deep", value: "2", inCard: true, stepperInRow: true, under: true });
    for (const ratio of await textContrast(page!, `${row} [data-settings-title], ${row} [data-settings-description], ${row} [data-k='levels-deep-value']`)) expect(ratio).toBeGreaterThanOrEqual(4.5);
  }, 60_000);

  it.each(["dark", "light"] as const)("in the %s theme at 1440 every list's heads stand over their own values in one style, a cloud's Machines over its count, and no head is blank", async theme => {
    await page!.setViewportSize({ width: 1440, height: 900 });
    await page!.emulateMedia({ colorScheme: theme });
    await page!.goto(`${base}?screen=settings-computers&theme=${theme}`);
    await page!.waitForSelector("[data-grid=clouds] [data-place-row]");
    const got = await page!.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-grid]")].map(grid => {
        const head = [...grid.querySelectorAll<HTMLElement>("[data-grid-head] > *")];
        const rows = [...grid.querySelectorAll<HTMLElement>("[data-grid-row]")];
        const style = (el: HTMLElement) => { const cs = getComputedStyle(el); return `${cs.fontSize} ${cs.fontWeight} ${Math.round(el.getBoundingClientRect().bottom)}`; };
        return {
          id: grid.dataset["grid"],
          blank: head.filter(cell => (cell.textContent ?? "").trim() === "").length,
          styles: [...new Set(head.map(style))],
          // Each right-aligned head's right edge, against the right edge of every value under it, by its data-k.
          off: head
            .filter(cell => getComputedStyle(cell).textAlign === "right")
            .flatMap(cell => {
              const right = cell.getBoundingClientRect().right;
              const k = { Cores: "cores", Memory: "memory", Threads: "threads", Machines: "machines" }[cell.textContent ?? ""];
              return rows.map(row => row.querySelector<HTMLElement>(`[data-k=${k}]`)).filter(v => v !== null).map(v => Math.abs(v!.getBoundingClientRect().right - right)).filter(gap => gap > 1);
            }),
        };
      }),
    );
    expect(got.map(g => g.id)).toEqual(["computers", "clouds"]);
    for (const grid of got) {
      expect(grid.blank).toBe(0);
      expect(grid.styles).toHaveLength(1);
      expect(grid.off).toEqual([]);
    }
    await page!.setViewportSize({ width: 390, height: 844 });
  }, 60_000);
});
