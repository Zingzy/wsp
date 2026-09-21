// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localWorkFolder, makeRuntime, startHost, type CliIO, type HostHandle } from "@wsp/host";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { hostTokenMatches, locateHost, openHost, probeHost, statePathIn, type HostSession } from "../src/host-lifecycle.js";
import { checkSetup } from "../src/setup.js";

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
    const handle = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    try {
      expect(await probeHost(handle.port)).toBe("wsp");
    } finally {
      await handle.close();
    }
  });

  it("recognises a host listening beyond this computer, whose page says nothing of this computer", async () => {
    const handle = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0, listen: "0.0.0.0", statePath: join(mkdtempSync(join(tmpdir(), "wsp-desktop-state-")), "state.json") });
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

  it("starts its own host rather than attaching to a wsp host on the port no lock beside this state file names", async () => {
    // Any login on this computer can bind a port and serve a page with the boot line in it; the lock beside the
    // state file is what says a host of the owner's is serving, and there is none here.
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    session = await open(existing.port, 0);
    expect(session.owned).toBe(true);
    expect(session.port).not.toBe(existing.port);
    expect((await bootOf(session.url))?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
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

  it("attaches to the host named in host.lock when its page carries the token beside this state file, whatever port it was asked for", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    const lock = { pid: process.pid, port: existing.port, wsPort: existing.wsPort, startedAt: new Date().toISOString() };
    writeFileSync(join(home, "host.lock"), JSON.stringify(lock));
    writeFileSync(join(home, "host-token"), `${existing.authToken}\n`);

    session = await open(await freePort(), 0);
    expect(session.owned).toBe(false);
    expect(session.url).toBe(`http://127.0.0.1:${existing.port}`);
    await session.close();
    session = undefined;
    expect((await bootOf(`http://127.0.0.1:${existing.port}`))?.token).toBeDefined();
    expect(JSON.parse(readFileSync(join(home, "host.lock"), "utf8"))).toEqual(lock);
  });

  it("opens on a computer with no provider key, over the state file this computer is recorded in", async () => {
    // No key in any layer, and the window's io answers nothing: the road that asks for one dies here.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const statePath = join(home, "state.json");
    const recorded = makeRuntime({}, statePath);
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-lifecycle-")));
    execFileSync("git", ["init", "-q", folder]);
    const project = await recorded.projects.add({ source: folder, name: "thisbox" });
    await recorded.workspaces.create({ project: project.id, name: "thisbox" });
    await recorded.close();

    // The two steps main.ts takes, over the runtime the gate built rather than a fixture's.
    const state = await checkSetup({ statePath });
    expect(state.ready).toBe(true);
    session = await openHost({ port: 0, wsPort: 0, statePath, webDir: fakeWebDir(), io: quietIO(), ...(state.ready ? { runtime: state.runtime } : {}) });
    expect(session.owned).toBe(true);
    expect((await bootOf(session.url))?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The workspace is this computer, so the folder its turns start in is here.
    expect(existsSync(localWorkFolder(home))).toBe(true);
  });

  it("is not ready rather than failing when there is no key, no golden and no workspace", async () => {
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    // Nothing recorded: the gate answers before any host is started, so the window has a first launch to show.
    expect(await checkSetup({ statePath: join(home, "state.json") })).toEqual({ ready: false });
    // And a first launch that ends there leaves the person's home as it was: no workspace was recorded here.
    expect(existsSync(localWorkFolder(home))).toBe(false);
  });

  it("refuses a loopback lock whose page carries another token than the file beside the state, and starts nothing", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: existing.port, wsPort: existing.wsPort, startedAt: new Date().toISOString() }));
    writeFileSync(join(home, "host-token"), "a-token-of-some-other-host\n");
    const port = await freePort();
    await expect(open(port, 0)).rejects.toThrow(/holds .*host\.lock on port \d+ but the page it serves carries another token/);
    // Nothing of this window's is on that port, and the lock is the one the other process wrote.
    expect(await probeHost(port)).toBe("free");
    expect((JSON.parse(readFileSync(join(home, "host.lock"), "utf8")) as { port: number }).port).toBe(existing.port);
  });

  it("refuses a loopback lock with no wsp host answering on its port, which is the stale lock a squatter took", async () => {
    const squatter = createServer((_req, res) => res.end("<html>hello</html>"));
    const port = await listen(squatter);
    try {
      writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port, wsPort: 0, startedAt: new Date().toISOString() }));
      await expect(open(await freePort(), 0)).rejects.toThrow(/but no wsp host answers there/);
    } finally {
      await closeServer(squatter);
    }
  });

  it("attaches through the lock alone to a host bound beyond this computer, whose page carries no token by design", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0, listen: "0.0.0.0", statePath: join(home, "state.json") });
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: existing.port, wsPort: existing.wsPort, address: "0.0.0.0", startedAt: new Date().toISOString() }));
    // No token file is written and none is asked for: that page inlines none, and the lock is the whole reading.
    session = await open(await freePort(), 0);
    expect(session.owned).toBe(false);
    expect(session.url).toBe(`http://127.0.0.1:${existing.port}`);
  });

  it.runIf(process.getuid !== undefined && process.getuid() !== 0)("refuses a lock naming a process of another login, whatever answers on its port", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
    writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: 1, port: existing.port, wsPort: existing.wsPort, startedAt: new Date().toISOString() }));
    writeFileSync(join(home, "host-token"), `${existing.authToken}\n`);
    await expect(open(await freePort(), 0)).rejects.toThrow(/but that process is not this login's/);
  });

  it("ignores a host.lock whose pid is gone and starts its own host", async () => {
    existing = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
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
    return startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, wsPort: 0 });
  }

  /** A home with a lock naming the fixture and the token it serves, the way a host serving it leaves things. */
  function homeServedBy(h: HostHandle, lock: string = alive(h)): string {
    const dir = mkdtempSync(join(tmpdir(), "wsp-desktop-custom-"));
    writeFileSync(join(dir, "host.lock"), lock);
    writeFileSync(join(dir, "host-token"), `${h.authToken}\n`);
    return dir;
  }

  it("finds nothing to attach to where a wsp host is on a port and no lock beside the resolved home names it", async () => {
    existing = await fixture();
    expect(await locateHost({ packaged: false, cwd })).toEqual({ home: join(user, ".wsp") });
  });

  it("names ~/.wsp with nothing to attach to when there is no host", async () => {
    expect(await locateHost({ packaged: false, cwd })).toEqual({ home: join(user, ".wsp") });
  });

  it("opens on the home WSP_HOME names, and a host serving some other home is not attached to", async () => {
    // The one way a window opens on a home somebody moved is being launched with that home named; a file under the
    // person's own home saying where a host went is a file two hosts would write.
    existing = await fixture();
    const custom = homeServedBy(existing);
    const env = join(user, "env-home");
    const found = await locateHost({ packaged: false, env, cwd });
    expect(found).toEqual({ home: env });
    expect(await locateHost({ packaged: false, env: custom, cwd })).toMatchObject({ home: custom, session: { url: `http://127.0.0.1:${existing.port}` } });
  });

  it("attaches through the lock next to the state file of the home it resolved", async () => {
    existing = await fixture();
    const env = homeServedBy(existing);
    const found = await locateHost({ packaged: false, env, cwd });
    expect(found.home).toBe(env);
    expect(found.session?.url).toBe(`http://127.0.0.1:${existing.port}`);
  });
});

describe("hostTokenMatches", () => {
  it("matches only the exact bytes of the token file beside the state, and nothing at all where there is no file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-desktop-token-"));
    const statePath = join(dir, "state.json");
    try {
      expect(hostTokenMatches(statePath, "a-token")).toBe(false);
      writeFileSync(join(dir, "host-token"), "a-token\n");
      expect(hostTokenMatches(statePath, "a-token")).toBe(true);
      expect(hostTokenMatches(statePath, "a-token ")).toBe(false);
      expect(hostTokenMatches(statePath, "A-TOKEN")).toBe(false);
      expect(hostTokenMatches(statePath, "a-toke")).toBe(false);
      expect(hostTokenMatches(statePath, "")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("statePathIn", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-home-"));
    cwd = mkdtempSync(join(tmpdir(), "wsp-desktop-cwd-"));
    // What makes a folder a checkout of wsp: its own root package.json naming the workspace.
    writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "wsp", private: true })}\n`);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("shares the checkout's state with wspx when a development run is launched from a checkout of wsp", () => {
    expect(statePathIn(home, { packaged: false, cwd })).toBe(join(cwd, ".wsp", "state.json"));
  });

  it("keeps a packaged app's state in the home, whatever the folder it was launched from holds", () => {
    expect(statePathIn(home, { packaged: true, cwd })).toBe(join(home, "state.json"));
  });

  it("lets WSP_HOME win over the launch folder, packaged or not, which is what the locate doc says", () => {
    for (const packaged of [true, false]) expect(statePathIn(home, { packaged, cwd, env: home })).toBe(join(home, "state.json"));
  });

  it("reads an empty WSP_HOME as none set, so a development run still shares the checkout's state", () => {
    expect(statePathIn(home, { packaged: false, cwd, env: "" })).toBe(join(cwd, ".wsp", "state.json"));
  });

  it("takes the home when the launch folder is no checkout, packaged or not", () => {
    const bare = mkdtempSync(join(tmpdir(), "wsp-desktop-bare-"));
    for (const packaged of [true, false]) expect(statePathIn(home, { packaged, cwd: bare })).toBe(join(home, "state.json"));
    rmSync(bare, { recursive: true, force: true });
  });
});
