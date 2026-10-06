// SPDX-License-Identifier: AGPL-3.0-only
// What a drag or a select-all takes in a real Chromium: the app's own chrome
// (the sidebar's search row, its filters, its tiles, the page header) is
// never page text, while what a person reads or copies (a reply, its code
// block, the composer) selects as text. Runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import type { Browser, Page } from "playwright";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The chrome's words the Linux run saw highlighted. */
const CHROME = ["Search", "All projects", "All computers"];

if (renderSkipped !== undefined) console.info(`selection render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("what selects as text, in Chromium", { timeout: 60_000 }, () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const selected = (): Promise<string> => page!.evaluate(() => window.getSelection()?.toString() ?? "");
  /** Whether any of the element's text is inside the selection's ranges. */
  const touched = (selector: string): Promise<boolean> =>
    page!.$eval(selector, el => {
      const s = window.getSelection();
      if (s === null || s.rangeCount === 0 || s.isCollapsed) return false;
      const text = s.toString();
      return [...el.querySelectorAll("*"), el].some(n => n.childNodes.length > 0 && [...n.childNodes].some(c => c.nodeType === 3 && (c.textContent ?? "").trim().length > 1 && s.containsNode(c, true) && text.includes((c.textContent ?? "").trim())));
    });
  const dragBetween = async (from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> => {
    await page!.mouse.move(from.x, from.y);
    await page!.mouse.down();
    await page!.mouse.move(to.x, to.y, { steps: 8 });
    await page!.mouse.up();
  };

  async function openChat(): Promise<void> {
    await page!.goto(`${base}?ws=ws_a&chat=1`);
    await page!.waitForSelector(".chat-markdown .shiki");
    await page!.waitForSelector("[data-slot=sidebar] [data-sidebar-row]");
  }

  it("select-all takes the transcript and none of the sidebar or the page header", async () => {
    await openChat();
    await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page!.evaluate(() => document.execCommand("selectAll"));
    const text = await selected();
    expect(text).toContain("Bumped the lockfile and ran the gate.");
    for (const word of CHROME) expect(text, word).not.toContain(word);
    expect(await touched("[data-slot=sidebar]")).toBe(false);
    expect(await touched("header")).toBe(false);
    await page!.mouse.click(5, 5);
    await page!.evaluate(() => window.getSelection()?.removeAllRanges());
    await page!.keyboard.press("ControlOrMeta+A");
    expect(await selected()).toContain("Bumped the lockfile and ran the gate.");
    for (const word of CHROME) expect(await selected(), word).not.toContain(word);
  });

  it("a drag across the sidebar selects nothing", async () => {
    await openChat();
    const sidebar = (await page!.locator("[data-slot=sidebar]").first().boundingBox())!;
    // From the empty foot of the list up past the filters and the search row, and on into the page header.
    await dragBetween({ x: sidebar.x + 40, y: sidebar.y + sidebar.height - 160 }, { x: sidebar.x + 40, y: sidebar.y + 40 });
    expect(await selected()).toBe("");
    await dragBetween({ x: sidebar.x + 40, y: sidebar.y + sidebar.height - 160 }, { x: sidebar.x + sidebar.width + 200, y: 20 });
    for (const word of CHROME) expect(await selected(), word).not.toContain(word);
  });

  it("a drag across a reply's paragraph selects its words, and one inside its code block selects code", async () => {
    await openChat();
    const paragraph = page!.locator(".chat-markdown p").last();
    const words = (await paragraph.textContent()) ?? "";
    expect(words.length).toBeGreaterThan(10);
    const p = (await paragraph.boundingBox())!;
    await dragBetween({ x: p.x + 1, y: p.y + 4 }, { x: p.x + p.width - 1, y: p.y + p.height - 4 });
    expect((await selected()).length).toBeGreaterThan(10);
    expect(words).toContain((await selected()).trim().slice(0, 10));
    const code = (await page!.locator(".chat-markdown pre").first().boundingBox())!;
    await dragBetween({ x: code.x + 8, y: code.y + 8 }, { x: code.x + code.width - 8, y: code.y + code.height - 8 });
    expect((await selected()).trim().length).toBeGreaterThan(10);
  });

  it("the composer's own text selects", async () => {
    await openChat();
    const box = "[data-chat-composer] [contenteditable=true]";
    await page!.click(box);
    await page!.keyboard.type("select me please");
    await page!.keyboard.press("ControlOrMeta+A");
    expect(await selected()).toContain("select me please");
  });

  it("select-all after a click in the Pull request pane takes that pane's text, not the transcript", async () => {
    await page!.goto(`${base}?ws=ws_a&chat=1&panel=pr`);
    await page!.waitForSelector(".chat-markdown pre");
    await page!.waitForSelector("[data-pr-body] .chat-markdown p");
    const body = page!.locator("[data-pr-body] .chat-markdown p").first();
    const words = ((await body.textContent()) ?? "").trim();
    expect(words.length).toBeGreaterThan(10);
    const at = (await body.boundingBox())!;
    await page!.mouse.click(at.x + 4, at.y + at.height / 2);
    await page!.keyboard.press("ControlOrMeta+A");
    const text = await selected();
    expect(text).toContain(words.slice(0, 30));
    expect(text).not.toContain("Bumped the lockfile and ran the gate.");
    for (const word of CHROME) expect(text, word).not.toContain(word);
    // A click back in the transcript takes the transcript again.
    const reply = (await page!.locator("[data-timeline-root] .chat-markdown p").first().boundingBox())!;
    await page!.mouse.click(reply.x + 4, reply.y + reply.height / 2);
    await page!.keyboard.press("ControlOrMeta+A");
    expect(await selected()).toContain("Bumped the lockfile and ran the gate.");
  });
});
