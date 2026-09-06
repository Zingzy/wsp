// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:http";
import { EventUnion, sendRefusal, workspaceState, type WorkspaceStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { createStatusTracker, type StatusWatchOptions } from "../src/status.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

/** Every road to the provider's view of a machine: backend.get/list and machine.state(). */
function countProvider(backend: StubBackend): () => { get: number; list: number; state: number } {
  const n = { get: 0, list: 0, state: 0 };
  const get = backend.get.bind(backend);
  const list = backend.list.bind(backend);
  backend.get = async id => { n.get++; return get(id); };
  backend.list = async labels => { n.list++; return list(labels); };
  for (const m of backend.machines) {
    const state = m.state.bind(m);
    m.state = async () => { n.state++; return state(); };
  }
  return () => ({ ...n });
}

function testRuntime(status?: StatusWatchOptions): {
  rt: Runtime;
  backend: StubBackend;
} {
  const backend = stubBackend();
  const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, ...(status ? { status } : {}) });
  return { rt, backend };
}

/** delayMs "never" holds the request open so the probe can only time out; onRequest runs as each request lands. */
async function httpStub(statusCode: number, delayMs: number | "never" = 0, onRequest?: () => void): Promise<{ server: Server; port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    onRequest?.();
    if (delayMs === "never") return;
    setTimeout(() => res.writeHead(statusCode).end(), delayMs);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { server, port, hits: () => hits };
}

const openServers: Server[] = [];
let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  await Promise.all(openServers.map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); }));
  openServers.length = 0;
});

describe("status.list", () => {
  it("enriches views with machine state, reach, size, and rate from backend pricing", async () => {
    const { rt, backend } = testRuntime();
    await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    const statuses = await rt.status.list();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      name: "alpha",
      phase: "running",
      machineState: "running",
      reach: { state: "unsupported" }, // stub machines mint no preview URLs
      size: backend.pricing.defaultSize, // asked for explicitly when the caller names none; the stub builds what it is asked
      rateUsdPerHour: backend.pricing.rateUsdPerHour(backend.pricing.defaultSize),
    });
    expect(statuses[0]!.rateUsdPerHour).toBeCloseTo(0.11, 5);
  });

  it("probes the daemon through a minted preview URL and reuses fresh reach", async () => {
    const { rt, backend } = testRuntime();
    await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    // Plain HTTP against the daemon's ws port answers 426 (measured, ticket-6 spike).
    const probe = await httpStub(426);
    openServers.push(probe.server);
    let minted = 0;
    backend.machines[0]!.previewUrl = async port => {
      minted++;
      return { url: `http://127.0.0.1:${probe.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 };
    };

    const first = await rt.status.list();
    expect(first[0]!.reach).toMatchObject({ state: "reachable" });
    expect(first[0]!.reach.url).toContain(`127.0.0.1:${probe.port}`);
    await rt.status.list();
    expect(minted).toBe(1); // fresh reach is cached, not reminted per call

    // 502 comes from the edge when nothing listens in the guest.
    const dead = await httpStub(502);
    openServers.push(dead.server);
    backend.machines[0]!.previewUrl = async port => ({
      url: `http://127.0.0.1:${dead.port}/?port=${port}`,
      token: "t",
      expiresAt: Date.now() + 3_600_000,
    });
    const ws = (await rt.workspaces.list())[0]!;
    await rt.workspaces.nap(ws.id);
    await rt.workspaces.wake(ws.id); // wake keeps the machine; cached reach still fresh
    const again = await rt.status.list();
    expect(["reachable", "no-daemon"]).toContain(again[0]!.reach.state); // cache may still hold the live stub
  });

  it("maps napping and gone machines without probing", async () => {
    const { rt, backend } = testRuntime();
    const a = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await rt.workspaces.create({ golden: "snap_g", name: "b" });
    await rt.workspaces.nap(a.id);
    await backend.machines[1]!.kill();
    const statuses = await rt.status.list();
    const byName = new Map(statuses.map(s => [s.name, s]));
    expect(byName.get("a")).toMatchObject({ machineState: "paused", reach: { state: "napping" } });
    expect(byName.get("b")).toMatchObject({ machineState: "gone", reach: { state: "gone" } });
  });

  it("an explicit list() asks the provider once per machine and never list()", async () => {
    const { rt, backend } = testRuntime();
    await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    const calls = countProvider(backend);
    const statuses = await rt.status.list();
    expect(statuses[0]).toMatchObject({ machineState: "running" });
    expect(calls()).toEqual({ get: 0, list: 0, state: 1 });
    backend.machines[0]!.paused = true; // the provider paused it behind our back
    expect((await rt.status.list())[0]).toMatchObject({ phase: "running", machineState: "paused" });
    await backend.machines[0]!.kill();
    expect((await rt.status.list())[0]).toMatchObject({ machineState: "gone", reach: { state: "gone" } });
  });

  it("maps a prompt 502 to no-daemon, a late answer to slow, silence to unreachable, and leaves the row where it was for any other answer the edge gives", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    // The stub moves the clock as the request lands, so "late" is what the clock says and not how fast the box answered.
    // The probe timeout is a real abort: only the silent case keeps it short, the answering ones get more than any local fetch needs.
    const cases: [number, number | "never", number, string][] = [
      [426, 0, 5_000, "reachable"],
      [502, 0, 5_000, "no-daemon"],
      // Not the guest's answer, so it decides nothing on its own: an edge refusal must not take a live workspace
      // out of service in the row, it only sends the poll to the provider for the machine's real state.
      [200, 0, 5_000, "reachable"],
      [401, 0, 5_000, "reachable"],
      [404, 0, 5_000, "reachable"],
      [503, 0, 5_000, "reachable"],
      [502, 150, 5_000, "slow"],
      [426, 150, 5_000, "slow"],
      [426, "never", 300, "unreachable"],
    ];
    for (const [code, took, probeTimeoutMs, expected] of cases) {
      const opts = { probeTimeoutMs, promptMs: 60 };
      const stub = await httpStub(code, took === "never" ? "never" : 0, () => fc.advance(took === "never" ? 0 : took));
      openServers.push(stub.server);
      // A fresh runtime per case so no cached reach carries the previous stub over.
      const fresh = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock });
      await fresh.workspaces.create({ golden: "snap_g", name: `case-${code}-${took}` });
      const last = backend.machines.at(-1)!;
      last.previewUrl = async port => ({
        url: `http://127.0.0.1:${stub.port}/?port=${port}&case=${code}-${took}`,
        token: "t",
        expiresAt: Date.now() + 3_600_000,
      });
      const status = (await fresh.status.list(opts)).find(s => s.machineId === last.id)!;
      expect(status.reach.state, `${code} after ${took}`).toBe(expected);
      expect(status.machineState).toBe("running");
      // A running machine stays sendable through every answer but the guest's own silence or a dead daemon port.
      const sendable = sendRefusal(workspaceState({ phase: status.phase, machineState: status.machineState, reach: status.reach.state })) === null;
      expect(sendable, `${code} after ${took} sendable`).toBe(expected === "reachable" || expected === "slow");
    }
  });
});

describe("status.watch provider calls", () => {
  it("asks the provider nothing across healthy polls", async () => {
    const { rt, backend } = testRuntime({ costIntervalMs: 60_000, pollIntervalMs: 5 });
    await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    const probe = await httpStub(426);
    openServers.push(probe.server);
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${probe.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    await rt.workspaces.create({ golden: "snap_g", name: "no-preview" }); // unsupported reach is healthy too
    const calls = countProvider(backend);
    const stop = rt.status.watch();
    await until(() => probe.hits() >= 8);
    stop();
    expect(calls()).toEqual({ get: 0, list: 0, state: 0 });
  });

  it("asks the provider once after a failed reach, then not again inside the reconcile window", async () => {
    const { rt, backend } = testRuntime({ costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 });
    await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    const dead = await httpStub(502);
    openServers.push(dead.server);
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${dead.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    const calls = countProvider(backend);
    const seen: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => seen.push((e as { status: WorkspaceStatus }).status));
    const stop = rt.status.watch();
    await until(() => dead.hits() >= 8);
    stop();
    expect(calls()).toEqual({ get: 0, list: 0, state: 1 });
    expect(seen.at(-1)).toMatchObject({ machineState: "running", reach: { state: "no-daemon" } });
  });
});

describe("status.watch cost events", () => {
  it("emits workspace.cost on a timer with awake-time accrual, zero rate while napping", async () => {
    const { rt, backend } = testRuntime({ costIntervalMs: 15, pollIntervalMs: 60_000 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "alpha", cpu: 4, memMb: 8192 });
    const costs: (EventUnion & { type: "workspace.cost" })[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as EventUnion & { type: "workspace.cost" }));

    const stop = rt.status.watch();
    await until(() => costs.length >= 2);
    const running = costs.at(-1)!;
    EventUnion.parse(running); // the wire schema accepts what the bus emits
    expect(running.workspaceId).toBe(ws.id);
    expect(running.phase).toBe("running");
    expect(running.rateUsdPerHour).toBeCloseTo(backend.pricing.rateUsdPerHour({ cpu: 4, memMb: 8192 }), 5);
    expect(running.awakeMs).toBeGreaterThan(0);
    expect(running.accruedUsd).toBeGreaterThan(0);

    await rt.workspaces.nap(ws.id);
    costs.length = 0;
    await until(() => costs.length >= 2);
    stop();
    expect(costs.at(-1)!.rateUsdPerHour).toBe(0);
    // napping accrues nothing: consecutive events carry the same total
    expect(costs.at(-1)!.accruedUsd).toBeCloseTo(costs[0]!.accruedUsd, 10);
    expect(costs.at(-1)!.awakeMs).toBe(costs[0]!.awakeMs);

    costs.length = 0;
    await new Promise(r => setTimeout(r, 40));
    expect(costs.length).toBe(0); // unwatched = no timers running
  });

  it("emits workspace.status when the enriched status changes, not on every poll", async () => {
    const { rt } = testRuntime({ costIntervalMs: 60_000, pollIntervalMs: 15 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    const seen: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => seen.push((e as { status: WorkspaceStatus }).status));

    const stop = rt.status.watch();
    await until(() => seen.length >= 1); // first poll baselines every workspace once
    expect(seen.length).toBe(1);
    await rt.workspaces.nap(ws.id);
    // The nap pushes pausing and napping itself; the poller re-emits napping once in its own shape, then stays quiet.
    await until(() => seen.filter(s => s.phase === "napping").length >= 2);
    const settled = seen.length;
    await new Promise(r => setTimeout(r, 60));
    stop();
    expect(seen.length).toBe(settled);
    const phases = seen.map(s => s.phase).filter((p, i, all) => i === 0 || all[i - 1] !== p);
    expect(phases).toEqual(["running", "pausing", "napping"]);
    expect(seen.at(-1)).toMatchObject({ id: ws.id, phase: "napping", machineState: "paused" });
  });
});

describe("the status ticks", () => {
  it("an answer the guest did not send sends the poll to the provider once, and leaves the row running", async () => {
    const { rt, backend } = testRuntime({ costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 });
    await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    // The edge refusing a token it minted itself: the request never reached the guest, so it says nothing about it.
    const edge = await httpStub(401);
    openServers.push(edge.server);
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    const calls = countProvider(backend);
    const seen: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => seen.push((e as { status: WorkspaceStatus }).status));

    const stop = rt.status.watch();
    try {
      await until(() => edge.hits() >= 8, 5_000);
    } finally {
      stop();
    }
    expect(calls()).toEqual({ get: 0, list: 0, state: 1 });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ phase: "running", machineState: "running", reach: { state: "reachable" } });
    expect(sendRefusal(workspaceState({ phase: last.phase, machineState: last.machineState, reach: last.reach.state }))).toBeNull();
  }, 10_000);

  it("a tick that throws is logged and the next tick still runs; nothing reaches the process as an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const caught = (e: unknown): void => void rejections.push(e);
    process.on("unhandledRejection", caught);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let asked = 0;
    const tracker = createStatusTracker({
      rateUsdPerHour: () => 0.11,
      records: async () => {
        asked++;
        throw new Error("the store is gone");
      },
      store: memoryStore(),
      emit: () => {},
      on: () => () => {},
      defaults: { costIntervalMs: 5, pollIntervalMs: 5 },
    });
    const stop = tracker.watch();
    try {
      await until(() => asked >= 4, 5_000);
    } finally {
      stop();
      process.off("unhandledRejection", caught);
      warn.mockRestore();
    }
    expect(rejections).toEqual([]);
  }, 10_000);
});

describe("a pause the provider made", () => {
  type Cost = EventUnion & { type: "workspace.cost" };

  it("the poll asks the provider when the edge answers for the machine instead of the daemon, and the record follows", async () => {
    const { rt, backend } = testRuntime({ costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 0 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    // The edge answers for a machine it cannot hand the request to; only the daemon's own 426 proves a live guest.
    const edge = await httpStub(404);
    openServers.push(edge.server);
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    const napped: EventUnion[] = [];
    rt.events.on("workspace.napped", e => napped.push(EventUnion.parse(e)));
    backend.machines[0]!.paused = true;

    const stop = rt.status.watch();
    try {
      await until(() => statuses.some(s => s.phase === "napping"), 5_000);
    } finally {
      stop();
    }
    // The wire event says the pause was found, not made here: what the meter needs to end the stretch where it did.
    expect(napped).toMatchObject([{ type: "workspace.napped", workspaceId: ws.id, found: true }]);
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    // The status that moved it: the record still said running, the edge answered for the machine, the provider said
    // paused. The edge's answer never reads as a dead daemon, so the row says Paused and not Unreachable.
    const moved = statuses.find(s => s.phase === "running" && s.machineState === "paused")!;
    expect(moved.reach.state).toBe("reachable");
    expect(workspaceState({ phase: moved.phase, machineState: moved.machineState, reach: moved.reach.state })).toBe("paused");
  }, 10_000);

  it("a machine paused at the provider while the host was down hydrates napping, in the store too, and the gap is not billed", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const status = { costIntervalMs: 15, pollIntervalMs: 60_000 };
    // The clock jumps an hour: the idle window must not nap the workspace behind the test.
    const idle = { defaultWindowMs: 24 * 3_600_000 };
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    const ws = await first.workspaces.create({ golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    await until(() => costs.length >= 1);
    fc.advance(60_000);
    await until(() => costs.at(-1)!.awakeMs >= 60_000);
    stop();
    await first.close();
    const metered = costs.at(-1)!.awakeMs;

    // An hour down, and the provider paused the machine meanwhile: the next host reads the state off the view it fetches.
    backend.machines[0]!.paused = true;
    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    expect((await second.workspaces.get(ws.id)).phase).toBe("napping");
    expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "napping" });
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await until(() => after.filter(t => t.phase === "napping").length >= 2);
    const held = after.filter(t => t.phase === "napping");
    expect(held[0]).toMatchObject({ rateUsdPerHour: 0 });
    expect(held[1]!.awakeMs).toBe(held[0]!.awakeMs);
    expect(held[0]!.awakeMs).toBeLessThanOrEqual(metered);

    // The wake resumes the machine the provider paused, and the stretch starts there, not an hour ago.
    await second.workspaces.wake(ws.id);
    fc.advance(10_000);
    await until(() => after.at(-1)!.phase === "running" && after.at(-1)!.awakeMs > held[0]!.awakeMs);
    stop();
    expect(after.at(-1)!.awakeMs).toBe(held[0]!.awakeMs + 10_000);
    expect(backend.machines[0]!.resumes).toBe(1);
    await second.close();
  });

  it("a pause found after a gap in watching ends the awake stretch at the last proof the machine was awake", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    const status = { costIntervalMs: 15, pollIntervalMs: 15, promptMs: 10_000, probeTimeoutMs: 50, reconcileMinMs: 0 };
    // The clock jumps an hour: the idle window must not nap the workspace behind the test.
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, clock: fc.clock, status, idle: { defaultWindowMs: 24 * 3_600_000 } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    const live = await httpStub(426);
    openServers.push(live.server);
    // Under the refresh margin, so every poll mints the route again and the probe follows the machine's current one.
    const minted = (port: number, at: number): { url: string; token: string; expiresAt: number } => ({ url: `http://127.0.0.1:${at}/?port=${port}`, token: "t", expiresAt: Date.now() + 60_000 });
    backend.machines[0]!.previewUrl = async port => minted(port, live.port);
    const costs: Cost[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as Cost));
    const napped: string[] = [];
    rt.events.on("workspace.napped", () => napped.push("napped"));

    let stop = rt.status.watch();
    fc.advance(60_000);
    const proofs = live.hits();
    try {
      await until(() => live.hits() > proofs && costs.at(-1)?.awakeMs === 60_000, 5_000);
    } finally {
      stop();
    }

    // An hour with nothing watching: no tick and no poll runs, and the provider pauses the machine within it.
    fc.advance(3_600_000);
    backend.machines[0]!.paused = true;
    // The reach goes dark while a machine is paused (measured), whatever the record still says.
    const dark = await httpStub(426, "never");
    openServers.push(dark.server);
    backend.machines[0]!.previewUrl = async port => minted(port, dark.port);

    stop = rt.status.watch();
    try {
      await until(() => napped.length >= 1, 5_000);
      const seen = costs.length;
      await until(() => costs.length > seen, 2_000);
    } finally {
      stop();
    }
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    expect(costs.at(-1)).toMatchObject({ phase: "napping", rateUsdPerHour: 0, awakeMs: 60_000 });
    expect((await rt.status.history(ws.id)).at(-1)).toMatchObject({ awakeMs: 60_000 });
  }, 20_000);
});

describe("status.history", () => {
  type Cost = EventUnion & { type: "workspace.cost" };
  /** A store whose writes to the cost history collection are counted. */
  function countingStore(): { store: Store; puts: () => number; deletes: () => number } {
    const store = memoryStore();
    const n = { puts: 0, deletes: 0 };
    const put = store.put.bind(store);
    const del = store.delete.bind(store);
    store.put = async (collection, id, value) => {
      if (collection === "cost-histories") n.puts++;
      return put(collection, id, value);
    };
    store.delete = async (collection, id) => {
      if (collection === "cost-histories") n.deletes++;
      return del(collection, id);
    };
    return { store, puts: () => n.puts, deletes: () => n.deletes };
  }

  it("holds the folded ticks since metering began and hands them out over the wire", async () => {
    const { rt } = testRuntime({ costIntervalMs: 15, pollIntervalMs: 60_000 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    expect(await rt.status.history(ws.id)).toEqual([]);
    const costs: Cost[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as Cost));
    const stop = rt.status.watch();
    await until(() => costs.length >= 4);
    // One rate the whole way: the first tick and the newest, nothing between.
    let history = await rt.status.history(ws.id);
    expect(history).toHaveLength(2);
    // The bus stamps a seq on what it emits; the history holds the ticks as the tracker built them.
    expect(costs[0]).toMatchObject(history[0]!);
    expect(costs.at(-1)).toMatchObject(history[1]!);

    await rt.workspaces.nap(ws.id);
    const before = costs.length;
    await until(() => costs.length >= before + 3);
    history = await rt.status.history(ws.id);
    const rates = history.map(p => p.rateUsdPerHour);
    // The last running tick and the first napping one bracket the change; the napping run folds to its newest.
    expect(rates.slice(0, 2).every(r => r > 0)).toBe(true);
    expect(rates.slice(2).every(r => r === 0)).toBe(true);
    expect(history).toHaveLength(4);
    expect(costs.at(-1)).toMatchObject(history.at(-1)!);

    srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const res = await c.request("cost.history", { workspaceId: ws.id });
    stop();
    c.close();
    expect(res.ok).toBe(true);
    expect(res["points"]).toEqual(await rt.status.history(ws.id));
    expect(await rt.status.history("ws_nobody")).toEqual([]);
  });

  it("survives a host restart: a fresh runtime over the same store hands out the stored ticks and meters on from them", async () => {
    const backend = stubBackend();
    const { store, puts } = countingStore();
    const fc = fakeClock();
    const status = { costIntervalMs: 15, pollIntervalMs: 60_000 };
    // The clock jumps an hour: the idle window must not nap the workspace behind the test.
    const idle = { defaultWindowMs: 24 * 3_600_000 };
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    const ws = await first.workspaces.create({ golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    await until(() => costs.length >= 2);
    fc.advance(60_000);
    await until(() => costs.at(-1)!.awakeMs >= 60_000 && costs.length >= 6);
    stop();
    const stored = await first.status.history(ws.id);
    expect(stored).toHaveLength(2);
    // Ticks of one rate replace the newest point in memory and reach the store only when a point is added.
    expect(puts()).toBe(2);

    // An hour down, the machine still running and billing the whole time. The store's newest point is the tick
    // that added it, so the series it hands out before its first tick ends where the rate run began.
    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    const handed = await second.status.history(ws.id);
    expect(handed).toHaveLength(2);
    expect(handed[0]).toEqual(stored[0]);
    expect(handed[1]).toMatchObject({ workspaceId: ws.id, phase: "running", rateUsdPerHour: stored[1]!.rateUsdPerHour });
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await until(() => after.length >= 2);
    const tick = after.at(-1)!;
    expect(tick.awakeMs).toBeGreaterThanOrEqual(60_000 + 3_600_000);
    expect(tick.accruedUsd).toBeCloseTo((tick.rateUsdPerHour * tick.awakeMs) / 3_600_000, 10);
    expect(tick.accruedUsd).toBeGreaterThan(0.1);
    // The run continues at one rate: the stored first tick stays, the newest moves, no point was added.
    const history = await second.status.history(ws.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(stored[0]);
    expect(history[1]).toMatchObject({ awakeMs: tick.awakeMs, accruedUsd: tick.accruedUsd });
    expect(puts()).toBe(2);

    // A nap after the restart is a rate change: it adds two points and both reach the store.
    await second.workspaces.nap(ws.id);
    const before = after.length;
    await until(() => after.length >= before + 3);
    stop();
    expect(await second.status.history(ws.id)).toHaveLength(4);
    expect(puts()).toBe(4);
    const third = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    const restored = await third.status.history(ws.id);
    expect(restored).toHaveLength(4);
    expect(restored.at(-1)!.rateUsdPerHour).toBe(0);
    expect(restored.at(-1)!.awakeMs).toBe(tick.awakeMs);
  });

  it("a workspace napping across the restart keeps its total and accrues nothing until it wakes", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const status = { costIntervalMs: 15, pollIntervalMs: 60_000 };
    // The clock jumps an hour: the idle window must not nap the workspace behind the test.
    const idle = { defaultWindowMs: 24 * 3_600_000 };
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    const ws = await first.workspaces.create({ golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    await until(() => costs.length >= 1);
    fc.advance(30_000);
    await first.workspaces.nap(ws.id);
    await until(async () => costs.at(-1)!.rateUsdPerHour === 0 && (await first.status.history(ws.id)).length >= 3);
    stop();
    const total = costs.at(-1)!.awakeMs;
    expect(total).toBe(30_000);

    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await until(() => after.length >= 2);
    expect(after.at(-1)).toMatchObject({ phase: "napping", rateUsdPerHour: 0, awakeMs: total });
    await second.workspaces.wake(ws.id);
    fc.advance(10_000);
    await until(() => after.at(-1)!.phase === "running" && after.at(-1)!.awakeMs >= total + 10_000);
    stop();
    expect(after.at(-1)!.awakeMs).toBe(total + 10_000);
  });

  it("a host that died between a nap and its tick does not bill the nap: the wake starts the stretch afresh", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const status = { costIntervalMs: 15, pollIntervalMs: 60_000 };
    const idle = { defaultWindowMs: 24 * 3_600_000 };
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    const ws = await first.workspaces.create({ golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    await until(() => costs.length >= 2);
    stop();
    // The store's newest point still says running when the nap lands and the host dies before the next tick.
    await first.workspaces.nap(ws.id);

    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    expect((await second.status.history(ws.id)).at(-1)).toMatchObject({ phase: "running" });
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await until(() => after.length >= 1);
    expect(after.at(-1)).toMatchObject({ phase: "napping", rateUsdPerHour: 0, awakeMs: 0 });
    await second.workspaces.wake(ws.id);
    fc.advance(10_000);
    await until(() => after.at(-1)!.phase === "running" && after.at(-1)!.awakeMs > 0);
    stop();
    expect(after.at(-1)!.awakeMs).toBe(10_000);
  });

  it("forgets a deleted workspace's history, in memory and in the store", async () => {
    const backend = stubBackend();
    const { store, deletes } = countingStore();
    const rt = createRuntime({ backend, store, adapters: {}, status: { costIntervalMs: 15, pollIntervalMs: 60_000 } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    rt.events.on("workspace.cost", e => costs.push(e as Cost));
    const stop = rt.status.watch();
    await until(() => costs.length >= 1);
    await rt.workspaces.delete(ws.id);
    stop();
    expect(await rt.status.history(ws.id)).toEqual([]);
    await until(() => deletes() >= 1);
    const fresh = createRuntime({ backend, store, adapters: {}, status: { costIntervalMs: 15, pollIntervalMs: 60_000 } });
    expect(await fresh.status.history(ws.id)).toEqual([]);
  });
});

describe("serveRuntime status.subscribe", () => {
  it("returns a snapshot and pushes cost events to a subscribed socket", async () => {
    const { rt } = testRuntime({ costIntervalMs: 15, pollIntervalMs: 60_000 });
    await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    await c.request("events.subscribe");
    const res = await c.request("status.subscribe");
    expect(res.ok).toBe(true);
    const statuses = res["statuses"] as WorkspaceStatus[];
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ name: "alpha", machineState: "running" });
    await until(() => c.events.some(e => e.type === "workspace.cost"));
    c.close();
  });
});

describe("status zombie at rest", () => {
  /** A stub that answers 426 late: the machine is there, the edge is slow (the two measured zombies read this way for minutes). */
  async function slowMachine(backend: StubBackend): Promise<{ hits: () => number }> {
    const slow = await httpStub(426, 40);
    openServers.push(slow.server);
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${slow.port}/?port=${port}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    return slow;
  }
  const probes = (backend: StubBackend) => backend.machines[0]!.execLog.filter(c => c === "echo ok").length;
  const statuses = (rt: Runtime): WorkspaceStatus[] => {
    const seen: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => seen.push((e as { status: WorkspaceStatus }).status));
    return seen;
  };
  const opts = { costIntervalMs: 60_000, pollIntervalMs: 5, promptMs: 10, probeTimeoutMs: 500, zombieWindowMs: 80, zombieProbeTimeoutMs: 200 };

  it("reach slow past the window and a failing exec probe mark the workspace zombie, with the machine id and timings in the reason, once", async () => {
    const { rt, backend } = testRuntime(opts);
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "hello" });
    await slowMachine(backend);
    backend.execImpl = (_m, cmd) => (cmd === "echo ok" ? { exitCode: 1, stdout: "", stderr: "502 exec failed" } : { exitCode: 0, stdout: "", stderr: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen = statuses(rt);
    const stop = rt.status.watch();
    try {
      await until(() => seen.some(s => s.reach.state === "zombie"), 5_000);
      const zombie = seen.find(s => s.reach.state === "zombie")!;
      expect(zombie).toMatchObject({ id: ws.id, phase: "running", machineState: "running", machineId: "m1" });
      expect(zombie.reason).toMatch(/m1/);
      expect(zombie.reason).toMatch(/slow .*\d+ s/);
      expect(zombie.reason).toMatch(/echo ok.*\d+ ms.*exit 1: 502 exec failed/);
      expect(seen.filter(s => s.reach.state === "slow").length).toBeGreaterThan(0);
      // The mark sticks: later polls keep saying zombie without probing again.
      const before = probes(backend);
      const pushed = seen.length;
      await new Promise(r => setTimeout(r, 100));
      expect(probes(backend)).toBe(before);
      expect(before).toBe(1);
      expect(seen.slice(pushed).every(s => s.reach.state === "zombie")).toBe(true);
      expect(seen.filter(s => s.reach.state === "zombie").length).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/zombie.*m1/);
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it("a slow spell where exec answers never flags, and the probe repeats once per window rather than per poll", async () => {
    const { rt, backend } = testRuntime(opts);
    await rt.workspaces.create({ golden: "snap_g", name: "weather" });
    const slow = await slowMachine(backend);
    backend.execImpl = (_m, cmd) => (cmd === "echo ok" ? { exitCode: 0, stdout: "ok\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const seen = statuses(rt);
    const stop = rt.status.watch();
    try {
      await until(() => probes(backend) >= 2, 5_000);
      const polls = slow.hits();
      expect(seen.every(s => s.reach.state === "slow")).toBe(true);
      expect(seen.every(s => s.reason === undefined)).toBe(true);
      expect(polls).toBeGreaterThan(probes(backend) * 2);
    } finally {
      stop();
    }
  });

  it("an exec probe that never returns is cut at its timeout and counts as failed", async () => {
    const { rt, backend } = testRuntime({ ...opts, zombieProbeTimeoutMs: 60 });
    await rt.workspaces.create({ golden: "snap_g", name: "hang" });
    await slowMachine(backend);
    backend.execImpl = (_m, cmd) => (cmd === "echo ok" ? new Promise<never>(() => {}) : { exitCode: 0, stdout: "", stderr: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen = statuses(rt);
    const stop = rt.status.watch();
    try {
      await until(() => seen.some(s => s.reach.state === "zombie"), 5_000);
      expect(seen.find(s => s.reach.state === "zombie")!.reason).toMatch(/timed out after 60 ms/);
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it("a machine the provider says is paused gets no probe: the divergence already explains the slow reach", async () => {
    const { rt, backend } = testRuntime(opts);
    await rt.workspaces.create({ golden: "snap_g", name: "behind-our-back" });
    await slowMachine(backend);
    backend.machines[0]!.paused = true;
    const seen = statuses(rt);
    const stop = rt.status.watch();
    try {
      await until(() => seen.some(s => s.machineState === "paused"), 5_000);
      await new Promise(r => setTimeout(r, 200));
      expect(probes(backend)).toBe(0);
      expect(seen.some(s => s.reach.state === "zombie")).toBe(false);
    } finally {
      stop();
    }
  });
});

describe("gone machines and the meter", () => {
  type Cost = EventUnion & { type: "workspace.cost" };

  it("a record found gone at hydrate drops its awake mark without folding: gone ticks are frozen and the first tick after a rebuild does not bill the downtime", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const status = { costIntervalMs: 15, pollIntervalMs: 60_000 };
    // The clock jumps an hour: the idle window must not nap the workspace behind the test.
    const idle = { defaultWindowMs: 24 * 3_600_000 };
    const first = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    const ws = await first.workspaces.create({ golden: "snap_g", name: "alpha" });
    const costs: Cost[] = [];
    first.events.on("workspace.cost", e => costs.push(e as Cost));
    let stop = first.status.watch();
    await until(() => costs.length >= 1);
    fc.advance(60_000);
    await until(() => costs.at(-1)!.awakeMs >= 60_000);
    stop();
    await first.close();
    const stored = costs.at(-1)!.awakeMs;

    // An hour down, and the machine deleted at the provider meanwhile: the next host finds it gone.
    backend.machines[0]!.killed = true;
    fc.advance(3_600_000);
    const second = createRuntime({ backend, store, adapters: {}, clock: fc.clock, status, idle });
    const after: Cost[] = [];
    second.events.on("workspace.cost", e => after.push(e as Cost));
    stop = second.status.watch();
    await until(() => after.filter(t => t.phase === "gone").length >= 2);
    const gone = after.filter(t => t.phase === "gone");
    expect(gone[0]).toMatchObject({ rateUsdPerHour: 0 });
    expect(gone[1]!.awakeMs).toBe(gone[0]!.awakeMs);
    expect(gone[0]!.awakeMs).toBeLessThanOrEqual(stored);

    await second.workspaces.rebuild(ws.id);
    await until(() => after.at(-1)!.phase === "running");
    fc.advance(10_000);
    await until(() => after.at(-1)!.awakeMs >= gone[0]!.awakeMs + 10_000);
    // The stretch begins at the rebuild: the hour the host was down and the machine did not exist is not on the bill.
    expect(after.at(-1)!.awakeMs).toBe(gone[0]!.awakeMs + 10_000);
    stop();
    await second.close();
  });
});
