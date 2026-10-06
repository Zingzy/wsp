// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { NO_SUCH_TURN, TURN_TOKEN_ENV, notifyLine, type EventUnion, type TurnResult } from "@wsp/protocol";
import { GUEST_LOGIN_ENV, createRuntime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn } from "./stub-backend.js";
import { held, settle } from "./runtime-fixture.js";

describe("a thread whose start named who to tell", () => {
  it("a running parent that steers is told by one steer: the line, with the outcome, duration, cost and the reply whole, and the child's transcript holds a session.notify naming the parent", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    const parentThread = parent.view().threadId!;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: [parentThread], startedBy: "agent" });
    const kidThread = kid.view().threadId!;
    expect(kidThread).not.toBe(parentThread);
    h.end(1, "Ran the gate.\n\nAll 12 tests green.\n", { durationMs: 492_000, costUsd: 1.94 });
    const line = `thread ${kidThread.slice(0, 8)} finished (completed, 8m 12s, $1.94): Ran the gate.\n\nAll 12 tests green.`;
    await vi.waitFor(() => expect(h.steered).toEqual([line]));
    expect(h.starts.map(s => s.prompt)).toEqual(["orchestrate", "build it"]);
    const history = await rt.sessions.history(ws.id);
    expect(history.filter(e => e.threadId === kidThread).map(e => e.type)).toEqual(["session.start", "session.notify", "session.done", "session.end"]);
    expect(history.find(e => e.type === "session.notify")).toMatchObject({ threadId: kidThread, turnId: kid.turnId, sessionId: kid.view().claudeSessionId, notify: parentThread, text: line });
    expect(history.filter(e => e.threadId === parentThread).map(e => e.type)).toEqual(["session.start", "session.steer"]);
    expect(history.find(e => e.type === "session.steer")).toMatchObject({ threadId: parentThread, turnId: parent.turnId, prompt: line });
    h.end(0, "handled");
    await rt.close();
  });

  it("an idle parent is told by a turn of its own: a start that resumes the parent's session with the line as its prompt", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate", startedBy: "cli" });
    const parentThread = parent.view().threadId!;
    const parentSid = parent.view().claudeSessionId!;
    h.end(0, "waiting for the builder");
    await parent.finished;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: [parentThread] });
    const kidThread = kid.view().threadId!;
    h.end(1, "done", { durationMs: 1_500, costUsd: 0.0042 });
    await vi.waitFor(() => expect(h.starts).toHaveLength(3));
    const line = `thread ${kidThread.slice(0, 8)} finished (completed, 1.5s, $0.00): done`;
    expect(h.starts[2]).toMatchObject({ prompt: line, resume: parentSid });
    expect(h.steered).toEqual([]);
    const rows = await rt.sessions.list(ws.id);
    expect(rows.filter(r => r.threadId === parentThread).map(r => [r.status, r.prompt, r.startedBy])).toEqual([["running", "orchestrate", "cli"]]);
    const history = await rt.sessions.history(ws.id);
    expect(history.filter(e => e.threadId === parentThread).map(e => e.type)).toEqual(["session.start", "session.done", "session.end", "session.start"]);
    expect(history.at(-1)).toMatchObject({ type: "session.start", threadId: parentThread, prompt: line });
    h.end(2, "read it");
    await rt.close();
  });

  it("a parent that replied while its process still runs is told once that process exits: the line waits for its session.end, then goes as a turn of its own", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    const parentThread = parent.view().threadId!;
    const parentSid = parent.view().claudeSessionId!;
    h.reply(0, "waiting for the builder");
    expect(parent.view().status).toBe("running");
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: [parentThread] });
    h.end(1, "done", { durationMs: 1_500, costUsd: 0.0042 });
    const line = `thread ${kid.view().threadId!.slice(0, 8)} finished (completed, 1.5s, $0.00): done`;
    await settle();
    // The parent's turn has replied, so it takes no steer; the line queues behind that process, as any send does.
    expect(h.steered).toEqual([]);
    expect(h.starts).toHaveLength(2);
    expect(events.filter(e => e.type === "session.queued")).toMatchObject([{ threadId: parentThread, prompt: line }]);
    expect((await rt.sessions.history(ws.id)).find(e => e.type === "session.notify")).toMatchObject({ notify: parentThread, text: line });

    h.exit(0);
    await parent.finished;
    await vi.waitFor(() => expect(h.starts).toHaveLength(3));
    expect(h.starts[2]).toMatchObject({ prompt: line, resume: parentSid });
    expect(h.steered).toEqual([]);
    const history = await rt.sessions.history(ws.id);
    expect(history.filter(e => e.threadId === parentThread).map(e => e.type)).toEqual(["session.start", "session.done", "session.end", "session.start"]);
    h.end(2, "read it");
    await rt.close();
  });

  it("a turn that replied and is then ended by a nap keeps its reply's status and tells its parent nothing more", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const turn = await rt.sessions.start(ws.id, { prompt: "orchestrate", notify: ["me"] });
    h.reply(0, "the reply", { durationMs: 1_500, costUsd: 0.0042 });
    const line = `thread ${turn.view().threadId!.slice(0, 8)} finished (completed, 1.5s, $0.00): the reply`;
    await rt.workspaces.nap(ws.id);
    expect(events.filter(e => e.type === "session.notify").map(e => (e as { text: string }).text)).toEqual([line]);
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("completed");
    const history = await rt.sessions.history(ws.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.notify", "session.done", "session.end"]);
    expect(history.at(-1)).toMatchObject({ type: "session.end", exitCode: null, sawResult: true, reason: "machine paused while the agent was working" });
    await rt.close();
  });

  it("a turn that replied and whose host restarts before its process exited settles to its reply's status at load and tells its parent nothing more", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h1 = held(false);
    const rt1 = createRuntime({ backend, store, adapters: { claude: h1.adapter } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    const turn = await rt1.sessions.start(ws.id, { prompt: "orchestrate", notify: ["me"] });
    h1.reply(0, "the reply", { durationMs: 1_500, costUsd: 0.0042 });
    const line = `thread ${turn.view().threadId!.slice(0, 8)} finished (completed, 1.5s, $0.00): the reply`;
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: held(false).adapter } });
    try {
      const history = await rt2.sessions.history(ws.id);
      expect(history.map(e => e.type)).toEqual(["session.start", "session.notify", "session.done", "session.end"]);
      expect(history.filter(e => e.type === "session.notify").map(e => (e as { text: string }).text)).toEqual([line]);
      expect(history.at(-1)).toMatchObject({ type: "session.end", exitCode: null, sawResult: true, reason: "host restarted while the agent was working" });
      expect((await rt2.sessions.list(ws.id))[0]!.status).toBe("completed");
    } finally {
      await rt2.close();
    }
  });

  it("a running parent that cannot steer is told once its turn ends: the line waits behind it as a queued send does", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    const parentThread = parent.view().threadId!;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: [parentThread] });
    h.end(1, "done", { durationMs: 60_000, costUsd: 0.5 });
    const line = `thread ${kid.view().threadId!.slice(0, 8)} finished (completed, 1m, $0.50): done`;
    await vi.waitFor(() => expect(events.filter(e => e.type === "session.queued")).toMatchObject([{ threadId: parentThread, prompt: line }]));
    await settle();
    expect(h.starts).toHaveLength(2);
    h.end(0, "first done");
    await vi.waitFor(() => expect(h.starts).toHaveLength(3));
    expect(h.starts[2]).toMatchObject({ prompt: line, resume: parent.view().claudeSessionId });
    h.end(2, "read it");
    await rt.close();
  });

  it("failed and interrupted ends carry their words; me records the line for the person and starts nothing", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const failing = await rt.sessions.start(ws.id, { prompt: "die", notify: ["me"] });
    h.end(0, "", { status: "failed", error: "the harness died", durationMs: 3_000 });
    const stopped = await rt.sessions.start(ws.id, { prompt: "run", notify: ["me"] });
    h.end(1, "Stopped mid-way.", { status: "interrupted", durationMs: 12_000, costUsd: 0.03 });
    await Promise.all([failing.finished, stopped.finished]);
    const told = events.filter(e => e.type === "session.notify");
    expect(told).toMatchObject([
      { threadId: failing.view().threadId, notify: "me", text: `thread ${failing.view().threadId!.slice(0, 8)} finished (failed, 3.0s): the harness died` },
      { threadId: stopped.view().threadId, notify: "me", text: `thread ${stopped.view().threadId!.slice(0, 8)} finished (interrupted, 12s, $0.03): Stopped mid-way.` },
    ]);
    expect(h.starts).toHaveLength(2);
    expect(h.steered).toEqual([]);
    // Pushed before the turn's session.done, where a follower keyed on the turn stops reading.
    const kinds = events.filter(e => "turnId" in e && e.turnId === failing.turnId).map(e => e.type);
    expect(kinds).toEqual(["session.start", "session.notify", "session.done", "session.end"]);
    await rt.close();
  });

  it("a thread id no thread carries is refused before anything starts", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await expect(rt.sessions.start(ws.id, { prompt: "build it", notify: ["thread_nobody"]})).rejects.toThrow("no thread thread_nobody to notify");
    expect(h.starts).toEqual([]);
    expect(await rt.sessions.list(ws.id)).toEqual([]);
    await rt.close();
  });

  it("the thread keeps who to tell: a later send into it, and a turn after the host restarted, both tell the parent", async () => {
    const h = held(true);
    const store = memoryStore();
    const backend = stubBackend();
    const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    const parentThread = parent.view().threadId!;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: [parentThread] });
    const kidThread = kid.view().threadId!;
    h.end(1, "first");
    await vi.waitFor(() => expect(h.steered).toHaveLength(1));
    const again = await rt.sessions.start(ws.id, { prompt: "and the docs", thread: kidThread });
    expect(again.view().threadId).toBe(kid.view().threadId);
    h.end(2, "second");
    await vi.waitFor(() => expect(h.steered).toHaveLength(2));
    expect(h.steered[1]).toBe(`thread ${kid.view().threadId!.slice(0, 8)} finished (completed): second`);
    h.end(0, "parent done");
    await rt.close();

    const h2 = held(true);
    const rt2 = createRuntime({ backend, store, adapters: { claude: h2.adapter } });
    const parentAgain = await rt2.sessions.start(ws.id, { prompt: "still here", thread: parentThread });
    expect(parentAgain.view().threadId).toBe(parentThread);
    const third = await rt2.sessions.start(ws.id, { prompt: "and the tests", thread: kidThread });
    expect(third.view().threadId).toBe(kid.view().threadId);
    h2.end(1, "third");
    await vi.waitFor(() => expect(h2.steered).toEqual([`thread ${kid.view().threadId!.slice(0, 8)} finished (completed): third`]));
    h2.end(0, "ok");
    await rt2.close();
  });

  it("a thread cannot notify itself: a send into it that names its own thread is refused, and nothing starts", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const own = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    h.end(0, "ready");
    await own.finished;
    await expect(rt.sessions.start(ws.id, { prompt: "again", thread: own.view().threadId!, notify: [own.view().threadId!]})).rejects.toThrow("a thread cannot notify itself");
    expect(h.starts).toHaveLength(1);
    expect((await rt.sessions.history(ws.id)).map(e => e.type)).toEqual(["session.start", "session.done", "session.end"]);
    await rt.close();
  });

  it("a cycle is refused: a start whose notify already leads back to this thread, at any length of the chain", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const a = await rt.sessions.start(ws.id, { prompt: "a" });
    const b = await rt.sessions.start(ws.id, { prompt: "b", notify: [a.view().threadId!] });
    const c = await rt.sessions.start(ws.id, { prompt: "c", notify: [b.view().threadId!] });
    // Ended child first, so each end steers its line into a parent still running instead of opening a turn on it.
    h.end(2, "idle");
    await vi.waitFor(() => expect(h.steered).toHaveLength(1));
    h.end(1, "idle");
    await vi.waitFor(() => expect(h.steered).toHaveLength(2));
    h.end(0, "idle");
    await a.finished;
    await expect(rt.sessions.start(ws.id, { prompt: "a again", thread: a.view().threadId!, notify: [b.view().threadId!]})).rejects.toThrow(`thread ${b.view().threadId!.slice(0, 8)} already notifies this thread; a cycle would run forever`);
    await expect(rt.sessions.start(ws.id, { prompt: "a again", thread: a.view().threadId!, notify: [c.view().threadId!]})).rejects.toThrow(`thread ${c.view().threadId!.slice(0, 8)} already notifies this thread; a cycle would run forever`);
    expect(h.starts).toHaveLength(3);
    // A chain that does not come back is fine: a fresh thread may name c, and c's own chain ends at a.
    const d = await rt.sessions.start(ws.id, { prompt: "d", notify: [c.view().threadId!] });
    expect(d.outcome).toBe("started");
    await rt.close();
  });

  it("a parent whose workspace naps while the child ends gets the line when the workspace wakes, as the first turn of its own", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    h.end(0, "waiting");
    await parent.finished;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: [parent.view().threadId!] });
    await rt.workspaces.nap(ws.id);
    const line = `thread ${kid.view().threadId!.slice(0, 8)} finished (failed): machine paused while the agent was working`;
    expect(events.find(e => e.type === "session.notify")).toMatchObject({ notify: parent.view().threadId, text: line });
    expect(h.starts).toHaveLength(2);
    await rt.workspaces.wake(ws.id);
    await vi.waitFor(() => expect(h.starts).toHaveLength(3));
    expect(h.starts[2]).toMatchObject({ prompt: line, resume: parent.view().claudeSessionId });
    expect(events.filter(e => e.type === "session.start").at(-1)).toMatchObject({ threadId: parent.view().threadId, prompt: line });
    h.end(2, "read it");
    await rt.close();
  });

  it("a turn the runtime ends is told too: a nap while the child works reaches the parent as failed with the reason", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: ["me"] });
    await rt.workspaces.nap(ws.id);
    const kinds = events.filter(e => "turnId" in e && e.turnId === kid.turnId).map(e => e.type);
    expect(kinds).toEqual(["session.start", "session.notify", "session.end"]);
    expect(events.find(e => e.type === "session.notify")).toMatchObject({ notify: "me", text: `thread ${kid.view().threadId!.slice(0, 8)} finished (failed): machine paused while the agent was working` });
    await rt.close();
  });

  it("a turn a host restart cut is told the same way: the parent, in another workspace whose rows load later, gets the line as a turn of its own since its own turn was cut too", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h1 = held(true);
    const rt1 = createRuntime({ backend, store, adapters: { claude: h1.adapter } });
    // The child's workspace has the older sessions document, so the sweep meets the child before its parent.
    const kidWs = await createOn(rt1, { golden: "snap_g", name: "builder" });
    const warmup = await rt1.sessions.start(kidWs.id, { prompt: "warm up" });
    h1.end(0, "ready");
    await warmup.finished;
    const parentWs = await createOn(rt1, { golden: "snap_g", name: "lead" });
    const parent = await rt1.sessions.start(parentWs.id, { prompt: "orchestrate" });
    const parentThread = parent.view().threadId!;
    const kid = await rt1.sessions.start(kidWs.id, { prompt: "build it", notify: [parentThread], startedBy: "agent" });
    const kidThread = kid.view().threadId!;
    await rt1.close();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 723_000);
    const h2 = held(true);
    const rt2 = createRuntime({ backend, store, adapters: { claude: h2.adapter } });
    try {
      const line = `thread ${kidThread.slice(0, 8)} finished (failed): cut by a host restart after 12m 03s`;
      const kidHistory = (await rt2.sessions.history(kidWs.id)).filter(e => e.threadId === kidThread);
      expect(kidHistory.map(e => e.type)).toEqual(["session.start", "session.notify", "session.end"]);
      expect(kidHistory[1]).toMatchObject({ type: "session.notify", turnId: kid.turnId, sessionId: kid.view().claudeSessionId, notify: parentThread, text: line });
      expect(kidHistory[2]).toMatchObject({ type: "session.end", turnId: kid.turnId, reason: "host restarted while the agent was working" });
      await vi.waitFor(() => expect(h2.starts).toHaveLength(1));
      expect(h2.starts[0]).toMatchObject({ prompt: line, resume: parent.view().claudeSessionId });
      expect(h2.steered).toEqual([]);
      const parentHistory = (await rt2.sessions.history(parentWs.id)).filter(e => e.threadId === parentThread);
      expect(parentHistory.map(e => e.type)).toEqual(["session.start", "session.end", "session.start"]);
      expect(parentHistory[2]).toMatchObject({ type: "session.start", prompt: line });
      h2.end(0, "read it");
      await rt2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a turn a host restart cut that was to tell me records the line in its thread, with the row's span", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h1 = held(true);
    const rt1 = createRuntime({ backend, store, adapters: { claude: h1.adapter } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    const kid = await rt1.sessions.start(ws.id, { prompt: "build it", notify: ["me"] });
    await rt1.close();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 45_000);
    const rt2 = createRuntime({ backend, store, adapters: {} });
    try {
      const events: EventUnion[] = [];
      rt2.events.on("*", e => events.push(e));
      const history = await rt2.sessions.history(ws.id);
      expect(history.map(e => e.type)).toEqual(["session.start", "session.notify", "session.end"]);
      expect(history[1]).toMatchObject({ type: "session.notify", turnId: kid.turnId, notify: "me", text: `thread ${kid.view().threadId!.slice(0, 8)} finished (failed): cut by a host restart after 0m 45s` });
      expect(events.filter(e => e.type === "session.notify")).toHaveLength(1);
      await rt2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("me is the thread the request came out of: two turns on one machine launch under a token each, and each token resolves me to its own thread", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const one = await rt.sessions.start(ws.id, { prompt: "coordinate one" });
    const two = await rt.sessions.start(ws.id, { prompt: "coordinate two" });
    const tokens = h.envs.map(e => e[TURN_TOKEN_ENV]!);
    expect(tokens.filter(t => /^[0-9a-f]{32}$/.test(t ?? ""))).toHaveLength(2);
    expect(new Set(tokens).size).toBe(2);
    // Neither turn's token is anything the machine's own login carries: it is this launch's alone.
    expect(GUEST_LOGIN_ENV[TURN_TOKEN_ENV]).toBeUndefined();
    const kidOne = await rt.sessions.start(ws.id, { prompt: "build for one", notify: ["me"], turnToken: tokens[0], startedBy: "agent" });
    const kidTwo = await rt.sessions.start(ws.id, { prompt: "build for two", notify: ["me"], turnToken: tokens[1], startedBy: "agent" });
    h.end(2, "one done");
    h.end(3, "two done");
    await vi.waitFor(async () => expect((await rt.sessions.history(ws.id)).filter(e => e.type === "session.notify")).toHaveLength(2));
    const told = (await rt.sessions.history(ws.id)).filter(e => e.type === "session.notify");
    expect(told.map(e => [e.threadId, e.notify])).toEqual([
      [kidOne.view().threadId, one.view().threadId],
      [kidTwo.view().threadId, two.view().threadId],
    ]);
    h.end(0, "read it");
    h.end(1, "read it");
    await rt.close();
  });

  it("a turn the runtime ended rather than its own process leaves its token naming nobody", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const turn = await rt.sessions.start(ws.id, { prompt: "coordinate" });
    const token = h.envs[0]![TURN_TOKEN_ENV]!;
    // A nap ends the turn from this side: its harness process never exits, so nothing on that road clears the row.
    await rt.workspaces.nap(ws.id);
    expect(turn.view().status).toBe("failed");
    await rt.workspaces.wake(ws.id);
    await expect(rt.sessions.start(ws.id, { prompt: "build it", notify: ["me"], turnToken: token })).rejects.toThrow(NO_SUCH_TURN);
    await rt.close();
  });

  it("a token no turn on this host carries is refused, and nothing starts", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await expect(rt.sessions.start(ws.id, { prompt: "build it", notify: ["me"], turnToken: "f".repeat(32) })).rejects.toThrow(NO_SUCH_TURN);
    expect(h.starts).toEqual([]);
    expect(await rt.sessions.list(ws.id)).toEqual([]);
    await rt.close();
  });

  it("the token dies with the turn that carried it, and a start with no token still reaches the person", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const turn = await rt.sessions.start(ws.id, { prompt: "coordinate" });
    const token = h.envs[0]![TURN_TOKEN_ENV]!;
    h.end(0, "handed off");
    await turn.finished;
    await settle();
    await expect(rt.sessions.start(ws.id, { prompt: "build it", notify: ["me"], turnToken: token })).rejects.toThrow(NO_SUCH_TURN);
    // No token at all is every road that is not a turn: the app, a person's shell, an agent nobody launched here.
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: ["me"] });
    h.end(1, "done");
    await vi.waitFor(async () => expect((await rt.sessions.history(ws.id)).some(e => e.type === "session.notify")).toBe(true));
    expect((await rt.sessions.history(ws.id)).find(e => e.type === "session.notify")).toMatchObject({ threadId: kid.view().threadId, notify: "me" });
    await rt.close();
  });

  it("notify takes several targets: a builder's end reaches its orchestrator and a reviewer, each once, with the same line", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const lead = await createOn(rt, { golden: "snap_g", name: "lead" });
    const box = await createOn(rt, { golden: "snap_g", name: "box" });
    const orchestrator = await rt.sessions.start(lead.id, { prompt: "orchestrate" });
    const reviewer = await rt.sessions.start(lead.id, { prompt: "review what lands" });
    const builder = await rt.sessions.start(box.id, { prompt: "build it", notify: [orchestrator.view().threadId!, reviewer.view().threadId!], startedBy: "agent" });
    h.end(2, "Ran the gate.\nAll 12 tests green.");
    const line = notifyLine(builder.view().threadId!, { status: "completed", text: "Ran the gate.\nAll 12 tests green." }, "whole");
    await vi.waitFor(() => expect(h.steered).toEqual([line, line]));
    const told = (await rt.sessions.history(box.id)).filter(e => e.type === "session.notify");
    expect(told.map(e => e.notify)).toEqual([orchestrator.view().threadId, reviewer.view().threadId]);
    expect(told.map(e => e.text)).toEqual([line, line]);
    h.end(0, "read it");
    h.end(1, "read it");
    await rt.close();
  });

  it("a target whose thread is gone when the child ends falls back to the person, and the person is told once however many fell away", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const lead = await createOn(rt, { golden: "snap_g", name: "lead" });
    const box = await createOn(rt, { golden: "snap_g", name: "box" });
    const orchestrator = await rt.sessions.start(lead.id, { prompt: "orchestrate" });
    const builder = await rt.sessions.start(box.id, { prompt: "build it", notify: [orchestrator.view().threadId!, "me"], startedBy: "agent" });
    // The orchestrator's workspace is deleted while the builder works, so the thread the report was addressed to is
    // not there to take it.
    await rt.workspaces.delete(lead.id);
    h.end(1, "done");
    await vi.waitFor(async () => expect((await rt.sessions.history(box.id)).some(e => e.type === "session.notify")).toBe(true));
    const told = (await rt.sessions.history(box.id)).filter(e => e.type === "session.notify");
    expect(told.map(e => e.notify)).toEqual(["me"]);
    expect(told[0]!.text).toBe(notifyLine(builder.view().threadId!, { status: "completed", text: "done" }));
    expect(h.steered).toEqual([]);
    await rt.close();
  });

  it("a target list never holds the sender: its own thread by id or through me is refused, and a target named twice is one target", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const one = await rt.sessions.start(ws.id, { prompt: "one" });
    const oneThread = one.view().threadId!;
    const token = h.envs[0]![TURN_TOKEN_ENV]!;
    await expect(rt.sessions.start(ws.id, { prompt: "again", thread: oneThread, notify: [oneThread] })).rejects.toThrow("a thread cannot notify itself");
    await expect(rt.sessions.start(ws.id, { prompt: "again", thread: oneThread, notify: ["me"], turnToken: token })).rejects.toThrow("a thread cannot notify itself");
    expect(h.starts).toHaveLength(1);
    // Named twice is told once: a list is a set of targets, not a count of them.
    const two = await rt.sessions.start(ws.id, { prompt: "two", notify: [oneThread, oneThread], startedBy: "agent" });
    h.end(1, "done");
    const line = notifyLine(two.view().threadId!, { status: "completed", text: "done" }, "whole");
    await vi.waitFor(() => expect(h.steered).toEqual([line]));
    expect((await rt.sessions.history(ws.id)).filter(e => e.type === "session.notify")).toHaveLength(1);
    h.end(0, "read it");
    await rt.close();
  });

  it("the line into a thread carries the final message whole; the person's stays its last line", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: [parent.view().threadId!], startedBy: "agent" });
    const mine = await rt.sessions.start(ws.id, { prompt: "build mine", notify: ["me"] });
    const report: TurnResult = { status: "completed", text: "Ran the gate.\n\nAll 12 tests green.\n", durationMs: 492_000, costUsd: 1.94 };
    h.end(1, report.text!, { durationMs: report.durationMs, costUsd: report.costUsd });
    h.end(2, report.text!, { durationMs: report.durationMs, costUsd: report.costUsd });
    const whole = notifyLine(kid.view().threadId!, report, "whole");
    expect(whole).toContain("Ran the gate.\n\nAll 12 tests green.");
    await vi.waitFor(() => expect(h.steered).toEqual([whole]));
    const told = (await rt.sessions.history(ws.id)).filter(e => e.type === "session.notify");
    expect(told.find(e => e.notify === parent.view().threadId)!.text).toBe(whole);
    expect(told.find(e => e.notify === "me")!.text).toBe(notifyLine(mine.view().threadId!, report));
    h.end(0, "read it");
    await rt.close();
  });
});
