// SPDX-License-Identifier: AGPL-3.0-only
// A computer's grid row, measured in a real Chromium at the 390 px sheet in
// both themes, since jsdom lays nothing out: every cell that stands at that
// width stands wholly inside the row, the cores and memory having given way
// and the state kept, on the Computers list and under Add a computer once a
// box has joined. Runs only when asked for (WSP_RENDER=1) and skips without
// Playwright's Chromium.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
          return cell === null || getComputedStyle(cell).display === "none" ? "" : (cell.textContent ?? "");
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

  it.each(["dark", "light"] as const)("in the %s theme the joined box's row under Add a computer stands whole", async theme => {
    await page!.emulateMedia({ colorScheme: theme });
    await page!.goto(`${base}?screen=settings-add-joined&theme=${theme}`);
    await page!.waitForSelector("[data-k='road-ssh'] [data-k='joined'] [data-place-row]");
    const got = await cut("[data-k='joined']");
    expect(got.rows).toBe(1);
    expect(got.cut).toEqual([]);
  }, 60_000);

  it.each(["dark", "light"] as const)("in the %s theme every row on the Computers list stands whole with its name, one load, its state and the chevron", async theme => {
    await page!.emulateMedia({ colorScheme: theme });
    await page!.goto(`${base}?screen=settings-computers&theme=${theme}`);
    await page!.waitForSelector("[data-settings-card='computers'] [data-place-row]");
    const got = await cut("[data-settings-page]");
    expect(got.rows).toBeGreaterThan(0);
    expect(new Set(got.standing)).toEqual(new Set([4]));
    expect(got.states.filter(state => state === "")).toEqual([]);
    expect(got.cut).toEqual([]);
  }, 60_000);
});
