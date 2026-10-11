// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { BUILDER_IDLE_MS, KILL_ASKS } from "@wsp/engine";
import { daemonTokenFor, rotateDaemonTokenScript } from "../src/daemon-token.js";
import { copyKey, createRuntime, type GoldenExec } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { tarRead } from "../../engine/test/tar-read.js";
import { answersGoneOnce, missesFirstDelete, stubBackend, tokenGuest, type StubBackend, type StubMachine, createOn } from "./stub-backend.js";
import { TOKEN_PATH, TOKEN } from "./runtime-fixture.js";

describe("runtime golden builders", () => {
  const recipe = { setup: "install", smoke: "true" };

  it("an exec listener that throws is warned about once and never changes an exec's result: the prepare still completes", async () => {
    const backend = stubBackend();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let seen = 0;
      const rt = createRuntime({
        backend,
        store: memoryStore(),
        adapters: {},
        goldenRecipe: {
          ...recipe,
          onExec: () => {
            seen += 1;
            throw new Error("ENOSPC: no space left on device, write");
          },
        },
      });
      const builder = await rt.golden.prepare({ name: "default" });
      expect(builder.id).toBe(backend.machines[0]!.id);
      expect(backend.machines[0]!.execLog.length).toBeGreaterThan(0);
      expect(seen).toBe(backend.machines[0]!.execLog.length);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(`exec log for ${builder.id} failed, its execs go on unlogged: ENOSPC: no space left on device, write`);
    } finally {
      warn.mockRestore();
    }
  });

  it("a run reaches the exec listener as one command with its result, whatever carried it", async () => {
    const backend = stubBackend();
    const harness = (cmd: string) => cmd.includes("\ninstall' &");
    backend.execImpl = (_m, cmd) => (harness(cmd) ? { exitCode: 0, stdout: "harness on\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const seen: GoldenExec[] = [];
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: { ...recipe, onExec: e => void seen.push(e) } });
    await rt.golden.prepare({ name: "default" });
    // The base stage's steps, the harness install and the cache sweeps all run under the guard: nothing runs bare.
    expect(backend.machines[0]!.runLog.filter(s => !s.includes("setsid bash -c"))).toEqual([]);
    expect(backend.machines[0]!.runLog.filter(harness)).toHaveLength(1);
    expect(seen.filter(e => harness(e.cmd))).toEqual([expect.objectContaining({ machineId: "m1", exitCode: 0, stdout: "harness on\n" })]);
  });

  it("reap keeps a first-life builder left behind by an earlier process, kills one found paused, and keeps this process's own", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const kept = await crashed.golden.prepare({ name: "default" });
    const paused = await crashed.golden.prepare({ name: "other" });
    backend.machines[1]!.paused = true;

    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const own = await rt.golden.prepare({ name: "mine" });
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect((await rt.golden.builders()).sort(byId).map(b => [b.id, b.sealable])).toEqual([[kept.id, true], [paused.id, false], [own.id, true]]);

    expect(await rt.reap()).toEqual({ reaped: [{ id: paused.id, builder: true, reason: "recorded" }], spared: [] });
    expect(backend.machines.map(m => m.killed)).toEqual([false, true, false]);
    expect((await rt.golden.builders()).sort(byId).map(b => b.id)).toEqual([kept.id, own.id]);
    expect(await store.list("builders")).toHaveLength(2);
    expect(await store.get("builders", kept.id)).toMatchObject({ firstLife: true });
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("a builder whose machine already vanished is forgotten on hydrate", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const b = await crashed.golden.prepare();
    await backend.machines[0]!.kill();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    expect(await rt.golden.builders()).toEqual([]);
    expect(await store.get("builders", b.id)).toBeUndefined();
  });

  it("a builder its provider answers for past the load's deadline is admitted once that read lands, the one read the listing waits on", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const kept = await crashed.golden.prepare({ name: "default" });
    await crashed.close();
    const get = backend.get.bind(backend);
    const reads: string[] = [];
    backend.get = async id => (reads.push(id), await new Promise(resolve => setTimeout(resolve, 2_000)), get(id));
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    let listed = false;
    void rt.golden.builders().then(() => (listed = true));
    await rt.workspaces.list();
    expect(listed).toBe(false);
    expect((await rt.golden.builders()).map(b => [b.id, b.sealable])).toEqual([[kept.id, true]]);
    expect(reads).toEqual([kept.id]);
    await rt.close();
  });

  it("builderReach mints the builder's daemon route once while fresh and writes the token to the guest", async () => {
    const backend = stubBackend();
    let minted = 0;
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, daemonToken: TOKEN });
    const b = await rt.golden.prepare();
    expect(b.screen).toBeUndefined();
    backend.machines[0]!.previewUrl = async port => {
      minted++;
      return { url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    const reach = await rt.golden.builderReach(b.id);
    expect(reach).toEqual({ url: "https://m1-7070.preview.example/?pt_token=edge", expiresAt: expect.any(Number), daemonToken: daemonTokenFor(TOKEN, "m1") });
    await rt.golden.builderReach(b.id);
    expect(minted).toBe(1);
    expect(backend.machines[0]!.execLog.filter(c => c.includes(TOKEN_PATH))).toEqual([rotateDaemonTokenScript(reach.daemonToken!)]);
    await expect(rt.golden.builderReach("m_nobody")).rejects.toThrow(/no such builder/);
  });

  it("a failed seal forgets the builder and writes no manifest", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd === "true" ? { exitCode: 1, stdout: "", stderr: "broken" } : { exitCode: 0, stdout: "", stderr: "" });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    const stages: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") stages.push(e.stage); });
    const b = await rt.golden.prepare();
    await expect(rt.golden.seal(b.id)).rejects.toThrow(/smoke failed/);
    expect(stages.at(-1)).toBe("failed");
    expect(backend.machines.every(m => m.killed)).toBe(true);
    expect(await rt.golden.builders()).toEqual([]);
    expect(await rt.golden.get()).toBeUndefined();
  });

  it("a seal whose builder outlives three kills fails with kind machineAlive, forks nothing, writes no manifest and keeps the builder in the record", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, killConfirm: { graceMs: 20, pollMs: 1 } });
    const b = await rt.golden.prepare();
    const machine = backend.machines.find(m => m.id === b.id)!;
    let kills = 0;
    machine.kill = async () => { kills++; };
    await expect(rt.golden.seal(b.id)).rejects.toMatchObject({ kind: "machineAlive", machineId: b.id });
    expect(kills).toBe(KILL_ASKS);
    expect(backend.machines).toHaveLength(1);
    expect(await rt.golden.get()).toBeUndefined();
    // The provider still has the machine, so the record still names it: a builder dropped here would bill with
    // nothing on this computer pointing at it.
    expect(await rt.golden.builders()).toEqual([expect.objectContaining({ id: b.id })]);
  });

  it("a seal whose kill the provider fails keeps the builder's record when one gateway copy then answers 404 for it", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    const b = await rt.golden.prepare();
    const machine = backend.machines.find(m => m.id === b.id)!;
    let kills = 0;
    machine.kill = async () => {
      kills++;
      throw Object.assign(new Error("provider 500"), { status: 500 });
    };
    answersGoneOnce(backend, machine, () => kills > 0);
    await expect(rt.golden.seal(b.id)).rejects.toThrow("provider 500");
    expect(await rt.golden.builders()).toEqual([expect.objectContaining({ id: b.id })]);
  });

  it("stamps its builders with one owner id per store, kept across processes", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    await first.golden.prepare();
    const again = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    await again.golden.prepare();
    const other = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    await other.golden.prepare();
    const owners = backend.machines.map(m => m.spec.labels?.["wsp-owner"]);
    expect(owners[0]).toMatch(/^h_[0-9a-f]{8}$/);
    expect(owners[1]).toBe(owners[0]);
    expect(owners[2]).not.toBe(owners[0]);
    expect(await store.get("owner", "id")).toEqual({ id: owners[0] });
  });

  it("re-mints and persists the owner id when the stored row carries none", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("owner", "id", {});
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    await rt.golden.prepare();
    const owner = backend.machines[0]!.spec.labels!["wsp-owner"];
    expect(owner).toMatch(/^h_[0-9a-f]{8}$/);
    expect(await store.get("owner", "id")).toEqual({ id: owner });
  });

  it("seal passes the logins it is given through to the version", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    const b = await rt.golden.prepare();
    const logins = [{ name: "Codex login", state: "not-signed-in" as const }];
    const { version } = await rt.golden.seal(b.id, { logins });
    expect(version.logins).toEqual(logins);
    expect((await rt.golden.get())?.versions[0]?.logins).toEqual(logins);
  });

  it("stamps the owner on workspaces, smoke forks and command-line golden builds as well", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    await createOn(rt, { golden: "snap_g", name: "x" });
    await rt.golden.build({ setup: "true", smoke: "true" });
    const owners = backend.machines.map(m => m.spec.labels?.["wsp-owner"]);
    expect(owners).toHaveLength(5);
    expect(new Set(owners).size).toBe(1);
    expect(owners[0]).toMatch(/^h_[0-9a-f]{8}$/);
    expect(backend.machines[1]!.spec.labels).toMatchObject({ wsp: "1", "wsp-smoke": "1" });
    expect(backend.machines[2]!.spec.labels).toMatchObject({ wsp: "1" });
    // A scripted build with no labels of its own still gets the wsp mark and a readable age, like the wizard's builder.
    expect(backend.machines[3]!.spec.labels).toMatchObject({ wsp: "1", "wsp-builder": "1", createdAt: expect.stringMatching(/^\d{4}-/) });
    expect(backend.machines[4]!.spec.labels).toMatchObject({ wsp: "1", "wsp-smoke": "1", createdAt: expect.stringMatching(/^\d{4}-/) });
  });

  it("the sweep leaves a builder this process is still preparing alone", async () => {
    const backend = stubBackend();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: { ...recipe, deployDaemon: () => gate } });
    const preparing = rt.golden.prepare();
    await vi.waitFor(() => expect(backend.machines).toHaveLength(1));
    expect(backend.machines[0]!.spec.labels).toMatchObject({ "wsp-builder": "1", "wsp-owner": expect.stringMatching(/^h_/) });

    // Well past the minute a fresh own builder gets anyway: only the in-flight claim protects it now.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    try {
      expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
      expect(backend.machines[0]!.killed).toBe(false);

      release();
      const b = await preparing;
      expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
      expect(backend.machines[0]!.killed).toBe(false);
      expect((await rt.golden.builders()).map(x => x.id)).toEqual([b.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a builder whose create lands while the sweep is already listing is left alone", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    let releaseList!: () => void;
    const listGate = new Promise<void>(r => (releaseList = r));
    let listing!: () => void;
    const listStarted = new Promise<void>(r => (listing = r));
    const realList = backend.list.bind(backend);
    backend.list = async labels => {
      listing();
      await listGate;
      return realList(labels);
    };
    const sweeping = rt.reap();
    await listStarted;
    const preparing = rt.golden.prepare();
    await vi.waitFor(() => expect(backend.machines).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    try {
      releaseList();
      expect(await sweeping).toEqual({ reaped: [], spared: [] });
      expect(backend.machines[0]!.killed).toBe(false);
      const b = await preparing;
      expect((await rt.golden.builders()).map(x => x.id)).toEqual([b.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a recorded builder the provider still lists after its kill is not swept again and does not fail the sweep", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const stale = await crashed.golden.prepare();
    backend.machines[0]!.paused = true;
    const orphan = await backend.create({ kind: "sandbox", labels: { wsp: "1", createdAt: new Date(Date.now() - 3_600_000).toISOString() } });
    // The listing lags a kill on the real provider and GET still answers for the zombie, so both keep showing the killed machine.
    backend.list = async () => backend.machines.map(m => ({ id: m.id, state: "running" as const, labels: m.spec.labels ?? {} }));
    backend.get = async id => backend.machines.find(m => m.id === id)!;
    let kills = 0;
    const realKill = backend.machines[0]!.kill;
    backend.machines[0]!.kill = async () => { kills++; await realKill(); };
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    expect(await rt.reap()).toEqual({
      reaped: [{ id: stale.id, builder: true, reason: "recorded" }, expect.objectContaining({ id: orphan.id, reason: "orphan" })],
      spared: [],
    });
    expect(kills).toBe(1);
    expect(backend.machines.map(m => m.killed)).toEqual([true, true]);
  });

  it("a recorded kill that fails is reported per machine, keeps its record, and the sweep still runs", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const first = await crashed.golden.prepare({ name: "a" });
    const second = await crashed.golden.prepare({ name: "b" });
    backend.machines[0]!.paused = true;
    backend.machines[1]!.paused = true;
    const orphan = await backend.create({ kind: "sandbox", labels: { wsp: "1", createdAt: new Date(Date.now() - 3_600_000).toISOString() } });
    backend.machines[0]!.kill = async () => { throw new Error("502 exec failed"); };
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    expect(await rt.reap()).toEqual({
      reaped: [{ id: second.id, builder: true, reason: "recorded" }, expect.objectContaining({ id: orphan.id, reason: "orphan" })],
      spared: [],
      failed: [{ id: first.id, message: "could not stop: 502 exec failed; stays recorded, retried next sweep" }],
    });
    expect(backend.machines.map(m => m.killed)).toEqual([false, true, true]);
    expect((await rt.golden.builders()).map(b => b.id)).toEqual([first.id]);
    expect((await store.list("builders")).map(b => (b as { id: string }).id)).toEqual([first.id]);
  });

  it("a listing failure after the recorded kills reports both, and touches nothing else", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const stale = await crashed.golden.prepare();
    backend.machines[0]!.paused = true;
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    backend.list = async () => { throw new Error("list 502"); };
    expect(await rt.reap()).toEqual({ reaped: [{ id: stale.id, builder: true, reason: "recorded" }], spared: [], failed: [{ message: "list 502" }] });
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
  });

  it("reap kills a lost builder wearing this store's owner label, lists another owner's and an unowned young one, and never a poc machine", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    const own = await rt.golden.prepare();
    const owner = backend.machines[0]!.spec.labels!["wsp-owner"]!;
    const now = new Date().toISOString();
    // Past the minute of grace a fresh own builder gets, so the label alone decides.
    const lost = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": owner, createdAt: new Date(Date.now() - 5 * 60_000).toISOString() } });
    const foreign = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": "h_other", createdAt: now } });
    const unowned = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", createdAt: now } });
    const experiment = await backend.create({ kind: "sandbox", labels: { poc: "p1", wsp: "1", "wsp-builder": "1", createdAt: now } });
    const result = await rt.reap();
    expect(result.reaped.map(r => [r.id, r.reason])).toEqual([[lost.id, "own"]]);
    expect(result.spared.map(b => [b.id, b.whose, b.owner])).toEqual([[foreign.id, "foreign", "h_other"], [unowned.id, "none", undefined]]);
    expect(backend.machines.filter(m => m.killed).map(m => m.id)).toEqual([lost.id]);
    for (const id of [own.id, foreign.id, unowned.id, experiment.id]) expect(backend.machines.find(m => m.id === id)!.killed).toBe(false);
  });

  it("a stale builder whose first delete reached the copy that never held it is asked again behind the sweep until it is gone", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const stale = await crashed.golden.prepare({ name: "other" });
    backend.machines[0]!.paused = true;
    missesFirstDelete(backend.machines[0]!);
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe, killConfirm: { graceMs: 20, pollMs: 1 } });
    expect(await rt.reap()).toEqual({ reaped: [{ id: stale.id, builder: true, reason: "recorded" }], spared: [] });
    await vi.waitFor(() => expect(backend.machines[0]!.killed).toBe(true));
    await rt.close();
  });

  it("an own machine no record claims, whose first delete reached the copy that never held it, is asked again behind the sweep until it is gone", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, killConfirm: { graceMs: 20, pollMs: 1 } });
    const lost = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": await rt.owner(), createdAt: new Date(Date.now() - 5 * 60_000).toISOString() } });
    missesFirstDelete(backend.machines[0]!);
    expect((await rt.reap()).reaped.map(r => [r.id, r.reason])).toEqual([[lost.id, "own"]]);
    await vi.waitFor(() => expect(backend.machines[0]!.killed).toBe(true));
    await rt.close();
  });

  it("a machine still being asked to stop is the watch's, so the next sweep neither stops nor names it again", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, killConfirm: { graceMs: 20, pollMs: 1 } });
    const lost = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": await rt.owner(), createdAt: new Date(Date.now() - 5 * 60_000).toISOString() } });
    backend.machines[0]!.kill = async () => {};
    expect((await rt.reap()).reaped.map(r => r.id)).toEqual([lost.id]);
    expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
    await rt.close();
  });

  it("once close() resolves the watch sends the provider nothing more, even mid-round", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, killConfirm: { graceMs: 1500, pollMs: 100 } });
    await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": await rt.owner(), createdAt: new Date(Date.now() - 5 * 60_000).toISOString() } });
    let calls = 0;
    const get = backend.get.bind(backend);
    backend.get = async id => {
      calls++;
      return get(id);
    };
    backend.machines[0]!.kill = async () => void calls++;
    await rt.reap();
    await vi.waitFor(() => expect(calls).toBeGreaterThan(2));
    await rt.close();
    const atClose = calls;
    await new Promise(r => setTimeout(r, 400));
    expect(calls).toBe(atClose);
  });

  it("what became of a machine the watch is asking about is said on the line the sweep was handed", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, killConfirm: { graceMs: 20, pollMs: 1 } });
    const lost = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": await rt.owner(), createdAt: new Date(Date.now() - 5 * 60_000).toISOString() } });
    backend.machines[0]!.kill = async () => {};
    const said: string[] = [];
    await rt.reap(undefined, line => void said.push(line));
    await vi.waitFor(() => expect(said).toEqual([expect.stringMatching(new RegExp(`^machine ${lost.id} is still running after .*; asking again in 60 s$`))]));
    await rt.close();
  });

  it("an upgrade's replaced machine, whose first delete reached the copy that never held it, is asked again until it is gone", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, killConfirm: { graceMs: 20, pollMs: 1 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    missesFirstDelete(backend.machines[0]!);
    expect((await rt.workspaces.upgrade(ws.id)).machineId).toBe("m2");
    await vi.waitFor(() => expect(backend.machines[0]!.killed).toBe(true));
    await rt.close();
  });

  it("a recorded marked builder at 6 h 1 min by our createdAt label is reaped although get(id) says running; one at 5 h 59 min is kept", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const expired = await crashed.golden.prepare({ name: "old" });
    const kept = await crashed.golden.prepare({ name: "young" });
    // The label is our clock at creation and the provider's createdAt sits beside it; both are aged so the
    // provider's view still says running and does not read as a resume.
    const bornAgo = (m: { spec: { labels?: Record<string, string> }; shape: { createdAt?: string } }, ms: number) => {
      const at = new Date(Date.now() - ms).toISOString();
      m.spec.labels!["createdAt"] = at;
      m.shape.createdAt = at;
    };
    bornAgo(backend.machines[0]!, BUILDER_IDLE_MS + 60_000);
    bornAgo(backend.machines[1]!, BUILDER_IDLE_MS - 60_000);

    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    expect(await backend.machines[0]!.state()).toBe("running");
    expect(await rt.reap()).toEqual({ reaped: [{ id: expired.id, builder: true, reason: "expired", ageMs: expect.any(Number) }], spared: [] });
    expect(backend.machines.map(m => m.killed)).toEqual([true, false]);
    expect((await rt.golden.builders()).map(b => [b.id, b.sealable])).toEqual([[kept.id, true]]);
    expect(await store.list("builders")).toHaveLength(1);
    // This process's own builder is never aged out by the sweep: a person may be working on it.
    const own = await rt.golden.prepare({ name: "mine" });
    backend.machines[2]!.spec.labels!["createdAt"] = new Date(Date.now() - BUILDER_IDLE_MS - 60_000).toISOString();
    expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
    expect(backend.machines[2]!.killed).toBe(false);
    void own;
  });

  it("the sweep never fetches a machine it leaves alone", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    await rt.golden.builders();
    const now = new Date().toISOString();
    await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": "h_other", createdAt: now } });
    await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": "h_other", createdAt: new Date(Date.now() - 3_600_000).toISOString() } });
    await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", createdAt: now } });
    await backend.create({ kind: "sandbox", labels: { wsp: "1", createdAt: now } });
    const get = vi.spyOn(backend, "get");
    const result = await rt.reap();
    expect(result.reaped).toEqual([]);
    expect(result.spared.map(s => s.whose)).toEqual(["foreign", "foreign", "none", "none"]);
    expect(get).not.toHaveBeenCalled();
    expect(backend.machines.some(m => m.killed)).toBe(false);
  });

  it("the sweep leaves a workspace this process is still forking alone, on create and on a rebuild", async () => {
    const backend = stubBackend();
    let release!: () => void;
    let gate = new Promise<void>(r => (release = r));
    backend.execImpl = async (_m, cmd) => {
      if (cmd.startsWith("hostname ")) await gate;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await rt.golden.builders();
    const creating = createOn(rt, { golden: "snap_g", name: "x" });
    await vi.waitFor(() => expect(backend.machines).toHaveLength(1));
    // Well past the minute a fresh own machine gets anyway: only the claim protects it now.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    try {
      expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
      expect(backend.machines[0]!.killed).toBe(false);
      release();
      const ws = await creating;
      expect(ws.machineId).toBe("m1");

      gate = new Promise<void>(r => (release = r));
      const rebuilding = rt.workspaces.rebuild(ws.id);
      await vi.waitFor(() => expect(backend.machines).toHaveLength(2));
      vi.setSystemTime(Date.now() + 5 * 60_000);
      expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
      expect(backend.machines[1]!.killed).toBe(false);
      release();
      expect((await rebuilding).machineId).toBe("m2");
      expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runtime upgrade vault", () => {
  it("vaults user files (skipping golden-provided dirs) onto the fresh fork", async () => {
    const backend = stubBackend();
    const tarCmds: string[] = [];
    const untarCmds: string[] = [];
    backend.execImpl = (m, cmd) => {
      if (cmd.includes("ls -A /root")) {
        return { exitCode: 0, stdout: "notes.md\n.local\n.claude-cfg\n.npm\n.wsp-upgraded\n", stderr: "" };
      }
      if (cmd.includes("tar czf")) tarCmds.push(`${m.id}:${cmd}`);
      if (cmd.includes("tar xzf")) untarCmds.push(`${m.id}:${cmd}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) =>
        init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(Buffer.from("tarbytes")),
      ),
    );
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const upgraded = await rt.workspaces.upgrade(ws.id);
      expect(upgraded.machineId).toBe("m2");
      const tar = tarCmds.find(c => c.startsWith("m1:"));
      expect(tar).toContain("'root/notes.md'");
      expect(tar).toContain("'root/.claude-cfg'");
      expect(tar).not.toContain(".local");
      expect(tar).not.toContain(".npm");
      expect(untarCmds.some(c => c.startsWith("m2:"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("runtime golden rollback", () => {
  const version = (n: number) => ({
    version: n,
    snapshotId: `snap_golden-v${n}`,
    baseTemplate: "base",
    setupSha: `sha${n}`,
    createdAt: `2026-08-${10 + n}T00:00:00.000Z`,
    smoke: { cmd: "true", exitCode: 0 },
  });

  it("moves head to an earlier version, persists it, and leaves existing workspaces on their image", async () => {
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 2, versions: [version(1), version(2)] });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_golden-v2", name: "a" });

    const rolled = await rt.golden.rollback(1);
    expect(rolled).toEqual({ head: 1, versions: [version(1), version(2)] });
    expect(await rt.golden.get()).toEqual(rolled);
    expect((await rt.workspaces.get(ws.id)).golden).toBe("snap_golden-v2");
  });

  it("refuses a version that is not in the manifest, and a golden that does not exist, as kind missing", async () => {
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [version(1)] });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {} });
    await expect(rt.golden.rollback(7)).rejects.toMatchObject({ kind: "missing", message: expect.stringContaining("v7") });
    await expect(rt.golden.rollback(1, "nope")).rejects.toMatchObject({ kind: "missing" });
    expect(await rt.golden.get()).toEqual({ head: 1, versions: [version(1)] }); // untouched
  });
});

describe("runtime machine context", () => {
  const probe = "WSP_CTX\nKERNEL 6.6.30\nDISK 20466256 11720704\nAGENT claude\nSHELL zsh\nWSP_CTX_END\n";
  const namesIn = (tgz: Buffer): string[] => tarRead(["-tzf", "-"], tgz).toString("utf8").trim().split("\n");
  /** The context archives that went up for a machine: the texts travel through the upload road, never inside an exec. */
  const writes = (backend: StubBackend, m: StubMachine) => backend.puts.filter(p => p.machine === m.id && namesIn(p.body).includes("etc/wsp/machine-context.md")).map(p => p.body);
  const docOf = (tgz: Buffer) => tarRead(["-xzOf", "-", "etc/wsp/skills/wsp-machine/SKILL.md"], tgz).toString("utf8");
  const version = { version: 4, snapshotId: "snap_g", baseTemplate: "base", setupSha: "abcdef0123456789", createdAt: "2026-09-05T10:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } };

  it("refreshes the document on the fresh fork with the workspace's name and its golden version", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: probe, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 4, versions: [version] });
    const rt = createRuntime({ backend, store, adapters: {} });
    await createOn(rt, { golden: "snap_g", name: "task-1" });
    const m = backend.machines[0]!;
    expect(writes(backend, m)).toHaveLength(1);
    expect(m.execLog.some(c => c.includes("base64 --decode"))).toBe(false);
    expect(m.execLog.findIndex(c => c.includes("tar xzf - -C '/' "))).toBeGreaterThan(m.execLog.findIndex(c => c.startsWith("hostname ")));
    const doc = docOf(writes(backend, m)[0]!);
    expect(doc).toContain("- Workspace: task-1.");
    expect(doc).toContain("- Golden: v4, sealed 2026-09-05, setup abcdef012345.");
    expect(doc).toContain("- Disk: 19.5 GB root disk, 11.2 GB free when this file was written.");
    expect(namesIn(writes(backend, m)[0]!)).toContain("etc/claude-code/CLAUDE.md");
    expect(namesIn(writes(backend, m)[0]!)).toContain("etc/claude-code/.claude/skills/wsp-machine/SKILL.md");
  });

  it("refreshes again on the fork an upgrade boots, and a guest that does not answer is only logged", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes("ls -A /root") ? { exitCode: 0, stdout: "notes.md\n", stderr: "" } : cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: probe, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
      expect(docOf(writes(backend, backend.machines[0]!)[0]!)).toContain("- Golden: version not recorded.");
      await rt.workspaces.upgrade(ws.id);
      expect(writes(backend, backend.machines[1]!)).toHaveLength(1);
      expect(docOf(writes(backend, backend.machines[1]!)[0]!)).toContain("- Workspace: task-1.");

      backend.execImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
      const silent = await createOn(rt, { golden: "snap_g", name: "task-2" });
      expect(silent.name).toBe("task-2");
      expect(writes(backend, backend.machines[2]!)).toHaveLength(0);
      expect(warn.mock.calls.some(c => String(c[0]).includes("machine context for") && String(c[0]).includes("without its markers"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("runtime guest hostname", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  const hostnameCmds = (m: { execLog: string[] }) => m.execLog.filter(c => c.startsWith("hostname "));

  it("names the fresh guest after the workspace on create", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await createOn(rt, { golden: "snap_g", name: "task-1" });
    expect(hostnameCmds(backend.machines[0]!)).toEqual(["hostname task-1 && echo task-1 > /etc/hostname"]);
  });

  it("names the fresh fork again on upgrade", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes("ls -A /root") ? { exitCode: 0, stdout: "notes.md\n", stderr: "" } : ok);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) =>
        init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(Buffer.from("tarbytes")),
      ),
    );
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
      await rt.workspaces.upgrade(ws.id);
      expect(hostnameCmds(backend.machines[1]!)).toEqual(["hostname task-1 && echo task-1 > /etc/hostname"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sanitizes a name that is not a valid hostname", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await createOn(rt, { golden: "snap_g", name: "  My Workspace!! (v2) " });
    await createOn(rt, { golden: "snap_g", name: "a".repeat(70) });
    await createOn(rt, { golden: "snap_g", name: "!!!" });
    expect(hostnameCmds(backend.machines[0]!)).toEqual(["hostname my-workspace-v2 && echo my-workspace-v2 > /etc/hostname"]);
    expect(hostnameCmds(backend.machines[1]!)).toEqual([`hostname ${"a".repeat(63)} && echo ${"a".repeat(63)} > /etc/hostname`]);
    expect(hostnameCmds(backend.machines[2]!)).toEqual(["hostname wsp && echo wsp > /etc/hostname"]);
  });

  it("a guest that refuses the hostname is logged and create still succeeds", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.startsWith("hostname ") ? { exitCode: 1, stdout: "", stderr: "hostname: you must be root" } : ok);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const ws = await createOn(rt, { golden: "snap_g", name: "task-1" });
      expect(ws.phase).toBe("running");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("you must be root"));
    } finally {
      warn.mockRestore();
    }
  });

  it("an exec that throws while setting the hostname is logged, not fatal", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => {
      if (cmd.startsWith("hostname ")) throw new Error("exec timed out");
      return ok;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      await expect(createOn(rt, { golden: "snap_g", name: "task-1" })).resolves.toMatchObject({ phase: "running" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("exec timed out"));
    } finally {
      warn.mockRestore();
    }
  });
});
