// SPDX-License-Identifier: AGPL-3.0-only
// The owner's picks of 2026-10-05 measured in Chromium, since jsdom lays nothing out: the spoo live traffic slate at the
// panel's 400 px and widened to 640 and 960. The bar lists, held in grids as the live agent wrote them, share one switch
// that never moves the page: the card stays the tallest list's height and every segment keeps its width whichever list
// is picked, and the pick holds across a value push. The request log's path takes the slack, its last column ending on
// the card's right inset. The
// request log's header words stand 8 px over its card, each over its column. Sections stand 32 px apart, a head 12 px
// over what it holds, and the stat strip is three equal cells a row. The harness is built by Vite into a folder and
// served as files, no dev server; like the other render tests it runs only when asked for (WSP_RENDER=1).
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

if (renderSkipped !== undefined) console.info(`slate picks render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the owner's slate picks laid out in Chromium", () => {
  let out = "";
  let server: Server | undefined;
  let browser: Browser | undefined;
  let base = "";

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "wsp-slate-picks-"));
    // The build runs in a child of its own: Vite's esbuild refuses jsdom's TextEncoder.
    const built = spawnSync(process.execPath, [join(WEB_DIR, "node_modules/vite/bin/vite.js"), "build", "test/slate-render", "--config", "vite.config.ts", "--base", "./", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { cwd: WEB_DIR, encoding: "utf8" });
    if (built.status !== 0) throw new Error(`the harness did not build: ${built.stderr}`);
    server = createServer((req, res) => {
      const file = join(out, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
      if (!file.startsWith(out) || !existsSync(file)) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/index.html`;
    browser = await launchRender();
  }, 120_000);
  afterAll(async () => {
    await stopRender(browser, undefined);
    server?.close();
    rmSync(out, { recursive: true, force: true });
  });

  const open = async (width: number): Promise<Page> => {
    const page = await browser!.newPage({ viewport: { width: width + 40, height: 1200 } });
    await page.goto(`${base}?w=${width}`);
    await page.waitForSelector("[data-slate-bar-switch]");
    return page;
  };

  for (const width of [640, 960]) {
    it(`gives the request log's slack to the path, so its last column ends on the card's right inset, at ${width}`, async () => {
      const page = await open(width);
      const layout = await page.evaluate(() => {
        const box = (el: Element) => el.getBoundingClientRect();
        const table = document.querySelector("[data-slate-head]")!.parentElement!;
        const card = table.querySelector("[data-slate-head] + div")!;
        const cells = [...card.querySelector("[role=row]")!.querySelectorAll("[role=cell]")];
        const range = document.createRange();
        range.selectNodeContents(cells[2]!);
        return { inset: Math.round(box(card).right - box(cells.at(-1)!).right), path: Math.round(box(cells[2]!).width), pathText: Math.round(range.getBoundingClientRect().width) };
      });
      // The card's 1 px border and its 16 px inset.
      expect(layout.inset).toBe(17);
      expect(layout.path).toBeGreaterThan(layout.pathText);
      await page.close();
    });
  }

  for (const width of [400, 640]) {
    it(`keeps the bar lists' card and segments still across every switch and a value push at ${width}`, async () => {
      const page = await open(width);
      const measure = () =>
        page.evaluate(() => {
          const sw = document.querySelector("[data-slate-bar-switch]")!;
          const card = sw.children[1]!.getBoundingClientRect();
          return {
            card: [Math.round(card.top), Math.round(card.height)],
            segments: [...sw.querySelectorAll("[data-segment]")].map(s => Math.round(s.getBoundingClientRect().width)),
            shown: [...sw.querySelectorAll("[data-slate-bar-list]")].filter(l => getComputedStyle(l).visibility === "visible").map(l => l.getAttribute("data-slate-bar-list")),
            below: Math.round(document.querySelector("[data-panel]")!.getBoundingClientRect().height),
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
        expect(now.below).toBe(first.below);
      }
      // A value push redraws the lists; the pick stays where the person left it.
      await page.evaluate(() => (window as unknown as { slateEngine: { applyValues(v: Record<string, unknown>, r: number): void } }).slateEngine.applyValues({ $events: [{ n: "request_completed", v: 4000 }] }, 9));
      await page.waitForTimeout(100);
      expect((await measure()).shown).toEqual(["events"]);
      await page.close();
    });

    it(`stands the request log's header words 8 px over its card, each over its column, at ${width}`, async () => {
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
        };
      });
      expect(layout.gap).toBe(8);
      expect(layout.offsets).toEqual([0, 0, 0, 0, 0, 0]);
      await page.close();
    });

    it(`spaces sections 32 px apart and a head 12 px over its pieces, and splits the strip into three equal cells, at ${width}`, async () => {
      const page = await open(width);
      const layout = await page.evaluate(() => {
        const box = (el: Element) => el.getBoundingClientRect();
        const sections = [...document.querySelectorAll("[data-slate-section]")];
        const cells = [...document.querySelectorAll("[data-slate-strip] > div > *")].map(c => [Math.round(box(c).left), Math.round(box(c).top), Math.round(box(c).width)]);
        return {
          apart: sections.slice(1).map((s, i) => Math.round(box(s).top - box(sections[i]!).bottom)),
          head: sections.map(s => Math.round(box(s.children[1]!).top - box(s.children[0]!).bottom)),
          rows: new Set(cells.map(c => c[1])).size,
          widths: new Set(cells.map(c => c[2])).size,
        };
      });
      expect(layout.apart).toEqual([32]);
      expect(layout.head).toEqual([12, 12]);
      expect(layout.rows).toBe(2);
      expect(layout.widths).toBe(1);
      await page.close();
    });
  }
});
