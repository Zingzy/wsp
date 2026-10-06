// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NOTIFY_ME, SessionEvent, foldThreads, notifyLine, threadMessages, threadReplyRows, threadResult, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { until } from "./until.js";
import { stubBackend, createOn } from "./stub-backend.js";

describe("runtime session index", () => {
  /** One completed turn per start, under the resume id when given; remembers every start the harness was asked for. */
  const turns = () => {
    const starts: HarnessStartOptions[] = [];
    const adapter: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        starts.push(o);
        const sessionId = o.resume ?? randomUUID();
        const result: TurnResult = { status: "completed", text: o.prompt };
        const finished = Promise.resolve().then(() => {
          o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", cwd: o.cwd ?? "/root/work" });
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return result;
        });
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    return { adapter, starts };
  };
  /** Two behaviours under one agent, picked by the turn's own prompt: a thread runs on the agent its rows carry,
   * so a turn that hangs or dies before init is that agent's own turn doing it and not a second agent resuming
   * the session it wrote. */
  const onPrompt = (prompt: string, one: HarnessAdapterFactory, rest: HarnessAdapterFactory): HarnessAdapterFactory => (...args) => {
    const takes = one(...args);
    const every = rest(...args);
    return { ...every, start: o => (o.prompt === prompt ? takes.start(o) : every.start(o)) };
  };
  /** A turn that announces itself and never settles: the host goes down under it. */
  const HUNG_ID = "55555555-5555-4555-8555-555555555555";
  const hung: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      o.onEvent({ type: "session.start", sessionId: HUNG_ID, model: "claude-sonnet-4-5", cwd: "/root/work" });
      return { localId: HUNG_ID, finished: new Promise<TurnResult>(() => {}), interrupt: async () => {} };
    },
  });

  it("writes the index to the store and lists the rows after a restart; a turn the restart cut reads as ended", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const t = turns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: t.adapter, hung } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    await (await rt1.sessions.start(ws.id, { prompt: "first", cwd: "/root/app" })).finished;
    await rt1.sessions.start(ws.id, { prompt: "second", harness: "hung" });
    const before = await rt1.sessions.list(ws.id);
    expect(before.map(s => s.status)).toEqual(["completed", "running"]);
    await rt1.close();
    const stored = (await store.get("sessions", ws.id)) as { sessions: unknown[] };
    expect(stored.sessions).toHaveLength(2);

    const rt2 = createRuntime({ backend, store, adapters: {} });
    const after = await rt2.sessions.list(ws.id);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual({ ...before[0], threadId: before[0]!.threadId });
    expect(after[0]).toMatchObject({ status: "completed", prompt: "first", cwd: "/root/app", model: "claude-sonnet-4-5", harness: "claude" });
    expect(after[1]).toMatchObject({ id: HUNG_ID, prompt: "second", status: "failed", endedAt: expect.any(Number) });
    expect(after[1]!.threadId).toBe(before[1]!.threadId);
    const history = await rt2.sessions.history(ws.id);
    expect(history.at(-1)).toMatchObject({ type: "session.end", sessionId: HUNG_ID, threadId: before[1]!.threadId, reason: "host restarted while the agent was working" });
    expect(history.at(-1)!.turnId).toBe(history.at(-2)!.turnId);
    expect(await rt2.sessions.interrupt(HUNG_ID)).toEqual({ outcome: "not-running" });
    await rt2.close();
    // the cut turn is written back ended, so a second restart does not end it again
    const rt3 = createRuntime({ backend, store, adapters: {} });
    expect((await rt3.sessions.history(ws.id)).filter(e => e.type === "session.end")).toHaveLength(2);
    await rt3.close();
  });

  it("a resume after a turn the restart cut stamps afterCut on its start; the resume after that does not", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const t = turns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: t.adapter, hung } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    const thread = (await rt1.sessions.start(ws.id, { prompt: "first", harness: "hung" })).view().threadId!;
    await rt1.close();

    // The thread ran on hung and goes on running on hung: the agent a thread's rows carry is the one its next
    // turn runs on, and this host answers for it again after the restart.
    const rt2 = createRuntime({ backend, store, adapters: { claude: t.adapter, hung: t.adapter } });
    await (await rt2.sessions.start(ws.id, { prompt: "second", thread })).finished;
    await (await rt2.sessions.start(ws.id, { prompt: "third", thread })).finished;
    const starts = (await rt2.sessions.history(ws.id)).filter(e => e.type === "session.start");
    expect(starts.map(e => [e.prompt, e.afterCut])).toEqual([["first", undefined], ["second", true], ["third", undefined]]);
    expect(new Set(starts.map(e => e.threadId)).size).toBe(1);
    await rt2.close();
  });

  it("the start of the turn that opened its thread says so, a later one does not, and each says who opened the thread", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: turns().adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "first", harness: "claude", startedBy: "cli" });
    await first.finished;
    await (await rt.sessions.start(ws.id, { prompt: "second", thread: first.view().threadId!, startedBy: "agent" })).finished;
    const starts = (await rt.sessions.history(ws.id)).filter(e => e.type === "session.start");
    expect(starts.map(e => [e.prompt, e.opensThread, e.startedBy])).toEqual([
      ["first", true, "cli"],
      ["second", undefined, "cli"],
    ]);
    await rt.close();
  });

  /** A harness whose turn the transport cut, as the idle deadline does: a failed done, then an end with no exit code and
   * no result. Every other prompt is one completed turn. */
  const CUT_ID = "77777777-7777-4777-8777-777777777777";
  const cutting: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      const sessionId = o.resume ?? CUT_ID;
      const cut = o.prompt === "cut";
      const result: TurnResult = cut ? { status: "failed", error: "stopped after 15m 00s with no output for 10m" } : { status: "completed", text: o.prompt };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", cwd: "/root/work" });
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: cut ? null : 0, sawResult: !cut });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });

  it("a resume after a turn the transport cut stamps afterCut; a turn that failed with an exit code, or finished, leaves the next start plain", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: onPrompt("dies", dying, cutting) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const cut = await rt.sessions.start(ws.id, { prompt: "cut" });
    await cut.finished;
    const thread = cut.view().threadId!;
    await (await rt.sessions.start(ws.id, { prompt: "second", thread })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "third", thread })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "dies", thread })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "fifth", thread })).finished;
    const starts = (await rt.sessions.history(ws.id)).filter(e => e.type === "session.start");
    expect(starts.map(e => [e.prompt, e.afterCut])).toEqual([["cut", undefined], ["second", true], ["third", undefined], ["fifth", undefined]]);
    // a fresh thread has no previous turn
    await (await rt.sessions.start(ws.id, { prompt: "cut" })).finished;
    const opened = (await rt.sessions.history(ws.id)).filter(e => e.type === "session.start").at(-1);
    expect(opened).toMatchObject({ prompt: "cut" });
    expect(opened!.afterCut).toBeUndefined();
    await rt.close();
  });

  /** A harness that dies before init: only a done and an end, under the resume id or a fresh local one. */
  const dying: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      const localId = o.resume ?? randomUUID();
      const result: TurnResult = { status: "failed", error: "claude exited before init (exit code 1)" };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "turn.done", sessionId: localId, result });
        o.onEvent({ type: "session.end", sessionId: localId, exitCode: 1, sawResult: true });
        return result;
      });
      // The real adapter hands back its local id as claudeSessionId until init re-keys it; the row must not take it.
      return { localId, claudeSessionId: localId, finished, interrupt: async () => {} };
    },
  });

  it("a harness that dies before init leaves its row and the workspace without a session id: no harness announced one", async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: dying } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "first" });
    await handle.finished;
    const [row] = await rt.sessions.list(ws.id);
    expect(row).toMatchObject({ id: handle.id, status: "failed", prompt: "first", threadId: expect.any(String) });
    expect(row!.claudeSessionId).toBeUndefined();
    expect((await rt.workspaces.get(ws.id)).claudeSessionId).toBeUndefined();
    // the dead turn's events still carry the adapter's local id, so the row is found by its id, not by a session
    expect((await rt.sessions.history(ws.id)).map(e => e.sessionId)).toEqual([handle.id, handle.id]);
    await rt.close();
    const stored = (await store.get("sessions", ws.id)) as { sessions: { claudeSessionId?: string }[] };
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0]!.claudeSessionId).toBeUndefined();
  });

  it("a resumed turn that dies before init keeps the resume id on its row: the harness answered that id in an earlier turn", async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: onPrompt("again", dying, turns().adapter) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "first" })).finished;
    const [first] = await rt.sessions.list(ws.id);
    const resume = first!.claudeSessionId!;
    await (await rt.sessions.start(ws.id, { prompt: "again", thread: first!.threadId! })).finished;
    const rows = await rt.sessions.list(ws.id);
    expect(rows.map(r => [r.prompt, r.status, r.threadId, r.claudeSessionId])).toEqual([["first", "failed", first!.threadId, resume]]);
    await rt.close();
    const stored = (await store.get("sessions", ws.id)) as { sessions: { claudeSessionId?: string }[] };
    expect(stored.sessions.map(r => r.claudeSessionId)).toEqual([resume]);
  });

  it("a start naming a thread whose harness never announced a session runs the message as a first turn on that thread; named again, the thread is resumed; an unknown thread is refused", async () => {
    const starts: HarnessStartOptions[] = [];
    const bornDead: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        starts.push(o);
        const sessionId = o.resume ?? "33333333-3333-4333-8333-333333333333";
        if (starts.length === 1) {
          // The real adapter's local id for a turn that never announced a session, under which its events go.
          const localId = "local-dead";
          const result: TurnResult = { status: "failed", error: "the machine could not be reached from this computer after 6 attempts over 23s" };
          const finished = Promise.resolve().then(() => {
            o.onEvent({ type: "turn.done", sessionId: localId, result });
            o.onEvent({ type: "session.end", sessionId: localId, exitCode: null, sawResult: false });
            return result;
          });
          return { localId, finished, interrupt: async () => {} };
        }
        const result: TurnResult = { status: "completed", text: o.prompt };
        const finished = Promise.resolve().then(() => {
          o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return result;
        });
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: bornDead } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const other = await createOn(rt, { golden: "snap_g", name: "b" });
    const dead = await rt.sessions.start(ws.id, { prompt: "first" });
    expect((await dead.finished).status).toBe("failed");
    const thread = dead.view().threadId!;
    expect((await rt.sessions.list(ws.id)).map(r => [r.threadId, r.claudeSessionId])).toEqual([[thread, undefined]]);

    const again = await rt.sessions.start(ws.id, { prompt: "again", thread });
    expect((await again.finished).status).toBe("completed");
    expect(starts[1]!.resume).toBeUndefined();
    expect(again.view().threadId).toBe(thread);
    const rows = await rt.sessions.list(ws.id);
    expect(rows.map(r => [r.prompt, r.status, r.threadId])).toEqual([
      ["first", "failed", thread],
      ["again", "completed", thread],
    ]);
    const sessionId = rows[1]!.claudeSessionId!;

    const third = await rt.sessions.start(ws.id, { prompt: "more", thread });
    expect((await third.finished).status).toBe("completed");
    expect(starts[2]!.resume).toBe(sessionId);
    expect(third.view().threadId).toBe(thread);

    await expect(rt.sessions.start(ws.id, { prompt: "x", thread: "no-such-thread" })).rejects.toThrow("no thread no-such-thread on this workspace");
    await expect(rt.sessions.start(other.id, { prompt: "x", thread })).rejects.toThrow(`no thread ${thread} on this workspace`);
    expect(starts).toHaveLength(3);
  });

  it("a thread whose first turn is still reaching the machine is listed, running, under one row; a start that never opens leaves none", async () => {
    const backend = stubBackend();
    backend.execImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    const slow: HarnessAdapterFactory = ctx => ({ ...turns().adapter(ctx), probeCatalog: async () => (await probed, null) });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: slow } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const starting = rt.sessions.start(ws.id, { prompt: "build it", startedBy: "cli" });
    await until(async () => (await rt.sessions.list(ws.id)).length === 1);
    const [pending] = await rt.sessions.list(ws.id);
    expect(pending).toMatchObject({ workspaceId: ws.id, harness: "claude", status: "running", startedBy: "cli", prompt: "build it" });
    expect(foldThreads(await rt.sessions.list(ws.id))).toMatchObject([{ id: pending!.threadId, status: "running", turns: 1 }]);

    letProbe();
    const handle = await starting;
    expect(handle.view().threadId).toBe(pending!.threadId);
    expect((await handle.finished).status).toBe("completed");
    const rows = await rt.sessions.list(ws.id);
    expect(rows.map(r => [r.prompt, r.status, r.threadId])).toEqual([["build it", "completed", pending!.threadId]]);
    expect(rows[0]!.id).toBe(handle.id);
    await rt.close();
  });

  it("a second send inside that window writes no row of its own and waits: the turn still reaching the machine is the one a wait is waiting on, and this send's fate follows it", async () => {
    const backend = stubBackend();
    backend.execImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    const starts: string[] = [];
    const slow: HarnessAdapterFactory = ctx => ({
      ...turns().adapter(ctx),
      probeCatalog: async () => (await probed, null),
      start: o => {
        starts.push(o.prompt);
        if (o.prompt === "and this too") throw new Error("the harness would not launch");
        return turns().adapter(ctx).start(o);
      },
    });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: slow } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const ends: SessionEvent[] = [];
    rt.events.on("session.end", e => ends.push(e as SessionEvent));
    const first = rt.sessions.start(ws.id, { prompt: "build it" });
    await until(async () => (await rt.sessions.list(ws.id)).length === 1);
    const thread = (await rt.sessions.list(ws.id))[0]!.threadId!;

    // The thread is already spoken for by a turn no harness holds yet, so this one waits for it rather than
    // writing a row beside it and becoming the row every client folds the thread off.
    const second = rt.sessions.start(ws.id, { prompt: "and this too", thread });
    await new Promise(r => setTimeout(r, 50));
    const folded = foldThreads(await rt.sessions.list(ws.id));
    expect(await rt.sessions.list(ws.id)).toHaveLength(1);
    expect(folded).toMatchObject([{ id: thread, status: "running", turns: 1 }]);

    letProbe();
    const handle = await first;
    expect((await handle.finished).status).toBe("completed");
    await expect(second).rejects.toThrow("the harness would not launch");
    // The second send waited out the first turn and gave up only as the thread's next turn, resuming the session the
    // first announced: its end follows the first turn's own, so a wait following the thread for that turn got that
    // turn's fate and not this send's.
    expect(starts).toEqual(["build it", "and this too"]);
    expect(ends.map(e => [(e as { turnId?: string }).turnId === handle.turnId, (e as { reason?: string }).reason])).toEqual([
      [true, undefined],
      [false, "the harness would not launch"],
    ]);
    expect(foldThreads(await rt.sessions.list(ws.id))).toMatchObject([{ id: thread, status: "completed", cwd: ws.project.path, turns: 1 }]);
    await rt.close();
  });

  it.each([
    ["the same trips as the first", {}],
    ["its access named, which skips a trip the first turn still makes", { permissionMode: "bypassPermissions" }],
  ])("a send named at a thread while its first turn is still reaching the machine waits for that turn and resumes its session, with %s: one harness session per thread, sends taken as they reach the loop", async (_shape, extra) => {
    const backend = stubBackend();
    backend.execImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    const t = turns();
    const slow: HarnessAdapterFactory = ctx => ({ ...t.adapter(ctx), probeCatalog: async () => (await probed, null) });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: slow } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = rt.sessions.start(ws.id, { prompt: "A first" });
    await until(async () => (await rt.sessions.list(ws.id)).length === 1);
    const thread = (await rt.sessions.list(ws.id))[0]!.threadId!;
    const second = rt.sessions.start(ws.id, { prompt: "B second", thread, ...extra });
    await new Promise(r => setTimeout(r, 50));
    expect(t.starts).toEqual([]);

    letProbe();
    const a = await first;
    expect((await a.finished).status).toBe("completed");
    const b = await second;
    expect(b.outcome).toBe("queued");
    expect((await b.finished).status).toBe("completed");
    // The second send joins the session the first turn minted, which it could not have read when it arrived.
    expect(t.starts.map(s => [s.prompt, s.resume])).toEqual([
      ["A first", undefined],
      ["B second", a.view().claudeSessionId],
    ]);
    expect(foldThreads(await rt.sessions.list(ws.id))).toMatchObject([{ id: thread, status: "completed", turns: 1, claudeSessionId: a.view().claudeSessionId }]);
    await rt.close();
  });

  it("a send named at a thread while its first turn is still reaching the machine tells whoever that thread tells: the notify the opener registered is on the thread from its row, not from its launch", async () => {
    const backend = stubBackend();
    backend.execImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    const slow: HarnessAdapterFactory = ctx => ({ ...turns().adapter(ctx), probeCatalog: async () => (await probed, null) });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: slow } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = rt.sessions.start(ws.id, { prompt: "a", notify: [NOTIFY_ME] });
    await until(async () => (await rt.sessions.list(ws.id)).length === 1);
    const thread = (await rt.sessions.list(ws.id))[0]!.threadId!;
    const second = rt.sessions.start(ws.id, { prompt: "b", thread });
    await new Promise(r => setTimeout(r, 50));
    letProbe();
    const a = await first;
    const b = await second;
    await Promise.all([a.finished, b.finished]);
    // Both turns tell the person, since a send into the thread inherits what its opener registered whether it arrived
    // inside the launch window or after it.
    const told = (await rt.sessions.history(ws.id)).filter(e => e.type === "session.notify");
    expect(told.map(e => [e.turnId === a.turnId, (e as { text: string }).text])).toEqual([
      [true, notifyLine(thread, { status: "completed", text: "a" }, "tail")],
      [false, notifyLine(thread, { status: "completed", text: "b" }, "tail")],
    ]);
    await rt.close();
  });

  it("a row for a turn still reaching the machine never reaches the session file: another turn's write leaves it out, and a host reading that file back finds no turn to cut", async () => {
    const backend = stubBackend();
    backend.execImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
    const store = memoryStore();
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    const slow: HarnessAdapterFactory = ctx => ({ ...turns().adapter(ctx), probeCatalog: async () => (await probed, null) });
    const rt = createRuntime({ backend, store, adapters: { claude: slow, quick: turns().adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const starting = rt.sessions.start(ws.id, { prompt: "build it" });
    await until(async () => (await rt.sessions.list(ws.id)).length === 1);
    // Another thread on the workspace runs to its end while the first is still reaching the machine, and its turn
    // writes the workspace's session file.
    await (await rt.sessions.start(ws.id, { prompt: "quick one", harness: "quick" })).finished;
    const stored = async (): Promise<string[]> => (((await store.get("sessions", ws.id)) as { sessions: { prompt?: string }[] } | undefined)?.sessions ?? []).map(r => r.prompt!);
    await until(async () => (await stored()).includes("quick one"));
    expect(await stored()).toEqual(["quick one"]);
    // What a host reading that file back sees: no running row with nothing behind it, so no turn to settle as cut.
    const again = createRuntime({ backend, store, adapters: { claude: turns().adapter, quick: turns().adapter } });
    expect((await again.sessions.list(ws.id)).map(r => [r.prompt, r.status])).toEqual([["quick one", "completed"]]);
    expect((await again.sessions.history(ws.id)).filter(e => e.type === "session.end")).toHaveLength(1);
    await again.close();

    letProbe();
    expect((await (await starting).finished).status).toBe("completed");
    await rt.close();
  });

  it("a start whose harness will not open sends its turn's end with the reason and leaves no row: nobody waits on a turn that is not coming", async () => {
    const refusing: HarnessAdapterFactory = () => ({
      steers: false,
      start: () => {
        throw new Error("the harness would not launch");
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: refusing } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const ends: SessionEvent[] = [];
    rt.events.on("session.end", e => ends.push(e as SessionEvent));
    await expect(rt.sessions.start(ws.id, { prompt: "build it" })).rejects.toThrow("the harness would not launch");
    expect(ends).toMatchObject([{ reason: "the harness would not launch", exitCode: null, sawResult: false }]);
    // No turn ran, so the thread is on no listing and the transcript holds nothing of it either; the end is a wake
    // for whoever the row had already told this thread was working, and the reason rides that end.
    expect(await rt.sessions.list(ws.id)).toEqual([]);
    expect(await rt.sessions.history(ws.id)).toEqual([]);
    await rt.close();
  });

  it("a send that never launches leaves the thread's last turn exactly as it was: the row, the read and the reply all still say what that turn came to", async () => {
    const starts: string[] = [];
    const oneThenNothing: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        starts.push(o.prompt);
        if (starts.length > 1) throw new Error("the harness would not launch");
        const sessionId = randomUUID();
        const result: TurnResult = { status: "completed", text: "all green" };
        const finished = Promise.resolve().then(() => {
          o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", cwd: "/root/app" });
          o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: "all green" });
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return result;
        });
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: oneThenNothing } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "build it" });
    await first.finished;
    const thread = first.view().threadId!;
    expect(threadResult(await rt.sessions.history(ws.id), thread)).toEqual({ status: "completed", text: "all green" });

    await expect(rt.sessions.start(ws.id, { prompt: "and then this", thread })).rejects.toThrow("the harness would not launch");
    const after = await rt.sessions.history(ws.id);
    // One fact, how the thread's last turn went, read the four ways every client reads it; the send that never
    // opened is on none of them, since it never became a turn.
    expect(after.map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end"]);
    expect(threadResult(after, thread)).toEqual({ status: "completed", text: "all green" });
    expect(threadReplyRows(after, thread).map(m => m.text)).toEqual(["all green"]);
    expect(threadMessages(after, thread).map(m => m.text)).toEqual(["build it", "all green", "completed"]);
    expect(foldThreads(await rt.sessions.list(ws.id))).toMatchObject([{ id: thread, status: "completed", turns: 1 }]);
    await rt.close();
  });

  it("a message the running turn steers takes no row of its own: the thread keeps one turn, and its facts stay the running turn's", async () => {
    const steering: HarnessAdapterFactory = () => ({
      steers: true,
      start: o => {
        const sessionId = o.resume ?? randomUUID();
        queueMicrotask(() => o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", cwd: "/root/app" }));
        return { localId: sessionId, finished: new Promise<TurnResult>(() => {}), interrupt: async () => {}, steer: async () => "accepted" as const };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: steering } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const running = await rt.sessions.start(ws.id, { prompt: "build it" });
    const thread = running.view().threadId!;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.claudeSessionId !== undefined);
    const joined = await rt.sessions.start(ws.id, { prompt: "and this too", thread });
    expect(joined.outcome).toBe("steered");
    expect(foldThreads(await rt.sessions.list(ws.id))).toMatchObject([{ id: thread, status: "running", sessionId: running.id, cwd: "/root/app", turns: 1 }]);
    await rt.close();
  });

  it("a send that queues behind a running turn writes no second row: the thread's state, folder and stop stay the running turn's", async () => {
    const opened: ((r: TurnResult) => void)[] = [];
    const holding: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        const sessionId = o.resume ?? randomUUID();
        queueMicrotask(() => o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", cwd: "/root/app" }));
        let end!: (r: TurnResult) => void;
        const finished = new Promise<TurnResult>(r => {
          end = result => {
            o.onEvent({ type: "turn.done", sessionId, result });
            o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
            r(result);
          };
        });
        opened.push(end);
        return { localId: sessionId, finished, interrupt: async () => end({ status: "interrupted" }) };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: holding } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const running = await rt.sessions.start(ws.id, { prompt: "build it" });
    const thread = running.view().threadId!;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.claudeSessionId !== undefined);
    const queued = rt.sessions.start(ws.id, { prompt: "and then this", thread });
    await new Promise(r => setTimeout(r, 50));
    // The thread reads as its running turn does, and the row a client would stop is that turn's, not the queued one's.
    const folded = foldThreads(await rt.sessions.list(ws.id));
    expect(folded).toMatchObject([{ id: thread, status: "running", sessionId: running.id, cwd: "/root/app", turns: 1 }]);
    expect(await rt.sessions.interrupt(folded[0]!.sessionId)).toEqual({ outcome: "accepted" });

    const second = await queued;
    expect(second.outcome).toBe("queued");
    expect(second.view().threadId).toBe(thread);
    opened[1]!({ status: "completed", text: "second done" });
    await second.finished;
    // The queued turn resumed the first one's harness session, so it took over its row, as every resume does.
    expect(foldThreads(await rt.sessions.list(ws.id))).toMatchObject([{ id: thread, status: "completed", turns: 1 }]);
    await rt.close();
  });

  it("a resume after a restart joins the persisted thread and hands the harness the session id and folder", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: { claude: turns().adapter } });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    await (await rt1.sessions.start(ws.id, { prompt: "first", cwd: "/root/app" })).finished;
    const [first] = await rt1.sessions.list(ws.id);
    await rt1.close();
    // the transcript is gone but the index survives: the thread still folds
    await store.deleteBlob("transcripts", ws.id);

    const t = turns();
    const rt2 = createRuntime({ backend, store, adapters: { claude: t.adapter } });
    await (await rt2.sessions.start(ws.id, { prompt: "more", thread: first!.threadId!, cwd: first!.cwd })).finished;
    expect(t.starts[0]).toMatchObject({ resume: first!.claudeSessionId, cwd: "/root/app" });
    // the resumed turn keeps the session id, so it takes over that row and its opening prompt, in memory and in the store
    const rows = await rt2.sessions.list(ws.id);
    expect(rows.map(s => s.prompt)).toEqual(["first"]);
    expect(rows[0]!.threadId).toBe(first!.threadId);
    await rt2.close();
    const stored = (await store.get("sessions", ws.id)) as { sessions: { prompt: string; threadId: string }[] };
    expect(stored.sessions.map(s => s.prompt)).toEqual(["first"]);
    expect(stored.sessions[0]!.threadId).toBe(first!.threadId);
  });

  it("rows of a workspace whose machine is gone are still listed, and a deleted workspace takes its rows with it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: { claude: turns().adapter } });
    const a = await createOn(rt1, { golden: "snap_g", name: "a" });
    const b = await createOn(rt1, { golden: "snap_g", name: "b" });
    await (await rt1.sessions.start(a.id, { prompt: "on a" })).finished;
    await (await rt1.sessions.start(b.id, { prompt: "on b" })).finished;
    await rt1.close();
    backend.machines[0]!.killed = true;

    const rt2 = createRuntime({ backend, store, adapters: {} });
    await until(async () => (await rt2.workspaces.get(a.id)).phase === "gone");
    expect((await rt2.sessions.list(a.id)).map(s => s.prompt)).toEqual(["on a"]);
    expect((await rt2.status.list()).find(w => w.id === a.id)?.machineState).toBe("gone");
    await rt2.workspaces.delete(b.id);
    expect(await rt2.sessions.list()).toHaveLength(1);
    expect(await store.get("sessions", b.id)).toBeUndefined();
    await rt2.close();
  });

  it("a resume runs in the folder its session started in, whatever folder the request names or none", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const t = turns();
    const rt = createRuntime({ backend, store, adapters: { claude: t.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "first", cwd: "/root/app" })).finished;
    const [first] = await rt.sessions.list(ws.id);
    await (await rt.sessions.start(ws.id, { prompt: "from another folder", thread: first!.threadId!, cwd: "/root/other" })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "from the command line", thread: first!.threadId! })).finished;
    expect(t.starts.map(s => s.cwd)).toEqual(["/root/app", "/root/app", "/root/app"]);
    expect((await rt.sessions.list(ws.id)).map(s => s.cwd)).toEqual(["/root/app"]);
    // a start without a thread still runs where it was asked to
    await (await rt.sessions.start(ws.id, { prompt: "new thread", cwd: "/root/other" })).finished;
    expect(t.starts[3]!.cwd).toBe("/root/other");
    await rt.close();

    // the index is gone but the transcript keeps the start: the folder still comes from it
    await store.delete("sessions", ws.id);
    const t2 = turns();
    const rt2 = createRuntime({ backend, store, adapters: { claude: t2.adapter } });
    await (await rt2.sessions.start(ws.id, { prompt: "after a restart", thread: first!.threadId!, cwd: "/root/other" })).finished;
    expect(t2.starts[0]!.cwd).toBe("/root/app");
    await rt2.close();
  });

  it("a workspace deleted while a turn runs gets no document written back when the harness settles", async () => {
    const store = memoryStore();
    let settle!: (result: TurnResult) => void;
    const pending: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        o.onEvent({ type: "session.start", sessionId: HUNG_ID, model: "claude-sonnet-4-5", cwd: "/root/work" });
        return { localId: HUNG_ID, finished: new Promise<TurnResult>(r => (settle = r)), interrupt: async () => {} };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: pending } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "slow" });
    await rt.workspaces.delete(ws.id);
    expect(await store.get("sessions", ws.id)).toBeUndefined();
    // the real adapter settles when its exec stream dies, which can be after kill() returned
    settle({ status: "failed", text: "" });
    await new Promise(r => setImmediate(r));
    await rt.close();
    expect(await store.list("sessions")).toEqual([]);
  });

  it("a sessions document without a rows array is logged and read as empty; the runtime still boots", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt1, { golden: "snap_g", name: "a" });
    await rt1.close();
    await store.put("sessions", ws.id, { workspaceId: ws.id });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt2 = createRuntime({ backend, store, adapters: {} });
      expect((await rt2.workspaces.list()).map(w => w.id)).toEqual([ws.id]);
      expect(await rt2.sessions.list(ws.id)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(ws.id));
      await rt2.close();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps at most 200 rows per workspace: the oldest finished row falls off first, a running row never does", { timeout: 20_000 }, async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: turns().adapter, hung } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "stuck", harness: "hung" });
    // Named: a start with no agent would take the hung one the first start left on the project.
    for (let i = 0; i < 199; i++) await (await rt.sessions.start(ws.id, { prompt: `t${i}`, harness: "claude" })).finished;
    const full = await rt.sessions.list(ws.id);
    expect(full).toHaveLength(200);
    expect(full.slice(0, 2).map(s => s.prompt)).toEqual(["stuck", "t0"]);
    await (await rt.sessions.start(ws.id, { prompt: "t199", harness: "claude" })).finished;
    const rows = await rt.sessions.list(ws.id);
    expect(rows.map(s => s.prompt)).toEqual(["stuck", ...Array.from({ length: 199 }, (_, i) => `t${i + 1}`)]);
    await rt.close();
    const stored = (await store.get("sessions", ws.id)) as { sessions: { prompt: string }[] };
    expect(stored.sessions.map(s => s.prompt)).toEqual(rows.map(s => s.prompt));
  });
});
