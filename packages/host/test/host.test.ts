// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoldenManifest } from "@wsp/engine";
import { createRuntime, memoryStore, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cli, serve, type CliIO } from "../src/cli.js";
import { startHost, type HostHandle } from "../src/server.js";
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
    vi.stubEnv("WSP_HOME", home);

    handle = await serve(quietIO(), { port: 0, wsPort: 0, statePath: join(home, "state.json"), webDir: webDir() });
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

    const list = await getJson(`http://127.0.0.1:${handle.port}/api/workspaces`);
    expect(list.body.workspaces).toHaveLength(1);
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
