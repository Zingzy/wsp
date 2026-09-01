// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { GoldenManifest } from "@wsp/engine";
import { createRuntime, memoryStore, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { cli } from "../src/cli.js";
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

describe("wsp cli", () => {
  it("--version prints the package version", async () => {
    const lines: string[] = [];
    const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
    const code = await cli(["--version"], {
      log: l => lines.push(l),
      error: l => lines.push(l),
      ask: noPrompt,
      askSecret: noPrompt,
    });
    expect(code).toBe(0);
    expect(lines).toEqual([`wsp ${pkg.version}`]);
  });

  it("is wired as the wsp bin", () => {
    expect(pkg.bin["wsp"]).toBe("./dist/bin.js");
  });
});

describe("host status shell", () => {
  let handle: HostHandle | undefined;
  let probeTarget: Server | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await new Promise<void>(r => (probeTarget ? probeTarget.close(() => r()) : r()));
    probeTarget = undefined;
  });

  it("serves the shell HTML and the workspace list JSON", async () => {
    const { rt } = testRuntime();
    await rt.workspaces.create({ golden: "snap_gold", name: "alpha" });
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0 });
    expect(handle.wsPort).toBeGreaterThan(0);

    const page = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("wsp");
    expect(html).toContain("new workspace");

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
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0 });
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
    handle = await startHost({ runtime: rt, port: 0, wsPort: 0 });
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

    handle = await startHost({ runtime: rt, port: 0, wsPort: 0 });
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
