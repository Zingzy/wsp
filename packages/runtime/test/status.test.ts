// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:http";
import { EventUnion, type WorkspaceStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
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

function testRuntime(status?: { costIntervalMs?: number; pollIntervalMs?: number; reconcileMinMs?: number }): {
  rt: Runtime;
  backend: StubBackend;
} {
  const backend = stubBackend();
  const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, ...(status ? { status } : {}) });
  return { rt, backend };
}

/** delayMs "never" holds the request open so the probe can only time out. */
async function httpStub(statusCode: number, delayMs: number | "never" = 0): Promise<{ server: Server; port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
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

  it("maps a prompt 426 to reachable, a prompt 502 to no-daemon, a late answer to slow, and silence to unreachable", async () => {
    const { rt, backend } = testRuntime();
    await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    const opts = { probeTimeoutMs: 300, promptMs: 60 };
    const cases: [number, number | "never", string][] = [
      [426, 0, "reachable"],
      [502, 0, "no-daemon"],
      [502, 150, "slow"],
      [426, 150, "slow"],
      [426, "never", "unreachable"],
    ];
    for (const [code, delay, expected] of cases) {
      const stub = await httpStub(code, delay);
      openServers.push(stub.server);
      backend.machines[0]!.previewUrl = async port => ({
        url: `http://127.0.0.1:${stub.port}/?port=${port}&case=${code}-${delay}`,
        token: "t",
        expiresAt: Date.now() + 3_600_000,
      });
      // A fresh runtime per case so no cached reach carries the previous stub over.
      const fresh = createRuntime({ backend, store: memoryStore(), adapters: {} });
      await fresh.workspaces.create({ golden: "snap_g", name: `case-${code}-${delay}` });
      const last = backend.machines.at(-1)!;
      last.previewUrl = backend.machines[0]!.previewUrl;
      const status = (await fresh.status.list(opts)).find(s => s.machineId === last.id)!;
      expect(status.reach.state, `${code} after ${delay}`).toBe(expected);
      expect(status.machineState).toBe("running");
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
    await until(() => seen.length >= 2);
    stop();
    expect(seen.length).toBe(2);
    expect(seen.at(-1)).toMatchObject({ id: ws.id, phase: "napping", machineState: "paused" });
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
