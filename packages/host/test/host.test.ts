// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, TurnResult } from "@wsp/adapter-claude";
import { BUILDER_IDLE_MS, type GoldenManifest } from "@wsp/engine";
import { createRuntime, memoryStore, type HarnessAdapterFactory, type ReapResult, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cli, serve, type CliIO } from "../src/cli.js";
import { claudeEnvs } from "../src/doctor.js";
import { REAP_INTERVAL_MS, startHost, type HostHandle } from "../src/server.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  bin: Record<string, string>;
};

const GOLDEN: GoldenManifest = {
  head: 1,
  versions: [
    {
      version: 1,
      snapshotId: "snap_gold",
      baseTemplate: "base",
      setupSha: "x",
      createdAt: "2026-09-01T00:00:00Z",
      smoke: { cmd: "true", exitCode: 0 },
    },
  ],
};

// Stands in for apps/web/dist: the dev boot line the host replaces, one
// module script with a src, one asset.
const DEV_BOOT = `<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>`;
const PAGE = `<!doctype html>
<html><head><script type="module" crossorigin src="/assets/app.js"></script></head>
<body><div id="root"></div>
${DEV_BOOT}
</body></html>
`;

function fakeWebDir(page: string | null = PAGE): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app')\n");
  if (page !== null) writeFileSync(join(dir, "index.html"), page);
  return dir;
}

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
function quietIO(lines: string[] = []): CliIO {
  return { log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt };
}

function testRuntime(seedGolden = true): { rt: Runtime; backend: StubBackend; store: Store } {
  const backend = stubBackend();
  const store = memoryStore();
  if (seedGolden) void store.put("goldens", "default", GOLDEN);
  const rt = createRuntime({ backend, store, adapters: {} });
  return { rt, backend, store };
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
}

function refused(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => sock.destroy(new Error("connected")));
    sock.once("error", e => resolve((e as NodeJS.ErrnoException).code === "ECONNREFUSED"));
  });
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]!);
}

describe("wsp cli", () => {
  it("--version prints the package version", async () => {
    const lines: string[] = [];
    const code = await cli(["--version"], quietIO(lines));
    expect(code).toBe(0);
    expect(lines).toEqual([`wsp ${pkg.version}`]);
  });

  it("is wired as the wsp bin", () => {
    expect(pkg.bin["wsp"]).toBe("./dist/bin.js");
  });
});

describe("host serves the app", () => {
  let handle: HostHandle | undefined;
  let probeTarget: Server | undefined;
  const dirs: string[] = [];
  const webDir = (page?: string | null): string => {
    const d = fakeWebDir(page);
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    vi.useRealTimers();
    await handle?.close();
    handle = undefined;
    await new Promise<void>(r => (probeTarget ? probeTarget.close(() => r()) : r()));
    probeTarget = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("the page's one inline script is the boot object: runtime port, token, and key flags", async () => {
    const { rt } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: true } });
    expect(handle.wsPort).toBeGreaterThan(0);

    const page = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('<script type="module" crossorigin src="/assets/app.js">');
    expect(inlineScripts(html)).toEqual([
      `window.__WSP__ = {"wsPort":${handle.wsPort},"token":"${handle.authToken}","keys":{"anthropic":true}};`,
    ]);
    expect(html).not.toContain("window.__WSP__ ||");
  });

  it("carries the builder wsp init prepared so the page lands on it", async () => {
    const { rt } = testRuntime(false);
    const builder = { id: "m_b", name: "default", kind: "sandbox" as const, createdAt: "2026-09-03T00:00:00Z", size: { cpu: 2, memMb: 4096 } };
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, builder });
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/`)).text();
    expect(inlineScripts(html)[0]).toContain(`"builder":${JSON.stringify(builder)}`);
  });

  it("says anthropic false when the host loaded no anthropic key", async () => {
    const { rt } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false } });
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/`)).text();
    expect(html).toContain('"keys":{"anthropic":false}');
  });

  it("through the cli, the page carries the flag and never the key value", async () => {
    const SOLARI = "slr_live_fake_solari_key";
    const ANTHROPIC = "sk-ant-x-fake-anthropic-key";
    const home = mkdtempSync(join(tmpdir(), "wsp-home-"));
    dirs.push(home);
    vi.stubEnv("SOLARI_API_KEY", SOLARI);
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC);
    vi.stubEnv("HOME", home);
    vi.stubEnv("WSP_HOME", home);

    const { rt } = testRuntime();
    handle = await serve(quietIO(), { port: 0, wsPort: 0, statePath: join(home, "state.json"), webDir: webDir(), runtime: rt });
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/`)).text();
    expect(html).toContain('"keys":{"anthropic":true}');
    expect(html).not.toContain(ANTHROPIC);
    expect(html).not.toContain(SOLARI);
    expect(html).not.toMatch(/sk-ant|slr_live/);
    const assets = await (await fetch(`http://127.0.0.1:${handle.port}/assets/app.js`)).text();
    expect(assets).not.toMatch(/sk-ant|slr_live/);
  });

  it("serves the bundle's assets and refuses paths outside the web dir", async () => {
    const { rt } = testRuntime();
    const dir = webDir();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: dir, keys: { anthropic: false } });
    const base = `http://127.0.0.1:${handle.port}`;

    const js = await fetch(`${base}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect(await js.text()).toBe("console.log('app')\n");

    writeFileSync(join(dir, "..", "wsp-outside-marker.txt"), "outside");
    dirs.push(join(dir, "..", "wsp-outside-marker.txt"));
    expect((await fetch(`${base}/..%2fwsp-outside-marker.txt`)).status).toBe(404);
    expect((await fetch(`${base}/assets/..%2f..%2fwsp-outside-marker.txt`)).status).toBe(404);
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/assets/`)).status).toBe(404);
  });

  it("refuses to start without a built page or without the boot line to replace", async () => {
    const { rt } = testRuntime();
    await expect(startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(null), keys: { anthropic: false } })).rejects.toThrow(
      /web app not built/,
    );
    await expect(
      startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir("<!doctype html><html><body></body></html>"), keys: { anthropic: false } }),
    ).rejects.toThrow(/__WSP__/);
  });

  it("releases the runtime port when the app port is already held", async () => {
    const { rt } = testRuntime();
    probeTarget = createServer();
    await new Promise<void>(r => probeTarget!.listen(0, "127.0.0.1", r));
    const held = (probeTarget.address() as { port: number }).port;
    const wsPort = await freePort();

    await expect(startHost({ runtime: rt, port: held, wsPort, webDir: webDir(), keys: { anthropic: false } })).rejects.toThrow(/EADDRINUSE/);
    await new Promise<void>(r => probeTarget!.close(() => r()));
    probeTarget = undefined;

    expect(await refused(held)).toBe(true);
    expect(await refused(wsPort)).toBe(true);
  });

  it("lists workspaces as JSON", async () => {
    const { rt } = testRuntime();
    await rt.workspaces.create({ golden: "snap_gold", name: "alpha" });
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false } });
    const { status, body } = await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`);
    expect(status).toBe(200);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({
      name: "alpha",
      phase: "running",
      machineState: "running",
      reach: { state: "unsupported" }, // stub backend cannot mint preview URLs
    });
  });

  it("creates a workspace from the golden head via POST", async () => {
    const { rt, backend } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false } });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "beta" }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { workspace: { name: string; machineId: string } };
    expect(created.workspace.name).toBe("beta");
    expect(backend.machines[0]?.spec.fromSnapshot).toBe("snap_gold");
    expect(backend.machines[0]?.spec.labels).toMatchObject({ wsp: "1", "wsp-host": "1", "wsp-owner": expect.stringMatching(/^h_[0-9a-f]{8}$/) });

    const list = await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`);
    expect(list.body.workspaces).toHaveLength(1);
  });

  it("bakes BROWSER into a fork only when its golden head was sealed with the shim", async () => {
    for (const browserShim of [true, false]) {
      const backend = stubBackend();
      const store = memoryStore();
      const head = { ...GOLDEN.versions[0]!, ...(browserShim ? { browserShim } : {}) };
      void store.put("goldens", "default", { head: 1, versions: [head] });
      const rt = createRuntime({ backend, store, adapters: {} });
      const h = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: true }, workspaceEnvs: g => claudeEnvs("sk-ant-x", g) });
      try {
        const res = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "beta" }) });
        expect(res.status).toBe(200);
        const envs = backend.machines[0]?.spec.envs ?? {};
        expect(envs["CLAUDE_CONFIG_DIR"]).toBe("/root/.claude-cfg");
        expect(envs["BROWSER"]).toBe(browserShim ? "/usr/local/bin/wsp-open" : undefined);
      } finally {
        await h.close();
      }
    }
  });

  it("refuses workspace creation without a golden image", async () => {
    const { rt } = testRuntime(false);
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false } });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "beta" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/golden/i);
  });

  it("reports daemon reach by probing the minted preview URL", async () => {
    const { rt, backend } = testRuntime();
    await rt.workspaces.create({ golden: "snap_gold", name: "alpha" });

    // Stands in for the Solari edge + guest daemon: plain HTTP against the
    // daemon's ws port answers 426 Upgrade Required (measured through the
    // real proxy in the ticket-6 spike).
    probeTarget = createServer((_req, res) => {
      res.writeHead(426).end();
    });
    await new Promise<void>(r => probeTarget!.listen(0, "127.0.0.1", r));
    const addr = probeTarget.address();
    const probePort = typeof addr === "object" && addr !== null ? addr.port : 0;
    const machine = backend.machines[0]!;
    let minted = 0;
    machine.previewUrl = async port => {
      minted++;
      return {
        url: `http://127.0.0.1:${probePort}/?pt_token=stub&port=${port}`,
        token: "stub",
        expiresAt: Date.now() + 60 * 60_000,
      };
    };

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false } });
    const first = await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`);
    expect(first.body.workspaces[0].reach).toMatchObject({ state: "reachable" });
    expect(first.body.workspaces[0].reach.url).toContain("pt_token=");

    // Fresh reach is reused across polls, not reminted per request.
    await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`);
    expect(minted).toBe(1);

    // Napping workspaces are not probed; their reach state says so.
    const ws = (await rt.workspaces.list())[0]!;
    await rt.workspaces.nap(ws.id);
    const napped = await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`);
    expect(napped.body.workspaces[0].reach.state).toBe("napping");
    expect(napped.body.workspaces[0].machineState).toBe("paused");
  });
});

describe("host close flushes transcripts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** An adapter the test drives by hand, so a turn boundary can land with no session.end behind it. */
  function manualAdapter(): { adapter: HarnessAdapterFactory; start: () => void; done: (text: string) => void } {
    const sessionId = "44444444-4444-4444-8444-444444444444";
    let onEvent: ((e: AdapterEvent) => void) | undefined;
    const finished = new Promise<TurnResult>(() => {});
    const adapter: HarnessAdapterFactory = () => ({
      start: o => {
        onEvent = o.onEvent;
        return { localId: sessionId, claudeSessionId: sessionId, finished };
      },
    });
    return {
      adapter,
      start: () => onEvent!({ type: "session.start", sessionId, model: "claude-sonnet-4-5" }),
      done: text => onEvent!({ type: "turn.done", sessionId, result: { status: "completed", text } }),
    };
  }

  it("a turn boundary right before close() is in the store once close() resolves", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", "default", GOLDEN);
    const m = manualAdapter();
    const rt = createRuntime({ backend, store, adapters: { claude: m.adapter } });
    const dir = fakeWebDir();
    dirs.push(dir);
    const handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: dir, keys: { anthropic: false } });

    const ws = await rt.workspaces.create({ golden: "snap_gold", name: "alpha" });
    await rt.sessions.start(ws.id, { prompt: "go" });
    m.start();
    m.done("t0");
    await handle.close();

    const stored = (await store.get("transcripts", ws.id)) as { events: { type: string }[] } | undefined;
    expect(stored?.events.map(e => e.type)).toEqual(["session.start", "session.done"]);
  });
});

describe("host sweeps orphaned machines", () => {
  let handle: HostHandle | undefined;
  const dirs: string[] = [];
  const webDir = (): string => {
    const d = fakeWebDir();
    dirs.push(d);
    return d;
  };
  const TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;
  afterEach(async () => {
    vi.useRealTimers();
    await handle?.close();
    handle = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const BUILDER = { wsp: "1", "wsp-builder": "1" };
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

  it("at start reaps what its own state owns or nobody claims past the backstop, lists the rest once in plain words, and touches no poc machine", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const owned = await crashed.golden.prepare();
    backend.machines[0]!.paused = true; // paused from the console, so no longer first-life
    const orphanAt = ago(BUILDER_IDLE_MS + 60_000);
    const strayAt = ago(12 * 60_000);
    const foreign = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(53_000) } });
    const orphan = await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: orphanAt } });
    const young = await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: ago(2 * 60_000) } });
    const ageless = await backend.create({ kind: "sandbox", labels: BUILDER });
    const experiment = await backend.create({ kind: "sandbox", labels: { ...BUILDER, poc: "ttl-test" } });
    const foreignWs = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": "h_other", createdAt: ago(20 * 60_000) } });
    const strayWs = await backend.create({ kind: "sandbox", labels: { wsp: "1", createdAt: strayAt } });
    const garbage = await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: "yesterday" } });
    const foreignSmoke = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-smoke": "1", "wsp-owner": "h_other", createdAt: ago(20 * 60_000) } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l) });

    const killed = (m: { id: string }): boolean => backend.machines.find(x => x.id === m.id)!.killed;
    expect([owned, foreign, orphan, young, ageless, experiment, foreignWs, strayWs, garbage, foreignSmoke].map(killed)).toEqual([true, false, true, false, false, false, false, true, false, false]);
    expect(lines).toEqual([
      `reap: stopped ${owned.id}: your earlier builder from this setup; a builder cannot be sealed after a restart`,
      `reap: stopped ${orphan.id} (wsp=1 wsp-builder=1 createdAt=${orphanAt}): builder with no owner, 6.0 h old`,
      `reap: stopped ${strayWs.id} (wsp=1 createdAt=${strayAt}): workspace with no owner, 12 min old`,
      `reap: left alone ${foreign.id}: builder from another wsp setup (owner h_other), 53 s old, $0.11/h (about $0.00 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: left alone ${young.id}: builder with no owner, 2 min old, $0.11/h (about $0.00 so far); reaped once it is 6.0 h old`,
      `reap: left alone ${ageless.id}: builder with no owner, age unknown, $0.11/h; never reaped by this host`,
      `reap: left alone ${foreignWs.id}: workspace from another wsp setup (owner h_other), 20 min old, $0.11/h (about $0.04 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: left alone ${garbage.id}: builder with no owner, age unknown, $0.11/h; never reaped by this host`,
      `reap: left alone ${foreignSmoke.id}: smoke fork from another wsp setup (owner h_other), 20 min old, $0.11/h (about $0.04 so far); kill it from the Solari console if it is yours and forgotten`,
    ]);
    expect(await store.list("builders")).toEqual([]);
  });

  it("a failed listing reaps nothing beyond the recorded builder, and logs both", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const owned = await crashed.golden.prepare();
    backend.machines[0]!.paused = true;
    await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: ago(BUILDER_IDLE_MS + 60_000) } });
    backend.list = async () => { throw new Error("list 502"); };
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l) });

    expect(backend.machines.map(m => m.killed)).toEqual([true, false]);
    expect(lines).toEqual([
      `reap: stopped ${owned.id}: your earlier builder from this setup; a builder cannot be sealed after a restart`,
      "reap: sweep failed: list 502",
    ]);
  });

  it("a listed machine that will not die is reported by id while everything before and after it is still handled", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const strayAt = ago(12 * 60_000);
    const stray = await backend.create({ kind: "sandbox", labels: { wsp: "1", createdAt: strayAt } });
    const lost = await crashed.golden.prepare();
    await store.delete("builders", lost.id);
    backend.machines[1]!.spec.labels!["createdAt"] = ago(5 * 60_000);
    backend.machines[1]!.kill = async () => { throw new Error("Bad Gateway"); };
    const orphanAt = ago(BUILDER_IDLE_MS + 60_000);
    const orphan = await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: orphanAt } });
    const foreign = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(53_000) } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l) });

    expect(backend.machines.map(m => m.killed)).toEqual([true, false, true, false]);
    expect(lines).toEqual([
      `reap: stopped ${stray.id} (wsp=1 createdAt=${strayAt}): workspace with no owner, 12 min old`,
      `reap: stopped ${orphan.id} (wsp=1 wsp-builder=1 createdAt=${orphanAt}): builder with no owner, 6.0 h old`,
      `reap: left alone ${foreign.id}: builder from another wsp setup (owner h_other), 53 s old, $0.11/h (about $0.00 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: could not stop ${lost.id} (Bad Gateway)`,
    ]);
  });

  it("ages never read negative, never round up, and hours have one format", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    await crashed.golden.builders();
    const { id: owner } = (await store.get("owner", "id")) as { id: string };
    const ahead = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(-45_000) } });
    const almostMinute = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(59_600) } });
    const ownWs = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": owner, createdAt: ago(45_000) } });
    const hours = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(6 * 3_600_000) } });
    const freshOwn = await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": owner, createdAt: ago(30_000) } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l) });

    expect(backend.machines.some(m => m.killed)).toBe(false);
    expect(lines).toEqual([
      `reap: left alone ${ahead.id}: builder from another wsp setup (owner h_other), 0 s old, $0.11/h (about $0.00 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: left alone ${almostMinute.id}: builder from another wsp setup (owner h_other), 59 s old, $0.11/h (about $0.00 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: left alone ${ownWs.id}: workspace from this setup that no record claims, 45 s old, $0.11/h (about $0.00 so far); reaped once it is 1 min old unless a record claims it first`,
      `reap: left alone ${hours.id}: builder from another wsp setup (owner h_other), 6.0 h old, $0.11/h (about $0.66 so far); kill it from the Solari console if it is yours and forgotten`,
      `reap: left alone ${freshOwn.id}: builder from this setup that no record claims, 30 s old, $0.11/h (about $0.00 so far); reaped once it is 1 min old unless a record claims it first`,
    ]);
  });

  it("a recorded builder that will not die is reported and the sweep goes on", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const stuck = await crashed.golden.prepare();
    backend.machines[0]!.paused = true;
    const orphanAt = ago(BUILDER_IDLE_MS + 60_000);
    const orphan = await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: orphanAt } });
    backend.machines[0]!.kill = async () => { throw new Error("502 exec failed"); };
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l) });

    expect(backend.machines.map(m => m.killed)).toEqual([false, true]);
    expect(lines).toEqual([
      `reap: stopped ${orphan.id} (wsp=1 wsp-builder=1 createdAt=${orphanAt}): builder with no owner, 6.0 h old`,
      `reap: could not stop ${stuck.id} (502 exec failed; stays recorded, retried next sweep)`,
    ]);
  });

  it("a first-life builder from an earlier run is kept, claimed against the sweep, and named at start", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const kept = await crashed.golden.prepare();
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l), recipePath: "/home/me/.wsp/state/golden-recipe.json" });

    expect(backend.machines[0]!.killed).toBe(false);
    expect(lines).toEqual([
      `reap: left alone ${kept.id}: your earlier builder from this setup, still first-life, 0 s old, $0.11/h (about $0.00 so far); reuse it with wsp init --manifest /home/me/.wsp/state/golden-recipe.json, or it is stopped at six hours`,
    ]);
    expect(await store.get("builders", kept.id)).toMatchObject({ firstLife: true });
  });

  it("a recorded builder wearing another setup's owner label is named as such at start and never touched", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const foreign = await crashed.golden.prepare();
    backend.machines[0]!.spec.labels!["wsp-owner"] = "h_other";
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l), recipePath: "/home/me/.wsp/state/golden-recipe.json" });

    expect(backend.machines[0]!.killed).toBe(false);
    expect(lines).toEqual([`reap: left alone ${foreign.id}: recorded builder wearing another setup's owner label (h_other); never touched by this host`]);
  });

  it("a recorded builder another live wsp process holds is named as in use at start and never touched", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const held = await crashed.golden.prepare();
    const record = (await store.get("builders", held.id)) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", held.id, { ...record, heldBy: { ...record.heldBy, pid: process.ppid } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l), recipePath: "/home/me/.wsp/state/golden-recipe.json" });

    expect(backend.machines[0]!.killed).toBe(false);
    expect(lines).toEqual([`reap: left alone ${held.id}: your earlier builder from this setup, in use by another wsp process (pid ${process.ppid}); never touched by this host`]);
  });

  it("a placeholder left mid-setup by a dead process is stopped at start with the line saying its setup never finished", async () => {
    const { rt, backend, store } = testRuntime();
    const gate = new Promise<void>(() => {});
    const dying = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", deployDaemon: () => gate } });
    void dying.golden.prepare();
    await vi.waitFor(() => expect(backend.machines).toHaveLength(1));
    const record = (await store.get("builders", "m1")) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", "m1", { ...record, heldBy: { ...record.heldBy, pid: 999_999_999 } });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l), recipePath: "/home/me/.wsp/state/golden-recipe.json" });

    expect(backend.machines[0]!.killed).toBe(true);
    expect(lines).toEqual(["reap: stopped m1: your earlier builder from this setup; its setup never finished"]);
    expect(await store.list("builders")).toEqual([]);
  });

  it("an unfinished placeholder that will not die is reported and named as unfinished at start, never as reusable", async () => {
    const { rt, backend, store } = testRuntime();
    const gate = new Promise<void>(() => {});
    const dying = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", deployDaemon: () => gate } });
    void dying.golden.prepare();
    await vi.waitFor(() => expect(backend.machines).toHaveLength(1));
    const record = (await store.get("builders", "m1")) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", "m1", { ...record, heldBy: { ...record.heldBy, pid: 999_999_999 } });
    backend.machines[0]!.kill = async () => { throw new Error("Bad Gateway"); };
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l), recipePath: "/home/me/.wsp/state/golden-recipe.json" });

    expect(lines).toEqual([
      "reap: could not stop m1 (Bad Gateway; stays recorded, retried next sweep)",
      "reap: left alone m1: your earlier builder from this setup; its setup never finished; the next sweep stops it",
    ]);
    expect(lines.join("\n")).not.toContain("reuse it");
  });

  it("a kept builder whose age cannot be read is stopped at start, with the line saying the age is unknown", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const ageless = await crashed.golden.prepare();
    backend.machines[0]!.spec.labels!["createdAt"] = "yesterday";
    await store.put("builders", ageless.id, { ...((await store.get("builders", ageless.id)) as object), createdAt: "yesterday" });
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l) });

    expect(backend.machines[0]!.killed).toBe(true);
    expect(lines).toEqual([`reap: stopped ${ageless.id}: your earlier builder from this setup, age unknown; a kept builder with no readable age is stopped at once`]);
    expect(await store.list("builders")).toEqual([]);
  });

  it("a kept first-life builder past six hours by our createdAt label is stopped and forgotten at start, with the line saying so", async () => {
    const { rt, backend, store } = testRuntime();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true" } });
    const old = await crashed.golden.prepare();
    backend.machines[0]!.spec.labels!["createdAt"] = ago(BUILDER_IDLE_MS + 60_000);
    const lines: string[] = [];

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l) });

    expect(backend.machines[0]!.killed).toBe(true);
    expect(lines).toEqual([`reap: stopped ${old.id}: your earlier builder from this setup, 6.0 h old; a kept builder is stopped at six hours`]);
    expect(await store.list("builders")).toEqual([]);
  });

  it("lists once per sweep", async () => {
    const { rt, backend } = testRuntime();
    const list = vi.spyOn(backend, "list");
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: () => {} });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("sweeps again every ten minutes until the host closes", async () => {
    vi.useFakeTimers({ toFake: [...TIMERS] });
    const { rt, backend } = testRuntime();
    const lines: string[] = [];
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: l => lines.push(l) });
    const reap = vi.spyOn(rt, "reap");

    await backend.create({ kind: "sandbox", labels: { ...BUILDER, createdAt: ago(BUILDER_IDLE_MS + 60_000) } });
    await backend.create({ kind: "sandbox", labels: { ...BUILDER, "wsp-owner": "h_other", createdAt: ago(60_000) } });
    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS - 1);
    expect(reap).not.toHaveBeenCalled();
    expect(backend.machines[0]?.killed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(reap).toHaveBeenCalledTimes(1);
    expect(backend.machines.map(m => m.killed)).toEqual([true, false]);
    // The foreign builder is listed at start only; later sweeps stay quiet about it.
    expect(lines).toEqual([expect.stringContaining("stopped m1")]);

    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS);
    expect(reap).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(1);

    await handle.close();
    handle = undefined;
    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS * 3);
    expect(reap).toHaveBeenCalledTimes(2);
  });

  it("starts no sweep while one is still in flight", async () => {
    vi.useFakeTimers({ toFake: [...TIMERS] });
    const { rt } = testRuntime();
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0, webDir: webDir(), keys: { anthropic: false }, log: () => {} });
    let finish!: (result: ReapResult) => void;
    const reap = vi.spyOn(rt, "reap").mockImplementationOnce(() => new Promise<ReapResult>(r => (finish = r)));

    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS * 3);
    expect(reap).toHaveBeenCalledTimes(1);

    finish({ reaped: [], spared: [] });
    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS);
    expect(reap).toHaveBeenCalledTimes(2);
  });
});
