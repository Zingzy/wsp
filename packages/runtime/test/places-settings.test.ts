// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS_ON, foldThreads, placeSettingsLine, dayStart, spendCapRefusal, absentComputer, HERE_PLACE_ID, noSuchPlaceRefusal, type PlaceView, type TurnResult, TURN_WALL_MS, turnCutLine } from "@wsp/protocol";
import type { MachineExecOptions } from "../src/machine-exec.js";
import { createRuntime, wiredPlace, type HarnessAdapterFactory } from "../src/runtime.js";
import { newPlaceKeyPair } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn, fakeLocal } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { scriptGuest } from "./script-guest.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { HERE, report, wiring } from "./place-join.js";
import { ctx, sockets, serving, code, join, placesOf, saysItsFacts, LOGINS, PLACE_FACTS } from "./places-fixture.js";

describe("a place's cap and what runs there", () => {
  const capOf = async (c: WsClient, placeId: string, set: Record<string, number>): Promise<Record<string, unknown>> => c.request("places.set", { placeId, ...set });

  it("gives every row its cap: a joined computer the rule's off its shape, this computer the rule's off its own, a cloud 3 machines and $10 a day", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const joined = await join(hostKey, { code: await code(), report: report("spoo", { shape: { cpu: 2, memMb: 7885 } }) });
    sockets.push(joined.client.ws);
    const places = await placesOf();
    expect(places.find(p => p.id === HERE_PLACE_ID)).toMatchObject({ cap: { threads: 8 }, running: 0, mac: "mac-mini" });
    expect(places.find(p => p.id === joined.placeId)).toMatchObject({ cap: { threads: 4 }, running: 0 });
    expect(places.find(p => p.id === "solari")).toMatchObject({ cap: { machines: 3, spendPerDayUsd: 10 }, running: 0 });
  });

  it("sets one number and keeps the rest, answers the row with it, and stores only the numbers a person set", async () => {
    const { hostKey, store } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const joined = await join(hostKey, { code: await code(), report: report("spoo", { shape: { cpu: 2, memMb: 7885 } }) });
    sockets.push(joined.client.ws);
    const host = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    const machines = await capOf(host, "solari", { machines: 5 });
    expect(machines, String(machines["error"])).toMatchObject({ ok: true, place: { id: "solari", cap: { machines: 5, spendPerDayUsd: 10 } } });
    expect(await capOf(host, "solari", { spendPerDayUsd: 0 })).toMatchObject({ ok: true, place: { cap: { machines: 5, spendPerDayUsd: 0 } } });
    expect(await capOf(host, joined.placeId, { threads: 1 })).toMatchObject({ ok: true, place: { id: joined.placeId, cap: { threads: 1 }, running: 0 } });
    host.close();
    const places = await placesOf();
    expect(places.find(p => p.id === joined.placeId)!.cap).toEqual({ threads: 1 });
    expect(places.find(p => p.id === "solari")!.cap).toEqual({ machines: 5, spendPerDayUsd: 0 });
    expect(places.find(p => p.id === HERE_PLACE_ID)!.cap).toEqual({ threads: 8 });
    expect(await store.get("caps", "solari")).toEqual({ machines: 5, spendPerDayUsd: 0 });
    expect(await store.get("caps", joined.placeId)).toEqual({ threads: 1 });
    expect(await store.get("caps", HERE_PLACE_ID)).toBeUndefined();
  });

  it("tells every socket the row a set made, so a page another window holds open reads it at once", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const joined = await join(hostKey, { code: await code(), report: report("spoo", { shape: { cpu: 2, memMb: 7885 } }) });
    sockets.push(joined.client.ws);
    const watcher = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    expect((await watcher.request("events.subscribe")).ok).toBe(true);
    const host = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    const answered = (await capOf(host, joined.placeId, { threads: 1 })) as { place: PlaceView };
    await capOf(host, HERE_PLACE_ID, { threads: 2 });
    await until(() => watcher.events.filter(e => e.type === "place.changed").length === 2);
    const changed = watcher.events.filter(e => e.type === "place.changed").map(e => e["place"] as PlaceView);
    expect(changed[0]).toEqual(answered.place);
    expect(changed[1]).toMatchObject({ id: HERE_PLACE_ID, cap: { threads: 2 } });
    host.close();
    watcher.close();
  });

  it("says on every row its kind's default beside the cap and what the person set, and a reset takes a number back to the default", async () => {
    const { hostKey, store } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const joined = await join(hostKey, { code: await code(), report: report("spoo", { shape: { cpu: 4, memMb: 8192 } }) });
    sockets.push(joined.client.ws);
    const unset = (await placesOf()).find(p => p.id === joined.placeId)!;
    expect(unset).toMatchObject({ cap: { threads: 4 }, capDefault: { threads: 4 } });
    expect(unset.settings).toBeUndefined();
    const host = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    expect(await capOf(host, joined.placeId, { threads: 1 })).toMatchObject({ ok: true, place: { cap: { threads: 1 }, capDefault: { threads: 4 }, settings: { threads: 1 } } });
    expect(await capOf(host, "solari", { machines: 5, spendPerDayUsd: 2 })).toMatchObject({ ok: true, place: { cap: { machines: 5, spendPerDayUsd: 2 }, capDefault: { machines: 3, spendPerDayUsd: 10 } } });
    const back = (await host.request("places.set", { placeId: joined.placeId, reset: ["threads"] })) as { ok: boolean; place: PlaceView };
    expect(back).toMatchObject({ ok: true, place: { cap: { threads: 4 } } });
    expect(back.place.settings).toBeUndefined();
    expect(await host.request("places.set", { placeId: "solari", reset: ["spend"] })).toMatchObject({ ok: true, place: { cap: { machines: 5, spendPerDayUsd: 10 }, settings: { machines: 5 } } });
    expect(await host.request("places.set", { placeId: joined.placeId, threads: 2, reset: ["threads"] })).toMatchObject({ ok: false, kind: "usage", error: "spoo: threads at once is both set and reset; name it once" });
    host.close();
    expect(await store.get("caps", joined.placeId)).toBeUndefined();
    expect(await store.get("caps", "solari")).toEqual({ machines: 5 });
  });

  it("refuses a number the row's kind does not take, a place this host does not hold and a set with no number, as usage, and writes nothing", async () => {
    const { store } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const host = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    expect(await capOf(host, HERE_PLACE_ID, { machines: 2 })).toMatchObject({ ok: false, kind: "usage", error: `${HERE.name} takes threads at once, turn limit, agents may start agents and levels deep, not machines at once` });
    expect(await capOf(host, "solari", { threads: 2 })).toMatchObject({ ok: false, kind: "usage", error: "solari takes machines at once, spend per day, nap after, turn limit, agents may start agents and levels deep, not threads at once" });
    expect(await capOf(host, "p_nothing", { threads: 2 })).toMatchObject({ ok: false, kind: "usage", error: noSuchPlaceRefusal("p_nothing", [HERE.name, "solari"]) });
    expect(await capOf(host, "solari", {})).toMatchObject({ ok: false, kind: "usage", error: "nothing to set on solari: it takes machines at once, spend per day, nap after, turn limit, agents may start agents and levels deep" });
    host.close();
    expect(await store.keys("caps")).toEqual([]);
  });

  it("counts on a computer only the threads running there now, and on a cloud the machines holding a slot", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-caps-"));
    // Keyed by prompt: the three starts reach the harness in whatever order their launches finish.
    const ends = new Map<string, () => void>();
    const held: HarnessAdapterFactory = () => ({
      steers: false,
      start: ({ onEvent, prompt }) => {
        const sessionId = randomUUID();
        onEvent({ type: "session.start", sessionId });
        const result: TurnResult = { status: "completed", text: "ok" };
        const finished = new Promise<TurnResult>(done =>
          ends.set(prompt, () => {
            onEvent({ type: "turn.done", sessionId, result });
            onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
            done(result);
          }),
        );
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    try {
      const hostKey = newPlaceKeyPair();
      const backend = stubBackend();
      ctx.runtime = createRuntime({ backend, places: wiredPlace("solari", backend), store: memoryStore(), adapters: { claude: held }, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }), local: fakeLocal(root) });
      ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
      const mac = await createOn(ctx.runtime, { on: HERE_PLACE_ID, name: "mac" });
      const cloud = await createOn(ctx.runtime, { on: "solari", golden: "snap_g", name: "cloud" });
      const running = async (): Promise<Record<string, number | undefined>> => Object.fromEntries((await placesOf()).map(p => [p.id, p.running]));
      expect(await running()).toEqual({ [HERE_PLACE_ID]: 0, solari: 1 });
      const first = await ctx.runtime.sessions.start(mac.id, { prompt: "one" });
      await ctx.runtime.sessions.start(mac.id, { prompt: "two" });
      await ctx.runtime.sessions.start(cloud.id, { prompt: "three" });
      await until(() => ends.size === 3);
      // A thread on the cloud's machine is that machine's; the cloud counts machines, and this computer only its own threads.
      expect(await running()).toEqual({ [HERE_PLACE_ID]: 2, solari: 1 });
      ends.get("one")!();
      await first.finished;
      await until(async () => (await running())[HERE_PLACE_ID] === 1);
      ends.get("three")!();
      await until(async () => (await ctx.runtime!.sessions.list(cloud.id)).every(r => r.status !== "running"));
      // A napping machine holds no slot on its cloud.
      await ctx.runtime.workspaces.nap(cloud.id);
      expect((await running())["solari"]).toBe(0);
    } finally {
      for (const end of ends.values()) end();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a computer's threads at once", () => {
  /** A harness whose turns run until the test ends them, by prompt, and say each start they were handed. */
  const heldTurns = () => {
    const ends = new Map<string, () => void>();
    const adapter: HarnessAdapterFactory = () => ({
      steers: false,
      start: ({ onEvent, prompt }) => {
        const sessionId = randomUUID();
        onEvent({ type: "session.start", sessionId });
        const result: TurnResult = { status: "completed", text: "ok" };
        const finished = new Promise<TurnResult>(done =>
          ends.set(prompt, () => {
            onEvent({ type: "turn.done", sessionId, result });
            onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
            done(result);
          }),
        );
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    return { ends, adapter };
  };
  const onHere = async (root: string, adapter: HarnessAdapterFactory) => {
    const backend = stubBackend();
    ctx.runtime = createRuntime({ backend, places: wiredPlace("solari", backend), store: memoryStore(), adapters: { claude: adapter }, placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }), local: fakeLocal(root) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const host = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    const set = (threads: number) => host.request("places.set", { placeId: HERE_PLACE_ID, threads });
    return { mac: await createOn(ctx.runtime, { on: HERE_PLACE_ID, name: "mac" }), set, host };
  };
  const rowsOf = async (workspaceId: string) => ctx.runtime!.sessions.list(workspaceId);

  it("holds a thread past it, says so on its row and in its transcript, and starts it when a thread there ends", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-wait-"));
    const { ends, adapter } = heldTurns();
    try {
      const { mac, set, host } = await onHere(root, adapter);
      expect(await set(1)).toMatchObject({ ok: true });
      const first = await ctx.runtime!.sessions.start(mac.id, { prompt: "one" });
      const second = ctx.runtime!.sessions.start(mac.id, { prompt: "two", requestId: "req_2" });
      const wait = { placeId: HERE_PLACE_ID, place: HERE.name, running: 1, atOnce: 1 };
      await until(async () => (await rowsOf(mac.id)).some(r => r.capped !== undefined));
      const held = (await rowsOf(mac.id)).find(r => r.capped !== undefined)!;
      expect(held).toMatchObject({ status: "running", capped: wait });
      expect(foldThreads(await rowsOf(mac.id)).find(t => t.threadId === held.threadId)).toMatchObject({ capped: wait });
      expect([...ends.keys()]).toEqual(["one"]);
      // The computer runs one thread, the one the held thread waits on.
      expect((await placesOf()).find(p => p.id === HERE_PLACE_ID)).toMatchObject({ running: 1, cap: { threads: 1 } });
      const said = (await ctx.runtime!.sessions.history(mac.id)).filter(e => e.type === "session.capped");
      expect(said).toEqual([expect.objectContaining({ type: "session.capped", threadId: held.threadId, turnId: held.id, requestId: "req_2", ...wait })]);

      ends.get("one")!();
      await first.finished;
      const started = await second;
      await until(() => ends.has("two"));
      expect((await rowsOf(mac.id)).find(r => r.id === started.id)?.capped).toBeUndefined();
      expect((await placesOf()).find(p => p.id === HERE_PLACE_ID)).toMatchObject({ running: 1 });
      ends.get("two")!();
      await started.finished;
      host.close();
    } finally {
      for (const end of ends.values()) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts the threads it holds in the order they came the moment the person raises it, and a stopped one never starts", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-raise-"));
    const { ends, adapter } = heldTurns();
    try {
      const { mac, set, host } = await onHere(root, adapter);
      await set(1);
      await ctx.runtime!.sessions.start(mac.id, { prompt: "one" });
      const second = ctx.runtime!.sessions.start(mac.id, { prompt: "two" });
      await until(async () => (await rowsOf(mac.id)).filter(r => r.capped !== undefined).length === 1);
      const third = ctx.runtime!.sessions.start(mac.id, { prompt: "three" });
      const fourth = ctx.runtime!.sessions.start(mac.id, { prompt: "four" });
      await until(async () => (await rowsOf(mac.id)).filter(r => r.capped !== undefined).length === 3);
      const fourthRow = (await rowsOf(mac.id)).find(r => r.prompt === "four")!;
      expect(await ctx.runtime!.sessions.interrupt(fourthRow.id)).toEqual({ outcome: "accepted" });
      await expect(fourth).rejects.toThrow(`stopped before it started, while ${HERE.name} was running 1 of 1 thread`);
      expect((await rowsOf(mac.id)).some(r => r.prompt === "four")).toBe(false);

      // One more slot takes the thread that waited longest, and nothing that ended made room.
      await set(2);
      await second;
      await until(() => ends.has("two"));
      await new Promise(r => setTimeout(r, 50));
      expect([...ends.keys()]).toEqual(["one", "two"]);
      expect((await rowsOf(mac.id)).find(r => r.prompt === "three")).toMatchObject({ capped: { running: 2, atOnce: 2 } });
      await set(3);
      await third;
      await until(() => ends.has("three"));
      expect(ends.has("four")).toBe(false);
      host.close();
    } finally {
      for (const end of ends.values()) end();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a place's nap after", () => {
  const MIN = 60_000;

  it("arms a workspace with no window of its own off its place's nap, again from now once the nap changes, never once it is off, and leaves a workspace's own window standing", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-nap-"));
    try {
      const backend = stubBackend();
      const fc = fakeClock(Date.parse("2026-09-16T12:00:00.000Z"));
      ctx.runtime = createRuntime({ backend, places: wiredPlace("solari", backend), store: memoryStore(), adapters: {}, clock: fc.clock, idle: { defaultWindowMs: 60 * MIN }, placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }), local: fakeLocal(root) });
      ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
      const idleAt = async (id: string): Promise<number | undefined> => (await ctx.runtime!.status.list()).find(s => s.id === id)?.idleAt;
      const first = await createOn(ctx.runtime, { on: "solari", golden: "snap_g", name: "first" });
      const own = await createOn(ctx.runtime, { on: "solari", golden: "snap_g", name: "own", idleWindowMs: 30 * MIN });
      await until(async () => (await idleAt(first.id)) !== undefined);
      expect(await idleAt(first.id)).toBe(fc.clock.now() + 60 * MIN);
      const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
      expect((await placesOf()).find(p => p.id === "solari")).toMatchObject({ napMs: 60 * MIN, napDefault: 60 * MIN });
      fc.advance(MIN);
      const fiveMin = (await c.request("places.set", { placeId: "solari", napMs: 5 * MIN })) as { place: PlaceView };
      expect(fiveMin).toMatchObject({ ok: true, place: { napMs: 5 * MIN, napDefault: 60 * MIN, settings: { napMs: 5 * MIN } } });
      // The line says the default this host runs, which is the row's own.
      expect(placeSettingsLine(fiveMin.place)).toContain("naps after 5m (60m by default)");
      // A new window counts from when the person set it, on every workspace there that has none of its own.
      expect(await idleAt(first.id)).toBe(fc.clock.now() + 5 * MIN);
      expect(await idleAt(own.id)).toBe(Date.parse("2026-09-16T12:00:00.000Z") + 30 * MIN);
      // Another setting on the place leaves every window where it stands.
      fc.advance(MIN);
      expect(await c.request("places.set", { placeId: "solari", machines: 4 })).toMatchObject({ ok: true });
      expect(await idleAt(first.id)).toBe(fc.clock.now() + 4 * MIN);
      const second = await createOn(ctx.runtime, { on: "solari", golden: "snap_g", name: "second" });
      await until(async () => (await idleAt(second.id)) !== undefined);
      expect(await idleAt(second.id)).toBe(fc.clock.now() + 5 * MIN);
      expect(await c.request("places.set", { placeId: "solari", napMs: null })).toMatchObject({ ok: true, place: { napMs: null, settings: { napMs: null } } });
      expect(await idleAt(first.id)).toBeUndefined();
      expect(await c.request("places.set", { placeId: "solari", reset: ["nap"] })).toMatchObject({ ok: true, place: { napMs: 60 * MIN } });
      expect(await idleAt(first.id)).toBe(fc.clock.now() + 60 * MIN);
      c.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is refused on the computer the host runs on, whose workspaces are folders that never nap, and says nothing of it on that row", async () => {
    await serving();
    const host = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    expect(await host.request("places.set", { placeId: HERE_PLACE_ID, napMs: 5 * MIN })).toMatchObject({ ok: false, kind: "usage", error: `${HERE.name} takes threads at once, turn limit, agents may start agents and levels deep, not nap after` });
    expect(await host.request("places.set", { placeId: "p_1", napMs: 30_000 })).toMatchObject({ ok: false });
    host.close();
    expect((await placesOf()).find(p => p.id === HERE_PLACE_ID)!.napMs).toBeUndefined();
  });
});

/** A harness whose turn is one real run read through the factory its kind handed it, failing with what ended the
 * read, as the shipped adapters fail a turn whose stream the runtime cut. */
const busy: HarnessAdapterFactory = ctx => ({
  steers: false,
  start: ({ onEvent }) => {
    const sessionId = randomUUID();
    onEvent({ type: "session.start", sessionId });
    // It prints as it goes, so the idle cut never stands in for the limit under test.
    const stream = ctx.execStream("while :; do echo working; sleep 0.05; done", { env: { ...ctx.env } });
    const finished = (async (): Promise<TurnResult> => {
      const result: TurnResult = await (async () => {
        for await (const line of stream.lines) void line;
        return { status: "completed", text: "done" } as const;
      })().catch((e: unknown) => ({ status: "failed", error: e instanceof Error ? e.message : String(e) }) as const);
      onEvent({ type: "turn.done", sessionId, result });
      onEvent({ type: "session.end", sessionId, exitCode: await stream.exited, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => stream.kill() };
  },
});

describe("a place's turn limit", () => {
  const HOUR = 3_600_000;

  it("reads off on a computer the person owns and six hours on a cloud, and takes a set and a reset on either", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const joined = await join(hostKey, { code: await code() });
    const rows = async (): Promise<Record<string, Pick<PlaceView, "turnLimitMs" | "turnLimitDefault">>> =>
      Object.fromEntries((await placesOf()).map(p => [p.id, { turnLimitMs: p.turnLimitMs, turnLimitDefault: p.turnLimitDefault }]));
    expect(await rows()).toEqual({
      [HERE_PLACE_ID]: { turnLimitMs: null, turnLimitDefault: null },
      [joined.placeId]: { turnLimitMs: null, turnLimitDefault: null },
      solari: { turnLimitMs: TURN_WALL_MS, turnLimitDefault: TURN_WALL_MS },
    });
    const host = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    const here = (await host.request("places.set", { placeId: HERE_PLACE_ID, turnLimitMs: 2 * HOUR })) as { place: PlaceView };
    expect(here).toMatchObject({ ok: true, place: { turnLimitMs: 2 * HOUR, turnLimitDefault: null, settings: { turnLimitMs: 2 * HOUR } } });
    expect(placeSettingsLine(here.place)).toContain("stops a turn at 2h (off by default)");
    expect(await host.request("places.set", { placeId: "solari", turnLimitMs: null })).toMatchObject({ ok: true, place: { turnLimitMs: null, turnLimitDefault: TURN_WALL_MS, settings: { turnLimitMs: null } } });
    expect(await host.request("places.set", { placeId: joined.placeId, turnLimitMs: 30 * 60_000 })).toMatchObject({ ok: false });
    expect(await rows()).toMatchObject({ [HERE_PLACE_ID]: { turnLimitMs: 2 * HOUR }, [joined.placeId]: { turnLimitMs: null }, solari: { turnLimitMs: null } });
    expect(await host.request("places.set", { placeId: HERE_PLACE_ID, reset: ["turn-limit"] })).toMatchObject({ ok: true, place: { turnLimitMs: null } });
    expect(await host.request("places.set", { placeId: "solari", reset: ["turn-limit"] })).toMatchObject({ ok: true, place: { turnLimitMs: TURN_WALL_MS } });
    expect((await placesOf()).find(p => p.id === "solari")!.settings).toBeUndefined();
    host.close();
  });

  it("is what a turn's reader runs under, read at the turn's launch, and a turn it stops says so and how to go on", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-turn-limit-"));
    try {
      const handed: (MachineExecOptions | undefined)[] = [];
      // The clock the reader reads, moved past the limit once the turn is under way.
      let skew = 0;
      const local = fakeLocal(root);
      const backend = stubBackend();
      ctx.runtime = createRuntime({
        backend,
        places: wiredPlace("solari", backend),
        store: memoryStore(),
        adapters: { claude: busy },
        placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }),
        local: { ...local, execStream: (o, waiting) => (handed.push(o), local.execStream({ ...o, now: () => Date.now() + skew, pollMs: 20 }, waiting)) },
      });
      ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
      const mac = await createOn(ctx.runtime, { on: HERE_PLACE_ID, name: "mac" });
      // The exec verb's road hands its own limits, idle among them; every road through the turn's adapter hands only the wall.
      const turnOn = (): MachineExecOptions | undefined => [...handed].reverse().find(o => o !== undefined && o.idleMs === undefined);

      const off = await ctx.runtime.sessions.start(mac.id, { prompt: "one" });
      await until(() => turnOn() !== undefined);
      expect(turnOn()).toEqual({ deadlineMs: Number.POSITIVE_INFINITY });
      // A day on, a computer with no limit still has its turn running.
      skew = 24 * HOUR;
      await new Promise(done => setTimeout(done, 200));
      expect((await ctx.runtime.sessions.list(mac.id)).map(r => r.status)).toEqual(["running"]);
      await ctx.runtime.sessions.interrupt(off.id);
      await off.finished;
      skew = 0;

      const host = await WsClient.connect(ctx.srv.port, { token: "host-token" });
      expect(await host.request("places.set", { placeId: HERE_PLACE_ID, turnLimitMs: 2 * HOUR })).toMatchObject({ ok: true });
      host.close();
      handed.length = 0;
      const capped = await ctx.runtime.sessions.start(mac.id, { prompt: "two" });
      await until(() => turnOn() !== undefined);
      expect(turnOn()).toEqual({ deadlineMs: 2 * HOUR });
      skew = 2 * HOUR;
      const result = await capped.finished;
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/^stopped after 2h 00m \d\ds at the 2h turn limit; send to continue where it stopped, or change the limit in Settings > Computers$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("stops a turn on a cloud's machine at six hours until the person sets another, and never once it is off", async () => {
    let skew = 0;
    const backend = stubBackend();
    ctx.runtime = createRuntime({ backend, places: wiredPlace("solari", backend), store: memoryStore(), adapters: { claude: busy }, placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }), machineExec: { now: () => Date.now() + skew, pollMs: 5 } });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const cloud = await createOn(ctx.runtime, { on: "solari", golden: "snap_g", name: "cloud" });
    scriptGuest(backend, [], backend.execImpl);
    const capped = await ctx.runtime.sessions.start(cloud.id, { prompt: "one" });
    await until(async () => (await ctx.runtime!.sessions.history(cloud.id)).some(e => e.type === "session.start"));
    skew = TURN_WALL_MS;
    expect(await capped.finished).toEqual({ status: "failed", error: turnCutLine("wall", TURN_WALL_MS, TURN_WALL_MS) });

    skew = 0;
    const host = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    expect(await host.request("places.set", { placeId: "solari", turnLimitMs: null })).toMatchObject({ ok: true });
    host.close();
    const guest = scriptGuest(backend, [], backend.execImpl);
    const open = await ctx.runtime.sessions.start(cloud.id, { prompt: "two" });
    await until(async () => (await ctx.runtime!.sessions.history(cloud.id)).filter(e => e.type === "session.start").length === 2);
    // A day on, in the same poll that brings the turn's next line, so only the limit could stop it.
    const answer = backend.execImpl;
    backend.execImpl = async (m, cmd) => {
      if (skew === 0 && cmd.includes("__WSP_EOF_")) {
        skew = 24 * HOUR;
        guest.append("working\n");
      }
      return answer(m, cmd);
    };
    await until(() => skew > 0);
    await new Promise(done => setTimeout(done, 200));
    expect((await ctx.runtime.sessions.list(cloud.id)).map(r => r.status)).toEqual(["failed", "running"]);
    await ctx.runtime.sessions.interrupt(open.id);
    await open.finished;
  }, 20_000);
});

describe("whether agents may start agents, as a place's default", () => {
  it("gives a workspace with no switch of its own its place's, keeps one a workspace was given, and patches a workspace's switch over the one it inherits", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-spawn-place-"));
    try {
      const backend = stubBackend();
      ctx.runtime = createRuntime({ backend, places: wiredPlace("solari", backend), store: memoryStore(), adapters: {}, placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }), local: fakeLocal(root) });
      ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
      const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
      expect((await placesOf()).find(p => p.id === "solari")).toMatchObject({ spawn: AGENTS_ON, spawnDefault: AGENTS_ON });
      const before = await createOn(ctx.runtime, { on: "solari", golden: "snap_g", name: "before" });
      expect(await c.request("places.set", { placeId: "solari", spawn: { spawn: false } })).toMatchObject({ ok: true, place: { spawn: { ...AGENTS_ON, spawn: false }, settings: { spawn: { spawn: false } } } });
      expect(await c.request("places.set", { placeId: HERE_PLACE_ID, spawn: { maxMachines: 1 } })).toMatchObject({ ok: true, place: { spawn: { ...AGENTS_ON, maxMachines: 1 } } });
      // Read at every ask rather than copied at the create, so a workspace made before the change follows it.
      expect((await ctx.runtime.workspaces.get(before.id)).agents).toEqual({ ...AGENTS_ON, spawn: false });
      const after = await createOn(ctx.runtime, { on: "solari", golden: "snap_g", name: "after" });
      expect((await ctx.runtime.workspaces.get(after.id)).agents).toEqual({ ...AGENTS_ON, spawn: false });
      const own = await createOn(ctx.runtime, { on: "solari", golden: "snap_g", name: "own", agents: { maxDepth: 3 } });
      expect((await ctx.runtime.workspaces.get(own.id)).agents).toEqual({ ...AGENTS_ON, spawn: false, maxDepth: 3 });
      const mac = await createOn(ctx.runtime, { on: HERE_PLACE_ID, name: "mac" });
      expect((await ctx.runtime.workspaces.get(mac.id)).agents).toEqual({ ...AGENTS_ON, maxMachines: 1 });
      // A cap named alone on a workspace tightens the switch it reads as, which is its place's.
      expect((await ctx.runtime.workspaces.agents(after.id, { maxMachines: 2 })).agents).toEqual({ spawn: false, maxMachines: 2, maxDepth: 2 });
      expect(await c.request("places.set", { placeId: "solari", reset: ["spawn"] })).toMatchObject({ ok: true, place: { spawn: AGENTS_ON } });
      expect((await ctx.runtime.workspaces.get(before.id)).agents).toEqual(AGENTS_ON);
      c.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores only the parts a person set, so a switch turned off and on again follows a later default, and levels deep resets alone", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-spawn-parts-"));
    const shipped = AGENTS_ON.maxDepth;
    try {
      ctx.runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, placeLinks: wiring(newPlaceKeyPair()), local: fakeLocal(root) });
      ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
      const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
      await c.request("places.set", { placeId: HERE_PLACE_ID, spawn: { spawn: false } });
      const back = (await c.request("places.set", { placeId: HERE_PLACE_ID, spawn: { spawn: true } })) as { place: PlaceView };
      expect(back.place.settings).toEqual({ spawn: { spawn: true } });
      const mac = await createOn(ctx.runtime, { on: HERE_PLACE_ID, name: "mac" });
      // The default moves under a computer that toggled, and both its row and its workspace read the new one.
      (AGENTS_ON as { maxDepth: number }).maxDepth = shipped + 3;
      expect((await placesOf()).find(p => p.id === HERE_PLACE_ID)!.spawn?.maxDepth).toBe(shipped + 3);
      expect((await ctx.runtime.workspaces.get(mac.id)).agents?.maxDepth).toBe(shipped + 3);
      (AGENTS_ON as { maxDepth: number }).maxDepth = shipped;
      // A depth set and taken back leaves the rest of the switch as the person set it.
      expect(await c.request("places.set", { placeId: HERE_PLACE_ID, spawn: { maxDepth: 4 } })).toMatchObject({ place: { settings: { spawn: { spawn: true, maxDepth: 4 } }, spawn: { maxDepth: 4 } } });
      const reset = (await c.request("places.set", { placeId: HERE_PLACE_ID, reset: ["max-depth"] })) as { place: PlaceView };
      expect(reset.place.settings).toEqual({ spawn: { spawn: true } });
      expect(reset.place.spawn).toEqual(AGENTS_ON);
      expect((await c.request("places.set", { placeId: HERE_PLACE_ID, reset: ["spawn"] })) as { place: PlaceView }).not.toHaveProperty("place.settings");
      c.close();
    } finally {
      (AGENTS_ON as { maxDepth: number }).maxDepth = shipped;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a cloud's spend per day", () => {
  const HOUR = 3_600_000;

  it("refuses a new machine on a cloud once its spend today reaches its spend per day, passes one under it, and leaves the running ones and this computer's copies alone", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-spend-cap-"));
    try {
      const backend = stubBackend();
      // An hour into a local day, so the hours below all fall in it whatever zone this runs in.
      const fc = fakeClock(dayStart(Date.parse("2026-09-16T12:00:00.000Z")) + HOUR);
      ctx.runtime = createRuntime({ backend, places: wiredPlace("solari", backend), store: memoryStore(), adapters: {}, clock: fc.clock, idle: { defaultWindowMs: 24 * HOUR }, placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }), local: fakeLocal(root) });
      ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
      const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
      expect(await c.request("places.set", { placeId: "solari", spendPerDayUsd: 0.2 })).toMatchObject({ ok: true });
      c.close();
      const opened = async (name: string) => {
        const made = await createOn(ctx.runtime!, { on: "solari", golden: "snap_g", name });
        await until(async () => (await ctx.runtime!.status.history(made.id)).length === 1);
        return made;
      };

      const first = await opened("first");
      fc.advance(HOUR);
      // An hour at $0.11 is under $0.20.
      const second = await opened("second");
      fc.advance(HOUR / 2);
      // An hour and a half of the first and half an hour of the second is $0.22.
      await expect(createOn(ctx.runtime, { on: "solari", golden: "snap_g", name: "third" })).rejects.toThrow(spendCapRefusal("solari", 0.22, 0.2));
      const phases = Object.fromEntries((await ctx.runtime.workspaces.list()).map(w => [w.id, w.phase]));
      expect(phases).toEqual({ [first.id]: "running", [second.id]: "running" });
      // A copy on this computer costs nothing, so no cloud's spend refuses it.
      await expect(createOn(ctx.runtime, { on: HERE_PLACE_ID, name: "mac" })).resolves.toMatchObject({ name: "mac" });
      // A higher spend per day lets the next machine through the same day.
      const again = await WsClient.connect(ctx.srv.port, { token: "host-token" });
      expect(await again.request("places.set", { placeId: "solari", spendPerDayUsd: 1 })).toMatchObject({ ok: true });
      again.close();
      await expect(createOn(ctx.runtime, { on: "solari", golden: "snap_g", name: "third" })).resolves.toMatchObject({ name: "third" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("spending a banked reset on a computer you joined", () => {
  const answer = (id: number, result: Record<string, unknown>): string => JSON.stringify({ id, result });
  const limits = (used: number, availableCount: number) => ({
    rateLimits: { limitId: "codex", primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1_790_700_000 }, planType: "plus" },
    accountId: "acct_a",
    rateLimitResetCredits: { availableCount, credits: [] },
  });
  const READ = [answer(1, {}), answer(2, { account: { type: "chatgpt", email: "a@example.com", planType: "plus" } }), answer(3, limits(100, 2))];
  const SPEND = [answer(1, {}), answer(4, { outcome: "reset" }), answer(3, limits(0, 1))];
  const signedIn = report("srv", { agents: ["codex"], logins: ["codex/auth.json"], login: { HOME: "/home/maya", USER: "maya", PATH: "/opt/codex/bin:/usr/bin" } });

  /** A joined computer holding a Codex login, answering each reset script it is asked to run, and the account a turn
   * there read before. */
  async function holding(): Promise<{ client: WsClient; placeId: string; ran: string[]; inputs: string[] }> {
    const store = memoryStore();
    const { hostKey } = await serving({ store });
    const ran: string[] = [];
    const inputs: string[] = [];
    const answers = (c: WsClient): void => {
      saysItsFacts(() => ({ ...PLACE_FACTS, logins: LOGINS }), { count: 0 })(c);
      c.onFrame(raw => {
        const frame = raw as unknown as { id?: number; op?: string; cmd?: string; stdin?: string };
        if (frame.op !== "exec" || !String(frame.cmd).includes("app-server")) return;
        ran.push(String(frame.cmd));
        inputs.push(Buffer.from(frame.stdin ?? "", "base64").toString("utf8"));
        c.say({ id: frame.id, ok: true, exitCode: 0, stderr: "", stdout: (String(frame.cmd).includes("rateLimitResetCredit/consume") ? SPEND : READ).join("\n") });
      });
    };
    const { client, placeId } = await join(hostKey, { code: await code(), report: signedIn, answers });
    sockets.push(client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)?.logins === LOGINS);
    await store.put("limits", "codex:acct_a", { key: "codex:acct_a", agent: "codex", label: "a@example.com", road: "named", plan: "plus", windows: [{ kind: "session", usedPercent: 100 }], readAt: Date.now(), computers: [placeId] });
    return { client, placeId, ran, inputs };
  }

  it("reads the account and then spends on that computer, under the login its workspaces share and the PATH it reported", async () => {
    const { ran, inputs } = await holding();
    expect(await ctx.runtime!.usage.reset({ account: "codex:acct_a" })).toMatchObject({ outcome: "reset", said: "Reset used: Codex with ChatGPT Plus on srv's windows start again now, 1 left", account: { key: "codex:acct_a", credits: { count: 1 } } });
    expect(ran).toHaveLength(2);
    for (const cmd of ran) expect(cmd).toContain(`CODEX_HOME='${LOGINS}/codex'`);
    // The PATH it reported rides each script's input with the rest of the launch variables, never its text.
    for (const input of inputs) expect(input.split("\0")).toContain("PATH=/opt/codex/bin:/usr/bin");
    expect(ran[0]).not.toContain("rateLimitResetCredit/consume");
    expect(ran[1]).toContain("rateLimitResetCredit/consume");
  });

  it("is refused in that computer's own words once it is away, with nothing run", async () => {
    const { client, placeId, ran } = await holding();
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    await expect(ctx.runtime!.usage.reset({ account: "codex:acct_a" })).rejects.toThrow(absentComputer("srv", null).sentence);
    expect(ran).toEqual([]);
  });
});
