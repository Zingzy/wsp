// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve, type CliIO } from "../src/cli.js";
import type { HostHandle } from "../src/server.js";
import { stubBackend } from "./stub-backend.js";

const PAGE = `<!doctype html>
<html><head><script type="module" crossorigin src="/assets/app.js"></script></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
</body></html>
`;

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO: CliIO = { log: () => {}, error: () => {}, ask: noPrompt, askSecret: noPrompt };

function testRuntime(): Runtime {
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
}

interface Lock {
  pid: number;
  port: number;
  wsPort: number;
  startedAt: string;
}

function readLock(path: string): Lock {
  return JSON.parse(readFileSync(path, "utf8")) as Lock;
}

/** A pid that was real a moment ago and is not alive now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

describe("serve takes host.lock next to the state file", () => {
  let dir: string;
  let home: string;
  let pointerPath: string;
  let webDir: string;
  let statePath: string;
  let lockPath: string;
  const handles: HostHandle[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-lock-home-"));
    home = join(dir, "custom");
    pointerPath = join(dir, "user", ".wsp", "current-home");
    webDir = join(home, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(home, "state", "state.json");
    lockPath = join(home, "state", "host.lock");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_lock_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", home);
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(dir: string = webDir): Promise<HostHandle> {
    const h = await serve(quietIO, { port: 0, wsPort: 0, statePath, webDir: dir, runtime: testRuntime() });
    handles.push(h);
    return h;
  }

  it("writes pid, ports and start time, and removes the lock on close", async () => {
    const before = Date.now();
    const h = await start();
    const lock = readLock(lockPath);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(h.port);
    expect(lock.wsPort).toBe(h.wsPort);
    expect(Date.parse(lock.startedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(lock.startedAt)).toBeLessThanOrEqual(Date.now());

    await h.close();
    handles.splice(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses a second host on the same state file, naming the running pid and ports", async () => {
    const first = await start();
    await expect(start()).rejects.toThrow(
      new RegExp(`pid ${process.pid}\\b.*\\b${first.port}\\b.*\\b${first.wsPort}\\b`),
    );
    // The loser must not take the winner's lock with it.
    expect(readLock(lockPath).port).toBe(first.port);
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
  });

  it("removes a lock whose pid is no longer alive and starts", async () => {
    mkdirSync(join(home, "state"));
    const stale = { pid: deadPid(), port: 1, wsPort: 2, startedAt: "2026-09-01T00:00:00.000Z" };
    writeFileSync(lockPath, JSON.stringify(stale));

    const h = await start();
    const lock = readLock(lockPath);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(h.port);
  });

  it("points ~/.wsp/current-home at the home it serves and removes it on close", async () => {
    const h = await start();
    expect(readFileSync(pointerPath, "utf8")).toBe(`${home}\n`);

    await h.close();
    handles.splice(0);
    expect(existsSync(pointerPath)).toBe(false);
  });

  it("leaves a pointer that a later host rewrote to its own home alone on close", async () => {
    const h = await start();
    writeFileSync(pointerPath, `${join(dir, "newer")}\n`);

    await h.close();
    handles.splice(0);
    expect(readFileSync(pointerPath, "utf8")).toBe(`${join(dir, "newer")}\n`);
  });

  it("does not leave a lock behind when the host fails to start", async () => {
    const broken = join(home, "broken-web");
    mkdirSync(broken);
    await expect(start(broken)).rejects.toThrow(/web app not built/);
    expect(existsSync(lockPath)).toBe(false);
  });
});
