// SPDX-License-Identifier: AGPL-3.0-only
// The slate's diagram drawn by the chat's MermaidBlock in Chromium, since jsdom lays nothing out: a deploy's flow draws
// its SVG with the live step marked, redraws when the step's value moves, a source that does not parse keeps the
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
