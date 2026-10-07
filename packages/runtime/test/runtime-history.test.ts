// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildEnv, catalogProbeCommand, parseCatalogProbe } from "@wsp/adapter-claude";
import { diskFullLine } from "@wsp/protocol";
import { foldThreads, type AdapterEvent, type EventUnion, type SessionEvent, type TurnResult, type WorkspaceStatus } from "@wsp/protocol";
import { DISK_USE_CMD } from "@wsp/engine";
import { harnessCatalog } from "../src/harness-catalog.js";
import { CATALOG_TTL_MS, TOOL_RESULT_KEPT, TRANSCRIPT_BYTES, TRANSCRIPT_FLUSH_MS, createRuntime, type HarnessAdapterFactory, type HarnessStartOptions } from "../src/runtime.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { wsRequest } from "./ws-client.js";
import { stubBackend, type StubBackend, createOn } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { CLAUDE_PIN, settle } from "./runtime-fixture.js";

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
    const a = await createOn(rt, { golden: "snap_g", name: "a" });
    const b = await createOn(rt, { golden: "snap_g", name: "b" });
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
    expect(await store.getBlob("transcripts", a.id)).toBeUndefined();
  });

  /** An adapter the test drives by hand, so turn boundaries can arrive without a session.end behind them. */
  const manual = () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    let onEvent: ((e: AdapterEvent) => void) | undefined;
    let lastStart: HarnessStartOptions | undefined;
    const starts: string[] = [];
    let finish!: (r: TurnResult) => void;
    const finished = new Promise<TurnResult>(r => (finish = r));
    const adapter: HarnessAdapterFactory = ctx => ({
      steers: false,
      probeCatalog: exec => exec(catalogProbeCommand(), buildEnv({ base: ctx.env })).then(parseCatalogProbe),
      start: o => {
        onEvent = o.onEvent;
        lastStart = o;
        starts.push(o.prompt);
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    return {
      adapter,
      starts,
      lastStart: () => lastStart,
      start: (cwd?: string) => onEvent!({ type: "session.start", sessionId, model: "claude-sonnet-4-5", ...(cwd !== undefined ? { cwd } : {}) }),
      tool: (command: string, cwd?: string) =>
        onEvent!({ type: "turn.delta", sessionId, kind: "tool_use", text: JSON.stringify({ command }), toolName: "Bash", toolUseId: "t1", ...(cwd !== undefined ? { cwd } : {}) }),
      say: (text: string, messageId?: string) => onEvent!({ type: "turn.delta", sessionId, kind: "text", text, ...(messageId !== undefined ? { messageId } : {}) }),
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const before = Date.now();
    const first = await rt.sessions.start(ws.id, { prompt: "first" });
    await first.finished;
    await (await rt.sessions.start(ws.id, { prompt: "second", thread: first.view().threadId! })).finished;
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "first" })).finished;

    const history = await rt.sessions.history(ws.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end"]);
    expect(history[0]).toMatchObject({ type: "session.start", sessionId, prompt: "first", cwd: "/root/work" });
    expect((await rt.sessions.list(ws.id))[0]).toMatchObject({ claudeSessionId: sessionId, cwd: "/root/work", status: "completed" });
    await rt.close();
  });

  /** Emits one full turn per start, under the resume id when given, else a fresh id. */
  const threaded = (): HarnessAdapterFactory => () => ({
    steers: false,
    start: o => {
      const sessionId = o.resume ?? randomUUID();
      const result: TurnResult = { status: "completed", text: o.prompt };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: o.prompt });
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  /** Counts runs of one threadId in wire order. Enough here, where turns never overlap; a consumer folding a
   * transcript keeps the events whose threadId equals the last event's, which also holds when turns interleave. */
  const threads = (events: ReadonlyArray<{ threadId?: string }>): number =>
    events.reduce((n, e, i) => (i === 0 || e.threadId !== events[i - 1]!.threadId ? n + 1 : n), 0);
  const UUID = /^[0-9a-f-]{36}$/;

  it("stamps a threadId that a send into the thread keeps and a start without a thread replaces, so two threads replay as two", async () => {
    const live: EventUnion[] = [];
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: threaded() } });
    rt.events.on("*", e => live.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "first" });
    await first.finished;
    await (await rt.sessions.start(ws.id, { prompt: "second", thread: first.view().threadId! })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "third" })).finished;

    const history = await rt.sessions.history(ws.id);
    expect(history).toHaveLength(12);
    for (const e of history) expect(e.threadId).toMatch(UUID);
    expect(new Set(history.slice(0, 8).map(e => e.threadId)).size).toBe(1);
    expect(new Set(history.slice(8).map(e => e.threadId)).size).toBe(1);
    expect(history[8]!.threadId).not.toBe(history[0]!.threadId);
    expect(threads(history)).toBe(2);
    expect(live.flatMap(e => ("threadId" in e && e.type !== "session.held" && e.type !== "thread.head" ? [e.threadId] : []))).toEqual(history.map(e => e.threadId));
    // The session rows carry the same ids, so a sidebar can fold rows into the threads the transcript folds into;
    // the resumed turn shares the first one's local id and so its row.
    expect((await rt.sessions.list(ws.id)).map(s => s.threadId)).toEqual([history[0]!.threadId, history[8]!.threadId]);
    await rt.close();
  });

  it("hands a resume the thread so far for a new session to open with, the turn being sent left out, and a fresh start nothing", async () => {
    const seeds: HarnessStartOptions["seed"][] = [];
    const inner = threaded();
    const claude: HarnessAdapterFactory = ctx => {
      const a = inner(ctx);
      return { ...a, start: o => (seeds.push(o.seed), a.start(o)) };
    };
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "fix the login page" });
    await first.finished;
    await (await rt.sessions.start(ws.id, { prompt: "now add a test", thread: first.view().threadId! })).finished;
    expect(seeds.map(seed => seed !== undefined)).toEqual([false, true]);
    const text = await seeds[1]!();
    expect(text).toContain("fix the login page");
    expect(text).not.toContain("now add a test");
    await rt.close();
  });

  it("reads the disk at a turn's end where a stop snapshots it, and a row says so only once use passes 90%", async () => {
    const backend = stubBackend();
    backend.capabilities.pauseMode = "disk";
    // Used and free in kB, as df prints them: 89.6%, 90.0% and 90.1% used.
    const readings = ["896000 104000", "900000 100000", "901000 99000"];
    const answer = backend.execImpl;
    let reads = 0;
    backend.execImpl = (m, cmd) => (cmd === DISK_USE_CMD ? { exitCode: 0, stdout: `${readings[reads++]}\n`, stderr: "" } : answer(m, cmd));
    const statuses: WorkspaceStatus[] = [];
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: threaded() } });
    rt.events.on("workspace.status", e => void (e.type === "workspace.status" && statuses.push(e.status)));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    for (const n of [1, 2]) {
      await (await rt.sessions.start(ws.id, { prompt: `build ${n}` })).finished;
      await until(async () => reads === n, 2_000);
      await new Promise(r => setTimeout(r, 20));
      // Neither just under the line nor on it says anything.
      expect((await rt.status.list())[0]!.reason).toBeUndefined();
    }
    await (await rt.sessions.start(ws.id, { prompt: "build 3" })).finished;
    await until(async () => statuses.some(s => s.reason === diskFullLine(90.1)), 2_000);
    expect((await rt.status.list())[0]!.reason).toMatch(/^its disk is 90\.1% full: /);
    await rt.close();
  });

  it("a row says who opened its thread: a resumed turn keeps the answer of the turn it resumes, a fresh start gives its own", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: threaded() } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "first", startedBy: "cli" });
    await first.finished;
    await (await rt.sessions.start(ws.id, { prompt: "second", thread: first.view().threadId! })).finished;
    await (await rt.sessions.start(ws.id, { prompt: "third" })).finished;
    expect((await rt.sessions.list(ws.id)).map(s => [s.prompt, s.startedBy])).toEqual([["first", "cli"], ["third", "person"]]);
    await rt.close();
  });

  it("a thread is titled by its first prompt: a second send leaves the row's prompt, and so the folded title, unchanged, also across a restart", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: threaded() } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const titles = async (r: typeof rt) => foldThreads(await r.sessions.list(ws.id)).map(t => [t.title, t.status]);
    const first = await rt.sessions.start(ws.id, { prompt: "You are a builder for the wsp repo", startedBy: "cli" });
    await first.finished;
    const thread = first.view().threadId!;
    expect(await titles(rt)).toEqual([["You are a builder for the wsp repo", "completed"]]);
    await (await rt.sessions.start(ws.id, { prompt: "GitHub is signed in on this machine now", thread })).finished;
    expect(await titles(rt)).toEqual([["You are a builder for the wsp repo", "completed"]]);
    const history = await rt.sessions.history(ws.id);
    expect(history.filter(e => e.type === "session.start").map(e => e.prompt)).toEqual(["You are a builder for the wsp repo", "GitHub is signed in on this machine now"]);
    await rt.close();

    const again = createRuntime({ backend, store, adapters: { claude: threaded() } });
    await (await again.sessions.start(ws.id, { prompt: "Push the branch", thread })).finished;
    expect(await titles(again)).toEqual([["You are a builder for the wsp repo", "completed"]]);
    await again.close();
  });

  it("sessions.history over the socket carries the threadId", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: threaded() } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    m.start();
    m.done("here is the reply");
    // The reply is recorded, but the process has not exited: the row is still running, not completed.
    expect(handle.view().status).toBe("running");
    expect((await rt.sessions.list(ws.id))[0]!.status).toBe("running");
    expect((await rt.sessions.history(ws.id)).map(e => e.type)).toEqual(["session.start", "session.done"]);
    // A send while the process lives is never refused and never a second agent in the same folder: it waits for
    // that process to exit and runs as the thread's next turn.
    const again = rt.sessions.start(ws.id, { prompt: "again", thread: handle.view().threadId! });
    await settle();
    expect(m.starts).toEqual(["go"]);

    m.end();
    const queued = await again;
    expect(queued.outcome).toBe("queued");
    expect(m.starts).toEqual(["go", "again"]);
    await handle.finished;
    await rt.close();
  });

  it("stamps the attempt a start names on the thread's row, keeps it through a restart, and folds it onto the thread", async () => {
    const m = manual();
    const store = memoryStore();
    const backend = stubBackend();
    const rt = createRuntime({ backend, store, adapters: { claude: m.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go", attempt: "att_1" });
    expect(handle.view()).toMatchObject({ attempt: "att_1" });
    m.start();
    m.done("done");
    m.end();
    await handle.finished;
    expect(foldThreads(await rt.sessions.list(ws.id))).toMatchObject([{ id: handle.view().threadId, attempt: "att_1" }]);
    expect(m.lastStart()).not.toHaveProperty("attempt");
    await rt.close();
    // The machine outlives the host, so the restarted host reads the same provider.
    const rt2 = createRuntime({ backend, store, adapters: { claude: m.adapter } });
    expect((await rt2.sessions.list(ws.id)).map(row => row.attempt)).toEqual(["att_1"]);
    const other = await rt2.sessions.start(ws.id, { prompt: "alone" });
    expect(other.view()).not.toHaveProperty("attempt");
    m.start();
    m.done("done");
    m.end();
    await other.finished;
    await rt2.close();
  });

  it("passes the picked model, effort and permission mode to the harness and records them on the SessionView", async () => {
    const m = manual();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: m.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go", model: "claude-opus-5-5", effort: "high", permissionMode: "acceptEdits" });
    expect(m.lastStart()).toMatchObject({ model: "claude-opus-5-5", effort: "high", permissionMode: "acceptEdits" });
    expect(handle.view()).toMatchObject({ model: "claude-opus-5-5", effort: "high", permissionMode: "acceptEdits" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    // cwd rides every start now: a workspace is one project's copy and the thread opens in that project's folder.
    expect(Object.keys(m.lastStart()!)).toEqual(["prompt", "cwd", "model", "effort", "permissionMode", "onEvent"]);
    const view = handle.view();
    expect(view.model).toBe("claude-opus-5-5");
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
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const catalogs = await rt.harnesses.list(ws.id);
      const claude = catalogs.find(c => c.harness === "claude")!;
      // The wire's isDefault is the harness an unnamed start runs, whichever source answered.
      expect(claude).toMatchObject({ source: "harness", version: "2.1.257", isDefault: true });
      expect(claude.models.map(m => m.value)).toEqual(["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
      // A binary that still offers Opus 5 keeps it among its current models, under the table's name for it.
      expect(claude.models[0]).toMatchObject({ label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] });
      expect(claude.legacyModels?.map(m => m.value)).not.toContain("claude-opus-5");
      expect(claude.permissionModes.map(o => o.value)).toEqual(["default", "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk"]);
      expect(probes(backend)).toHaveLength(1);
      // The probe is the adapter's line under the guest's login, so it runs under the guest's config dir, never HOME.
      // A provider's exec drops stdin, so on its single-login machine the login's variables are piped in from the text.
      expect(probes(backend)[0]).toContain("'CLAUDE_CONFIG_DIR=/root/.claude-cfg'");
      await rt.close();
    });

    it("a start before any list fills the cache, and the list still marks the default harness", async () => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude --help") ? { exitCode: 0, stdout: PROBE_OUTPUT, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: manual().adapter } });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const catalogs = await rt.harnesses.list(ws.id);
      expect(catalogs.find(c => c.harness === "claude")).toMatchObject({ source: "harness", version: "2.1.257" });
      const codex = catalogs.find(c => c.harness === "codex")!;
      expect(codex).toMatchObject({ source: "harness", version: "0.9.0", label: "Codex" });
      expect(codex.isDefault).toBeUndefined();
      expect(codex.models).toEqual([{ value: "gpt-5-codex", label: "Codex", isDefault: true, efforts: ["high"], contextWindows: [] }]);
      // The table lends the words for values the binary only names.
      expect(codex.permissionModes).toEqual([{ value: "read-only", label: "Read only", description: "Reads only; edits no files and runs no command that writes" }]);
      expect(probes(backend)).toHaveLength(1);
      expect(codexProbes(backend)).toHaveLength(1);
      await rt.close();

      const quiet = stubBackend();
      twoBinaries(quiet);
      const rt2 = createRuntime({ backend: quiet, store: memoryStore(), adapters: { claude: threaded(), codex: codexProbing } });
      const ws2 = await createOn(rt2, { golden: "snap_g", name: "b" });
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
      const refusing: HarnessAdapterFactory = ctx => ({ ...threaded()(ctx), probeCatalog: exec => exec("codex --describe").then(() => ({ refused: "Codex is not signed in where this workspace runs; run codex login there" })) });
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { codex: refusing } });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const codex = (await rt.harnesses.list(ws.id)).find(c => c.harness === "codex")!;
      expect(codex).toMatchObject({ source: "table", version: harnessCatalog("codex")!.version, refusal: "Codex is not signed in where this workspace runs; run codex login there" });
      expect(codex.models.map(m => m.value)).toEqual(harnessCatalog("codex")!.models.map(m => m.value));
      expect(codex.models.length).toBeGreaterThan(0);
      await rt.close();
    });

    it("a probe the machine refused is said once, and the table answers until the next probe", async () => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => {
        if (cmd.includes("claude --help")) throw new Error("timeoutMs must be at most 26000 for a dedicated sandbox");
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: manual().adapter } });
        const ws = await createOn(rt, { golden: "snap_g", name: "a" });
        const claude = (await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!;
        expect(claude).toMatchObject({ source: "table", version: CLAUDE_PIN });
        expect(claude.models.map(m => m.value)).toEqual(harnessCatalog("claude")!.models.map(m => m.value));
        const said = warn.mock.calls.map(c => String(c[0])).filter(line => line.includes("the probe of the agent failed"));
        expect(said).toHaveLength(1);
        expect(said[0]).toContain(backend.machines[0]!.id);
        expect(said[0]).toContain("claude");
        expect(said[0]).toContain("timeoutMs must be at most 26000 for a dedicated sandbox");
        // The cache holds the failure too, so a person opening the composer twice reads one line and costs one exec.
        await rt.harnesses.list(ws.id);
        expect(warn.mock.calls.map(c => String(c[0])).filter(line => line.includes("the probe of the agent failed"))).toHaveLength(1);
        expect(probes(backend)).toHaveLength(1);
        await rt.close();
      } finally {
        warn.mockRestore();
      }
    });

    it("a session start asks the binary of the harness that starts, when its adapter probes, and no other", async () => {
      const backend = stubBackend();
      twoBinaries(backend);
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: threaded(), codex: codexProbing } });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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

    it("past the TTL a session start answers off the lists it holds while the binary is asked again, and the next start reads the new answer", async () => {
      const backend = stubBackend();
      let asked: ((r: { exitCode: number; stdout: string; stderr: string }) => void) | undefined;
      backend.execImpl = (_m, cmd) => {
        if (!cmd.includes("claude --help")) return { exitCode: 0, stdout: "", stderr: "" };
        if (probes(backend).length === 1) return { exitCode: 0, stdout: PROBE_OUTPUT, stderr: "" };
        return new Promise(resolve => (asked = resolve));
      };
      const fc = fakeClock();
      const m = manual();
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: m.adapter }, clock: fc.clock });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      expect((await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")).toMatchObject({ source: "harness" });
      fc.advance(CATALOG_TTL_MS);
      const handle = await rt.sessions.start(ws.id, { prompt: "go", model: "claude-opus-5" });
      expect(probes(backend)).toHaveLength(2);
      expect(m.lastStart()).toMatchObject({ model: "claude-opus-5" });
      m.done("ok");
      m.end();
      await handle.finished;
      asked!({ exitCode: 0, stdout: "garbage\n", stderr: "" });
      await new Promise(r => setImmediate(r));
      expect((await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")).toMatchObject({ source: "table" });
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
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const first = (await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!;
      expect(first).toMatchObject({ source: "table", version: CLAUDE_PIN });
      expect(first.models.map(m => m.value)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
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
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      await expect(rt.sessions.start(ws.id, { prompt: "go", model: "claude-opus-4-1" })).rejects.toThrow(
        'model "claude-opus-4-1" is not one claude takes; one of: Opus 5 (claude-opus-5), Fable 5.1 (claude-fable-5-1), Sonnet 5 (claude-sonnet-5), Haiku 4.5 (claude-haiku-4-5-20251001); legacy: Opus 4.8 (claude-opus-4-8)',
      );
      await expect(rt.sessions.start(ws.id, { prompt: "go", permissionMode: "yolo" })).rejects.toThrow(/^access mode "yolo" is not one claude takes; one of: Default \(default\), /);
      expect(m.lastStart()).toBeUndefined();
      expect(await rt.sessions.list(ws.id)).toEqual([]);
      const handle = await rt.sessions.start(ws.id, { prompt: "go", effort: "high", permissionMode: "acceptEdits" });
      expect(m.lastStart()).toMatchObject({ model: "claude-opus-5", effort: "high", permissionMode: "acceptEdits" });
      m.start();
      m.done("ok");
      m.end();
      await handle.finished;
      const resumed = await rt.sessions.start(ws.id, { prompt: "more", thread: handle.view().threadId! });
      // A send that names no model runs on the one the thread ran on, as its agent announced it.
      expect(m.lastStart()!.model).toBe("claude-sonnet-4-5");
      m.done("ok");
      m.end();
      await resumed.finished;
      // The binary's handshake lists no older model, and the table's legacy ones still start as named.
      const heard = (await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!;
      expect(heard.source).toBe("harness");
      expect(heard.legacyModels?.map(o => o.value)).toContain("claude-opus-4-8");
      const legacy = await rt.sessions.start(ws.id, { prompt: "old", model: "claude-opus-4-8", effort: "xhigh" });
      expect(m.lastStart()).toMatchObject({ model: "claude-opus-4-8", effort: "xhigh" });
      m.done("ok");
      m.end();
      await legacy.finished;
      expect(probes(backend)).toHaveLength(1);
      await rt.close();
    });

    it("keeps one answer per machine and leaves a napping workspace's binary alone", async () => {
      const backend = stubBackend();
      backend.execImpl = (_m, cmd) => (cmd.includes("claude --help") ? { exitCode: 0, stdout: PROBE_OUTPUT, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
      const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: manual().adapter } });
      const a = await createOn(rt, { golden: "snap_g", name: "a" });
      const b = await createOn(rt, { golden: "snap_g", name: "b" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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

  it("the transcript keeps the harness's message id on each piece of text, so a reader folds the turn's replies apart", async () => {
    const m = manual();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: m.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "hold for 90 seconds" });
    m.start();
    m.say("Waiting for the hold to complete.", "msg_a");
    m.say("Done.", "msg_b");
    m.tool("ls");
    m.done("Done.");
    m.end();
    await handle.finished;
    const history = await rt.sessions.history(ws.id);
    expect(history.filter(e => e.type === "session.delta").map(e => (e.type === "session.delta" ? e.messageId : null))).toEqual(["msg_a", "msg_b", undefined]);
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
      putBlob: async (collection: string, id: string, bytes: Buffer) => {
        if (collection === "transcripts" && puts++ === 0 && holdFirst) await gate;
        await inner.putBlob(collection, id, bytes);
      },
    };
    const stored = async (id: string): Promise<{ type: string; prompt?: string }[]> => {
      const bytes = await inner.getBlob("transcripts", id);
      return bytes === undefined ? [] : (JSON.parse(bytes.toString("utf8")) as { events: { type: string; prompt?: string }[] }).events;
    };
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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

  /** A turn that calls one tool with `input` and gets `output` back, the way a harness reports a file written and read. */
  const tooled = (input: string, output: string): HarnessAdapterFactory => () => ({
    steers: false,
    start: ({ onEvent }) => {
      const sessionId = "44444444-4444-4444-8444-444444444444";
      const result: TurnResult = { status: "completed", text: "done" };
      const finished = (async () => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId },
          { type: "turn.delta", sessionId, kind: "tool_use", text: input, toolName: "Write", toolUseId: "tu_1" },
          { type: "turn.delta", sessionId, kind: "tool_result", text: output, toolUseId: "tu_1" },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) onEvent(e);
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  const jsonBytes = (events: readonly unknown[]): number => events.reduce<number>((n, e) => n + JSON.stringify(e).length, 0);

  it("caps a transcript in bytes as well as in events, so one workspace's tool calls cannot fill the host's memory", async () => {
    const { store, stored } = countingStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: tooled("w".repeat(256 * 1024), "ok") } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    for (let i = 0; i < 40; i++) await (await rt.sessions.start(ws.id, { prompt: `t${i}` })).finished;
    const history = await rt.sessions.history(ws.id);
    expect(jsonBytes(history)).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
    expect(history.some(e => e.type === "session.start" && e.prompt === "t39")).toBe(true);
    expect(history.some(e => e.type === "session.start" && e.prompt === "t0")).toBe(false);
    await rt.close();
    const persisted = await stored(ws.id);
    expect(jsonBytes(persisted)).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
    // A runtime reading the file back holds the same events, not more.
    const again = createRuntime({ backend: stubBackend(), store, adapters: {} });
    expect(await again.sessions.history(ws.id)).toHaveLength(history.length);
    await again.close();
  });

  it("one thread's traffic never trims another thread's history off the workspace they share", async () => {
    const { store } = countingStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: tooled("w".repeat(256 * 1024), "ok") } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    // Every thread of a project's folder is one workspace: a quiet thread, then busy ones beside it.
    const quiet = await rt.sessions.start(ws.id, { prompt: "the quiet one" });
    await quiet.finished;
    // Three busy threads, each past the byte cap on its own.
    const busy: string[] = [];
    for (let b = 0; b < 3; b++) {
      const first = await rt.sessions.start(ws.id, { prompt: `busy ${b}.0` });
      await first.finished;
      busy.push(first.view().threadId!);
      for (let i = 1; i < 20; i++) await (await rt.sessions.start(ws.id, { thread: first.view().threadId!, prompt: `busy ${b}.${i}` })).finished;
    }
    const history = await rt.sessions.history(ws.id);
    const ofQuiet = history.filter(e => e.threadId === quiet.view().threadId);
    expect(ofQuiet.some(e => e.type === "session.start" && e.prompt === "the quiet one")).toBe(true);
    expect(ofQuiet.at(-1)).toMatchObject({ type: "session.end" });
    // Every busy thread keeps its newest turn whole, and the workspace stays inside the one cap.
    for (const [b, threadId] of busy.entries()) expect(history.some(e => e.threadId === threadId && e.type === "session.start" && e.prompt === `busy ${b}.19`)).toBe(true);
    expect(jsonBytes(history)).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
    await rt.close();
  });

  /** A harness whose turns each say what the agent held after two calls, a subagent's between them, then compact,
   * and whose result names a figure only where `named` says. A turn with `hang` never ends. */
  const holding = (o: { named: boolean[]; hang?: boolean }): HarnessAdapterFactory => {
    let turns = 0;
    return () => ({
      steers: false,
      start: ({ onEvent }) => {
        const sessionId = "44444444-4444-4444-8444-444444444444";
        const named = o.named[turns++] === true;
        const result: TurnResult = { status: "completed", text: "", ...(named ? { tokens: { input: 1, output: 1, context: 3_100, window: 200_000 } } : {}) };
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId },
          { type: "turn.delta", sessionId, kind: "text", text: "before" },
          { type: "turn.usage", sessionId, tokens: 26_000, context: 26_000, window: 200_000 },
          { type: "turn.usage", sessionId, tokens: 900 },
          { type: "turn.usage", sessionId, tokens: 27_500, context: 27_500, window: 200_000 },
          { type: "turn.compacted", sessionId, before: 27_500, after: 3_100 },
        ];
        const finished = (async () => {
          for (const e of feed) onEvent(e);
          if (o.hang === true) return new Promise<TurnResult>(() => {});
          onEvent({ type: "turn.done", sessionId, result });
          onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return result;
        })();
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
  };
  const heldRows = (events: readonly SessionEvent[]) => events.flatMap(e => (e.type === "session.context" ? [[e.turnId, e.context, e.window]] : e.type === "session.compacted" ? [["compacted", e.line, e.before, e.after]] : []));

  it("passes what the agent held after each of its own calls by on the bus, and writes it only for a turn whose result names none", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: holding({ named: [false, true] }) } });
    onTestFinished(() => rt.close());
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const passed: unknown[] = [];
    rt.events.on("session.context", e => passed.push([e.type === "session.context" ? e.context : 0]));
    const first = await rt.sessions.start(ws.id, { prompt: "/compact" });
    await first.finished;
    await (await rt.sessions.start(ws.id, { thread: first.view().threadId!, prompt: "again" })).finished;
    // A subagent's call names no figure and passes nothing; the first turn's row goes out as it is written.
    expect(passed).toEqual([[26_000], [27_500], [27_500], [26_000], [27_500]]);
    const history = await rt.sessions.history(ws.id);
    // The first turn's result named nothing, so its last reading is its row; the second's result is the reading.
    expect(heldRows(history)).toEqual([["compacted", 1, 27_500, 3_100], [first.turnId, 27_500, 200_000], ["compacted", 1, 27_500, 3_100]]);
  });

  it("writes what a running turn's agent held as its host closes, for the next window to read off the transcript", async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: holding({ named: [], hang: true }) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "work" });
    await until(async () => heldRows(await rt.sessions.history(ws.id)).length === 1, 5_000);
    expect(heldRows(await rt.sessions.history(ws.id))).toEqual([["compacted", 1, 27_500, 3_100]]);
    await rt.close();
    const again = createRuntime({ backend: stubBackend(), store, adapters: {} });
    onTestFinished(() => again.close());
    expect(heldRows(await again.sessions.history(ws.id))).toEqual([["compacted", 1, 27_500, 3_100], [handle.turnId, 27_500, 200_000]]);
  });

  it("keeps a tool result's opening characters in the transcript and hands the live stream all of it", async () => {
    const output = `first line\n${"r".repeat(TOOL_RESULT_KEPT * 4)}`;
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: tooled("{}", output) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const live: string[] = [];
    rt.events.on("*", e => {
      if (e.type === "session.delta" && e.kind === "tool_result") live.push(e.text);
    });
    await (await rt.sessions.start(ws.id, { prompt: "read it" })).finished;
    expect(live).toEqual([output]);
    const kept = (await rt.sessions.history(ws.id)).flatMap(e => (e.type === "session.delta" && e.kind === "tool_result" ? [e.text] : []));
    expect(kept).toEqual([output.slice(0, TOOL_RESULT_KEPT)]);
    await rt.close();
  });

  it("moves the transcripts an older build kept inside the state file into files of their own", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.close();
    const events = [
      { type: "session.start", workspaceId: ws.id, sessionId: "s1", threadId: "thr_1", prompt: "go", at: 1 },
      { type: "session.end", workspaceId: ws.id, sessionId: "s1", threadId: "thr_1", exitCode: 0, sawResult: true, at: 2 },
    ];
    await store.put("transcripts", ws.id, { workspaceId: ws.id, events });

    const after = createRuntime({ backend, store, adapters: {} });
    // The move gives each event its place in the transcript, in order from one.
    expect(await after.sessions.history(ws.id)).toEqual(placed(events));
    expect(await store.list("transcripts")).toEqual([]);
    expect(JSON.parse((await store.getBlob("transcripts", ws.id))!.toString("utf8"))).toEqual({ workspaceId: ws.id, events: placed(events) });
    await after.close();
  });

  /** Every event a workspace's transcript files hold, the head written at a move and the tail the host flushes. */
  const onDisk = async (store: Store, id: string): Promise<unknown[]> => {
    const read = async (collection: string): Promise<unknown[]> => {
      const bytes = await store.getBlob(collection, id);
      return bytes === undefined ? [] : (JSON.parse(bytes.toString("utf8")) as { events: unknown[] }).events;
    };
    return [...(await read("transcript-heads")), ...(await read("transcripts"))];
  };
  /** Events as a move writes them: each with its place in the transcript, in order from one. */
  const placed = <T extends object>(events: readonly T[]): (T & { pos: number })[] => events.map((e, i) => ({ ...e, pos: i + 1 }));
  const delta = (workspaceId: string, i: number, text: string) => ({ type: "session.delta", workspaceId, sessionId: "s1", threadId: "thr_1", kind: "tool_use", text, toolUseId: `u${i}`, at: i });

  it("moves every event of a transcript past the byte cap to its files, and holds only the tail", async () => {
    // The owner's state held 36194 events, and trimming them at the move would have dropped 2395 for good.
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.close();
    const events = Array.from({ length: 1000 }, (_, i) => delta(ws.id, i + 1, "k".repeat(8 * 1024)));
    await store.put("transcripts", ws.id, { workspaceId: ws.id, events });

    const after = createRuntime({ backend, store, adapters: {} });
    const history = await after.sessions.history(ws.id);
    expect(jsonBytes(history)).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
    expect(history.at(-1)).toEqual(placed(events).at(-1));
    expect(await onDisk(store, ws.id)).toEqual(placed(events));
    // A turn after the move rewrites the tail and leaves the head as the move wrote it.
    await after.close();
    const again = createRuntime({ backend, store, adapters: { claude: scripted("more") } });
    await (await again.sessions.start(ws.id, { prompt: "more" })).finished;
    await again.close();
    const kept = await onDisk(store, ws.id);
    expect(kept.slice(0, events.length - history.length)).toEqual(placed(events).slice(0, events.length - history.length));
    expect(kept.some(e => (e as { prompt?: string }).prompt === "more")).toBe(true);
  });

  it("merges a transcript an older build wrote back into the state file with what its files hold, and never duplicates", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.close();
    const first = Array.from({ length: 3000 }, (_, i) => delta(ws.id, i + 1, "a"));
    await store.put("transcripts", ws.id, { workspaceId: ws.id, events: first });
    const moved = createRuntime({ backend, store, adapters: {} });
    expect(await moved.sessions.history(ws.id)).toHaveLength(first.length);
    await moved.close();
    // An older build on the same state finds no transcript in it and writes the two events it recorded there.
    const older = [delta(ws.id, 5001, "b"), delta(ws.id, 5002, "c")];
    await store.put("transcripts", ws.id, { workspaceId: ws.id, events: older });

    const after = createRuntime({ backend, store, adapters: {} });
    expect(await after.sessions.history(ws.id)).toEqual(placed([...first, ...older]));
    await after.close();
    // A move cut short after its files were written leaves the same events in both places: they are kept once.
    await store.put("transcripts", ws.id, { workspaceId: ws.id, events: [...first, ...older] });
    const redone = createRuntime({ backend, store, adapters: {} });
    expect(await redone.sessions.history(ws.id)).toEqual(placed([...first, ...older]));
    expect(await onDisk(store, ws.id)).toEqual(placed([...first, ...older]));
    await redone.close();
  });
});
