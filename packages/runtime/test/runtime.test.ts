import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { gunzipSync } from "node:zlib";
import type { AdapterEvent, TurnResult } from "@wsp/adapter-claude";
import { SessionEvent, type EventUnion } from "@wsp/protocol";
import { BUILDER_IDLE_MS, type GoldenImport } from "@wsp/engine";
import { TRANSCRIPT_FLUSH_MS, createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { wsRequest } from "./ws-client.js";
import { stubBackend } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";

describe("runtime", () => {
  it("creates a workspace from a golden manifest and emits protocol events", async () => {
    const events: string[] = [];
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    rt.events.on("*", e => events.push(e.type));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    expect(ws.id).toBeTruthy();
    expect(events).toContain("workspace.created");
    await rt.workspaces.nap(ws.id);
    expect(events).toContain("workspace.napped");
  });

  it("same behavior over the wire: serveRuntime round-trips create via WS", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const res = await wsRequest(srv.port, "t", { op: "workspaces.create", golden: "snap_g", name: "x" });
    expect(res["ok"]).toBe(true);
    await srv.close();
  });

  it("wake after the paused machine vanished resurrects a fresh golden fork", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x", envs: { FOO: "1" } });
    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true; // paused machine vanished overnight
    const woken = await rt.workspaces.wake(ws.id);
    expect(woken.machineId).toBe("m2");
    expect(backend.machines[1]!.spec.fromSnapshot).toBe("snap_g");
    expect(backend.machines[1]!.spec.envs).toEqual({ FOO: "1" });
    const wokeEvent = events.find(e => e.type === "workspace.woken");
    expect(wokeEvent).toMatchObject({ machineId: "m2", resurrected: true });
  });

  it("persists workspaces in the store and rehydrates them (phase survives)", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "x" });
    await rt1.workspaces.nap(ws.id);

    const rt2 = createRuntime({ backend, store, adapters: {} });
    const listed = await rt2.workspaces.list();
    expect(listed.map(w => w.id)).toContain(ws.id);
    expect(listed.find(w => w.id === ws.id)?.phase).toBe("napping");
    const woken = await rt2.workspaces.wake(ws.id); // must resume, not no-op
    expect(woken.phase).toBe("running");
    expect(backend.machines[0]!.paused).toBe(false);
  });

  it("runs a harness session and fans adapter events out as session.* protocol events", async () => {
    const backend = stubBackend();
    const scripted: HarnessAdapterFactory = () => ({
      start: ({ onEvent }) => {
        const sessionId = "11111111-1111-4111-8111-111111111111";
        const result: TurnResult = { status: "completed", text: "done" };
        const finished = (async () => {
          const feed: AdapterEvent[] = [
            { type: "session.start", sessionId, model: "claude-sonnet-4-5" },
            { type: "turn.delta", sessionId, kind: "text", text: "hi" },
            { type: "turn.done", sessionId, result },
            { type: "session.end", sessionId, exitCode: 0, sawResult: true },
          ];
          for (const e of feed) onEvent(e);
          return result;
        })();
        return { localId: sessionId, claudeSessionId: sessionId, finished, interrupt: async () => {} };
      },
    });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: scripted } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    const session = await rt.sessions.start(ws.id, { prompt: "say hi" });
    const result = await session.finished;
    expect(result.status).toBe("completed");
    const types = events.map(e => e.type);
    expect(types).toContain("session.start");
    expect(types).toContain("session.delta");
    expect(types).toContain("session.done");
    expect(types).toContain("session.end");
    for (const e of events) {
      if (e.type.startsWith("session.")) expect((e as { workspaceId: string }).workspaceId).toBe(ws.id);
    }
    expect(rt.sessions.list()[0]?.status).toBe("completed");
    // the workspace remembers the claude session id so later sends can --resume it
    expect((await rt.workspaces.get(ws.id)).claudeSessionId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("delete kills the machine and reap sweeps only unclaimed wsp machines", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    // a stray wsp-labeled machine nothing claims, old enough to reap
    await backend.create({
      kind: "sandbox",
      labels: { wsp: "1", createdAt: new Date(Date.now() - 3_600_000).toISOString() },
    });
    expect(await rt.reap()).toEqual({ reaped: [expect.objectContaining({ id: "m2", builder: false, reason: "orphan" })], spared: [] });
    expect(backend.machines[0]!.killed).toBe(false);
    await rt.workspaces.delete(ws.id);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
  });
});

describe("runtime session history", () => {
  const scripted = (text: string): HarnessAdapterFactory => () => ({
    start: ({ onEvent }) => {
      const sessionId = "22222222-2222-4222-8222-222222222222";
      const result: TurnResult = { status: "completed", text };
      const finished = (async () => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId, model: "claude-sonnet-4-5" },
          { type: "turn.delta", sessionId, kind: "text", text },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) onEvent(e);
        return result;
      })();
      return { localId: sessionId, claudeSessionId: sessionId, finished, interrupt: async () => {} };
    },
  });

  it("replays a workspace's session events with the prompt on session.start, surviving a restart", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: scripted("hello") } });
    const a = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const b = await rt.workspaces.create({ golden: "snap_g", name: "b" });
    await (await rt.sessions.start(a.id, { prompt: "say hello" })).finished;

    const history = await rt.sessions.history(a.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end"]);
    expect(history[0]).toMatchObject({ type: "session.start", workspaceId: a.id, prompt: "say hello" });
    expect(await rt.sessions.history(b.id)).toEqual([]);

    // a fresh runtime over the same store still has it; deleting the workspace drops it
    const rt2 = createRuntime({ backend, store, adapters: {} });
    expect(await rt2.sessions.history(a.id)).toEqual(history);
    await rt2.workspaces.delete(a.id);
    await expect(rt2.sessions.history(a.id)).rejects.toThrow("no such workspace");
    expect(await store.list("transcripts")).toEqual([]);
  });

  /** An adapter the test drives by hand, so turn boundaries can arrive without a session.end behind them. */
  const manual = () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    let onEvent: ((e: AdapterEvent) => void) | undefined;
    let finish!: (r: TurnResult) => void;
    const finished = new Promise<TurnResult>(r => (finish = r));
    const adapter: HarnessAdapterFactory = () => ({
      start: o => {
        onEvent = o.onEvent;
        return { localId: sessionId, claudeSessionId: sessionId, finished, interrupt: async () => {} };
      },
    });
    return {
      adapter,
      start: () => onEvent!({ type: "session.start", sessionId, model: "claude-sonnet-4-5" }),
      done: (text: string) => onEvent!({ type: "turn.done", sessionId, result: { status: "completed", text } }),
      end: () => {
        onEvent!({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        finish({ status: "completed", text: "" });
      },
    };
  };

  it("stamps at and one turnId per start on every session event, and forwards the adapter's harness", async () => {
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const harness = { slashCommands: ["compact"], permissionMode: "bypassPermissions", agents: ["general-purpose"] };
    const scripted: HarnessAdapterFactory = () => ({
      start: o => {
        const result: TurnResult = { status: "completed", text: "ok" };
        const finished = Promise.resolve().then(() => {
          o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", harness });
          o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: "ok" });
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return result;
        });
        return { localId: sessionId, claudeSessionId: sessionId, finished, interrupt: async () => {} };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: scripted } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const before = Date.now();
    await (await rt.sessions.start(ws.id, { prompt: "first" })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "second", resume: sessionId })).finished;
    const after = Date.now();

    const history = await rt.sessions.history(ws.id);
    expect(history).toHaveLength(8);
    for (const e of history) {
      expect(e.at).toBeGreaterThanOrEqual(before);
      expect(e.at).toBeLessThanOrEqual(after);
      expect(e.turnId).toMatch(/^[0-9a-f-]{36}$/);
    }
    const turnIds = new Set(history.map(e => e.turnId));
    expect(turnIds.size).toBe(2);
    expect(new Set(history.slice(0, 4).map(e => e.turnId)).size).toBe(1);
    expect(new Set(history.slice(4).map(e => e.turnId)).size).toBe(1);
    expect(history[0]).toMatchObject({ type: "session.start", harness });
    await rt.close();
  });

  /** Emits one full turn per start, under the resume id when given, else a fresh id; `rekey` makes a resumed
   * start announce a different id in system/init, as the CLI is allowed to. */
  const threaded = (rekey?: (resume: string) => string): HarnessAdapterFactory => () => ({
    start: o => {
      const localId = o.resume ?? randomUUID();
      const sessionId = o.resume !== undefined && rekey !== undefined ? rekey(o.resume) : localId;
      const result: TurnResult = { status: "completed", text: o.prompt };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: o.prompt });
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId, claudeSessionId: sessionId, finished, interrupt: async () => {} };
    },
  });
  /** Counts runs of one threadId in wire order. Enough here, where turns never overlap; a consumer folding a
   * transcript keeps the events whose threadId equals the last event's, which also holds when turns interleave. */
  const threads = (events: ReadonlyArray<{ threadId?: string }>): number =>
    events.reduce((n, e, i) => (i === 0 || e.threadId !== events[i - 1]!.threadId ? n + 1 : n), 0);
  const UUID = /^[0-9a-f-]{36}$/;

  it("stamps a threadId that resume keeps and a start without resume replaces, so two threads replay as two", async () => {
    const live: EventUnion[] = [];
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: threaded() } });
    rt.events.on("*", e => live.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "first" })).finished;
    const resume = (await rt.workspaces.get(ws.id)).claudeSessionId!;
    await (await rt.sessions.start(ws.id, { prompt: "second", resume })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "third" })).finished;

    const history = await rt.sessions.history(ws.id);
    expect(history).toHaveLength(12);
    for (const e of history) expect(e.threadId).toMatch(UUID);
    expect(new Set(history.slice(0, 8).map(e => e.threadId)).size).toBe(1);
    expect(new Set(history.slice(8).map(e => e.threadId)).size).toBe(1);
    expect(history[8]!.threadId).not.toBe(history[0]!.threadId);
    expect(threads(history)).toBe(2);
    expect(live.flatMap(e => ("threadId" in e ? [e.threadId] : []))).toEqual(history.map(e => e.threadId));
    await rt.close();
  });

  it("a resumed start joins the thread of the session it resumes, across a CLI re-key; an unknown resume id starts a new one", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: threaded(id => `${id.slice(0, 8)}-rekeyed`) } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "first" })).finished;
    const first = (await rt.workspaces.get(ws.id)).claudeSessionId!;
    await (await rt.sessions.start(ws.id, { prompt: "second", resume: first })).finished;
    const rekeyed = (await rt.workspaces.get(ws.id)).claudeSessionId!;
    expect(rekeyed).not.toBe(first);
    await (await rt.sessions.start(ws.id, { prompt: "third", resume: rekeyed })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "fourth", resume: "never-started" })).finished;

    const history = await rt.sessions.history(ws.id);
    expect(history).toHaveLength(16);
    expect(new Set(history.slice(0, 12).map(e => e.threadId)).size).toBe(1);
    expect(history[12]!.threadId).toMatch(UUID);
    expect(threads(history)).toBe(2);
    await rt.close();
  });

  it("a transcript written before threads existed replays as one thread, and a resume into it stamps it in place", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const setup = createRuntime({ backend, store, adapters: {} });
    const a = await setup.workspaces.create({ golden: "snap_g", name: "a" });
    const b = await setup.workspaces.create({ golden: "snap_g", name: "b" });
    await setup.close();
    const legacy = (workspaceId: string, sessionId: string) => [
      { type: "session.start", workspaceId, sessionId, prompt: "old" },
      { type: "session.delta", workspaceId, sessionId, kind: "text", text: "old answer" },
      { type: "session.done", workspaceId, sessionId, result: { status: "completed", text: "old answer" } },
      { type: "session.end", workspaceId, sessionId, exitCode: 0, sawResult: true },
    ];
    await store.put("transcripts", a.id, { workspaceId: a.id, events: legacy(a.id, "old-a") });
    await store.put("transcripts", b.id, { workspaceId: b.id, events: legacy(b.id, "old-b") });

    const rt = createRuntime({ backend, store, adapters: { claude: threaded() } });
    for (const id of [a.id, b.id]) {
      const old = await rt.sessions.history(id);
      expect(old).toHaveLength(4);
      for (const e of old) {
        expect(SessionEvent.parse(e)).toEqual(e);
        expect(e.threadId).toBeUndefined();
      }
      expect(threads(old)).toBe(1);
    }

    // continuing the old conversation: the old events take the new thread's id, in memory and in the store
    await (await rt.sessions.start(a.id, { prompt: "more", resume: "old-a" })).finished;
    const continued = await rt.sessions.history(a.id);
    expect(continued).toHaveLength(8);
    expect(new Set(continued.map(e => e.threadId)).size).toBe(1);
    expect(continued[0]!.threadId).toMatch(UUID);
    expect(threads(continued)).toBe(1);
    // a new thread: the old events stay as they were and fold as the thread before it
    await (await rt.sessions.start(b.id, { prompt: "fresh" })).finished;
    const split = await rt.sessions.history(b.id);
    expect(split.slice(0, 4).map(e => e.threadId)).toEqual([undefined, undefined, undefined, undefined]);
    expect(new Set(split.slice(4).map(e => e.threadId)).size).toBe(1);
    expect(threads(split)).toBe(2);
    await rt.close();
    const storedA = (await store.get("transcripts", a.id)) as { events: { threadId?: string }[] };
    expect(storedA.events.map(e => e.threadId)).toEqual(continued.map(e => e.threadId));
  });

  it("a resume whose session.start fell off the cap opens a new thread; the surviving head keeps its own id", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const setup = createRuntime({ backend, store, adapters: {} });
    const ws = await setup.workspaces.create({ golden: "snap_g", name: "a" });
    await setup.close();
    const scope = { workspaceId: ws.id, sessionId: "X", turnId: "turn_x", threadId: "T" };
    await store.put("transcripts", ws.id, {
      workspaceId: ws.id,
      events: [
        { type: "session.delta", ...scope, kind: "text", text: "tail of an old answer" },
        { type: "session.done", ...scope, result: { status: "completed" } },
        { type: "session.end", ...scope, exitCode: 0, sawResult: true },
      ],
    });

    const rt = createRuntime({ backend, store, adapters: { claude: threaded() } });
    await (await rt.sessions.start(ws.id, { prompt: "more", resume: "X" })).finished;
    const history = await rt.sessions.history(ws.id);
    expect(history.slice(0, 3).map(e => e.threadId)).toEqual(["T", "T", "T"]);
    expect(new Set(history.slice(3).map(e => e.threadId)).size).toBe(1);
    expect(history[3]!.threadId).toMatch(UUID);
    expect(threads(history)).toBe(2);
    await rt.close();
  });

  it("sessions.history hands out copies, so an earlier result does not change when a legacy transcript is stamped", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const setup = createRuntime({ backend, store, adapters: {} });
    const ws = await setup.workspaces.create({ golden: "snap_g", name: "a" });
    await setup.close();
    await store.put("transcripts", ws.id, {
      workspaceId: ws.id,
      events: [{ type: "session.start", workspaceId: ws.id, sessionId: "old", prompt: "old" }],
    });
    const rt = createRuntime({ backend, store, adapters: { claude: threaded() } });
    const earlier = await rt.sessions.history(ws.id);
    await (await rt.sessions.start(ws.id, { prompt: "more", resume: "old" })).finished;
    expect(earlier).toEqual([{ type: "session.start", workspaceId: ws.id, sessionId: "old", prompt: "old" }]);
    expect((await rt.sessions.history(ws.id))[0]!.threadId).toMatch(UUID);
    await rt.close();
  });

  it("sessions.history over the socket carries the threadId", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: threaded() } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "first" })).finished;
    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const res = await wsRequest(srv.port, "t", { op: "sessions.history", workspaceId: ws.id });
    const events = res["events"] as { type: string; threadId?: string }[];
    expect(events.map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end"]);
    for (const e of events) expect(e.threadId).toMatch(UUID);
    expect(events.map(e => e.threadId)).toEqual((await rt.sessions.history(ws.id)).map(e => e.threadId));
    await srv.close();
    await rt.close();
  });

  it("SessionView carries the prompt, when it started and when it ended", async () => {
    const m = manual();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: m.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const before = Date.now();
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    m.start();
    const running = handle.view();
    expect(running.prompt).toBe("go");
    expect(running.startedAt).toBeGreaterThanOrEqual(before);
    expect(running.startedAt).toBeLessThanOrEqual(Date.now());
    expect(running.endedAt).toBeUndefined();

    m.done("done");
    m.end();
    await handle.finished;
    const ended = rt.sessions.list(ws.id)[0]!;
    expect(ended.endedAt).toBeGreaterThanOrEqual(ended.startedAt!);
    expect(ended.endedAt).toBeLessThanOrEqual(Date.now());
    expect(ended.prompt).toBe("go");
    await rt.close();
  });

  /** memoryStore that counts transcript puts and can hold the first one open until the test lets go. */
  const countingStore = () => {
    const inner = memoryStore();
    let puts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(r => (release = r));
    let holdFirst = false;
    const store = {
      ...inner,
      put: async (collection: string, id: string, value: unknown) => {
        if (collection === "transcripts" && puts++ === 0 && holdFirst) await gate;
        await inner.put(collection, id, value);
      },
    };
    const stored = async (id: string) => ((await inner.get("transcripts", id)) as { events: { type: string; prompt?: string }[] } | undefined)?.events ?? [];
    return { store, stored, puts: () => puts, holdFirstPut: () => (holdFirst = true), releaseFirstPut: () => release!() };
  };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const until = async (cond: () => Promise<boolean>, ms: number) => {
    const deadline = Date.now() + ms;
    while (!(await cond()) && Date.now() < deadline) await sleep(5);
    return cond();
  };

  it("coalesces a burst of turn boundaries into one put after the debounce instead of one per event", async () => {
    const { store, stored, puts } = countingStore();
    const m = manual();
    const fc = fakeClock();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: m.adapter }, clock: fc.clock });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "go" });
    m.start();
    for (let i = 0; i < 20; i++) m.done(`t${i}`);
    fc.advance(TRANSCRIPT_FLUSH_MS - 1);
    expect(puts()).toBe(0);
    fc.advance(1);
    expect(await until(async () => puts() === 1, 1000)).toBe(true);
    expect((await stored(ws.id)).length).toBe(21);
    fc.advance(TRANSCRIPT_FLUSH_MS * 2);
    expect(puts()).toBe(1);
    m.end();
    await rt.close();
  });

  it("session.end lands in the store at once, without waiting out the debounce", async () => {
    const { store, stored, puts } = countingStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: scripted("x") } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "go" })).finished;
    expect(await until(async () => (await stored(ws.id)).length === 4, 100)).toBe(true);
    expect((await stored(ws.id)).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end"]);
    expect(puts()).toBe(1);
  });

  it("a pending debounce holds the process open until it flushes; the idle window does not", async () => {
    const { store, puts } = countingStore();
    const m = manual();
    const fc = fakeClock();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: m.adapter }, clock: fc.clock });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    expect(fc.pending()).toBe(1);
    expect(fc.holding()).toBe(0);
    await rt.sessions.start(ws.id, { prompt: "go" });
    m.start();
    m.done("t0");
    expect(fc.pending()).toBe(2);
    expect(fc.holding()).toBe(1);
    fc.advance(TRANSCRIPT_FLUSH_MS);
    expect(await until(async () => puts() === 1, 1000)).toBe(true);
    expect(fc.holding()).toBe(0);
    m.end();
    await rt.close();
  });

  it("close() writes what is still waiting on the debounce and leaves no timer behind", async () => {
    const { store, stored, puts } = countingStore();
    const m = manual();
    const fc = fakeClock();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: m.adapter }, clock: fc.clock });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "go" });
    m.start();
    m.done("t0");
    await rt.close();
    expect(puts()).toBe(1);
    expect((await stored(ws.id)).map(e => e.type)).toEqual(["session.start", "session.done"]);
    expect(fc.pending()).toBe(0);
    fc.advance(TRANSCRIPT_FLUSH_MS * 2);
    expect(puts()).toBe(1);
  });

  it("persists flushes in order even when an earlier put finishes last", async () => {
    const { store, stored, puts, holdFirstPut, releaseFirstPut } = countingStore();
    holdFirstPut();
    const m = manual();
    const fc = fakeClock();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: m.adapter }, clock: fc.clock });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "go" });
    m.start();
    m.done("t0");
    // the debounce fires and the first put stalls in the store; the end flush queues behind it
    fc.advance(TRANSCRIPT_FLUSH_MS);
    expect(await until(async () => puts() === 1, 1000)).toBe(true);
    m.end();
    await new Promise(r => setImmediate(r));
    expect(await stored(ws.id)).toEqual([]);
    releaseFirstPut();
    await rt.close();
    expect((await stored(ws.id)).map(e => e.type)).toEqual(["session.start", "session.done", "session.end"]);
  });

  it("caps the persisted transcript so a chatty workspace cannot grow the store without bound", { timeout: 20_000 }, async () => {
    const { store, stored } = countingStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: scripted("x") } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    for (let i = 0; i < 1300; i++) await (await rt.sessions.start(ws.id, { prompt: `t${i}` })).finished;
    const history = await rt.sessions.history(ws.id);
    expect(history.length).toBeLessThanOrEqual(5000);
    expect(history[history.length - 1]).toMatchObject({ type: "session.end" });
    expect(history.some(e => e.type === "session.start" && e.prompt === "t1299")).toBe(true);
    expect(history.some(e => e.type === "session.start" && e.prompt === "t0")).toBe(false);
    // close() waits the put chain out, so nothing drains into the next test's clock.
    await rt.close();
    const persisted = await stored(ws.id);
    expect(persisted.length).toBeLessThanOrEqual(5000);
    expect(persisted.some(e => e.type === "session.start" && e.prompt === "t1299")).toBe(true);
  });
});

describe("runtime daemon reach", () => {
  const TOKEN_CMD = "cat /root/.wsp-daemon-token";

  it("hands back the preview route plus the daemon token read once off the guest", async () => {
    const backend = stubBackend();
    let minted = 0;
    backend.execImpl = (_m, cmd) =>
      cmd === TOKEN_CMD ? { exitCode: 0, stdout: "guest-token\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => {
      minted++;
      return { url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    const reach = await rt.workspaces.daemonReach(ws.id);
    expect(reach).toEqual({ url: "https://m1-7070.preview.example/?pt_token=edge", expiresAt: expect.any(Number), daemonToken: "guest-token" });
    await rt.workspaces.daemonReach(ws.id);
    expect(minted).toBe(1);
    expect(backend.machines[0]!.execLog.filter(c => c === TOKEN_CMD)).toHaveLength(1);
  });

  it("omits the daemon token when the guest has none and refuses backends without preview urls", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd === TOKEN_CMD ? { exitCode: 1, stdout: "", stderr: "No such file" } : { exitCode: 0, stdout: "", stderr: "" });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow("without preview URLs");

    backend.machines[0]!.previewUrl = async () => ({ url: "https://m1-7070.preview.example/?pt_token=e", token: "e", expiresAt: Date.now() + 3_600_000 });
    const reach = await rt.workspaces.daemonReach(ws.id);
    expect(reach.daemonToken).toBeUndefined();
    expect("daemonToken" in reach).toBe(false);
  });

  it("re-reads the token after a resurrect replaces the machine", async () => {
    const backend = stubBackend();
    backend.execImpl = (m, cmd) => (cmd === TOKEN_CMD ? { exitCode: 0, stdout: `tok-${m.id}`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const mint = async (port: number) => ({ url: `https://x-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: Date.now() + 3_600_000 });
    backend.machines[0]!.previewUrl = mint;
    expect((await rt.workspaces.daemonReach(ws.id)).daemonToken).toBe("tok-m1");

    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true;
    await rt.workspaces.wake(ws.id);
    backend.machines[1]!.previewUrl = mint;
    expect((await rt.workspaces.daemonReach(ws.id)).daemonToken).toBe("tok-m2");
  });
});

describe("runtime port reach", () => {
  it("mints a guest port's route once while fresh, caches per port, and never reads or carries the daemon token", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) =>
      cmd === "cat /root/.wsp-daemon-token" ? { exitCode: 0, stdout: "guest-token", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const minted: number[] = [];
    backend.machines[0]!.previewUrl = async port => {
      minted.push(port);
      return { url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    // Nothing listens on 3000 in this fixture: a typed-in port still mints, the tab decides what to show.
    const reach = await rt.workspaces.portReach(ws.id, 3000);
    expect(reach).toEqual({ url: "https://m1-3000.preview.example/?pt_token=edge", expiresAt: expect.any(Number) });
    await rt.workspaces.portReach(ws.id, 3000);
    await rt.workspaces.portReach(ws.id, 5173);
    expect(minted).toEqual([3000, 5173]);
    expect(backend.machines[0]!.execLog.filter(c => c.includes(".wsp-daemon-token"))).toHaveLength(0);
  });

  it("rejects an unknown workspace", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    await expect(rt.workspaces.portReach("ws_nobody", 3000)).rejects.toThrow(/no such workspace/);
  });
});

describe("runtime golden builders", () => {
  const recipe = { setup: "install", smoke: "true" };

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
    expect((await rt.golden.builders()).sort(byId).map(b => [b.id, b.firstLife])).toEqual([[kept.id, true], [paused.id, false], [own.id, true]]);

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

  it("builderReach mints the builder's daemon route once while fresh and reads its token off the guest", async () => {
    const backend = stubBackend();
    let minted = 0;
    backend.execImpl = (_m, cmd) =>
      cmd === "cat /root/.wsp-daemon-token" ? { exitCode: 0, stdout: "builder-token\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    const b = await rt.golden.prepare();
    expect(b.screen).toBeUndefined();
    backend.machines[0]!.previewUrl = async port => {
      minted++;
      return { url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    const reach = await rt.golden.builderReach(b.id);
    expect(reach).toEqual({ url: "https://m1-7070.preview.example/?pt_token=edge", expiresAt: expect.any(Number), daemonToken: "builder-token" });
    await rt.golden.builderReach(b.id);
    expect(minted).toBe(1);
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

  it("a seal whose builder outlives two kills fails with kind machineAlive, forks nothing, and writes no manifest", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, killConfirm: { graceMs: 20, pollMs: 1 } });
    const b = await rt.golden.prepare();
    const machine = backend.machines.find(m => m.id === b.id)!;
    let kills = 0;
    machine.kill = async () => { kills++; };
    await expect(rt.golden.seal(b.id)).rejects.toMatchObject({ kind: "machineAlive", machineId: b.id });
    expect(kills).toBe(2);
    expect(backend.machines).toHaveLength(1);
    expect(await rt.golden.get()).toBeUndefined();
    expect(await rt.golden.builders()).toEqual([]);
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
    await rt.workspaces.create({ golden: "snap_g", name: "x" });
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
      failed: [{ id: first.id, message: "502 exec failed; stays recorded, retried next sweep" }],
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
    expect((await rt.golden.builders()).map(b => [b.id, b.firstLife])).toEqual([[kept.id, true]]);
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

  it("the sweep leaves a workspace this process is still forking alone, on create and on a resurrect", async () => {
    const backend = stubBackend();
    let release!: () => void;
    let gate = new Promise<void>(r => (release = r));
    backend.execImpl = async (_m, cmd) => {
      if (cmd.startsWith("hostname ")) await gate;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await rt.golden.builders();
    const creating = rt.workspaces.create({ golden: "snap_g", name: "x" });
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

      await rt.workspaces.nap(ws.id);
      backend.machines[0]!.killed = true; // vanished while paused, so the wake forks anew
      gate = new Promise<void>(r => (release = r));
      const waking = rt.workspaces.wake(ws.id);
      await vi.waitFor(() => expect(backend.machines).toHaveLength(2));
      vi.setSystemTime(Date.now() + 5 * 60_000);
      expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
      expect(backend.machines[1]!.killed).toBe(false);
      release();
      expect((await waking).machineId).toBe("m2");
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
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
      const upgraded = await rt.workspaces.upgrade(ws.id, { cpu: 4 });
      expect(upgraded.machineId).toBe("m2");
      expect(backend.machines[1]!.spec.cpu).toBe(4);
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
    await store.put("goldens", "default", { head: 2, versions: [version(1), version(2)] });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_golden-v2", name: "a" });

    const rolled = await rt.golden.rollback(1);
    expect(rolled).toEqual({ head: 1, versions: [version(1), version(2)] });
    expect(await rt.golden.get()).toEqual(rolled);
    expect((await rt.workspaces.get(ws.id)).golden).toBe("snap_golden-v2");
  });

  it("refuses a version that is not in the manifest, and a golden that does not exist, as kind missing", async () => {
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [version(1)] });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {} });
    await expect(rt.golden.rollback(7)).rejects.toMatchObject({ kind: "missing", message: expect.stringContaining("v7") });
    await expect(rt.golden.rollback(1, "nope")).rejects.toMatchObject({ kind: "missing" });
    expect(await rt.golden.get()).toEqual({ head: 1, versions: [version(1)] }); // untouched
  });
});

describe("runtime guest hostname", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  const hostnameCmds = (m: { execLog: string[] }) => m.execLog.filter(c => c.startsWith("hostname "));

  it("names the fresh guest after the workspace on create", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
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
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
      await rt.workspaces.upgrade(ws.id, { cpu: 4 });
      expect(hostnameCmds(backend.machines[1]!)).toEqual(["hostname task-1 && echo task-1 > /etc/hostname"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sanitizes a name that is not a valid hostname", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await rt.workspaces.create({ golden: "snap_g", name: "  My Workspace!! (v2) " });
    await rt.workspaces.create({ golden: "snap_g", name: "a".repeat(70) });
    await rt.workspaces.create({ golden: "snap_g", name: "!!!" });
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
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
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
      await expect(rt.workspaces.create({ golden: "snap_g", name: "task-1" })).resolves.toMatchObject({ phase: "running" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("exec timed out"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("runtime verified wake", () => {
  const TOKEN_CMD = "cat /root/.wsp-daemon-token";
  const TOKEN = "guest-token";

  /** A stub whose guest answers ls/tar/untar/token like a golden fork; tar and untar commands are recorded per machine. */
  function guestBackend() {
    const backend = stubBackend();
    const tars: string[] = [];
    const untars: string[] = [];
    let tgzBytes = 1_000;
    backend.execImpl = (m, cmd) => {
      if (cmd === TOKEN_CMD) return { exitCode: 0, stdout: `${TOKEN}\n`, stderr: "" };
      if (cmd.includes("ls -A /root")) return { exitCode: 0, stdout: "notes.md\n.local\n", stderr: "" };
      if (cmd.startsWith("stat -c %s")) return { exitCode: 0, stdout: `${tgzBytes}\n`, stderr: "" };
      if (cmd.includes("tar czf")) tars.push(m.id);
      if (cmd.includes("tar xzf")) untars.push(m.id);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const fetchStub = vi.fn(async (_url: string, init?: { method?: string }) =>
      init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(Buffer.from("tarbytes")),
    );
    vi.stubGlobal("fetch", fetchStub);
    return { backend, tars, untars, setTgzBytes: (n: number) => { tgzBytes = n; } };
  }

  async function withDaemon<T>(fn: (port: number) => Promise<T>): Promise<T> {
    const { startDaemon } = await import("@wsp/daemon");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const inboxDir = mkdtempSync(join(tmpdir(), "wsp-wake-inbox-"));
    const daemon = await startDaemon({ port: 0, token: TOKEN, inboxDir, inboxQuietMs: 100, inboxPollMs: 25, portsSource: async () => [], portsIntervalMs: 25 });
    try {
      return await fn(daemon.port);
    } finally {
      await daemon.close();
      rmSync(inboxDir, { recursive: true, force: true });
    }
  }

  /** A port nothing listens on: the edge dialed, the guest never answered. */
  async function deadPort(): Promise<number> {
    const { createServer } = await import("node:net");
    return new Promise(resolve => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as { port: number };
        srv.close(() => resolve(port));
      });
    });
  }

  it("resume returns but the daemon never answers: waking, one retry, then a golden fork with the vault and the zombie killed", async () => {
    const { backend, tars, untars } = guestBackend();
    const port = await deadPort();
    try {
      const store = memoryStore();
      const rt = createRuntime({ backend, store, adapters: {}, wake: { pingTimeoutMs: 300 } });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
      const m1 = backend.machines[0]!;
      m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      await rt.workspaces.nap(ws.id);
      expect(tars).toEqual(["m1"]);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));

      const woken = await rt.workspaces.wake(ws.id);
      const phases = events.filter(e => e.type === "workspace.status").map(e => (e as { status: { phase: string } }).status.phase);
      expect(phases[0]).toBe("waking");
      expect(m1.resumes).toBe(2);
      expect(m1.killed).toBe(true);
      expect(woken.machineId).toBe("m2");
      expect(woken.phase).toBe("running");
      expect(backend.machines[1]!.spec.fromSnapshot).toBe("snap_g");
      expect(untars).toEqual(["m2"]);
      expect(events.find(e => e.type === "workspace.woken")).toMatchObject({ machineId: "m2", resurrected: true });
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { phase: string; reason?: string; machineId: string } };
      expect(last.status.phase).toBe("running");
      expect(last.status.machineId).toBe("m2");
      expect(last.status.reason).toMatch(/attempt 1: daemon on m1 did not answer within 300 ms.*created as \{"cpu":2,"memMb":4096.*attempt 2:/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a size mismatch fails the wake before any ping, naming both values", async () => {
    const { backend } = guestBackend();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "x", memMb: 4096 });
      const m1 = backend.machines[0]!;
      let minted = 0;
      m1.previewUrl = async () => { minted++; return { url: "ws://127.0.0.1:1", token: "e", expiresAt: Date.now() + 3_600_000 }; };
      await rt.workspaces.nap(ws.id);
      m1.shape = { cpu: 2, memMb: 2048, createdAt: "2026-09-02T19:03:35.000Z" };

      const started = Date.now();
      const woken = await rt.workspaces.wake(ws.id);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(minted).toBe(0);
      expect(woken.machineId).toBe("m2");
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { reason?: string } };
      expect(last.status.reason).toContain("memMb 2048 != 4096");
      expect(last.status.reason).toContain('provider view {"cpu":2,"memMb":2048,"createdAt":"2026-09-02T19:03:35.000Z"}');
      expect(warn.mock.calls.some(c => String(c[0]).includes("2048") && String(c[0]).includes("4096"))).toBe(true);
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("a healthy wake stays on the same machine even though createdAt moved, imports nothing, and reports the daemon reachable", async () => {
    const { backend, untars } = guestBackend();
    try {
      await withDaemon(async port => {
        const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
        const events: EventUnion[] = [];
        rt.events.on("*", e => events.push(e));
        const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
        const m1 = backend.machines[0]!;
        m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
        await rt.workspaces.nap(ws.id);
        m1.shape = { ...m1.shape, createdAt: "2026-09-02T20:11:04.444Z" }; // every Solari resume does this
        const woken = await rt.workspaces.wake(ws.id);
        expect(woken).toMatchObject({ machineId: "m1", phase: "running" });
        expect(m1.resumes).toBe(1);
        expect(m1.killed).toBe(false);
        expect(backend.machines).toHaveLength(1);
        expect(untars).toEqual([]);
        expect(events.find(e => e.type === "workspace.woken")).toMatchObject({ machineId: "m1", resurrected: false });
        const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { reach: { state: string }; reason?: string } };
        expect(last.status.reach.state).toBe("reachable");
        expect(last.status.reason).toBeUndefined();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("every nap replaces the stashed vault; one over the cap is refused with a warning and the previous stays", async () => {
    const { backend, tars, setTgzBytes } = guestBackend();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = memoryStore();
      const rt = createRuntime({ backend, store, adapters: {}, wake: { vaultCapBytes: 5_000 } });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));
      await rt.workspaces.wake(ws.id);
      setTgzBytes(6_000);
      await rt.workspaces.nap(ws.id);
      expect(tars).toEqual(["m1", "m1"]);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));
      expect(warn.mock.calls.some(c => /6000 bytes, over the 5000 byte cap/.test(String(c[0])))).toBe(true);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
      await rt.workspaces.delete(ws.id);
      expect(await store.getBlob("vaults", ws.id)).toBeUndefined();
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("rebuild forks the golden, imports the nap-time vault, kills the old machine, keeps the id and name, and pushes status", async () => {
    const { backend, untars } = guestBackend();
    try {
      const store = memoryStore();
      const rt = createRuntime({ backend, store, adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "hello", memMb: 2048 });
      const m1 = backend.machines[0]!;
      await rt.workspaces.nap(ws.id);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));
      // The provider resumed it behind our back and handed back a running machine whose guest is dead.
      m1.paused = false;
      const rec = (await store.get("workspaces", ws.id)) as { phase: string };
      expect(rec.phase).toBe("napping");

      const rebuilt = await rt.workspaces.rebuild(ws.id);
      expect(rebuilt).toMatchObject({ id: ws.id, name: "hello", machineId: "m2", phase: "running", golden: "snap_g" });
      expect(m1.killed).toBe(true);
      expect(m1.resumes).toBe(0);
      expect(backend.machines[1]!.spec).toMatchObject({ fromSnapshot: "snap_g", memMb: 2048 });
      expect(untars).toEqual(["m2"]);
      expect(events.find(e => e.type === "workspace.upgraded")).toMatchObject({ workspaceId: ws.id, machineId: "m2" });
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { phase: string; machineId: string; reason?: string } };
      expect(last.status).toMatchObject({ phase: "running", machineId: "m2" });
      expect(last.status.reason).toMatch(/rebuilt.*m1.*m2.*vault/);
      expect((await store.get("workspaces", ws.id)) as object).toMatchObject({ machineId: "m2", phase: "running", firstLife: true });
      expect((await rt.status.list())[0]!.reach.state).not.toBe("zombie");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rebuild of a workspace that never napped imports nothing and says so", async () => {
    const { backend, untars } = guestBackend();
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "fresh" });
      const rebuilt = await rt.workspaces.rebuild(ws.id);
      expect(rebuilt.machineId).toBe("m2");
      expect(backend.machines[0]!.killed).toBe(true);
      expect(untars).toEqual([]);
      const last = events.filter(e => e.type === "workspace.status").at(-1) as { status: { reason?: string } };
      expect(last.status.reason).toMatch(/rebuilt.*m1.*m2.*no vault/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("runtime workspace size", () => {
  /** A provider that clamps memory: whatever is asked, the machine it builds has 2048 MB. */
  function clampingBackend() {
    const backend = stubBackend();
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      const m = (await create(spec)) as (typeof backend.machines)[number];
      m.shape = { ...m.shape, memMb: 2048 };
      return m;
    };
    return backend;
  }

  it("create asks for an explicit size: the pricing default when the caller names none", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await rt.workspaces.create({ golden: "snap_g", name: "b", memMb: 2048 });
    expect(backend.machines[0]!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
    expect(backend.machines[1]!.spec).toMatchObject({ cpu: 2, memMb: 2048 });
  });

  it("the size shown and billed is what the provider built, not what was asked, and it survives a restart", async () => {
    const backend = clampingBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {}, status: { costIntervalMs: 15, pollIntervalMs: 60_000 } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    expect(backend.machines[0]!.spec.memMb).toBe(4096);
    const built = { cpu: 2, memMb: 2048 };
    const [status] = await rt.status.list();
    expect(status).toMatchObject({ size: built, rateUsdPerHour: backend.pricing.rateUsdPerHour(built) });

    const costs: number[] = [];
    rt.events.on("workspace.cost", e => { if (e.type === "workspace.cost") costs.push(e.rateUsdPerHour); });
    const stop = rt.status.watch();
    while (costs.length === 0) await new Promise(r => setTimeout(r, 5));
    stop();
    expect(costs[0]).toBeCloseTo(backend.pricing.rateUsdPerHour(built), 10);

    const rt2 = createRuntime({ backend, store, adapters: {} });
    expect((await rt2.status.list())[0]).toMatchObject({ id: ws.id, size: built });
  });

  it("a resurrected fork asks for the recorded size and records what came back; an upgrade records its new size", async () => {
    const backend = clampingBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes("ls -A /root") ? { exitCode: 0, stdout: "notes.md\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { method?: string }) =>
      init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(Buffer.from("tarbytes")),
    ));
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("workspace.status", e => events.push(e));
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      await rt.workspaces.nap(ws.id);
      backend.machines[0]!.killed = true;
      await rt.workspaces.wake(ws.id);
      expect(backend.machines[1]!.spec).toMatchObject({ cpu: 2, memMb: 2048 });
      const pushed = events.at(-1) as { status: { size: { cpu: number; memMb: number } } };
      expect(pushed.status.size).toEqual({ cpu: 2, memMb: 2048 });

      backend.machines[1]!.previewUrl = undefined;
      await rt.workspaces.upgrade(ws.id, { cpu: 4 });
      expect(backend.machines[2]!.spec).toMatchObject({ cpu: 4, memMb: 2048 });
      expect((await rt.status.list())[0]!.size).toEqual({ cpu: 4, memMb: 2048 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a fork inherits the size its golden was sealed at unless the caller overrides it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const version = { version: 1, snapshotId: "snap_golden-v1", baseTemplate: "base", setupSha: "s", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 }, size: { cpu: 2, memMb: 8192 } };
    await store.put("goldens", "big", { head: 1, versions: [version] });
    const rt = createRuntime({ backend, store, adapters: {} });
    await rt.workspaces.create({ golden: "snap_golden-v1", name: "a" });
    await rt.workspaces.create({ golden: "snap_golden-v1", name: "b", memMb: 2048 });
    await rt.workspaces.create({ golden: "snap_elsewhere", name: "c" });
    expect(backend.machines[0]!.spec).toMatchObject({ cpu: 2, memMb: 8192 });
    expect(backend.machines[1]!.spec).toMatchObject({ cpu: 2, memMb: 2048 });
    expect(backend.machines[2]!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
    expect((await rt.status.list()).map(s => s.size.memMb).sort()).toEqual([2048, 4096, 8192]);
  });

  it("seal records the builder's size on the version, as the provider reported it", async () => {
    const backend = clampingBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: { setup: "install", smoke: "true", cpu: 2, memMb: 4096 } });
    const b = await rt.golden.prepare();
    expect(backend.machines[0]!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
    const { version } = await rt.golden.seal(b.id);
    expect(version.size).toEqual({ cpu: 2, memMb: 2048 });
    expect(backend.machines[1]!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
  });

  it("a stored workspace with no recorded size is sized from the provider's view on hydrate", async () => {
    const backend = clampingBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    const raw = (await store.get("workspaces", ws.id)) as Record<string, unknown>;
    delete raw["size"];
    await store.put("workspaces", ws.id, raw);

    const rt2 = createRuntime({ backend, store, adapters: {} });
    expect((await rt2.status.list())[0]!.size).toEqual({ cpu: 2, memMb: 2048 });
  });
});

describe("runtime workspace screen", () => {
  /** A provider whose forks boot as desktop machines: every machine it builds streams a display. */
  function desktopBackend() {
    const backend = stubBackend();
    const create = backend.create.bind(backend);
    backend.create = spec => create({ ...spec, kind: "desktop" });
    return backend;
  }

  it("a desktop machine's stream rides the view and the status; a sandbox carries no screen", async () => {
    const desktop = desktopBackend();
    const rt = createRuntime({ backend: desktop, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    expect(ws.screen).toEqual({ streamUrl: "wss://stub/stream/m1" });
    expect((await rt.workspaces.get(ws.id)).screen).toEqual({ streamUrl: "wss://stub/stream/m1" });
    expect((await rt.status.list())[0]!.screen).toEqual({ streamUrl: "wss://stub/stream/m1" });

    const headless = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const sandbox = await headless.workspaces.create({ golden: "snap_g", name: "b" });
    expect(sandbox).not.toHaveProperty("screen");
    expect((await headless.status.list())[0]).not.toHaveProperty("screen");
  });

  it("the stream survives a restart and a wake on the same machine; a resurrect refreshes it from the new machine", async () => {
    const backend = desktopBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    await rt1.workspaces.nap(ws.id);

    const rt2 = createRuntime({ backend, store, adapters: {} });
    expect((await rt2.workspaces.get(ws.id)).screen).toEqual({ streamUrl: "wss://stub/stream/m1" });
    const woken = await rt2.workspaces.wake(ws.id);
    expect(woken.machineId).toBe("m1");
    expect(woken.screen).toEqual({ streamUrl: "wss://stub/stream/m1" });

    const pushed: EventUnion[] = [];
    rt2.events.on("workspace.status", e => pushed.push(e));
    await rt2.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true;
    const resurrected = await rt2.workspaces.wake(ws.id);
    expect(resurrected.machineId).toBe("m2");
    expect(resurrected.screen).toEqual({ streamUrl: "wss://stub/stream/m2" });
    const last = pushed.at(-1) as { status: { screen?: { streamUrl: string } } };
    expect(last.status.screen).toEqual({ streamUrl: "wss://stub/stream/m2" });
    expect((await store.get("workspaces", ws.id) as { screen?: unknown }).screen).toEqual({ streamUrl: "wss://stub/stream/m2" });
  });
});

describe("runtime fork kind", () => {
  const version = (kind?: "sandbox" | "desktop") => ({
    version: 1,
    snapshotId: "snap_golden-v1",
    baseTemplate: "base",
    ...(kind !== undefined ? { kind } : {}),
    setupSha: "sha1",
    createdAt: "2026-08-11T00:00:00.000Z",
    smoke: { cmd: "true", exitCode: 0 },
  });

  it("forks a desktop golden as kind desktop on create, resurrect and upgrade, carrying the stream on the view", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [version("desktop")] });
    const rt = createRuntime({ backend, store, adapters: {} });

    const ws = await rt.workspaces.create({ golden: "snap_golden-v1", name: "a" });
    expect(backend.machines[0]!.spec.kind).toBe("desktop");
    expect(ws.screen).toEqual({ streamUrl: "wss://stub/stream/m1" });

    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true;
    const woken = await rt.workspaces.wake(ws.id);
    expect(backend.machines[1]!.spec.kind).toBe("desktop");
    expect(woken.screen).toEqual({ streamUrl: "wss://stub/stream/m2" });

    const upgraded = await rt.workspaces.upgrade(ws.id, { cpu: 4 });
    expect(backend.machines[2]!.spec.kind).toBe("desktop");
    expect(upgraded.screen).toEqual({ streamUrl: "wss://stub/stream/m3" });
  });

  it("a manifest sealed before versions recorded a kind still forks sandbox", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [version()] });
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_golden-v1", name: "a" });
    expect(backend.machines[0]!.spec.kind).toBe("sandbox");
    expect(ws.screen).toBeUndefined();
  });
});

describe("nap vault against the stub backend", () => {
  it("stores a real tar from the stub download URL without warning", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store, adapters: {} });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      expect(warn).not.toHaveBeenCalled();
      const vault = await store.getBlob("vaults", ws.id);
      expect(vault).toBeDefined();
      expect(gunzipSync(vault!).equals(Buffer.alloc(1024))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once and keeps the previous vault when the download URL cannot be fetched", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store, adapters: {} });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      const first = await store.getBlob("vaults", ws.id);
      await rt.workspaces.wake(ws.id);

      backend.machines[0]!.downloadUrl = async () => "http://127.0.0.1:1/nothing-listens-here";
      await rt.workspaces.nap(ws.id);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(`nap vault for ${ws.id} not stored, previous kept: fetch failed`);
      expect(await store.getBlob("vaults", ws.id)).toEqual(first);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("runtime golden import", () => {
  const importOf = (recipeHash = "h1"): GoldenImport => ({
    recipeHash,
    files: { count: 1, rungs: { shell: 1 }, bytes: 10, skipped: [], pack: async () => ({ tar: Buffer.from("t"), bytes: 10, unpacked: 10, skipped: [], cut: [] }) },
    tools: [{ id: "tools/brew/jq", label: "jq", manager: "brew", cmd: "brew install jq" }],
    agents: [{ id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version" }],
  });
  const dfOk = (m: unknown, cmd: string) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: `${2000 * 1024}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });

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
      "applying-setup:1 file: shell 1",
      "applying-setup:10 B packed",
      "installing-tools:jq (1/1)",
      "installing-tools:1 installed",
      "installing-harness",
      "installing-harness:Codex (1/1)",
      "installing-harness:Codex installed",
      "ready",
    ]);
    expect(await store.get("builders", b.id)).toMatchObject({ import: { recipeHash: "h1", applied: ["applying-setup", "uploading-files", "installing-tools", "installing-harness"], smoke: "codex --version" } });
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
      "installing-tools:already applied",
      "installing-harness:already applied",
      "ready:",
    ]);
    expect(await rt.golden.builders()).toHaveLength(1);
  });

  const recipeWith = (imp: GoldenImport) => ({ setup: "true", smoke: "true", import: imp });
  const SKIPPED = ["creating:already applied", "deploying-daemon:already applied", "applying-setup:already applied", "uploading-files:already applied", "installing-tools:already applied", "installing-harness:already applied", "ready:"];

  it("a first-life builder from an earlier process with the same recipe is attached to: every stage skipped, one machine, and it seals", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    const b = await first.golden.prepare();
    expect(await store.get("builders", b.id)).toMatchObject({ firstLife: true });

    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect(await second.golden.builders()).toEqual([expect.objectContaining({ id: b.id, firstLife: true, recipeHash: "h1" })]);
    const frames: string[] = [];
    second.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const again = await second.golden.prepare();
    expect(again).toMatchObject({ id: b.id, firstLife: true, recipeHash: "h1" });
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
    expect(await second.golden.builders()).toEqual([expect.objectContaining({ id: b.id, firstLife: false })]);
    expect(await store.get("builders", b.id)).toMatchObject({ firstLife: false });
    const fresh = await second.golden.prepare();
    expect(fresh.id).not.toBe(b.id);
    expect(backend.machines).toHaveLength(2);

    // Resumed from outside wsp: the provider reports it running again, the record still says not first-life.
    backend.machines[0]!.paused = false;
    const third = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    expect((await third.golden.builders()).map(x => [x.id, x.firstLife])).toEqual([[b.id, false], [fresh.id, true]]);
    expect(await third.reap()).toEqual({ reaped: [{ id: b.id, builder: true, reason: "recorded" }], spared: [] });
    expect(backend.machines.map(m => m.killed)).toEqual([true, false]);
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
    expect(await store.get("builders", b.id)).toMatchObject({ import: { recipeHash: "h1", applied: ["applying-setup", "uploading-files", "installing-tools", "installing-harness"] } });
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
    expect((await second.golden.builders()).map(x => [x.id, x.firstLife, x.recipeHash])).toEqual([[b.id, true, "h1"], [fresh.id, true, "h9"]]);
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
    expect(await second.golden.builders()).toEqual([expect.objectContaining({ id: b.id, firstLife: true, foreignOwner: mine })]);
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
    expect(backend.machines[0]!.execLog.filter(c => c.includes("wsp-daemon-token"))).toEqual([]);
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
    expect(view).toEqual([expect.objectContaining({ id: b.id, firstLife: true })]);
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
    expect(frames.slice(-2)).toEqual(["installing-harness:already applied", "failed:gone"]);
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
    expect(await second.golden.builders()).toEqual([expect.objectContaining({ id: b.id, firstLife: false })]);
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
    expect(await c.golden.builders()).toEqual([expect.objectContaining({ id: b.id, firstLife: true, heldBy: expect.objectContaining({ pid: otherPid }) })]);
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
    expect(view).toMatchObject({ id: b.id, firstLife: true });
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
    expect(done.import?.applied).toHaveLength(4);

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
    expect(await c.golden.builders()).toEqual([expect.objectContaining({ id: b.id, firstLife: true })]);
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
    expect(done.import?.applied).toEqual(["applying-setup", "uploading-files", "installing-tools", "installing-harness"]);
    expect(done.heldBy).toMatchObject({ pid: process.pid });
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
    expect(view).toEqual([expect.objectContaining({ id: m.id, building: true, firstLife: true })]);
    expect(view[0]).not.toHaveProperty("heldBy");
    await expect(later.golden.seal(m.id)).rejects.toThrow("still being prepared");
    expect((await later.golden.prepare()).id).not.toBe(m.id);
    expect(await later.reap()).toEqual({ reaped: [{ id: m.id, builder: true, reason: "unfinished" }], spared: [] });
    expect(m.killed).toBe(true);

    // A prepare whose stages fail: the engine kills the machine and the placeholder goes with it.
    const failing = stubBackend();
    failing.execImpl = (x, cmd) => (cmd === "true" ? { exitCode: 1, stdout: "", stderr: "setup broke" } : dfOk(x, cmd));
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
    expect(log.filter(c => c.includes("tar"))).toHaveLength(1);
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
    backend.execImpl = (m, cmd) => (cmd === "true" ? { exitCode: 1, stdout: "", stderr: "setup broke" } : dfOk(m, cmd));

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
