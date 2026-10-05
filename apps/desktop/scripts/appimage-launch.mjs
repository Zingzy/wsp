// SPDX-License-Identifier: AGPL-3.0-only
// Starts a built AppImage once, as its desktop entry does, waits until the
// app's window has loaded its page, closes that window, which quits the app on
// Linux, and stops the service the launch installed. Exits 1 with what the app
// and its host printed when no page loaded or the app did not quit in time.
// Run it under a display: xvfb-run node appimage-launch.mjs <AppImage>
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { hostLogPath, runFailureLine, serviceManagerFor, stopService, systemRunner } from "@wsp/host";

if (process.argv[2] === undefined) throw new Error("usage: node appimage-launch.mjs <AppImage>");
const appImage = resolve(process.argv[2]);

const LOAD_MS = 180_000;
const QUIT_MS = 30_000;
/** One DevTools request: the endpoint answers off the app's main thread, which an error dialog holds. */
const ASK_MS = 2_000;
/** The two pages a launch opens: the app on its host, or the first launch's screen. */
const LOADED = /^http:\/\/127\.0\.0\.1:\d+\/$|\/onboarding\.html$/;
/** A line the runtime prints for each file it unpacks or finds unpacked already: hundreds, before the app says
 * anything. */
const UNPACKED = /^(?:\/\S*\/appimage_extracted_[0-9a-f]+(?:\/\S*)?|File exists and file size matches, skipping)$/;

// HOME stays the runner's own: systemd's user manager reads units from the real home alone, so a launch under a
// temp HOME writes a unit nothing loads. The state goes to a fresh folder, which also names a unit of its own.
const wspHome = mkdtempSync(join(tmpdir(), "wsp-appimage-"));
const statePath = join(wspHome, "state.json");
// The runtime unpacks the image and runs it from there instead of mounting it, which needs a libfuse2 a runner
// need not have. --no-sandbox is the argument electron-builder's desktop entry starts AppRun with.
const child = spawn(appImage, ["--no-sandbox", "--remote-debugging-port=0"], {
  env: { ...process.env, WSP_HOME: wspHome, APPIMAGE_EXTRACT_AND_RUN: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const said = [];
let devtools;
for (const stream of [child.stdout, child.stderr]) {
  let rest = "";
  stream.on("data", chunk => {
    const lines = (rest + chunk.toString()).split("\n");
    rest = lines.pop();
    for (const line of lines) {
      if (line.trim() === "" || UNPACKED.test(line)) continue;
      said.push(line);
      devtools ??= line.match(/^DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
    }
  });
}
let exited;
const exit = new Promise(resolve => {
  child.once("exit", (code, signal) => resolve((exited = signal ?? code)));
  child.once("error", e => resolve((exited = e.message)));
});
const from = Date.now();
const seconds = () => ((Date.now() - from) / 1000).toFixed(1);

/** The app window's page once the document has loaded, read off Chromium's own DevTools endpoint. */
async function loadedPage() {
  for (; Date.now() - from < LOAD_MS; await sleep(250)) {
    if (exited !== undefined) throw new Error(`the app exited (${exited}) after ${seconds()}s before a page loaded`);
    if (devtools === undefined) continue;
    const targets = await fetch(`http://127.0.0.1:${devtools}/json/list`, { signal: AbortSignal.timeout(ASK_MS) })
      .then(r => r.json())
      .catch(() => []);
    const page = targets.find(t => t.type === "page" && LOADED.test(t.url));
    if (page !== undefined && (await evaluate(page.webSocketDebuggerUrl, "document.readyState")) === "complete") return page;
  }
  throw new Error(`no page at ${LOADED} loaded within ${LOAD_MS / 1000}s`);
}

/** One expression run in a page, and its value, or nothing where none came in time; with no answer wanted, the
 * page may close before it could give one. */
async function evaluate(url, expression, answer = true) {
  const ws = new WebSocket(url);
  const asked = new Promise(resolve => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
      if (!answer) resolve(undefined);
    };
    ws.onmessage = m => resolve(JSON.parse(m.data).result?.result?.value);
    ws.onerror = () => resolve(undefined);
  });
  try {
    return await Promise.race([asked, sleep(ASK_MS, undefined, { ref: false })]);
  } finally {
    ws.close();
  }
}

let failed;
try {
  const page = await loadedPage();
  console.log(`loaded ${page.url} ("${page.title}") in ${seconds()}s`);
  await evaluate(page.webSocketDebuggerUrl, "window.close()", false);
  const code = await Promise.race([exit, sleep(QUIT_MS, "running", { ref: false })]);
  if (code === "running") throw new Error(`the app was still running ${QUIT_MS / 1000}s after its window closed`);
  if (code !== 0) throw new Error(`the app quit with ${code} after its window closed`);
  console.log(`quit with ${code} in ${seconds()}s`);
} catch (e) {
  failed = e instanceof Error ? e.message : String(e);
}
if (exited === undefined) process.kill(-child.pid, "SIGKILL");
const manager = serviceManagerFor(process.platform);
const stopped = manager === undefined ? {} : await stopService(manager, { statePath, home: homedir(), uid: process.getuid?.() ?? 0 }, systemRunner).catch(e => ({ failure: e }));
if (stopped.failure !== undefined) console.error(stopped.failure instanceof Error ? stopped.failure.message : runFailureLine(stopped.failure));
if (failed !== undefined) {
  console.error(`the AppImage failed its launch: ${failed}`);
  console.error("--- what the app printed");
  for (const line of said) console.error(line);
  const log = hostLogPath(statePath);
  console.error(`--- ${log}`);
  console.error(existsSync(log) ? readFileSync(log, "utf8") : "(not written)");
  process.exitCode = 1;
}
