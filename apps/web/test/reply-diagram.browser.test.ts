// SPDX-License-Identifier: AGPL-3.0-only
// A reply's Mermaid fence and formulas in a real Chromium, both themes: the
// flowchart draws as an SVG in the page's own inks with a script in its label
// never reaching the page, a fence that does not parse keeps its source with
// the line under it, the formulas typeset while a price stays prose, and a
// thread with neither asks for neither chunk. Runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (renderSkipped !== undefined) console.info(`reply diagram render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("a reply's diagrams and formulas in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  /** The page at the query given, with every module it asks the server for. */
  const open = async (query: string): Promise<string[]> => {
    await page?.close();
    page = await browser!.newPage({ viewport: { width: 1200, height: 1400 } });
    const asked: string[] = [];
    page.on("request", request => asked.push(request.url()));
    await page.goto(`${base}?${query}`);
    return asked;
  };

  it.each(["dark", "light"] as const)("in the %s theme draws the flowchart without its script, keeps the broken fence as source, and typesets the formulas", async theme => {
    await open(`theme=${theme}&ws=ws_a&chat=diagram`);
    await page!.waitForSelector(".chat-markdown [data-mermaid] svg", { timeout: 30_000 });
    await page!.waitForSelector(".chat-markdown .katex-display", { timeout: 30_000 });
    const read = await page!.evaluate(() => {
      const root = document.querySelector(".chat-markdown:has([data-mermaid])")!;
      const svg = root.querySelector("[data-mermaid] svg")!;
      const node = svg.querySelector("g.node rect, g.node path, g.node polygon");
      return {
        ran: (window as unknown as { __mermaidRan?: boolean }).__mermaidRan === true,
        scripts: root.querySelectorAll("script").length,
        foreign: svg.querySelectorAll("foreignObject").length,
        labels: svg.textContent ?? "",
        fill: node === null ? null : getComputedStyle(node).fill,
        broken: [...root.querySelectorAll("[data-mermaid='error']")].map(el => el.textContent ?? ""),
        display: root.querySelectorAll(".katex-display").length,
        inline: root.querySelectorAll(":not(.katex-display) > .katex").length,
        prose: root.textContent?.includes("at $3 to $5 a run") ?? false,
        // \neq is a slash laid over the equals sign; the stylesheet has to be the one the markup was written for.
        overlay: [...root.querySelectorAll(".katex .rlap > .inner")].map(el => getComputedStyle(el).position),
      };
    });
    expect(read.ran).toBe(false);
    expect(read.scripts).toBe(0);
    expect(read.foreign).toBe(0);
    expect(read.labels).toContain("Install");
    expect(read.labels).toContain("Build");
    expect(read.fill).not.toBeNull();
    expect(read.broken).toHaveLength(1);
    expect(read.broken[0]).toContain("A -->");
    expect(read.broken[0]).toContain("Diagram did not parse");
    expect(read.display).toBe(1);
    expect(read.inline).toBeGreaterThanOrEqual(1);
    expect(read.prose).toBe(true);
    expect(read.overlay.length).toBeGreaterThan(0);
    expect(read.overlay.every(position => position === "absolute")).toBe(true);
  }, 60_000);

  it("keeps a diagram's labels legible on a phone, scrolling the block sideways rather than shrinking it", async () => {
    await page?.close();
    page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}?theme=dark&ws=ws_a&chat=diagram`);
    await page.waitForSelector(".chat-markdown [data-mermaid] svg", { timeout: 30_000 });
    const read = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>(".chat-markdown [data-mermaid='true']")!;
      return { svg: block.querySelector("svg")!.getBoundingClientRect().width, block: block.clientWidth, scrolls: block.scrollWidth > block.clientWidth };
    });
    expect(read.svg).toBeGreaterThanOrEqual(read.block);
    expect(read.scrolls).toBe(true);
  }, 60_000);

  it("fetches nothing a diagram names while it draws, and leaves no link in the page", async () => {
    const asked: string[] = [];
    const beacon = createServer((req, res) => {
      asked.push(req.url ?? "");
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => beacon.listen(0, "127.0.0.1", resolve));
    const { port } = beacon.address() as AddressInfo;
    try {
      await open(`theme=dark&ws=ws_a&chat=hostile&beacon=${encodeURIComponent(`http://127.0.0.1:${port}`)}`);
      await page!.waitForFunction(() => document.querySelectorAll(".chat-markdown [data-mermaid]").length === 5 && document.querySelectorAll(".chat-markdown [data-mermaid='pending']").length === 0, undefined, { timeout: 30_000 });
      // A fetch Mermaid starts while it measures lands in well under this.
      await page!.waitForTimeout(1500);
      const read = await page!.evaluate(() => ({
        links: document.querySelectorAll(".chat-markdown [data-mermaid] a").length,
        refused: [...document.querySelectorAll(".chat-markdown [data-mermaid]")].map(el => el.getAttribute("data-mermaid")),
        lines: [...document.querySelectorAll(".chat-markdown [data-mermaid] [data-mermaid-note]")].map(el => el.textContent),
      }));
      expect(asked).toEqual([]);
      expect(read.links).toBe(0);
      expect(read.refused).toEqual(Array(5).fill("refused"));
      expect(read.lines).toEqual(Array(5).fill("Diagram names an address and is not drawn"));
    } finally {
      await new Promise<void>(resolve => beacon.close(() => resolve()));
    }
  }, 60_000);

  it("asks for neither chunk on a thread with no diagram and no formula", async () => {
    const asked = await open("theme=dark&ws=ws_a&chat=1");
    await page!.waitForSelector(".chat-markdown .shiki");
    await page!.waitForTimeout(500);
    expect(asked.filter(url => /mermaid|katex|MermaidBlock|markdownMath/i.test(url))).toEqual([]);
  }, 60_000);
});
