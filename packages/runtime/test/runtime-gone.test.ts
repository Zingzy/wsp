// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { EventUnion, TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { droppingPort } from "./held-port.js";
import { until } from "./until.js";
import { stubBackend, createOn } from "./stub-backend.js";

describe("gone machines", () => {
  /** A turn that announces itself and never settles on its own: only the runtime ending it ends it. */
  const held: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      const sessionId = randomUUID();
      o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", cwd: "/root/work" });
      return { localId: sessionId, finished: new Promise<TurnResult>(() => {}), interrupt: async () => {} };
    },
  });
  /** Two workspaces, one napping, both machines deleted at the provider while no host ran; the same store hydrated again. */
  const hydratedGone = async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const a = await createOn(rt1, { golden: "snap_g", name: "a" });
    const b = await createOn(rt1, { golden: "snap_g", name: "b" });
    await rt1.workspaces.nap(b.id);
    await rt1.close();
    for (const m of backend.machines) m.killed = true;
    const rt = createRuntime({ backend, store, adapters: {} });
    // The load holds each record on its one 404 and confirms it once the host serves.
    await until(async () => (await rt.workspaces.list()).every(w => w.phase === "gone"));
    return { backend, store, rt, a, b };
  };

  it("a stored workspace whose machine the provider no longer knows hydrates as gone with the provider's words, whatever phase it was left at", async () => {
    const { store, rt, a, b } = await hydratedGone();
    const listed = await rt.workspaces.list();
    // The words name the load that met the 404 and quote the provider's answer to it.
    const loadSaw = (id: string) => new RegExp(`^machine ${id} is gone at the provider: the record load found it gone at \\S+Z \\(404 gone\\)$`);
    expect(listed.map(w => [w.name, w.phase, w.gone])).toEqual([
      ["a", "gone", expect.stringMatching(loadSaw("m1"))],
      ["b", "gone", expect.stringMatching(loadSaw("m2"))],
    ]);
    // Written back once confirmed: a second host over the store reads gone without asking the provider.
    expect(await store.get("workspaces", a.id)).toMatchObject({ phase: "gone", gone: expect.stringMatching(loadSaw("m1")) });
    expect(await store.get("workspaces", b.id)).toMatchObject({ phase: "gone" });
    const statuses = await rt.status.list();
    const sa = statuses.find(s => s.id === a.id)!;
    expect(sa).toMatchObject({ phase: "gone", machineState: "gone", reach: { state: "gone" }, reason: expect.stringMatching(loadSaw("m1")) });
    expect(sa.idleAt).toBeUndefined();
    await rt.close();
  });

  it("a gone workspace refuses wake and sends with the provider's words; nap is a no-op; rebuild is the road out", async () => {
    const { backend, store, rt, a } = await hydratedGone();
    const words = (await rt.workspaces.get(a.id)).gone!;
    expect(words).toMatch(/^machine m1 is gone at the provider: the record load found it gone at /);
    await expect(rt.workspaces.wake(a.id)).rejects.toThrow(`a's machine is gone with its disk, so work that was not pushed is lost; rebuild it to wake, which brings back its home folder from the last saved nap (${words})`);
    await expect(rt.sessions.start(a.id, { prompt: "hi" })).rejects.toThrow(`a's machine is gone with its disk, so work that was not pushed is lost; rebuild it to send, which brings back its home folder from the last saved nap (${words})`);
    expect(await rt.workspaces.nap(a.id)).toMatchObject({ phase: "gone" });
    expect(backend.machines).toHaveLength(2);

    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const rebuilt = await rt.workspaces.rebuild(a.id);
    expect(rebuilt).toMatchObject({ phase: "running", machineId: "m3" });
    expect(rebuilt.gone).toBeUndefined();
    expect(backend.machines[2]!.spec.fromSnapshot).toBe("snap_g");
    expect(events.find(e => e.type === "workspace.upgraded")).toMatchObject({ workspaceId: a.id, machineId: "m3" });
    expect((await rt.status.list()).find(s => s.id === a.id)).toMatchObject({ phase: "running", machineState: "running", machineId: "m3" });
    expect(await store.get("workspaces", a.id)).toMatchObject({ phase: "running", machineId: "m3" });
    expect((await store.get("workspaces", a.id) as { gone?: string }).gone).toBeUndefined();
    expect(await rt.workspaces.wake(a.id)).toMatchObject({ phase: "running" });
    await rt.close();
  });

  it("the reach poll finds a running machine gone: the workspace moves to gone, its turn ends, the idle window drops and the bill stops", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: held }, status: { pollIntervalMs: 5, costIntervalMs: 5, reconcileMinMs: 0 }, goneConfirmMs: 5 });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    backend.machines[0]!.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    await rt.sessions.start(ws.id, { prompt: "work" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const stop = rt.status.watch();
    try {
      // Unreachable alone is weather: the provider still says running, so the workspace does.
      await until(() => events.some(e => e.type === "workspace.status" && e.status.reach.state === "unreachable"));
      expect(await rt.workspaces.get(ws.id)).toMatchObject({ phase: "running" });
      expect(events.some(e => e.type === "workspace.gone")).toBe(false);

      backend.machines[0]!.killed = true; // deleted through the provider's API under a running host
      await until(() => events.some(e => e.type === "workspace.gone"));
      const pollSaw = /^machine m1 is gone at the provider: the status poll found it gone at \S+Z$/;
      expect(events.find(e => e.type === "workspace.gone")).toMatchObject({ workspaceId: ws.id, machineId: "m1", reason: expect.stringMatching(pollSaw) });
      expect(await rt.workspaces.get(ws.id)).toMatchObject({ phase: "gone", gone: expect.stringMatching(pollSaw) });
      expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "gone", gone: expect.stringMatching(pollSaw) });
      expect(events.find(e => e.type === "session.end")).toMatchObject({ workspaceId: ws.id, reason: "machine gone at the provider while the agent was working" });
      expect((await rt.sessions.list(ws.id)).map(s => s.status)).toEqual(["failed"]);

      // The bill stops where the machine did: rate 0 and the awake time frozen from one tick to the next.
      await until(() => events.filter(e => e.type === "workspace.cost" && e.phase === "gone").length >= 2);
      const ticks = events.filter((e): e is EventUnion & { type: "workspace.cost" } => e.type === "workspace.cost" && e.phase === "gone");
      expect(ticks[0]).toMatchObject({ rateUsdPerHour: 0 });
      expect(ticks[1]!.awakeMs).toBe(ticks[0]!.awakeMs);
      const last = events.filter((e): e is EventUnion & { type: "workspace.status" } => e.type === "workspace.status").at(-1)!;
      expect(last.status).toMatchObject({ phase: "gone", machineState: "gone", reach: { state: "gone" }, reason: expect.stringMatching(pollSaw) });
      expect(last.status.idleAt).toBeUndefined();
    } finally {
      stop();
      await rt.close();
    }
  });

  it("the host's metrics answer 404 while the state read says running: the workspace stays running and its turn works on", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: held }, status: { pollIntervalMs: 5, costIntervalMs: 5, reconcileMinMs: 0 }, goneConfirmMs: 5 });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const m = backend.machines[0]!;
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    m.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    await rt.sessions.start(ws.id, { prompt: "work" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asks = { metrics: 0 };
    const metrics = m.metrics.bind(m);
    m.metrics = async () => {
      asks.metrics++;
      return metrics();
    };
    const stop = rt.status.watch();
    try {
      // The guest misses the probe and the host has lost the VM; the state read by id is the only word on gone.
      m.hostLost = true;
      // Several passes read the metrics 404 with the guest still missing; none of them is a verdict.
      await until(() => asks.metrics >= 3);

      expect(m.killed).toBe(false);
      expect(await rt.workspaces.get(ws.id)).toMatchObject({ phase: "running" });
      expect(events.some(e => e.type === "workspace.gone")).toBe(false);
      expect(events.some(e => e.type === "session.end")).toBe(false);
      expect((await rt.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
      const rows = events.filter((e): e is EventUnion & { type: "workspace.status" } => e.type === "workspace.status");
      expect(rows.filter(r => r.status.machineState === "gone")).toEqual([]);
      expect(rows.at(-1)!.status).toMatchObject({ phase: "running", machineState: "running", reach: { state: "unreachable" } });
      // The gap is one line per spell, however many passes read it.
      expect(warn.mock.calls.map(c => String(c[0])).filter(l => /^host metrics for/.test(l))).toHaveLength(1);
    } finally {
      stop();
      warn.mockRestore();
      await rt.close();
    }
  });
});

describe("a machine its provider answers for past the load's deadline", () => {
  /** One stored workspace whose next host's reads of its machine fail, the first landing 2 s on, past LOAD_READS_MS. */
  const lateFailure = async (fails: (backend: ReturnType<typeof stubBackend>, get: (id: string) => Promise<never>) => Promise<never>) => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    await rt1.close();
    const get = backend.get.bind(backend) as (id: string) => Promise<never>;
    let reads = 0;
    backend.get = async () => {
      if (reads++ === 0) await new Promise(resolve => setTimeout(resolve, 2_000));
      return fails(backend, get);
    };
    const rt = createRuntime({ backend, store, adapters: {} });
    onTestFinished(() => rt.close());
    return { backend, rt, ws };
  };

  it("holds the record on what the provider said, as a read that fails in time does", async () => {
    const { rt, ws } = await lateFailure(async () => {
      throw new Error("provider: key refused (401)");
    });
    await expect(rt.workspaces.exec(ws.id, "true")).rejects.toThrow("provider: key refused (401)");
  });

  it("settles a machine it answers gone for with the provider's words, as a load that met the 404 in time does", async () => {
    const { rt, ws } = await lateFailure((backend, get) => {
      for (const m of backend.machines) m.killed = true;
      return get("m1");
    });
    await until(async () => (await rt.workspaces.get(ws.id)).phase === "gone", 6_000);
    expect((await rt.workspaces.get(ws.id)).gone).toMatch(/^machine m1 is gone at the provider: the record load found it gone at \S+Z \(404 gone\)$/);
  });
});

describe("a create on a computer that names its own machines", () => {
  it("runs no hostname command inside the workspace, and a provider's fork is still named", async () => {
    const named = stubBackend();
    (named as { namesWorkspace?: boolean }).namesWorkspace = true;
    const rt = createRuntime({ backend: named, store: memoryStore(), adapters: {} });
    await createOn(rt, { golden: "snap_g", name: "on-a-box" });
    expect(named.machines[0]!.execLog.filter(cmd => cmd.startsWith("hostname "))).toEqual([]);

    // The provider's own fork boots as localhost, so that road still names it: the flag is the backend's, not a
    // rule about creates.
    const provider = stubBackend();
    const forking = createRuntime({ backend: provider, store: memoryStore(), adapters: {} });
    await createOn(forking, { golden: "snap_g", name: "at-a-provider" });
    expect(provider.machines[0]!.execLog.filter(cmd => cmd.startsWith("hostname "))).toEqual(["hostname at-a-provider && echo at-a-provider > /etc/hostname"]);
  });
});
