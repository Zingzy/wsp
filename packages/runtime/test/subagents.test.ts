// SPDX-License-Identifier: AGPL-3.0-only
// An agent's own subagents, all the way through the runtime: each start and end
// written once into the transcript, the children a listing stamps on the row
// they ran under and keeps after the turn, a replay after a host restart that
// writes nothing twice, a child forgotten once its rows leave the ring, a
// subagent's long text clipped where its lead's is not, and a stop of one child
// that reaches that child alone. The harness is a fake run whose log an attach
// replays from its first event, so the runtime's own bookkeeping is what is
// under test.
import { describe, expect, it } from "vitest";
import { foldThreads, type AdapterEvent, type HarnessCatalogAnswer, type SessionEvent, type TaskStop, type TurnResult } from "@wsp/protocol";
import { createRuntime, TOOL_RESULT_KEPT, TRANSCRIPT_BYTES, type HarnessAdapterFactory, type HarnessSession } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { createOn, stubBackend, type StubBackend } from "./stub-backend.js";
import { until } from "./until.js";

interface Run {
  log: AdapterEvent[];
  sessionId: string;
  live?: (event: AdapterEvent) => void;
  settle?: (result: TurnResult) => void;
  result?: TurnResult;
}

/** A harness whose runs live on the machine: an attach replays a run's log from its first event, as reading a guest's
 * log from byte zero does. Each run stops its subagents through `stops`, which the test sets per case. */
function machineRuns(stops?: (task: string) => Promise<TaskStop>, probed?: HarnessCatalogAnswer) {
  const runs = new Map<string, Run>();
  const asked: string[] = [];
  /** The agent version each start was handed, in order. */
  const versions: (string | undefined)[] = [];
  let minted = 0;
  const deliver = (run: Run, event: AdapterEvent): void => {
    if (event.type === "turn.done") run.result = event.result;
    run.live?.(event);
    if (event.type === "session.end") run.settle?.(run.result ?? { status: "failed" });
  };
  const open = (run: Run, handle: string, onEvent: (event: AdapterEvent) => void, localId: string): HarnessSession => {
    const finished = new Promise<TurnResult>(resolve => {
      run.settle = resolve;
    });
    run.live = onEvent;
    return {
      localId,
      run: handle,
      finished,
      interrupt: async () => {
        deliver(run, { type: "turn.done", sessionId: run.sessionId, result: { status: "interrupted" } });
        deliver(run, { type: "session.end", sessionId: run.sessionId, exitCode: null, sawResult: true });
      },
      ...(stops !== undefined
        ? {
            stopTask: (task: string) => {
              asked.push(task);
              return stops(task);
            },
          }
        : {}),
    };
  };
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    ...(probed !== undefined ? { probeCatalog: async () => probed } : {}),
    start: o => {
      versions.push(o.version);
      const handle = `/tmp/wsp-run/${(++minted).toString(16).padStart(12, "0")}`;
      const run: Run = { log: [], sessionId: o.resume ?? `sess-${minted}` };
      runs.set(handle, run);
      const session = open(run, handle, o.onEvent, `local-${minted}`);
      queueMicrotask(() => emit(handle, { type: "session.start", sessionId: run.sessionId, cwd: "/root/work" }));
      return session;
    },
    attach: async o => {
      const run = runs.get(o.run);
      if (run === undefined) return "gone";
      const session = open(run, o.run, o.onEvent, o.sessionId);
      const replayed = [...run.log];
      queueMicrotask(() => {
        for (const event of replayed) deliver(run, event);
      });
      return session;
    },
  });
  const emit = (handle: string, event: AdapterEvent): void => {
    const run = runs.get(handle)!;
    run.log.push(event);
    deliver(run, event);
  };
  /** A line of the run's log the host reading it as it ran did not record: what a host from before an event existed
   * left behind, which the next host reads on its replay. */
  const logOnly = (handle: string, event: AdapterEvent): void => void runs.get(handle)!.log.push(event);
  return { adapter, emit, logOnly, handles: () => [...runs.keys()], asked, versions };
}

const started = (task: string, sessionId: string, title = `count ${task}`): AdapterEvent => ({ type: "subagent", sessionId, task, state: "running", parentToolUseId: `toolu_${task}`, title, depth: 1 });
const ended = (task: string, sessionId: string, state: "done" | "stopped" | "failed", summary?: string): AdapterEvent => ({ type: "subagent", sessionId, task, state, parentToolUseId: `toolu_${task}`, ...(summary !== undefined ? { summary } : {}) });
const reply = (h: ReturnType<typeof machineRuns>, run: string, sessionId: string): void => {
  h.emit(run, { type: "turn.done", sessionId, result: { status: "completed", text: "both replied" } });
  h.emit(run, { type: "session.end", sessionId, exitCode: 0, sawResult: true });
};
const subagentRows = (events: readonly SessionEvent[]) => events.filter(e => e.type === "session.subagent");

async function begin(h: ReturnType<typeof machineRuns>, store: Store = memoryStore(), backend: StubBackend = stubBackend()) {
  const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
  const ws = await createOn(rt, { golden: "snap_g", name: "a" });
  const handle = await rt.sessions.start(ws.id, { prompt: "fan out" });
  await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.start"));
  return { rt, ws, handle, run: h.handles().at(-1)!, store, backend };
}

describe("an agent's own subagents as children of its thread", () => {
  it("a running row lists its children as they start and end, and keeps them once the turn settles", async () => {
    const h = machineRuns();
    const { rt, ws, run } = await begin(h);
    h.emit(run, started("a1", "sess-1"));
    h.emit(run, started("b2", "sess-1"));
    await until(async () => (await rt.sessions.list(ws.id))[0]!.subagents?.length === 2);
    const [row] = await rt.sessions.list(ws.id);
    expect(row!.subagents).toEqual([
      { id: "a1", title: "count a1", state: "running", parentToolUseId: "toolu_a1", depth: 1, startedAt: expect.any(Number) },
      { id: "b2", title: "count b2", state: "running", parentToolUseId: "toolu_b2", depth: 1, startedAt: expect.any(Number) },
    ]);
    h.emit(run, ended("a1", "sess-1", "done", "30"));
    await until(async () => (await rt.sessions.list(ws.id))[0]!.subagents?.[0]?.state === "done");
    expect((await rt.sessions.list(ws.id))[0]!.subagents?.[0]).toMatchObject({ id: "a1", state: "done", endedAt: expect.any(Number) });
    reply(h, run, "sess-1");
    await until(async () => (await rt.sessions.list(ws.id))[0]!.status === "completed");
    const settled = await rt.sessions.list(ws.id);
    // The child the turn left running went with it, and both stay under the thread as a finished child thread does.
    expect(settled[0]!.subagents?.map(c => [c.id, c.state])).toEqual([["a1", "done"], ["b2", "stopped"]]);
    expect(foldThreads(settled)[0]!.subagents?.map(c => c.id)).toEqual(["a1", "b2"]);
    // Two rows a child, its start and its end, whatever the turn's own end says of the one it left running.
    const rows = subagentRows(await rt.sessions.history(ws.id));
    expect(rows.map(e => [e.task, e.state])).toEqual([["a1", "running"], ["b2", "running"], ["a1", "done"]]);
    // The prompt is the launching call's own input, which its tool_use delta already carries: the row holds no copy.
    expect(rows[0]).toMatchObject({ title: "count a1", parentToolUseId: "toolu_a1", depth: 1 });
    expect(rows[0]).not.toHaveProperty("prompt");
    expect(rows[2]).toMatchObject({ summary: "30" });
    await rt.close();
  });

  it("every turn's children stay under the thread, an earlier turn's beside the running one's", async () => {
    const h = machineRuns();
    const { rt, ws, run } = await begin(h);
    h.emit(run, started("a1", "sess-1"));
    h.emit(run, ended("a1", "sess-1", "done"));
    reply(h, run, "sess-1");
    await until(async () => (await rt.sessions.list(ws.id))[0]!.status === "completed");
    const thread = foldThreads(await rt.sessions.list(ws.id))[0]!;
    await rt.sessions.start(ws.id, { prompt: "again", thread: thread.id });
    await until(async () => h.handles().length === 2);
    const second = h.handles()[1]!;
    h.emit(second, started("c3", "sess-1"));
    await until(async () => foldThreads(await rt.sessions.list(ws.id))[0]!.subagents?.length === 2);
    expect(foldThreads(await rt.sessions.list(ws.id))[0]!.subagents?.map(c => [c.id, c.state])).toEqual([["a1", "done"], ["c3", "running"]]);
    await rt.close();
  });

  it("a run re-read after a restart writes no second row for a change already written, and one for a change made while the host was down", async () => {
    const h = machineRuns();
    const store = memoryStore();
    const backend = stubBackend();
    const { rt, ws, run } = await begin(h, store, backend);
    h.emit(run, started("a1", "sess-1"));
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: "counting", parentToolUseId: "toolu_a1" });
    h.emit(run, started("b2", "sess-1"));
    await until(async () => subagentRows(await rt.sessions.history(ws.id)).length === 2);
    await rt.close();
    // The host is down while A finishes.
    h.emit(run, ended("a1", "sess-1", "done"));

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    await until(async () => subagentRows(await rt2.sessions.history(ws.id)).length === 3);
    h.emit(run, ended("b2", "sess-1", "done"));
    await until(async () => subagentRows(await rt2.sessions.history(ws.id)).length === 4);
    const history = await rt2.sessions.history(ws.id);
    expect(subagentRows(history).map(e => [e.task, e.state])).toEqual([["a1", "running"], ["b2", "running"], ["a1", "done"], ["b2", "done"]]);
    expect(history.filter(e => e.type === "session.delta").map(e => e.text)).toEqual(["counting"]);
    expect((await rt2.sessions.list(ws.id))[0]!.subagents?.map(c => [c.id, c.state])).toEqual([["a1", "done"], ["b2", "done"]]);
    await rt2.close();
  });

  it("a run a host from before subagents were recorded wrote is re-read with its children and no delta twice", async () => {
    const h = machineRuns();
    const store = memoryStore();
    const backend = stubBackend();
    const { rt, ws, run } = await begin(h, store, backend);
    // That host recorded the deltas and not the subagent lines between them.
    h.logOnly(run, started("a1", "sess-1"));
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: "one", parentToolUseId: "toolu_a1" });
    h.logOnly(run, started("b2", "sess-1"));
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: "two", parentToolUseId: "toolu_b2" });
    await until(async () => (await rt.sessions.history(ws.id)).filter(e => e.type === "session.delta").length === 2);
    await rt.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    await until(async () => subagentRows(await rt2.sessions.history(ws.id)).length === 2);
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: "three", parentToolUseId: "toolu_a1" });
    await until(async () => (await rt2.sessions.history(ws.id)).filter(e => e.type === "session.delta").length === 3);
    const history = await rt2.sessions.history(ws.id);
    expect(history.filter(e => e.type === "session.delta").map(e => e.text)).toEqual(["one", "two", "three"]);
    expect(subagentRows(history).map(e => [e.task, e.state])).toEqual([["a1", "running"], ["b2", "running"]]);
    await rt2.close();
  });

  it("a resumed child stays while its second start row is in the ring, though its first has left", async () => {
    const h = machineRuns();
    const { rt, ws, run } = await begin(h);
    const chunk = "x".repeat(Math.ceil(TRANSCRIPT_BYTES / 4));
    h.emit(run, started("a1", "sess-1"));
    h.emit(run, ended("a1", "sess-1", "done"));
    for (let i = 0; i < 3; i++) h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: chunk });
    // The agent sends the finished child a message and it runs again under the same id.
    h.emit(run, started("a1", "sess-1"));
    for (let i = 0; i < 2; i++) h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: chunk });
    await until(async () => subagentRows(await rt.sessions.history(ws.id)).length === 1);
    expect((await rt.sessions.list(ws.id))[0]!.subagents?.map(c => [c.id, c.state])).toEqual([["a1", "running"]]);
    await rt.close();
  });

  it("each start is handed the version the agent's binary answered the probe with, and none where it answered nothing", async () => {
    const probe: HarnessCatalogAnswer = { version: "2.1.288", models: [], efforts: [], permissionModes: [] };
    const told = machineRuns(undefined, probe);
    const one = await begin(told);
    expect(told.versions).toEqual(["2.1.288"]);
    await one.rt.close();
    const silent = machineRuns(undefined, null);
    const two = await begin(silent);
    expect(silent.versions).toEqual([undefined]);
    await two.rt.close();
  });

  it("a child whose rows the transcript's ring dropped is gone from the next listing", async () => {
    const h = machineRuns();
    const { rt, ws, run } = await begin(h);
    h.emit(run, started("a1", "sess-1"));
    h.emit(run, ended("a1", "sess-1", "done"));
    await until(async () => (await rt.sessions.list(ws.id))[0]!.subagents?.length === 1);
    // The lead's own words are clipped nowhere, so five of these push everything before them out of the ring.
    const chunk = "x".repeat(Math.ceil(TRANSCRIPT_BYTES / 4));
    for (let i = 0; i < 5; i++) h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: chunk });
    await until(async () => !subagentRows(await rt.sessions.history(ws.id)).some(e => e.task === "a1"));
    expect((await rt.sessions.list(ws.id))[0]!.subagents ?? []).toEqual([]);
    await rt.close();
  });

  it("a subagent's text and thinking are clipped where a tool result is, and the lead's own are not", async () => {
    const h = machineRuns();
    const { rt, ws, run } = await begin(h);
    const long = "y".repeat(TOOL_RESULT_KEPT + 500);
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "thinking", text: long, parentToolUseId: "toolu_a1" });
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: long, parentToolUseId: "toolu_a1" });
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: long });
    await until(async () => (await rt.sessions.history(ws.id)).filter(e => e.type === "session.delta").length === 3);
    const deltas = (await rt.sessions.history(ws.id)).filter(e => e.type === "session.delta");
    expect(deltas.map(d => d.text.length)).toEqual([TOOL_RESULT_KEPT, TOOL_RESULT_KEPT, long.length]);
    await rt.close();
  });
});

describe("one subagent stopped by itself", () => {
  it("reaches the harness's stop for that child alone, and the turn and its sibling run on", async () => {
    const h = machineRuns(async () => ({ outcome: "accepted" }));
    const { rt, ws, handle, run } = await begin(h);
    h.emit(run, started("a1", "sess-1"));
    h.emit(run, started("b2", "sess-1"));
    expect(await rt.sessions.interrupt(handle.id, undefined, "a1")).toEqual({ outcome: "accepted" });
    expect(h.asked).toEqual(["a1"]);
    h.emit(run, ended("a1", "sess-1", "stopped"));
    await until(async () => (await rt.sessions.list(ws.id))[0]!.subagents?.[0]?.state === "stopped");
    const [row] = await rt.sessions.list(ws.id);
    expect(row!.status).toBe("running");
    expect(row!.subagents?.map(c => [c.id, c.state])).toEqual([["a1", "stopped"], ["b2", "running"]]);
    await rt.close();
  });

  it("a refusal comes back in the agent's words with the task named, and a harness with no such stop says so", async () => {
    const h = machineRuns(async task => ({ outcome: "refused", error: `No task found with ID: ${task}` }));
    const { rt, handle } = await begin(h);
    expect(await rt.sessions.interrupt(handle.id, undefined, "zz9")).toEqual({ outcome: "refused", error: "Claude Code would not stop it: No task found with ID: zz9" });
    await rt.close();

    const bare = machineRuns();
    const other = await begin(bare);
    expect(await other.rt.sessions.interrupt(other.handle.id, undefined, "a1")).toEqual({ outcome: "unsupported", error: "Stop is not available for Claude Code subagents; stop the thread to stop them all" });
    expect((await other.rt.sessions.list(other.ws.id))[0]!.status).toBe("running");
    await other.rt.close();
  });

  it("a turn that is over has no child to stop", async () => {
    const h = machineRuns(async () => ({ outcome: "accepted" }));
    const { rt, ws, handle, run } = await begin(h);
    reply(h, run, "sess-1");
    await until(async () => (await rt.sessions.list(ws.id))[0]!.status === "completed");
    expect(await rt.sessions.interrupt(handle.id, undefined, "a1")).toEqual({ outcome: "not-running" });
    expect(h.asked).toEqual([]);
    await rt.close();
  });
});
