// SPDX-License-Identifier: AGPL-3.0-only
// A host started cold answers the app off its own state: what its machines' provider and daemons say comes after.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxBackend, type Machine } from "@wsp/engine";
import { copyKey, createRuntime, memoryStore } from "@wsp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve, type CliIO } from "../src/cli.js";
import { servingHost } from "../src/host-lock.js";
import type { HostHandle } from "../src/server.js";
import { dialHost } from "../src/verbs/client.js";
import { SEALED_GOLDEN as GOLDEN } from "./sealed-golden.js";
import { stubBackend, withDaemonRoads } from "./stub-backend.js";
import { createOn } from "./verbs-fixture.js";

const quiet: CliIO = { log: () => {}, error: () => {}, ask: q => Promise.reject(new Error(q)), askSecret: q => Promise.reject(new Error(q)) };
const MACHINES = 20;
/** What one read of a machine takes at a provider that is slow to answer: twenty of them one after another is the
 * whole start's wait several times over. */
const PROVIDER_READ_MS = 5_000;

describe("a host started cold with twenty machines whose daemons never answer", () => {
  const dirs: string[] = [];
  const sockets: Socket[] = [];
  let hang: Server | undefined;
  let host: HostHandle | undefined;
  afterEach(async () => {
    // A close waits out the dials it has in flight to the daemons that never answer.
    await host?.close();
    host = undefined;
    for (const s of sockets.splice(0)) s.destroy();
    await new Promise(r => (hang === undefined ? r(undefined) : hang.close(r)));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  }, 60_000);

  it("answers the app's first reads within 3 s, while its provider takes 5 s a machine, and holds each machine once its read lands", async () => {
    hang = createServer(s => sockets.push(s));
    await new Promise<void>(r => hang!.listen(0, "127.0.0.1", r));
    const hangPort = (hang.address() as { port: number }).port;
    const backend = withDaemonRoads(stubBackend());
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), GOLDEN);
    const before = createRuntime({ backend, store, adapters: {} });
    for (let i = 0; i < MACHINES; i++) await createOn(before, { golden: "snap_gold", name: `w${i}` });
    await before.close();
    // Every daemon takes the connect and never says a word; the provider answers each read late.
    for (const m of backend.machines) {
      Object.assign(m, {
        previewUrl: async () => ({ url: `http://127.0.0.1:${hangPort}`, token: "e", expiresAt: Date.now() + 3_600_000 }),
        daemonAnswers: () => new Promise(() => {}),
      });
    }
    const get = backend.get.bind(backend);
    const reads: string[] = [];
    backend.get = async (id: string): Promise<Machine> => {
      reads.push(id);
      await new Promise(r => setTimeout(r, PROVIDER_READ_MS));
      return get(id);
    };

    const dir = mkdtempSync(join(tmpdir(), "wsp-cold-"));
    dirs.push(dir);
    const web = join(dir, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), `<html><body><script>window.__WSP__ = window.__WSP__ || { token: "" };</script></body></html>`);
    const statePath = join(dir, "state.json");
    const t0 = Date.now();
    const rt = createRuntime({ backend, store, adapters: {} });
    const serving = serve(quiet, { port: 0, statePath, webDir: web, runtime: rt });
    void serving.then(h => (host = h));
    await vi.waitUntil(() => (servingHost(statePath)?.port ?? 0) > 0, { timeout: 3_000, interval: 20 }).catch(() => expect.fail(`no host bound after ${Date.now() - t0} ms`));
    // What the app asks first, as it asks it: the page, then whether this is the first launch.
    await vi.waitUntil(async () => (await fetch(`http://127.0.0.1:${servingHost(statePath)!.port}/`).catch(() => undefined))?.ok === true, { timeout: 3_000, interval: 20 });
    const client = await dialHost(statePath, { aim: { kind: "here" }, home: dir });
    try {
      await client.request("golden.get", { name: "default" });
      const { workspaces } = await client.request<{ workspaces: { name: string }[] }>("workspaces.list");
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(workspaces.map(w => w.name).sort()).toEqual(Array.from({ length: MACHINES }, (_, i) => `w${i}`).sort());
      // Each machine was asked once, all at once rather than one after another.
      expect(reads).toHaveLength(MACHINES);
      // Each is read in once its answer lands: a verb on one runs on its machine.
      const listed = await client.request<{ workspaces: { id: string }[] }>("workspaces.list");
      expect((await rt.workspaces.exec(listed.workspaces[0]!.id, "echo ok")).stdout).toBe("ok\n");
    } finally {
      client.close();
    }
  }, 40_000);

  it("comes up, its address lines said, while its provider takes every read and never answers one", async () => {
    // Each read is held until the backend's own cap ends it, as a provider that takes the connection and stalls does.
    const fetch = ((_url: string, init: RequestInit = {}) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof globalThis.fetch;
    const dir = mkdtempSync(join(tmpdir(), "wsp-cold-"));
    dirs.push(dir);
    const web = join(dir, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), `<html><body><script>window.__WSP__ = window.__WSP__ || { token: "" };</script></body></html>`);
    const lines: string[] = [];
    const io: CliIO = { ...quiet, log: line => lines.push(line) };
    const rt = createRuntime({ backend: new BoxBackend({ apiKey: "box_x", fetch }), store: memoryStore(), adapters: {} });
    const serving = serve(io, { port: 0, statePath: join(dir, "state.json"), webDir: web, runtime: rt });
    const up = await Promise.race([serving, new Promise<undefined>(resolve => setTimeout(resolve, 5_000))]);
    host = up ?? (await serving);
    expect(up, "the host was still starting after 5 s").toBeDefined();
    expect(lines.some(line => line.startsWith("app         http://"))).toBe(true);
  }, 120_000);

  it("answers the app before it reads a stored image builder its provider never answers for", async () => {
    const fetch = ((_url: string, init: RequestInit = {}) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof globalThis.fetch;
    const store = memoryStore();
    await store.put("builders", "bx_kept", { id: "bx_kept", name: "default", kind: "sandbox", baseTemplate: "base", setupSha: "abc", createdAt: new Date().toISOString() });
    const dir = mkdtempSync(join(tmpdir(), "wsp-cold-"));
    dirs.push(dir);
    const web = join(dir, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), `<html><body><script>window.__WSP__ = window.__WSP__ || { token: "" };</script></body></html>`);
    const statePath = join(dir, "state.json");
    const t0 = Date.now();
    const rt = createRuntime({ backend: new BoxBackend({ apiKey: "box_x", fetch }), store, adapters: {} });
    const serving = serve(quiet, { port: 0, statePath, webDir: web, runtime: rt });
    void serving.then(h => (host = h));
    // The builder's read ends only at the provider read cap, 20 s on.
    await vi.waitUntil(() => (servingHost(statePath)?.port ?? 0) > 0, { timeout: 3_000, interval: 20 }).catch(() => expect.fail(`no host bound after ${Date.now() - t0} ms`));
    const client = await dialHost(statePath, { aim: { kind: "here" }, home: dir });
    try {
      await client.request("golden.get", { name: "default" });
    } finally {
      client.close();
    }
    host = await serving;
  }, 60_000);
});
