// SPDX-License-Identifier: AGPL-3.0-only
import type { AdapterEvent, TurnResult } from "@wsp/adapter-claude";
import type { EventUnion, WorkspaceStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { IDLE_OFF_BACKSTOP_MS, createIdlePolicy, type IdlePolicy } from "../src/idle.js";
import { createRuntime, type HarnessAdapterFactory, type RuntimeOptions } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

/** Minutes, not milliseconds: the clock is fake, so a long window costs nothing and scheduling jitter cannot reach it. */
const WINDOW = 5 * 60_000;

describe("idle policy mechanics", () => {
  const windows = new Map<string, number | null>();
  let fired: { id: string; windowMs: number }[] = [];
  let policy: IdlePolicy | undefined;
  let fc = fakeClock();
  const make = (): IdlePolicy =>
    (policy = createIdlePolicy({
      windowOf: id => (windows.has(id) ? windows.get(id)! : WINDOW),
      onIdle: async (id, windowMs) => {
        fired.push({ id, windowMs });
      },
      clock: fc.clock,
    }));
  afterEach(() => {
    policy?.close();
    policy = undefined;
    windows.clear();
    fired = [];
    fc = fakeClock();
  });

  it("fires once after the window with the window it used, then waits for the next touch", () => {
    const p = make();
    p.touch("a");
    expect(p.idleAt("a")).toBe(fc.clock.now() + WINDOW);
    expect(fc.pending()).toBe(1);
    expect(fc.holding()).toBe(0); // an armed window never keeps the process alive
    fc.advance(WINDOW - 1);
    expect(fired).toEqual([]);
    fc.advance(1);
    expect(fired).toEqual([{ id: "a", windowMs: WINDOW }]);
    expect(p.idleAt("a")).toBeUndefined();
    fc.advance(WINDOW * 2);
    expect(fired).toHaveLength(1);
  });

  it("every touch starts the window over", () => {
    const p = make();
    for (let i = 0; i < 8; i++) {
      p.touch("a");
      fc.advance(WINDOW / 4);
    }
    expect(fired).toEqual([]);
    expect(p.idleAt("a")).toBe(fc.clock.now() + (WINDOW * 3) / 4);
    fc.advance((WINDOW * 3) / 4);
    expect(fired).toEqual([{ id: "a", windowMs: WINDOW }]);
  });

  it("a hold keeps the window from firing; the last release starts it over", () => {
    const p = make();
    p.touch("a");
    p.hold("a");
    p.hold("a");
    expect(p.idleAt("a")).toBeUndefined();
    fc.advance(WINDOW * 2.5);
    expect(fired).toEqual([]);
    p.release("a");
    fc.advance(WINDOW * 1.5);
    expect(fired).toEqual([]); // one hold still stands
    p.release("a");
    expect(p.idleAt("a")).toBe(fc.clock.now() + WINDOW);
    fc.advance(WINDOW - 1);
    expect(fired).toEqual([]);
    fc.advance(1);
    expect(fired).toEqual([{ id: "a", windowMs: WINDOW }]);
  });

  it("the last release starts the window over from the release, not from the touch", () => {
    const p = make();
    p.touch("a");
    p.hold("a");
    fc.advance(WINDOW / 2);
    p.release("a");
    expect(p.idleAt("a")).toBe(fc.clock.now() + WINDOW);
    fc.advance(WINDOW - 1);
    expect(fired).toEqual([]);
    fc.advance(1);
    expect(fired).toEqual([{ id: "a", windowMs: WINDOW }]);
  });

  it("off means never: no timer, no deadline", () => {
    windows.set("a", null);
    const p = make();
    p.touch("a");
    expect(p.idleAt("a")).toBeUndefined();
    expect(fc.pending()).toBe(0);
    fc.advance(WINDOW * 3);
    expect(fired).toEqual([]);
  });

  it("forget cancels the window (a nap or a delete)", () => {
    const p = make();
    p.touch("a");
    p.forget("a");
    expect(p.idleAt("a")).toBeUndefined();
    expect(fc.pending()).toBe(0);
    fc.advance(WINDOW * 2);
    expect(fired).toEqual([]);
  });

  it("a per-workspace window overrides the default", () => {
    windows.set("fast", WINDOW / 4);
    const p = make();
    p.touch("fast");
    p.touch("slow");
    fc.advance(WINDOW / 4);
    expect(fired).toEqual([{ id: "fast", windowMs: WINDOW / 4 }]);
    fc.advance((WINDOW * 3) / 4);
    expect(fired.map(f => f.id)).toEqual(["fast", "slow"]);
  });
});

function testRuntime(extra: Partial<RuntimeOptions> = {}) {
  const backend = stubBackend();
  const fc = fakeClock();
  const rt = createRuntime({
    backend,
    store: memoryStore(),
    adapters: {},
    clock: fc.clock,
    idle: { defaultWindowMs: WINDOW },
    status: { costIntervalMs: 60_000, pollIntervalMs: 60_000 },
    ...extra,
  });
  return { rt, backend, fc };
}

const phaseOf = async (rt: ReturnType<typeof testRuntime>["rt"], id: string) => (await rt.workspaces.get(id)).phase;
const napping = (rt: ReturnType<typeof testRuntime>["rt"], id: string) => until(async () => (await phaseOf(rt, id)) === "napping");

/** A session that stays running until the test ends it. */
function heldSession(): { factory: HarnessAdapterFactory; end: () => void } {
  let end!: () => void;
  const factory: HarnessAdapterFactory = () => ({
    start(o) {
      const result: TurnResult = { status: "completed" };
      const finished = new Promise<TurnResult>(resolve => {
        end = () => {
          o.onEvent({ type: "turn.done", sessionId: "c1", result } as AdapterEvent);
          o.onEvent({ type: "session.end", sessionId: "c1", exitCode: 0, sawResult: true } as AdapterEvent);
          resolve(result);
        };
      });
      o.onEvent({ type: "session.start", sessionId: "c1" } as AdapterEvent);
      return { localId: "s1", claudeSessionId: "c1", finished, interrupt: async () => {} };
    },
  });
  return { factory, end: () => end() };
}

let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

describe("idle policy in the runtime", () => {
  it("naps an untouched workspace after the window and pushes a status that says why", async () => {
    const { rt, backend, fc } = testRuntime();
    const napped: EventUnion[] = [];
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.napped", e => napped.push(e));
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const [before] = await rt.status.list();
    expect(before!.idleAt).toBe(fc.clock.now() + WINDOW);
    fc.advance(WINDOW - 1);
    expect(await phaseOf(rt, ws.id)).toBe("running");
    fc.advance(1);
    await until(() => statuses.some(s => s.phase === "napping"));
    expect(await phaseOf(rt, ws.id)).toBe("napping");
    expect(napped).toHaveLength(1);
    expect(backend.machines[0]!.paused).toBe(true);
    const pushed = statuses.find(s => s.phase === "napping");
    expect(pushed).toMatchObject({ id: ws.id, machineState: "paused", reach: { state: "napping" } });
    expect(pushed!.reason).toBe("idle 5 min");
    expect(pushed!.idleAt).toBeUndefined();
    fc.advance(WINDOW * 2);
    expect(napped).toHaveLength(1); // napping is not idle
  });

  it("names the window in minutes the way the rail will show it", async () => {
    const { rt, fc } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    await rt.workspaces.create({ golden: "snap_g", name: "a", idleWindowMs: 3 * 60_000 });
    fc.advance(3 * 60_000);
    await until(() => statuses.some(s => s.phase === "napping"));
    expect(statuses.at(-1)!.reason).toBe("idle 3 min");
    const [status] = await rt.status.list();
    expect(status!.idleAt).toBeUndefined();
  });

  it("workspaces.touch over the wire starts the window over", async () => {
    const { rt, fc } = testRuntime();
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    for (let i = 0; i < 8; i++) {
      fc.advance(WINDOW / 4);
      const res = await c.request("workspaces.touch", { workspaceId: ws.id });
      expect(res.ok).toBe(true);
    }
    expect(await phaseOf(rt, ws.id)).toBe("running");
    const [status] = await rt.status.list();
    expect(status!.idleAt).toBe(fc.clock.now() + WINDOW);
    c.close();
    fc.advance(WINDOW);
    await napping(rt, ws.id);
    const missing = await rt.workspaces.touch("ws_nope").catch((e: Error) => e.message);
    expect(missing).toContain("no such workspace");
  });

  it("a running session holds the workspace awake; the window starts when it ends", async () => {
    const held = heldSession();
    const { rt, fc } = testRuntime({ adapters: { claude: held.factory } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "go" });
    fc.advance(WINDOW * 3);
    expect(await phaseOf(rt, ws.id)).toBe("running");
    const [active] = await rt.status.list();
    expect(active!.idleAt).toBeUndefined();
    held.end();
    await until(async () => (await rt.status.list())[0]!.idleAt !== undefined);
    expect((await rt.status.list())[0]!.idleAt).toBe(fc.clock.now() + WINDOW);
    fc.advance(WINDOW);
    await napping(rt, ws.id);
  });

  it("off means never; a per-workspace window beats the default", async () => {
    const { rt, fc } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    const off = await rt.workspaces.create({ golden: "snap_g", name: "off", idleWindowMs: null });
    const fast = await rt.workspaces.create({ golden: "snap_g", name: "fast", idleWindowMs: WINDOW });
    fc.advance(WINDOW);
    await napping(rt, fast.id);
    fc.advance(40 * 60_000);
    expect(await phaseOf(rt, off.id)).toBe("running");
    const byName = new Map((await rt.status.list()).map(s => [s.name, s]));
    expect(byName.get("off")!.idleAt).toBeUndefined();
  });

  it("wake and upgrade start the window over; a rehydrated running workspace gets one too", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const fc = fakeClock();
    const rt = createRuntime({ backend, store, adapters: {}, clock: fc.clock, idle: { defaultWindowMs: WINDOW } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    fc.advance(WINDOW);
    await napping(rt, ws.id);
    await rt.workspaces.wake(ws.id);
    fc.advance(WINDOW);
    await napping(rt, ws.id);
    await rt.workspaces.upgrade(ws.id, { cpu: 4 });
    expect(await phaseOf(rt, ws.id)).toBe("running");
    fc.advance(WINDOW);
    await napping(rt, ws.id);
    await rt.workspaces.wake(ws.id);
    await rt.close();

    const rt2 = createRuntime({ backend, store, adapters: {}, clock: fc.clock, idle: { defaultWindowMs: WINDOW } });
    expect(await phaseOf(rt2, ws.id)).toBe("running");
    fc.advance(WINDOW);
    await napping(rt2, ws.id);
  });
});

describe("provider backstop on the fork spec", () => {
  it("pauses on idle at twice the policy window", async () => {
    const { rt, backend } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    await rt.workspaces.create({ golden: "snap_g", name: "a" });
    expect(backend.machines[0]!.spec).toMatchObject({ onIdle: "pause", idleTimeoutMs: 40 * 60_000 });
  });

  it("follows the per-workspace window, and a resurrected fork carries it too", async () => {
    const { rt, backend } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a", idleWindowMs: 5 * 60_000 });
    expect(backend.machines[0]!.spec).toMatchObject({ onIdle: "pause", idleTimeoutMs: 10 * 60_000 });
    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true;
    await rt.workspaces.wake(ws.id);
    expect(backend.machines[1]!.spec).toMatchObject({ onIdle: "pause", idleTimeoutMs: 10 * 60_000 });
  });

  it("off still leaves a long pause backstop so a crashed runtime stops billing", async () => {
    const { rt, backend } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    await rt.workspaces.create({ golden: "snap_g", name: "a", idleWindowMs: null });
    expect(backend.machines[0]!.spec).toMatchObject({ onIdle: "pause", idleTimeoutMs: IDLE_OFF_BACKSTOP_MS });
    expect(IDLE_OFF_BACKSTOP_MS).toBeGreaterThanOrEqual(60 * 60_000);
  });
});
