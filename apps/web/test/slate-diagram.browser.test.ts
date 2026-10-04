// SPDX-License-Identifier: AGPL-3.0-only
// The slate's diagram drawn by the chat's MermaidBlock in Chromium, since jsdom lays nothing out: a deploy's flow draws
// its SVG with the live step marked, redraws when the step's value moves, a flow larger than the panel opens with no
// label under 12 px in a frame that zooms, pans and opens whole in a dialog, a source that does not parse keeps the
// block's own line, and Mermaid's chunk loads only on a page whose slate holds a diagram. Like the other render tests
// it runs only when asked for (WSP_RENDER=1).
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { serveHarness, type Harness } from "./slate-render/serve";

if (renderSkipped !== undefined) console.info(`slate diagram render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the slate's diagram drawn in Chromium", () => {
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

  const open = async (doc: "diagram" | "reach"): Promise<Page> => {
    const page = await browser!.newPage({ viewport: { width: 440, height: 900 } });
    await page.goto(`${harness!.base}?w=400${doc === "diagram" ? "&doc=diagram" : ""}`);
    await page.waitForSelector("[data-slate]");
    return page;
  };
  /** The node whose shape carries the live step's class. */
  const marked = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-slate-piece="flow"] svg g.node.now')].map(n => n.textContent?.trim()));

  it("draws the flow with the live step marked, and moves the mark when the value moves", async () => {
    const page = await open("diagram");
    await page.waitForSelector('[data-slate-piece="flow"] [data-mermaid] svg', { timeout: 30_000 });
    expect(await page.locator('[data-slate-piece="flow"] figcaption').textContent()).toBe("Where the deploy is");
    expect(await marked(page)).toEqual(["test"]);
    await page.evaluate(() => (window as unknown as { slateEngine: { applyValues(v: Record<string, unknown>, r: number): void } }).slateEngine.applyValues({ $step: "ship" }, 9));
    await page.waitForFunction(() => document.querySelector('[data-slate-piece="flow"] svg g.node.now')?.textContent?.trim() === "ship", undefined, { timeout: 30_000 });
    expect(await marked(page)).toEqual(["ship"]);
    await page.close();
  });

  /** The frame's scale, the smallest node and edge label as drawn, the frame's height and a node's centre. */
  const read = (page: Page, frame: string) =>
    page.evaluate(sel => {
      const zoom = document.querySelector<HTMLElement>(sel)!;
      const k = Number(zoom.dataset["slateZoom"]);
      const least = (q: string) => Math.min(...[...zoom.querySelectorAll(q)].map(t => parseFloat(getComputedStyle(t).fontSize) * k));
      const proxy = [...zoom.querySelectorAll("svg g.node")].find(n => n.textContent?.trim() === "Cloudflare proxy")!.getBoundingClientRect();
      return { k, node: least(".node text, .node tspan"), edge: least(".edgeLabel text, .edgeLabel tspan"), height: zoom.getBoundingClientRect().height, proxy: { x: proxy.x + proxy.width / 2, y: proxy.y + proxy.height / 2 } };
    }, frame);
  const WIDE = '[data-slate-piece="wide"] [data-slate-zoom]';
  const EXPANDED = "[data-slate-diagram-expanded] [data-slate-zoom]";

  it("keeps the live mark's own stroke over the slate's hairline", async () => {
    const page = await open("diagram");
    await page.waitForSelector('[data-slate-piece="flow"] svg g.node.now', { timeout: 30_000 });
    const width = await page.evaluate(() => getComputedStyle(document.querySelector('[data-slate-piece="flow"] svg g.node.now rect')!).strokeWidth);
    expect(width).toBe("3px");
    await page.close();
  });

  it("opens a flow larger than the panel with no label under 12 px, in a frame no taller than 420 px", async () => {
    const page = await open("diagram");
    await page.waitForSelector(`${WIDE} svg`, { timeout: 30_000 });
    const opened = await read(page, WIDE);
    expect(opened).toMatchObject({ k: 1, node: 13, edge: 12, height: 420 });
    await page.close();
  });

  it("zooms around the pointer with ctrl and the wheel, leaves a plain wheel alone, pans by a drag and fits again on a double-click", async () => {
    const page = await open("diagram");
    await page.waitForSelector(`${WIDE} svg`, { timeout: 30_000 });
    // Whether the frame kept each wheel from the page, read where it reaches the window.
    await page.evaluate(() => addEventListener("wheel", event => ((window as unknown as { kept: boolean[] }).kept ??= []).push(event.defaultPrevented)));
    const opened = await read(page, WIDE);
    await page.mouse.move(opened.proxy.x, opened.proxy.y);
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(100);
    expect((await read(page, WIDE)).k).toBe(1);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -40);
    await page.mouse.wheel(0, -40);
    await page.keyboard.up("Control");
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as unknown as { kept: boolean[] }).kept)).toEqual([false, true, true]);
    const zoomed = await read(page, WIDE);
    expect(zoomed.k).toBeGreaterThan(1.5);
    expect(Math.abs(zoomed.proxy.x - opened.proxy.x)).toBeLessThan(2);
    expect(Math.abs(zoomed.proxy.y - opened.proxy.y)).toBeLessThan(2);
    await page.mouse.down();
    await page.mouse.move(opened.proxy.x - 60, opened.proxy.y - 40, { steps: 4 });
    await page.mouse.up();
    const panned = await read(page, WIDE);
    expect(panned.proxy.x - zoomed.proxy.x).toBeCloseTo(-60, 0);
    expect(panned.proxy.y - zoomed.proxy.y).toBeCloseTo(-40, 0);
    await page.mouse.dblclick(opened.proxy.x, opened.proxy.y);
    expect(await read(page, WIDE)).toEqual(opened);
    await page.close();
  });

  it("opens whole in a dialog that zooms out, in and fits by its buttons, keeps redrawing the live value, and leaves on Esc or its close", async () => {
    const page = await open("diagram");
    await page.waitForSelector('[data-slate-piece="flow"] svg', { timeout: 30_000 });
    await page.locator('[data-slate-piece="flow"]').getByRole("button", { name: "Expand" }).click();
    await page.waitForSelector(`${EXPANDED} svg g.node.now`, { timeout: 30_000 });
    const k = async () => Number(await page.locator(EXPANDED).getAttribute("data-slate-zoom"));
    expect(await page.getByRole("dialog").getByRole("heading").textContent()).toBe("Where the deploy is");
    const fitted = await k();
    await page.getByRole("button", { name: "Zoom in" }).click();
    expect(await k()).toBeCloseTo(fitted * 1.25, 2);
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    expect(await k()).toBeCloseTo(fitted / 1.25, 2);
    await page.getByRole("button", { name: "Fit" }).click();
    expect(await k()).toBe(fitted);
    await page.evaluate(() => (window as unknown as { slateEngine: { applyValues(v: Record<string, unknown>, r: number): void } }).slateEngine.applyValues({ $step: "ship" }, 9));
    await page.waitForFunction(sel => document.querySelector(`${sel} svg g.node.now`)?.textContent?.trim() === "ship", EXPANDED, { timeout: 30_000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-slate-diagram-expanded]", { state: "detached" });
    await page.locator('[data-slate-piece="flow"]').getByRole("button", { name: "Expand" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await page.waitForSelector("[data-slate-diagram-expanded]", { state: "detached" });
    await page.close();
  });

  it("keeps MermaidBlock's own line under a source that does not parse", async () => {
    const page = await open("diagram");
    const line = page.locator('[data-slate-piece="broken"] [data-mermaid-note]');
    await line.waitFor({ timeout: 30_000 });
    expect(await line.textContent()).toBe("Diagram did not parse");
    expect(await page.locator('[data-slate-piece="broken"] [data-slate-diagram-source]').textContent()).toContain("A -->");
    await page.close();
  });

  it("loads Mermaid's chunk only for a slate that holds a diagram", async () => {
    const chunk = (path: string) => /\/assets\/MermaidBlock-/.test(path);
    harness!.fetched.length = 0;
    const plain = await open("reach");
    await plain.waitForTimeout(500);
    expect(harness!.fetched.some(chunk)).toBe(false);
    await plain.close();
    const page = await open("diagram");
    await page.waitForSelector('[data-slate-piece="flow"] [data-mermaid] svg', { timeout: 30_000 });
    expect(harness!.fetched.some(chunk)).toBe(true);
    await page.close();
  });
});
