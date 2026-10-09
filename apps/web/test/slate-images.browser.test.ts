// SPDX-License-Identifier: AGPL-3.0-only
// The image pieces drawn from slate text over a folder of screenshots, at the panel's two widths in graphite and
// paper: a strip sits in one row at one height and scrolls past what fits, a gallery is two columns under 400 px, a
// file loading, missing, too big, not an image or waiting on its domain keeps the frame's height, its words wrapped
// inside it, and an address is never requested by the window, before the person allows its domain or after.
// The folder is made here from pages Chromium shoots, laid out as slate-render/images.ts says, unless
// SLATE_IMAGES_DIR names one of real screenshots; with SLATE_IMAGES_OUT set each case is also shot there. Like the
// other render tests it runs only when asked for (WSP_RENDER=1).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { IMAGE_FILES, REMOTE } from "./slate-render/images";
import { serveHarness, type Harness } from "./slate-render/serve";

const FOLDER = process.env["SLATE_IMAGES_DIR"];
const OUT = process.env["SLATE_IMAGES_OUT"];
const skipped = renderSkipped;
if (skipped !== undefined) console.info(`slate images render test skipped: ${skipped}`);

const CASES = ["img-single", "img-strip-3", "img-strip-6", "img-gallery", "img-slider", "img-states", "img-gallery-states", "img-remote", "img-gallery-61"] as const;

/** A folder of screenshots in the shapes the cases read: laptop screens, wide charts, and a tall sidebar pair. */
async function makeFolder(browser: Browser): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "wsp-slate-images-"));
  const page = await browser.newPage();
  const shot = async (path: string, width: number, height: number, hue: number, label: string): Promise<void> => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    await page.setViewportSize({ width, height });
    await page.setContent(`<body style="margin:0;height:100vh;display:grid;place-items:center;font:600 56px system-ui;color:#fff;background:linear-gradient(135deg,hsl(${hue} 55% 42%),hsl(${hue + 50} 55% 22%))">${label}</body>`);
    await page.screenshot({ path: join(dir, path) });
  };
  try {
    await shot(IMAGE_FILES.failure, 1440, 900, 0, "failed.png");
    for (const [i, path] of IMAGE_FILES.charts.entries()) await shot(path, 1200, i === 2 ? 500 : 800, 200 + i * 20, `chart ${i + 1}`);
    for (const [i, path] of IMAGE_FILES.screens.entries()) await shot(path, 1440, 900, 30 + i * 40, `screen ${i + 1}`);
    await shot(IMAGE_FILES.before, 600, 900, 260, "before");
    await shot(IMAGE_FILES.after, 600, 900, 140, "after");
  } finally {
    await page.close();
  }
  return dir;
}

describe.skipIf(skipped !== undefined)("the slate's image pieces in Chromium", () => {
  let harness: Harness | undefined;
  let browser: Browser | undefined;
  let made: string | undefined;
  beforeAll(async () => {
    browser = await launchRender();
    if (FOLDER === undefined) made = await makeFolder(browser);
    harness = await serveHarness(FOLDER ?? made);
    if (OUT !== undefined) mkdirSync(OUT, { recursive: true });
  }, 120_000);
  afterAll(async () => {
    await stopRender(browser, undefined);
    harness?.stop();
    if (made !== undefined) rmSync(made, { recursive: true, force: true });
  });

  // A dialog over the whole window is shot at 1x: at 2x the low-end mode's tile budget crashed the page.
  const open = async (doc: string, w: number, theme: string, scale = OUT === undefined ? 1 : 2): Promise<Page> => {
    const page = await browser!.newPage({ viewport: { width: Math.max(w + 40, 1200), height: 1100 }, deviceScaleFactor: scale, reducedMotion: "reduce" });
    await page.goto(`${harness!.base}?w=${w}&doc=${doc}&theme=${theme}`);
    await page.waitForSelector("[data-slate-image], [data-slate-images-piece]");
    // Settled once every picture drew and something did: a picture, a refusal or a domain's question.
    await page.waitForFunction(() => [...document.querySelectorAll("img")].every(i => i.complete) && document.querySelector("img, [data-slate-image-refused], [data-slate-image-asking]") !== null, undefined, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(250);
    return page;
  };
  const shoot = async (page: Page, name: string, whole = false) => {
    if (OUT === undefined) return;
    if (whole) await page.screenshot({ path: join(OUT, `${name}.png`) });
    else await page.locator("[data-panel]").screenshot({ path: join(OUT, `${name}.png`) });
  };

  for (const doc of CASES)
    for (const w of [400, 640])
      for (const theme of ["graphite", "paper"])
        it(`${doc} at ${w} in ${theme} draws inside the panel`, async () => {
          const page = await open(doc, w, theme);
          try {
            const out = await page.evaluate(() => {
              const panel = document.querySelector("[data-panel]")!.getBoundingClientRect();
              // A strip's row scrolls inside its own frame: what it holds past the panel's edge is scrolled out of view.
              const scrolled = (el: Element): boolean => {
                for (let up = el.parentElement; up !== null; up = up.parentElement) if (up.matches('[data-slot="scroll-area-viewport"]')) return true;
                return false;
              };
              return [...document.querySelectorAll("[data-slate-image] *, [data-slate-images-piece] *")]
                .filter(el => !scrolled(el))
                .map(el => el.getBoundingClientRect())
                .filter(r => r.width > 0 && (r.left < panel.left - 0.5 || r.right > panel.right + 0.5)).length;
            });
            await shoot(page, `${doc.slice(4)}-${w}-${theme}`);
            expect(out).toBe(0);
          } finally {
            await page.close();
          }
        }, 30_000);

  it("lays a strip in one row at one height, scrolling past what fits, and opens any of it large with previous and next", async () => {
    for (const theme of ["graphite", "paper"])
      for (const w of [400, 640])
        for (const doc of ["img-strip-3", "img-strip-6"]) {
          const page = await open(doc, w, theme, w === 640 && doc === "img-strip-6" ? 1 : undefined);
          try {
            const drawn = await page.evaluate(() => {
              const thumbs = [...document.querySelectorAll("[data-slate-thumb] button")].map(b => b.getBoundingClientRect());
              const port = document.querySelector('[data-slate-images="strip"] [data-slot="scroll-area-viewport"]') ?? document.querySelector('[data-slate-images="strip"] ul')!.parentElement!;
              return { tops: new Set(thumbs.map(t => Math.round(t.top))).size, heights: new Set(thumbs.map(t => Math.round(t.height))).size, scrolls: port.scrollWidth > port.clientWidth + 1 };
            });
            expect({ doc, w, ...drawn }).toEqual({ doc, w, tops: 1, heights: 1, scrolls: !(doc === "img-strip-3" && w === 640) });
            if (w === 640 && doc === "img-strip-6") {
              await page.locator("[data-slate-thumb] button").nth(4).click();
              await page.waitForSelector("[data-slate-image-expanded] svg image");
              expect(await page.locator("[data-slate-image-expanded] [data-slate-image-at]").textContent()).toBe("5 of 6");
              await page.waitForTimeout(250);
              await shoot(page, `strip-open-${theme}`, true);
              await page.keyboard.press("ArrowLeft");
              expect(await page.locator("[data-slate-image-expanded] [data-slate-image-at]").textContent()).toBe("4 of 6");
            }
          } finally {
            await page.close();
          }
        }
  }, 120_000);

  it("lays a gallery in two columns at 400 and three at 640, and opens one large with previous and next", async () => {
    for (const theme of ["graphite", "paper"]) {
      const columns: Record<number, number> = {};
      for (const w of [400, 640]) {
        const page = await open("img-gallery", w, theme, w === 640 ? 1 : undefined);
        try {
          const tops = await page.locator("[data-slate-thumb]").evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
          columns[w] = tops.filter(t => t === tops[0]).length;
          if (w === 640) {
            await page.locator("[data-slate-thumb] button").nth(2).click();
            await page.waitForSelector("[data-slate-image-expanded] svg image");
            expect(await page.locator("[data-slate-image-expanded] [data-slate-image-at]").textContent()).toBe("3 of 6");
            await page.waitForTimeout(250);
            await shoot(page, `gallery-open-${theme}`, true);
            await page.keyboard.press("ArrowRight");
            expect(await page.locator("[data-slate-image-expanded] [data-slate-image-at]").textContent()).toBe("4 of 6");
          }
        } finally {
          await page.close();
        }
      }
      expect(columns).toEqual({ 400: 2, 640: 3 });
    }
  }, 60_000);

  it("opens one image large in the diagram's dialog", async () => {
    for (const theme of ["graphite", "paper"]) {
      const page = await open("img-single", 640, theme, 1);
      try {
        await page.getByRole("button", { name: "Expand" }).click();
        await page.waitForSelector("[data-slate-image-expanded] svg image");
        await page.waitForTimeout(250);
        await shoot(page, `single-open-${theme}`, true);
        expect(await page.locator("[data-slate-image-expanded] [data-slate-zoom]").getAttribute("data-slate-zoom")).not.toBe("1");
      } finally {
        await page.close();
      }
    }
  }, 90_000);

  it("moves a slider's line with the keys", async () => {
    for (const theme of ["graphite", "paper"]) {
      const page = await open("img-slider", 640, theme);
      try {
        const slider = page.getByRole("slider");
        for (let i = 0; i < 4; i++) await slider.press("ArrowLeft");
        expect(await slider.getAttribute("aria-valuenow")).toBe("30");
        await slider.blur();
        await shoot(page, `slider-moved-640-${theme}`);
      } finally {
        await page.close();
      }
    }
  }, 30_000);

  it("holds a frame's height while it loads, where the file is missing, too big or not an image, and while its domain waits", async () => {
    for (const theme of ["graphite", "paper"])
      for (const w of [400, 640]) {
        const page = await open("img-states", w, theme);
        try {
          const said = await page.evaluate(() => Object.fromEntries(["loading", "missing", "big", "text", "asking"].map(id => {
            const piece = document.querySelector(`[data-slate-piece="${id}"]`)!;
            const frame = piece.querySelector("figure > :first-child")!.getBoundingClientRect();
            return [id, { h: Math.round(frame.height), w: Math.round(frame.width), spinner: piece.querySelector("[data-slate-image-loading]") !== null, line: piece.querySelector("[data-slate-image-refused]")?.textContent ?? null, asking: piece.querySelector("[data-slate-image-asking]")?.textContent ?? null }];
          })));
          for (const s of Object.values(said)) expect(s.h).toBe(Math.round(s.w * (10 / 16)));
          const wrapped = await page.evaluate(() => [...document.querySelectorAll("[data-slate-image-refused], [data-slate-image-asking]")].map(el => ({ fits: el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1 })));
          expect(wrapped.every(l => l.fits), JSON.stringify(wrapped)).toBe(true);
          expect(said["loading"]).toMatchObject({ spinner: true, line: null });
          expect(said["missing"]!.line).toBe("No file at plots/latency.png");
          expect(said["big"]!.line).toContain("save it smaller, or show a part of it");
          expect(said["big"]!.line).toMatch(/^too-big\/trace\.png is 14(\.\d)? MB, over the 10 MB an image may weigh/);
          expect(said["text"]!.line).toBe("text/notes.png is not a PNG, JPEG, GIF or WebP image");
          expect(said["asking"]!.asking).toBe("Show images from images.acme.test in this thread? wsp fetches them, not this window.Allow");
        } finally {
          await page.close();
        }
      }
  }, 60_000);

  it("asks the host only for thumbnails near view, and for the rest as they scroll in", async () => {
    const asked = (page: Page) => page.evaluate(() => (window as unknown as { hostAsked: string[] }).hostAsked.length);
    // Scrolled a step at a time, as a person scrolls, so every row passes through view on the way.
    const stepped = async (strip: boolean) => {
      const box = strip ? document.querySelector<HTMLElement>('[data-slate-images="strip"] [data-slot="scroll-area-viewport"]')! : document.scrollingElement!;
      for (let i = 0; i < 60; i++) {
        box.scrollBy(strip ? { left: 200 } : { top: 300 });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
    };
    for (const [doc, count, strip] of [
      ["img-gallery-60", 60, false],
      ["img-strip-30", 30, true],
    ] as const) {
      const page = await open(doc, 400, "graphite");
      try {
        const first = await asked(page);
        expect(first, doc).toBeGreaterThan(0);
        expect(first, doc).toBeLessThan(count);
        await page.evaluate(stepped, strip);
        await page.waitForFunction(n => (window as unknown as { hostAsked: string[] }).hostAsked.length === n, count, { timeout: 10_000 });
      } finally {
        await page.close();
      }
    }
  }, 60_000);

  it("refuses a list of more than 60 images in one line and asks the host for none of them", async () => {
    const page = await open("img-gallery-61", 400, "graphite");
    try {
      expect(await page.locator("[data-slate-image-refused]").textContent()).toBe("This list holds 61 images and a slate shows at most 60, so it shows none; show a page of them");
      expect(await page.evaluate(() => (window as unknown as { hostAsked: string[] }).hostAsked)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("never requests an address from the window: it asks for the domain, and once allowed the host's read draws every image from it", async () => {
    const page = await browser!.newPage({ viewport: { width: 1200, height: 1100 }, reducedMotion: "reduce" });
    const requested: string[] = [];
    page.on("request", r => void requested.push(r.url()));
    try {
      await page.goto(`${harness!.base}?w=640&doc=img-remote&theme=graphite`);
      await page.waitForSelector("[data-slate-image-asking]");
      await page.waitForFunction(() => document.querySelectorAll("[data-slate-image-asking]").length === 4);
      expect(await page.evaluate(() => (window as unknown as { hostFetched: string[] }).hostFetched)).toEqual([]);
      const fits = await page.evaluate(() => [...document.querySelectorAll("[data-slate-image-asking]")].map(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1));
      expect(fits).toEqual([true, true, true, true]);
      await shoot(page, "remote-asking-640-graphite");
      await page.locator("[data-slate-image-asking] button").first().click();
      await page.waitForFunction(() => document.querySelectorAll("[data-slate-image-asking]").length === 0 && document.querySelectorAll("img").length === 4);
      const fetched = await page.evaluate(() => (window as unknown as { hostFetched: string[] }).hostFetched);
      expect(fetched.sort()).toEqual([IMAGE_FILES.failure, ...IMAGE_FILES.screens.slice(0, 3)].map(p => `${REMOTE}/${p}`).sort());
      await shoot(page, "remote-allowed-640-graphite");
      expect(requested.filter(url => !url.startsWith(new URL(harness!.base).origin) && !url.startsWith("blob:") && !url.startsWith("data:"))).toEqual([]);
      expect(requested.filter(url => url.includes("acme.test"))).toEqual([]);
      expect(await page.evaluate(() => [...document.querySelectorAll("img")].every(i => i.src.startsWith("blob:")))).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
});
