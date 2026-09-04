// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:http";
import { EventUnion, type WorkspaceStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import type { StatusWatchOptions } from "../src/status.js";
import { memoryStore } from "../src/store.js";
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

  it("maps a prompt 426 to reachable, a prompt 502 to no-daemon, a late answer to slow, and silence to unreachable", async () => {
    const backend = stubBackend();
    const fc = fakeClock();
    // The stub moves the clock as the request lands, so "late" is what the clock says and not how fast the box answered.
    // The probe timeout is a real abort: only the silent case keeps it short, the answering ones get more than any local fetch needs.
    const cases: [number, number | "never", number, string][] = [
      [426, 0, 5_000, "reachable"],
      [502, 0, 5_000, "no-daemon"],
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
