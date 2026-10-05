// SPDX-License-Identifier: AGPL-3.0-only
// The composer as a person meets it in a real Chromium, both themes: the row
// under the box sits in a tray joined to the box's foot, inset from its sides
// and drawing its own glass, so the chat scrolling behind never shows through
// the row's words; the placeholder keeps to one line in a phone-wide window;
// keys typed with focus outside any field land in the box, the first one
// included; the context ring's card opens at once on hover with Compact
// context in it; and a file dragged over the chat draws the drop zone. Runs
// only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDITOR = "[data-testid=composer-editor]";

if (renderSkipped !== undefined) console.info(`composer tray render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the composer's tray, placeholder, keys, ring card and drop zone in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const open = async (theme: "dark" | "light", width: number, extra = ""): Promise<Page> => {
    const page = await browser!.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto(`${base}?theme=${theme}&ws=ws_a&chat=1${extra}`);
    await page.waitForSelector(".chat-markdown");
    // A phone-wide window opens the right panel as a sheet over the thread.
    if (width < 640) await page.keyboard.press("Escape");
    return page;
  };

  it.each(["dark", "light"] as const)("in the %s theme the row sits in a tray joined to the box, inset from its sides, under glass of its own", async theme => {
    const page = await open(theme, 1440);
    const shape = await page.evaluate(() => {
      const box = document.querySelector("[data-slot=composer-host]")!.getBoundingClientRect();
      const tray = document.querySelector<HTMLElement>("[data-slot=composer-tray]")!;
      const rect = tray.getBoundingClientRect();
      const row = [...tray.children].map(c => c.getBoundingClientRect());
      const glass = getComputedStyle(tray, "::before");
      return {
        joined: rect.top < box.bottom && rect.bottom > box.bottom,
        inset: rect.left - box.left,
        rowInside: row.every(r => r.top >= box.bottom - 0.5 && r.bottom <= rect.bottom + 0.5),
        fill: glass.backgroundColor,
        edge: glass.borderBottomWidth,
        radius: glass.borderBottomLeftRadius,
      };
    });
    expect(shape.joined).toBe(true);
    expect(shape.inset).toBeCloseTo(22, 0);
    expect(shape.rowInside).toBe(true);
    expect(shape.fill).not.toBe("rgba(0, 0, 0, 0)");
    expect(shape.edge).toBe("1px");
    expect(shape.radius).toBe("16px");
    await page.close();
  }, 60_000);

  it.each(["dark", "light"] as const)("in the %s theme the placeholder keeps to one line in a phone-wide window, saying the short one there", async theme => {
    const page = await open(theme, 390);
    // The lines the words themselves draw on, off their own boxes: the placeholder's box is the editor's whatever wraps.
    const lines = await page.locator("[data-chat-composer] .text-placeholder").evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
    });
    expect(lines).toBe(1);
    // Too narrow for the whole sentence, the box says the short one, which fits whole.
    expect(await page.locator("[data-chat-composer] .text-placeholder").innerText()).toBe("Ask anything");
    expect(await page.locator("[data-chat-composer] .text-placeholder").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.close();
    const wide = await open(theme, 1440);
    expect(await wide.locator("[data-chat-composer] .text-placeholder").innerText()).toBe("Ask anything, or / for commands");
    await wide.close();
  }, 60_000);

  it("keys typed with focus outside any field land in the box, the first one too", async () => {
    const page = await open("dark", 1440);
    await page.locator(".chat-markdown").first().click();
    expect(await page.evaluate(sel => document.activeElement === document.querySelector(sel), EDITOR)).toBe(false);
    await page.keyboard.type("hello");
    expect(await page.locator(EDITOR).textContent()).toBe("hello");
    await page.close();
  }, 60_000);

  it("with the panel launcher open, a word typed with the transcript focused lands in the box and opens no panel, and the launcher's letters still answer inside the panel", async () => {
    const page = await open("dark", 1440);
    await page.waitForSelector("text=Open a panel");
    await page.locator(".chat-markdown").first().click();
    // T opens the Terminal from the launcher; here it is the first letter of a message.
    await page.keyboard.type("Try");
    expect(await page.locator(EDITOR).textContent()).toBe("Try");
    expect(await page.getByText("Open a panel").isVisible()).toBe(true);
    await page.getByText("Open a panel").click();
    await page.keyboard.press("f");
    await page.waitForSelector("text=Open a panel", { state: "detached" });
    expect(await page.locator(EDITOR).textContent()).toBe("Try");
    await page.close();
  }, 60_000);

  it("the ring's card opens at once on hover with the figures and Compact context", async () => {
    const page = await open("dark", 1440, "&ring=1");
    await page.hover("[data-context-ring]");
    // The card is open before a tooltip's usual delay would have run out.
    await page.waitForSelector("[data-context-card]", { timeout: 300 });
    expect(await page.locator("[data-context-figures]").textContent()).toBe("7.8%78.4k / 1M");
    expect(await page.locator("[data-context-compact]").count()).toBe(1);
    await page.close();
  }, 60_000);

  it("a file dragged over the chat draws the drop zone over it, and it goes when the drag leaves", async () => {
    const page = await open("dark", 1440);
    const drag = (type: "dragenter" | "dragleave") =>
      page.evaluate(kind => {
        const data = new DataTransfer();
        data.items.add(new File(["x"], "notes.txt", { type: "text/plain" }));
        document.querySelector(".chat-markdown")!.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: data, relatedTarget: null }));
      }, type);
    await drag("dragenter");
    await page.waitForSelector("[data-chat-drop-zone]");
    const covers = await page.evaluate(() => {
      const zone = document.querySelector("[data-chat-drop-zone]")!.getBoundingClientRect();
      const chat = document.querySelector("[data-chat-view]")!.getBoundingClientRect();
      return Math.abs(zone.width - chat.width) < 1 && Math.abs(zone.height - chat.height) < 1;
    });
    expect(covers).toBe(true);
    await drag("dragleave");
    await page.waitForSelector("[data-chat-drop-zone]", { state: "detached" });
    await page.close();
  }, 60_000);
});
