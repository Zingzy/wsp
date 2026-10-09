// SPDX-License-Identifier: AGPL-3.0-only
// A sub-thread's tile in the Needs you inbox, in a real Chromium: the
// project's glyph keeps its slot with the "↳" on its top right corner, read off
// the pixels with the glyph alone, the mark alone and neither, so a mark drawn
// over the glyph's own strokes, which a person cannot see, fails here; a
// top-level thread's tile draws no mark. Every wait has a limit under the
// case's, so a stall names itself. Like the other render tests it runs only when
// asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`tile marks render test skipped: ${renderSkipped}`);

const CHILD = "[data-row-id='inbox:thread:s16']";
const TOP = "[data-row-id='thread:s17']";

/** The longest any one wait in a case may take, well under the case's own 20 s. */
const WAIT_MS = 8_000;

/** A page call Playwright puts no limit on, given one that names it. */
const within = <T>(what: string, call: Promise<T>): Promise<T> =>
  Promise.race([call, new Promise<never>((_, fail) => setTimeout(() => fail(new Error(`${what} took over ${WAIT_MS} ms`)), WAIT_MS).unref())]);

/** Which of the slot's two parts a shot leaves standing. */
type Shown = "both" | "glyph" | "mark" | "none";

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

describe.skipIf(renderSkipped !== undefined)("a sub-thread's mark in the Needs you inbox, in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
    page.setDefaultTimeout(WAIT_MS);
    mkdirSync(SHOTS, { recursive: true });
    // Vite bundles the page's imports on the first load, which takes longer than a case may.
    await page.goto(`${base}?inbox=box`, { timeout: 60_000 });
    await page.waitForSelector(CHILD, { timeout: 60_000 });
  }, 90_000);

  afterAll(() => stopRender(browser, vite?.child));

  /** The slot photographed with only some of its parts drawn, each device pixel as one rgb number. */
  const shot = async (shown: Shown): Promise<number[][]> => {
    const slot = page!.locator(`${CHILD} [data-tile-started-by]`);
    await slot.evaluate((el, show) => {
      const [glyph, mark] = [el.children[0] as SVGElement, el.children[1] as SVGElement];
      glyph.style.visibility = show === "both" || show === "glyph" ? "" : "hidden";
      mark.style.visibility = show === "both" || show === "mark" ? "" : "hidden";
    }, shown);
    const box = (await slot.boundingBox())!;
    const png = await page!.screenshot({ clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 }, animations: "disabled" });
    return within(`reading the ${shown} shot's pixels`, page!.evaluate(async data => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = [img.width, img.height];
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { data: px, width, height } = ctx.getImageData(0, 0, img.width, img.height);
      return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => px[(y * width + x) * 4]! * 65536 + px[(y * width + x) * 4 + 1]! * 256 + px[(y * width + x) * 4 + 2]!));
    }, png.toString("base64")));
  };

  /** Where a shot differs from the empty slot by more than antialiasing's dust. */
  const inkOf = (shown: number[][], empty: number[][]): boolean[][] =>
    shown.map((row, y) =>
      row.map((rgb, x) => {
        const bg = empty[y]![x]!;
        const channel = (s: number) => Math.abs(((rgb >> s) & 255) - ((bg >> s) & 255));
        return Math.max(channel(16), channel(8), channel(0)) > 24;
      }),
    );

  const cases = (["box", "folder", "terminal", "rocket"] as const).flatMap(glyph => (["dark", "light"] as const).map(theme => [glyph, theme] as const));

  it.each(cases)("a sub-thread's mark on the %s glyph in the %s theme stands clear of the glyph's ink, on its top right, in the muted ink", async (glyph, theme) => {
    await page!.goto(`${base}?inbox=${glyph}&theme=${theme}`);
    await page!.waitForSelector(`${CHILD} [data-tile-started-by]`);
    await page!.mouse.move(1400, 880);

    const empty = await shot("none");
    const glyphInk = inkOf(await shot("glyph"), empty);
    const mark = inkOf(await shot("mark"), empty);
    await shot("both");
    await page!.locator(CHILD).screenshot({ path: join(SHOTS, `tile-marks-${glyph}-${theme}.png`) });

    const count = (grid: boolean[][]) => grid.flat().filter(Boolean).length;
    // Each part draws on its own, and no pixel of the mark, nor one beside it, is a pixel of the glyph.
    expect(count(glyphInk)).toBeGreaterThan(20);
    expect(count(mark)).toBeGreaterThan(12);
    const touches = mark.flatMap((row, y) => row.map((on, x) => on && [-1, 0, 1].some(dy => [-1, 0, 1].some(dx => glyphInk[y + dy]?.[x + dx] === true)))).filter(Boolean).length;
    expect(touches).toBe(0);

    const geometry = (await within("measuring the slot", page!.evaluate(`(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
      const child = document.querySelector("${CHILD}");
      const top = document.querySelector("${TOP}");
      const slot = child.querySelector("[data-tile-started-by]");
      const mark = slot.children[1];
      const muted = document.createElement("span");
      muted.className = "text-sidebar-muted-foreground";
      slot.append(muted);
      const ink = getComputedStyle(muted).color;
      muted.remove();
      return {
        slot: rect(slot),
        glyph: rect(slot.children[0]),
        mark: rect(mark),
        markInk: getComputedStyle(mark).color,
        muted: ink,
        stroke: parseFloat(getComputedStyle(mark).strokeWidth) * rect(mark).width / 24,
        words: rect(child.querySelector("[data-tile-where]")).left,
        topWords: rect(top.querySelector("[data-tile-where]")).left,
        topMark: top.querySelector("[data-tile-started-by]") !== null,
      };
    })()`))) as { slot: Box; glyph: Box; mark: Box; markInk: string; muted: string; stroke: number; words: number; topWords: number; topMark: boolean };

    // The glyph keeps a top-level tile's slot, so row one's words start where a top-level tile's do.
    expect(geometry.slot.width).toBe(12);
    expect(geometry.glyph.width).toBe(12);
    expect(geometry.words).toBe(geometry.topWords);
    expect(geometry.topMark).toBe(false);
    // The mark sits on the slot's top right as a superscript, reaching at most 2 px into the gap before the words.
    expect(geometry.mark.left).toBeGreaterThanOrEqual(geometry.slot.left + geometry.slot.width / 2 - 1);
    expect(geometry.mark.top).toBeLessThan(geometry.glyph.top);
    expect(geometry.mark.right).toBeLessThanOrEqual(geometry.slot.right + 2);
    expect(geometry.words - geometry.mark.right).toBeGreaterThanOrEqual(4);
    // Its line is at least a css pixel, which an icon shrunk at its default stroke is not.
    expect(geometry.stroke).toBeGreaterThanOrEqual(1);
    expect(geometry.markInk).toBe(geometry.muted);
  });

});
