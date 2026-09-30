// SPDX-License-Identifier: AGPL-3.0-only
// The image's build on a computer's page, in a real Chromium, at 1280 by 800
// and 390 by 844, in every build state the wireframe stages: a running build
// is its current stage and count on the IMAGE row and nothing more, and one
// that needs the person (a sign-in, a stop, a failure, a refused key) draws its
// whole view under the row in a box that scrolls on its own. Landing on the page
// and the stage changing under it leave the page's own scroller where it was.
// Runs only when asked for (WSP_RENDER=1) and skips without Playwright's
// Chromium.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (renderSkipped !== undefined) console.info(`image build layout render test skipped: ${renderSkipped}`);

/** Each staged build, with whether it stands in the box under the row or reads on the row alone. */
const SCREENS: [string, string, "row" | "box"][] = [
  ["settings-image-build", "", "row"],
  ["settings-image-build", "&advance=1", "row"],
  ["settings-image-signin", "", "box"],
  ["settings-image-build-sealing", "", "row"],
  ["settings-image-build-stopped", "", "box"],
  ["settings-image-build-failed", "", "box"],
  ["settings-image-build-key", "&computer=solari", "box"],
];
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

interface Layout {
  scrolled: string[];
  rowTop: number;
  note: string;
  box: { scrolls: boolean; overflowY: string; scrollTop: number; stages: number } | null;
}

/** Every ancestor of the IMAGE list that has scrolled, the row's top and note, and the box under it where it stands. */
const measure = (page: Page): Promise<Layout> =>
  page.evaluate(() => {
    const list = document.querySelector<HTMLElement>("[data-grid='image']")!;
    const scrolled: string[] = [];
    for (let el: HTMLElement | null = list; el !== null; el = el.parentElement) if (el.scrollTop !== 0) scrolled.push(`${el.tagName}[${el.getAttribute("data-k") ?? el.getAttribute("data-slot") ?? ""}] ${el.scrollTop}`);
    if (window.scrollY !== 0) scrolled.push(`window ${window.scrollY}`);
    const row = list.querySelector<HTMLElement>("[data-k='image-state']")!;
    const box = document.querySelector<HTMLElement>("[data-k='image-build-box']");
    return {
      scrolled,
      rowTop: row.getBoundingClientRect().top,
      note: row.querySelector("[data-grid-note]")?.textContent ?? "",
      box:
        box === null
          ? null
          : {
              scrolls: box.scrollHeight > box.clientHeight,
              overflowY: getComputedStyle(box).overflowY,
              scrollTop: box.scrollTop,
              stages: box.querySelectorAll("[data-k='build'] [data-k='card'] li[data-k='row'], [data-k='build'] [data-k='card'] li[data-k='signin']").length,
            },
    };
  });

describe.skipIf(renderSkipped !== undefined)("the image's build on a computer's page laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    browser = await launchRender();
    page = await browser.newPage({ viewport: { ...VIEWPORTS[0] } });
    await page.addInitScript(() => window.localStorage.clear());
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  for (const viewport of VIEWPORTS) {
    for (const [screen, extra, where] of SCREENS) {
      it(`${screen}${extra} at ${viewport.width}: ${where === "row" ? "the stage on the row and no box" : "the whole view in the box under the row"}, and the page never scrolls`, async () => {
        await page!.setViewportSize(viewport);
        await page!.goto(`${vite!.base}/test/wireframe/index.html?screen=${screen}&theme=dark${extra}`);
        await page!.waitForSelector("[data-grid='image'] [data-k='image-state']", { timeout: 15_000 });
        // The staged stage change lands 300 ms in; the page is read after it.
        await page!.waitForTimeout(700);
        const layout = await measure(page!);
        expect(layout.scrolled).toEqual([]);
        expect(layout.rowTop).toBeGreaterThanOrEqual(0);
        if (where === "row") {
          expect(layout.box).toBeNull();
          expect(layout.note).toMatch(extra === "&advance=1" ? /^Installing MCP servers, \d+ of \d+/ : /, \d+ of \d+/);
          return;
        }
        expect(layout.box).not.toBeNull();
        expect(layout.box!.stages).toBeGreaterThan(1);
        expect(layout.box!.scrollTop).toBe(0);
        // A view longer than the box is read by scrolling the box, never cut where the wheel cannot reach.
        if (layout.box!.scrolls) expect(layout.box!.overflowY).toBe("auto");
      }, 30_000);
    }
  }
});
