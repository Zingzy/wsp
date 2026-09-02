// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost, type CliIO, type HostHandle } from "@wsp/host";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { openHost, probeHost, type HostSession } from "../src/host-lifecycle.js";

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
});
