// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { SessionEvent, type AdapterEvent, type EventUnion, type PermissionAsk, type TurnResult } from "@wsp/protocol";
import { GuestUnusableError } from "@wsp/engine";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { machineExecStream } from "../src/machine-exec.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, type StubMachine, createOn } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { held, settle } from "./runtime-fixture.js";

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
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    expect(backend.machines[0]!.spec.idempotencyKey).toMatch(new RegExp(`^workspace/${ws.id}:[0-9a-f]{16}$`));
    expect(await store.list("creates")).toEqual([]);
  });

  it("a retry of an attempt the provider never answered sends the same key and the same body", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    let lose = true;
    const specs = intercept(backend, (spec, real) => {
      if (lose) {
        lose = false;
        throw lostAnswer();
      }
      return real(spec);
    });
    await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow("fetch failed");
    expect(await store.list("creates")).toHaveLength(1);
    const rebuilt = await rt.workspaces.rebuild(ws.id);
    expect(rebuilt.machineId).toBe("m2");
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
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    await rt.workspaces.upgrade(ws.id);
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

  it("a create the backend gave up on because nothing on the guest could run spends its key, so the next attempt never sends the deleted box's key again", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    let dead = true;
    const specs = intercept(backend, (spec, real) => {
      if (dead) {
        dead = false;
        // The backend deleted the box it could not use before throwing; a key that outlived it would name it again.
        throw new GuestUnusableError("bx_dead", "Boat", "bash: error while loading shared libraries: libtinfo.so.6: cannot open shared object file: Error 24", 200);
      }
      return real(spec);
    });
    await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow(/nothing on it can run/);
    expect(await store.list("creates")).toEqual([]);
    await rt.workspaces.rebuild(ws.id);
    expect(specs[1]!.idempotencyKey).not.toBe(specs[0]!.idempotencyKey);
  });

  it("a replayed create is logged, and a replay naming a dead machine is created anew under a fresh key", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await createOn(rt, { golden: "snap_g", name: "x" });
      const specs = intercept(backend, async (spec, real) => {
        const m = await real(spec);
        if (specs.length === 1) m.killed = true;
        return Object.assign(Object.create(m) as typeof m, { replayed: specs.length <= 2 });
      });
      const rebuilt = await rt.workspaces.rebuild(ws.id);
      expect(rebuilt.machineId).toBe("m3");
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
    const ws = await createOn(rt, { golden: "snap_g", name: "x" });
    let losses = 2;
    const specs = intercept(backend, (spec, real) => {
      if (losses-- > 0) throw lostAnswer();
      return real(spec);
    });
    await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow("fetch failed");
    const purpose = `workspace/${ws.id}`;
    const left = (await store.get("creates", purpose)) as { key: string; pid: number };
    expect(left.pid).toBe(process.pid);
    const deadPid = 99_999_999;
    await store.put("creates", purpose, { ...left, pid: deadPid });
    await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow("fetch failed");
    expect(await store.get("creates", purpose)).toMatchObject({ key: left.key, pid: process.pid });
    await rt.workspaces.rebuild(ws.id);
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
      ask: (raised: PermissionAsk) => onEvent!({ type: "permission.ask", sessionId: SID, ask: raised }),
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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

  it("marks the steer waiting when the turn it joined is stopped on a prompt nobody has answered, and leaves it off one that is working", async () => {
    const h = steerable();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "write it" });
    h.init();
    await rt.sessions.steer(handle.id, { prompt: "hurry" });
    h.ask({ askId: "a1", toolName: "Write", input: JSON.stringify({ file_path: "kai.txt" }), options: [{ id: "allow", label: "Yes", effect: "allow" }] });
    await vi.waitFor(async () => expect((await rt.sessions.list(ws.id))[0]!.asking).toBeDefined());
    await rt.sessions.steer(handle.id, { prompt: "yes" });
    const steers = events.filter(e => e.type === "session.steer") as Extract<SessionEvent, { type: "session.steer" }>[];
    expect(steers.map(e => [e.prompt, e.waiting])).toEqual([
      ["hurry", undefined],
      ["yes", true],
    ]);
    h.end();
    await handle.finished;
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    expect((await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!.steers).toBe(true);
    expect((await rt.harnesses.list()).find(c => c.harness === "claude")!.steers).toBe(false);
    await rt.close();
  });

  it("a steer inside a turn keeps the idle hold: the workspace stays awake through the window and naps after the turn ends", async () => {
    const h = steerable();
    const fc = fakeClock();
    const WINDOW = 5 * 60_000;
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter }, clock: fc.clock, idle: { defaultWindowMs: WINDOW }, status: { costIntervalMs: 60_000, pollIntervalMs: 60_000 } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
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

describe("a start on a thread whose turn is running", () => {
  it("on a harness that steers, the start becomes a steer: session.steer is recorded with the request id, no second session.start, and the caller holds the running turn", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "loop for a minute", requestId: "req_1" });
    expect(first.outcome).toBe("started");
    const sid = first.view().claudeSessionId!;
    const joined = await rt.sessions.start(ws.id, { prompt: "end with STEERED", thread: first.view().threadId!, requestId: "req_2", startedBy: "cli" });
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const first = await rt.sessions.start(ws.id, { prompt: "one" });
    const sid = first.view().claudeSessionId!;
    let second: Awaited<ReturnType<typeof rt.sessions.start>> | undefined;
    const pending = rt.sessions.start(ws.id, { prompt: "two", thread: first.view().threadId!, requestId: "req_2" }).then(s => (second = s));
    await settle();
    expect(h.starts.map(s => s.prompt)).toEqual(["one"]);
    expect(second).toBeUndefined();
    // The wait is announced at once, so a caller can say it is waiting before the reply comes.
    expect(events.filter(e => e.type === "session.queued")).toEqual([{ type: "session.queued", workspaceId: ws.id, threadId: first.view().threadId, harness: "claude", prompt: "two", requestId: "req_2", seq: expect.any(Number) }]);
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
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const thread = (await rt.sessions.start(ws.id, { prompt: "one" })).view().threadId!;
    const outcomes: string[] = [];
    const two = rt.sessions.start(ws.id, { prompt: "two", thread }).then(s => outcomes.push(`two:${s.outcome}`));
    const three = rt.sessions.start(ws.id, { prompt: "three", thread }).then(s => outcomes.push(`three:${s.outcome}`));
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

  it("a send that meets the reply tail queues instead of being refused, and two of them keep their order", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "one" });
    const threadId = first.view().threadId!;
    // The turn has answered and its process has not exited: the row still reads running.
    h.reply(0, "answered");
    expect(first.view().status).toBe("running");
    const outcomes: string[] = [];
    const two = rt.sessions.start(ws.id, { prompt: "two", thread: threadId }).then(t => outcomes.push(`two:${t.outcome}`));
    const three = rt.sessions.start(ws.id, { prompt: "three", thread: threadId }).then(t => outcomes.push(`three:${t.outcome}`));
    await settle();
    // Neither was refused, and neither opened a second agent on the thread while the first process lived.
    expect(h.starts.map(s => s.prompt)).toEqual(["one"]);
    h.exit(0);
    await two;
    h.end(1, "two done");
    await three;
    expect(h.starts.map(s => s.prompt)).toEqual(["one", "two", "three"]);
    expect(outcomes).toEqual(["two:queued", "three:queued"]);
    h.end(2, "three done");
    await rt.close();
  });

  it("a harness that takes a message mid-turn takes none once its turn has answered: that send queues for the next turn too", async () => {
    const h = held(true);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "one" });
    const threadId = first.view().threadId!;
    h.reply(0, "answered");
    const later = rt.sessions.start(ws.id, { prompt: "two", thread: threadId });
    await settle();
    // Steering it would put the words behind a reply the caller has already read.
    expect(h.steered).toEqual([]);
    expect(h.starts.map(s => s.prompt)).toEqual(["one"]);
    h.exit(0);
    expect((await later).outcome).toBe("queued");
    expect(h.starts.map(s => s.prompt)).toEqual(["one", "two"]);
    h.end(1, "two done");
    await rt.close();
  });

  it("a start on another thread of the same workspace is not held back by the running turn", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "one" });
    const other = await rt.sessions.start(ws.id, { prompt: "elsewhere" });
    expect(other.outcome).toBe("started");
    expect(h.starts.map(s => s.prompt)).toEqual(["one", "elsewhere"]);
    await rt.close();
  });
});

describe("what a turn cost, on the row it ran on", () => {
  it("is kept on the row the listing answers with, and adds up over the turns that ran there, so a reader of the list needs no transcript to say what a thread spent", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const one = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    h.end(0, "done", { durationMs: 1_000, costUsd: 0.75 });
    await one.finished;
    expect(one.view().costUsd).toBeCloseTo(0.75, 10);
    // A second turn on the same row: what the row says is what the turns on it have cost together.
    const two = await rt.sessions.start(ws.id, { prompt: "and again", thread: one.view().threadId });
    h.end(1, "done again", { durationMs: 1_000, costUsd: 0.39 });
    await two.finished;
    const rows = await rt.sessions.list(ws.id);
    expect(rows.map(r => r.costUsd).filter(c => c !== undefined).reduce((a, b) => a + b, 0)).toBeCloseTo(1.14, 10);
    await rt.close();
  });

  it("is absent on a row whose harness reported no figure, so nothing reads a missing number as nothing spent", async () => {
    const h = held(false);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const turn = await rt.sessions.start(ws.id, { prompt: "orchestrate" });
    h.end(0, "done", { durationMs: 1_000 });
    await turn.finished;
    expect((await rt.sessions.list(ws.id))[0]!.costUsd).toBeUndefined();
    await rt.close();
  });
});
