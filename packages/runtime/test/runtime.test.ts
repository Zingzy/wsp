import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { gunzipSync } from "node:zlib";
import { catalogProbeCommand, createClaudeAdapter, parseCatalogProbe } from "@wsp/adapter-claude";
import { DAEMON_RESTART_FAILED, DAEMON_RESTARTING, DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DAEMON_VERSION, RUN_GONE_LINE, SessionEvent, foldThreads, stillWorkingRefusal, type AdapterEvent, type EventUnion, type RecipeDigest, type TurnResult, type WorkspaceStatus } from "@wsp/protocol";
import { BUILDER_IDLE_MS, TOOLS_PATH, type GoldenDelta, type GoldenImport } from "@wsp/engine";
import { DAEMON_TOKEN_NONE, DAEMON_TOKEN_SET, rotateDaemonTokenScript } from "../src/daemon-token.js";
import { writeDaemonRootsScript } from "../src/daemon-roots.js";
import { harnessCatalog } from "../src/harness-catalog.js";
import { CATALOG_TTL_MS, DAEMON_REVIVE_AGAIN_MS, GRACE_MS, GUEST_LOGIN_ENV, PORT_PROBE_BODY_CAP, TRANSCRIPT_FLUSH_MS, createRuntime, type GoldenExec, type HarnessAdapterContext, type HarnessAdapterFactory, type HarnessSession, type HarnessStartOptions } from "../src/runtime.js";
import { POLL_INTERVAL_MS } from "../src/status.js";
import { machineExecStream } from "../src/machine-exec.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { until } from "./until.js";
import { wsRequest } from "./ws-client.js";
import { stubBackend, type StubBackend, type StubMachine } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { WebSocketServer } from "ws";

/** What a catalog served from the table carries as its version: that harness's own pin, never another's. */
const CLAUDE_PIN = harnessCatalog("claude")!.version;

/** The recipes here set up with "true", which the harness stage runs under its guard like every installer. */
const setupRan = (cmd: string): boolean => cmd.includes("\ntrue' &");

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

  it("a create that asks for an offered size forks the machine at it and the record and the rate follow; one off the list is refused with the list before any machine is forked", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "big", cpu: 2, memMb: 8192 });
    expect(backend.machines[0]!.spec).toMatchObject({ cpu: 2, memMb: 8192 });
    const [status] = await rt.status.list();
    expect(status).toMatchObject({ id: ws.id, size: { cpu: 2, memMb: 8192 } });
    expect(status!.rateUsdPerHour).toBeCloseTo(0.15, 10);

    await expect(rt.workspaces.create({ golden: "snap_g", name: "odd", cpu: 8, memMb: 16384 })).rejects.toMatchObject({
      kind: "invalid",
      message: "8x16 is not a size this provider offers; the sizes are 2x2 ($0.09/hr), 2x4 ($0.11/hr), 2x8 ($0.15/hr), 4x8 ($0.22/hr)",
    });
    expect(backend.machines).toHaveLength(1);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["big"]);

    // No size asked: the golden's own, whether or not the provider offers it today.
    const plain = await rt.workspaces.create({ golden: "snap_g", name: "plain" });
    expect((await rt.status.list()).find(s => s.id === plain.id)!.size).toEqual({ cpu: 2, memMb: 4096 });
  });

  it("same behavior over the wire: serveRuntime round-trips create via WS", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const res = await wsRequest(srv.port, "t", { op: "workspaces.create", golden: "snap_g", name: "x" });
    expect(res["ok"]).toBe(true);
    await srv.close();
  });

  it("every fork carries HOME, USER and the golden's PATH in its envs, under the workspace's own", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    expect(GUEST_LOGIN_ENV).toEqual({ HOME: "/root", USER: "root", PATH: TOOLS_PATH });
    await rt.workspaces.create({ golden: "snap_g", name: "plain" });
    await rt.workspaces.create({ golden: "snap_g", name: "own", envs: { FOO: "1", HOME: "/home/dev" } });
    expect(backend.machines[0]!.spec.envs).toEqual(GUEST_LOGIN_ENV);
    expect(backend.machines[1]!.spec.envs).toEqual({ HOME: "/home/dev", USER: "root", PATH: TOOLS_PATH, FOO: "1" });
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
    expect(backend.machines[1]!.spec.envs).toEqual({ ...GUEST_LOGIN_ENV, FOO: "1" });
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
    const contexts: HarnessAdapterContext[] = [];
    const scripted: HarnessAdapterFactory = ctx => {
      contexts.push(ctx);
      return {
      steers: false,
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
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
      };
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: scripted } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    const session = await rt.sessions.start(ws.id, { prompt: "say hi" });
    const result = await session.finished;
    expect(result.status).toBe("completed");
    // The adapter is handed the machine's login environment: who the guest runs as and the golden's PATH, so a launch served by a bare-PATH exec still finds the binary.
    // Every context, not the first alone: a turn is not the only road that asks a harness something on the machine.
    expect(contexts.length).toBeGreaterThan(0);
    for (const ctx of contexts) expect(ctx.env).toEqual(GUEST_LOGIN_ENV);
    const types = events.map(e => e.type);
    expect(types).toContain("session.start");
    expect(types).toContain("session.delta");
    expect(types).toContain("session.done");
    expect(types).toContain("session.end");
    for (const e of events) {
      if (e.type.startsWith("session.")) expect((e as { workspaceId: string }).workspaceId).toBe(ws.id);
    }
    expect((await rt.sessions.list())[0]?.status).toBe("completed");
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
    steers: false,
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
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });

  it("replays a workspace's session events with the prompt on session.start, surviving a restart", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: scripted("hello") } });
    const a = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const b = await rt.workspaces.create({ golden: "snap_g", name: "b" });
    await (await rt.sessions.start(a.id, { prompt: "say hello", requestId: "req_a1" })).finished;

    const history = await rt.sessions.history(a.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end"]);
    expect(history[0]).toMatchObject({ type: "session.start", workspaceId: a.id, prompt: "say hello", requestId: "req_a1" });
    expect(history.slice(1).some(e => "requestId" in e)).toBe(false);
    expect(await rt.sessions.history(b.id)).toEqual([]);
    // A client that sent no id leaves the start without one; the id is the client's, never minted here.
    await (await rt.sessions.start(b.id, { prompt: "say hello" })).finished;
    expect((await rt.sessions.history(b.id))[0]).not.toHaveProperty("requestId");
    await rt.workspaces.delete(b.id);

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
    let lastStart: HarnessStartOptions | undefined;
    let finish!: (r: TurnResult) => void;
    const finished = new Promise<TurnResult>(r => (finish = r));
    const adapter: HarnessAdapterFactory = () => ({
      steers: false,
      probeCatalog: exec => exec(catalogProbeCommand({ configDir: "/root/.claude-cfg" })).then(parseCatalogProbe),
      start: o => {
        onEvent = o.onEvent;
        lastStart = o;
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    return {
      adapter,
      lastStart: () => lastStart,
      start: (cwd?: string) => onEvent!({ type: "session.start", sessionId, model: "claude-sonnet-4-5", ...(cwd !== undefined ? { cwd } : {}) }),
      tool: (command: string, cwd?: string) =>
        onEvent!({ type: "turn.delta", sessionId, kind: "tool_use", text: JSON.stringify({ command }), toolName: "Bash", toolUseId: "t1", ...(cwd !== undefined ? { cwd } : {}) }),
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
      steers: false,
      start: o => {
        const result: TurnResult = { status: "completed", text: "ok" };
        const finished = Promise.resolve().then(() => {
          o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", harness });
          o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: "ok" });
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return result;
        });
        return { localId: sessionId, finished, interrupt: async () => {} };
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

  it("a harness that announces itself twice on one turn records one session.start, under the id it announced", async () => {
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const twice: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        const result: TurnResult = { status: "completed", text: "ok" };
        const finished = Promise.resolve().then(() => {
          o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", cwd: "/root/work" });
          o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", cwd: "/root/work" });
          o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: "ok" });
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return result;
        });
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: twice } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "first" })).finished;

    const history = await rt.sessions.history(ws.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end"]);
    expect(history[0]).toMatchObject({ type: "session.start", sessionId, prompt: "first", cwd: "/root/work" });
    expect((await rt.sessions.list(ws.id))[0]).toMatchObject({ claudeSessionId: sessionId, cwd: "/root/work", status: "completed" });
    await rt.close();
  });

  /** Emits one full turn per start, under the resume id when given, else a fresh id; `rekey` makes a resumed
   * start announce a different id in system/init, as the CLI is allowed to. */
  const threaded = (rekey?: (resume: string) => string): HarnessAdapterFactory => () => ({
    steers: false,
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
      return { localId, finished, interrupt: async () => {} };
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
    // The session rows carry the same ids, so a sidebar can fold rows into the threads the transcript folds into;
    // the resumed turn shares the first one's local id and so its row.
    expect((await rt.sessions.list(ws.id)).map(s => s.threadId)).toEqual([history[0]!.threadId, history[8]!.threadId]);
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

  it("a row says who opened its thread: a resumed turn keeps the answer of the turn it resumes, a fresh start gives its own", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: threaded() } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "first", startedBy: "cli" })).finished;
    const resume = (await rt.workspaces.get(ws.id)).claudeSessionId!;
    await (await rt.sessions.start(ws.id, { prompt: "second", resume })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "third" })).finished;
    expect((await rt.sessions.list(ws.id)).map(s => [s.prompt, s.startedBy])).toEqual([["first", "cli"], ["third", "person"]]);
    await rt.close();
  });

  it("a thread is titled by its first prompt: a second send leaves the row's prompt, and so the folded title, unchanged, also across a restart", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: threaded() } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const titles = async (r: typeof rt) => foldThreads(await r.sessions.list(ws.id)).map(t => [t.title, t.status]);
    await (await rt.sessions.start(ws.id, { prompt: "You are a builder for the wsp repo", startedBy: "cli" })).finished;
    const resume = (await rt.workspaces.get(ws.id)).claudeSessionId!;
    expect(await titles(rt)).toEqual([["You are a builder for the wsp repo", "completed"]]);
    await (await rt.sessions.start(ws.id, { prompt: "GitHub is signed in on this machine now", resume })).finished;
    expect(await titles(rt)).toEqual([["You are a builder for the wsp repo", "completed"]]);
    const history = await rt.sessions.history(ws.id);
    expect(history.filter(e => e.type === "session.start").map(e => e.prompt)).toEqual(["You are a builder for the wsp repo", "GitHub is signed in on this machine now"]);
    await rt.close();

    const again = createRuntime({ backend, store, adapters: { claude: threaded() } });
    await (await again.sessions.start(ws.id, { prompt: "Push the branch", resume })).finished;
    expect(await titles(again)).toEqual([["You are a builder for the wsp repo", "completed"]]);
    await again.close();
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
    const ended = (await rt.sessions.list(ws.id))[0]!;
    expect(ended.endedAt).toBeGreaterThanOrEqual(ended.startedAt!);
    expect(ended.endedAt).toBeLessThanOrEqual(Date.now());
    expect(ended.prompt).toBe("go");
    await rt.close();
  });

  it("keeps the row running while the process lives past its reply, refuses a send until it exits, then completes", async () => {
    const m = manual();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: m.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    m.start();
    m.done("here is the reply");
    // The reply is recorded, but the process has not exited: the row is still running, not completed.
    expect(handle.view().status).toBe("running");
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("running");
    expect((await rt.sessions.history(ws.id)).map(e => e.type)).toEqual(["session.start", "session.done"]);
    const sid = (await rt.sessions.list(ws.id))[0]!.claudeSessionId!;
    // A send while the process lives is refused in words naming the thread, never run as a second agent.
    await expect(rt.sessions.start(ws.id, { prompt: "again", resume: sid })).rejects.toThrow(stillWorkingRefusal(handle.view().threadId!));

    m.end();
    await handle.finished;
    // The process exited: the row completes and no longer refuses a send.
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("completed");
    await expect(rt.sessions.start(ws.id, { prompt: "again", resume: sid })).resolves.toBeDefined();
    await rt.close();
  });

  it("passes the picked model, effort and permission mode to the harness and records them on the SessionView", async () => {
    const m = manual();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: m.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go", model: "claude-opus-5", effort: "high", permissionMode: "plan" });
    expect(m.lastStart()).toMatchObject({ model: "claude-opus-5", effort: "high", permissionMode: "plan" });
    expect(handle.view()).toMatchObject({ model: "claude-opus-5", effort: "high", permissionMode: "plan" });
    // The CLI announces the model it resolved; that name replaces the request's on the view.
    m.start();
    expect((await rt.sessions.list(ws.id))[0]!.model).toBe("claude-sonnet-4-5");
    m.done("done");
    m.end();
    await handle.finished;
    await rt.close();
  });

  it("a harness with an adapter but no table row gets the picks as named and nothing else of the request", async () => {
    const m = manual();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { aider: m.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go", harness: "aider", model: "gpt-9", cwd: "/w", startedBy: "cli", requestId: "r1" });
    expect(Object.keys(m.lastStart()!).sort()).toEqual(["cwd", "model", "onEvent", "prompt"]);
    expect(m.lastStart()).toMatchObject({ model: "gpt-9", cwd: "/w" });
    expect(handle.view()).not.toHaveProperty("requestId");
    expect(handle.view()).toMatchObject({ harness: "aider", model: "gpt-9", startedBy: "cli" });
    m.done("done");
    m.end();
    await handle.finished;
    await rt.close();
  });

  it("a start without picks hands the harness the model, effort and access the catalog marks, the ones the composer shows, and nothing else", async () => {
    const m = manual();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: m.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    expect(Object.keys(m.lastStart()!)).toEqual(["prompt", "model", "effort", "permissionMode", "onEvent"]);
    const view = handle.view();
    expect(view.model).toBe("claude-opus-5");
    expect(view.effort).toBe("high");
    // The access is named too: unnamed, it reached the adapter as nothing, which every adapter here reads as its
    // own skip-everything flag, so what the picker showed and what the CLI ran could differ.
    expect(view.permissionMode).toBe("bypassPermissions");
    m.done("done");
    m.end();
    await handle.finished;
    await rt.close();
  });

  it("lists a catalog per harness with an adapter, from the table when no workspace is named", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: manual().adapter } });
    const catalogs = await rt.harnesses.list();
    // Codex and the rest sit in the table for the day an adapter lands; without one they cannot run a turn and are not listed.
    expect(catalogs.map(c => c.harness)).toEqual(["claude"]);
    const claude = catalogs[0]!;
    expect(claude.efforts.length).toBeGreaterThan(0);
    // Marked as the one an unnamed start runs, so a client without the catalog package can pick its list.
    expect(claude).toMatchObject({ source: "table", version: CLAUDE_PIN, isDefault: true });
    expect((await createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} }).harnesses.list()).length).toBe(0);
  });

  describe("harnesses.list on a workspace", () => {
    const PROBE_OUTPUT = readFileSync(new URL("../../adapter-claude/test/fixtures/catalog-probe.txt", import.meta.url), "utf8");
    const probes = (backend: StubBackend) => backend.machines.flatMap(m => m.execLog.filter(cmd => cmd.includes("claude --help")));

    it("asks the machine's binary and serves its models, efforts and modes as the catalog", async () => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude --help") ? { exitCode: 0, stdout: PROBE_OUTPUT, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: manual().adapter } });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const catalogs = await rt.harnesses.list(ws.id);
      const claude = catalogs.find(c => c.harness === "claude")!;
      // The wire's isDefault is the harness an unnamed start runs, whichever source answered.
      expect(claude).toMatchObject({ source: "harness", version: "2.1.257", isDefault: true });
      expect(claude.models.map(m => m.value)).toEqual(["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
      expect(claude.models[0]).toMatchObject({ label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] });
      expect(claude.permissionModes.map(o => o.value)).toEqual(["default", "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
      expect(probes(backend)).toHaveLength(1);
      // The probe is the adapter's line, so it runs under the session's isolated config dir, never HOME.
      expect(probes(backend)[0]).toContain("CLAUDE_CONFIG_DIR='/root/.claude-cfg'");
      await rt.close();
    });

    it("a start before any list fills the cache, and the list still marks the default harness", async () => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude --help") ? { exitCode: 0, stdout: PROBE_OUTPUT, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: manual().adapter } });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      await rt.sessions.start(ws.id, { prompt: "first" });
      const claude = (await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!;
      expect(claude).toMatchObject({ source: "harness", version: "2.1.257", isDefault: true });
      expect(probes(backend)).toHaveLength(1);
      await rt.close();
    });

    it("an adapter without a probe line gets the table, marked so, and the machine is not asked", async () => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude --help") ? { exitCode: 0, stdout: PROBE_OUTPUT, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: threaded() } });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const claude = (await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!;
      expect(claude).toMatchObject({ source: "table", version: CLAUDE_PIN });
      expect(probes(backend)).toHaveLength(0);
      await rt.close();
    });

    /** A second harness whose binary answers with a version line; its adapter opts into the probe, whatever its id. */
    const codexProbing: HarnessAdapterFactory = ctx => ({
      ...threaded()(ctx),
      probeCatalog: exec =>
        exec("codex --describe").then(out => ({
          version: out.trim(),
          models: [{ slug: "gpt-5-codex", label: "Codex", efforts: ["high"], contextWindows: [], isDefault: true }],
          efforts: ["low", "high"],
          permissionModes: ["read-only"],
        })),
    });
    const codexProbes = (backend: StubBackend) => backend.machines.flatMap(m => m.execLog.filter(cmd => cmd === "codex --describe"));
    const twoBinaries = (backend: StubBackend) => {
      backend.execImpl = (_m, cmd) => ({ exitCode: 0, stdout: cmd.includes("claude --help") ? PROBE_OUTPUT : cmd === "codex --describe" ? "0.9.0\n" : "", stderr: "" });
    };

    it("each adapter decides whether its binary is asked, whatever its harness id, and each harness keeps its own answer", async () => {
      const backend = stubBackend();
      twoBinaries(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: manual().adapter, codex: codexProbing } });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const catalogs = await rt.harnesses.list(ws.id);
      expect(catalogs.find(c => c.harness === "claude")).toMatchObject({ source: "harness", version: "2.1.257" });
      const codex = catalogs.find(c => c.harness === "codex")!;
      expect(codex).toMatchObject({ source: "harness", version: "0.9.0", label: "Codex" });
      expect(codex.isDefault).toBeUndefined();
      expect(codex.models).toEqual([{ value: "gpt-5-codex", label: "Codex", isDefault: true, efforts: ["high"], contextWindows: [] }]);
      // The table lends the words for values the binary only names.
      expect(codex.permissionModes).toEqual([{ value: "read-only", label: "Read only", description: "No edits, no commands that write" }]);
      expect(probes(backend)).toHaveLength(1);
      expect(codexProbes(backend)).toHaveLength(1);
      await rt.close();

      const quiet = stubBackend();
      twoBinaries(quiet);
      const rt2 = createRuntime({ backend: quiet, store: memoryStore(), adapters: { claude: threaded(), codex: codexProbing } });
      const ws2 = await rt2.workspaces.create({ golden: "snap_g", name: "b" });
      const later = await rt2.harnesses.list(ws2.id);
      expect(later.find(c => c.harness === "claude")).toMatchObject({ source: "table", version: CLAUDE_PIN });
      expect(later.find(c => c.harness === "codex")).toMatchObject({ source: "harness", version: "0.9.0" });
      expect(probes(quiet)).toHaveLength(0);
      expect(codexProbes(quiet)).toHaveLength(1);
      await rt2.close();
    });

    it("a binary that named why it described nothing keeps that harness's table and lends the footer its words", async () => {
      const backend = stubBackend();
      backend.execImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
      const refusing: HarnessAdapterFactory = ctx => ({ ...threaded()(ctx), probeCatalog: exec => exec("codex --describe").then(() => ({ refused: "Codex is not signed in on this machine; run codex login there" })) });
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { codex: refusing } });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const codex = (await rt.harnesses.list(ws.id)).find(c => c.harness === "codex")!;
      expect(codex).toMatchObject({ source: "table", version: harnessCatalog("codex")!.version, refusal: "Codex is not signed in on this machine; run codex login there" });
      expect(codex.models.map(m => m.value)).toEqual(harnessCatalog("codex")!.models.map(m => m.value));
      expect(codex.models.length).toBeGreaterThan(0);
      await rt.close();
    });

    it("a session start asks the binary of the harness that starts, when its adapter probes, and no other", async () => {
      const backend = stubBackend();
      twoBinaries(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: threaded(), codex: codexProbing } });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      await (await rt.sessions.start(ws.id, { prompt: "go", harness: "codex" })).finished;
      await new Promise(r => setImmediate(r));
      expect(codexProbes(backend)).toHaveLength(1);
      expect(probes(backend)).toHaveLength(0);
      await (await rt.sessions.start(ws.id, { prompt: "go" })).finished;
      await new Promise(r => setImmediate(r));
      expect(probes(backend)).toHaveLength(0);
      await rt.close();
    });

    it("a session start re-asks the binary, within the same TTL, so an upgrade on the machine shows within minutes", async () => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude --help") ? { exitCode: 0, stdout: PROBE_OUTPUT, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
      const fc = fakeClock();
      const m = manual();
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: m.adapter }, clock: fc.clock });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const handle = await rt.sessions.start(ws.id, { prompt: "go" });
      await new Promise(r => setImmediate(r));
      expect(probes(backend)).toHaveLength(1);
      await rt.harnesses.list(ws.id);
      expect(probes(backend)).toHaveLength(1);
      m.done("ok");
      m.end();
      await handle.finished;
      fc.advance(CATALOG_TTL_MS);
      await (await rt.sessions.start(ws.id, { prompt: "again" })).finished.catch(() => {});
      await new Promise(r => setImmediate(r));
      expect(probes(backend)).toHaveLength(2);
      await rt.close();
    });

    it("answers from the table, marked so, when the binary gives nothing or the exec fails, and does not ask again within the TTL", async () => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => {
        if (cmd.includes("claude --help")) throw new Error("exec timed out");
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const fc = fakeClock();
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: manual().adapter }, clock: fc.clock });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const first = (await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!;
      expect(first).toMatchObject({ source: "table", version: CLAUDE_PIN });
      expect(first.models.map(m => m.value)).toEqual(["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]);
      backend.execImpl = (_m, cmd) => ({ exitCode: 0, stdout: cmd.includes("claude --help") ? "garbage\n" : "", stderr: "" });
      await rt.harnesses.list(ws.id);
      expect(probes(backend)).toHaveLength(1);
      fc.advance(CATALOG_TTL_MS);
      const later = (await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!;
      expect(probes(backend)).toHaveLength(2);
      expect(later.source).toBe("table");
      await rt.close();
    });

    it("a start's model, effort and access mode are checked against the binary's catalog and refused with its list; a new thread without a model runs the default it marks", async () => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude --help") ? { exitCode: 0, stdout: PROBE_OUTPUT, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
      const m = manual();
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: m.adapter } });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      await expect(rt.sessions.start(ws.id, { prompt: "go", model: "claude-opus-4-1" })).rejects.toThrow(
        'model "claude-opus-4-1" is not one claude takes; one of: Opus 5 (claude-opus-5), Fable 5.1 (claude-fable-5-1), Sonnet 5 (claude-sonnet-5), Haiku (claude-haiku-4-5-20251001)',
      );
      await expect(rt.sessions.start(ws.id, { prompt: "go", permissionMode: "yolo" })).rejects.toThrow(/^access mode "yolo" is not one claude takes; one of: Default \(default\), /);
      expect(m.lastStart()).toBeUndefined();
      expect(await rt.sessions.list(ws.id)).toEqual([]);
      const handle = await rt.sessions.start(ws.id, { prompt: "go", effort: "high", permissionMode: "plan" });
      expect(m.lastStart()).toMatchObject({ model: "claude-opus-5", effort: "high", permissionMode: "plan" });
      m.start();
      m.done("ok");
      m.end();
      await handle.finished;
      const resumed = await rt.sessions.start(ws.id, { prompt: "more", resume: "33333333-3333-4333-8333-333333333333" });
      expect(m.lastStart()!.model).toBeUndefined();
      m.done("ok");
      m.end();
      await resumed.finished;
      expect(probes(backend)).toHaveLength(1);
      await rt.close();
    });

    it("keeps one answer per machine and leaves a napping workspace's binary alone", async () => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude --help") ? { exitCode: 0, stdout: PROBE_OUTPUT, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: manual().adapter } });
      const a = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      const b = await rt.workspaces.create({ golden: "snap_g", name: "b" });
      await rt.harnesses.list(a.id);
      await rt.harnesses.list(a.id);
      await rt.harnesses.list(b.id);
      expect(probes(backend)).toHaveLength(2);
      await rt.workspaces.nap(b.id);
      const napping = (await rt.harnesses.list(b.id)).find(c => c.harness === "claude")!;
      expect(napping.source).toBe("table");
      expect(probes(backend)).toHaveLength(2);
      await expect(rt.harnesses.list("ws_nope")).rejects.toThrow(/no such workspace/);
      await rt.close();
    });
  });

  it("SessionView carries the folder: the start request's until the harness announces its own", async () => {
    const m = manual();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: m.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go", cwd: "/root/app" });
    expect(handle.view().cwd).toBe("/root/app");
    m.start("/root/app/packages/web");
    expect((await rt.sessions.list(ws.id))[0]!.cwd).toBe("/root/app/packages/web");
    m.done("done");
    m.end();
    await handle.finished;
    await rt.close();
  });

  it("SessionView keeps the harness folder when a tool call moves the shell; the delta event carries the move", async () => {
    const m = manual();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: m.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const deltas: Array<string | undefined> = [];
    rt.events.on("session.delta", e => { if (e.type === "session.delta") deltas.push(e.cwd); });
    const handle = await rt.sessions.start(ws.id, { prompt: "go", cwd: "/root" });
    m.start("/root");
    m.tool("ls");
    m.tool("cd /root/2048 && ls", "/root/2048");
    expect((await rt.sessions.list(ws.id))[0]!.cwd).toBe("/root");
    expect(deltas).toEqual([undefined, "/root/2048"]);
    m.done("done");
    m.end();
    await handle.finished;
    const history = await rt.sessions.history(ws.id);
    expect(history.filter(e => e.type === "session.delta").map(e => (e.type === "session.delta" ? e.cwd : null))).toEqual([undefined, "/root/2048"]);
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
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
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
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    await rt1.sessions.start(ws.id, { prompt: "first", harness: "hung" });
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: t.adapter } });
    await (await rt2.sessions.start(ws.id, { prompt: "second", resume: HUNG_ID })).finished;
    await (await rt2.sessions.start(ws.id, { prompt: "third", resume: HUNG_ID })).finished;
    const starts = (await rt2.sessions.history(ws.id)).filter(e => e.type === "session.start");
    expect(starts.map(e => [e.prompt, e.afterCut])).toEqual([["first", undefined], ["second", true], ["third", undefined]]);
    expect(new Set(starts.map(e => e.threadId)).size).toBe(1);
    await rt2.close();
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
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: cutting, dying } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "cut" })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "second", resume: CUT_ID })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "third", resume: CUT_ID })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "dies", resume: CUT_ID, harness: "dying" })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "fifth", resume: CUT_ID })).finished;
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
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
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: turns().adapter, dying } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "first" })).finished;
    const [first] = await rt.sessions.list(ws.id);
    const resume = first!.claudeSessionId!;
    await (await rt.sessions.start(ws.id, { prompt: "again", resume, harness: "dying" })).finished;
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const other = await rt.workspaces.create({ golden: "snap_g", name: "b" });
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

  it("a resume after a restart joins the persisted thread and hands the harness the session id and folder", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: { claude: turns().adapter } });
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt1.sessions.start(ws.id, { prompt: "first", cwd: "/root/app" })).finished;
    const [first] = await rt1.sessions.list(ws.id);
    await rt1.close();
    // the transcript is gone but the index survives: the thread still folds
    await store.delete("transcripts", ws.id);

    const t = turns();
    const rt2 = createRuntime({ backend, store, adapters: { claude: t.adapter } });
    await (await rt2.sessions.start(ws.id, { prompt: "more", resume: first!.claudeSessionId, cwd: first!.cwd })).finished;
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
    const a = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    const b = await rt1.workspaces.create({ golden: "snap_g", name: "b" });
    await (await rt1.sessions.start(a.id, { prompt: "on a" })).finished;
    await (await rt1.sessions.start(b.id, { prompt: "on b" })).finished;
    await rt1.close();
    backend.machines[0]!.killed = true;

    const rt2 = createRuntime({ backend, store, adapters: {} });
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "first", cwd: "/root/app" })).finished;
    const [first] = await rt.sessions.list(ws.id);
    await (await rt.sessions.start(ws.id, { prompt: "from another folder", resume: first!.claudeSessionId, cwd: "/root/other" })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "from the command line", resume: first!.claudeSessionId })).finished;
    expect(t.starts.map(s => s.cwd)).toEqual(["/root/app", "/root/app", "/root/app"]);
    expect((await rt.sessions.list(ws.id)).map(s => s.cwd)).toEqual(["/root/app"]);
    // a start without resume still runs where it was asked to
    await (await rt.sessions.start(ws.id, { prompt: "new thread", cwd: "/root/other" })).finished;
    expect(t.starts[3]!.cwd).toBe("/root/other");
    await rt.close();

    // the index is gone but the transcript keeps the start: the folder still comes from it
    await store.delete("sessions", ws.id);
    const t2 = turns();
    const rt2 = createRuntime({ backend, store, adapters: { claude: t2.adapter } });
    await (await rt2.sessions.start(ws.id, { prompt: "after a restart", resume: first!.claudeSessionId, cwd: "/root/other" })).finished;
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
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
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "stuck", harness: "hung" });
    for (let i = 0; i < 199; i++) await (await rt.sessions.start(ws.id, { prompt: `t${i}` })).finished;
    const full = await rt.sessions.list(ws.id);
    expect(full).toHaveLength(200);
    expect(full.slice(0, 2).map(s => s.prompt)).toEqual(["stuck", "t0"]);
    await (await rt.sessions.start(ws.id, { prompt: "t199" })).finished;
    const rows = await rt.sessions.list(ws.id);
    expect(rows.map(s => s.prompt)).toEqual(["stuck", ...Array.from({ length: 199 }, (_, i) => `t${i + 1}`)]);
    await rt.close();
    const stored = (await store.get("sessions", ws.id)) as { sessions: { prompt: string }[] };
    expect(stored.sessions.map(s => s.prompt)).toEqual(rows.map(s => s.prompt));
  });
});

describe("a turn the host comes back to", () => {
  /** A harness whose run lives on the machine, not in this process: every event it emits is a line of the run's log,
   * and an attach replays that log from its first line before the rest of it arrives, which is what reading the
   * guest's own log from byte zero does. Forgetting a run is the machine having swept it. */
  const machineRuns = () => {
    interface Run {
      log: AdapterEvent[];
      sessionId: string;
      localId: string;
      live?: (event: AdapterEvent) => void;
      settle?: (result: TurnResult) => void;
      result?: TurnResult;
    }
    const runs = new Map<string, Run>();
    let minted = 0;
    /** Set, nothing on the machine answers the question the attach asks, and the run is neither there nor gone. */
    let unreachable: Error | undefined;
    const deliver = (run: Run, event: AdapterEvent): void => {
      if (event.type === "turn.done") run.result = event.result;
      run.live?.(event);
      if (event.type === "session.end") run.settle?.(run.result ?? { status: "failed" });
    };
    const emit = (handle: string, event: AdapterEvent): void => {
      const run = runs.get(handle)!;
      run.log.push(event);
      deliver(run, event);
    };
    const open = (run: Run, handle: string, onEvent: (event: AdapterEvent) => void, localId: string): HarnessSession => {
      let settle!: (result: TurnResult) => void;
      const finished = new Promise<TurnResult>(resolve => {
        settle = resolve;
      });
      run.settle = settle;
      run.live = onEvent;
      return { localId, run: handle, finished, interrupt: async () => {} };
    };
    const asked: string[] = [];
    const adapter: HarnessAdapterFactory = () => ({
      steers: false,
      // Answering nothing leaves the row on its seed, so the only thing that can stop a second question after the
      // restart is the start row the turn already wrote.
      titleFor: async turn => {
        asked.push(turn.opening);
        return null;
      },
      start: o => {
        // The shape a handle the guest's run directory reports has to have to be one of this host's.
        const handle = `/tmp/wsp-run/${(++minted).toString(16).padStart(12, "0")}`;
        // The CLI keys the session by its own id, not by the one the launch minted, so the row and the harness
        // session are two different ids across the restart.
        const run: Run = { log: [], sessionId: `sess-${minted}`, localId: `local-${minted}` };
        runs.set(handle, run);
        const session = open(run, handle, o.onEvent, run.localId);
        queueMicrotask(() => emit(handle, { type: "session.start", sessionId: run.sessionId, model: "claude-sonnet-4-5", cwd: o.cwd ?? "/root/work" }));
        return session;
      },
      attach: async o => {
        if (unreachable !== undefined) throw unreachable;
        const run = runs.get(o.run);
        // A machine that answered and no longer holds the run: no reader, and nothing is ever emitted for it.
        if (run === undefined) return "gone";
        const session = open(run, o.run, o.onEvent, o.sessionId);
        const replayed = [...run.log];
        queueMicrotask(() => {
          for (const event of replayed) deliver(run, event);
        });
        return session;
      },
    });
    return {
      adapter,
      emit,
      handles: () => [...runs.keys()],
      sweep: (handle: string) => runs.delete(handle),
      unreach: (e: Error) => (unreachable = e),
      asked: () => [...asked],
    };
  };

  /** A workspace with one turn running on the machine, the host stopped under it, and what that turn's run is. */
  const hostWentDown = async (h: ReturnType<typeof machineRuns>, store: Store, backend: StubBackend): Promise<{ workspaceId: string; run: string }> => {
    const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "build it" });
    await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const run = h.handles()[0]!;
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: "reading the ticket" });
    await rt.close();
    return { workspaceId: ws.id, run };
  };

  it("the run outlives the host: the row keeps its run, stays running across the restart and completes with its reply", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    const stored = (await store.get("sessions", workspaceId)) as { sessions: { status: string; run?: string }[] };
    expect(stored.sessions.map(s => [s.status, s.run])).toEqual([["running", run]]);

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);
    h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: "wrote the fix" });
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.sessions.list(workspaceId))[0]!.status === "completed");
    const history = await rt2.sessions.history(workspaceId);
    // the line the old host already wrote is read past, so the replay costs the transcript nothing
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.done", "session.end"]);
    expect(history.filter(e => e.type === "session.delta").map(e => e.text)).toEqual(["reading the ticket", "wrote the fix"]);
    expect(history.at(-1)).toMatchObject({ type: "session.end", exitCode: 0, sawResult: true });
    // The name goes out under the one start row the turn writes, so the host that re-opened the run asks nothing:
    // its own asked-set is empty and the row is still on its seed, and the start row is what stands in for both.
    expect(h.asked()).toEqual(["build it"]);
    expect((await rt2.sessions.list(workspaceId))[0]!.harnessTitle).toBeUndefined();
    await rt2.close();
  });

  /** What the machine answers when a connecting host asks which runs it holds, and what it was told to end. */
  const guestRuns = (backend: StubBackend, claims: readonly string[]) => {
    const reaps: string[] = [];
    backend.execImpl = (_m, cmd) => {
      if (cmd.includes("printf '%s\\n' \"$d\"")) return { exitCode: 0, stdout: `${claims.map(base => `${base}.d`).join("\n")}\n`, stderr: "" };
      if (cmd.includes("kill -TERM")) reaps.push(cmd);
      return { exitCode: 0, stdout: cmd.includes("echo WSP_CTX") ? "WSP_CTX\nWSP_CTX_END\n" : "", stderr: "" };
    };
    return { reaps };
  };

  it("a host that connects ends the runs on the machine that no thread of its own holds, and leaves the one it re-opened", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    const orphan = "/tmp/wsp-run/aabbccddeeff";
    const guest = guestRuns(backend, [run, orphan]);

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);

    expect(guest.reaps).toHaveLength(1);
    expect(guest.reaps[0]).toContain(`rm -rf '${orphan}'.*`);
    expect(guest.reaps[0]).not.toContain(run);
    await rt2.close();
  });

  it("a run whose row this host could not re-open is ended on the machine, not left holding it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    const guest = guestRuns(backend, [run]);

    // No adapter for the row's harness: the turn reads as one the restart cut, and nothing here reads its run again.
    const rt2 = createRuntime({ backend, store, adapters: {} });
    await until(async () => (await rt2.sessions.list(workspaceId))[0]!.status === "failed");

    expect(guest.reaps).toHaveLength(1);
    expect(guest.reaps[0]).toContain(`rm -rf '${run}'.*`);
    await rt2.close();
  });

  it("a run the machine no longer holds ends the turn on those words, and a second restart does not end it again", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    h.sweep(run);

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    await until(async () => (await rt2.sessions.list(workspaceId))[0]!.status === "failed");
    const history = await rt2.sessions.history(workspaceId);
    expect(history.at(-1)).toMatchObject({ type: "session.end", exitCode: null, sawResult: false, reason: RUN_GONE_LINE });
    await rt2.close();

    const rt3 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt3.sessions.history(workspaceId)).filter(e => e.type === "session.end")).toHaveLength(1);
    await rt3.close();
  });

  it("a machine that answers nothing about the run leaves the turn running, kills nothing, and the poll that finds the machine gone is what settles it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId, run } = await hostWentDown(h, store, backend);
    h.unreach(new Error("gateway said 502"));

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["running"]);
    // Nothing was told about the turn either way: no end row, and the run is still there to be read next time.
    expect((await rt2.sessions.history(workspaceId)).some(e => e.type === "session.end")).toBe(false);
    expect(h.handles()).toContain(run);
    // The machine really is away, and the road that watches machines can still settle a row this host never opened.
    const [ws] = await rt2.workspaces.list();
    await rt2.workspaces.delete(ws!.id);
    await until(async () => (await rt2.sessions.list(workspaceId)).every(s => s.status !== "running"));
    await rt2.close();
  });

  it("a turn whose reply is already written settles completed when the run is gone at boot, and tells its parent nothing more", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    await rt1.sessions.start(ws.id, { prompt: "build it", notify: "me" });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const run = h.handles()[0]!;
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.notify"));
    await rt1.close();
    h.sweep(run);

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const rows = await rt2.sessions.list(ws.id);
    expect(rows.map(s => s.status)).toEqual(["completed"]);
    const history = await rt2.sessions.history(ws.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.notify", "session.done", "session.end"]);
    expect(history.at(-1)).toMatchObject({ type: "session.end", sawResult: true, reason: RUN_GONE_LINE });
    await rt2.close();
  });

  it("a turn longer than the transcript cap replays without writing a line twice: the count comes off the last row's stamp, not off how many rows survive", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    await rt1.sessions.start(ws.id, { prompt: "build it" });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const run = h.handles()[0]!;
    const printed = 5200;
    for (let i = 0; i < printed; i++) h.emit(run, { type: "turn.delta", sessionId: "sess-1", kind: "text", text: `line ${i}` });
    // A non-delta row is what flushes the transcript, so the capped store is what the next host reads.
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
    const before = (await rt1.sessions.history(ws.id)).filter(e => e.type === "session.delta");
    expect(before.length).toBeLessThan(printed);
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    await rt2.sessions.list(ws.id);
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.sessions.list(ws.id))[0]!.status === "completed");
    const deltas = (await rt2.sessions.history(ws.id)).filter(e => e.type === "session.delta");
    expect(new Set(deltas.map(e => e.text)).size).toBe(deltas.length);
    expect(deltas.at(-1)).toMatchObject({ text: `line ${printed - 1}`, line: printed });
    await rt2.close();
  });

  it("a host with no adapter for the harness cannot re-open the run, so the turn reads as one the restart cut", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const { workspaceId } = await hostWentDown(h, store, backend);

    const rt2 = createRuntime({ backend, store, adapters: {} });
    expect((await rt2.sessions.list(workspaceId)).map(s => s.status)).toEqual(["failed"]);
    expect((await rt2.sessions.history(workspaceId)).at(-1)).toMatchObject({ type: "session.end", reason: "host restarted while the agent was working" });
    await rt2.close();
  });

  it("a turn whose reply landed before the restart has its line recorded once, not again on the replay", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const h = machineRuns();
    const rt1 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    await rt1.sessions.start(ws.id, { prompt: "build it", notify: "me" });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.start"));
    const run = h.handles()[0]!;
    // the reply landed and the harness process had not exited when the host went down
    h.emit(run, { type: "turn.done", sessionId: "sess-1", result: { status: "completed", text: "done" } });
    await until(async () => (await rt1.sessions.history(ws.id)).some(e => e.type === "session.notify"));
    expect((await rt1.sessions.list(ws.id))[0]).toMatchObject({ status: "running" });
    await rt1.close();

    const rt2 = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    expect((await rt2.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    h.emit(run, { type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    await until(async () => (await rt2.sessions.list(ws.id))[0]!.status === "completed");
    expect((await rt2.sessions.history(ws.id)).map(e => e.type)).toEqual(["session.start", "session.notify", "session.done", "session.end"]);
    await rt2.close();
  });
});

describe("runtime daemon reach", () => {
  it("hands back the preview route plus the token it minted, written to the guest once and never in the url", async () => {
    const backend = stubBackend();
    let minted = 0;
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => {
      minted++;
      return { url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    const reach = await rt.workspaces.daemonReach(ws.id);
    expect(reach).toEqual({ url: "https://m1-7070.preview.example/?pt_token=edge", expiresAt: expect.any(Number), daemonToken: TOKEN });
    await rt.workspaces.daemonReach(ws.id);
    expect(minted).toBe(1);
    expect(backend.machines[0]!.execLog.filter(c => c.includes(TOKEN_PATH))).toEqual([rotateDaemonTokenScript(TOKEN)]);
  });

  it("mints a token per process, hex so the write needs no quoting, unless one is given", async () => {
    const written: string[] = [];
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => {
        const m = /^WSP_DAEMON_TOKEN='([^']*)'$/m.exec(cmd);
        if (m) written.push(m[1]!);
        return { exitCode: 0, stdout: DAEMON_TOKEN_SET, stderr: "" };
      };
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
      backend.machines[0]!.previewUrl = async port => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: Date.now() + 3_600_000 });
      tokens.push((await rt.workspaces.daemonReach(ws.id)).daemonToken!);
    }
    expect(tokens[0]).toMatch(/^[0-9a-f]{48}$/);
    expect(tokens[1]).toMatch(/^[0-9a-f]{48}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(written).toEqual(tokens);
    expect(() => createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, daemonToken: "it's not hex" })).toThrow(/hex/);
  });

  it("omits the daemon token when the guest has none and refuses backends without preview urls", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes(TOKEN_PATH) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_NONE}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow("without preview URLs");

    backend.machines[0]!.previewUrl = async () => ({ url: "https://m1-7070.preview.example/?pt_token=e", token: "e", expiresAt: Date.now() + 3_600_000 });
    const reach = await rt.workspaces.daemonReach(ws.id);
    expect(reach.daemonToken).toBeUndefined();
    expect("daemonToken" in reach).toBe(false);
  });

  it("updateDaemon runs the recipe's deploy on the running machine, then writes this runtime's token again so the next reach opens the new daemon", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const deployed: string[] = [];
    const recipe = {
      setup: "true",
      smoke: "true",
      deployDaemon: async (machine: { id: string; exec(cmd: string): Promise<unknown> }) => {
        deployed.push(machine.id);
        await machine.exec("DEPLOY_DAEMON");
        return "daemon on node v22";
      },
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 50 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const m = backend.machines[0]!;
    m.previewUrl = async port => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: Date.now() + 3_600_000 });
    expect((await rt.workspaces.daemonReach(ws.id)).daemonToken).toBe(TOKEN);
    const before = m.execLog.length;

    await rt.workspaces.updateDaemon(ws.id);
    expect(deployed).toEqual(["m1"]);
    // The deploy started the daemon on its own token; the rotation after it is what makes the runtime's token open it.
    const after = m.execLog.slice(before);
    expect(after).toEqual(["DEPLOY_DAEMON", rotateDaemonTokenScript(TOKEN)]);
    expect((await rt.workspaces.daemonReach(ws.id)).daemonToken).toBe(TOKEN);
    expect(m.execLog.length).toBe(before + 2);

    await rt.workspaces.nap(ws.id);
    await expect(rt.workspaces.updateDaemon(ws.id)).rejects.toThrow("wake a before updating its daemon");
    expect(deployed).toEqual(["m1"]);
  });

  it("replaces a daemon older than this wsp by itself: the runtime connects to a machine it adopts, reads the hello and deploys, with nothing asking it to", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const daemon = await helloingDaemon(1);
    try {
      const before = createRuntime({ backend, store, adapters: {} });
      const ws = await before.workspaces.create({ golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      m.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      const deployed: string[] = [];
      let release!: () => void;
      const held = new Promise<void>(r => (release = r));
      const recipe = {
        setup: "true",
        smoke: "true",
        deployDaemon: async (machine: { id: string }) => {
          deployed.push(machine.id);
          await held;
          daemon.announce(DAEMON_VERSION);
        },
      };
      // The host starting again over the same store, on a machine that is already running: the one case a person
      // hits after an upgrade, and the one nothing else in the runtime reaches.
      const rt = createRuntime({ backend, store, adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 2_000 });
      const pushed: WorkspaceStatus[] = [];
      rt.events.on("workspace.status", e => pushed.push((e as { status: WorkspaceStatus }).status));
      await rt.workspaces.list();
      await until(() => deployed.length === 1);
      expect(deployed).toEqual(["m1"]);

      // The row says what is being done while it is being done, and the status carrying it still carries the nap
      // countdown: a client replaces the whole status, so a line that dropped it would blank the row.
      await until(async () => (await rt.workspaces.get(ws.id)).daemonNote === DAEMON_UPDATING);
      const updating = pushed.filter(st => st.daemonNote === DAEMON_UPDATING);
      expect(updating).toHaveLength(1);
      expect(updating[0]!.idleAt).toBeGreaterThan(Date.now());

      release();
      await until(async () => (await rt.workspaces.get(ws.id)).daemonNote === undefined);
      expect(pushed.at(-1)!.daemonNote).toBeUndefined();
      expect(pushed.at(-1)!.idleAt).toBeGreaterThan(Date.now());
    } finally {
      await daemon.close();
    }
  });

  it("a deploy that fails leaves the old daemon serving, says so on the row once and no longer, and logs the reason", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const daemon = await helloingDaemon(1);
    try {
      const before = createRuntime({ backend, store, adapters: {} });
      const ws = await before.workspaces.create({ golden: "snap_g", name: "a" });
      const m = backend.machines[0]!;
      m.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      let atDeploy = -1;
      const recipe = {
        setup: "true",
        smoke: "true",
        deployDaemon: async () => {
          atDeploy = m.execLog.length;
          throw new Error("daemon deploy failed: NPM_FAIL");
        },
      };
      const rt = createRuntime({ backend, store, adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 2_000 });
      const pushed: WorkspaceStatus[] = [];
      rt.events.on("workspace.status", e => pushed.push((e as { status: WorkspaceStatus }).status));
      const warned: string[] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
      try {
        await rt.workspaces.list();
        await until(() => pushed.some(st => st.daemonNote === DAEMON_UPDATE_FAILED));
      } finally {
        warn.mockRestore();
      }
      // The row said it once. It is not on the workspace any more, so the next poll shows the rate and the
      // countdown again rather than a failure nobody here can act on.
      expect((await rt.workspaces.get(ws.id)).daemonNote).toBeUndefined();
      expect(pushed.filter(st => st.daemonNote === DAEMON_UPDATE_FAILED)).toHaveLength(1);
      // The reason npm gave is in this host's log and nowhere a person reads.
      expect(warned.some(l => l.includes("daemon deploy failed: NPM_FAIL") && l.includes("m1"))).toBe(true);
      expect(pushed.every(st => st.daemonNote === undefined || !st.daemonNote.includes("NPM_FAIL"))).toBe(true);
      // Nothing reached the machine after the deploy threw, the token was not rotated away from the daemon that
      // holds it, and that daemon still answers with the version it always did.
      expect(m.execLog.slice(atDeploy)).toEqual([]);
      expect(await helloOf(daemon.port)).toBe(1);
    } finally {
      await daemon.close();
    }
  });

  it("waits out a running turn before replacing the daemon, since the deploy ends what the turn runs under", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const daemon = await helloingDaemon(1, true);
    let finish!: (r: TurnResult) => void;
    const held: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        const sessionId = "55555555-5555-4555-8555-555555555555";
        queueMicrotask(() => o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" }));
        return {
          localId: sessionId,
          finished: new Promise<TurnResult>(r => {
            finish = result => {
              o.onEvent({ type: "turn.done", sessionId, result });
              o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
              r(result);
            };
          }),
          interrupt: async () => {},
        };
      },
    });
    try {
      const before = createRuntime({ backend, store, adapters: {} });
      const ws = await before.workspaces.create({ golden: "snap_g", name: "a" });
      backend.machines[0]!.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      const deployed: string[] = [];
      const recipe = { setup: "true", smoke: "true", deployDaemon: async (m: { id: string }) => void deployed.push(m.id) };
      const rt = createRuntime({ backend, store, adapters: { claude: held }, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 5_000 });
      await rt.workspaces.list();
      // A turn opens while the runtime is still waiting on the machine's hello: the update it is about to run holds.
      await rt.sessions.start(ws.id, { prompt: "go" });
      await until(async () => (await rt.sessions.list())[0]?.status === "running");
      daemon.release();
      await new Promise(r => setTimeout(r, 200));
      expect(deployed).toEqual([]);

      finish({ status: "completed", text: "done" });
      await until(() => deployed.length === 1);
      expect(deployed).toEqual(["m1"]);
    } finally {
      finish?.({ status: "completed", text: "" });
      await daemon.close();
    }
  });

  it("writes the folders the record names on every connect, and again after the update, so a project imported before the daemon read that file is browsable", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const daemon = await helloingDaemon(1);
    const roots = writeDaemonRootsScript(["/Users/dev/wsp"]);
    try {
      const before = createRuntime({ backend, store, adapters: {} });
      const ws = await before.workspaces.create({ golden: "snap_g", name: "a" });
      const stored = (await store.get("workspaces", ws.id)) as Record<string, unknown>;
      await store.put("workspaces", ws.id, { ...stored, project: { name: "wsp", dest: "/Users/dev/wsp", importedAt: "2026-09-01T00:00:00Z" } });
      const m = backend.machines[0]!;
      m.previewUrl = async () => ({ url: `ws://127.0.0.1:${daemon.port}`, token: "e", expiresAt: Date.now() + 3_600_000 });

      let atDeploy = -1;
      const recipe = {
        setup: "true",
        smoke: "true",
        deployDaemon: async () => {
          atDeploy = m.execLog.length;
          daemon.announce(DAEMON_VERSION);
        },
      };
      const from = m.execLog.length;
      const rt = createRuntime({ backend, store, adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, daemonHelloTimeoutMs: 2_000 });
      await rt.workspaces.list();
      await until(() => m.execLog.slice(from).filter(cmd => cmd === roots).length === 2);
      // Once before the daemon is asked anything, so the first files op lands; once after the daemon was replaced.
      expect(m.execLog.slice(from, atDeploy).filter(cmd => cmd === roots)).toEqual([roots]);
      expect(m.execLog.slice(atDeploy).filter(cmd => cmd === roots)).toEqual([roots]);
    } finally {
      await daemon.close();
    }
  });

  const openServers: Server[] = [];
  afterEach(async () => {
    await Promise.all(openServers.map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); }));
    openServers.length = 0;
  });

  /** A preview edge in front of a machine whose daemon port answers nothing: the shape a dead daemon has on the
   * wire (a prompt 502), and 426 once `up` is set, which is the daemon answering again. */
  async function daemonPort(up: () => boolean): Promise<{ server: Server; port: number; hits: () => number }> {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(up() ? 426 : 502).end();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    openServers.push(server);
    return { server, port: (server.address() as AddressInfo).port, hits: () => hits };
  }

  it("puts the daemon back on a running machine whose port answers nothing, with nothing asking it to", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    // Answers once, then dies: the first silence is a window, and only the second is a daemon that is gone.
    let probes = 0;
    let back = false;
    const edge = await daemonPort(() => ++probes === 1 || back);
    const deployed: string[] = [];
    const recipe = {
      setup: "true",
      smoke: "true",
      deployDaemon: async (machine: { id: string }) => {
        deployed.push(machine.id);
        back = true;
      },
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, status: { costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
    const pushed: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => pushed.push((e as { status: WorkspaceStatus }).status));

    const stop = rt.status.watch();
    try {
      await until(() => deployed.length === 1);
      // One silence is a window a restart sits inside; the deploy waits for the second.
      expect(edge.hits()).toBeGreaterThanOrEqual(3);
      await until(() => pushed.at(-1)?.reach.state === "reachable");
    } finally {
      stop();
    }
    expect(deployed).toEqual(["m1"]);
    // The row said what was being done while it was being done, and says nothing once the daemon answers again.
    expect(pushed.filter(st => st.daemonNote === DAEMON_RESTARTING).length).toBeGreaterThanOrEqual(1);
    expect((await rt.workspaces.get(ws.id)).daemonNote).toBeUndefined();
    // The redeploy went through the same road the verb takes, so the runtime's own token opens the new daemon.
    expect(backend.machines[0]!.execLog).toContain(rotateDaemonTokenScript(TOKEN));
  });

  it("leaves a machine alone whose daemon answers again on the next poll: one silence is not a dead daemon", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    let probes = 0;
    // Every other probe answers; the run of silences never reaches two.
    const edge = await daemonPort(() => ++probes % 2 === 1);
    const deployed: string[] = [];
    const recipe = { setup: "true", smoke: "true", deployDaemon: async (machine: { id: string }) => void deployed.push(machine.id) };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, status: { costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 } });
    await rt.workspaces.create({ golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
    const stop = rt.status.watch();
    try {
      await until(() => edge.hits() >= 10);
    } finally {
      stop();
    }
    expect(deployed).toEqual([]);
  });

  it("a redeploy that fails says so on the row once, logs the reason, holds the row at no-daemon, and is tried again a cooldown later", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const fc = fakeClock();
    const edge = await daemonPort(() => false);
    const deployed: number[] = [];
    const recipe = {
      setup: "true",
      smoke: "true",
      deployDaemon: async () => {
        deployed.push(fc.clock.now());
        throw new Error("daemon deploy failed: NPM_FAIL");
      },
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, clock: fc.clock, goldenRecipe: recipe, status: { costIntervalMs: 24 * 3_600_000, reconcileMinMs: 60_000 } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: fc.clock.now() + 3_600_000 });
    const pushed: WorkspaceStatus[] = [];
    rt.events.on("workspace.status", e => pushed.push((e as { status: WorkspaceStatus }).status));
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
    /** One poll tick, waited out: the timer runs on the fake clock, the probe and the deploy on real promises. */
    const poll = async (): Promise<void> => {
      const before = edge.hits();
      fc.advance(POLL_INTERVAL_MS);
      await until(() => edge.hits() > before);
      await new Promise(r => setTimeout(r, 30));
    };
    const stop = rt.status.watch();
    try {
      await poll();
      await poll();
      await until(() => deployed.length === 1);
      await until(() => pushed.some(st => st.daemonNote === DAEMON_RESTART_FAILED));
      // Ten more polls, three minutes of them, all inside the cooldown: the machine is left alone.
      for (let i = 0; i < 10; i++) await poll();
      expect(deployed).toHaveLength(1);
      // The row a client is left looking at says the machine's daemon is dead, not that the machine answers: a
      // push made while the deploy ran must not paint over what the poll measured, or the poll's own word after it
      // reads as a repeat and never reaches the bus.
      expect(pushed.at(-1)!.reach.state).toBe("no-daemon");
      expect(pushed.at(-1)!.daemonNote).toBeUndefined();
      // Past the cooldown, it tries again on its own.
      fc.advance(DAEMON_REVIVE_AGAIN_MS);
      await poll();
      await until(() => deployed.length === 2);
    } finally {
      stop();
      warn.mockRestore();
    }
    expect(deployed[1]! - deployed[0]!).toBeGreaterThanOrEqual(DAEMON_REVIVE_AGAIN_MS);
    // Neither line about the daemon claims the machine answers. The runtime has no probe of its own between
    // polls, so a push carries what the poll measured rather than what a running machine's kind would claim.
    const aboutTheDaemon = pushed.filter(st => st.daemonNote === DAEMON_RESTARTING || st.daemonNote === DAEMON_RESTART_FAILED);
    expect(aboutTheDaemon.length).toBeGreaterThanOrEqual(3);
    expect(aboutTheDaemon.every(st => st.reach.state === "no-daemon")).toBe(true);
    // The row said it and stopped saying it; the npm log is in this host's log and nowhere a person reads.
    expect((await rt.workspaces.get(ws.id)).daemonNote).toBeUndefined();
    expect(warned.some(l => l.includes("not restarted") && l.includes("NPM_FAIL") && l.includes("m1"))).toBe(true);
    expect(pushed.every(st => st.daemonNote === undefined || !st.daemonNote.includes("NPM_FAIL"))).toBe(true);
  });

  it("a machine replaced under the record starts its own attempt instead of inheriting the old machine's cooldown", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const edge = await daemonPort(() => false);
    const deployed: string[] = [];
    const recipe = {
      setup: "true",
      smoke: "true",
      deployDaemon: async (machine: { id: string }) => {
        deployed.push(machine.id);
        throw new Error("daemon deploy failed: NPM_FAIL");
      },
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, status: { costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const edgeOn = (m: StubMachine): void => {
      m.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
    };
    edgeOn(backend.machines[0]!);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = rt.status.watch();
    try {
      await until(() => deployed.length === 1);
      await rt.workspaces.rebuild(ws.id);
      edgeOn(backend.machines[1]!);
      // Well inside the cooldown the first machine earned: the entry is that machine's, and this is another one.
      await until(() => deployed.length === 2, 5_000);
    } finally {
      stop();
      warn.mockRestore();
    }
    expect(deployed).toEqual(["m1", "m2"]);
  });

  it("leaves a dead daemon alone on a backend that mints no upload URL, since the deploy has no road to the machine", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    backend.capabilities.signedUrls = false;
    const edge = await daemonPort(() => false);
    const deployed: string[] = [];
    const recipe = { setup: "true", smoke: "true", deployDaemon: async (machine: { id: string }) => void deployed.push(machine.id) };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN, goldenRecipe: recipe, status: { costIntervalMs: 60_000, pollIntervalMs: 5, reconcileMinMs: 60_000 } });
    await rt.workspaces.create({ golden: "snap_g", name: "a" });
    backend.machines[0]!.previewUrl = async port => ({ url: `http://127.0.0.1:${edge.port}/?port=${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
    const stop = rt.status.watch();
    try {
      await until(() => edge.hits() >= 10);
    } finally {
      stop();
    }
    expect(deployed).toEqual([]);
  });

  it("updateDaemon refuses on a runtime whose recipe carries no deploy", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await expect(rt.workspaces.updateDaemon(ws.id)).rejects.toThrow("cannot deploy a daemon");
    await expect(rt.workspaces.updateDaemon("ws_nobody")).rejects.toThrow("no such workspace");
  });

  it("writes the token again after a resurrect replaces the machine", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const mint = async (port: number) => ({ url: `https://x-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: Date.now() + 3_600_000 });
    backend.machines[0]!.previewUrl = mint;
    expect((await rt.workspaces.daemonReach(ws.id)).daemonToken).toBe(TOKEN);

    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true;
    await rt.workspaces.wake(ws.id);
    backend.machines[1]!.previewUrl = mint;
    expect((await rt.workspaces.daemonReach(ws.id)).daemonToken).toBe(TOKEN);
    expect(backend.machines[1]!.execLog.filter(c => c.includes(TOKEN_PATH))).toEqual([rotateDaemonTokenScript(TOKEN)]);
  });
});

describe("runtime port reach", () => {
  it("mints a guest port's route once while fresh, caches per port, and never reads or carries the daemon token", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
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
    expect(backend.machines[0]!.execLog.filter(c => c.includes(TOKEN_PATH))).toHaveLength(0);
  });

  it("rejects an unknown workspace", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    await expect(rt.workspaces.portReach("ws_nobody", 3000)).rejects.toThrow(/no such workspace/);
  });
});

const VITE_BLOCKED = "Blocked request. This host (m1-5173.preview.example) is not allowed. To allow this host, add it to server.allowedHosts";

/** A guest port as the preview edge would relay it: one answer for every request, closed by the test. */
async function guestPort(statusCode: number, body: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => res.writeHead(statusCode, { "content-type": "text/plain" }).end(body));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}/?pt_token=edge` };
}

describe("runtime port probe", () => {
  const closing: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      closing.map(s => {
        s.closeAllConnections();
        return new Promise<void>(r => s.close(() => r()));
      }),
    );
    closing.length = 0;
  });

  it("fetches the port's minted route once and reports the status and body a frame cannot read", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const guest = await guestPort(403, VITE_BLOCKED);
    closing.push(guest.server);
    const minted: number[] = [];
    backend.machines[0]!.previewUrl = async port => {
      minted.push(port);
      return { url: guest.url, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    expect(await rt.workspaces.portProbe(ws.id, 5173)).toEqual({ status: 403, body: VITE_BLOCKED });
    expect(minted).toEqual([5173]);
  });

  it("cuts the body at the cap so a page never rides the reply whole", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const guest = await guestPort(200, "<html>".padEnd(PORT_PROBE_BODY_CAP + 500, "x"));
    closing.push(guest.server);
    backend.machines[0]!.previewUrl = async () => ({ url: guest.url, token: "edge", expiresAt: Date.now() + 3_600_000 });

    const probe = await rt.workspaces.portProbe(ws.id, 3000);
    expect(probe.status).toBe(200);
    expect(probe.body).toHaveLength(PORT_PROBE_BODY_CAP);
  });

  it("never follows a redirect: a 302 on the route is the frame's business, not a refetch without the token", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url?.startsWith("/app")) res.writeHead(401).end("edge: no token");
      else res.writeHead(302, { location: "/app" }).end();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    closing.push(server);
    const addr = server.address();
    const guestPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${guestPort}/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 });

    expect((await rt.workspaces.portProbe(ws.id, 3000)).status).toBe(302);
    expect(seen).toEqual(["/?pt_token=edge"]);
  });

  it("reads the body only up to the cap: a response that never ends still answers with its first bytes", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html>".padEnd(PORT_PROBE_BODY_CAP + 500, "x"));
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    closing.push(server);
    const addr = server.address();
    const guestPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${guestPort}/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 });

    const probe = await rt.workspaces.portProbe(ws.id, 3000);
    expect(probe.status).toBe(200);
    expect(probe.body).toHaveLength(PORT_PROBE_BODY_CAP);
    expect(probe.body.startsWith("<html>")).toBe(true);
  });

  it("a 401 drops the port's cached route and mints a fresh one, so the next portReach carries the new token", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const server = createServer((req, res) => {
      if (req.url?.endsWith("pt_token=t1")) res.writeHead(401).end("token expired");
      else res.writeHead(200).end("<!doctype html>");
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    closing.push(server);
    const addr = server.address();
    const guestPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    let mints = 0;
    backend.machines[0]!.previewUrl = async () => {
      mints++;
      return { url: `http://127.0.0.1:${guestPort}/?pt_token=t${mints}`, token: `t${mints}`, expiresAt: Date.now() + 3_600_000 };
    };

    expect((await rt.workspaces.portReach(ws.id, 3000)).url).toContain("pt_token=t1");
    expect((await rt.workspaces.portProbe(ws.id, 3000)).status).toBe(401);
    expect(mints).toBe(2);
    expect((await rt.workspaces.portReach(ws.id, 3000)).url).toContain("pt_token=t2");
    expect(mints).toBe(2);
    expect((await rt.workspaces.portProbe(ws.id, 3000)).status).toBe(200);
    expect(mints).toBe(2);
  });

  it("rejects when the route cannot be fetched at all, and rejects an unknown workspace", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const guest = await guestPort(200, "");
    await new Promise<void>(r => guest.server.close(() => r()));
    backend.machines[0]!.previewUrl = async () => ({ url: guest.url, token: "edge", expiresAt: Date.now() + 3_600_000 });

    await expect(rt.workspaces.portProbe(ws.id, 3000)).rejects.toThrow();
    await expect(rt.workspaces.portProbe("ws_nobody", 3000)).rejects.toThrow(/no such workspace/);
  });
});

describe("runtime golden builders", () => {
  const recipe = { setup: "install", smoke: "true" };

  it("an exec listener that throws is warned about once and never changes an exec's result: the prepare still completes", async () => {
    const backend = stubBackend();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let seen = 0;
      const rt = createRuntime({
        backend,
        store: memoryStore(),
        adapters: {},
        goldenRecipe: {
          ...recipe,
          onExec: () => {
            seen += 1;
            throw new Error("ENOSPC: no space left on device, write");
          },
        },
      });
      const builder = await rt.golden.prepare({ name: "default" });
      expect(builder.id).toBe(backend.machines[0]!.id);
      expect(backend.machines[0]!.execLog.length).toBeGreaterThan(0);
      expect(seen).toBe(backend.machines[0]!.execLog.length);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(`exec log for ${builder.id} failed, its execs go on unlogged: ENOSPC: no space left on device, write`);
    } finally {
      warn.mockRestore();
    }
  });

  it("a run reaches the exec listener as one command with its result, whatever carried it", async () => {
    const backend = stubBackend();
    const harness = (cmd: string) => cmd.includes("\ninstall' &");
    backend.execImpl = (_m, cmd) => (harness(cmd) ? { exitCode: 0, stdout: "harness on\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const seen: GoldenExec[] = [];
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: { ...recipe, onExec: e => void seen.push(e) } });
    await rt.golden.prepare({ name: "default" });
    // The base stage's steps, the harness install and the cache sweeps all run under the guard: nothing runs bare.
    expect(backend.machines[0]!.runLog.filter(s => !s.includes("setsid bash -c"))).toEqual([]);
    expect(backend.machines[0]!.runLog.filter(harness)).toHaveLength(1);
    expect(seen.filter(e => harness(e.cmd))).toEqual([expect.objectContaining({ machineId: "m1", exitCode: 0, stdout: "harness on\n" })]);
  });

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

  it("builderReach mints the builder's daemon route once while fresh and writes the token to the guest", async () => {
    const backend = stubBackend();
    let minted = 0;
    backend.execImpl = tokenGuest;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, daemonToken: TOKEN });
    const b = await rt.golden.prepare();
    expect(b.screen).toBeUndefined();
    backend.machines[0]!.previewUrl = async port => {
      minted++;
      return { url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 };
    };

    const reach = await rt.golden.builderReach(b.id);
    expect(reach).toEqual({ url: "https://m1-7070.preview.example/?pt_token=edge", expiresAt: expect.any(Number), daemonToken: TOKEN });
    await rt.golden.builderReach(b.id);
    expect(minted).toBe(1);
    expect(backend.machines[0]!.execLog.filter(c => c.includes(TOKEN_PATH))).toEqual([rotateDaemonTokenScript(TOKEN)]);
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
      failed: [{ id: first.id, message: "could not stop: 502 exec failed; stays recorded, retried next sweep" }],
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

describe("runtime machine context", () => {
  const probe = "WSP_CTX\nKERNEL 6.6.30\nDISK 20466256 11720704\nAGENT claude\nSHELL zsh\nWSP_CTX_END\n";
  const namesIn = (tgz: Buffer): string[] => execFileSync("tar", ["-tzf", "-"], { input: tgz }).toString("utf8").trim().split("\n");
  /** The context archives that went up for a machine: the texts travel through the upload road, never inside an exec. */
  const writes = (backend: StubBackend, m: StubMachine) => backend.puts.filter(p => p.machine === m.id && namesIn(p.body).includes("etc/wsp/machine-context.md")).map(p => p.body);
  const docOf = (tgz: Buffer) => execFileSync("tar", ["-xzOf", "-", "etc/wsp/skills/wsp-machine/SKILL.md"], { input: tgz }).toString("utf8");
  const version = { version: 4, snapshotId: "snap_g", baseTemplate: "base", setupSha: "abcdef0123456789", createdAt: "2026-09-05T10:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } };

  it("refreshes the document on the fresh fork with the workspace's name and its golden version", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: probe, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const store = memoryStore();
    await store.put("goldens", "default", { head: 4, versions: [version] });
    const rt = createRuntime({ backend, store, adapters: {} });
    await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const m = backend.machines[0]!;
    expect(writes(backend, m)).toHaveLength(1);
    expect(m.execLog.some(c => c.includes("base64 --decode"))).toBe(false);
    expect(m.execLog.findIndex(c => c.includes("tar xzf - -C '/' "))).toBeGreaterThan(m.execLog.findIndex(c => c.startsWith("hostname ")));
    const doc = docOf(writes(backend, m)[0]!);
    expect(doc).toContain("- Workspace: task-1.");
    expect(doc).toContain("- Golden: v4, sealed 2026-09-05, setup abcdef012345.");
    expect(doc).toContain("- Disk: 19.5 GB root disk, 11.2 GB free when this file was written.");
    expect(namesIn(writes(backend, m)[0]!)).toContain("etc/claude-code/CLAUDE.md");
    expect(namesIn(writes(backend, m)[0]!)).toContain("etc/claude-code/.claude/skills/wsp-machine/SKILL.md");
  });

  it("refreshes again on the fork an upgrade boots, and a guest that does not answer is only logged", async () => {
    const backend = stubBackend();
    backend.execImpl = (_m, cmd) => (cmd.includes("ls -A /root") ? { exitCode: 0, stdout: "notes.md\n", stderr: "" } : cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: probe, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
      expect(docOf(writes(backend, backend.machines[0]!)[0]!)).toContain("- Golden: version not recorded.");
      await rt.workspaces.upgrade(ws.id, { cpu: 4 });
      expect(writes(backend, backend.machines[1]!)).toHaveLength(1);
      expect(docOf(writes(backend, backend.machines[1]!)[0]!)).toContain("- Workspace: task-1.");

      backend.execImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
      const silent = await rt.workspaces.create({ golden: "snap_g", name: "task-2" });
      expect(silent.name).toBe("task-2");
      expect(writes(backend, backend.machines[2]!)).toHaveLength(0);
      expect(warn.mock.calls.some(c => String(c[0]).includes("machine context for") && String(c[0]).includes("without its markers"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
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

const TOKEN_PATH = "/root/.wsp-daemon-token";
const TOKEN = "deadbeef".repeat(3);
/** A guest with a daemon: the token write lands, everything else is silently fine. */
const tokenGuest = (_m: unknown, cmd: string) => (cmd.includes(TOKEN_PATH) ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });

/** A daemon on a loopback port that answers every op ok and announces the version it is set to right after the auth
 * reply, as the real one does: the one way a client learns a daemon's version, and the only way to stand an old one
 * up here, since the daemon in this checkout only ever announces the current version. */
async function helloingDaemon(version: number, holdHello = false): Promise<{ port: number; announce: (v: number) => void; release: () => void; close: () => Promise<void> }> {
  let announced = version;
  let held = holdHello;
  const waiting: (() => void)[] = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(done => wss.once("listening", () => done()));
  wss.on("connection", socket => {
    const hello = (): void => socket.send(JSON.stringify({ type: "daemon.hello", root: "/root", version: announced }));
    socket.on("message", raw => {
      const { id, op } = JSON.parse(String(raw)) as { id: number; op: string };
      socket.send(JSON.stringify({ id, ok: true }));
      if (op !== "auth") return;
      if (held) waiting.push(hello);
      else hello();
    });
  });
  return {
    port: (wss.address() as AddressInfo).port,
    announce: v => (announced = v),
    release: () => {
      held = false;
      for (const say of waiting.splice(0)) say();
    },
    close: () => new Promise<void>(done => wss.close(() => done())),
  };
}

/** The version a daemon on this port announces, read the way any client reads it: dial, auth, listen. */
async function helloOf(port: number): Promise<number> {
  const { default: WebSocket } = await import("ws");
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    return await new Promise<number>((done, fail) => {
      socket.on("open", () => socket.send(JSON.stringify({ id: 1, op: "auth", token: TOKEN })));
      socket.on("message", raw => {
        const m = JSON.parse(String(raw)) as { type?: string; version?: number };
        if (m.type === "daemon.hello") done(m.version ?? 1);
      });
      socket.on("error", fail);
    });
  } finally {
    socket.close();
  }
}

/** A real daemon on a loopback port for the runtime to ping, torn down with its inbox. */
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

describe("runtime create stages", () => {
  const ok = { exitCode: 0, stdout: "", stderr: "" };
  /** A stub whose forks carry an edge route to the given port and whose guest hands out the daemon token. */
  function edgeBackend(port: number) {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      const m = await create(spec);
      m.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
      return m;
    };
    return backend;
  }
  const creating = (events: EventUnion[]) => events.filter(e => e.type === "workspace.creating");

  it("a plain create reports every awaited step in order, names the hostname before the daemon is asked, and announces created last", async () => {
    await withDaemon(async port => {
      const backend = edgeBackend(port);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
      const stages = creating(events);
      expect(stages.map(e => e.stage)).toEqual(["fork-requested", "machine-booting", "hostname-set", "preview-route", "daemon-answering", "ready"]);
      expect(stages.map(e => e.message)).toEqual([
        "Fork of the golden image requested.",
        "Machine m1 is booting.",
        "Hostname set to task-1.",
        "Preview route to the daemon minted.",
        "Daemon answered through the edge.",
        "Ready.",
      ]);
      for (const e of stages) expect(e).toMatchObject({ workspaceId: ws.id, name: "task-1", elapsedMs: expect.any(Number) });
      expect(stages.some(e => "notice" in e)).toBe(false);
      const log = backend.machines[0]!.execLog;
      expect(log.indexOf("hostname task-1 && echo task-1 > /etc/hostname")).toBeLessThan(log.findIndex(c => c.includes(TOKEN_PATH)));
      const ready = events.findIndex(e => e.type === "workspace.creating" && e.stage === "ready");
      expect(events.findIndex(e => e.type === "workspace.created")).toBe(ready + 1);
    });
  });

  it("a fork whose daemon never answers still becomes a workspace: the stage says so, with the fault as its notice", async () => {
    const port = await deadPort();
    const backend = edgeBackend(port);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, wake: { pingTimeoutMs: 300 }, daemonToken: TOKEN });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const stages = creating(events);
    expect(stages.map(e => e.stage)).toEqual(["fork-requested", "machine-booting", "hostname-set", "preview-route", "daemon-answering", "ready"]);
    expect(stages[4]).toMatchObject({ message: "Daemon did not answer through the edge.", notice: expect.stringMatching(/daemon on m1 did not answer within 300 ms/) });
    expect(backend.machines[0]!.killed).toBe(false);
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([ws.id]);
  });

  it("a create that fails after the fork kills its machine, reports failed with the reason, and lists nothing", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const put = store.put.bind(store);
    store.put = async (collection, id, value) => {
      if (collection === "workspaces") throw new Error("disk full");
      return put(collection, id, value);
    };
    const rt = createRuntime({ backend, store, adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    await expect(rt.workspaces.create({ golden: "snap_g", name: "task-1" })).rejects.toThrow("disk full");
    const stages = creating(events);
    expect(stages.map(e => e.stage)).toEqual(["fork-requested", "machine-booting", "hostname-set", "failed"]);
    expect(stages.at(-1)!.message).toBe("disk full");
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
    expect(events.some(e => e.type === "workspace.created")).toBe(false);
  });

  it("until ready the workspace is neither listed nor reachable, so nothing opens a shell under the old hostname", async () => {
    const backend = stubBackend();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    backend.execImpl = async (_m, cmd) => {
      if (cmd.startsWith("hostname ")) await gate;
      return ok;
    };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ids: string[] = [];
    rt.events.on("workspace.creating", e => { if (e.type === "workspace.creating") ids.push(e.workspaceId); });
    const made = rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    await vi.waitFor(() => expect(backend.machines[0]!.execLog.some(c => c.startsWith("hostname "))).toBe(true));
    expect(await rt.workspaces.list()).toEqual([]);
    expect((await rt.status.list()).map(s => s.id)).toEqual([]);
    await expect(rt.workspaces.get(ids[0]!)).rejects.toThrow(/no such workspace/);
    release();
    const ws = await made;
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([ws.id]);
    expect((await rt.workspaces.get(ws.id)).id).toBe(ws.id);
  });
});

describe("runtime verified wake", () => {

  /** A stub whose guest answers ls/tar/untar/token like a golden fork; tar and untar commands are recorded per machine. */
  function guestBackend() {
    const backend = stubBackend();
    const tars: string[] = [];
    const untars: string[] = [];
    let tgzBytes = 1_000;
    backend.execImpl = (m, cmd) => {
      if (cmd.includes(TOKEN_PATH)) return tokenGuest(m, cmd);
      if (cmd.includes("ls -A /root")) return { exitCode: 0, stdout: "notes.md\n.local\n", stderr: "" };
      if (cmd.startsWith("wc -c <")) return { exitCode: 0, stdout: `${tgzBytes}\n`, stderr: "" };
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
      expect(phases.slice(0, 3)).toEqual(["pausing", "napping", "waking"]);
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
        const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: TOKEN });
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

  it("every nap replaces the stashed vault; one over the cap is refused with a warning, the previous stays, and the napping status says so once", async () => {
    const { backend, tars, setTgzBytes } = guestBackend();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = memoryStore();
      const rt = createRuntime({ backend, store, adapters: {}, wake: { vaultCapBytes: 5_000 }, vaultCaches: { dirs: ["node_modules", "dist"], files: [".DS_Store"], markers: [".git"] } });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const napReason = (): string | undefined => (events.filter(e => e.type === "workspace.status").at(-1) as { status: { phase: string; reason?: string } }).status.reason;
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));
      expect(napReason()).toBeUndefined();
      const script = backend.machines[0]!.runLog.find(s => s.includes("tar czf"))!;
      expect(script).toContain(`find 'root/notes.md' -mindepth 1 -path '*/.git' -prune -o \\( \\( -type d \\( -name 'node_modules' -o -name 'dist' \\) \\) -o \\( -type f \\( -name '.DS_Store' \\) \\) -o \\( -type d -exec test -f '{}/.git' \\; \\) \\) -prune -print > `);
      expect(script).toMatch(/tar czf '[^']+' --no-recursion --null -T '[^']+\.keep'/);
      await rt.workspaces.wake(ws.id);
      setTgzBytes(6_000);
      await rt.workspaces.nap(ws.id);
      expect(tars).toEqual(["m1", "m1"]);
      expect(await store.getBlob("vaults", ws.id)).toEqual(Buffer.from("tarbytes"));
      expect(warn.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("nap vault"))).toEqual([`nap vault for ${ws.id} not stored, previous kept: the export was 5.9 KB, over the 4.9 KB cap`]);
      expect((await rt.workspaces.get(ws.id)).phase).toBe("napping");
      expect(napReason()).toBe("nap kept the previous vault; the export was 5.9 KB, over the 4.9 KB cap");
      await rt.workspaces.wake(ws.id);
      setTgzBytes(1_000);
      await rt.workspaces.nap(ws.id);
      expect(napReason()).toBeUndefined();
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

  it("warns once, keeps the previous vault and says so on the napping status when the download URL cannot be fetched", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createRuntime({ backend, store, adapters: {} });
      const events: EventUnion[] = [];
      rt.events.on("*", e => events.push(e));
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      const first = await store.getBlob("vaults", ws.id);
      await rt.workspaces.wake(ws.id);

      backend.machines[0]!.downloadUrl = async () => "http://127.0.0.1:1/nothing-listens-here";
      await rt.workspaces.nap(ws.id);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(`nap vault for ${ws.id} not stored, previous kept: fetch failed`);
      expect(await store.getBlob("vaults", ws.id)).toEqual(first);
      expect((events.filter(e => e.type === "workspace.status").at(-1) as { status: { phase: string; reason?: string } }).status).toMatchObject({ phase: "napping", reason: "nap kept the previous vault; fetch failed" });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("runtime golden import", () => {
  const importOf = (recipeHash = "h1"): GoldenImport => ({
    recipeHash,
    files: { count: 1, rungs: { shell: 1 }, bytes: 10, skipped: [], pack: async () => ({ tar: Buffer.from("t"), bytes: 10, unpacked: 10, skipped: [], cut: [], silenced: [] }) },
    tools: [{ id: "tools/brew/jq", label: "jq", manager: "brew", cmd: "brew install jq" }],
    agents: [{ id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version" }],
  });
  const dfOk = (m: unknown, cmd: string) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: `${3000 * 1024}\n`, stderr: "" } : cmd === "echo ok" ? { exitCode: 0, stdout: "ok\n", stderr: "" } : cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });

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
      "deploying-daemon",
      ...["login shell PATH", "Node 22 with npm", "pnpm", "uv", "Python 3.12", "apt index", "git", "jq", "ripgrep", "curl", "Docker engine and compose", "C toolchain with cmake and ninja", "fd", "sqlite3", "wget", "zip and unzip", "xz", "rsync"].map((label, i) => `deploying-daemon:${label} (${i + 1}/18)`),
      "deploying-daemon:18 installed; caches swept; 2.9 GB free",
      // The stub answers the versions read with nothing, so the stage closes on the disk alone.
      "deploying-daemon:2.9 GB free",
      "applying-setup:1 file: shell 1",
      "applying-setup:10 B packed",
      "installing-harness",
      "installing-harness:Codex (1/1)",
      "installing-harness:Codex installed; caches swept; 2.9 GB free",
      "installing-tools:jq (1/1)",
      "installing-tools:1 installed; caches swept; 2.9 GB free",
      "installing-mcp:none configured",
      expect.stringMatching(/^installing-mcp:machine context: \d+(\.\d+)? KB written; no agent on the machine$/),
      "ready",
    ]);
    expect(await store.get("builders", b.id)).toMatchObject({ import: { recipeHash: "h1", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"], smoke: "codex --version" } });
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
      "installing-harness:already applied",
      "installing-tools:already applied",
      "installing-mcp:already applied",
      "ready:",
    ]);
    expect(await rt.golden.builders()).toHaveLength(1);
  });

  const recipeWith = (imp: GoldenImport) => ({ setup: "true", smoke: "true", import: imp });
  const SKIPPED = ["creating:already applied", "deploying-daemon:already applied", "applying-setup:already applied", "uploading-files:already applied", "installing-harness:already applied", "installing-tools:already applied", "installing-mcp:already applied", "ready:"];

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
    expect(await store.get("builders", b.id)).toMatchObject({ import: { recipeHash: "h1", applied: ["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"] } });
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
    expect(backend.machines[0]!.execLog.filter(c => c.includes(TOKEN_PATH))).toEqual([]);
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
    expect(frames.slice(-2)).toEqual(["installing-mcp:already applied", "failed:gone"]);
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

  it("a builder another process made after this one hydrated is never reaped while it is held or building, past the create grace", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const host = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "host:1" });
    expect(await host.golden.builders()).toEqual([]);

    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const init = createRuntime({ backend, store, adapters: {}, goldenRecipe: { ...recipeWith(importOf()), deployDaemon: m => (m.id === "m2" ? gate : Promise.resolve()) }, hostId: "init:2" });
    const held = await init.golden.prepare({ name: "done" });
    const building = init.golden.prepare({ name: "mid" });
    await vi.waitFor(async () => expect(await store.get("builders", "m2")).toMatchObject({ building: true }));
    for (const m of backend.machines) m.spec.labels!["createdAt"] = new Date(Date.now() - 2 * 60_000).toISOString();

    const swept = await host.reap();
    expect(swept.reaped).toEqual([]);
    expect(backend.machines.map(m => m.killed)).toEqual([false, false]);
    expect((await host.golden.builders()).map(b => [b.id, b.heldBy?.host, b.building])).toEqual([[held.id, "init:2", undefined], ["m2", "init:2", true]]);
    release();
    expect((await building).id).toBe("m2");
    await init.close();
  });

  /** A builder an earlier process left, hydrated here as reusable, then taken by a third process. */
  const takenAfterHydration = async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const crashed = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "old:1" });
    const b = await crashed.golden.prepare();
    await crashed.close();
    const host = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "host:2" });
    expect((await host.golden.builders())[0]).not.toHaveProperty("heldBy");
    const other = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "other:3" });
    expect((await other.golden.prepare()).id).toBe(b.id);
    return { backend, store, host, other, id: b.id };
  };

  it("a hold written after this process hydrated is seen by the sweep", async () => {
    const { backend, store, host, other, id } = await takenAfterHydration();
    const machine = backend.machines[0]!;
    machine.spec.labels!["createdAt"] = new Date(Date.now() - 7 * 3_600_000).toISOString();

    expect((await host.reap()).reaped).toEqual([]);
    expect(machine.killed).toBe(false);
    expect(await store.get("builders", id)).toMatchObject({ heldBy: { host: "other:3" } });
    await other.close();
  });

  it("a hold written after this process hydrated is seen by the attach lookup", async () => {
    const { backend, store, host, other, id } = await takenAfterHydration();

    expect((await host.golden.prepare()).id).not.toBe(id);
    expect(backend.machines).toHaveLength(2);
    expect(await store.get("builders", id)).toMatchObject({ heldBy: { host: "other:3" } });
    await other.close();
  });

  it("kill re-reads the record and refuses a builder another process has taken since hydration", async () => {
    const { backend, store, host, other, id } = await takenAfterHydration();

    await expect(host.golden.kill(id)).rejects.toThrow(/in use by another wsp process/);
    expect(backend.machines[0]!.killed).toBe(false);
    expect(await store.get("builders", id)).toMatchObject({ heldBy: { host: "other:3" } });
    await other.close();
  });

  it("a sweep whose last listing is older than a pass that admitted a row neither drops nor kills that row", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const inner = memoryStore();
    // The n-th listing of the builders is held after it read the store, so a pass started later lists and admits first.
    let gate: Promise<void> | undefined;
    let holdAt = 0;
    let listings = 0;
    let listed = false;
    const store: Store = {
      ...inner,
      list: async collection => {
        const rows = await inner.list(collection);
        if (collection === "builders" && ++listings === holdAt && gate !== undefined) {
          listed = true;
          await gate;
        }
        return rows;
      },
    };
    const host = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "host:1" });
    expect(await host.golden.builders()).toEqual([]);

    // The sweep lists once for itself and once inside its grace pass; the second is the last read before it kills.
    let release!: () => void;
    gate = new Promise<void>(r => (release = r));
    listings = 0;
    holdAt = 2;
    const sweep = host.reap();
    await vi.waitFor(() => expect(listed).toBe(true));
    const other = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), hostId: "other:2" });
    const b = await other.golden.prepare();
    backend.machines[0]!.spec.labels!["createdAt"] = new Date(Date.now() - 2 * 60_000).toISOString();
    const mine = await host.golden.prepare({ name: "mine" });
    const listing = async () => (await host.golden.builders()).map(x => [x.id, x.heldBy?.host]).sort();
    expect(await listing()).toEqual([[b.id, "other:2"], [mine.id, undefined]]);

    release();
    expect((await sweep).reaped).toEqual([]);
    expect(backend.machines.map(m => m.killed)).toEqual([false, false]);
    expect(await listing()).toEqual([[b.id, "other:2"], [mine.id, undefined]]);
    await other.close();
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
    expect(done.import?.applied).toHaveLength(5);

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
    expect(done.import?.applied).toEqual(["applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"]);
    expect(done.heldBy).toMatchObject({ pid: process.pid });
  });

  it("the record's createdAt is the label the provider got, as placeholder and as finished, even when the clock ticks between the stamp and the keyed create", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    // The attempt is keyed after this read, so the stamp the provider gets is later than the one in the spec.
    const ticking: Store = {
      ...store,
      get: async (collection, id) => {
        if (collection === "creates") vi.setSystemTime(Date.now() + 1);
        return store.get(collection, id);
      },
    };
    const rt = createRuntime({ backend, store: ticking, adapters: {}, goldenRecipe: recipeWith(importOf()) });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const b = await rt.golden.prepare();
      const m = backend.machines[0]!;
      const stored = (await store.get("builders", b.id)) as { createdAt: string };
      expect(stored.createdAt).toBe(m.spec.labels!["createdAt"]);
    } finally {
      vi.useRealTimers();
    }
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
    failing.execImpl = (x, cmd) => (setupRan(cmd) ? { exitCode: 1, stdout: "", stderr: "setup broke" } : dfOk(x, cmd));
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
    // One untar of the person's files under /root and one of the machine context at the root.
    expect(log.filter(c => c.includes("tar xzf - -C '/root'"))).toHaveLength(1);
    expect(log.filter(c => c.includes("tar xzf - -C '/' "))).toHaveLength(1);
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
    backend.execImpl = (m, cmd) => (setupRan(cmd) ? { exitCode: 1, stdout: "", stderr: "setup broke" } : dfOk(m, cmd));

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

describe("runtime golden update and the post-seal grace", () => {
  const dfOk = (m: unknown, cmd: string) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: `${3000 * 1024}\n`, stderr: "" } : cmd === "echo ok" ? { exitCode: 0, stdout: "ok\n", stderr: "" } : cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
  const snapshot = (recipeHash: string, dests: string[]): RecipeDigest => ({ ticks: dests.map(d => ({ id: `shell/${d}` })), files: dests.map(d => ({ id: `shell/${d}`, dest: d, path: `~/${d}`, digest: `d-${recipeHash}` })) });
  const importOf = (recipeHash = "h1", agents: GoldenImport["agents"] = [{ id: "agents/codex", name: "Codex", install: "codex-install", smoke: "codex --version" }]): GoldenImport => ({
    recipeHash,
    recipe: snapshot(recipeHash, [".zshrc"]),
    files: { count: 1, rungs: { shell: 1 }, bytes: 10, skipped: [], pack: async () => ({ tar: Buffer.from("t"), bytes: 10, unpacked: 10, skipped: [], cut: [], silenced: [] }) },
    tools: [],
    agents,
  });
  const recipeWith = (imp: GoldenImport) => ({ setup: "true", smoke: "true", import: imp });
  const deltaOf = (recipeHash = "h2"): GoldenDelta => ({
    import: {
      recipeHash,
      recipe: snapshot(recipeHash, [".zshrc", ".config/starship.toml"]),
      files: { count: 1, rungs: { shell: 1 }, bytes: 5, skipped: [], pack: async () => ({ tar: Buffer.from("d"), bytes: 5, unpacked: 5, skipped: [], cut: [], silenced: [] }) },
      tools: [{ id: "tools/npm/cowsay", label: "cowsay", manager: "npm", cmd: "npm install -g cowsay" }],
      agents: [],
    },
    retired: [{ id: "shell/bashrc", name: "~/.bashrc" }],
    retiredOnImage: [{ id: "shell/bashrc", name: "~/.bashrc" }],
  });
  const started = () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock, hostId: "h1" });
    return { backend, store, clock, advance, rt };
  };

  it("the seal keeps a builder built from a recipe: it runs on with the version on its record and view, the recipe is stored with the version, and the sweep leaves it be", async () => {
    const { backend, store, rt, clock } = started();
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    expect(version.version).toBe(1);
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_wsp-h1-default-v1", true]]);
    expect(frames.at(-1)).toBe("sealed:v1; builder kept for one more change");
    // A caller with no process left to end the window asks for no keep: the builder goes with the seal and leaves no record.
    const again = started();
    const b2 = await again.rt.golden.prepare();
    await again.rt.golden.seal(b2.id, { keepBuilder: false });
    expect(again.backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1-default-v1", true]]);
    expect(await again.store.list("builders")).toEqual([]);
    const sealedAt = new Date(clock.now()).toISOString();
    expect(await store.get("builders", b.id)).toMatchObject({ firstLife: true, sealed: { at: sealedAt, version: 1 }, import: { recipeHash: "h1" } });
    expect(await store.get("golden-recipes", "default@v1")).toEqual(snapshot("h1", [".zshrc"]));
    expect(await rt.golden.recipe()).toEqual(snapshot("h1", [".zshrc"]));
    expect(await rt.golden.builders()).toEqual([expect.objectContaining({ id: b.id, firstLife: true, sealed: { at: sealedAt, version: 1 } })]);
    expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
    expect(backend.machines[0]!.killed).toBe(false);
  });

  it("a snapshot the provider refuses leaves the builder as it was and recorded, so the next process attaches to it; a builder the provider no longer has loses its record", async () => {
    const refused = () => Object.assign(new Error("Failed to snapshot sandbox"), { kind: "snapshotUnavailable", status: 502, requestId: "req_1" });
    const backend = stubBackend();
    backend.execImpl = dfOk;
    backend.beforeSnapshot = () => { throw refused(); };
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), snapshotRetryMs: 1 });
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const b = await rt.golden.prepare();
    await expect(rt.golden.seal(b.id)).rejects.toMatchObject({ kind: "snapshotFailed", attempts: 3, builderState: "running", answer: { status: 502, requestId: "req_1" } });
    expect(frames.at(-1)).toBe("failed:the snapshot failed 3 times: the provider answered 502 Failed to snapshot sandbox (request req_1) while the builder read running");
    expect(backend.machines.map(m => m.killed)).toEqual([false]);
    expect(await rt.golden.get()).toBeUndefined();
    expect(await rt.golden.builders()).toEqual([expect.objectContaining({ id: b.id, firstLife: true })]);
    expect(await store.get("builders", b.id)).toMatchObject({ firstLife: true, import: { recipeHash: "h1" } });
    await rt.close();
    backend.beforeSnapshot = undefined;
    const again = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), snapshotRetryMs: 1, hostId: "h1" });
    expect((await again.golden.prepare()).id).toBe(b.id);
    expect((await again.golden.seal(b.id)).version.snapshotId).toBe("snap_wsp-h1-default-v1");
    expect(backend.machines).toHaveLength(2);

    const dropped = stubBackend();
    dropped.execImpl = dfOk;
    dropped.beforeSnapshot = m => { m.killed = true; throw refused(); };
    const lost = createRuntime({ backend: dropped, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith(importOf()), snapshotRetryMs: 1, hostId: "h1" });
    const b2 = await lost.golden.prepare();
    await expect(lost.golden.seal(b2.id)).rejects.toMatchObject({ kind: "snapshotFailed", attempts: 1, builderState: "gone" });
    expect(await lost.golden.builders()).toEqual([]);
  });

  it("a builder built without a recipe snapshot is consumed by the seal as before, and the golden has no recipe to diff", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith({ ...importOf(), recipe: undefined }) });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await rt.golden.builders()).toEqual([]);
    expect(await rt.golden.recipe()).toBeUndefined();
  });

  it("an update during the grace lands on the kept builder: the delta's stages run there, the dropped row is retired on v2 and never taken off, one smoke fork boots, v2 is sealed and current, and the window starts over", async () => {
    const { backend, store, rt, advance, clock } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    advance(5 * 60_000);
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const builder = backend.machines[0]!;
    const before = builder.execLog.length;
    const result = await rt.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("builder");
    expect(result.previousDropped).toBe(false);
    // The kept builder was sealed as v1, so v2 records v1's snapshot as its parent.
    expect(result.version).toMatchObject({ version: 2, snapshotId: "snap_wsp-h1-default-v2", parentSnapshotId: "snap_wsp-h1-default-v1", smoke: { cmd: "codex --version", exitCode: 0 }, retired: [{ id: "shell/bashrc", name: "~/.bashrc" }] });
    expect(result.manifest).toMatchObject({ head: 2, versions: [{ version: 1 }, { version: 2 }] });
    expect(await rt.golden.get()).toEqual(result.manifest);
    expect(frames).toEqual([
      "creating:your builder from v1, kept since the save",
      "applying-setup:1 row left on the image, retired: ~/.bashrc",
      "applying-setup:1 file: shell 1",
      "applying-setup:5 B packed",
      "uploading-files:5 B",
      expect.stringMatching(/^uploading-files:5 B in /),
      "installing-harness:",
      "installing-harness:no agent ticked",
      "installing-tools:cowsay (1/1)",
      "installing-tools:1 installed; caches swept; 2.9 GB free",
      "installing-mcp:none configured",
      expect.stringMatching(/^installing-mcp:machine context: \d+(\.\d+)? KB written; no agent on the machine$/),
      "ready:",
      "snapshotting:wsp-h1-default-v2",
      "smoke-forking:codex --version",
      "smoke-forking:1 agent answers: Codex",
      "sealed:v2; builder kept for one more change",
    ]);
    const ran = builder.execLog.slice(before);
    expect(ran[0]).toBe("true");
    expect(ran.some(c => c.includes("rm -rf -- '\\''/root/.bashrc'\\''"))).toBe(false);
    expect(ran.some(c => c.includes("npm install -g cowsay"))).toBe(true);
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_wsp-h1-default-v1", true], ["snap_wsp-h1-default-v2", true]]);
    expect(await store.get("builders", b.id)).toMatchObject({ sealed: { at: new Date(clock.now()).toISOString(), version: 2 }, import: { recipeHash: "h2", recipe: snapshot("h2", [".zshrc", ".config/starship.toml"]) } });
    expect(await store.get("golden-recipes", "default@v2")).toEqual(snapshot("h2", [".zshrc", ".config/starship.toml"]));
    expect(await rt.golden.recipe()).toEqual(snapshot("h2", [".zshrc", ".config/starship.toml"]));
    // Nine minutes after the second save the builder is still there; the window ran from that save, not the first.
    advance(9 * 60_000);
    expect(builder.killed).toBe(false);
    advance(60_000);
    // The timer's work is async: the kill lands, then the record goes.
    await vi.waitFor(async () => expect(await store.list("builders")).toEqual([]));
    expect(builder.killed).toBe(true);
  });

  it("the grace ends on the timer at GRACE_MS: the builder is killed and forgotten; a second process over the store past the window stops it on its sweep with reason grace", async () => {
    const { backend, store, rt, advance } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    advance(GRACE_MS - 1);
    expect(backend.machines[0]!.killed).toBe(false);
    advance(1);
    await vi.waitFor(async () => expect(await store.list("builders")).toEqual([]));
    expect(backend.machines[0]!.killed).toBe(true);
    await rt.close();

    const again = started();
    const b2 = await again.rt.golden.prepare();
    await again.rt.golden.seal(b2.id);
    await again.rt.close();
    // The next process reads the record as reusable; its clock is past the window, so the first sweep stops it.
    const late = fakeClock(again.clock.now() + GRACE_MS + 5_000);
    const next = createRuntime({ backend: again.backend, store: again.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: late.clock });
    expect(await next.golden.builders()).toEqual([expect.objectContaining({ id: b2.id, sealed: { at: expect.any(String), version: 1 } })]);
    expect(await next.reap()).toEqual({ reaped: [{ id: b2.id, builder: true, reason: "grace", ageMs: GRACE_MS + 5_000 }], spared: [] });
    expect(again.backend.machines[0]!.killed).toBe(true);
    expect(await again.store.list("builders")).toEqual([]);
  });

  it("coverage: a kept builder a second process rehydrates from the store seals its update with the floor the first process read", async () => {
    const { backend, store, rt, clock } = started();
    const floor = [{ name: "node", version: "22.23.2" }, { name: "pnpm", version: "10.4.1" }];
    backend.execImpl = (m, cmd) => (cmd.includes("VERSION node:") && !cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: "VERSION node: v22.23.2\nVERSION pnpm: 10.4.1\nVERSION docker: \n", stderr: "" } : dfOk(m, cmd));
    const b = await rt.golden.prepare();
    const { version: one } = await rt.golden.seal(b.id);
    expect(one.base).toEqual(floor);
    expect(await store.get("builders", b.id)).toMatchObject({ base: floor });
    await rt.close();
    // The second process runs no base stage and reads no versions: the floor v2 records is the record's alone.
    backend.execImpl = dfOk;
    const next = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock, hostId: "h1" });
    const result = await next.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("builder");
    expect(result.version.base).toEqual(floor);
    expect((await next.golden.get())?.versions.map(v => v.base)).toEqual([floor, floor]);
    expect(await store.get("builders", b.id)).toMatchObject({ sealed: { version: 2 }, base: floor });
    await next.close();
  });

  it("with the builder gone the update forks the head at its size: the delta runs on the fork and takes nothing off it, v2 is sealed and current, the fork is kept for its own window, and v1 stays for rollback", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    // Killed from outside wsp: the kept builder is found dead at update time and forgotten.
    backend.machines[0]!.killed = true;
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const result = await rt.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("fork");
    expect(result.manifest).toMatchObject({ head: 2, versions: [{ version: 1, snapshotId: "snap_wsp-h1-default-v1" }, { version: 2, snapshotId: "snap_wsp-h1-default-v2", parentSnapshotId: "snap_wsp-h1-default-v1" }] });
    expect(result.manifest.versions[0]).not.toHaveProperty("parentSnapshotId");
    expect(frames[0]).toBe("creating:fork of golden v1");
    const fork = backend.machines[2]!;
    expect(fork.spec).toMatchObject({ kind: "sandbox", fromSnapshot: "snap_wsp-h1-default-v1", cpu: 2, memMb: 4096, onIdle: "kill", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": expect.stringMatching(/^h_/) } });
    expect(fork.execLog.some(c => c.includes("rm -rf -- '\\''/root/.bashrc'\\''"))).toBe(false);
    expect(fork.execLog.some(c => c.includes("npm install -g cowsay"))).toBe(true);
    expect(fork.killed).toBe(false);
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1-default-v1", true], ["snap_wsp-h1-default-v1", false], ["snap_wsp-h1-default-v2", true]]);
    expect(await store.list("builders")).toEqual([expect.objectContaining({ id: fork.id, firstLife: true, sealed: { at: expect.any(String), version: 2 } })]);
    expect(await store.get("golden-recipes", "default@v1")).toBeDefined();
    expect(await store.get("golden-recipes", "default@v2")).toBeDefined();
  });

  it("keepPrevious false deletes the previous version's snapshot and drops it from the manifest; a snapshot that will not delete keeps its version", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const deleted = vi.spyOn(backend, "deleteSnapshot");
    const two = await rt.golden.upgrade({ delta: deltaOf("h2"), keepPrevious: false });
    expect(deleted.mock.calls).toEqual([["snap_wsp-h1-default-v1"]]);
    expect(two.previousDropped).toBe(true);
    expect(two.manifest).toEqual({ head: 2, versions: [expect.objectContaining({ version: 2 })] });
    expect(await rt.golden.get()).toEqual(two.manifest);
    expect(await store.get("golden-recipes", "default@v1")).toBeUndefined();
    expect(await store.get("golden-recipes", "default@v2")).toBeDefined();

    deleted.mockRejectedValueOnce(Object.assign(new Error("SnapshotHasChildren"), { status: 409 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const three = await rt.golden.upgrade({ delta: deltaOf("h3"), keepPrevious: false });
    warn.mockRestore();
    expect(three.previousDropped).toBe(false);
    expect(three.manifest).toMatchObject({ head: 3, versions: [{ version: 2 }, { version: 3 }] });
    expect(await store.get("golden-recipes", "default@v2")).toBeDefined();
  });

  it("keepPrevious false leaves a durable version alone while a workspace stands on it: its template would delete under the workspace's feet", async () => {
    const { backend, rt } = started();
    backend.capabilities.templates = true;
    const b = await rt.golden.prepare();
    const { version: one } = await rt.golden.seal(b.id);
    expect(one.templateId).toBe("tpl_wsp-h1-default-v1");
    const ws = await rt.workspaces.create({ golden: one.snapshotId, name: "on-v1" });
    expect(backend.machines.find(m => m.id === ws.machineId)!.spec).toMatchObject({ template: "tpl_wsp-h1-default-v1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const two = await rt.golden.upgrade({ delta: deltaOf("h2"), keepPrevious: false });
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual(["golden default v1 kept: on-v1 still on it"]);
    warn.mockRestore();
    expect(two.previousDropped).toBe(false);
    expect(two.manifest.versions.map(v => [v.version, v.templateId])).toEqual([[1, "tpl_wsp-h1-default-v1"], [2, "tpl_wsp-h1-default-v2"]]);
    expect(backend.templates.has("tpl_wsp-h1-default-v1")).toBe(true);
    expect(backend.snapshots.map(r => r.id)).toContain("snap_wsp-h1-default-v1");

    await rt.workspaces.delete(ws.id);
    const three = await rt.golden.upgrade({ delta: deltaOf("h3"), keepPrevious: false });
    expect(three.previousDropped).toBe(true);
    expect(backend.templates.has("tpl_wsp-h1-default-v2")).toBe(false);
    expect(backend.snapshots.map(r => r.id)).not.toContain("snap_wsp-h1-default-v2");
  });

  it("dropping the previous version on the fork road ends the fork builder first, since it descends from that snapshot", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    backend.machines[0]!.killed = true;
    const deleted = vi.spyOn(backend, "deleteSnapshot");
    const two = await rt.golden.upgrade({ delta: deltaOf(), keepPrevious: false });
    expect(two.road).toBe("fork");
    expect(two.previousDropped).toBe(true);
    expect(deleted.mock.calls).toEqual([["snap_wsp-h1-default-v1"]]);
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, true], ["snap_wsp-h1-default-v1", true], ["snap_wsp-h1-default-v1", true], ["snap_wsp-h1-default-v2", true]]);
    expect(await store.list("builders")).toEqual([]);
    expect(two.manifest).toEqual({ head: 2, versions: [expect.objectContaining({ version: 2 })] });
  });

  it("composes with the reuse rules: a kept builder from an earlier process is the update's machine; one another live process holds is neither used nor stopped from here", async () => {
    const first = started();
    const b = await first.rt.golden.prepare();
    await first.rt.golden.seal(b.id);
    await first.rt.close();

    const second = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: fakeClock(first.clock.now()).clock });
    const onKept = await second.golden.upgrade({ delta: deltaOf() });
    expect(onKept.road).toBe("builder");
    expect(first.backend.machines[0]!.killed).toBe(false);
    expect(await first.store.get("builders", b.id)).toMatchObject({ sealed: { version: 2 }, heldBy: { pid: process.pid } });
    await second.close();

    // Held by another live process (a pid that is not ours and is alive): listed, left alone, the update forks instead.
    const record = (await first.store.get("builders", b.id)) as { heldBy?: { host: string; pid: number; heartbeat: string } };
    await first.store.put("builders", b.id, { ...record, heldBy: { host: hostname(), pid: process.ppid, heartbeat: new Date().toISOString() } });
    const late = fakeClock(Date.now() + GRACE_MS + 60_000);
    const third = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: late.clock });
    expect(await third.golden.builders()).toEqual([expect.objectContaining({ id: b.id, heldBy: expect.objectContaining({ pid: process.ppid }), sealed: { at: expect.any(String), version: 2 } })]);
    expect(await third.reap()).toEqual({ reaped: [], spared: [] });
    expect(first.backend.machines[0]!.killed).toBe(false);
    const forked = await third.golden.upgrade({ delta: deltaOf("h3") });
    expect(forked.road).toBe("fork");
    expect(first.backend.machines[0]!.killed).toBe(false);
  });

  it("a delta that fails on the kept builder kills it, forgets it, and leaves the golden at its version", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    backend.execImpl = (m, cmd) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: "1\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const frames: string[] = [];
    rt.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    await expect(rt.golden.upgrade({ delta: deltaOf() })).rejects.toThrow(/your files need/);
    expect(frames.at(-1)).toMatch(/^failed:your files need/);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
    expect(await rt.golden.get()).toMatchObject({ head: 1, versions: [{ version: 1 }] });
    expect(backend.machines).toHaveLength(2);
  });

  it("the window is suspended while an update runs on the kept builder: the timer and the sweep leave it alone mid-stage, and the window is re-armed on success", async () => {
    const { backend, store, rt, advance } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    advance(9 * 60_000);
    let release: (() => void) | undefined;
    const gate = new Promise<void>(r => (release = r));
    let packing = false;
    const delta = deltaOf();
    delta.import.files!.pack = async () => {
      packing = true;
      await gate;
      return { tar: Buffer.from("d"), bytes: 5, unpacked: 5, skipped: [], cut: [], silenced: [] };
    };
    const running = rt.golden.upgrade({ delta });
    await vi.waitFor(() => expect(packing).toBe(true));
    expect(await store.get("builders", b.id)).not.toHaveProperty("sealed");
    advance(2 * 60_000);
    expect(await rt.reap()).toEqual({ reaped: [], spared: [] });
    expect(backend.machines[0]!.killed).toBe(false);
    release!();
    const result = await running;
    expect(result.road).toBe("builder");
    const settled = (await store.get("builders", b.id)) as Record<string, unknown>;
    expect(settled).toMatchObject({ sealed: { version: 2 } });
    // Settled: the record is sealed again and no longer marked as mid-setup, so the next process reuses it.
    expect(settled).not.toHaveProperty("building");
    advance(GRACE_MS);
    await vi.waitFor(async () => expect(await store.list("builders")).toEqual([]));
    expect(backend.machines[0]!.killed).toBe(true);
  });

  it("a crash mid-update leaves the kept builder marked building, so the next process over the store stops it as unfinished instead of keeping it six hours", async () => {
    const first = started();
    const b = await first.rt.golden.prepare();
    await first.rt.golden.seal(b.id);
    let packing = false;
    const delta = deltaOf();
    delta.import.files!.pack = async () => {
      packing = true;
      return new Promise(() => {});
    };
    void first.rt.golden.upgrade({ delta });
    await vi.waitFor(() => expect(packing).toBe(true));
    expect(await first.store.get("builders", b.id)).toMatchObject({ building: true });
    expect(await first.store.get("builders", b.id)).not.toHaveProperty("sealed");
    // The process died here; another one, past the window, reads the record.
    const late = fakeClock(first.clock.now() + GRACE_MS + 1000);
    const next = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: late.clock, hostId: "h1" });
    expect(await next.golden.builders()).toEqual([expect.objectContaining({ id: b.id, building: true })]);
    expect(await next.reap()).toEqual({ reaped: [{ id: b.id, builder: true, reason: "unfinished" }], spared: [] });
    expect(first.backend.machines[0]!.killed).toBe(true);
    expect(await first.store.list("builders")).toEqual([]);
  });

  it("an update whose smoke fork the cap refuses falls back to killing the builder first and says so on the result", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const create = backend.create.bind(backend);
    let refused = false;
    backend.create = async spec => {
      if (spec.fromSnapshot === "snap_wsp-h1-default-v2" && !refused) {
        refused = true;
        throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency" });
      }
      return create(spec);
    };
    const kept = await rt.golden.upgrade({ delta: deltaOf() });
    expect(kept.road).toBe("builder");
    expect(kept.builderKept).toBe(false);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
    backend.create = create;
    const forked = await rt.golden.upgrade({ delta: deltaOf("h3") });
    expect(forked.road).toBe("fork");
    expect(forked.builderKept).toBe(true);
  });

  it("a kept builder that fails the no-op is killed until gone and forgotten, never left billing; the update forks", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const builder = backend.machines[0]!;
    const exec = builder.exec.bind(builder);
    builder.exec = async cmd => {
      if (cmd === "true") throw new Error("502 Bad Gateway");
      return exec(cmd);
    };
    const result = await rt.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("fork");
    expect(builder.killed).toBe(true);
    expect((await store.list("builders")).map(r => (r as { id: string }).id)).toEqual([backend.machines[2]!.id]);
  });

  it("a kept builder past its window is never used, running or not: the update forks and the old one is stopped", async () => {
    const first = started();
    const b = await first.rt.golden.prepare();
    await first.rt.golden.seal(b.id);
    await first.rt.close();
    const late = fakeClock(first.clock.now() + GRACE_MS + 1000);
    const next = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: late.clock, hostId: "h1" });
    expect(await next.golden.builders()).toEqual([expect.objectContaining({ id: b.id, sealed: expect.objectContaining({ version: 1 }) })]);
    const result = await next.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("fork");
    expect(first.backend.machines[0]!.killed).toBe(true);
    expect(first.backend.machines[2]!.spec.fromSnapshot).toBe("snap_wsp-h1-default-v1");
    expect((await first.store.list("builders")).map(r => (r as { id: string }).id)).toEqual([first.backend.machines[2]!.id]);
  });

  it("a kept builder past its window whose kill fails is still never used: the update forks beside it and the record stays for the next sweep", async () => {
    const first = started();
    const b = await first.rt.golden.prepare();
    await first.rt.golden.seal(b.id);
    await first.rt.close();
    const machine = first.backend.machines[0]!;
    machine.kill = async () => {
      throw new Error("502 Bad Gateway");
    };
    const late = fakeClock(first.clock.now() + GRACE_MS + 1000);
    const next = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: late.clock, hostId: "h1" });
    const before = machine.execLog.length;
    const frames: string[] = [];
    next.events.on("golden.stage", e => { if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`); });
    const result = await next.golden.upgrade({ delta: deltaOf() });
    expect(result.road).toBe("fork");
    // Not even the no-op runs on it, and the person hears why it is still there.
    expect(machine.execLog).toHaveLength(before);
    expect(frames[0]).toBe(`creating:an earlier kept builder ${b.id}: could not stop: 502 Bad Gateway; stays recorded, retried next sweep`);
    expect(frames[1]).toBe("creating:fork of golden v1");
    expect(await first.store.get("builders", b.id)).toMatchObject({ sealed: { version: 1 } });
  });

  it("one kept builder whose kill fails does not stop the others: it is reported on the sweep and retried next time", async () => {
    const { backend, store, rt, advance } = started();
    const a = await rt.golden.prepare({ name: "a" });
    await rt.golden.seal(a.id);
    const b = await rt.golden.prepare({ name: "b" });
    await rt.golden.seal(b.id);
    const first = backend.machines[0]!;
    const kill = first.kill.bind(first);
    first.kill = async () => {
      throw new Error("502 Bad Gateway");
    };
    advance(GRACE_MS);
    await vi.waitFor(async () => expect(await store.list("builders")).toHaveLength(1));
    expect(backend.machines[2]!.killed).toBe(true);
    expect(first.killed).toBe(false);
    const swept = await rt.reap();
    expect(swept.reaped).toEqual([]);
    expect(swept.failed).toEqual([{ id: a.id, message: expect.stringContaining("502 Bad Gateway") }]);
    expect(await store.get("builders", a.id)).toMatchObject({ sealed: { version: 1 } });
    first.kill = kill;
    expect((await rt.reap()).reaped).toEqual([{ id: a.id, builder: true, reason: "grace", ageMs: expect.any(Number) }]);
    expect(await store.list("builders")).toEqual([]);
  });

  it("prepare never attaches to a builder kept since a save, even on the same recipe: a fresh one boots beside it", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const again = await rt.golden.prepare();
    expect(again.id).not.toBe(b.id);
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([[undefined, false], ["snap_wsp-h1-default-v1", true], [undefined, false]]);
    expect(await store.get("builders", b.id)).toMatchObject({ sealed: { version: 1 } });
    expect(await store.get("builders", again.id)).not.toHaveProperty("sealed");
  });

  it("a workspace create refused at the cap stops the kept builder first, says so, and creates; with no kept builder the refusal stands", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined && backend.machines.some(m => !m.killed)) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = await rt.workspaces.create({ golden: version.snapshotId, name: "one" });
    const said = warn.mock.calls.map(c => String(c[0]));
    warn.mockRestore();
    expect(backend.machines[0]!.killed).toBe(true);
    expect(await store.list("builders")).toEqual([]);
    expect(ws.machineId).toBe(backend.machines[2]!.id);
    // The person who asked for the workspace reads why a builder of theirs went, on the create's own result.
    expect(ws.notice).toBe("Stopped the builder kept from golden v1 to make room at the machine cap.");
    expect(said).toEqual([`workspace ${ws.id}: stopped the builder kept from golden v1 to make room at the machine cap (${b.id})`]);

    // Nothing left to stop: the refusal reaches the caller with its kind, and nothing of ours is killed.
    await expect(rt.workspaces.create({ golden: version.snapshotId, name: "two" })).rejects.toMatchObject({ kind: "concurrency" });
    expect(backend.machines.filter(m => m.killed).map(m => m.id)).toEqual([backend.machines[0]!.id, backend.machines[1]!.id]);
  });

  it("a create at the cap with nothing left to stop is refused in words naming the workspaces holding the slots, not the provider's sentence", async () => {
    const { backend, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    await rt.golden.kill(b.id);
    const first = await rt.workspaces.create({ golden: version.snapshotId, name: "first" });
    await rt.workspaces.create({ golden: version.snapshotId, name: "t-cap" });
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
      return create(spec);
    };
    const stages: EventUnion[] = [];
    rt.events.on("workspace.creating", e => stages.push(e));
    const refused = await rt.workspaces.create({ golden: version.snapshotId, name: "f2" }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ kind: "concurrency", status: 429, message: "both machine slots are in use: first, t-cap. Pause one or wait for a nap." });
    // The provider's own sentence is kept for whoever reads the log, never as the answer.
    expect((refused as { cause?: Error }).cause?.message).toBe("Too many concurrent sessions");
    // The app's creation log reads the failed stage, so the same words land there.
    expect(stages.at(-1)).toMatchObject({ stage: "failed", message: "both machine slots are in use: first, t-cap. Pause one or wait for a nap." });

    // A napped workspace holds no slot, so it is not named; the builder that is up is, as a builder.
    await rt.workspaces.nap(first.id);
    const kept = await rt.golden.prepare({ name: "wsp-golden" }).catch((e: unknown) => e);
    expect(kept).toMatchObject({ id: expect.any(String) });
    const again = await rt.workspaces.create({ golden: version.snapshotId, name: "f3" }).catch((e: unknown) => e);
    expect((again as Error).message).toBe("both machine slots are in use: t-cap, wsp-golden (builder). Pause one or wait for a nap.");
  });

  it("a create at the cap names a workspace whose own create is still in flight: its machine is up and holds a slot", async () => {
    const { backend, store, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    await rt.golden.kill(b.id);
    // A record reaches the store only once its machine is bound, so holding that write holds a create in flight.
    const put = store.put.bind(store);
    let bound = (): void => {};
    let land = (): void => {};
    const inFlight = new Promise<void>(resolve => { bound = resolve; });
    const held = new Promise<void>(resolve => { land = resolve; });
    store.put = async (collection, id, value) => {
      const r = value as { name?: string; machineId?: string };
      if (r.name === "slow" && (r.machineId ?? "") !== "") {
        bound();
        await held;
      }
      await put(collection, id, value);
    };
    const slow = rt.workspaces.create({ golden: version.snapshotId, name: "slow" });
    await inFlight;
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
      return create(spec);
    };
    const refused = await rt.workspaces.create({ golden: version.snapshotId, name: "f2" }).catch((e: unknown) => e);
    expect((refused as Error).message).toBe("a machine slot is in use: slow. Pause it or wait for a nap.");
    land();
    expect(await slow).toMatchObject({ name: "slow" });
  });

  it("a create that made room reports the fork twice, the second time with the builder it stopped as the notice", async () => {
    const { backend, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined && backend.machines.some(m => !m.killed)) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    const stages: EventUnion[] = [];
    rt.events.on("workspace.creating", e => stages.push(e));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = await rt.workspaces.create({ golden: version.snapshotId, name: "one" });
    warn.mockRestore();
    expect(stages.map(e => (e.type === "workspace.creating" ? e.stage : e.type))).toEqual(["fork-requested", "fork-requested", "machine-booting", "hostname-set", "ready"]);
    expect(stages[0]).not.toHaveProperty("notice");
    expect(stages[1]).toMatchObject({
      workspaceId: ws.id,
      message: "Fork of the golden image requested again.",
      notice: "Stopped the builder kept from golden v1 to make room at the machine cap.",
    });
    expect(stages.map(e => (e.type === "workspace.creating" ? e.name : ""))).toEqual(Array<string>(5).fill("one"));
  });

  it("a create that needs no room carries no notice, on the result and on the wire; one that made room carries it beside the workspace", async () => {
    const { backend, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    const srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    await rt.golden.kill(b.id);
    const quiet = await wsRequest(srv.port, "t", { op: "workspaces.create", golden: version.snapshotId, name: "quiet" });
    expect(quiet["ok"]).toBe(true);
    expect(quiet).not.toHaveProperty("notice");
    expect(quiet["workspace"]).not.toHaveProperty("notice");
    const second = await rt.golden.prepare({ name: "other" });
    await rt.golden.seal(second.id);
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined && backend.machines.filter(m => !m.killed).length >= 2) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const made = await wsRequest(srv.port, "t", { op: "workspaces.create", golden: version.snapshotId, name: "room" });
    warn.mockRestore();
    expect(made["ok"]).toBe(true);
    expect(made["notice"]).toBe("Stopped the builder kept from golden v1 to make room at the machine cap.");
    expect(made["workspace"]).not.toHaveProperty("notice");
    await srv.close();
  });

  it("with two kept builders one is stopped per refusal: the first retry succeeds and the second builder stays", async () => {
    const { backend, store, rt } = started();
    const a = await rt.golden.prepare({ name: "a" });
    const sealedA = await rt.golden.seal(a.id);
    const b = await rt.golden.prepare({ name: "b" });
    await rt.golden.seal(b.id);
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined && backend.machines.filter(m => !m.killed).length >= 2) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = await rt.workspaces.create({ golden: sealedA.version.snapshotId, name: "one" });
    warn.mockRestore();
    const stopped = [a.id, b.id].filter(id => backend.machines.find(m => m.id === id)!.killed);
    expect(stopped).toHaveLength(1);
    expect((await store.list("builders")).map(r => (r as { id: string }).id)).toEqual([a.id, b.id].filter(id => !stopped.includes(id)));
    expect(ws.notice).toBe("Stopped the builder kept from golden v1 to make room at the machine cap.");

    // The cap at one: the next create needs a second slot, so the remaining kept builder goes on the second refusal.
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined && backend.machines.filter(m => !m.killed).length >= 2) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const two = await rt.workspaces.create({ golden: sealedA.version.snapshotId, name: "two" });
    quiet.mockRestore();
    expect(await store.list("builders")).toEqual([]);
    expect(two.notice).toBe("Stopped the builder kept from golden v1 to make room at the machine cap.");
  });

  it("a kept builder another live process holds is not stopped to make room; the refusal stands", async () => {
    const first = started();
    const b = await first.rt.golden.prepare();
    const { version } = await first.rt.golden.seal(b.id);
    await first.rt.close();
    const record = (await first.store.get("builders", b.id)) as { heldBy?: { host: string; pid: number; heartbeat: string } };
    await first.store.put("builders", b.id, { ...record, heldBy: { host: hostname(), pid: process.ppid, heartbeat: new Date().toISOString() } });
    const next = createRuntime({ backend: first.backend, store: first.store, adapters: {}, goldenRecipe: recipeWith(importOf()), clock: fakeClock(first.clock.now()).clock });
    const create = first.backend.create.bind(first.backend);
    first.backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Sandbox limit reached (2)"), { kind: "concurrency" });
      return create(spec);
    };
    await expect(next.workspaces.create({ golden: version.snapshotId, name: "one" })).rejects.toMatchObject({ kind: "concurrency" });
    expect(first.backend.machines[0]!.killed).toBe(false);
  });

  it("the seal stamps the tools missing from the image on the version, and an update carries them on both roads", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const skippedTools = [{ id: "tools/brew-cask/raycast", label: "Raycast", note: "macOS app, no Linux build" }];
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith({ ...importOf(), skippedTools }), clock: fakeClock().clock });
    const b = await rt.golden.prepare();
    const want = [{ id: "tools/brew-cask/raycast", name: "Raycast", outcome: "skipped", note: "macOS app, no Linux build" }];
    expect((await rt.golden.seal(b.id)).version.missingTools).toEqual(want);
    const two = await rt.golden.upgrade({ delta: deltaOf("h2") });
    expect(two.road).toBe("builder");
    expect(two.version.missingTools).toEqual(want);
    backend.machines[0]!.killed = true;
    const three = await rt.golden.upgrade({ delta: deltaOf("h3") });
    expect(three.road).toBe("fork");
    expect(three.version.missingTools).toEqual(want);
    expect((await rt.golden.get())?.versions.map(v => v.missingTools)).toEqual([want, want, want]);
  });

  it("the seal stamps what the pack left off the image on the version, and an update carries it on both roads", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const left = [{ id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: /opt/homebrew/bin/terminal-notifier" }];
    const imp = importOf();
    const files = { ...imp.files!, pack: async () => ({ tar: Buffer.from("t"), bytes: 10, unpacked: 10, skipped: [...left], cut: [], silenced: [], leftBehind: left }) };
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith({ ...imp, files }), clock: fakeClock().clock });
    const b = await rt.golden.prepare();
    expect((await rt.golden.seal(b.id)).version.leftBehind).toEqual(left);
    const two = await rt.golden.upgrade({ delta: deltaOf("h2") });
    expect(two.road).toBe("builder");
    expect(two.version.leftBehind).toEqual(left);
    backend.machines[0]!.killed = true;
    const three = await rt.golden.upgrade({ delta: deltaOf("h3") });
    expect(three.road).toBe("fork");
    expect(three.version.leftBehind).toEqual(left);
    expect((await rt.golden.get())?.versions.map(v => v.leftBehind)).toEqual([left, left, left]);
  });

  it("an update stamps the logins it is given on the new version, on both roads; one given none carries none", async () => {
    const { backend, rt } = started();
    const b = await rt.golden.prepare();
    const v1 = [{ name: "GitHub CLI login", state: "signed-in" as const }, { name: "Codex login", state: "not-signed-in" as const }];
    await rt.golden.seal(b.id, { logins: v1 });
    const carried = [{ name: "GitHub CLI login", state: "signed-in" as const }, { name: "Codex login", state: "copied" as const }];
    const two = await rt.golden.upgrade({ delta: deltaOf("h2"), logins: carried });
    expect(two.road).toBe("builder");
    expect(two.version.logins).toEqual(carried);
    expect((await rt.golden.get())?.versions.map(v => v.logins)).toEqual([v1, carried]);
    backend.machines[0]!.killed = true;
    const three = await rt.golden.upgrade({ delta: deltaOf("h3"), logins: carried });
    expect(three.road).toBe("fork");
    expect(three.version.logins).toEqual(carried);
    const four = await rt.golden.upgrade({ delta: deltaOf("h4") });
    expect(four.version).not.toHaveProperty("logins");
  });

  it("an update with no golden to update is refused before anything boots", async () => {
    const { backend, rt } = started();
    await expect(rt.golden.upgrade({ delta: deltaOf() })).rejects.toThrow(/no golden named "default" to update/);
    expect(backend.machines).toEqual([]);
  });
});

describe("create idempotency keys", () => {
  type Spec = Parameters<ReturnType<typeof stubBackend>["create"]>[0];
  type Made = Promise<StubMachine>;
  /** Routes every create through `plan` first, so a test can lose an answer or hand back a replay. */
  const intercept = (backend: ReturnType<typeof stubBackend>, plan: (spec: Spec, real: (s: Spec) => Made) => Made): Spec[] => {
    const original = backend.create.bind(backend);
    const real = (spec: Spec): Made => original(spec) as Made;
    const specs: Spec[] = [];
    backend.create = async spec => {
      specs.push(spec);
      return plan(spec, real);
    };
    return specs;
  };
  const lostAnswer = () => new TypeError("fetch failed");

  it("a workspace create carries a key made of the workspace id and a nonce, gone from the store once the machine exists", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    expect(backend.machines[0]!.spec.idempotencyKey).toMatch(new RegExp(`^workspace/${ws.id}:[0-9a-f]{16}$`));
    expect(await store.list("creates")).toEqual([]);
  });

  it("a retry of an attempt the provider never answered sends the same key and the same body", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true;
    let lose = true;
    const specs = intercept(backend, (spec, real) => {
      if (lose) {
        lose = false;
        throw lostAnswer();
      }
      return real(spec);
    });
    await expect(rt.workspaces.wake(ws.id)).rejects.toThrow("fetch failed");
    expect(await store.list("creates")).toHaveLength(1);
    const woken = await rt.workspaces.wake(ws.id);
    expect(woken.machineId).toBe("m2");
    expect(specs).toHaveLength(2);
    expect(specs[1]!.idempotencyKey).toBe(specs[0]!.idempotencyKey);
    expect(specs[1]!.labels?.["createdAt"]).toBe(specs[0]!.labels?.["createdAt"]);
    expect(specs[1]!.idempotencyKey).not.toBe(backend.machines[0]!.spec.idempotencyKey);
    expect(await store.list("creates")).toEqual([]);
  });

  it("a new attempt after a kill, a refusal or a changed request mints a new key", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    await rt.workspaces.upgrade(ws.id, { cpu: 4 });
    const [first, second] = backend.machines.map(m => m.spec.idempotencyKey);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(second).not.toBe(first);

    let refuse = true;
    const specs = intercept(backend, (spec, real) => {
      if (refuse) {
        refuse = false;
        throw Object.assign(new Error("at cap"), { kind: "concurrency", status: 429 });
      }
      return real(spec);
    });
    await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow("at cap");
    expect(await store.list("creates")).toEqual([]);
    await rt.workspaces.rebuild(ws.id);
    expect(specs[1]!.idempotencyKey).not.toBe(specs[0]!.idempotencyKey);

    let lose = true;
    specs.length = 0;
    backend.create = async spec => {
      specs.push(spec);
      if (lose) {
        lose = false;
        throw lostAnswer();
      }
      return stubBackend().create(spec);
    };
    await expect(rt.golden.build({ setup: "true", smoke: "true", cpu: 2 })).rejects.toThrow("fetch failed");
    expect(await store.list("creates")).toHaveLength(1);
    await rt.golden.build({ setup: "true", smoke: "true", cpu: 4 });
    expect(specs.slice(0, 2).map(s => s.cpu)).toEqual([2, 4]);
    expect(specs[1]!.idempotencyKey).not.toBe(specs[0]!.idempotencyKey);
    expect(await store.list("creates")).toEqual([]);
  });

  it("a replayed create is logged, and a replay naming a dead machine is created anew under a fresh key", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
      await rt.workspaces.nap(ws.id);
      backend.machines[0]!.killed = true;
      const specs = intercept(backend, async (spec, real) => {
        const m = await real(spec);
        if (specs.length === 1) m.killed = true;
        return Object.assign(Object.create(m) as typeof m, { replayed: specs.length <= 2 });
      });
      const woken = await rt.workspaces.wake(ws.id);
      expect(woken.machineId).toBe("m3");
      expect(specs.map(s => s.idempotencyKey)).toHaveLength(2);
      expect(specs[1]!.idempotencyKey).not.toBe(specs[0]!.idempotencyKey);
      const notes = warn.mock.calls.map(c => String(c[0]));
      expect(notes.some(n => n.includes("m2") && n.includes("gone"))).toBe(true);
      expect(notes.some(n => n.includes("m3") && n.includes("replayed"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("adopting a dead process's attempt takes the key and rewrites the entry to the adopter", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    await rt.workspaces.nap(ws.id);
    backend.machines[0]!.killed = true;
    let losses = 2;
    const specs = intercept(backend, (spec, real) => {
      if (losses-- > 0) throw lostAnswer();
      return real(spec);
    });
    await expect(rt.workspaces.wake(ws.id)).rejects.toThrow("fetch failed");
    const purpose = `workspace/${ws.id}`;
    const left = (await store.get("creates", purpose)) as { key: string; pid: number };
    expect(left.pid).toBe(process.pid);
    const deadPid = 99_999_999;
    await store.put("creates", purpose, { ...left, pid: deadPid });
    await expect(rt.workspaces.wake(ws.id)).rejects.toThrow("fetch failed");
    expect(await store.get("creates", purpose)).toMatchObject({ key: left.key, pid: process.pid });
    await rt.workspaces.wake(ws.id);
    expect(specs.map(s => s.idempotencyKey)).toEqual([left.key, left.key, left.key]);
    expect(await store.list("creates")).toEqual([]);
  });

  it("a purpose too long for the provider's 255-character key cap is hashed, the nonce kept", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await rt.golden.build({ name: "g".repeat(300), setup: "true", smoke: "true" });
    const key = backend.machines[0]!.spec.idempotencyKey!;
    expect(key.length).toBeLessThanOrEqual(255);
    expect(key).toMatch(/^[0-9a-f]{64}:[0-9a-f]{16}$/);
  });

  it("a builder and its smoke fork carry keys for the golden they build", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    await rt.golden.build({ setup: "true", smoke: "true" });
    expect(backend.machines.map(m => m.spec.idempotencyKey)).toEqual([
      expect.stringMatching(/^golden\/default:[0-9a-f]{16}$/),
      expect.stringMatching(/^golden\/default:[0-9a-f]{16}$/),
    ]);
    expect(backend.machines[0]!.spec.idempotencyKey).not.toBe(backend.machines[1]!.spec.idempotencyKey);
  });
});

describe("runtime session steer", () => {
  const SID = "66666666-6666-4666-8666-666666666666";
  /** A harness whose turn runs until the test ends it; steer records the prompt and answers as told, or is absent. */
  const steerable = (opts: { steers?: boolean; answer?: "accepted" | "not-running" } = {}) => {
    const steered: string[] = [];
    let onEvent: ((e: AdapterEvent) => void) | undefined;
    let finish!: (r: TurnResult) => void;
    const finished = new Promise<TurnResult>(r => (finish = r));
    const steers = opts.steers ?? true;
    const adapter: HarnessAdapterFactory = () => ({
      steers,
      start: o => {
        onEvent = o.onEvent;
        return {
          localId: SID,
          finished,
          interrupt: async () => {},
          ...(steers
            ? {
                steer: async (prompt: string) => {
                  steered.push(prompt);
                  return opts.answer ?? "accepted";
                },
              }
            : {}),
        };
      },
    });
    return {
      adapter,
      steered,
      init: () => onEvent!({ type: "session.start", sessionId: SID, model: "claude-sonnet-4-5" }),
      end: () => {
        onEvent!({ type: "turn.done", sessionId: SID, result: { status: "completed", text: "ok" } });
        onEvent!({ type: "session.end", sessionId: SID, exitCode: 0, sawResult: true });
        finish({ status: "completed", text: "ok" });
      },
    };
  };

  it("accepted: the adapter takes the line and the runtime records session.steer under the turn's scope with the prompt and the request id; no session.start comes with it", async () => {
    const h = steerable();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go", requestId: "req_1" });
    h.init();
    expect(await rt.sessions.steer(handle.id, { prompt: "and say pineapple", requestId: "req_2" })).toEqual({ outcome: "accepted" });
    expect(h.steered).toEqual(["and say pineapple"]);
    const start = events.find(e => e.type === "session.start") as Extract<SessionEvent, { type: "session.start" }>;
    const steers = events.filter(e => e.type === "session.steer");
    expect(steers).toMatchObject([
      { type: "session.steer", workspaceId: ws.id, sessionId: SID, turnId: start.turnId, threadId: start.threadId, prompt: "and say pineapple", requestId: "req_2", at: expect.any(Number) },
    ]);
    expect(start.turnId).toBeDefined();
    expect(start.threadId).toBeDefined();
    expect(events.filter(e => e.type === "session.start")).toHaveLength(1);
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("running");
    h.end();
    await handle.finished;
    const history = await rt.sessions.history(ws.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.steer", "session.done", "session.end"]);
    expect(history[1]).toMatchObject({ type: "session.steer", prompt: "and say pineapple" });
    await rt.close();
  });

  it("not-found for a session this runtime does not hold", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: steerable().adapter } });
    expect(await rt.sessions.steer("nope", { prompt: "x" })).toEqual({ outcome: "not-found" });
  });

  it("not-running once the turn ended, and when the adapter says the line missed the turn; nothing is recorded either way", async () => {
    const late = steerable({ answer: "not-running" });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: late.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    late.init();
    expect(await rt.sessions.steer(handle.id, { prompt: "racing" })).toEqual({ outcome: "not-running" });
    expect(late.steered).toEqual(["racing"]);
    late.end();
    await handle.finished;
    expect(await rt.sessions.steer(handle.id, { prompt: "too late" })).toEqual({ outcome: "not-running" });
    expect(late.steered).toEqual(["racing"]);
    expect(events.some(e => e.type === "session.steer")).toBe(false);
    await rt.close();
  });

  it("over the claude adapter on a fake machine: a steer after the CLI exited, before the poll saw it, answers not-running, appends nothing and records nothing", async () => {
    const backend = stubBackend();
    const plain = backend.execImpl;
    const log = Buffer.from(`{"type":"system","subtype":"init","session_id":"${SID}"}\n`);
    let exitFile = "";
    const appends: string[] = [];
    backend.execImpl = (m, cmd) => {
      if (cmd.includes("WSP_LAUNCHED")) return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
      const sentinel = cmd.match(/(__WSP_EOF_[a-z0-9]+__)/)?.[1];
      if (sentinel !== undefined) {
        const from = Number(cmd.match(/tail -c \+(\d+)/)?.[1] ?? "1") - 1;
        return { exitCode: 0, stdout: `${log.subarray(from).toString("base64")}\n${sentinel} ${exitFile} ${exitFile === "" ? "up" : "down"}\n`, stderr: "" };
      }
      if (cmd.includes("base64 -d >> ")) {
        appends.push(cmd);
        return { exitCode: 0, stdout: exitFile === "" ? "WSP_OK\n" : "WSP_GONE\n", stderr: "" };
      }
      return plain(m, cmd);
    };
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: { claude: ctx => createClaudeAdapter({ exec: machineExecStream(ctx.machine, { pollMs: 200 }), configDir: "/root/.claude-cfg" }) },
    });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    await vi.waitFor(() => expect(events.some(e => e.type === "session.start")).toBe(true));
    exitFile = "1";
    expect(await rt.sessions.steer(handle.id, { prompt: "after exit" })).toEqual({ outcome: "not-running" });
    expect(appends).toHaveLength(1);
    expect(events.some(e => e.type === "session.steer")).toBe(false);
    expect((await handle.finished).status).toBe("failed");
    expect((await rt.sessions.history(ws.id)).some(e => e.type === "session.steer")).toBe(false);
    await rt.close();
  });

  it("unsupported when the session's harness takes no message mid-turn; the catalog says so before the turn runs", async () => {
    const plain = steerable({ steers: false });
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: plain.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    expect((await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!.steers).toBe(false);
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    plain.init();
    expect(await rt.sessions.steer(handle.id, { prompt: "x" })).toEqual({ outcome: "unsupported" });
    expect((await rt.sessions.history(ws.id)).some(e => e.type === "session.steer")).toBe(false);
    plain.end();
    await handle.finished;
    await rt.close();
  });

  it("harnesses.list carries steers from the adapter on a workspace; the table alone, with no machine to ask, says false", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: steerable().adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    expect((await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!.steers).toBe(true);
    expect((await rt.harnesses.list()).find(c => c.harness === "claude")!.steers).toBe(false);
    await rt.close();
  });

  it("a steer inside a turn keeps the idle hold: the workspace stays awake through the window and naps after the turn ends", async () => {
    const h = steerable();
    const fc = fakeClock();
    const WINDOW = 5 * 60_000;
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter }, clock: fc.clock, idle: { defaultWindowMs: WINDOW }, status: { costIntervalMs: 60_000, pollIntervalMs: 60_000 } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    h.init();
    fc.advance(WINDOW * 2);
    expect(await rt.sessions.steer(handle.id, { prompt: "more" })).toEqual({ outcome: "accepted" });
    fc.advance(WINDOW * 2);
    expect((await rt.workspaces.get(ws.id)).phase).toBe("running");
    h.end();
    await handle.finished;
    await new Promise(r => setTimeout(r, 20));
    fc.advance(WINDOW);
    await vi.waitFor(async () => expect((await rt.workspaces.get(ws.id)).phase).toBe("napping"));
    await rt.close();
  });

  it("refuses while the workspace is pausing and once it is paused, with the composer's sentence, as start does", async () => {
    const backend = stubBackend();
    const h = steerable();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    h.init();
    const m = backend.machines[0]!;
    let releasePause: () => void = () => {};
    const gate = new Promise<void>(r => (releasePause = r));
    const pause = m.pause.bind(m);
    m.pause = async () => {
      await gate;
      await pause();
    };
    const napping = rt.workspaces.nap(ws.id);
    await vi.waitFor(async () => expect((await rt.workspaces.get(ws.id)).phase).toBe("pausing"));
    await expect(rt.sessions.steer(handle.id, { prompt: "x" })).rejects.toThrow("Workspace is pausing; wake it to send");
    expect(h.steered).toEqual([]);
    releasePause();
    await napping;
    await expect(rt.sessions.steer(handle.id, { prompt: "x" })).rejects.toThrow("Workspace is paused; wake it to send");
    await rt.close();
  });
});

/** A harness whose every turn runs until the test ends it; a resumed start keeps the session id, as the real one
 * does, and steers when told to. `end` completes a turn with the text, and whatever else of the result is given. */
const held = (steers: boolean) => {
  const starts: HarnessStartOptions[] = [];
  const steered: string[] = [];
  const turns: { sessionId: string; onEvent: (e: AdapterEvent) => void; finish: (r: TurnResult) => void }[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers,
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? randomUUID();
      let finish!: (r: TurnResult) => void;
      const finished = new Promise<TurnResult>(r => (finish = r));
      turns.push({ sessionId, onEvent: o.onEvent, finish });
      o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
      return {
        localId: sessionId,
        finished,
        interrupt: async () => {},
        ...(steers
          ? {
              steer: async (prompt: string) => {
                steered.push(prompt);
                return "accepted" as const;
              },
            }
          : {}),
      };
    },
  });
  const results: TurnResult[] = [];
  /** The harness's result lands while its process keeps running. */
  const reply = (turn: number, text: string, more: Partial<TurnResult> = {}): void => {
    const t = turns[turn]!;
    results[turn] = { status: "completed", text, ...more };
    t.onEvent({ type: "turn.done", sessionId: t.sessionId, result: results[turn]! });
  };
  /** The process exits, after its reply. */
  const exit = (turn: number): void => {
    const t = turns[turn]!;
    t.onEvent({ type: "session.end", sessionId: t.sessionId, exitCode: 0, sawResult: true });
    t.finish(results[turn]!);
  };
  const end = (turn: number, text: string, more: Partial<TurnResult> = {}): void => {
    reply(turn, text, more);
    exit(turn);
  };
  return { adapter, starts, steered, reply, exit, end };
};
const settle = () => new Promise<void>(r => setTimeout(r, 20));

describe("a start on a thread whose turn is running", () => {
  it("on a harness that steers, the start becomes a steer: session.steer is recorded with the request id, no second session.start, and the caller holds the running turn", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "loop for a minute", requestId: "req_1" });
    expect(first.outcome).toBe("started");
    const sid = first.view().claudeSessionId!;
    const joined = await rt.sessions.start(ws.id, { prompt: "end with STEERED", resume: sid, requestId: "req_2", startedBy: "cli" });
    expect(joined.outcome).toBe("steered");
    expect(joined.id).toBe(first.id);
    expect(joined.turnId).toBe(first.turnId);
    expect(joined.finished).toBe(first.finished);
    expect(joined.view()).toMatchObject({ threadId: first.view().threadId, status: "running", prompt: "loop for a minute" });
    expect(h.starts).toHaveLength(1);
    expect(h.steered).toEqual(["end with STEERED"]);
    expect(events.filter(e => e.type === "session.start")).toHaveLength(1);
    expect(events.some(e => e.type === "session.queued")).toBe(false);
    expect(events.filter(e => e.type === "session.steer")).toMatchObject([{ sessionId: sid, turnId: first.turnId, threadId: first.view().threadId, prompt: "end with STEERED", requestId: "req_2" }]);
    expect(await rt.sessions.list(ws.id)).toHaveLength(1);
    h.end(0, "done STEERED");
    expect(await joined.finished).toEqual({ status: "completed", text: "done STEERED" });
    expect((await rt.sessions.history(ws.id)).map(e => e.type)).toEqual(["session.start", "session.steer", "session.done", "session.end"]);
    await rt.close();
  });

  it("on a harness that cannot steer, the start waits for the running turn and follows its done: one turn at a time on the session", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const first = await rt.sessions.start(ws.id, { prompt: "one" });
    const sid = first.view().claudeSessionId!;
    let second: Awaited<ReturnType<typeof rt.sessions.start>> | undefined;
    const pending = rt.sessions.start(ws.id, { prompt: "two", resume: sid, requestId: "req_2" }).then(s => (second = s));
    await settle();
    expect(h.starts.map(s => s.prompt)).toEqual(["one"]);
    expect(second).toBeUndefined();
    // The wait is announced at once, so a caller can say it is waiting before the reply comes.
    expect(events.filter(e => e.type === "session.queued")).toEqual([{ type: "session.queued", workspaceId: ws.id, threadId: first.view().threadId, prompt: "two", requestId: "req_2", seq: expect.any(Number) }]);
    h.end(0, "one done");
    await pending;
    expect(second!.outcome).toBe("queued");
    expect(second!.turnId).not.toBe(first.turnId);
    expect(h.starts.map(s => [s.prompt, s.resume])).toEqual([["one", undefined], ["two", sid]]);
    expect(second!.view()).toMatchObject({ status: "running", prompt: "one", threadId: first.view().threadId });
    h.end(1, "two done");
    expect(await second!.finished).toEqual({ status: "completed", text: "two done" });
    const history = await rt.sessions.history(ws.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.done", "session.end", "session.start", "session.done", "session.end"]);
    expect(history[3]).toMatchObject({ type: "session.start", prompt: "two", requestId: "req_2", threadId: first.view().threadId, turnId: second!.turnId });
    expect(history.some(e => e.type === "session.steer")).toBe(false);
    expect(events.filter(e => e.type === "session.queued")).toHaveLength(1);
    await rt.close();
  });

  it("two sends queued behind one turn run in order, each after the one before it ended", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const sid = (await rt.sessions.start(ws.id, { prompt: "one" })).view().claudeSessionId!;
    const outcomes: string[] = [];
    const two = rt.sessions.start(ws.id, { prompt: "two", resume: sid }).then(s => outcomes.push(`two:${s.outcome}`));
    const three = rt.sessions.start(ws.id, { prompt: "three", resume: sid }).then(s => outcomes.push(`three:${s.outcome}`));
    await settle();
    expect(h.starts.map(s => s.prompt)).toEqual(["one"]);
    expect(events.filter(e => e.type === "session.queued").map(e => (e as { prompt: string }).prompt)).toEqual(["two", "three"]);
    h.end(0, "one done");
    await two;
    await settle();
    expect(h.starts.map(s => s.prompt)).toEqual(["one", "two"]);
    expect(outcomes).toEqual(["two:queued"]);
    h.end(1, "two done");
    await three;
    expect(h.starts.map(s => s.prompt)).toEqual(["one", "two", "three"]);
    expect(outcomes).toEqual(["two:queued", "three:queued"]);
    h.end(2, "three done");
    // Each waiter says so once, when it first waits; the second wait of the third send is not announced again.
    expect(events.filter(e => e.type === "session.queued")).toHaveLength(2);
    expect((await rt.sessions.history(ws.id)).filter(e => e.type === "session.start").map(e => e.prompt)).toEqual(["one", "two", "three"]);
    await rt.close();
  });

  it("a start on another thread of the same workspace is not held back by the running turn", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "one" });
    const other = await rt.sessions.start(ws.id, { prompt: "elsewhere" });
    expect(other.outcome).toBe("started");
    expect(h.starts.map(s => s.prompt)).toEqual(["one", "elsewhere"]);
    await rt.close();
  });
});

describe("a thread whose start named who to tell", () => {
  it("a running parent that steers is told by one steer: the line, with the outcome, duration, cost and the reply's last line, and the child's transcript holds a session.notify naming the parent", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    const parentThread = parent.view().threadId!;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: parentThread, startedBy: "agent" });
    const kidThread = kid.view().threadId!;
    expect(kidThread).not.toBe(parentThread);
    h.end(1, "Ran the gate.\n\nAll 12 tests green.\n", { durationMs: 492_000, costUsd: 1.94 });
    const line = `thread ${kidThread.slice(0, 8)} finished (completed, 8m 12s, $1.94): All 12 tests green.`;
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate", startedBy: "cli" });
    const parentThread = parent.view().threadId!;
    const parentSid = parent.view().claudeSessionId!;
    h.end(0, "waiting for the builder");
    await parent.finished;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: parentThread });
    const kidThread = kid.view().threadId!;
    h.end(1, "done", { durationMs: 1_500, costUsd: 0.0042 });
    await vi.waitFor(() => expect(h.starts).toHaveLength(3));
    const line = `thread ${kidThread.slice(0, 8)} finished (completed, 1.5s, $0.0042): done`;
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    const parentThread = parent.view().threadId!;
    const parentSid = parent.view().claudeSessionId!;
    h.reply(0, "waiting for the builder");
    expect(parent.view().status).toBe("running");
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: parentThread });
    h.end(1, "done", { durationMs: 1_500, costUsd: 0.0042 });
    const line = `thread ${kid.view().threadId!.slice(0, 8)} finished (completed, 1.5s, $0.0042): done`;
    await settle();
    // The parent's turn has replied, so it takes no steer and is not queued behind; the line waits for its exit.
    expect(h.steered).toEqual([]);
    expect(h.starts).toHaveLength(2);
    expect(events.filter(e => e.type === "session.queued")).toEqual([]);
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const turn = await rt.sessions.start(ws.id, { prompt: "orchestrate", notify: "me" });
    h.reply(0, "the reply", { durationMs: 1_500, costUsd: 0.0042 });
    const line = `thread ${turn.view().threadId!.slice(0, 8)} finished (completed, 1.5s, $0.0042): the reply`;
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
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    const turn = await rt1.sessions.start(ws.id, { prompt: "orchestrate", notify: "me" });
    h1.reply(0, "the reply", { durationMs: 1_500, costUsd: 0.0042 });
    const line = `thread ${turn.view().threadId!.slice(0, 8)} finished (completed, 1.5s, $0.0042): the reply`;
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    const parentThread = parent.view().threadId!;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: parentThread });
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const failing = await rt.sessions.start(ws.id, { prompt: "die", notify: "me" });
    h.end(0, "", { status: "failed", error: "the harness died", durationMs: 3_000 });
    const stopped = await rt.sessions.start(ws.id, { prompt: "run", notify: "me" });
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await expect(rt.sessions.start(ws.id, { prompt: "build it", notify: "thread_nobody" })).rejects.toThrow("no thread thread_nobody to notify");
    expect(h.starts).toEqual([]);
    expect(await rt.sessions.list(ws.id)).toEqual([]);
    await rt.close();
  });

  it("the thread keeps who to tell: a later send into it, and a turn after the host restarted, both tell the parent", async () => {
    const h = held(true);
    const store = memoryStore();
    const backend = stubBackend();
    const rt = createRuntime({ backend, store, adapters: { claude: h.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    const parentThread = parent.view().threadId!;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: parentThread });
    const kidSid = kid.view().claudeSessionId!;
    h.end(1, "first");
    await vi.waitFor(() => expect(h.steered).toHaveLength(1));
    const again = await rt.sessions.start(ws.id, { prompt: "and the docs", resume: kidSid });
    expect(again.view().threadId).toBe(kid.view().threadId);
    h.end(2, "second");
    await vi.waitFor(() => expect(h.steered).toHaveLength(2));
    expect(h.steered[1]).toBe(`thread ${kid.view().threadId!.slice(0, 8)} finished (completed): second`);
    h.end(0, "parent done");
    await rt.close();

    const h2 = held(true);
    const rt2 = createRuntime({ backend, store, adapters: { claude: h2.adapter } });
    const parentAgain = await rt2.sessions.start(ws.id, { prompt: "still here", resume: parent.view().claudeSessionId! });
    expect(parentAgain.view().threadId).toBe(parentThread);
    const third = await rt2.sessions.start(ws.id, { prompt: "and the tests", resume: kidSid });
    expect(third.view().threadId).toBe(kid.view().threadId);
    h2.end(1, "third");
    await vi.waitFor(() => expect(h2.steered).toEqual([`thread ${kid.view().threadId!.slice(0, 8)} finished (completed): third`]));
    h2.end(0, "ok");
    await rt2.close();
  });

  it("a thread cannot notify itself: a resumed start that names its own thread is refused, and nothing starts", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const own = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    const sid = own.view().claudeSessionId!;
    h.end(0, "ready");
    await own.finished;
    await expect(rt.sessions.start(ws.id, { prompt: "again", resume: sid, notify: own.view().threadId! })).rejects.toThrow("a thread cannot notify itself");
    expect(h.starts).toHaveLength(1);
    expect((await rt.sessions.history(ws.id)).map(e => e.type)).toEqual(["session.start", "session.done", "session.end"]);
    await rt.close();
  });

  it("a cycle is refused: a start whose notify already leads back to this thread, at any length of the chain", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const a = await rt.sessions.start(ws.id, { prompt: "a" });
    const b = await rt.sessions.start(ws.id, { prompt: "b", notify: a.view().threadId! });
    const c = await rt.sessions.start(ws.id, { prompt: "c", notify: b.view().threadId! });
    // Ended child first, so each end steers its line into a parent still running instead of opening a turn on it.
    h.end(2, "idle");
    await vi.waitFor(() => expect(h.steered).toHaveLength(1));
    h.end(1, "idle");
    await vi.waitFor(() => expect(h.steered).toHaveLength(2));
    h.end(0, "idle");
    await a.finished;
    await expect(rt.sessions.start(ws.id, { prompt: "a again", resume: a.view().claudeSessionId!, notify: b.view().threadId! })).rejects.toThrow(`thread ${b.view().threadId!.slice(0, 8)} already notifies this thread; a cycle would run forever`);
    await expect(rt.sessions.start(ws.id, { prompt: "a again", resume: a.view().claudeSessionId!, notify: c.view().threadId! })).rejects.toThrow(`thread ${c.view().threadId!.slice(0, 8)} already notifies this thread; a cycle would run forever`);
    expect(h.starts).toHaveLength(3);
    // A chain that does not come back is fine: a fresh thread may name c, and c's own chain ends at a.
    const d = await rt.sessions.start(ws.id, { prompt: "d", notify: c.view().threadId! });
    expect(d.outcome).toBe("started");
    await rt.close();
  });

  it("a parent whose workspace naps while the child ends gets the line when the workspace wakes, as the first turn of its own", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const parent = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    h.end(0, "waiting");
    await parent.finished;
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: parent.view().threadId! });
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
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const kid = await rt.sessions.start(ws.id, { prompt: "build it", notify: "me" });
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
    const kidWs = await rt1.workspaces.create({ golden: "snap_g", name: "builder" });
    const warmup = await rt1.sessions.start(kidWs.id, { prompt: "warm up" });
    h1.end(0, "ready");
    await warmup.finished;
    const parentWs = await rt1.workspaces.create({ golden: "snap_g", name: "lead" });
    const parent = await rt1.sessions.start(parentWs.id, { prompt: "orchestrate" });
    const parentThread = parent.view().threadId!;
    const kid = await rt1.sessions.start(kidWs.id, { prompt: "build it", notify: parentThread, startedBy: "agent" });
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
    const ws = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    const kid = await rt1.sessions.start(ws.id, { prompt: "build it", notify: "me" });
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
});

describe("gone machines", () => {
  /** A port nothing listens on: a reach probe against it fails at once, the way a dead edge route does. */
  const closedPort = async (): Promise<number> => {
    const probe = createServer();
    await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(r => probe.close(() => r()));
    return port;
  };
  /** A turn that announces itself and never settles on its own: only the runtime ending it ends it. */
  const held: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      const sessionId = randomUUID();
      o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", cwd: "/root/work" });
      return { localId: sessionId, finished: new Promise<TurnResult>(() => {}), interrupt: async () => {} };
    },
  });
  /** Two workspaces, one napping, both machines deleted at the provider while no host ran; the same store hydrated again. */
  const hydratedGone = async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const a = await rt1.workspaces.create({ golden: "snap_g", name: "a" });
    const b = await rt1.workspaces.create({ golden: "snap_g", name: "b" });
    await rt1.workspaces.nap(b.id);
    await rt1.close();
    for (const m of backend.machines) m.killed = true;
    const rt = createRuntime({ backend, store, adapters: {} });
    return { backend, store, rt, a, b };
  };

  it("a stored workspace whose machine the provider no longer knows hydrates as gone with the provider's words, whatever phase it was left at", async () => {
    const { store, rt, a, b } = await hydratedGone();
    const listed = await rt.workspaces.list();
    // The words name the load that met the 404 and quote the provider's answer to it.
    const loadSaw = (id: string) => new RegExp(`^machine ${id} is gone at the provider: the record load found it gone at \\S+Z \\(404 gone\\)$`);
    expect(listed.map(w => [w.name, w.phase, w.gone])).toEqual([
      ["a", "gone", expect.stringMatching(loadSaw("m1"))],
      ["b", "gone", expect.stringMatching(loadSaw("m2"))],
    ]);
    // Written back before anything lists it: a second host over the store reads gone without asking the provider.
    expect(await store.get("workspaces", a.id)).toMatchObject({ phase: "gone", gone: expect.stringMatching(loadSaw("m1")) });
    expect(await store.get("workspaces", b.id)).toMatchObject({ phase: "gone" });
    const statuses = await rt.status.list();
    const sa = statuses.find(s => s.id === a.id)!;
    expect(sa).toMatchObject({ phase: "gone", machineState: "gone", reach: { state: "gone" }, reason: expect.stringMatching(loadSaw("m1")) });
    expect(sa.idleAt).toBeUndefined();
    await rt.close();
  });

  it("a gone workspace refuses wake and sends with the provider's words; nap is a no-op; rebuild is the road out", async () => {
    const { backend, store, rt, a } = await hydratedGone();
    const words = (await rt.workspaces.get(a.id)).gone!;
    expect(words).toMatch(/^machine m1 is gone at the provider: the record load found it gone at /);
    await expect(rt.workspaces.wake(a.id)).rejects.toThrow(`Workspace machine is gone; rebuild it to wake (${words})`);
    await expect(rt.sessions.start(a.id, { prompt: "hi" })).rejects.toThrow(`Workspace machine is gone; rebuild it to send (${words})`);
    expect(await rt.workspaces.nap(a.id)).toMatchObject({ phase: "gone" });
    expect(backend.machines).toHaveLength(2);

    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const rebuilt = await rt.workspaces.rebuild(a.id);
    expect(rebuilt).toMatchObject({ phase: "running", machineId: "m3" });
    expect(rebuilt.gone).toBeUndefined();
    expect(backend.machines[2]!.spec.fromSnapshot).toBe("snap_g");
    expect(events.find(e => e.type === "workspace.upgraded")).toMatchObject({ workspaceId: a.id, machineId: "m3" });
    expect((await rt.status.list()).find(s => s.id === a.id)).toMatchObject({ phase: "running", machineState: "running", machineId: "m3" });
    expect(await store.get("workspaces", a.id)).toMatchObject({ phase: "running", machineId: "m3" });
    expect((await store.get("workspaces", a.id) as { gone?: string }).gone).toBeUndefined();
    expect(await rt.workspaces.wake(a.id)).toMatchObject({ phase: "running" });
    await rt.close();
  });

  it("the reach poll finds a running machine gone: the workspace moves to gone, its turn ends, the idle window drops and the bill stops", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: held }, status: { pollIntervalMs: 5, costIntervalMs: 5, reconcileMinMs: 0 }, goneConfirmMs: 5 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const port = await closedPort();
    backend.machines[0]!.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    await rt.sessions.start(ws.id, { prompt: "work" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const stop = rt.status.watch();
    try {
      // Unreachable alone is weather: the provider still says running, so the workspace does.
      await until(() => events.some(e => e.type === "workspace.status" && e.status.reach.state === "unreachable"));
      expect(await rt.workspaces.get(ws.id)).toMatchObject({ phase: "running" });
      expect(events.some(e => e.type === "workspace.gone")).toBe(false);

      backend.machines[0]!.killed = true; // deleted through the provider's API under a running host
      await until(() => events.some(e => e.type === "workspace.gone"));
      const pollSaw = /^machine m1 is gone at the provider: the status poll found it gone at \S+Z$/;
      expect(events.find(e => e.type === "workspace.gone")).toMatchObject({ workspaceId: ws.id, machineId: "m1", reason: expect.stringMatching(pollSaw) });
      expect(await rt.workspaces.get(ws.id)).toMatchObject({ phase: "gone", gone: expect.stringMatching(pollSaw) });
      expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "gone", gone: expect.stringMatching(pollSaw) });
      expect(events.find(e => e.type === "session.end")).toMatchObject({ workspaceId: ws.id, reason: "machine gone at the provider while the agent was working" });
      expect((await rt.sessions.list(ws.id)).map(s => s.status)).toEqual(["failed"]);

      // The bill stops where the machine did: rate 0 and the awake time frozen from one tick to the next.
      await until(() => events.filter(e => e.type === "workspace.cost" && e.phase === "gone").length >= 2);
      const ticks = events.filter((e): e is EventUnion & { type: "workspace.cost" } => e.type === "workspace.cost" && e.phase === "gone");
      expect(ticks[0]).toMatchObject({ rateUsdPerHour: 0 });
      expect(ticks[1]!.awakeMs).toBe(ticks[0]!.awakeMs);
      const last = events.filter((e): e is EventUnion & { type: "workspace.status" } => e.type === "workspace.status").at(-1)!;
      expect(last.status).toMatchObject({ phase: "gone", machineState: "gone", reach: { state: "gone" }, reason: expect.stringMatching(pollSaw) });
      expect(last.status.idleAt).toBeUndefined();
    } finally {
      stop();
      await rt.close();
    }
  });

  it("the host's metrics answer 404 while the state read says running: the workspace stays running and its turn works on", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: held }, status: { pollIntervalMs: 5, costIntervalMs: 5, reconcileMinMs: 0 }, goneConfirmMs: 5 });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const m = backend.machines[0]!;
    const port = await closedPort();
    m.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    await rt.sessions.start(ws.id, { prompt: "work" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asks = { metrics: 0 };
    const metrics = m.metrics.bind(m);
    m.metrics = async () => {
      asks.metrics++;
      return metrics();
    };
    const stop = rt.status.watch();
    try {
      // The guest misses the probe and the host has lost the VM; the state read by id is the only word on gone.
      m.hostLost = true;
      // Several passes read the metrics 404 with the guest still missing; none of them is a verdict.
      await until(() => asks.metrics >= 3);

      expect(m.killed).toBe(false);
      expect(await rt.workspaces.get(ws.id)).toMatchObject({ phase: "running" });
      expect(events.some(e => e.type === "workspace.gone")).toBe(false);
      expect(events.some(e => e.type === "session.end")).toBe(false);
      expect((await rt.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
      const rows = events.filter((e): e is EventUnion & { type: "workspace.status" } => e.type === "workspace.status");
      expect(rows.filter(r => r.status.machineState === "gone")).toEqual([]);
      expect(rows.at(-1)!.status).toMatchObject({ phase: "running", machineState: "running", reach: { state: "unreachable" } });
      // The gap is one line per spell, however many passes read it.
      expect(warn.mock.calls.map(c => String(c[0])).filter(l => /^host metrics for/.test(l))).toHaveLength(1);
    } finally {
      stop();
      warn.mockRestore();
      await rt.close();
    }
  });
});

describe("a workspace behind the golden's head", () => {
  const version = (n: number) => ({ version: n, snapshotId: `snap_golden-v${n}`, baseTemplate: "base", setupSha: `s${n}`, createdAt: `2026-09-0${n}T00:00:00.000Z`, smoke: { cmd: "true", exitCode: 0 } });
  const seeded = async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", "default", { head: 2, versions: [version(1), version(2)] });
    return { backend, store, rt: createRuntime({ backend, store, adapters: {} }) };
  };

  it("moves onto the head: a fork of the newer image replaces the machine, the record names it, and the status says which version it came from", async () => {
    const { backend, store, rt } = await seeded();
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_golden-v1", name: "api" });
    const moved = await rt.workspaces.updateImage(ws.id);
    expect(moved.golden).toBe("snap_golden-v2");
    expect(moved.machineId).toBe("m2");
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([["snap_golden-v1", true], ["snap_golden-v2", false]]);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ golden: "snap_golden-v2", machineId: "m2" });
    expect(events.filter(e => e.type === "workspace.upgraded")).toMatchObject([{ workspaceId: ws.id, machineId: "m2" }]);
    const last = events.filter((e): e is EventUnion & { type: "workspace.status" } => e.type === "workspace.status").at(-1)!;
    expect(last.status.reason).toBe("moved from image v1 to v2");
  });

  it("one already on the head is handed back untouched: no machine is replaced", async () => {
    const { backend, rt } = await seeded();
    const ws = await rt.workspaces.create({ golden: "snap_golden-v2", name: "api" });
    expect(await rt.workspaces.updateImage(ws.id)).toMatchObject({ golden: "snap_golden-v2", machineId: "m1" });
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]!.killed).toBe(false);
  });

  it.each([
    ["napping" as const, "api is paused; wake it to move it to a newer image"],
    ["gone" as const, "api's machine is gone; rebuild it to move it to a newer image"],
  ])("a %s workspace is refused with the sentence the app shows: the move replaces the machine, so only a running one takes it", async (phase, why) => {
    const { backend, store, rt } = await seeded();
    const ws = await rt.workspaces.create({ golden: "snap_golden-v1", name: "api" });
    const record = (await store.get("workspaces", ws.id)) as { phase: string };
    await store.put("workspaces", ws.id, { ...record, phase });
    // The store's word has to be the provider's too: a record over a machine that runs hydrates running, whichever
    // phase it was left at.
    if (phase === "napping") backend.machines[0]!.paused = true;
    else backend.machines[0]!.killed = true;
    await rt.close();
    const later = createRuntime({ backend, store, adapters: {} });
    try {
      await expect(later.workspaces.updateImage(ws.id)).rejects.toMatchObject({ kind: "conflict", message: why });
      // Nothing was replaced: the refusal lands before any fork.
      expect(backend.machines).toHaveLength(1);
      expect((await later.workspaces.get(ws.id)).machineId).toBe("m1");
    } finally {
      await later.close();
    }
  });

  it("one forked from a project image is refused, since the move would throw its project disk away", async () => {
    const { backend, store, rt } = await seeded();
    await store.put("project-goldens", "snap_project", {
      snapshotId: "snap_project",
      project: { name: "spoo", path: "/root/spoo", importedAt: "2026-09-02T00:00:00.000Z" },
      golden: "snap_golden-v1",
      workspaceId: "ws_old",
      workspaceName: "old",
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    const ws = await rt.workspaces.create({ golden: "snap_project", name: "api" });
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toMatchObject({ kind: "conflict" });
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]!.killed).toBe(false);
  });

  // The move replaces the machine the way a resize does, and that kills before it forks: a create the provider
  // refuses leaves the workspace machineless whichever of the two asked for it. What the move owes is the record:
  // the image it names must be the one the workspace is on, so the rebuild that follows restores that version.
  it("a move that fails leaves the record on the image the workspace came from, so the rebuild after it forks that one", async () => {
    const { backend, store, rt } = await seeded();
    const ws = await rt.workspaces.create({ golden: "snap_golden-v1", name: "api" });
    const create = backend.create.bind(backend);
    let refused = true;
    backend.create = async spec => {
      if (refused && spec.fromSnapshot === "snap_golden-v2") {
        refused = false;
        throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency" });
      }
      return create(spec);
    };
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toThrow("Too many concurrent sessions");
    expect((await rt.workspaces.get(ws.id)).golden).toBe("snap_golden-v1");
    expect(await store.get("workspaces", ws.id)).toMatchObject({ golden: "snap_golden-v1" });
    await rt.workspaces.rebuild(ws.id);
    expect(backend.machines.map(m => m.spec.fromSnapshot)).toEqual(["snap_golden-v1", "snap_golden-v1"]);
  });

  it("one forked from a snapshot no golden of this host knows is refused by name", async () => {
    const { rt } = await seeded();
    const ws = await rt.workspaces.create({ golden: "snap_elsewhere", name: "api" });
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toThrow("api's image is not a version of any golden this host knows");
  });
});
