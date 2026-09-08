// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright";

// Playwright's default --disable-dev-shm-usage puts Chromium's shared memory in
// files under /tmp, which on a 20 GB box is the root disk. Uncapped, one render
// file grew 1628 of them to 8 GB in 20 s, filled the disk and killed other
// threads' tests with ENOSPC (measured 2026-09-08). Low-end device mode caps
// the compositor's tile and image budgets, which holds a whole file under a
// gigabyte; /dev/shm cannot hold them instead, since it is 992 MB here and the
// same file needs over 3 GB.
export const RENDER_ARGS = ["--enable-low-end-device-mode"];

export type ChromiumLauncher = (options: LaunchOptions) => Promise<Browser>;

/** The one launch every render file uses, so the cap has a single home. */
export const launchRender = (launch: ChromiumLauncher = options => chromium.launch(options)): Promise<Browser> => launch({ args: RENDER_ARGS });

/** Why a render file cannot run on this machine, or undefined when it can. The
 * files are asked for by name, and Playwright's Chromium is not everywhere. */
export const renderSkipped = ((): string | undefined => {
  const browser = ((): string | undefined => {
    try {
      return chromium.executablePath();
    } catch {
      return undefined;
    }
  })();
  if (process.env["WSP_RENDER"] !== "1") return "WSP_RENDER is not 1";
  return browser === undefined || !existsSync(browser) ? "Playwright's Chromium is not installed" : undefined;
})();

export interface ViteChild {
  child: ChildProcess;
  base: string;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`vite did not serve ${url} in time`);
}

/** Spawns the web dev server on a free port and resolves once it serves `path`. */
export async function startVite(webDir: string, path: string): Promise<ViteChild> {
  const port = await freePort();
  const child = spawn(join(webDir, "node_modules", ".bin", "vite"), ["--host", "127.0.0.1", "--port", String(port), "--strictPort", "--logLevel", "silent"], { cwd: webDir, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}${path}`, child);
  } catch (error) {
    await stopVite(child);
    throw error;
  }
  return { child, base };
}

// Vite's SIGTERM handler waits on a dependency prebundle it cancelled, so a
// plain kill can leave the server alive at ppid 1; only the recorded handle
// is ever signalled.
export async function stopVite(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(done => child.once("exit", () => done()));
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await exited;
  clearTimeout(timer);
}

// Chromium under memory pressure can throw on close or never finish it; vite
// is stopped on every one of those paths.
export async function stopRender(browser: { close(): Promise<void> } | undefined, vite: ChildProcess | undefined, closeGraceMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    if (browser !== undefined) await Promise.race([browser.close(), new Promise<void>(r => (timer = setTimeout(r, closeGraceMs)))]);
  } finally {
    clearTimeout(timer);
    await stopVite(vite);
  }
}
