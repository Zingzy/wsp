// SPDX-License-Identifier: AGPL-3.0-only
// Drives a served wsp app through one scripted session and records every request the page makes: HTTP requests
// with their size, status and whether Chromium answered them from its cache, and every frame on the host socket with
// its op. Each record carries the step of the session it happened in, so a fetch can be read against what the person
// was doing. The host under test is any serving host; the device token is read off the file beside its state.
//
//   node scripts/audit-refetch.mjs run --url http://127.0.0.1:<port> --token-file <state dir>/host-token --out <dir> [--idle <seconds>] [--headed]
//   node scripts/audit-refetch.mjs summary <dir>
//
// The run writes requests.jsonl, ws.jsonl and steps.json into --out, then prints the summary. The summary alone
// reads a finished run again.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Playwright is the web app's own dev dependency, where its screenshot runner lives.
const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))("playwright");

const DEVICE_TOKEN_KEY = "wsp:device-token";
const SETTLE_MS = 3_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = name => process.argv.includes(`--${name}`);

async function run() {
  const url = arg("url");
  const tokenFile = arg("token-file");
  const out = arg("out");
  const idleSeconds = Number(arg("idle", "120"));
  if (!url || !tokenFile || !out) throw new Error("run needs --url, --token-file and --out");
  mkdirSync(out, { recursive: true });
  const requests = join(out, "requests.jsonl");
  const ws = join(out, "ws.jsonl");
  writeFileSync(requests, "");
  writeFileSync(ws, "");
  const steps = [];
  let step = "launch";
  const mark = name => {
    step = name;
    steps.push({ step: name, at: new Date().toISOString() });
    console.log(`${new Date().toISOString().slice(11, 19)} ${name}`);
  };

  const browser = await chromium.launch({ headless: !has("headed") });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(([key, held]) => window.localStorage.setItem(key, held), [DEVICE_TOKEN_KEY, readFileSync(tokenFile, "utf8").trim()]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");

  const live = new Map();
  cdp.on("Network.requestWillBeSent", e => {
    // A redirect arrives as the same request sent again; the leg that answered 302 is written out on its own, since
    // GitHub's login-to-avatar redirect is a request of its own on every render.
    const leg = live.get(e.requestId);
    if (leg !== undefined && e.redirectResponse !== undefined) {
      const h = Object.fromEntries(Object.entries(e.redirectResponse.headers).map(([k, v]) => [k.toLowerCase(), v]));
      appendFileSync(requests, JSON.stringify({ ...leg, status: e.redirectResponse.status, location: h["location"], cacheControl: h["cache-control"], cache: e.redirectResponse.fromDiskCache ? "disk" : "network", bytes: e.redirectResponse.encodedDataLength ?? 0, redirect: true }) + "\n");
    }
    live.set(e.requestId, { id: e.requestId, step, at: Date.now(), url: e.request.url, method: e.request.method, type: e.type, initiator: e.initiator?.type, cache: "network" });
  });
  cdp.on("Network.requestServedFromCache", e => {
    const r = live.get(e.requestId);
    if (r) r.cache = "memory";
  });
  cdp.on("Network.responseReceived", e => {
    const r = live.get(e.requestId);
    if (!r) return;
    const h = Object.fromEntries(Object.entries(e.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    Object.assign(r, {
      status: e.response.status,
      mime: e.response.mimeType,
      fromDiskCache: e.response.fromDiskCache === true,
      cacheControl: h["cache-control"],
      etag: h["etag"],
      expires: h["expires"],
      location: h["location"],
      ratelimitRemaining: h["x-ratelimit-remaining"],
    });
    if (e.response.fromDiskCache) r.cache = "disk";
    else if (r.cache !== "memory") r.cache = e.response.status === 304 ? "revalidated" : "network";
  });
  const finish = (e, failed) => {
    const r = live.get(e.requestId);
    if (!r) return;
    r.bytes = e.encodedDataLength ?? 0;
    if (failed) r.failed = e.errorText;
    live.delete(e.requestId);
    appendFileSync(requests, JSON.stringify(r) + "\n");
  };
  cdp.on("Network.loadingFinished", e => finish(e, false));
  cdp.on("Network.loadingFailed", e => finish(e, true));
  const frame = (dir, e) => {
    const payload = e.response.payloadData ?? "";
    let op;
    let id;
    let type;
    let inner;
    try {
      const parsed = JSON.parse(payload);
      op = parsed.op;
      id = parsed.id;
      type = parsed.type;
      // A daemon frame rides inside the host's: what the page asked the daemon, or what the daemon pushed.
      const carried = parsed.frame ?? parsed.event ?? parsed.reply;
      inner = carried === undefined ? undefined : (carried.op ?? carried.type ?? carried.kind);
      if (op === "daemon.send" && inner !== undefined) op = `daemon.send ${inner}`;
      if (type === "daemon.event" && inner !== undefined) type = `daemon.event ${inner}`;
    } catch {
      op = undefined;
    }
    appendFileSync(ws, JSON.stringify({ step, at: Date.now(), dir, bytes: payload.length, op, id, type }) + "\n");
  };
  cdp.on("Network.webSocketFrameSent", e => frame("sent", e));
  cdp.on("Network.webSocketFrameReceived", e => frame("received", e));

  const settle = (ms = SETTLE_MS) => page.waitForTimeout(ms);
  const click = async (selector, why) => {
    const el = page.locator(selector).first();
    await el.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
      throw new Error(`${why}: nothing visible at ${selector}`);
    });
    // A dispatched click, since a hover card over a row held a pointer click for its whole timeout.
    await el.scrollIntoViewIfNeeded().catch(() => undefined);
    await el.dispatchEvent("click");
  };
  const visibleAttrs = async attr => page.locator(`[${attr}]`).evaluateAll((els, a) => els.filter(e => e.offsetParent !== null).map(e => e.getAttribute(a)), attr);
  /** Opens a pane: off the empty panel's launcher, off the tab bar's menu when tabs are open, with the panel toggled
   * back on first when it is hidden. */
  const launch = async kind => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const direct = page.locator(`[data-surface-launch="${kind}"]`).first();
      if (await direct.isVisible().catch(() => false)) return direct.dispatchEvent("click");
      const menu = page.locator('[aria-label="Add a panel"]').first();
      if (await menu.isVisible().catch(() => false)) {
        await menu.dispatchEvent("click");
        await settle(800);
        const item = page.locator(`[role="menuitem"]`).filter({ hasText: paneWord(kind) }).first();
        if (await item.isVisible().catch(() => false)) return item.click();
        await page.keyboard.press("Escape");
      }
      // The panel is hidden; its toggle brings the launcher back.
      await page.keyboard.press("Meta+Alt+b");
      await settle(1_500);
      if ((await visibleAttrs("data-surface-launch")).length === 0) await page.keyboard.press("Meta+Alt+b");
      await settle(1_500);
    }
    throw new Error(`open the ${kind} pane: launchers visible: ${(await visibleAttrs("data-surface-launch")).join(",") || "none"}`);
  };
  const paneWord = kind => ({ preview: "Browser", terminal: "Terminal", diff: "Changes", pr: "Pull request", files: "Files", machine: "Computer", processes: "Processes", agents: "Agents" })[kind];
  const tiles = async () => {
    const ids = await page.locator('[data-row-id^="thread:"]').evaluateAll(els => els.map(el => el.getAttribute("data-row-id")));
    return [...new Set(ids)];
  };

  mark("load");
  // The load event waits on every module vite compiles on a first visit; the first tile is the sign the app is up.
  await page.goto(url, { waitUntil: "commit" });
  await page.locator('[data-row-id^="thread:"]').first().waitFor({ state: "visible", timeout: 180_000 });
  await settle(8_000);

  // Thread 1 is the one whose workspace has a pull request, read off the launcher its panel offers.
  mark("pick threads");
  const found = await tiles();
  console.log(`tiles: ${found.join(", ")}`);
  const rows = [];
  for (const row of found) {
    await click(`[data-row-id="${row}"]`, `look at ${row}`);
    await settle(4_000);
    const hasPr = await page.locator('[data-surface-launch="pr"]').first().isVisible().catch(() => false);
    if (hasPr) rows.unshift(row);
    else rows.push(row);
  }
  console.log(`thread 1 is ${rows[0]}`);
  mark("open thread 1");
  await click(`[data-row-id="${rows[0]}"]`, "open the first thread");
  await settle(6_000);

  const prPane = async () => {
  mark("pr pane open");
  await launch("pr");
  await page.locator("[data-pr-tabs]").waitFor({ state: "visible", timeout: 30_000 });
  await settle(6_000);
  for (const tab of ["commits", "files", "conversation", "commits", "files", "conversation"]) {
    mark(`pr tab ${tab}`);
    await click(`[data-pr-tabs] [data-segment="${tab}"]`, `the ${tab} tab`);
    await settle();
  }
  mark("pr pane close");
  await click('[data-right-panel-tab-list] button[aria-label^="Close Pull request"]', "close the pull request pane");
  await settle();
  mark("pr pane reopen");
  await launch("pr");
  await page.locator("[data-pr-tabs]").waitFor({ state: "visible", timeout: 30_000 });
  await settle(6_000);
  mark("pr refresh");
  await click("[data-pr-refresh]", "the refresh control");
  await settle(6_000);
  };
  await prPane().catch(e => console.log(`  pr pane: ${e.message}`));
  if (has("only-pr")) {
    mark("end");
    writeFileSync(join(out, "steps.json"), JSON.stringify(steps, null, 2));
    await browser.close();
    return summary(out);
  }

  if (rows.length > 1) {
    mark("switch to thread 2");
    await click(`[data-row-id="${rows[1]}"]`, "open the second thread");
    await settle(6_000);
    mark("switch back to thread 1");
    await click(`[data-row-id="${rows[0]}"]`, "open the first thread again");
    await settle(6_000);
  }

  for (const kind of ["diff", "files", "machine", "processes", "agents", "pr"]) {
    mark(`panel ${kind}`);
    await launch(kind).catch(e => console.log(`  ${kind}: ${e.message}`));
    await settle(5_000);
  }

  mark("settings open");
  await page.keyboard.press("Meta+,");
  await page.locator('[data-row-id^="group:"]').first().waitFor({ state: "visible", timeout: 15_000 });
  await settle();
  for (const group of ["general", "appearance", "agents", "computers", "projects", "usage", "devices", "account", "usage"]) {
    mark(`settings ${group}`);
    await click(`[data-row-id="group:${group}"]`, `the ${group} page`).catch(async e => console.log(`  ${e.message}; rows visible: ${(await visibleAttrs("data-row-id")).join(",")}`));
    await settle(4_000);
  }
  mark("settings close");
  await page.keyboard.press("Meta+,");
  await settle();

  mark(`idle ${idleSeconds}s`);
  await page.waitForTimeout(idleSeconds * 1_000);

  // Chromium's frozen lifecycle state is the one hide a script can ask for: the document reads hidden, timers stop as
  // they do for a window put away, and active brings it back with the visibilitychange a refocus fires.
  mark("hidden");
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await page.waitForTimeout(20_000);
  mark("refocus");
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  console.log(`  visibility after refocus: ${await page.evaluate(() => document.visibilityState)}`);
  await page.waitForTimeout(20_000);

  mark("end");
  writeFileSync(join(out, "steps.json"), JSON.stringify(steps, null, 2));
  await browser.close();
  summary(out);
}

/** One line per URL family in a step: GitHub's avatar redirect, the avatar host, the host's own routes, vite. */
function family(url) {
  const u = new URL(url);
  if (u.hostname === "github.com" && u.pathname.endsWith(".png")) return "github.com/<login>.png";
  if (u.hostname === "avatars.githubusercontent.com") return "avatars.githubusercontent.com";
  if (u.port === "5174" || u.port === "5173") return "vite";
  if (u.pathname.startsWith("/api/")) return `host ${u.pathname}`;
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return `host ${u.pathname.split("/").slice(0, 2).join("/")}`;
  return u.hostname;
}

function summary(out) {
  const lines = path => readFileSync(join(out, path), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const requests = lines("requests.jsonl");
  const frames = lines("ws.jsonl");
  const steps = JSON.parse(readFileSync(join(out, "steps.json"), "utf8"));
  const tally = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = key(r);
      const t = m.get(k) ?? { n: 0, bytes: 0, cached: 0 };
      t.n += 1;
      t.bytes += r.bytes ?? 0;
      if (r.cache && r.cache !== "network") t.cached += 1;
      m.set(k, t);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  };
  console.log("\n== HTTP by family (whole session)");
  for (const [k, t] of tally(requests.filter(r => family(r.url) !== "vite"), r => family(r.url))) console.log(`${String(t.n).padStart(5)}  ${String(t.bytes).padStart(9)} B  ${String(t.cached).padStart(4)} cached  ${k}`);
  console.log("\n== HTTP by step (vite left out)");
  for (const s of steps) {
    const rows = requests.filter(r => r.step === s.step && family(r.url) !== "vite");
    if (rows.length === 0) continue;
    console.log(`-- ${s.step}`);
    for (const [k, t] of tally(rows, r => family(r.url))) console.log(`${String(t.n).padStart(5)}  ${String(t.bytes).padStart(9)} B  ${String(t.cached).padStart(4)} cached  ${k}`);
  }
  console.log("\n== socket ops sent, by step");
  for (const s of steps) {
    const rows = frames.filter(f => f.step === s.step && f.dir === "sent" && f.op);
    if (rows.length === 0) continue;
    const ops = tally(rows, f => f.op).map(([k, t]) => `${k}×${t.n}`);
    console.log(`-- ${s.step}: ${ops.join(", ")}`);
  }
  console.log("\n== reply bytes by op (whole session)");
  const asked = new Map(frames.filter(f => f.dir === "sent" && f.id !== undefined).map(f => [f.id, f.op]));
  for (const [k, t] of tally(frames.filter(f => f.dir === "received" && f.id !== undefined), f => asked.get(f.id) ?? "?").sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 20)) console.log(`${String(t.n).padStart(5)}  ${String(t.bytes).padStart(9)} B  ${k}`);
  console.log("\n== socket frames received, by type (whole session)");
  for (const [k, t] of tally(frames.filter(f => f.dir === "received"), f => f.type ?? (f.id !== undefined ? "reply" : "other"))) console.log(`${String(t.n).padStart(5)}  ${String(t.bytes).padStart(9)} B  ${k}`);
  const avatars = requests.filter(r => family(r.url).startsWith("github.com/") || family(r.url).startsWith("avatars."));
  if (avatars.length > 0) {
    console.log("\n== avatar requests");
    for (const [k, t] of tally(avatars, r => `${family(r.url)} ${r.status} ${r.cache} cc=${r.cacheControl ?? "-"}`)) console.log(`${String(t.n).padStart(5)}  ${String(t.bytes).padStart(9)} B  ${k}`);
    const urls = new Set(avatars.map(r => r.url));
    console.log(`distinct avatar urls: ${urls.size}`);
  }
}

const mode = process.argv[2];
if (mode === "run") await run();
else if (mode === "summary") summary(process.argv[3]);
else {
  console.error("usage: node scripts/audit-refetch.mjs run --url <url> --token-file <file> --out <dir> [--idle <s>] [--headed] | summary <dir>");
  process.exit(2);
}
