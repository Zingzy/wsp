// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import { BUILDER_IDLE_MS, type GoldenImport } from "@wsp/engine";
import { createRuntime } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { answersGoneOnce, stubBackend } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { setupRan, TOKEN_PATH } from "./runtime-fixture.js";

describe("runtime golden import", () => {
  const importOf = (recipeHash = "h1"): GoldenImport => ({
    recipeHash,
    files: { count: 1, rungs: { shell: 1 }, bytes: 10, lands: [], skipped: [], pack: async () => ({ tar: Buffer.from("t"), bytes: 10, unpacked: 10, skipped: [], cut: [], silenced: [], macPaths: [] }) },
    tools: [{ id: "tools/brew/jq", label: "jq", manager: "brew", cmd: "brew install jq" }],
    agents: [{ id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version", road: "npm" as const }],
  });
  const dfOk = (m: unknown, cmd: string) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: `${3000 * 1024}\n`, stderr: "" } : cmd === "echo ok" ? { exitCode: 0, stdout: "ok\n", stderr: "" } : cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });

  it("prepare runs the import stages on the wire, records the ledger on the builder, and seals with the builder's own smoke", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: { setup: "true", smoke: "true", import: importOf() } });
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(e.detail === undefined ? e.stage : `${e.stage}:${e.detail}`); });
    const b = await rt.golden.prepare();
    expect(frames.filter(f => !f.startsWith("uploading-files:"))).toEqual([
      "creating:sandbox from base",
      "deploying-daemon",
      ...["login shell PATH", "apt index", "curl", "uv", "Python 3.12", "git", "jq", "ripgrep", "C toolchain with cmake and ninja", "fd", "sqlite3", "wget", "zip and unzip", "xz", "rsync", "OpenSSH server"].map((label, i) => `deploying-daemon:${label} (${i + 1}/16)`),
      "deploying-daemon:16 installed; caches swept; 2.9 GB free",
      // The stub answers the versions read with nothing, so the stage closes on the disk alone.
      "deploying-daemon:2.9 GB free",
      "applying-setup:1 file: shell 1",
      "applying-setup:10 B packed",
      "installing-harness",
      "installing-harness:Codex (1/1)",
      "installing-harness:Codex installed; caches swept; 2.9 GB free",
      "installing-tools:jq (1/1)",
      "installing-tools:1 installed; caches swept; 2.9 GB free",
      "installing-mcp:none configured",
      expect.stringMatching(/^installing-mcp:machine context: \d+(\.\d+)? KB written; no agent on the machine$/),
      "ready",
    ]);
    expect(await store.get("builders", b.id)).toMatchObject({ import: { recipeHash: "h1", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"], smoke: "codex --version" } });
    const { version } = await rt.golden.seal(b.id);
    expect(version.smoke).toEqual({ cmd: "codex --version", exitCode: 0 });
    expect(backend.machines[1]!.execLog).toEqual(["codex --version", "test -x /usr/local/bin/wsp-open"]);
  });

  it("a second prepare with the same recipe hash reuses the live builder instead of booting another, skipping every stage", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: { setup: "true", smoke: "true", import: importOf() } });
    const first = await rt.golden.prepare();
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const again = await rt.golden.prepare();
    expect(again.id).toBe(first.id);
    expect(backend.machines).toHaveLength(1);
    // The machine and its daemon are already there too: the terminal shows every stage the same way.
    expect(frames).toEqual([
      "creating:already applied",
      "deploying-daemon:already applied",
      "applying-setup:already applied",
      "uploading-files:already applied",
      "installing-harness:already applied",
      "installing-tools:already applied",
      "installing-mcp:already applied",
      "ready:",
    ]);
    expect(await rt.golden.builders()).toHaveLength(1);
  });

  const recipeWith = (imp: GoldenImport) => ({ setup: "true", smoke: "true", import: imp });
  const SKIPPED = ["creating:already applied", "deploying-daemon:already applied", "applying-setup:already applied", "uploading-files:already applied", "installing-harness:already applied", "installing-tools:already applied", "installing-mcp:already applied", "ready:"];

  it("a first-life builder from an earlier process with the same recipe is attached to: every stage skipped, one machine, and it seals", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    expect(await store.get("builders", b.id)).toMatchObject({ firstLife: true });

    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect(await second.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealable: true, recipeHash: "h1" })]);
    const frames: string[] = [];
    second.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const again = await second.golden.prepare();
    expect(again).toMatchObject({ id: b.id, sealable: true, recipeHash: "h1" });
    expect(backend.machines).toHaveLength(1);
    expect(frames).toEqual(SKIPPED);
    expect(await second.reap()).toEqual({ reaped: [], spared: [] });
    const { version } = await second.golden.seal(b.id);
    expect(version.smoke).toEqual({ cmd: "codex --version", exitCode: 0 });
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
  });

  it("a builder found paused is refused: its marker is cleared for good, a fresh one boots, and reap stops it", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    backend.machines[0]!.paused = true;

    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect(await second.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealable: false })]);
    expect(await store.get("builders", b.id)).toMatchObject({ firstLife: false });
    const fresh = await second.golden.prepare();
    expect(fresh.id).not.toBe(b.id);
    expect(backend.machines).toHaveLength(2);

    // Resumed from outside wsp: the provider reports it running again, and this provider takes no seal from a machine that was.
    backend.machines[0]!.paused = false;
    const third = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect((await third.golden.builders()).map(x => [x.id, x.sealable])).toEqual([[b.id, false], [fresh.id, true]]);
    expect(await third.reap()).toEqual({ reaped: [{ id: b.id, builder: true, reason: "recorded" }], spared: [] });
    expect(backend.machines.map(m => m.killed)).toEqual([true, false]);
  });

  it("which life a seal may be taken from is the place's rule: a builder that woke is still sealable where a copy is the disk as it stands, and the sweep leaves it", async () => {
    // Solari refuses a resumed machine with a 502 and consumes the builder; a container's commit and a box's named
    // snapshot read the disk as it stands, so a builder that napped and woke there still has a seal in it.
    const backend = stubBackend();
    backend.capabilities.snapshotsAnyLife = true;
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    backend.machines[0]!.paused = true;

    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    // The record keeps the machine's own first life; the view carries the place's answer about it.
    expect(await second.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealable: true })]);
    expect(await store.get("builders", b.id)).toMatchObject({ firstLife: false });
    expect(await second.reap()).toEqual({ reaped: [], spared: [] });
    expect(backend.machines.map(m => m.killed)).toEqual([false]);
    // And it is attached to rather than left for a fresh machine: the stages it carries are not run again.
    backend.machines[0]!.paused = false;
    const again = await second.golden.prepare();
    expect(again.id).toBe(b.id);
    expect(backend.machines).toHaveLength(1);
    expect((await second.golden.seal(b.id)).version.smoke).toEqual({ cmd: "codex --version", exitCode: 0 });
  });

  it("the digest behind the recipe hash is recorded on the builder and read back on its view, in this process and the next", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const recipe = { ticks: [{ id: "shell/zshrc" }, { id: "tools/npm/bun", version: "1.4.0" }], files: [{ id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d1" }] };
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith({ ...importOf(), recipe }) });
    const b = await first.golden.prepare();
    expect(b.recipe).toEqual(recipe);
    expect(await store.get("builders", b.id)).toMatchObject({ import: { recipeHash: "h1", recipe } });
    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf("h9")) });
    expect(await second.golden.builders()).toEqual([expect.objectContaining({ id: b.id, recipeHash: "h1", recipe })]);
  });

  it("an attach whose volatile re-import fails keeps the builder: the machine lives, the record stays, the stage carries the reason", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    const files = { ...importOf().files!, volatile: { paths: ["~/.claude.json"], pack: async (): Promise<never> => { throw new Error("upload refused"); } } };
    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith({ ...importOf(), files }) });
    const frames: string[] = [];
    second.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const again = await second.golden.prepare();
    expect(again.id).toBe(b.id);
    expect(backend.machines[0]!.killed).toBe(false);
    expect(frames).toContain("uploading-files:~/.claude.json not re-imported: upload refused");
    expect(frames.at(-1)).toBe("ready:");
    expect(await store.get("builders", b.id)).toMatchObject({ import: { recipeHash: "h1", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"] } });
  });

  it("a stored builder one gateway copy answers 404 for at the next process's load keeps its record, and the next build attaches to it", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    answersGoneOnce(backend, backend.machines[0]!);
    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    await second.golden.builders();
    expect(await store.get("builders", b.id)).toMatchObject({ id: b.id });
    expect((await second.golden.prepare()).id).toBe(b.id);
    expect(backend.machines).toHaveLength(1);
  });

  it("kill stops a builder of this setup by its recorded id and drops the record, from this process or the next", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf("h9")) });
    await second.golden.kill(b.id);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
    expect(await second.golden.builders()).toEqual([]);
    await expect(second.golden.kill(b.id)).rejects.toThrow(`no such builder: ${b.id}`);
    const own = await second.golden.prepare();
    await second.golden.kill(own.id);
    expect(backend.machines[1]!.killed).toBe(true);
    expect(await second.golden.builders()).toEqual([]);
  });

  it("kill refuses a builder another live process holds and one wearing another setup's label, and touches neither", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    const record = (await store.get("builders", b.id)) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", b.id, { ...record, heldBy: { ...record.heldBy, pid: process.ppid } });
    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf("h9")) });
    await expect(second.golden.kill(b.id)).rejects.toThrow(`${b.id} is in use by another wsp process (pid ${process.ppid}); it is never sealed or reached from here`);
    expect(backend.machines[0]!.killed).toBe(false);

    await store.put("builders", b.id, record);
    await store.put("owner", "id", { id: "h_other" });
    const third = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf("h9")) });
    await expect(third.golden.kill(b.id)).rejects.toThrow("wears another setup's owner label");
    expect(backend.machines[0]!.killed).toBe(false);
    expect(await store.list("builders")).toHaveLength(1);
  });

  it("a different recipe hash gets a fresh machine; the earlier first-life builder stays, listed with its hash", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();

    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf("h9")) });
    const fresh = await second.golden.prepare();
    expect(fresh.id).not.toBe(b.id);
    expect(backend.machines).toHaveLength(2);
    expect((await second.golden.builders()).map(x => [x.id, x.sealable, x.recipeHash])).toEqual([[b.id, true, "h1"], [fresh.id, true, "h9"]]);
    expect(await second.reap()).toEqual({ reaped: [], spared: [] });
    expect(backend.machines.some(m => m.killed)).toBe(false);
  });

  it("a builder wearing another owner's label is refused and never touched, and the view names that owner", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    const mine = backend.machines[0]!.spec.labels!["wsp-owner"]!;
    await store.put("owner", "id", { id: "h_other" });

    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect(await second.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealable: true, foreignOwner: mine })]);
    const fresh = await second.golden.prepare();
    expect(fresh.id).not.toBe(b.id);
    expect(backend.machines[1]!.spec.labels).toMatchObject({ "wsp-owner": "h_other" });
    expect(await second.reap()).toEqual({ reaped: [], spared: [] });
    expect(backend.machines[0]!.killed).toBe(false);
    expect((await second.golden.builders()).map(x => x.id)).toEqual([b.id, fresh.id]);
    // Acting on it by id would touch that setup's machine: neither the seal nor the daemon route goes through.
    const refusal = `${b.id} wears another setup's owner label (${mine}); it is never sealed or reached from here`;
    await expect(second.golden.seal(b.id)).rejects.toThrow(refusal);
    await expect(second.golden.builderReach(b.id)).rejects.toThrow(refusal);
    expect(backend.machines[0]!.killed).toBe(false);
    expect(backend.machines[0]!.execLog.filter(c => c.includes(TOKEN_PATH))).toEqual([]);
    expect(await store.get("builders", b.id)).toBeDefined();
    expect(await second.golden.get()).toBeUndefined();
  });

  it("a machine whose provider view carries no labels is this setup's: attached to, never refused", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    delete (backend.machines[0] as { labels?: unknown }).labels;

    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const view = await second.golden.builders();
    expect(view).toEqual([expect.objectContaining({ id: b.id, sealable: true })]);
    expect(view[0]).not.toHaveProperty("foreignOwner");
    expect((await second.golden.prepare()).id).toBe(b.id);
    expect(backend.machines).toHaveLength(1);
  });

  it("an attach proves the machine alive: one that died after hydration takes the failure road, an alive one is exec'd once", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();

    const alive = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const before = backend.machines[0]!.execLog.length;
    expect((await alive.golden.prepare()).id).toBe(b.id);
    expect(backend.machines[0]!.execLog.slice(before)).toEqual(["true"]);

    const dead = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), killConfirm: { graceMs: 50, pollMs: 5 } });
    await dead.golden.builders();
    backend.machines[0]!.killed = true; // gone between hydration and the attach
    const frames: string[] = [];
    dead.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    await expect(dead.golden.prepare()).rejects.toThrow("gone");
    expect(frames.slice(-2)).toEqual(["installing-mcp:already applied", "failed:gone"]);
    expect(frames).not.toContain("ready:");
    expect(await dead.golden.builders()).toEqual([]);
    expect(await store.list("builders")).toEqual([]);

    // A guest that answers but cannot run a no-op is not serving either: killed and forgotten the same way.
    const third = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b2 = await third.golden.prepare();
    expect(b2.id).toBe("m2");
    const broken = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), killConfirm: { graceMs: 50, pollMs: 5 } });
    await broken.golden.builders();
    backend.execImpl = (m, cmd) => (cmd === "true" ? { exitCode: 127, stdout: "", stderr: "" } : dfOk(m, cmd));
    await expect(broken.golden.prepare()).rejects.toThrow("the builder answered exit 127 to a no-op; it is not serving");
    expect(backend.machines[1]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
  });

  it("once a process attaches, the builder is its own: the six-hour label rule no longer applies", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();

    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect((await second.golden.prepare()).id).toBe(b.id);
    backend.machines[0]!.spec.labels!["createdAt"] = new Date(Date.now() - BUILDER_IDLE_MS - 60_000).toISOString();
    expect(await second.reap()).toEqual({ reaped: [], spared: [] });
    expect(backend.machines[0]!.killed).toBe(false);
    expect((await second.golden.builders()).map(x => x.id)).toEqual([b.id]);
  });

  it("a record written before the marker existed is never reused", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    const { firstLife: _marker, ...older } = (await store.get("builders", b.id)) as { firstLife: boolean };
    await store.put("builders", b.id, older);

    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect(await second.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealable: false })]);
    await second.golden.prepare();
    expect(backend.machines).toHaveLength(2);
    expect(await second.reap()).toEqual({ reaped: [{ id: b.id, builder: true, reason: "recorded" }], spared: [] });
    expect(backend.machines[0]!.killed).toBe(true);
  });

  it("a builder another live process holds is never reused, expired, sealed or reached; a stale heartbeat, a dead holder or a clean close frees it", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const a = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await a.golden.prepare();
    type Held = { heldBy?: { host: string; pid: number; heartbeat: string } };
    const recorded = async () => (await store.get("builders", b.id)) as Held;
    expect((await recorded()).heldBy).toMatchObject({ pid: process.pid, host: hostname() });
    const otherPid = process.ppid;
    const host = hostname();
    const heldBy = async (pid: number, heartbeat: string) => {
      await store.put("builders", b.id, { ...(await recorded()), heldBy: { host, pid, heartbeat } });
    };

    await heldBy(otherPid, new Date().toISOString());
    const c = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect(await c.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealable: true, heldBy: expect.objectContaining({ pid: otherPid }) })]);
    expect((await c.golden.prepare()).id).not.toBe(b.id);
    backend.machines[0]!.spec.labels!["createdAt"] = new Date(Date.now() - BUILDER_IDLE_MS - 60_000).toISOString();
    expect(await c.reap()).toEqual({ reaped: [], spared: [] });
    const refusal = `${b.id} is in use by another wsp process (pid ${otherPid}); it is never sealed or reached from here`;
    await expect(c.golden.seal(b.id)).rejects.toThrow(refusal);
    await expect(c.golden.builderReach(b.id)).rejects.toThrow(refusal);
    expect(backend.machines[0]!.killed).toBe(false);

    // The holder's own sweep writes its heartbeat back.
    await a.reap();
    expect((await recorded()).heldBy).toMatchObject({ pid: process.pid });

    // A heartbeat past fifteen minutes frees the record under the normal rule.
    backend.machines[0]!.spec.labels!["createdAt"] = new Date().toISOString();
    await heldBy(otherPid, new Date(Date.now() - 16 * 60_000).toISOString());
    const d = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect((await d.golden.builders())[0]).not.toHaveProperty("heldBy");
    expect((await d.golden.prepare()).id).toBe(b.id);
    await d.close();
    expect((await recorded()).heldBy).toBeUndefined();

    // A holder whose pid is gone frees it at once, whatever the heartbeat says.
    await heldBy(999_999_999, new Date().toISOString());
    const e = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect((await e.golden.builders())[0]).not.toHaveProperty("heldBy");
    expect((await e.golden.prepare()).id).toBe(b.id);
  });

  it("the provider's createdAt decides nothing: a view stamped 306 s past the one at creation is still reusable and attaches", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const a = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await a.golden.prepare();
    const m = backend.machines[0]!;
    expect(await store.get("builders", b.id)).not.toHaveProperty("providerCreatedAt");
    // The canary's ten-minute drift on a machine nobody touched.
    m.shape.createdAt = new Date(Date.parse(m.shape.createdAt!) + 306_000).toISOString();
    const c = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const view = (await c.golden.builders())[0]!;
    expect(view).toMatchObject({ id: b.id, sealable: true });
    expect(view).not.toHaveProperty("suspect");
    expect((await c.golden.prepare()).id).toBe(b.id);
    expect(backend.machines).toHaveLength(1);
    expect(await store.get("builders", b.id)).toMatchObject({ firstLife: true });
  });

  it("a hold from another host is trusted on its heartbeat alone, one from this host on its pid too, and an unreadable heartbeat reads as held", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const alpha = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "alpha:1" });
    const b = await alpha.golden.prepare();
    expect(await store.get("builders", b.id)).toMatchObject({ heldBy: { host: "alpha:1", pid: process.pid } });
    const setHold = async (host: string, pid: number, heartbeat: string) =>
      store.put("builders", b.id, { ...((await store.get("builders", b.id)) as object), heldBy: { host, pid, heartbeat } });
    const readerSees = async () => (await createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "alpha:1" }).golden.builders())[0]!;

    await setHold("beta:2", 999_999_999, new Date().toISOString());
    expect(await readerSees()).toMatchObject({ id: b.id, heldBy: { host: "beta:2" } });
    await setHold("alpha:1", 999_999_999, new Date().toISOString());
    expect(await readerSees()).not.toHaveProperty("heldBy");
    await setHold("beta:2", process.pid, new Date(Date.now() - 16 * 60_000).toISOString());
    expect(await readerSees()).not.toHaveProperty("heldBy");
    await setHold("beta:2", 999_999_999, "yesterday");
    expect(await readerSees()).toMatchObject({ heldBy: { host: "beta:2" } });
    await setHold("alpha:1", process.ppid, "yesterday");
    expect(await readerSees()).toMatchObject({ heldBy: { host: "alpha:1" } });
  });

  it("a builder another process made after this one hydrated is never reaped while it is held or building, past the create grace", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const host = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "host:1" });
    expect(await host.golden.builders()).toEqual([]);

    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const init = createRuntime({ backend, store, adapters: {}, goldenRecipe: { ...recipeWith(importOf()), deployDaemon: m => (m.id === "m2" ? gate : Promise.resolve()) }, hostId: "init:2" });
    const held = await init.golden.prepare({ name: "done" });
    const building = init.golden.prepare({ name: "mid" });
    await vi.waitFor(async () => expect(await store.get("builders", "m2")).toMatchObject({ building: true }));
    for (const m of backend.machines) m.spec.labels!["createdAt"] = new Date(Date.now() - 2 * 60_000).toISOString();

    const swept = await host.reap();
    expect(swept.reaped).toEqual([]);
    expect(backend.machines.map(m => m.killed)).toEqual([false, false]);
    expect((await host.golden.builders()).map(b => [b.id, b.heldBy?.host, b.building])).toEqual([[held.id, "init:2", undefined], ["m2", "init:2", true]]);
    release();
    expect((await building).id).toBe("m2");
    await init.close();
  });

  /** A builder an earlier process left, hydrated here as reusable, then taken by a third process. */
  const takenAfterHydration = async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "old:1" });
    const b = await crashed.golden.prepare();
    await crashed.close();
    const host = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "host:2" });
    expect((await host.golden.builders())[0]).not.toHaveProperty("heldBy");
    const other = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "other:3" });
    expect((await other.golden.prepare()).id).toBe(b.id);
    return { backend, store, host, other, id: b.id };
  };

  it("a hold written after this process hydrated is seen by the sweep", async () => {
    const { backend, store, host, other, id } = await takenAfterHydration();
    const machine = backend.machines[0]!;
    machine.spec.labels!["createdAt"] = new Date(Date.now() - 7 * 3_600_000).toISOString();

    expect((await host.reap()).reaped).toEqual([]);
    expect(machine.killed).toBe(false);
    expect(await store.get("builders", id)).toMatchObject({ heldBy: { host: "other:3" } });
    await other.close();
  });

  it("a hold written after this process hydrated is seen by the attach lookup", async () => {
    const { backend, store, host, other, id } = await takenAfterHydration();

    expect((await host.golden.prepare()).id).not.toBe(id);
    expect(backend.machines).toHaveLength(2);
    expect(await store.get("builders", id)).toMatchObject({ heldBy: { host: "other:3" } });
    await other.close();
  });

  it("kill re-reads the record and refuses a builder another process has taken since hydration", async () => {
    const { backend, store, host, other, id } = await takenAfterHydration();

    await expect(host.golden.kill(id)).rejects.toThrow(/in use by another wsp process/);
    expect(backend.machines[0]!.killed).toBe(false);
    expect(await store.get("builders", id)).toMatchObject({ heldBy: { host: "other:3" } });
    await other.close();
  });

  it("a sweep whose last listing is older than a pass that admitted a row neither drops nor kills that row", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const inner = memoryStore();
    // The n-th listing of the builders is held after it read the store, so a pass started later lists and admits first.
    let gate: Promise<void> | undefined;
    let holdAt = 0;
    let listings = 0;
    let listed = false;
    const store: Store = {
      ...inner,
      list: async collection => {
        const rows = await inner.list(collection);
        if (collection === "builders" && ++listings === holdAt && gate !== undefined) {
          listed = true;
          await gate;
        }
        return rows;
      },
    };
    const host = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "host:1" });
    expect(await host.golden.builders()).toEqual([]);

    // The sweep lists once for itself and once inside its grace pass; the second is the last read before it kills.
    let release!: () => void;
    gate = new Promise<void>(r => (release = r));
    listings = 0;
    holdAt = 2;
    const sweep = host.reap();
    await vi.waitFor(() => expect(listed).toBe(true));
    const other = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "other:2" });
    const b = await other.golden.prepare();
    backend.machines[0]!.spec.labels!["createdAt"] = new Date(Date.now() - 2 * 60_000).toISOString();
    const mine = await host.golden.prepare({ name: "mine" });
    const listing = async () => (await host.golden.builders()).map(x => [x.id, x.heldBy?.host]).sort();
    expect(await listing()).toEqual([[b.id, "other:2"], [mine.id, undefined]]);

    release();
    expect((await sweep).reaped).toEqual([]);
    expect(backend.machines.map(m => m.killed)).toEqual([false, false]);
    expect(await listing()).toEqual([[b.id, "other:2"], [mine.id, undefined]]);
    await other.close();
  });

  it("a prepare that finishes after close() still writes its finished record, without a hold, and the next process attaches", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const a = createRuntime({ backend, store, adapters: {}, goldenRecipe: { ...recipeWith(importOf()), deployDaemon: () => gate } });
    const preparing = a.golden.prepare();
    await vi.waitFor(async () => expect(await store.get("builders", "m1")).toBeDefined());
    await a.close();
    release();
    expect((await preparing).id).toBe("m1");
    type Stored = { building?: true; heldBy?: unknown; setupSha: string; import?: { applied: string[] } };
    const done = (await store.get("builders", "m1")) as Stored;
    expect(done.building).toBeUndefined();
    expect(done.heldBy).toBeUndefined();
    expect(done.setupSha).not.toBe("");
    expect(done.import?.applied).toHaveLength(5);

    const next = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect((await next.golden.prepare()).id).toBe("m1");
    expect(backend.machines).toHaveLength(1);
  });

  it("a failed write on a heartbeat tick is logged and the timer re-arms; the next tick writes", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const fake = fakeClock();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: fake.clock });
    const b = await rt.golden.prepare();
    type Stored = { heldBy?: { heartbeat: string } };
    const heartbeat = async () => ((await store.get("builders", b.id)) as Stored).heldBy?.heartbeat;
    const realPut = store.put.bind(store);
    let fail = false;
    store.put = async (collection, id, value) => {
      if (fail) throw new Error("disk full");
      return realPut(collection, id, value);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const stale = "2026-01-01T00:00:00.000Z";
      await realPut("builders", b.id, { ...((await store.get("builders", b.id)) as object), heldBy: { host: "h", pid: process.pid, heartbeat: stale } });
      fail = true;
      fake.advance(5 * 60_000);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(`heartbeat for builder ${b.id} not written: disk full`));
      expect(await heartbeat()).toBe(stale);
      expect(fake.pending()).toBe(1);
      fail = false;
      fake.advance(5 * 60_000);
      await vi.waitFor(async () => expect(await heartbeat()).not.toBe(stale));
      expect(fake.pending()).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a tick in flight when close() runs neither rewrites the hold nor re-arms", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const fake = fakeClock();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: fake.clock });
    const b = await rt.golden.prepare();
    const realPut = store.put.bind(store);
    store.put = async (collection, id, value) => {
      await new Promise(r => setTimeout(r, 30));
      return realPut(collection, id, value);
    };
    type Stored = { heldBy?: unknown };
    fake.advance(5 * 60_000);
    await rt.close();
    expect(((await store.get("builders", b.id)) as Stored).heldBy).toBeUndefined();
    expect(fake.pending()).toBe(0);
    await new Promise(r => setTimeout(r, 80));
    fake.advance(10 * 60_000);
    expect(((await store.get("builders", b.id)) as Stored).heldBy).toBeUndefined();
    expect(fake.pending()).toBe(0);
  });

  it("a reusable record whose age cannot be read is stopped on the next sweep, with no age on the result", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const a = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await a.golden.prepare();
    backend.machines[0]!.spec.labels!["createdAt"] = "yesterday";
    await store.put("builders", b.id, { ...(await store.get("builders", b.id)) as object, createdAt: "yesterday" });

    const c = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect(await c.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealable: true })]);
    expect(await c.reap()).toEqual({ reaped: [{ id: b.id, builder: true, reason: "expired" }], spared: [] });
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
  });

  it("the hold begins at creation: a prepare still in its stages is a held placeholder to another process, which lists it and touches nothing; finishing fills the record in", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const a = createRuntime({ backend, store, adapters: {}, goldenRecipe: { ...recipeWith(importOf()), deployDaemon: () => gate } });
    const preparing = a.golden.prepare();
    await vi.waitFor(() => expect(backend.machines).toHaveLength(1));
    const m = backend.machines[0]!;
    type Stored = { building?: true; heldBy: { host: string; pid: number; heartbeat: string }; firstLife: boolean; createdAt: string; setupSha: string; import?: { recipeHash: string; applied: string[] } };
    const placeholder = (await store.get("builders", m.id)) as Stored;
    expect(placeholder).toMatchObject({ building: true, firstLife: true, setupSha: "", heldBy: { pid: process.pid }, import: { recipeHash: "h1", applied: [] } });
    expect(placeholder.createdAt).toBe(m.spec.labels!["createdAt"]);

    // Two minutes old by our label (the provider's createdAt beside it), held by another live process.
    const at = new Date(Date.now() - 2 * 60_000).toISOString();
    m.spec.labels!["createdAt"] = at;
    m.shape.createdAt = at;
    await store.put("builders", m.id, { ...placeholder, createdAt: at, heldBy: { ...placeholder.heldBy, pid: process.ppid } });
    const other = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect(await other.golden.builders()).toEqual([expect.objectContaining({ id: m.id, building: true, heldBy: expect.objectContaining({ pid: process.ppid }) })]);
    expect(await other.reap()).toEqual({ reaped: [], spared: [] });
    expect(m.killed).toBe(false);
    await expect(other.golden.seal(m.id)).rejects.toThrow("in use by another wsp process");

    release();
    const b = await preparing;
    expect(b.id).toBe(m.id);
    const done = (await store.get("builders", m.id)) as Stored;
    expect(done.building).toBeUndefined();
    expect(done.setupSha).not.toBe("");
    expect(done.import?.applied).toEqual(["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"]);
    expect(done.heldBy).toMatchObject({ pid: process.pid });
  });

  it("the record's createdAt is the label the provider got, as placeholder and as finished, even when the clock ticks between the stamp and the keyed create", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    // The attempt is keyed after this read, so the stamp the provider gets is later than the one in the spec.
    const ticking: Store = {
      ...store,
      get: async (collection, id) => {
        if (collection === "creates") vi.setSystemTime(Date.now() + 1);
        return store.get(collection, id);
      },
    };
    const rt = createRuntime({ backend, store: ticking, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const b = await rt.golden.prepare();
      const m = backend.machines[0]!;
      const stored = (await store.get("builders", b.id)) as { createdAt: string };
      expect(stored.createdAt).toBe(m.spec.labels!["createdAt"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a placeholder whose holder died mid-setup is stale: never reused, stopped as recorded; a prepare that fails takes its placeholder with it", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const gate = new Promise<void>(() => {});
    const a = createRuntime({ backend, store, adapters: {}, goldenRecipe: { ...recipeWith(importOf()), deployDaemon: () => gate } });
    void a.golden.prepare();
    await vi.waitFor(() => expect(backend.machines).toHaveLength(1));
    const m = backend.machines[0]!;
    const stored = (await store.get("builders", m.id)) as { heldBy: { host: string; pid: number; heartbeat: string } };
    await store.put("builders", m.id, { ...stored, heldBy: { ...stored.heldBy, pid: 999_999_999 } });

    const later = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const view = await later.golden.builders();
    expect(view).toEqual([expect.objectContaining({ id: m.id, building: true, sealable: true })]);
    expect(view[0]).not.toHaveProperty("heldBy");
    await expect(later.golden.seal(m.id)).rejects.toThrow("still being prepared");
    expect((await later.golden.prepare()).id).not.toBe(m.id);
    expect(await later.reap()).toEqual({ reaped: [{ id: m.id, builder: true, reason: "unfinished" }], spared: [] });
    expect(m.killed).toBe(true);

    // A prepare whose stages fail: the engine kills the machine and the placeholder goes with it.
    const failing = stubBackend();
    failing.execImpl = (x, cmd) => (setupRan(cmd) ? { exitCode: 1, stdout: "", stderr: "setup broke" } : dfOk(x, cmd));
    const store2 = memoryStore();
    const c = createRuntime({ backend: failing, store: store2, adapters: {}, goldenRecipe: recipeWith(importOf()), killConfirm: { graceMs: 50, pollMs: 5 } });
    await expect(c.golden.prepare()).rejects.toThrow("golden setup failed");
    expect(failing.machines[0]!.killed).toBe(true);
    expect(await store2.list("builders")).toEqual([]);
    expect(await c.golden.builders()).toEqual([]);
  });

  it("a second prepare for the same recipe while the first is in its stages joins it: one machine, one run of each stage, the same view for both; a different recipe is refused", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const recipe = { ...recipeWith(importOf()), deployDaemon: () => gate };
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const first = rt.golden.prepare();
    await vi.waitFor(() => expect(backend.machines).toHaveLength(1));
    const second = rt.golden.prepare();
    // The second call reads the recipe after its own await; let it join before the recipe changes underneath.
    await new Promise(r => setImmediate(r));
    recipe.import = importOf("h9");
    await expect(rt.golden.prepare()).rejects.toThrow("a builder named default is still being prepared for a different recipe; wait for it to finish, then run again");
    recipe.import = importOf();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    expect(backend.machines).toHaveLength(1);
    const log = backend.machines[0]!.execLog;
    expect(log.filter(c => c.includes("brew install jq"))).toHaveLength(1);
    expect(log.filter(c => c.includes("codex-install"))).toHaveLength(1);
    // One untar of the person's files under /root and one of the machine context at the root.
    expect(log.filter(c => c.includes("tar xzf - -C '/root'"))).toHaveLength(1);
    expect(log.filter(c => c.includes("tar xzf - -C '/' "))).toHaveLength(1);
    expect(await rt.golden.builders()).toHaveLength(1);
  });

  it("own builders beat on their own five-minute timer, so a sweep stuck on the listing cannot starve the hold; close stops the timer", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const fake = fakeClock();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: fake.clock });
    const b = await rt.golden.prepare();
    type Stored = { heldBy?: { host: string; pid: number; heartbeat: string } };
    const stored = async () => (await store.get("builders", b.id)) as Stored;
    const stale = "2026-01-01T00:00:00.000Z";
    const ageHeartbeat = async () => store.put("builders", b.id, { ...(await stored()), heldBy: { ...(await stored()).heldBy!, heartbeat: stale } });

    backend.list = () => new Promise(() => {});
    void rt.reap();
    await ageHeartbeat();
    fake.advance(5 * 60_000);
    await vi.waitFor(async () => expect((await stored()).heldBy?.heartbeat).not.toBe(stale));
    await ageHeartbeat();
    fake.advance(5 * 60_000);
    await vi.waitFor(async () => expect((await stored()).heldBy?.heartbeat).not.toBe(stale));

    await rt.close();
    expect((await stored()).heldBy).toBeUndefined();
    fake.advance(10 * 60_000);
    await new Promise(r => setTimeout(r, 20));
    expect((await stored()).heldBy).toBeUndefined();
    expect(fake.pending()).toBe(0);
  });

  it("hydration reads each recorded builder once: the state comes off the view get() fetched", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const a = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await a.golden.prepare();
    const get = vi.spyOn(backend, "get");
    const state = vi.spyOn(backend.machines[0]!, "state");
    const c = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect((await c.golden.builders()).map(x => x.id)).toEqual([b.id]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(state).not.toHaveBeenCalled();
  });

  it("a reused builder whose stages fail is killed and forgotten, the same as a fresh one", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    // A ledger with the harness still to run, as a builder whose earlier process died mid-stage would carry.
    const stored = (await store.get("builders", b.id)) as { import: { applied: string[] } };
    stored.import.applied = stored.import.applied.filter(s => s !== "installing-harness");
    await store.put("builders", b.id, stored);
    backend.execImpl = (m, cmd) => (setupRan(cmd) ? { exitCode: 1, stdout: "", stderr: "setup broke" } : dfOk(m, cmd));

    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), killConfirm: { graceMs: 50, pollMs: 5 } });
    const frames: string[] = [];
    second.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    await expect(second.golden.prepare()).rejects.toThrow("golden setup failed");
    expect(frames.at(-1)).toMatch(/^failed:golden setup failed/);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await second.golden.builders()).toEqual([]);
    expect(await store.list("builders")).toEqual([]);
  });
});
