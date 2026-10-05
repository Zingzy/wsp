// SPDX-License-Identifier: AGPL-3.0-only
// Measures a thread switch in the web app against a throwaway host, for wsp-map#1694.
//
// It writes a state file into a temp folder, seeds one local workspace with threads
// whose events come from a Claude Code session file of the caller's own (tiled to the
// sizes asked for, ids and stamps minted fresh), starts the built wsp command on that
// state alone (a bare environment, --state, no WSP_HOME), serves the app either from
// a vite dev server on its own port or from the release build, and drives tile clicks
// in headless Chromium. Every step from the click to the first painted message is
// timed inside the page: the request leaving, the reply landing with its bytes, the
// first frame that shows a message row. A second socket from node times the host's
// own read of the same history. A streaming phase injects real deltas into the page's
// socket for N threads and counts React commits, component renders and main-thread
// lag per second, then switches again under that load.
//
//   node scripts/thread-switch-bench.mjs --mode dev|release --seed <session.jsonl> [--out <file.json>]
//     [--switches 12] [--stream 8] [--rate 6] [--vite-port 5180] [--port 4700] [--ws-port 4710] [--keep]
//
// It stops everything it started and checks the pids are gone before it exits.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_BIN = join(REPO, "packages", "host", "dist", "bin.js");
const HOST_PACKAGE = join(REPO, "packages", "host", "dist", "index.js");
const WEB_DIR = join(REPO, "apps", "web");
const require = createRequire(join(WEB_DIR, "package.json"));
const { chromium } = require("playwright");
const WebSocket = createRequire(join(REPO, "packages", "host", "package.json"))("ws");
const { thisComputersPath } = await import(pathToFileURL(HOST_PACKAGE).href);

const LOADING_WORDS = "Loading transcript";

function args(argv) {
  const out = { mode: "dev", switches: 12, stream: 8, rate: 6, vitePort: 5180, port: 4700, wsPort: 4710, keep: false, seed: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--mode": out.mode = value; i += 1; break;
      case "--seed": out.seed.push(resolve(value)); i += 1; break;
      case "--out": out.out = resolve(value); i += 1; break;
      case "--switches": out.switches = Number(value); i += 1; break;
      case "--stream": out.stream = Number(value); i += 1; break;
      case "--rate": out.rate = Number(value); i += 1; break;
      case "--vite-port": out.vitePort = Number(value); i += 1; break;
      case "--port": out.port = Number(value); i += 1; break;
      case "--ws-port": out.wsPort = Number(value); i += 1; break;
      case "--keep": out.keep = true; break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (out.seed.length === 0) throw new Error("--seed names a Claude Code session .jsonl of your own; at least one");
  if (out.mode !== "dev" && out.mode !== "release") throw new Error("--mode is dev or release");
  return out;
}

// --- seed: a Claude Code session file into wsp session events -------------------------------------------------

/** The turns a session file holds: each one the person's prompt and the blocks the agent wrote after it. */
function turnsOf(path) {
  const turns = [];
  let turn = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== "user" && row.type !== "assistant") continue;
    const content = row.message?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    if (row.type === "user") {
      const results = blocks.filter(b => b.type === "tool_result");
      if (results.length > 0 && turn !== null) {
        for (const b of results) {
          const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map(c => c.text ?? "").join("\n") : "";
          turn.blocks.push({ kind: "tool_result", text, toolUseId: b.tool_use_id, isError: b.is_error === true });
        }
        continue;
      }
      if (row.isMeta === true) continue;
      const prompt = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      if (prompt === "") continue;
      turn = { prompt, blocks: [], model: null };
      turns.push(turn);
      continue;
    }
    if (turn === null) continue;
    turn.model ??= row.message?.model ?? null;
    for (const b of blocks) {
      if (b.type === "text") turn.blocks.push({ kind: "text", text: b.text ?? "" });
      else if (b.type === "thinking") turn.blocks.push({ kind: "thinking", text: b.thinking ?? "" });
      else if (b.type === "tool_use") turn.blocks.push({ kind: "tool_use", text: JSON.stringify(b.input ?? {}), toolName: b.name, toolUseId: b.id });
    }
  }
  // A builder's turn is one prompt and hundreds of calls; a chat's is a few blocks. Both shapes are wanted, so a
  // turn past 80 blocks is cut at its text blocks into turns of 20 to 80, the cut's last words standing as the prompt.
  const sized = [];
  for (const t of turns) {
    if (t.blocks.length <= 80) { sized.push(t); continue; }
    let piece = { prompt: t.prompt, blocks: [], model: t.model };
    for (const b of t.blocks) {
      piece.blocks.push(b);
      if (piece.blocks.length >= 20 && b.kind === "text" || piece.blocks.length >= 80) {
        sized.push(piece);
        piece = { prompt: b.kind === "text" ? b.text.split("\n")[0].slice(0, 200) : t.prompt, blocks: [], model: t.model };
      }
    }
    if (piece.blocks.length > 0) sized.push(piece);
  }
  return sized.filter(t => t.blocks.length > 0);
}

/** One thread of about `target` events, tiled from the real turns with fresh ids, ending `endMinutesAgo` ago. */
function makeThread({ name, harness, model, turns, target, workspaceId, cwd, endMinutesAgo, startedBy = "person" }) {
  const threadId = randomUUID();
  const events = [];
  const rows = [];
  let i = 0;
  // Three seconds per event, so a thread of thousands of events spans the hours a real builder runs.
  let at = Date.now() - endMinutesAgo * 60_000 - target * 3_000;
  while (events.length < target) {
    const turn = turns[i % turns.length];
    i += 1;
    const sid = randomUUID();
    const turnId = randomUUID();
    const scope = { workspaceId, sessionId: sid, threadId, turnId };
    const startedAt = at;
    events.push({ type: "session.start", ...scope, at, prompt: turn.prompt, model, cwd, permissionMode: "bypassPermissions", agent: harness, harness: { permissionMode: "bypassPermissions" } });
    let reply = "";
    for (const b of turn.blocks) {
      at += 3_000;
      events.push({ type: "session.delta", ...scope, at, kind: b.kind, text: b.text, ...(b.toolName ? { toolName: b.toolName } : {}), ...(b.toolUseId ? { toolUseId: b.toolUseId } : {}), ...(b.isError ? { isError: true } : {}) });
      if (b.kind === "text") reply = b.text;
    }
    at += 3_000;
    events.push({ type: "session.done", ...scope, at, result: { status: "completed", durationMs: at - startedAt, costUsd: 0.12, text: reply } });
    events.push({ type: "session.end", ...scope, at, exitCode: 0, sawResult: true });
    rows.push({ id: sid, workspaceId, harness, status: "completed", startedBy, threadId, turnId, prompt: turn.prompt, harnessTitle: name, titleSource: "harness", startedAt, endedAt: at, cwd, model, permissionMode: "bypassPermissions", costUsd: 0.12 });
    at += 3_000;
  }
  return { threadId, name, harness, events, rows };
}

function seedDocuments({ workspaceId, cwd, seeds }) {
  const turns = seeds.flatMap(turnsOf);
  if (turns.length === 0) throw new Error("the seed files hold no turns");
  const plan = [
    { name: "long-claude", harness: "claude", model: "opus", target: 2000, endMinutesAgo: 5 },
    { name: "long-codex", harness: "codex", model: "gpt-5.6-sol", target: 2000, endMinutesAgo: 12 },
    ...Array.from({ length: 10 }, (_, k) => ({ name: `small-${k + 1}`, harness: k % 2 ? "codex" : "claude", model: k % 2 ? "gpt-5.6-sol" : "opus", target: 100, endMinutesAgo: 20 + k * 7 })),
  ];
  const threads = plan.map(p => makeThread({ ...p, turns, workspaceId, cwd }));
  const events = threads.flatMap(t => t.events).sort((a, b) => a.at - b.at);
  const rows = threads.flatMap(t => t.rows).sort((a, b) => a.startedAt - b.startedAt);
  return {
    sessions: { workspaceId, sessions: rows, threads: Object.fromEntries(threads.map(t => [t.threadId, { harness: t.harness, permissionMode: "bypassPermissions" }])) },
    transcripts: { workspaceId, events },
    threads: threads.map(t => ({ threadId: t.threadId, name: t.name, harness: t.harness, events: t.events.length, bytes: Buffer.byteLength(JSON.stringify(t.events)), rows: t.rows.length })),
    turns: turns.length,
    pool: deltaPool(events),
  };
}

/** Real deltas to stream back in, by kind, scope stripped. */
function deltaPool(events) {
  return events.filter(e => e.type === "session.delta").map(({ workspaceId: _w, sessionId: _s, threadId: _t, turnId: _u, at: _a, ...rest }) => rest).slice(0, 2000);
}

// --- processes -------------------------------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitHttp(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fetch(url).then(r => r.ok, () => false)) return;
    await sleep(150);
  }
  throw new Error(`${url} did not answer in ${ms} ms`);
}

function devIndex(vitePort) {
  const origin = `http://127.0.0.1:${vitePort}`;
  return `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>wsp</title>
    <script type="module">
      import RefreshRuntime from "${origin}/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="${origin}/@vite/client"></script>
  </head>
  <body>
    <div id="root"></div>
    <script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
    <script type="module" src="${origin}/src/main.tsx"></script>
  </body>
</html>
`;
}

function viteConfig(vitePort) {
  return `import { mergeConfig } from "vite";
import base from "./vite.config.js";
export default env => mergeConfig(base(env), { server: { host: "127.0.0.1", port: ${vitePort}, strictPort: true, origin: "http://127.0.0.1:${vitePort}" } });
`;
}

const started = [];
const tempFiles = [];
function start(name, cmd, argv, opts) {
  const child = spawn(cmd, argv, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  child.stdout.on("data", d => log.push(String(d)));
  child.stderr.on("data", d => log.push(String(d)));
  started.push({ name, child, log });
  return { child, log };
}

async function stopAll() {
  for (const f of tempFiles) rmSync(f, { force: true });
  for (const { child } of started.reverse()) {
    if (child.exitCode !== null) continue;
    const gone = new Promise(r => child.once("exit", r));
    child.kill("SIGTERM");
    if (await Promise.race([gone.then(() => true), sleep(5_000).then(() => false)])) continue;
    child.kill("SIGKILL");
    await gone;
  }
  const alive = started.filter(({ child }) => {
    try { process.kill(child.pid, 0); return true; } catch { return false; }
  });
  return { pids: started.map(s => ({ name: s.name, pid: s.child.pid })), alive: alive.map(s => s.child.pid) };
}

// --- starting the host --------------------------------------------------------------------------------------------

/** Starts the built wsp command on the state file and answers once the lock names this very process and the page
 * answers: the token file is rewritten after the port opens, so a read before the lock names the new pid gets the
 * previous run's token (measured here: the socket refused it). */
async function startHost({ statePath, home, port, wsPort, webDir }) {
  const stateDir = dirname(statePath);
  const env = { PATH: thisComputersPath(process.env.PATH), HOME: home, WSP_PROVIDER: "none", WSP_WEB_DIR: webDir };
  const host = start("host", process.execPath, [HOST_BIN, "up", "--state", statePath, "--port", String(port), "--ws-port", String(wsPort), "--no-relay", "--provider", "none"], { cwd: home, env });
  const deadline = Date.now() + 60_000;
  const lockPath = join(stateDir, "host.lock");
  while (Date.now() < deadline) {
    if (host.child.exitCode !== null) throw new Error(`the host exited with ${host.child.exitCode}:\n${host.log.join("")}`);
    let lock;
    try { lock = JSON.parse(readFileSync(lockPath, "utf8")); } catch { lock = undefined; }
    if (lock?.pid === host.child.pid && (await fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false))) break;
    await sleep(150);
  }
  await sleep(300);
  return { ...host, token: readFileSync(join(stateDir, "host-token"), "utf8").trim() };
}

async function stopOne(host) {
  if (host.child.exitCode !== null) return;
  const gone = new Promise(r => host.child.once("exit", r));
  host.child.kill("SIGTERM");
  if (!(await Promise.race([gone.then(() => true), sleep(8_000).then(() => false)]))) { host.child.kill("SIGKILL"); await gone; }
}

/** One socket as the owner: auth, then each request in turn. */
async function asOwner(wsPort, token, run) {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`);
  await new Promise((ok, no) => { ws.once("open", ok); ws.once("error", no); });
  let seq = 0;
  const pending = new Map();
  ws.on("message", data => {
    const text = String(data);
    const m = JSON.parse(text);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); if (m.ok === false) p.reject(new Error(`${p.op}: ${m.error}`)); else p.resolve({ m, bytes: Buffer.byteLength(text), at: performance.now() }); }
  });
  const request = o => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, op: o.op }); ws.send(JSON.stringify({ id, ...o })); });
  const auth = new Promise((resolve, reject) => { pending.set(0, { resolve, reject, op: "auth" }); });
  ws.send(JSON.stringify({ id: 0, op: "auth", token }));
  await auth;
  try { return await run(request); } finally { ws.close(); }
}

// --- the host's own read, timed from node ----------------------------------------------------------------------

async function hostRead({ wsPort, token, workspaceId, times }) {
  return asOwner(wsPort, token, async request => {
    const samples = { history: [], list: [] };
    for (let i = 0; i < times; i += 1) {
      let t0 = performance.now();
      let r = await request({ op: "sessions.history", workspaceId });
      samples.history.push({ ms: r.at - t0, bytes: r.bytes, events: r.m.events?.length ?? 0 });
      t0 = performance.now();
      r = await request({ op: "sessions.list", workspaceId });
      samples.list.push({ ms: r.at - t0, bytes: r.bytes, rows: r.m.sessions?.length ?? 0 });
    }
    return samples;
  });
}

// --- the page --------------------------------------------------------------------------------------------------

/** Runs before the app: the device token, a WebSocket wrapper that stamps requests and replies and can inject
 * frames, a React DevTools hook that counts commits and rendered components, and a lag probe. */
function pageProbe(token) {
  return `(() => {
    window.localStorage.setItem("wsp:device-token", ${JSON.stringify(token)});
    const bench = { requests: [], pending: new Map(), events: [], sockets: [], commits: [], renders: new Map(), cascades: new Map(), lag: [], lastHistory: null, countRenders: false };
    window.__bench = bench;
    const Orig = window.WebSocket;
    function Wrapped(url, protocols) {
      const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
      bench.sockets.push(ws);
      const send = ws.send.bind(ws);
      ws.send = data => {
        if (typeof data === "string") {
          const m = /^\\{"id":(\\d+),"op":"([^"]+)"/.exec(data) ?? /"id":(\\d+).*?"op":"([^"]+)"/.exec(data.slice(0, 200));
          if (m !== null) bench.pending.set(Number(m[1]), { op: m[2], sentAt: performance.now() });
        }
        return send(data);
      };
      ws.addEventListener("message", e => {
        const data = e.data;
        if (typeof data !== "string") return;
        const t = performance.now();
        const head = data.slice(0, 120);
        const id = /"id":(\\d+)/.exec(head);
        if (id !== null && bench.pending.has(Number(id[1])) && /"ok":/.test(head)) {
          const p = bench.pending.get(Number(id[1]));
          bench.pending.delete(Number(id[1]));
          bench.requests.push({ ...p, gotAt: t, bytes: data.length });
          if (p.op === "sessions.history") bench.lastHistory = data;
          return;
        }
        const type = /"type":"([^"]+)"/.exec(head);
        if (type !== null) bench.events.push({ t, type: type[1], bytes: data.length });
      });
      return ws;
    }
    Wrapped.prototype = Orig.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Wrapped[k] = Orig[k];
    window.WebSocket = Wrapped;
    bench.inject = frame => {
      const ws = bench.sockets[bench.sockets.length - 1];
      ws.onmessage({ data: JSON.stringify(frame) });
    };
    const hook = {
      isDisabled: false,
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer) { const id = hook.renderers.size + 1; hook.renderers.set(id, renderer); return id; },
      onScheduleFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
      setStrictMode() {},
      onCommitFiberRoot(_id, root) {
        const t = performance.now();
        let rendered = 0;
        let sawRow = false;
        if (bench.countRenders) {
          const stack = [root.current];
          while (stack.length > 0) {
            const f = stack.pop();
            if ((f.flags & 1) !== 0 && (f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15)) {
              rendered += 1;
              const name = f.type?.displayName ?? f.type?.name ?? f.type?.render?.name ?? f.type?.type?.name ?? "(anon)";
              bench.renders.set(name, (bench.renders.get(name) ?? 0) + 1);
              // Where a sidebar row's re-render started: the highest ancestor that rendered in this commit.
              if (name === "ThreadRow" && !sawRow) {
                sawRow = true;
                let top = null;
                for (let up = f.return; up !== null; up = up.return) if ((up.flags & 1) !== 0 && (up.tag === 0 || up.tag === 1 || up.tag === 11 || up.tag === 14 || up.tag === 15)) top = up;
                const topName = top === null ? "ThreadRow itself" : top.type?.displayName ?? top.type?.name ?? "(anon)";
                bench.cascades.set(topName, (bench.cascades.get(topName) ?? 0) + 1);
                // Which of that component's hooks changed value since its last render, by position in the hook list.
                if (top !== null && top.alternate !== null) {
                  let a = top.memoizedState, b = top.alternate.memoizedState, i = 0;
                  while (a !== null && b !== null) {
                    if (a.memoizedState !== b.memoizedState && !(a.memoizedState && typeof a.memoizedState === "object" && "destroy" in a.memoizedState)) {
                      const key = topName + "#" + i;
                      bench.cascades.set(key, (bench.cascades.get(key) ?? 0) + 1);
                    }
                    a = a.next; b = b.next; i += 1;
                  }
                }
              }
            }
            if (f.child) stack.push(f.child);
            if (f.sibling) stack.push(f.sibling);
          }
        }
        bench.commits.push({ t, rendered });
      },
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    let expected = performance.now() + 50;
    setInterval(() => { const now = performance.now(); bench.lag.push({ t: now, lag: Math.max(0, now - expected) }); expected = now + 50; }, 50);
    bench.longTasks = [];
    try { new PerformanceObserver(list => { for (const e of list.getEntries()) bench.longTasks.push({ t: e.startTime, ms: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
  })();`;
}

/** Clicks the tile and watches frames until a message row of the thread paints. Runs inside the page. */
const SWITCH_IN_PAGE = async ([rowId, loadingWords]) => {
  const bench = window.__bench;
  const el = document.querySelector('[data-row-id="' + rowId + '"]');
  if (el === null) return { error: "no tile " + rowId };
  const before = new Set([...document.querySelectorAll("[data-timeline-row-id]")].map(n => n.getAttribute("data-timeline-row-id")));
  const reqStart = bench.requests.length;
  const commitStart = bench.commits.length;
  const longStart = bench.longTasks.length;
  const t0 = performance.now();
  el.click();
  let loadingAt = null;
  let paintAt = null;
  let frames = 0;
  await new Promise(resolve => {
    const tick = () => {
      frames += 1;
      const now = performance.now();
      const root = document.querySelector("[data-timeline-root]");
      const loading = root === null || [...document.querySelectorAll("div")].some(d => d.childElementCount === 0 && d.textContent === loadingWords);
      if (loading && loadingAt === null) loadingAt = now;
      const rows = root === null ? [] : [...root.querySelectorAll("[data-timeline-row-id]")];
      const fresh = rows.some(r => !before.has(r.getAttribute("data-timeline-row-id")));
      if (!loading && rows.length > 0 && (loadingAt !== null || fresh)) { paintAt = now; resolve(); return; }
      if (now - t0 > 30000) { resolve(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const requests = bench.requests.slice(reqStart).map(r => ({ ...r, sentAt: r.sentAt - t0, gotAt: r.gotAt - t0 }));
  const commits = bench.commits.slice(commitStart).filter(c => c.t <= (paintAt ?? Infinity)).length;
  const longMs = bench.longTasks.slice(longStart).reduce((a, l) => a + l.ms, 0);
  return { rowId, loadingAt: loadingAt === null ? null : loadingAt - t0, paintAt: paintAt === null ? null : paintAt - t0, frames, requests, commits, longMs, rowsPainted: document.querySelectorAll("[data-timeline-row-id]").length };
};

const PARSE_IN_PAGE = () => {
  const data = window.__bench.lastHistory;
  if (data === null) return null;
  const t0 = performance.now();
  const parsed = JSON.parse(data);
  const t1 = performance.now();
  return { bytes: data.length, events: parsed.events.length, parseMs: t1 - t0 };
};

/** Streams real deltas into the page for `threads` threads at `rate` events per second each, for `seconds`. */
const STREAM_IN_PAGE = async ({ workspaceId, threads, pool, rate, seconds, turnEvery }) => {
  const bench = window.__bench;
  bench.commits.length = 0; bench.renders.clear(); bench.cascades.clear(); bench.lag.length = 0; bench.longTasks.length = 0; bench.requests.length = 0;
  bench.countRenders = true;
  const t0 = performance.now();
  const scopes = threads.map(t => ({ workspaceId, threadId: t.threadId, sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() }));
  for (const s of scopes) bench.inject({ type: "session.start", ...s, at: Date.now(), prompt: "keep going", model: "opus", cwd: "/tmp", permissionMode: "bypassPermissions", agent: "claude" });
  let i = 0;
  let sent = 0;
  let lastTurn = t0;
  const period = 1000 / rate;
  await new Promise(resolve => {
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - t0 > seconds * 1000) { clearInterval(timer); resolve(); return; }
      for (const s of scopes) {
        const d = pool[i % pool.length]; i += 1;
        bench.inject({ type: "session.delta", ...s, at: Date.now(), ...d });
        sent += 1;
      }
      if (turnEvery > 0 && now - lastTurn > turnEvery * 1000) {
        lastTurn = now;
        const s = scopes[i % scopes.length];
        bench.inject({ type: "session.end", ...s, at: Date.now(), exitCode: 0, sawResult: true });
        s.sessionId = crypto.randomUUID(); s.turnId = crypto.randomUUID();
        bench.inject({ type: "session.start", ...s, at: Date.now(), prompt: "next", model: "opus", cwd: "/tmp", permissionMode: "bypassPermissions", agent: "claude" });
      }
    }, period);
  });
  const dur = (performance.now() - t0) / 1000;
  bench.countRenders = false;
  const lagMs = bench.lag.reduce((a, l) => a + l.lag, 0);
  const incoming = {};
  for (const e of bench.events) if (e.t >= t0) incoming[e.type] = (incoming[e.type] ?? 0) + 1;
  for (const k of Object.keys(incoming)) incoming[k] = +(incoming[k] / dur).toFixed(1);
  const renders = [...bench.renders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, n]) => ({ name, perSec: +(n / dur).toFixed(1) }));
  const cascades = [...bench.cascades.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name, n]) => ({ from: name, commits: n }));
  return { seconds: +dur.toFixed(1), eventsPerSec: +(sent / dur).toFixed(1), incomingPerSec: incoming, commitsPerSec: +(bench.commits.length / dur).toFixed(1), renderedPerSec: +(bench.commits.reduce((a, c) => a + c.rendered, 0) / dur).toFixed(0), lagPct: +((lagMs / (dur * 1000)) * 100).toFixed(1), longTaskMsPerSec: +(bench.longTasks.reduce((a, l) => a + l.ms, 0) / dur).toFixed(0), listRequests: bench.requests.filter(r => r.op === "sessions.list").length, renders, cascades };
};

const stats = xs => {
  const s = [...xs].filter(x => typeof x === "number").sort((a, b) => a - b);
  if (s.length === 0) return null;
  const at = q => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
  return { n: s.length, min: +s[0].toFixed(1), median: +at(0.5).toFixed(1), p90: +at(0.9).toFixed(1), max: +s[s.length - 1].toFixed(1) };
};

async function main() {
  const a = args(process.argv.slice(2));
  if (!existsSync(HOST_BIN)) throw new Error(`${HOST_BIN} is not built: pnpm --filter @wsp/host build`);
  const tmp = mkdtempSync(join(tmpdir(), "wsp-1694-"));
  const home = join(tmp, "home");
  const stateDir = join(tmp, "wsp");
  mkdirSync(home, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, "state.json");

  let webDir;
  if (a.mode === "dev") {
    webDir = join(tmp, "web");
    mkdirSync(webDir);
    writeFileSync(join(webDir, "index.html"), devIndex(a.vitePort));
    // Beside the app, not in the temp folder: the config imports vite and the app's own config, which node resolves
    // from the file's own folder; removed on exit.
    const cfg = join(WEB_DIR, `.vite.bench.${process.pid}.config.mjs`);
    writeFileSync(cfg, viteConfig(a.vitePort));
    tempFiles.push(cfg);
    start("vite", join(REPO, "node_modules", ".bin", "vite"), ["--config", cfg], { cwd: WEB_DIR, env: { ...process.env } });
    await waitHttp(`http://127.0.0.1:${a.vitePort}/src/main.tsx`, 60_000);
  } else {
    webDir = join(WEB_DIR, "dist");
    if (!existsSync(join(webDir, "index.html"))) throw new Error("apps/web/dist is not built: pnpm --filter @wsp/web build");
  }

  // The project and the workspace are the host's own to record, so their records are in the shape it reads: a
  // first host on an empty state takes them over its socket, then stops, and the transcript is written under the
  // workspace id it minted before a second host reads the file.
  const proj = join(home, "proj");
  mkdirSync(proj);
  writeFileSync(join(proj, "README.md"), "bench\n");
  const git = argv => execFileSync("git", argv, { cwd: proj, env: { ...process.env, GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.invalid" }, stdio: "pipe" });
  git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "init"]);
  const first = await startHost({ statePath, home, port: a.port, wsPort: a.wsPort, webDir });
  const made = await asOwner(a.wsPort, first.token, async request => {
    const project = (await request({ op: "projects.add", source: proj })).m.project;
    const workspace = (await request({ op: "workspaces.create", project: project.id, name: "bench" })).m.workspace;
    return { workspaceId: workspace.id, cwd: workspace.folder ?? proj };
  });
  await stopOne(first);
  const seeded = seedDocuments({ workspaceId: made.workspaceId, cwd: made.cwd, seeds: a.seed });
  seeded.workspaceId = made.workspaceId;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.sessions = { [made.workspaceId]: seeded.sessions };
  state.transcripts = { [made.workspaceId]: seeded.transcripts };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const stateBytes = Buffer.byteLength(JSON.stringify(state, null, 2));
  console.log(`state ${statePath}: ${(stateBytes / 1e6).toFixed(1)} MB, ${seeded.turns} real turns tiled into ${seeded.threads.length} threads, ${seeded.threads.reduce((n, t) => n + t.events, 0)} events`);

  const host = await startHost({ statePath, home, port: a.port, wsPort: a.wsPort, webDir });
  const base = `http://127.0.0.1:${a.port}`;
  const token = host.token;
  // The Mac is shared with other sessions' builders, so every run says what load it ran under.
  const result = { mode: a.mode, at: new Date().toISOString(), loadAtStart: loadavg().map(x => +x.toFixed(1)), cpus: cpus().length, stateBytes, threads: seeded.threads, host: {}, switches: [], settings: null, streaming: [] };

  result.host = await hostRead({ wsPort: a.wsPort, token, workspaceId: seeded.workspaceId, times: 7 });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(pageProbe(token));
  const page = await context.newPage();
  page.on("pageerror", e => console.error("page error:", e.message));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator('[data-sidebar-row][data-row-id^="thread:"]').first().waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(1_500);
  const tiles = await page.evaluate(() => [...document.querySelectorAll('[data-sidebar-row][data-row-id^="thread:"]')].map(n => n.getAttribute("data-row-id")));
  const byName = Object.fromEntries(seeded.threads.map(t => [t.name, `thread:${t.threadId}`]));
  const want = ["long-claude", "long-codex", "small-1", "small-2"].map(n => byName[n]).filter(id => tiles.includes(id));
  if (want.length < 2) throw new Error(`the sidebar shows ${tiles.length} tiles and none of the seeded long ones: ${tiles.join(", ")}`);

  // The app opens the latest thread on its own, so the first click lands on a tile that is not in the loop: a click
  // on the open thread paints nothing new and would wait the whole timeout.
  const aside = byName["small-3"];
  if (tiles.includes(aside)) await page.evaluate(SWITCH_IN_PAGE, [aside, LOADING_WORDS]);
  await page.waitForTimeout(500);
  let open = aside;
  const order = [];
  for (let i = 0; i < a.switches; i += 1) order.push(want[i % want.length]);
  for (const rowId of order) {
    open = rowId;
    const one = (await page.evaluate(SWITCH_IN_PAGE, [rowId, LOADING_WORDS])) ?? { error: "the page answered nothing" };
    one.name = seeded.threads.find(t => `thread:${t.threadId}` === rowId)?.name;
    console.log(`switch to ${one.name}: ${one.error ?? `loading at ${one.loadingAt?.toFixed(0)} ms, paint at ${one.paintAt?.toFixed(0)} ms, ${one.requests.map(r => `${r.op} ${(r.gotAt - r.sentAt).toFixed(0)} ms ${r.bytes} B`).join(", ")}`}`);
    result.switches.push(one);
    await page.waitForTimeout(400);
  }
  result.parse = await page.evaluate(PARSE_IN_PAGE);

  // Settings and back: does the transcript come again?
  {
    const open = seeded.threads.find(t => `thread:${t.threadId}` === order[order.length - 1]);
    const before = await page.evaluate(() => window.__bench.requests.length);
    await page.locator('[data-k="settings-row"]').click();
    await page.locator('[data-k="settings-back"]').waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(300);
    const back = await page.evaluate(async ([loadingWords]) => {
      const bench = window.__bench;
      const t0 = performance.now();
      document.querySelector('[data-k="settings-back"]').click();
      let loadingAt = null; let paintAt = null;
      await new Promise(resolve => {
        const tick = () => {
          const now = performance.now();
          const root = document.querySelector("[data-timeline-root]");
          const loading = root === null || [...document.querySelectorAll("div")].some(d => d.childElementCount === 0 && d.textContent === loadingWords);
          if (loading && loadingAt === null) loadingAt = now;
          if (!loading && root !== null && root.querySelectorAll("[data-timeline-row-id]").length > 0) { paintAt = now; resolve(); return; }
          if (now - t0 > 60000) { resolve(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { loadingAt: loadingAt === null ? null : loadingAt - t0, paintAt: paintAt === null ? null : paintAt - t0, requests: bench.requests.map(r => r.op) };
    }, [LOADING_WORDS]);
    result.settings = { thread: open?.name, historyRequestsDuringRoundTrip: back.requests.slice(before).filter(op => op === "sessions.history").length, loadingAt: back.loadingAt, paintAt: back.paintAt };
  }

  // Streaming: N threads streaming while another is open, then a switch under load.
  const streamThreads = seeded.threads.filter(t => t.name.startsWith("small-")).slice(0, Math.max(a.stream, 0));
  const counts = [...new Set([0, 1, 4, streamThreads.length].map(n => Math.min(n, streamThreads.length)))];
  for (const n of counts) {
    if (n === 0) {
      const idle = await page.evaluate(STREAM_IN_PAGE, { workspaceId: seeded.workspaceId, threads: [], pool: seeded.pool.slice(0, 50), rate: a.rate, seconds: 6, turnEvery: 0 });
      result.streaming.push({ threads: 0, ...idle });
      continue;
    }
    const load = await page.evaluate(STREAM_IN_PAGE, { workspaceId: seeded.workspaceId, threads: streamThreads.slice(0, n), pool: seeded.pool.slice(0, 600), rate: a.rate, seconds: 10, turnEvery: 3 });
    const target = want.find(id => id !== open);
    open = target;
    const under = await page.evaluate(SWITCH_IN_PAGE, [target, LOADING_WORDS]);
    result.streaming.push({ threads: n, ...load, switchUnderLoad: { to: seeded.threads.find(t => `thread:${t.threadId}` === target)?.name, paintAt: under.paintAt, loadingAt: under.loadingAt, longMs: under.longMs } });
    await page.waitForTimeout(500);
  }
  // The open thread itself streaming: every delta lands in the view that is drawn.
  {
    const openThread = seeded.threads.find(t => `thread:${t.threadId}` === open);
    const own = await page.evaluate(STREAM_IN_PAGE, { workspaceId: seeded.workspaceId, threads: [openThread], pool: seeded.pool.slice(0, 600), rate: a.rate, seconds: 10, turnEvery: 0 });
    result.streaming.push({ threads: 1, openThread: openThread.name, ...own });
  }

  await browser.close();
  const stopped = await stopAll();
  result.stopped = stopped;
  if (!a.keep) rmSync(tmp, { recursive: true, force: true });

  const paint = stats(result.switches.map(s => s.paintAt));
  const reqs = result.switches.map(s => s.requests.find(r => r.op === "sessions.history")).filter(Boolean);
  result.loadAtEnd = loadavg().map(x => +x.toFixed(1));
  const summary = {
    mode: a.mode,
    load: { start: result.loadAtStart, end: result.loadAtEnd, cpus: result.cpus },
    hostHistoryMs: stats(result.host.history.map(h => h.ms)),
    hostHistoryBytes: result.host.history[0]?.bytes,
    hostHistoryEvents: result.host.history[0]?.events,
    hostListMs: stats(result.host.list.map(h => h.ms)),
    clickToRequestMs: stats(reqs.map(r => r.sentAt)),
    requestToReplyMs: stats(reqs.map(r => r.gotAt - r.sentAt)),
    replyToPaintMs: stats(result.switches.map(s => { const r = s.requests.find(x => x.op === "sessions.history"); return r && s.paintAt !== null ? s.paintAt - r.gotAt : undefined; })),
    clickToPaintMs: paint,
    parse: result.parse,
    settings: result.settings,
    streaming: result.streaming.map(({ renders: _r, ...rest }) => rest),
    stopped,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (a.out) writeFileSync(a.out, JSON.stringify({ summary, ...result }, null, 2));
  if (stopped.alive.length > 0) process.exitCode = 1;
}

main().catch(async e => {
  console.error(e.stack ?? String(e));
  for (const s of started) if (s.log.length > 0) console.error(`--- ${s.name}\n${s.log.join("").slice(-3000)}`);
  const stopped = await stopAll();
  console.error("stopped", JSON.stringify(stopped));
  process.exit(1);
});
