// SPDX-License-Identifier: AGPL-3.0-only
// A thread whose reply links to a public host, a private one and an internal name, opened in a real Chromium with
// every request the page and its workers make recorded: none leaves 127.0.0.1, so no linked host is named to a
// third party (Google's favicon service once was, for every link). Each link still leads with the app's own glyph.
// Shot in both themes. Runs only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(tmpdir(), "wsp-render");

if (renderSkipped !== undefined) console.info(`link requests render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("a thread with links opened in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme asks nothing of any host but 127.0.0.1", async theme => {
    const context = await browser!.newContext({ viewport: { width: 1200, height: 900 } });
    const asked: string[] = [];
    context.on("request", r => asked.push(r.url()));
    // Nothing leaves the machine even when the assertion below would fail, so a red run names no host to anyone.
    await context.route(url => url.hostname !== "127.0.0.1", route => route.abort());
    const page = await context.newPage();
    try {
      await page.goto(`${base}?theme=${theme}&ws=ws_a&chat=1&links=1`);
      const links = page.locator(".chat-markdown a[href^='http']");
      await page.waitForFunction(() => document.querySelectorAll(".chat-markdown a[href^='http']").length >= 4, undefined, { timeout: 30_000 });
      expect(await links.count()).toBe(4);
      // An image, had one been drawn, is asked for once it is laid out; give it the time.
      await page.waitForLoadState("networkidle");
      const away = asked.filter(u => /^(?:https?|wss?):/.test(u) && new URL(u).hostname !== "127.0.0.1");
      expect(away).toEqual([]);
      expect(await page.locator(".chat-markdown img").count()).toBe(0);
      expect(await links.evaluateAll(as => as.map(a => a.querySelector("svg.lucide-globe") !== null))).toEqual([true, true, true, true]);
      const last = page.locator(".chat-markdown").last();
      await last.locator("a", { hasText: "on the runner" }).scrollIntoViewIfNeeded();
      const path = join(SHOTS, `chat-links-${theme}.png`);
      await last.screenshot({ path });
      console.info(`${theme}: ${asked.length} requests, all to 127.0.0.1; shot ${path}`);
    } finally {
      await context.close();
    }
  }, 60_000);
});
