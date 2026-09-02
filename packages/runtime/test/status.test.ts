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

function testRuntime(status?: { costIntervalMs?: number; pollIntervalMs?: number }): {
  rt: Runtime;
  backend: StubBackend;
} {
  const backend = stubBackend();
  const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, ...(status ? { status } : {}) });
  return { rt, backend };
}

async function httpStub(statusCode: number): Promise<{ server: Server; port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(statusCode).end();
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
  await Promise.all(openServers.map(s => new Promise<void>(r => s.close(() => r()))));
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

  it("confirms absence with get(id) instead of trusting a list() flake", async () => {
    const { rt, backend } = testRuntime();
    await rt.workspaces.create({ golden: "snap_g", name: "alpha" });
    const realList = backend.list.bind(backend);
    backend.list = async () => []; // observed Solari flake: empty while machines exist
    const statuses = await rt.status.list();
    expect(statuses[0]).toMatchObject({ machineState: "running" }); // get(id) rescued it
    backend.list = realList;
    await backend.machines[0]!.kill(); // truly gone: get(id) throws kind "missing"
    const after = await rt.status.list();
    expect(after[0]).toMatchObject({ machineState: "gone", reach: { state: "gone" } });
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
