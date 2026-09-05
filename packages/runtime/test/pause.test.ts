// SPDX-License-Identifier: AGPL-3.0-only
// A pause is a phase of its own: pausing is persisted and pushed before the
// provider is asked, sends are refused from then on, and every live session
// of the workspace ends with a reason the timeline shows as its last row. The
// same ending runs on delete and when the reach tracker calls the machine a
// zombie (its retry budget, measured: minutes of silence plus a failed probe).
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent } from "@wsp/adapter-claude";
import type { EventUnion, SessionEvent } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { wsRequest } from "./ws-client.js";

const PAUSED = "machine paused while the agent was working";

/** A harness whose turn never ends on its own: interrupt ends it the way the CLI would, with a session.end of its own. */
function hangingAdapter() {
  const emitters = new Map<string, (e: AdapterEvent) => void>();
  const interrupts: string[] = [];
  let n = 0;
  const factory: HarnessAdapterFactory = ({ workspaceId }) => ({
    start: ({ onEvent }) => {
      const sessionId = `sess-${++n}`;
      emitters.set(workspaceId, onEvent);
      let settle: (r: { status: "interrupted" }) => void = () => {};
      const finished = new Promise<{ status: "interrupted" }>(resolve => (settle = resolve));
      onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
      onEvent({ type: "turn.delta", sessionId, kind: "text", text: "working" });
      return {
        localId: sessionId,
        claudeSessionId: sessionId,
        finished,
        interrupt: async () => {
          interrupts.push(workspaceId);
          onEvent({ type: "turn.done", sessionId, result: { status: "interrupted" } });
          onEvent({ type: "session.end", sessionId, exitCode: 143, sawResult: false });
          settle({ status: "interrupted" });
        },
      };
    },
  });
  const emit = (workspaceId: string, e: AdapterEvent): void => emitters.get(workspaceId)!(e);
  return { factory, interrupts, emit };
}

function holdable<T>(): { promise: Promise<T>; release: (v: T) => void } {
  let release: (v: T) => void = () => {};
  const promise = new Promise<T>(resolve => (release = resolve));
  return { promise, release };
}

const ends = (events: EventUnion[]): Extract<SessionEvent, { type: "session.end" }>[] =>
  events.filter((e): e is Extract<SessionEvent, { type: "session.end" }> => e.type === "session.end");

describe("nap phase order", () => {
  it("persists and pushes pausing before the provider pause, napping after, and a read mid-pause says pausing", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const pushed: string[] = [];
    rt.events.on("workspace.status", e => e.type === "workspace.status" && pushed.push(`${e.status.phase}/${e.status.machineState}/${e.status.reach.state}`));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    const m = backend.machines[0]!;
    const pause = m.pause.bind(m);
    let midPause: { stored: string; read: string; pushed: string[] } | undefined;
    m.pause = async () => {
      midPause = { stored: (await store.get("workspaces", ws.id) as { phase: string }).phase, read: (await rt.workspaces.get(ws.id)).phase, pushed: [...pushed] };
      await pause();
    };
    const napped = await rt.workspaces.nap(ws.id);
    expect(midPause).toEqual({ stored: "pausing", read: "pausing", pushed: ["pausing/running/napping"] });
    expect(napped.phase).toBe("napping");
    expect(pushed).toEqual(["pausing/running/napping", "napping/paused/napping"]);
    expect((await store.get("workspaces", ws.id) as { phase: string }).phase).toBe("napping");
  });

  it("a pause the provider refuses goes back to running with the error on the pushed status, its sessions untouched", async () => {
    const backend = stubBackend();
    const { factory } = hangingAdapter();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: factory } });
    const pushed: EventUnion[] = [];
    rt.events.on("*", e => pushed.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    backend.machines[0]!.pause = async () => {
      throw new Error("provider down");
    };
    await expect(rt.workspaces.nap(ws.id)).rejects.toThrow("provider down");
    expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
    expect(pushed.some(e => e.type === "session.end")).toBe(false);
    expect(handle.view().status).toBe("running");
    expect(pushed.filter(e => e.type === "workspace.status").map(e => e.type === "workspace.status" && [e.status.phase, e.status.reason])).toEqual([["pausing", undefined], ["running", "provider down"]]);
  });

  it("a wake asked during the pause waits for it and then wakes; a second nap joins the first", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    const m = backend.machines[0]!;
    const gate = holdable<void>();
    const pause = m.pause.bind(m);
    m.pause = async () => {
      await gate.promise;
      await pause();
    };
    const first = rt.workspaces.nap(ws.id);
    await until(async () => (await rt.workspaces.get(ws.id)).phase === "pausing");
    const second = rt.workspaces.nap(ws.id);
    const waking = rt.workspaces.wake(ws.id);
    expect((await rt.workspaces.get(ws.id)).phase).toBe("pausing");
    gate.release();
    expect((await first).phase).toBe("napping");
    expect((await second).phase).toBe("napping");
    expect((await waking).phase).toBe("running");
    expect(m.resumes).toBe(1);
  });
});

describe("the start guard", () => {
  it("refuses sessions.start while pausing, paused and waking with the composer's sentence, in process and over the wire", async () => {
    const backend = stubBackend();
    const { factory } = hangingAdapter();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: factory } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    const m = backend.machines[0]!;
    const pauseGate = holdable<void>();
    const pause = m.pause.bind(m);
    m.pause = async () => {
      await pauseGate.promise;
      await pause();
    };
    const napping = rt.workspaces.nap(ws.id);
    await until(async () => (await rt.workspaces.get(ws.id)).phase === "pausing");
    await expect(rt.sessions.start(ws.id, { prompt: "hi" })).rejects.toThrow("Workspace is pausing; wake it to send");
    pauseGate.release();
    await napping;
    await expect(rt.sessions.start(ws.id, { prompt: "hi" })).rejects.toThrow("Workspace is paused; wake it to send");

    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    try {
      const res = await wsRequest(srv.port, "t", { op: "sessions.start", workspaceId: ws.id, prompt: "hi" });
      expect(res).toMatchObject({ ok: false, error: "Workspace is paused; wake it to send" });
    } finally {
      await srv.close();
    }

    const resumeGate = holdable<void>();
    const resume = m.resume.bind(m);
    m.resume = async () => {
      await resumeGate.promise;
      await resume();
    };
    const waking = rt.workspaces.wake(ws.id);
    await until(async () => (await rt.workspaces.get(ws.id)).phase === "waking");
    await expect(rt.sessions.start(ws.id, { prompt: "hi" })).rejects.toThrow("Workspace is waking; sends open when it is running");
    resumeGate.release();
    await waking;
    const handle = await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(handle.view().status).toBe("running");
    expect(rt.sessions.list(ws.id)).toHaveLength(1);
  });
});

describe("sessions end with the machine", () => {
  it("nap ends every live session of that workspace with the reason once the provider has paused, once, and drops what the harness says after", async () => {
    const backend = stubBackend();
    const { factory, interrupts, emit } = hangingAdapter();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: factory } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const a = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const b = await rt.workspaces.create({ golden: "snap_g", name: "b" });
    const one = await rt.sessions.start(a.id, { prompt: "one" });
    const two = await rt.sessions.start(a.id, { prompt: "two" });
    const other = await rt.sessions.start(b.id, { prompt: "other" });
    let sessionsAtPause: string[] = [];
    const m = backend.machines[0]!;
    const pause = m.pause.bind(m);
    m.pause = async () => {
      sessionsAtPause = rt.sessions.list(a.id).map(s => s.status);
      await pause();
    };

    await rt.workspaces.nap(a.id);

    // The reason says the machine paused, so it is written once the provider has confirmed the pause, not before.
    expect(sessionsAtPause).toEqual(["running", "running"]);
    const ended = ends(events).filter(e => e.workspaceId === a.id);
    expect(ended).toHaveLength(2);
    for (const e of ended) expect(e).toMatchObject({ exitCode: null, sawResult: false, reason: PAUSED });
    expect(new Set(ended.map(e => e.sessionId))).toEqual(new Set([one.view().claudeSessionId, two.view().claudeSessionId]));
    expect(events.findIndex(e => e.type === "session.end")).toBeLessThan(events.findIndex(e => e.type === "workspace.napped"));
    for (const s of rt.sessions.list(a.id)) expect(s).toMatchObject({ status: "failed", endedAt: expect.any(Number) });
    expect(interrupts).toEqual([a.id, a.id]);
    expect(other.view().status).toBe("running");
    expect(ends(events).filter(e => e.workspaceId === b.id)).toEqual([]);

    // The harness's own end and anything after it are already told: the reason row stays the last one.
    const history = await rt.sessions.history(a.id);
    expect(history.at(-1)).toMatchObject({ type: "session.end", reason: PAUSED });
    expect(history.filter(e => e.type === "session.end")).toHaveLength(2);
    emit(a.id, { type: "turn.delta", sessionId: "sess-2", kind: "text", text: "late" });
    expect((await rt.sessions.history(a.id)).length).toBe(history.length);
    expect(await rt.sessions.interrupt(two.id)).toEqual({ outcome: "not-running" });
    await one.finished;
    expect(one.view().status).toBe("failed");
  });

  it("delete ends the live sessions with its own reason before the machine dies", async () => {
    const backend = stubBackend();
    const { factory } = hangingAdapter();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: factory } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "one" });
    await rt.workspaces.delete(ws.id);
    expect(ends(events)).toHaveLength(1);
    expect(ends(events)[0]).toMatchObject({ workspaceId: ws.id, reason: "machine deleted while the agent was working" });
    expect(events.findIndex(e => e.type === "session.end")).toBeLessThan(events.findIndex(e => e.type === "workspace.deleted"));
    expect(handle.view()).toMatchObject({ status: "failed", endedAt: expect.any(Number) });
  });
});

describe("sessions end when the machine stops answering", () => {
  const openServers: Server[] = [];
  let srv: RuntimeServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
    await Promise.all(openServers.map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); }));
    openServers.length = 0;
  });

  /** The edge answers late, the exec probe fails: the tracker's zombie verdict, as measured twice at rest. */
  async function unansweringMachine(backend: StubBackend): Promise<void> {
    const server = createServer((_req, res) => setTimeout(() => res.writeHead(426).end(), 40));
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    openServers.push(server);
    const port = (server.address() as { port: number }).port;
    backend.machines[0]!.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    backend.execImpl = (_m, cmd) => (cmd === "echo ok" ? { exitCode: 1, stdout: "", stderr: "502" } : { exitCode: 0, stdout: "", stderr: "" });
  }

  it("the zombie verdict ends the live sessions with the reason, once", async () => {
    const backend = stubBackend();
    const { factory } = hangingAdapter();
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: { claude: factory },
      status: { costIntervalMs: 60_000, pollIntervalMs: 5, promptMs: 10, probeTimeoutMs: 500, zombieWindowMs: 80, zombieProbeTimeoutMs: 200 },
    });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "one" });
    await unansweringMachine(backend);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = rt.status.watch();
    try {
      await until(() => ends(events).length > 0, 5_000);
      await new Promise(r => setTimeout(r, 60));
      expect(ends(events)).toHaveLength(1);
      expect(ends(events)[0]).toMatchObject({ workspaceId: ws.id, reason: "machine stopped answering while the agent was working" });
      expect(handle.view().status).toBe("failed");
      expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
    } finally {
      stop();
      warn.mockRestore();
    }
  });
});

describe("a record left at pausing", () => {
  it("hydrates as napping, so the next wake resumes whatever the provider did", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {} });
    const ws = await first.workspaces.create({ golden: "snap_g", name: "x" });
    const stored = (await store.get("workspaces", ws.id)) as { phase: string };
    await store.put("workspaces", ws.id, { ...stored, phase: "pausing" });
    const second = createRuntime({ backend, store, adapters: {} });
    expect((await second.workspaces.get(ws.id)).phase).toBe("napping");
    const woken = await second.workspaces.wake(ws.id);
    expect(woken.phase).toBe("running");
    expect(backend.machines[0]!.resumes).toBe(1);
  });
});

describe("a pause the runtime did not start", () => {
  const openServers: Server[] = [];
  afterEach(async () => {
    await Promise.all(openServers.map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); }));
    openServers.length = 0;
  });

  /** The edge answers nothing for a paused machine (measured: the reach goes dark only while paused). */
  async function darkReach(backend: StubBackend): Promise<void> {
    const server = createServer(() => {});
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    openServers.push(server);
    const port = (server.address() as { port: number }).port;
    backend.machines[0]!.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
  }

  it("the poll sees the provider's machine paused under a running record: the phase follows, the sessions end, the status is pushed, and wake resumes it", async () => {
    const backend = stubBackend();
    const { factory } = hangingAdapter();
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: { claude: factory },
      status: { costIntervalMs: 60_000, pollIntervalMs: 5, promptMs: 10, probeTimeoutMs: 50, reconcileMinMs: 0 },
    });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "one" });
    await darkReach(backend);
    const m = backend.machines[0]!;
    m.paused = true;
    const stop = rt.status.watch();
    try {
      await until(() => events.some(e => e.type === "workspace.napped"), 5_000);
    } finally {
      stop();
    }
    expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
    expect(ends(events)).toHaveLength(1);
    expect(ends(events)[0]).toMatchObject({ workspaceId: ws.id, reason: PAUSED });
    expect(handle.view().status).toBe("failed");
    const pushed = events.filter(e => e.type === "workspace.status").map(e => e.type === "workspace.status" && e.status);
    expect(pushed.some(s => s !== false && s.phase === "napping" && s.machineState === "paused" && s.reason === "paused outside wsp")).toBe(true);
    await expect(rt.sessions.start(ws.id, { prompt: "again" })).rejects.toThrow("Workspace is paused; wake it to send");
    const woken = await rt.workspaces.wake(ws.id);
    expect(woken.phase).toBe("running");
    expect(m.resumes).toBe(1);
    expect(m.paused).toBe(false);
  });

  it("a wake asked while the record still says running asks the provider once and resumes a machine it finds paused", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const m = backend.machines[0]!;
    let asked = 0;
    const state = m.state.bind(m);
    m.state = async () => { asked++; return state(); };
    expect((await rt.workspaces.wake(ws.id)).phase).toBe("running");
    expect(asked).toBe(1);
    expect(m.resumes).toBe(0);
    m.paused = true;
    const woken = await rt.workspaces.wake(ws.id);
    expect(woken.phase).toBe("running");
    expect(m.resumes).toBe(1);
    expect(events.map(e => e.type)).toContain("workspace.napped");
    expect(events.map(e => e.type)).toContain("workspace.woken");
  });
});
