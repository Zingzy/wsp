// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost, type CliIO, type HostHandle } from "@wsp/host";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { locateHost, openHost, probeHost, type HostSession } from "../src/host-lifecycle.js";

const PAGE = `<!doctype html>
<html><head><title>wsp</title></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
</body></html>
`;

function fakeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-desktop-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), PAGE);
  return dir;
}

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
function quietIO(lines: string[] = []): CliIO {
  return { log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt };
}

function testRuntime(): Runtime {
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
}

function listen(server: Server | TcpServer): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

function closeServer(server: Server | TcpServer): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function bootOf(url: string): Promise<{ wsPort: number; token: string } | undefined> {
  const html = await (await fetch(url)).text();
  const m = html.match(/window\.__WSP__ = (\{[^<]*\});<\/script>/);
  return m ? (JSON.parse(m[1]!) as { wsPort: number; token: string }) : undefined;
}

/** A pid that was real a moment ago and is not alive now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

async function refused(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
}

describe("probeHost", () => {
  it("reports a free port", async () => {
    const probe = createTcpServer();
    const port = await listen(probe);
    await closeServer(probe);
    expect(await probeHost(port)).toBe("free");
  });

  it("reports a port held by something that is not a wsp host", async () => {
    const other = createServer((_req, res) => res.end("<html>hello</html>"));
    const port = await listen(other);
    try {
      expect(await probeHost(port)).toBe("other");
    } finally {
      await closeServer(other);
    }
  });

  it("recognises a running wsp host by its boot line", async () => {
    const handle = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), keys: { anthropic: false }, port: 0, wsPort: 0 });
    try {
      expect(await probeHost(handle.port)).toBe("wsp");
    } finally {
      await handle.close();
    }
  });
});

describe("openHost", () => {
  let home: string;
  let session: HostSession | undefined;
  let existing: HostHandle | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-home-"));
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_desktop_key");
    vi.stubEnv("HOME", home);
    vi.stubEnv("WSP_HOME", home);
  });
  afterEach(async () => {
    await session?.close();
    await existing?.close();
    session = undefined;
    existing = undefined;
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function open(port: number, wsPort: number): Promise<HostSession> {
    return openHost({
      port,
      wsPort,
      statePath: join(home, "state.json"),
      webDir: fakeWebDir(),
      io: quietIO(),
      runtime: testRuntime(),
    });
  }

  it("starts the host on a free port and serves the app with a token", async () => {
    session = await open(0, 0);
    expect(session.owned).toBe(true);
    expect(session.port).toBeGreaterThan(0);
    expect(session.url).toBe(`http://127.0.0.1:${session.port}`);
    const boot = await bootOf(session.url);
    expect(boot?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(boot?.wsPort).toBeGreaterThan(0);
  });

  it("stops the host it started when closed", async () => {
    session = await open(0, 0);
    const url = session.url;
    await session.close();
    session = undefined;
    expect(await refused(url)).toBe(true);
  });

  it("attaches to a wsp host already on the port and leaves it running when closed", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), keys: { anthropic: false }, port: 0, wsPort: 0 });
    session = await open(existing.port, 0);
    expect(session.owned).toBe(false);
    expect(session.url).toBe(`http://127.0.0.1:${existing.port}`);
    const before = await bootOf(session.url);
    await session.close();
    session = undefined;
    const after = await bootOf(`http://127.0.0.1:${existing.port}`);
    expect(after).toEqual(before);
  });

  it("falls back to free ports when the defaults are held by something else", async () => {
    const other = createServer((_req, res) => res.end("nope"));
    const port = await listen(other);
    try {
      session = await open(port, 0);
      expect(session.owned).toBe(true);
      expect(session.port).not.toBe(port);
      expect((await bootOf(session.url))?.token).toBeDefined();
    } finally {
      await closeServer(other);
    }
  });

  it("falls back to free ports when only the websocket port is taken", async () => {
    const taken = createTcpServer();
    const wsPort = await listen(taken);
    const free = createTcpServer();
    const port = await listen(free);
    await closeServer(free);
    try {
      session = await open(port, wsPort);
      expect(session.owned).toBe(true);
      const boot = await bootOf(session.url);
      expect(boot?.wsPort).not.toBe(wsPort);
    } finally {
      await closeServer(taken);
    }
  });

  it("attaches to the host named in host.lock when its pid is alive, whatever port it was asked for", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), keys: { anthropic: false }, port: 0, wsPort: 0 });
    const lock = { pid: process.pid, port: existing.port, wsPort: existing.wsPort, startedAt: new Date().toISOString() };
    writeFileSync(join(home, "host.lock"), JSON.stringify(lock));

    session = await open(await freePort(), 0);
    expect(session.owned).toBe(false);
    expect(session.url).toBe(`http://127.0.0.1:${existing.port}`);
    await session.close();
    session = undefined;
    expect((await bootOf(`http://127.0.0.1:${existing.port}`))?.token).toBeDefined();
    expect(JSON.parse(readFileSync(join(home, "host.lock"), "utf8"))).toEqual(lock);
  });

  it("ignores a host.lock whose pid is gone and starts its own host", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), keys: { anthropic: false }, port: 0, wsPort: 0 });
    const stale = { pid: deadPid(), port: existing.port, wsPort: existing.wsPort, startedAt: "2026-09-01T00:00:00.000Z" };
    writeFileSync(join(home, "host.lock"), JSON.stringify(stale));

    session = await open(await freePort(), 0);
    expect(session.owned).toBe(true);
    expect(session.port).not.toBe(existing.port);
    const lock = JSON.parse(readFileSync(join(home, "host.lock"), "utf8")) as { pid: number; port: number };
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(session.port);
  });
});

describe("locateHost", () => {
  let user: string;
  let cwd: string;
  let existing: HostHandle | undefined;
  const alive = (h: HostHandle): string => JSON.stringify({ pid: process.pid, port: h.port, wsPort: h.wsPort, startedAt: new Date().toISOString() });

  beforeEach(() => {
    user = mkdtempSync(join(tmpdir(), "wsp-desktop-user-"));
    cwd = join(user, "cwd");
    mkdirSync(cwd);
    vi.stubEnv("HOME", user);
  });
  afterEach(async () => {
    await existing?.close();
    existing = undefined;
    vi.unstubAllEnvs();
    rmSync(user, { recursive: true, force: true });
  });

  function fixture(): Promise<HostHandle> {
    return startHost({ runtime: testRuntime(), webDir: fakeWebDir(), keys: { anthropic: false }, port: 0, wsPort: 0 });
  }

  /** A home with a lock naming the fixture, the way a host serving it leaves things. */
  function homeServedBy(h: HostHandle, lock: string = alive(h)): string {
    const dir = mkdtempSync(join(tmpdir(), "wsp-desktop-custom-"));
    writeFileSync(join(dir, "host.lock"), lock);
    return dir;
  }

  it("attaches to a wsp host on the port with an empty ~/.wsp and no keys anywhere", async () => {
    existing = await fixture();
    const found = await locateHost({ port: existing.port, cwd });
    expect(found.home).toBe(join(user, ".wsp"));
    expect(found.session?.owned).toBe(false);
    expect(found.session?.url).toBe(`http://127.0.0.1:${existing.port}`);
    expect(found.stalePointer).toBeUndefined();
  });

  it("follows current-home to a custom home whose host is live, on a port it was not asked about", async () => {
    existing = await fixture();
    const custom = homeServedBy(existing);
    const found = await locateHost({ port: await freePort(), pointer: custom, cwd });
    expect(found.home).toBe(custom);
    expect(found.session?.url).toBe(`http://127.0.0.1:${existing.port}`);
    expect(found.stalePointer).toBeUndefined();
  });

  it("reports a pointer whose host is gone and falls back to ~/.wsp without a session", async () => {
    existing = await fixture();
    const custom = homeServedBy(existing, JSON.stringify({ pid: deadPid(), port: existing.port, wsPort: existing.wsPort, startedAt: "2026-09-01T00:00:00.000Z" }));
    const found = await locateHost({ port: await freePort(), pointer: custom, cwd });
    expect(found).toEqual({ home: join(user, ".wsp"), stalePointer: custom });
  });

  it("names ~/.wsp with nothing to attach to when there is no host and no pointer", async () => {
    expect(await locateHost({ port: await freePort(), cwd })).toEqual({ home: join(user, ".wsp") });
  });

  it("uses WSP_HOME when set and leaves the pointer unread", async () => {
    existing = await fixture();
    const custom = homeServedBy(existing);
    const env = join(user, "env-home");
    const found = await locateHost({ port: await freePort(), env, pointer: custom, cwd });
    expect(found).toEqual({ home: env });
  });

  it("attaches through the lock next to the state file of the home it resolved", async () => {
    existing = await fixture();
    const env = homeServedBy(existing);
    const found = await locateHost({ port: await freePort(), env, cwd });
    expect(found.home).toBe(env);
    expect(found.session?.url).toBe(`http://127.0.0.1:${existing.port}`);
  });
});
