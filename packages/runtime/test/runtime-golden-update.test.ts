// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import type { EventUnion, RecipeDigest } from "@wsp/protocol";
import type { GoldenDelta, GoldenImport } from "@wsp/engine";
import { copyKey, GRACE_MS, createRuntime } from "../src/runtime.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { wsRequest } from "./ws-client.js";
import { missesFirstDelete, ownedStore, stubBackend, createOn, projectOn } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";

describe("runtime golden update and the post-seal grace", () => {
  const dfOk = (m: unknown, cmd: string) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: `${3000 * 1024}\n`, stderr: "" } : cmd === "echo ok" ? { exitCode: 0, stdout: "ok\n", stderr: "" } : cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
  const snapshot = (recipeHash: string, dests: string[]): RecipeDigest => ({ ticks: dests.map(d => ({ id: `shell/${d}` })), files: dests.map(d => ({ id: `shell/${d}`, dest: d, path: `~/${d}`, digest: `d-${recipeHash}` })) });
  const importOf = (recipeHash = "h1", agents: GoldenImport["agents"] = [{ id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version", road: "npm" as const }]): GoldenImport => ({
    recipeHash,
    recipe: snapshot(recipeHash, [".zshrc"]),
    files: { count: 1, rungs: { shell: 1 }, bytes: 10, lands: [], skipped: [], pack: async () => ({ tar: Buffer.from("t"), bytes: 10, unpacked: 10, skipped: [], cut: [], silenced: [], macPaths: [] }) },
    tools: [],
    agents,
  });
  const recipeWith = (imp: GoldenImport) => ({ setup: "true", smoke: "true", import: imp });
  const deltaOf = (recipeHash = "h2"): GoldenDelta => ({
    import: {
      recipeHash,
      recipe: snapshot(recipeHash, [".zshrc", ".config/starship.toml"]),
      files: { count: 1, rungs: { shell: 1 }, bytes: 5, lands: [], skipped: [], pack: async () => ({ tar: Buffer.from("d"), bytes: 5, unpacked: 5, skipped: [], cut: [], silenced: [], macPaths: [] }) },
      tools: [{ id: "tools/npm/cowsay", label: "cowsay", manager: "npm", cmd: "npm install -g cowsay" }],
      agents: [],
    },
    retired: [{ id: "shell/bashrc", name: "~/.bashrc" }],
    retiredOnImage: [{ id: "shell/bashrc", name: "~/.bashrc" }],
  });
  const started = () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = ownedStore();
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock, hostId: "h1", killConfirm: { graceMs: 20, pollMs: 1 } });
    return { backend, store, clock, advance, rt };
  };

  it("the seal keeps a builder built from a recipe: it runs on with the version on its record and view, the recipe is stored with the version, and the sweep leaves it be", async () => {
    const { backend, store, rt, clock } = started();
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    expect(version.version).toBe(1);
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_wsp-h1s1-default-v1", true]]);
    expect(frames.at(-1)).toBe("sealed:v1; builder kept for one more change");
    // A caller with no process left to end the window asks for no keep: the builder goes with the seal and leaves no record.
    const again = started();
    const b2 = await again.rt.golden.prepare();
    await again.rt.golden.seal(b2.id, { keepBuilder: false });
    expect(again.backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1s1-default-v1", true]]);
    expect(await again.store.list("builders")).toEqual([]);
    const sealedAt = new Date(clock.now()).toISOString();
    expect(await store.get("builders", b.id)).toMatchObject({ firstLife: true, sealed: { at: sealedAt, version: 1 }, import: { recipeHash: "h1" } });
    expect(await store.get("golden-recipes", copyKey("default", "default@v1"))).toEqual(snapshot("h1", [".zshrc"]));
    expect(await rt.golden.recipe()).toEqual(snapshot("h1", [".zshrc"]));
    expect(await rt.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealable: true, sealed: { at: sealedAt, version: 1 } })]);
    expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
    expect(backend.machines[0]!.killed).toBe(false);
  });

  it("a snapshot the provider refuses leaves the builder as it was and recorded, so the next process attaches to it; a builder the provider no longer has loses its record", async () => {
    const refused = () => Object.assign(new Error("Failed to snapshot sandbox"), { kind: "snapshotUnavailable", status: 502, requestId: "req_1" });
    const backend = stubBackend();
    backend.execImpl = dfOk;
    backend.beforeSnapshot = () => { throw refused(); };
    const store = ownedStore();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), snapshotRetryMs: 1 });
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const b = await rt.golden.prepare();
    await expect(rt.golden.seal(b.id)).rejects.toMatchObject({ kind: "snapshotFailed", attempts: 3, builderState: "running", answer: { status: 502, requestId: "req_1" } });
    expect(frames.at(-1)).toBe("failed:the snapshot failed 3 times: the provider answered 502 Failed to snapshot sandbox (request req_1) while the builder read running");
    expect(backend.machines.map(m => m.killed)).toEqual([false]);
    expect(await rt.golden.get()).toBeUndefined();
    expect(await rt.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealable: true })]);
    expect(await store.get("builders", b.id)).toMatchObject({ firstLife: true, import: { recipeHash: "h1" } });
    await rt.close();
    backend.beforeSnapshot = undefined;
    const again = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), snapshotRetryMs: 1, hostId: "h1" });
    expect((await again.golden.prepare()).id).toBe(b.id);
    expect((await again.golden.seal(b.id)).version.snapshotId).toBe("snap_wsp-h1s1-default-v1");
    expect(backend.machines).toHaveLength(2);

    const dropped = stubBackend();
    dropped.execImpl = dfOk;
    dropped.beforeSnapshot = m => { m.killed = true; throw refused(); };
    const lost = createRuntime({ backend: dropped, store: ownedStore(), adapters: {}, goldenRecipe: recipeWith(importOf()), snapshotRetryMs: 1, hostId: "h1" });
    const b2 = await lost.golden.prepare();
    await expect(lost.golden.seal(b2.id)).rejects.toMatchObject({ kind: "snapshotFailed", attempts: 1, builderState: "gone" });
    expect(await lost.golden.builders()).toEqual([]);
  });

  it("a builder built without a recipe snapshot is consumed by the seal as before, and the golden has no recipe to diff", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith({ ...importOf(), recipe: undefined }) });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await rt.golden.builders()).toEqual([]);
    expect(await rt.golden.recipe()).toBeUndefined();
  });

  it("an update during the grace lands on the kept builder: the delta's stages run there, the dropped row is retired on v2 and never taken off, one smoke fork boots, v2 is sealed and current, and the window starts over", async () => {
    const { backend, store, rt, advance, clock } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    advance(5 * 60_000);
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const builder = backend.machines[0]!;
    const before = builder.execLog.length;
    const result = await rt.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("builder");
    expect(result.previousDropped).toBe(false);
    // The kept builder was sealed as v1, so v2 records v1's snapshot as its parent.
    expect(result.version).toMatchObject({ version: 2, snapshotId: "snap_wsp-h1s1-default-v2", parentSnapshotId: "snap_wsp-h1s1-default-v1", smoke: { cmd: "codex --version", exitCode: 0 }, retired: [{ id: "shell/bashrc", name: "~/.bashrc" }] });
    expect(result.manifest).toMatchObject({ head: 2, versions: [{ version: 1 }, { version: 2 }] });
    expect(await rt.golden.get()).toEqual(result.manifest);
    expect(frames).toEqual([
      "creating:your builder from v1, kept since the save",
      "applying-setup:1 row left on the image, retired: ~/.bashrc",
      "applying-setup:1 file: shell 1",
      "applying-setup:5 B packed",
      "uploading-files:5 B",
      expect.stringMatching(/^uploading-files:5 B in /),
      "installing-harness:",
      "installing-harness:no agent ticked",
      "installing-tools:cowsay (1/1)",
      "installing-tools:1 installed; caches swept; 2.9 GB free",
      "installing-mcp:none configured",
      expect.stringMatching(/^installing-mcp:machine context: \d+(\.\d+)? KB written; no agent on the machine$/),
      "ready:",
      "snapshotting:syncing the disk",
      "snapshotting:snapshotting about 2.9 GB, usually under a minute",
      "smoke-forking:codex --version",
      "smoke-forking:1 agent answers: Codex",
      "sealed:v2; builder kept for one more change",
    ]);
    const ran = builder.execLog.slice(before);
    expect(ran[0]).toBe("true");
    expect(ran.some(c => c.includes("rm -rf -- '\\''/root/.bashrc'\\''"))).toBe(false);
    expect(ran.some(c => c.includes("npm install -g cowsay"))).toBe(true);
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_wsp-h1s1-default-v1", true], ["snap_wsp-h1s1-default-v2", true]]);
    expect(await store.get("builders", b.id)).toMatchObject({ sealed: { at: new Date(clock.now()).toISOString(), version: 2 }, import: { recipeHash: "h2", recipe: snapshot("h2", [".zshrc", ".config/starship.toml"]) } });
    expect(await store.get("golden-recipes", copyKey("default", "default@v2"))).toEqual(snapshot("h2", [".zshrc", ".config/starship.toml"]));
    expect(await rt.golden.recipe()).toEqual(snapshot("h2", [".zshrc", ".config/starship.toml"]));
    // Nine minutes after the second save the builder is still there; the window ran from that save, not the first.
    advance(9 * 60_000);
    expect(builder.killed).toBe(false);
    advance(60_000);
    // The timer's work is async: the kill lands, then the record goes.
    await vi.waitFor(async () => expect(await store.list("builders")).toEqual([]));
    expect(builder.killed).toBe(true);
  });

  it("a kept builder whose first delete at the window's end reached the copy that never held it is asked again until it is gone", async () => {
    const { backend, store, rt, advance } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    missesFirstDelete(backend.machines[0]!);
    advance(GRACE_MS);
    await vi.waitFor(async () => expect(await store.list("builders")).toEqual([]));
    await vi.waitFor(() => expect(backend.machines[0]!.killed).toBe(true));
    await rt.close();
  });

  it("the grace ends on the timer at GRACE_MS: the builder is killed and forgotten; a second process over the store past the window stops it on its sweep with reason grace", async () => {
    const { backend, store, rt, advance } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    advance(GRACE_MS - 1);
    expect(backend.machines[0]!.killed).toBe(false);
    advance(1);
    await vi.waitFor(async () => expect(await store.list("builders")).toEqual([]));
    expect(backend.machines[0]!.killed).toBe(true);
    await rt.close();

    const again = started();
    const b2 = await again.rt.golden.prepare();
    await again.rt.golden.seal(b2.id);
    await again.rt.close();
    // The next process reads the record as reusable; its clock is past the window, so the first sweep stops it.
    const late = fakeClock(again.clock.now() + GRACE_MS + 5_000);
    const next = createRuntime({ backend: again.backend, store: again.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: late.clock });
    expect(await next.golden.builders()).toEqual([expect.objectContaining({ id: b2.id, sealed: { at: expect.any(String), version: 1 } })]);
    expect(await next.reap()).toEqual({ reaped: [{ id: b2.id, builder: true, reason: "grace", ageMs: GRACE_MS + 5_000 }], spared: [] });
    expect(again.backend.machines[0]!.killed).toBe(true);
    expect(await again.store.list("builders")).toEqual([]);
  });

  it("coverage: a kept builder a second process rehydrates from the store seals its update with the floor the first process read", async () => {
    const { backend, store, rt, clock } = started();
    const floor = [{ name: "curl", version: "8.5.0" }, { name: "jq", version: "1.7.1" }];
    backend.execImpl = (m, cmd) => (cmd.includes("VERSION curl:") && !cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: "VERSION curl: curl 8.5.0\nVERSION jq: jq-1.7.1\nVERSION cc: \n", stderr: "" } : dfOk(m, cmd));
    const b = await rt.golden.prepare();
    const { version: one } = await rt.golden.seal(b.id);
    expect(one.base).toEqual(floor);
    expect(await store.get("builders", b.id)).toMatchObject({ base: floor });
    await rt.close();
    // The second process runs no base stage and reads no versions: the floor v2 records is the record's alone.
    backend.execImpl = dfOk;
    const next = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock, hostId: "h1" });
    const result = await next.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("builder");
    expect(result.version.base).toEqual(floor);
    expect((await next.golden.get())?.versions.map(v => v.base)).toEqual([floor, floor]);
    expect(await store.get("builders", b.id)).toMatchObject({ sealed: { version: 2 }, base: floor });
    await next.close();
  });

  it("with the builder gone the update forks the head at its size: the delta runs on the fork and takes nothing off it, v2 is sealed and current, the fork is kept for its own window, and v1 stays for rollback", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    // Killed from outside wsp: the kept builder is found dead at update time and forgotten.
    backend.machines[0]!.killed = true;
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const result = await rt.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("fork");
    expect(result.manifest).toMatchObject({ head: 2, versions: [{ version: 1, snapshotId: "snap_wsp-h1s1-default-v1" }, { version: 2, snapshotId: "snap_wsp-h1s1-default-v2", parentSnapshotId: "snap_wsp-h1s1-default-v1" }] });
    expect(result.manifest.versions[0]).not.toHaveProperty("parentSnapshotId");
    expect(frames[0]).toBe("creating:fork of golden v1");
    const fork = backend.machines[2]!;
    expect(fork.spec).toMatchObject({ kind: "sandbox", fromSnapshot: "snap_wsp-h1s1-default-v1", cpu: 2, memMb: 4096, onIdle: "kill", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": "s1" } });
    expect(fork.execLog.some(c => c.includes("rm -rf -- '\\''/root/.bashrc'\\''"))).toBe(false);
    expect(fork.execLog.some(c => c.includes("npm install -g cowsay"))).toBe(true);
    expect(fork.killed).toBe(false);
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1s1-default-v1", true], ["snap_wsp-h1s1-default-v1", false], ["snap_wsp-h1s1-default-v2", true]]);
    expect(await store.list("builders")).toEqual([expect.objectContaining({ id: fork.id, firstLife: true, sealed: { at: expect.any(String), version: 2 } })]);
    expect(await store.get("golden-recipes", copyKey("default", "default@v1"))).toBeDefined();
    expect(await store.get("golden-recipes", copyKey("default", "default@v2"))).toBeDefined();
  });

  it("keepPrevious false deletes the previous version's snapshot and drops it from the manifest; a snapshot that will not delete keeps its version", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const deleted = vi.spyOn(backend, "deleteSnapshot");
    const two = await rt.golden.upgrade({ delta: deltaOf("h2"), keepPrevious: false });
    expect(deleted.mock.calls).toEqual([["snap_wsp-h1s1-default-v1"]]);
    expect(two.previousDropped).toBe(true);
    expect(two.manifest).toEqual({ head: 2, versions: [expect.objectContaining({ version: 2 })] });
    expect(await rt.golden.get()).toEqual(two.manifest);
    expect(await store.get("golden-recipes", copyKey("default", "default@v1"))).toBeUndefined();
    expect(await store.get("golden-recipes", copyKey("default", "default@v2"))).toBeDefined();

    deleted.mockRejectedValueOnce(Object.assign(new Error("SnapshotHasChildren"), { status: 409 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const three = await rt.golden.upgrade({ delta: deltaOf("h3"), keepPrevious: false });
    warn.mockRestore();
    expect(three.previousDropped).toBe(false);
    expect(three.manifest).toMatchObject({ head: 3, versions: [{ version: 2 }, { version: 3 }] });
    expect(await store.get("golden-recipes", copyKey("default", "default@v2"))).toBeDefined();
  });

  it("keepPrevious false leaves a durable version alone while a workspace stands on it: its template would delete under the workspace's feet", async () => {
    const { backend, rt } = started();
    backend.capabilities.templates = true;
    const b = await rt.golden.prepare();
    const { version: one } = await rt.golden.seal(b.id);
    expect(one.templateId).toBe("tpl_wsp-h1s1-default-v1");
    const ws = await createOn(rt, { golden: one.snapshotId, name: "on-v1" });
    expect(backend.machines.find(m => m.id === ws.machineId)!.spec).toMatchObject({ template: "tpl_wsp-h1s1-default-v1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const two = await rt.golden.upgrade({ delta: deltaOf("h2"), keepPrevious: false });
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual(["golden default v1 kept: on-v1 still on it"]);
    warn.mockRestore();
    expect(two.previousDropped).toBe(false);
    expect(two.manifest.versions.map(v => [v.version, v.templateId])).toEqual([[1, "tpl_wsp-h1s1-default-v1"], [2, "tpl_wsp-h1s1-default-v2"]]);
    expect(backend.templates.has("tpl_wsp-h1s1-default-v1")).toBe(true);
    expect(backend.snapshots.map(r => r.id)).toContain("snap_wsp-h1s1-default-v1");

    await rt.workspaces.delete(ws.id);
    const three = await rt.golden.upgrade({ delta: deltaOf("h3"), keepPrevious: false });
    expect(three.previousDropped).toBe(true);
    expect(backend.templates.has("tpl_wsp-h1s1-default-v2")).toBe(false);
    expect(backend.snapshots.map(r => r.id)).not.toContain("snap_wsp-h1s1-default-v2");
  });

  it("dropping the previous version on the fork road ends the fork builder first, since it descends from that snapshot", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    backend.machines[0]!.killed = true;
    const deleted = vi.spyOn(backend, "deleteSnapshot");
    const two = await rt.golden.upgrade({ delta: deltaOf(), keepPrevious: false });
    expect(two.road).toBe("fork");
    expect(two.previousDropped).toBe(true);
    expect(deleted.mock.calls).toEqual([["snap_wsp-h1s1-default-v1"]]);
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1s1-default-v1", true], ["snap_wsp-h1s1-default-v1", true], ["snap_wsp-h1s1-default-v2", true]]);
    expect(await store.list("builders")).toEqual([]);
    expect(two.manifest).toEqual({ head: 2, versions: [expect.objectContaining({ version: 2 })] });
  });

  it("composes with the reuse rules: a kept builder from an earlier process is the update's machine; one another live process holds is neither used nor stopped from here", async () => {
    const first = started();
    const b = await first.rt.golden.prepare();
    await first.rt.golden.seal(b.id);
    await first.rt.close();

    const second = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: fakeClock(first.clock.now()).clock });
    const onKept = await second.golden.upgrade({ delta: deltaOf() });
    expect(onKept.road).toBe("builder");
    expect(first.backend.machines[0]!.killed).toBe(false);
    expect(await first.store.get("builders", b.id)).toMatchObject({ sealed: { version: 2 }, heldBy: { pid: process.pid } });
    await second.close();

    // Held by another live process (a pid that is not ours and is alive): listed, left alone, the update forks instead.
    const record = (await first.store.get("builders", b.id)) as { heldBy?: { host: string; pid: number; heartbeat: string } };
    await first.store.put("builders", b.id, { ...record, heldBy: { host: hostname(), pid: process.ppid, heartbeat: new Date().toISOString() } });
    const late = fakeClock(Date.now() + GRACE_MS + 60_000);
    const third = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: late.clock });
    expect(await third.golden.builders()).toEqual([expect.objectContaining({ id: b.id, heldBy: expect.objectContaining({ pid: process.ppid }), sealed: { at: expect.any(String), version: 2 } })]);
    expect(await third.reap()).toEqual({ reaped: [], spared: [] });
    expect(first.backend.machines[0]!.killed).toBe(false);
    const forked = await third.golden.upgrade({ delta: deltaOf("h3") });
    expect(forked.road).toBe("fork");
    expect(first.backend.machines[0]!.killed).toBe(false);
  });

  it("a delta that fails on the kept builder kills it, forgets it, and leaves the golden at its version", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    backend.execImpl = (m, cmd) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: "1\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    await expect(rt.golden.upgrade({ delta: deltaOf() })).rejects.toThrow(/your files need/);
    expect(frames.at(-1)).toMatch(/^failed:your files need/);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
    expect(await rt.golden.get()).toMatchObject({ head: 1, versions: [{ version: 1 }] });
    expect(backend.machines).toHaveLength(2);
  });

  it("the window is suspended while an update runs on the kept builder: the timer and the sweep leave it alone mid-stage, and the window is re-armed on success", async () => {
    const { backend, store, rt, advance } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    advance(9 * 60_000);
    let release: (() => void) | undefined;
    const gate = new Promise<void>(r => (release = r));
    let packing = false;
    const delta = deltaOf();
    delta.import.files!.pack = async () => {
      packing = true;
      await gate;
      return { tar: Buffer.from("d"), bytes: 5, unpacked: 5, skipped: [], cut: [], silenced: [], macPaths: [] };
    };
    const running = rt.golden.upgrade({ delta });
    await vi.waitFor(() => expect(packing).toBe(true));
    expect(await store.get("builders", b.id)).not.toHaveProperty("sealed");
    advance(2 * 60_000);
    expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
    expect(backend.machines[0]!.killed).toBe(false);
    release!();
    const result = await running;
    expect(result.road).toBe("builder");
    const settled = (await store.get("builders", b.id)) as Record<string, unknown>;
    expect(settled).toMatchObject({ sealed: { version: 2 } });
    // Settled: the record is sealed again and no longer marked as mid-setup, so the next process reuses it.
    expect(settled).not.toHaveProperty("building");
    advance(GRACE_MS);
    await vi.waitFor(async () => expect(await store.list("builders")).toEqual([]));
    expect(backend.machines[0]!.killed).toBe(true);
  });

  it("a crash mid-update leaves the kept builder marked building, so the next process over the store stops it as unfinished instead of keeping it six hours", async () => {
    const first = started();
    const b = await first.rt.golden.prepare();
    await first.rt.golden.seal(b.id);
    let packing = false;
    const delta = deltaOf();
    delta.import.files!.pack = async () => {
      packing = true;
      return new Promise(() => {});
    };
    void first.rt.golden.upgrade({ delta });
    await vi.waitFor(() => expect(packing).toBe(true));
    expect(await first.store.get("builders", b.id)).toMatchObject({ building: true });
    expect(await first.store.get("builders", b.id)).not.toHaveProperty("sealed");
    // The process died here; another one, past the window, reads the record.
    const late = fakeClock(first.clock.now() + GRACE_MS + 1000);
    const next = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: late.clock, hostId: "h1" });
    expect(await next.golden.builders()).toEqual([expect.objectContaining({ id: b.id, building: true })]);
    expect(await next.reap()).toEqual({ reaped: [{ id: b.id, builder: true, reason: "unfinished" }], spared: [] });
    expect(first.backend.machines[0]!.killed).toBe(true);
    expect(await first.store.list("builders")).toEqual([]);
  });

  it("an update whose smoke fork the cap refuses falls back to killing the builder first and says so on the result", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const create = backend.create.bind(backend);
    let refused = false;
    backend.create = async spec => {
      if (spec.fromSnapshot === "snap_wsp-h1s1-default-v2" && !refused) {
        refused = true;
        throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency" });
      }
      return create(spec);
    };
    const kept = await rt.golden.upgrade({ delta: deltaOf() });
    expect(kept.road).toBe("builder");
    expect(kept.builderKept).toBe(false);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
    backend.create = create;
    const forked = await rt.golden.upgrade({ delta: deltaOf("h3") });
    expect(forked.road).toBe("fork");
    expect(forked.builderKept).toBe(true);
  });

  it("a kept builder that fails the no-op is killed until gone and forgotten, never left billing; the update forks", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const builder = backend.machines[0]!;
    const exec = builder.exec.bind(builder);
    builder.exec = async cmd => {
      if (cmd === "true") throw new Error("502 Bad Gateway");
      return exec(cmd);
    };
    const result = await rt.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("fork");
    expect(builder.killed).toBe(true);
    expect((await store.list("builders")).map(r => (r as { id: string }).id)).toEqual([backend.machines[2]!.id]);
  });

  it("a kept builder past its window is never used, running or not: the update forks and the old one is stopped", async () => {
    const first = started();
    const b = await first.rt.golden.prepare();
    await first.rt.golden.seal(b.id);
    await first.rt.close();
    const late = fakeClock(first.clock.now() + GRACE_MS + 1000);
    const next = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: late.clock, hostId: "h1" });
    expect(await next.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealed: expect.objectContaining({ version: 1 }) })]);
    const result = await next.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("fork");
    expect(first.backend.machines[0]!.killed).toBe(true);
    expect(first.backend.machines[2]!.spec.fromSnapshot).toBe("snap_wsp-h1s1-default-v1");
    expect((await first.store.list("builders")).map(r => (r as { id: string }).id)).toEqual([first.backend.machines[2]!.id]);
  });

  it("a kept builder past its window whose kill fails is still never used: the update forks beside it and the record stays for the next sweep", async () => {
    const first = started();
    const b = await first.rt.golden.prepare();
    await first.rt.golden.seal(b.id);
    await first.rt.close();
    const machine = first.backend.machines[0]!;
    machine.kill = async () => {
      throw new Error("502 Bad Gateway");
    };
    const late = fakeClock(first.clock.now() + GRACE_MS + 1000);
    const next = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: late.clock, hostId: "h1" });
    const before = machine.execLog.length;
    const frames: string[] = [];
    next.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const result = await next.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("fork");
    // Not even the no-op runs on it, and the person hears why it is still there.
    expect(machine.execLog).toHaveLength(before);
    expect(frames[0]).toBe(`creating:an earlier kept builder ${b.id}: could not stop: 502 Bad Gateway; stays recorded, retried next sweep`);
    expect(frames[1]).toBe("creating:fork of golden v1");
    expect(await first.store.get("builders", b.id)).toMatchObject({ sealed: { version: 1 } });
  });

  it("one kept builder whose kill fails does not stop the others: it is reported on the sweep and retried next time", async () => {
    const { backend, store, rt, advance } = started();
    const a = await rt.golden.prepare({ name: "a" });
    await rt.golden.seal(a.id);
    const b = await rt.golden.prepare({ name: "b" });
    await rt.golden.seal(b.id);
    const first = backend.machines[0]!;
    const kill = first.kill.bind(first);
    first.kill = async () => {
      throw new Error("502 Bad Gateway");
    };
    advance(GRACE_MS);
    await vi.waitFor(async () => expect(await store.list("builders")).toHaveLength(1));
    expect(backend.machines[2]!.killed).toBe(true);
    expect(first.killed).toBe(false);
    const swept = await rt.reap();
    expect(swept.reaped).toEqual([]);
    expect(swept.failed).toEqual([{ id: a.id, message: expect.stringContaining("502 Bad Gateway") }]);
    expect(await store.get("builders", a.id)).toMatchObject({ sealed: { version: 1 } });
    first.kill = kill;
    expect((await rt.reap()).reaped).toEqual([{ id: a.id, builder: true, reason: "grace", ageMs: expect.any(Number) }]);
    expect(await store.list("builders")).toEqual([]);
  });

  it("prepare never attaches to a builder kept since a save, even on the same recipe: a fresh one boots beside it", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const again = await rt.golden.prepare();
    expect(again.id).not.toBe(b.id);
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_wsp-h1s1-default-v1", true], [undefined, false]]);
    expect(await store.get("builders", b.id)).toMatchObject({ sealed: { version: 1 } });
    expect(await store.get("builders", again.id)).not.toHaveProperty("sealed");
  });

  it("a workspace create refused at the cap stops the kept builder first, says so, and creates; with no kept builder the refusal stands", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined && backend.machines.some(m => !m.killed)) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = await createOn(rt, { golden: version.snapshotId, name: "one" });
    const said = warn.mock.calls.map(c => String(c[0]));
    warn.mockRestore();
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
    expect(ws.machineId).toBe(backend.machines[2]!.id);
    // The person who asked for the workspace reads why a builder of theirs went, on the create's own result.
    expect(ws.notice).toBe("Stopped the builder kept from image v1 to make room at the machine cap.");
    expect(said).toEqual([`workspace ${ws.id}: stopped the builder kept from image v1 to make room at the machine cap (${b.id})`]);

    // Nothing left to stop: the refusal reaches the caller with its kind, and nothing of ours is killed.
    await expect(createOn(rt, { golden: version.snapshotId, name: "two" })).rejects.toMatchObject({ kind: "concurrency" });
    expect(backend.machines.filter(m => m.killed).map(m => m.id)).toEqual([backend.machines[0]!.id, backend.machines[1]!.id]);
  });

  it("a create at the cap with nothing left to stop is refused in words naming the workspaces holding the slots, not the provider's sentence", async () => {
    const { backend, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    await rt.golden.kill(b.id);
    const first = await createOn(rt, { golden: version.snapshotId, name: "first" });
    await createOn(rt, { golden: version.snapshotId, name: "t-cap" });
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
      return create(spec);
    };
    const stages: EventUnion[] = [];
    rt.events.on("workspace.creating", e => stages.push(e));
    const refused = await createOn(rt, { golden: version.snapshotId, name: "f2" }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ kind: "concurrency", status: 429, message: "both machine slots are in use: first, t-cap. Pause one or wait for a nap." });
    // The provider's own sentence is kept for whoever reads the log, never as the answer.
    expect((refused as { cause?: Error }).cause?.message).toBe("Too many concurrent sessions");
    // The app's creation log reads the failed stage, so the same words land there.
    expect(stages.at(-1)).toMatchObject({ stage: "failed", message: "both machine slots are in use: first, t-cap. Pause one or wait for a nap." });

    // A napped workspace holds no slot, so it is not named; the builder that is up is, as a builder.
    await rt.workspaces.nap(first.id);
    const kept = await rt.golden.prepare({ name: "wsp-golden" }).catch((e: unknown) => e);
    expect(kept).toMatchObject({ id: expect.any(String) });
    const again = await createOn(rt, { golden: version.snapshotId, name: "f3" }).catch((e: unknown) => e);
    expect((again as Error).message).toBe("both machine slots are in use: t-cap, wsp-golden (builder). Pause one or wait for a nap.");
  });

  it("a create at the cap names a workspace whose own create is still in flight: its machine is up and holds a slot", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    await rt.golden.kill(b.id);
    // A record reaches the store only once its machine is bound, so holding that write holds a create in flight.
    const put = store.put.bind(store);
    let bound = (): void => {};
    let land = (): void => {};
    const inFlight = new Promise<void>(resolve => { bound = resolve; });
    const held = new Promise<void>(resolve => { land = resolve; });
    store.put = async (collection, id, value) => {
      const r = value as { name?: string; machineId?: string };
      if (r.name === "slow" && (r.machineId ?? "") !== "") {
        bound();
        await held;
      }
      await put(collection, id, value);
    };
    const slow = createOn(rt, { golden: version.snapshotId, name: "slow" });
    await inFlight;
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
      return create(spec);
    };
    const refused = await createOn(rt, { golden: version.snapshotId, name: "f2" }).catch((e: unknown) => e);
    expect((refused as Error).message).toBe("a machine slot is in use: slow. Pause it or wait for a nap.");
    land();
    expect(await slow).toMatchObject({ name: "slow" });
  });

  it("a create that made room reports the fork twice, the second time with the builder it stopped as the notice", async () => {
    const { backend, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined && backend.machines.some(m => !m.killed)) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    const stages: EventUnion[] = [];
    rt.events.on("workspace.creating", e => stages.push(e));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = await createOn(rt, { golden: version.snapshotId, name: "one" });
    warn.mockRestore();
    expect(stages.map(e => (e.type === "workspace.creating" ? e.stage : e.type))).toEqual(["fork-requested", "fork-requested", "hostname-set", "project-cloned", "ready"]);
    expect(stages[0]).not.toHaveProperty("notice");
    expect(stages[1]).toMatchObject({
      workspaceId: ws.id,
      message: "starting one on default again",
      notice: "Stopped the builder kept from image v1 to make room at the machine cap.",
    });
    expect(stages.map(e => (e.type === "workspace.creating" ? e.name : ""))).toEqual(Array<string>(5).fill("one"));
  });

  it("a create that needs no room carries no notice, on the result and on the wire; one that made room carries it beside the workspace", async () => {
    const { backend, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    await rt.golden.kill(b.id);
    const quiet = await wsRequest(srv.port, "t", { op: "workspaces.create", project: (await projectOn(rt)).id, golden: version.snapshotId, name: "quiet" });
    expect(quiet["ok"]).toBe(true);
    expect(quiet).not.toHaveProperty("notice");
    expect(quiet["workspace"]).not.toHaveProperty("notice");
    const second = await rt.golden.prepare({ name: "other" });
    await rt.golden.seal(second.id);
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined && backend.machines.filter(m => !m.killed).length >= 2) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const made = await wsRequest(srv.port, "t", { op: "workspaces.create", project: (await projectOn(rt)).id, golden: version.snapshotId, name: "room" });
    warn.mockRestore();
    expect(made["ok"]).toBe(true);
    expect(made["notice"]).toBe("Stopped the builder kept from image v1 to make room at the machine cap.");
    expect(made["workspace"]).not.toHaveProperty("notice");
    await srv.close();
  });

  it("a computer that would not fork at the size asked for says so on the create, and the record keeps the size it gave", async () => {
    const { backend, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    await rt.golden.kill(b.id);
    backend.createNotice = "size 2x4 on 2 cores: cpu clamped to 1 and memory clamped to 2 GB";
    const ws = await createOn(rt, { golden: version.snapshotId, name: "on-the-box" });
    expect(ws.notice).toBe("size 2x4 on 2 cores: cpu clamped to 1 and memory clamped to 2 GB");
    // The sentence is the whole of what travels: the size a reader wants is the machine's own, not the ask.
    expect(ws).not.toHaveProperty("cpu");
  });

  it("with two kept builders one is stopped per refusal: the first retry succeeds and the second builder stays", async () => {
    const { backend, store, rt } = started();
    const a = await rt.golden.prepare({ name: "a" });
    const sealedA = await rt.golden.seal(a.id);
    const b = await rt.golden.prepare({ name: "b" });
    await rt.golden.seal(b.id);
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined && backend.machines.filter(m => !m.killed).length >= 2) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = await createOn(rt, { golden: sealedA.version.snapshotId, name: "one" });
    warn.mockRestore();
    const stopped = [a.id, b.id].filter(id => backend.machines.find(m => m.id === id)!.killed);
    expect(stopped).toHaveLength(1);
    expect((await store.list("builders")).map(r => (r as { id: string }).id)).toEqual([a.id, b.id].filter(id => !stopped.includes(id)));
    expect(ws.notice).toBe("Stopped the builder kept from image v1 to make room at the machine cap.");

    // The cap at one: the next create needs a second slot, so the remaining kept builder goes on the second refusal.
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined && backend.machines.filter(m => !m.killed).length >= 2) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const two = await createOn(rt, { golden: sealedA.version.snapshotId, name: "two" });
    quiet.mockRestore();
    expect(await store.list("builders")).toEqual([]);
    expect(two.notice).toBe("Stopped the builder kept from image v1 to make room at the machine cap.");
  });

  it("a kept builder another live process holds is not stopped to make room; the refusal stands", async () => {
    const first = started();
    const b = await first.rt.golden.prepare();
    const { version } = await first.rt.golden.seal(b.id);
    await first.rt.close();
    const record = (await first.store.get("builders", b.id)) as { heldBy?: { host: string; pid: number; heartbeat: string } };
    await first.store.put("builders", b.id, { ...record, heldBy: { host: hostname(), pid: process.ppid, heartbeat: new Date().toISOString() } });
    const next = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: fakeClock(first.clock.now()).clock });
    const create = first.backend.create.bind(first.backend);
    first.backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    await expect(createOn(next, { golden: version.snapshotId, name: "one" })).rejects.toMatchObject({ kind: "concurrency" });
    expect(first.backend.machines[0]!.killed).toBe(false);
  });

  it("the seal stamps the tools missing from the image on the version, and an update carries them on both roads", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const skippedTools = [{ id: "tools/brew-cask/raycast", label: "Raycast", note: "macOS app, no Linux build" }];
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith({ ...importOf(), skippedTools }), clock: fakeClock().clock });
    const b = await rt.golden.prepare();
    const want = [{ id: "tools/brew-cask/raycast", name: "Raycast", outcome: "skipped", note: "macOS app, no Linux build" }];
    expect((await rt.golden.seal(b.id)).version.missingTools).toEqual(want);
    const two = await rt.golden.upgrade({ delta: deltaOf("h2") });
    expect(two.road).toBe("builder");
    expect(two.version.missingTools).toEqual(want);
    backend.machines[0]!.killed = true;
    const three = await rt.golden.upgrade({ delta: deltaOf("h3") });
    expect(three.road).toBe("fork");
    expect(three.version.missingTools).toEqual(want);
    expect((await rt.golden.get())?.versions.map(v => v.missingTools)).toEqual([want, want, want]);
  });

  it("the seal stamps what the pack left off the image on the version, and an update carries it on both roads", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const left = [{ id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: /opt/homebrew/bin/terminal-notifier" }];
    const imp = importOf();
    const files = { ...imp.files!, pack: async () => ({ tar: Buffer.from("t"), bytes: 10, unpacked: 10, skipped: [...left], cut: [], silenced: [], macPaths: [], leftBehind: left }) };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith({ ...imp, files }), clock: fakeClock().clock });
    const b = await rt.golden.prepare();
    expect((await rt.golden.seal(b.id)).version.leftBehind).toEqual(left);
    const two = await rt.golden.upgrade({ delta: deltaOf("h2") });
    expect(two.road).toBe("builder");
    expect(two.version.leftBehind).toEqual(left);
    backend.machines[0]!.killed = true;
    const three = await rt.golden.upgrade({ delta: deltaOf("h3") });
    expect(three.road).toBe("fork");
    expect(three.version.leftBehind).toEqual(left);
    expect((await rt.golden.get())?.versions.map(v => v.leftBehind)).toEqual([left, left, left]);
  });

  it("an update stamps the logins it is given on the new version, on both roads; one given none carries none", async () => {
    const { backend, rt } = started();
    const b = await rt.golden.prepare();
    const v1 = [{ name: "GitHub CLI login", state: "signed-in" as const }, { name: "Codex login", state: "not-signed-in" as const }];
    await rt.golden.seal(b.id, { logins: v1 });
    const carried = [{ name: "GitHub CLI login", state: "signed-in" as const }, { name: "Codex login", state: "copied" as const }];
    const two = await rt.golden.upgrade({ delta: deltaOf("h2"), logins: carried });
    expect(two.road).toBe("builder");
    expect(two.version.logins).toEqual(carried);
    expect((await rt.golden.get())?.versions.map(v => v.logins)).toEqual([v1, carried]);
    backend.machines[0]!.killed = true;
    const three = await rt.golden.upgrade({ delta: deltaOf("h3"), logins: carried });
    expect(three.road).toBe("fork");
    expect(three.version.logins).toEqual(carried);
    const four = await rt.golden.upgrade({ delta: deltaOf("h4") });
    expect(four.version).not.toHaveProperty("logins");
  });

  it("an update with no golden to update is refused before anything boots", async () => {
    const { backend, rt } = started();
    await expect(rt.golden.upgrade({ delta: deltaOf() })).rejects.toThrow(/no golden named "default" to update/);
    expect(backend.machines).toEqual([]);
  });
});
