// SPDX-License-Identifier: AGPL-3.0-only
// Drags root trees in a running lab's sidebar with a real pointer and says what
// each drag cost: the longest task the renderer ran, off a CDP trace of the
// drags, and the JS heap after a forced collection, before the first drag and
// after each one. Each drag picks up the top tree of the list, carries it down
// across the list and back up, and drops it on the Pinned head, which stands
// only while a tree is dragged, then checks the tree landed there.
//
//   node drag-measure.mjs <lab> [--drags 5] [--throttle 4] [--out <file.json>]
//
// The lab is one `node lab.mjs start <lab> --fixture <fixture>` left running;
// this reads its address and its host's token off the lab's own files, drives a
// headless Chromium of its own, and closes it at the end.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { BROWSER_ARGS, HOST_PACKAGE } from "./host.mjs";
import { homeOf } from "./lab.mjs";
import { APP_UP } from "./ready.mjs";

/** Where a paired browser keeps the host's token, as run.mjs writes it. */
const DEVICE_TOKEN_KEY = "wsp:device-token";
/** A task this long or longer is one the speed bar counts. */
const BAR_MS = 100;

function parseArgs(argv) {
  const [lab, ...rest] = argv;
  if (lab === undefined || lab.startsWith("--")) throw new Error("usage: node drag-measure.mjs <lab> [--drags 5] [--throttle 4] [--out <file.json>]");
  const args = { lab, drags: 5, throttle: 1, out: undefined };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === "--drags") args.drags = Number(value);
    else if (flag === "--throttle") args.throttle = Number(value);
    else if (flag === "--out") args.out = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

/** The longest task on the page's own main thread in a trace: the renderer thread named CrRendererMain, the
 * RunTask events on it. */
function longestTask(events) {
  const main = new Set(events.filter(e => e.name === "thread_name" && e.args?.name === "CrRendererMain").map(e => `${e.pid}:${e.tid}`));
  const tasks = events.filter(e => e.name === "RunTask" && e.ph === "X" && main.has(`${e.pid}:${e.tid}`)).map(e => e.dur / 1000);
  return { longestMs: Math.max(0, ...tasks), overBar: tasks.filter(ms => ms >= BAR_MS).length };
}

async function heapAfterGc(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  return Math.round((usedSize / 1024 / 1024) * 100) / 100;
}

async function traced(cdp, run) {
  const events = [];
  const collect = ({ value }) => events.push(...value);
  cdp.on("Tracing.dataCollected", collect);
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,toplevel", transferMode: "ReportEvents" });
  await run();
  const done = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  await done;
  cdp.off("Tracing.dataCollected", collect);
  return events;
}

/** One drag: the top tree of the list picked up, carried down across the list and back, and held over Pinned.
 * Answers the tree's id and the drop, which lets go and waits for the tree to stand in Pinned. */
async function dragTopTreeOverPinned(page) {
  const item = page.locator("[data-section=threads] > ul > li[data-thread-item]").first();
  const row = item.locator("[draggable=true]").first();
  const id = await row.getAttribute("data-row-id");
  const tile = await row.boundingBox();
  const x = tile.x + tile.width / 2;
  const y = tile.y + tile.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 8, { steps: 2 });
  await page.waitForTimeout(150);
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(x, y + step * 52, { steps: 2 });
  const head = await page.locator("[data-section-head=pinned]").boundingBox({ timeout: 5_000 });
  if (head === null) throw new Error("no Pinned head stands while the tree is dragged: the drag ended as it began");
  await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2, { steps: 12 });
  const drop = async () => {
    await page.mouse.up();
    await page.locator(`[data-section=pinned] [data-row-id="${id}"]`).waitFor({ state: "attached", timeout: 10_000 });
  };
  return { id, drop };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = homeOf(args.lab);
  const facts = JSON.parse(readFileSync(join(home, "lab.json"), "utf8"));
  const { hostTokenFor } = await import(pathToFileURL(HOST_PACKAGE).href);
  const token = hostTokenFor(join(home, ".wsp", "state.json"));
  const browser = await chromium.launch({ args: BROWSER_ARGS });
  try {
    // Tall enough that the list's top tree and the Pinned head both stand on screen over two open pinned trees and
    // Needs you, so the drag is the pointer's and never the browser's edge scroll.
    const context = await browser.newContext({ viewport: { width: 1440, height: 1800 } });
    await context.addInitScript(([key, held]) => window.localStorage.setItem(key, held), [DEVICE_TOKEN_KEY, token]);
    const page = await context.newPage();
    await page.goto(facts.url, { waitUntil: "domcontentloaded" });
    await page.locator(APP_UP).first().waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("[data-section=threads] [draggable=true]").first().waitFor({ state: "visible", timeout: 30_000 });
    // The app reads the open thread's transcript and every project's landing as it comes up; the drags start once
    // that is done, so the first one is not timed against the page loading.
    await page.waitForTimeout(5_000);
    // The app scrolls the open thread's tile into view; the drags start from the top of the list, under Pinned.
    await page.locator("[data-slot=sidebar] [data-slot=scroll-area-viewport]").first().evaluate(el => void (el.scrollTop = 0));
    await page.waitForTimeout(300);
    const cdp = await context.newCDPSession(page);
    const threads = await page.locator("[data-slot=sidebar] [data-sidebar-row][data-row-id^='thread:']").count();
    const pinnedBefore = await page.locator("[data-section=pinned] > ul > li[data-thread-item]").count();
    const needsYou = await page.locator("[data-section=needs-you]:not([data-drop-only]) > ul > li[data-thread-item]").count();
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: args.throttle });
    const heap = [await heapAfterGc(cdp)];
    const drags = [];
    for (let n = 0; n < args.drags; n += 1) {
      let held;
      // When the drag began, so a task that lands on the minute, when the sidebar's clock draws every tile's age, is
      // told from the drag's own.
      const at = new Date().toISOString().slice(11, 23);
      // The drag itself, from the press to the pointer over Pinned, and then the drop and the tree landing, apart:
      // the speed bar is the drag's, and the drop is the one React draw it makes.
      const dragging = longestTask(await traced(cdp, async () => void (held = await dragTopTreeOverPinned(page))));
      const dropping = longestTask(
        await traced(cdp, async () => {
          await held.drop();
          await page.waitForTimeout(300);
        }),
      );
      drags.push({ at, landed: held.id, dragMs: dragging.longestMs, dragOverBar: dragging.overBar, dropMs: dropping.longestMs, dropOverBar: dropping.overBar });
      heap.push(await heapAfterGc(cdp));
    }
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const result = {
      lab: args.lab,
      fixture: facts.fixture,
      throttle: args.throttle,
      rowsDrawn: threads,
      pinnedBefore,
      needsYouBefore: needsYou,
      drags,
      longestDragMs: Math.max(...drags.map(d => d.dragMs)),
      longestDropMs: Math.max(...drags.map(d => d.dropMs)),
      heapMb: heap,
      laterDragsAddMb: Math.round((heap.at(-1) - heap[1]) * 100) / 100,
    };
    console.log(JSON.stringify(result, null, 2));
    if (args.out !== undefined) writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

await main();
