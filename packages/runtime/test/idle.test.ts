// SPDX-License-Identifier: AGPL-3.0-only
import type { AdapterEvent, TurnResult } from "@wsp/adapter-claude";
import type { EventUnion, WorkspaceStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { IDLE_OFF_BACKSTOP_MS, createIdlePolicy, type IdlePolicy } from "../src/idle.js";
import { createRuntime, type HarnessAdapterFactory, type RuntimeOptions } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

const WINDOW = 80;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("idle policy mechanics", () => {
  const windows = new Map<string, number | null>();
  let fired: { id: string; windowMs: number }[] = [];
  let policy: IdlePolicy | undefined;
  const make = (): IdlePolicy =>
    (policy = createIdlePolicy({
      windowOf: id => (windows.has(id) ? windows.get(id)! : WINDOW),
      onIdle: async (id, windowMs) => {
        fired.push({ id, windowMs });
      },
    }));
  afterEach(() => {
    policy?.close();
    policy = undefined;
    windows.clear();
    fired = [];
  });

  it("fires once after the window with the window it used, then waits for the next touch", async () => {
    const p = make();
    p.touch("a");
    expect(p.idleAt("a")).toBeGreaterThan(Date.now());
    expect(p.idleAt("a")! - Date.now()).toBeLessThanOrEqual(WINDOW);
    await until(() => fired.length === 1);
    expect(fired).toEqual([{ id: "a", windowMs: WINDOW }]);
    expect(p.idleAt("a")).toBeUndefined();
    await sleep(WINDOW * 2);
    expect(fired).toHaveLength(1);
  });

  it("every touch starts the window over", async () => {
    const p = make();
    for (let i = 0; i < 8; i++) {
      p.touch("a");
      await sleep(WINDOW / 4);
    }
    expect(fired).toEqual([]);
    await until(() => fired.length === 1);
  });

  it("a hold keeps the window from firing; the last release starts it over", async () => {
    const p = make();
    p.touch("a");
    p.hold("a");
    p.hold("a");
    expect(p.idleAt("a")).toBeUndefined();
    await sleep(WINDOW * 2.5);
    expect(fired).toEqual([]);
    p.release("a");
    await sleep(WINDOW * 1.5);
    expect(fired).toEqual([]); // one hold still stands
    p.release("a");
    const releasedAt = Date.now();
    expect(p.idleAt("a")).toBeGreaterThanOrEqual(releasedAt + WINDOW - 5);
    await until(() => fired.length === 1);
    expect(Date.now() - releasedAt).toBeGreaterThanOrEqual(WINDOW - 5);
  });

  it("off means never: no timer, no deadline", async () => {
    windows.set("a", null);
    const p = make();
    p.touch("a");
    expect(p.idleAt("a")).toBeUndefined();
    await sleep(WINDOW * 3);
    expect(fired).toEqual([]);
  });

  it("forget cancels the window (a nap or a delete)", async () => {
    const p = make();
    p.touch("a");
    p.forget("a");
    expect(p.idleAt("a")).toBeUndefined();
    await sleep(WINDOW * 2);
    expect(fired).toEqual([]);
  });

  it("a per-workspace window overrides the default", async () => {
    windows.set("fast", WINDOW / 4);
    const p = make();
    p.touch("fast");
    p.touch("slow");
    await until(() => fired.length === 1);
    expect(fired[0]).toEqual({ id: "fast", windowMs: WINDOW / 4 });
  });
});

function testRuntime(extra: Partial<RuntimeOptions> = {}) {
  const backend = stubBackend();
  const rt = createRuntime({
    backend,
    store: memoryStore(),
    adapters: {},
    idle: { defaultWindowMs: WINDOW },
    status: { costIntervalMs: 60_000, pollIntervalMs: 60_000 },
    ...extra,
  });
  return { rt, backend };
}

const phaseOf = async (rt: ReturnType<typeof testRuntime>["rt"], id: string) => (await rt.workspaces.get(id)).phase;

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
      return { localId: "s1", claudeSessionId: "c1", finished };
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
    const { rt, backend } = testRuntime();
    const napped: EventUnion[] = [];
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.napped", e => napped.push(e));
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const [before] = await rt.status.list();
    expect(before!.idleAt).toBeGreaterThan(Date.now());
    await until(async () => (await phaseOf(rt, ws.id)) === "napping", 2000);
    expect(napped).toHaveLength(1);
    expect(backend.machines[0]!.paused).toBe(true);
    const pushed = statuses.find(s => s.phase === "napping");
    expect(pushed).toMatchObject({ id: ws.id, machineState: "paused", reach: { state: "napping" } });
    expect(pushed!.reason).toMatch(/^idle /);
    expect(pushed!.idleAt).toBeUndefined();
    await sleep(WINDOW * 2);
    expect(napped).toHaveLength(1); // napping is not idle
  });

  it("names the window in minutes the way the rail will show it", async () => {
    const { rt } = testRuntime({ idle: { defaultWindowMs: 20 * 60_000 } });
    const statuses: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => statuses.push((e as { status: WorkspaceStatus }).status));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a", idleWindowMs: WINDOW });
    await until(async () => (await phaseOf(rt, ws.id)) === "napping", 2000);
    expect(statuses.at(-1)!.reason).toBe("idle 0 min");
    const [status] = await rt.status.list();
    expect(status!.idleAt).toBeUndefined();
  });

  it("workspaces.touch over the wire starts the window over", async () => {
    const { rt } = testRuntime();
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    for (let i = 0; i < 8; i++) {
      await sleep(WINDOW / 4);
      const res = await c.request("workspaces.touch", { workspaceId: ws.id });
      expect(res.ok).toBe(true);
    }
    expect(await phaseOf(rt, ws.id)).toBe("running");
    const [status] = await rt.status.list();
    expect(status!.idleAt! - Date.now()).toBeLessThanOrEqual(WINDOW);
    c.close();
    await until(async () => (await phaseOf(rt, ws.id)) === "napping", 2000);
    const missing = await rt.workspaces.touch("ws_nope").catch((e: Error) => e.message);
    expect(missing).toContain("no such workspace");
  });

  it("a running session holds the workspace awake; the window starts when it ends", async () => {
    const held = heldSession();
    const { rt } = testRuntime({ adapters: { claude: held.factory } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "go" });
    await sleep(WINDOW * 3);
    expect(await phaseOf(rt, ws.id)).toBe("running");
    const [active] = await rt.status.list();
    expect(active!.idleAt).toBeUndefined();
    held.end();
    await until(async () => (await phaseOf(rt, ws.id)) === "napping", 2000);
  });

  it("off means never; a per-workspace window beats the default", async () => {
    const { rt } = testRuntime({ idle: { defaultWindowMs: 60_000 } });
    const off = await rt.workspaces.create({ golden: "snap_g", name: "off", idleWindowMs: null });
    const fast = await rt.workspaces.create({ golden: "snap_g", name: "fast", idleWindowMs: WINDOW });
    await until(async () => (await phaseOf(rt, fast.id)) === "napping", 2000);
    await sleep(WINDOW * 2);
    expect(await phaseOf(rt, off.id)).toBe("running");
    const byName = new Map((await rt.status.list()).map(s => [s.name, s]));
    expect(byName.get("off")!.idleAt).toBeUndefined();
  });

  it("wake and upgrade start the window over; a rehydrated running workspace gets one too", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {}, idle: { defaultWindowMs: WINDOW } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await until(async () => (await phaseOf(rt, ws.id)) === "napping", 2000);
    await rt.workspaces.wake(ws.id);
    await until(async () => (await phaseOf(rt, ws.id)) === "napping", 2000);
    await rt.workspaces.upgrade(ws.id, { cpu: 4 });
    expect(await phaseOf(rt, ws.id)).toBe("running");
    await until(async () => (await phaseOf(rt, ws.id)) === "napping", 2000);
    await rt.workspaces.wake(ws.id);

    const rt2 = createRuntime({ backend, store, adapters: {}, idle: { defaultWindowMs: WINDOW } });
    expect(await phaseOf(rt2, ws.id)).toBe("running");
    await until(async () => (await phaseOf(rt2, ws.id)) === "napping", 2000);
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
