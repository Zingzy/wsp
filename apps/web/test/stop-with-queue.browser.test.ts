// SPDX-License-Identifier: AGPL-3.0-only
// A turn stopped with a message waiting, in a real Chromium: the person types a message while the agent works, it
// queues, they press stop, and the queued message goes as the next turn. The host's side is a recording of a real
// run of exactly that (fixtures/stop-with-queue.json): the thread's history, every event with its timing, every
// session list the host answered and when, and how long the stop and the send took to answer. What is read is what a
// person sees once it settles: the queued message on the page, the turn it started answered, and nothing still
// working. Runs only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORDING = readFileSync(resolve(WEB_DIR, "test/fixtures/stop-with-queue.json"), "utf8");

if (renderSkipped !== undefined) console.info(`stop with a queue render test skipped: ${renderSkipped}`);

/** The rows on screen top to bottom, each by its words. */
const onScreen = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-timeline-root]")]
      .map(r => ({ top: r.getBoundingClientRect().top, h: r.getBoundingClientRect().height, text: (r as HTMLElement).innerText.replace(/\s+/g, " ").trim() }))
      .filter(r => r.h > 0 && r.text !== "")
      .sort((a, b) => a.top - b.top)
      .map(r => r.text),
  );

describe.skipIf(renderSkipped !== undefined)("a turn stopped with a message queued, laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  it("shows the queued message as the next turn's prompt and leaves nothing working once it settles", async () => {
    await page!.goto(`${vite!.base}/test/shell/index.html?ws=ws_a`);
    await page!.waitForSelector("[data-chat-composer]");
    await page!.evaluate(async recording => {
      const rec = JSON.parse(recording) as {
        thread: string;
        history: unknown[];
        events: Array<{ ms: number; event: { type: string } }>;
        lists: Array<{ ms: number; rows: unknown[] }>;
        replies: { interrupt: { after: number; outcome: string }; start: { after: number; session: unknown } };
      };
      // Built at run time, so the test runner's own module rewrite never reaches the page's import.
      const load = new Function("path", "return import(path)") as (path: string) => Promise<typeof import("../src/protocol/store")>;
      const { useStore } = await load("/src/protocol/store.ts");
      const api = useStore.getState().api!;
      const watchers = new Set<(e: unknown) => void>();
      let clock = -1;
      const play = (from: number, to: number, base: number) => {
        for (const { ms, event } of rec.events.filter(e => e.ms >= from && e.ms < to)) {
          setTimeout(() => {
            clock = Math.max(clock, ms);
            for (const fn of watchers) fn(event);
          }, ms - base);
        }
      };
      const at = (ms: number) => new Promise(r => setTimeout(r, ms));
      const stopAt = rec.events.find(e => e.event.type === "session.done")!.ms - 950;
      const sendAt = rec.events.find(e => e.event.type === "session.held")!.ms - 50;
      const w = window as unknown as { __replay: { started: number; stopped: boolean; sent: boolean } };
      w.__replay = { started: Date.now(), stopped: false, sent: false };
      useStore.setState({
        api: {
          ...api,
          subscribe: (fn: (e: unknown) => void) => {
            watchers.add(fn);
            return () => watchers.delete(fn);
          },
          sessionHistory: async (id: string) => (id === "ws_a" ? (rec.history as never) : []),
          listSessions: async () => (rec.lists.filter(l => l.ms <= clock).at(-1)?.rows ?? rec.lists[0]!.rows) as never,
          interruptSession: async () => {
            w.__replay.stopped = true;
            play(stopAt, sendAt, stopAt);
            await at(rec.replies.interrupt.after);
            return rec.replies.interrupt.outcome as never;
          },
          startSession: async (opts: { requestId?: string }) => {
            w.__replay.sent = true;
            // The recording's start names the send by the id the recorded composer made; this composer made its own.
            for (const { event } of rec.events) if ((event as { requestId?: string }).requestId !== undefined && opts.requestId !== undefined) (event as { requestId?: string }).requestId = opts.requestId;
            play(sendAt, Infinity, sendAt);
            await at(rec.replies.start.after);
            return rec.replies.start.session as never;
          },
        } as never,
      });
      useStore.getState().select("ws_a", rec.thread);
      await at(400);
      play(0, stopAt, 0);
    }, RECORDING);

    await page!.waitForSelector("[aria-label='Stop generation']", { timeout: 10_000 });
    await page!.waitForTimeout(2_000);
    await page!.locator("[data-chat-composer] [contenteditable=true]").click();
    await page!.keyboard.type("queued note two");
    await page!.keyboard.press("Enter");
    await page!.waitForSelector("[aria-label='Cancel queued message']", { timeout: 5_000 });
    await page!.locator("[aria-label='Stop generation']").click();
    await page!.waitForFunction(() => (window as unknown as { __replay: { sent: boolean } }).__replay.sent, undefined, { timeout: 10_000 });
    await page!.waitForTimeout(16_000);

    const rows = await onScreen(page!);
    expect(rows.some(r => r.startsWith("queued note two"))).toBe(true);
    expect(rows.filter(r => r.startsWith("Working for"))).toEqual([]);
    expect(rows.at(-1)).toContain("I'm not sure what you mean");
  }, 60_000);
});
