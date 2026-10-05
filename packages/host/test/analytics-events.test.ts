// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HERE_PLACE_ID, usageRefusal, type EventUnion, type InitJob, type InitJobEvent, type Preferences } from "@wsp/protocol";
import { hostAnalytics, NO_ANALYTICS, type AnalyticsProps } from "../src/analytics.js";
import { followUsage, OP_FAILED_EVERY_MS, osWord, usageReader } from "../src/analytics-events.js";

// Every property each event may carry. A property not written here fails the suite, so adding one is a change to
// this list that a reviewer reads, never a field that rides along unseen.
const ALLOWED: Record<string, readonly string[]> = {
  "host.started": ["projects", "computers", "workspaces", "firstRun"],
  "init.ended": ["road", "outcome", "durationMs", "stoppedAt"],
  "thread.started": ["agent", "startedBy", "model", "permissionMode"],
  "turn.done": ["agent", "status", "startedBy", "refusal", "model", "models", "durationMs", "waitedMs", "costUsd", "inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "reasoningTokens"],
  "computer.added": ["os", "agents"],
  "computer.setup.ended": ["end", "failedSteps", "durationMs"],
  "project.added": ["source", "here"],
  "op.failed": ["op", "class", "kind"],
};
const COMMON = ["wspVersion", "os", "arch", "host", "$process_person_profile"];

/** Put in every field that carries a person's words, a path, a name, a secret or a model's free text. */
const S = "SENTINEL-sk-ant-x-/Users/someone/secret-project";

const turnStart = (turnId: string, opensThread: boolean, agent = "claude"): EventUnion =>
  ({
    type: "session.start",
    workspaceId: S,
    sessionId: S,
    turnId,
    threadId: S,
    prompt: S,
    cwd: S,
    model: S,
    agent,
    permissionMode: "bypassPermissions",
    startedBy: "agent",
    tools: [S],
    attachments: [{ name: S, type: "text/plain", bytes: 3 }],
    harness: { slashCommands: [S], permissionMode: S, agents: [S] },
    ...(opensThread ? { opensThread: true } : {}),
    seq: 1,
  }) as unknown as EventUnion;

const turnDone = (turnId: string): EventUnion =>
  ({
    type: "session.done",
    workspaceId: S,
    sessionId: S,
    turnId,
    threadId: S,
    result: {
      status: "failed",
      durationMs: 1200,
      waitedMs: 200,
      costUsd: 0.12,
      tokens: { input: 100, output: 20, cached: 50, cacheWrite: 10, reasoning: 5 },
      model: "claude-opus-5-5[1m]",
      models: [{ model: S, tokens: { input: 1, output: 1 } }],
      text: S,
      error: S,
      refusal: "sign-in",
    },
    seq: 2,
  }) as unknown as EventUnion;

const placeJoined: EventUnion = { type: "place.joined", place: { id: S, kind: "computer", name: S, label: S, default: false, os: `Ubuntu 24.04 ${S}`, agents: ["claude", "codex"], logins: S }, from: S, seq: 3 } as unknown as EventUnion;
const setupLine = (step: string, state: string): EventUnion => ({ type: "place.setup", addId: "add-1", placeId: S, line: { step, state, note: S }, said: S, seq: 4 }) as unknown as EventUnion;
const setupEnd: EventUnion = { type: "place.setup", addId: "add-1", placeId: S, end: "needs-you", said: S, landed: S, seq: 5 } as unknown as EventUnion;
const projectAdded: EventUnion = {
  type: "project.added",
  project: { id: S, name: S, computer: HERE_PLACE_ID, source: { kind: "folder", path: S }, path: S, remote: S, defaultBranch: S, memoryKey: S, memoryDir: S },
  seq: 6,
} as unknown as EventUnion;
const initJob = (phase: InitJob["phase"]): InitJobEvent => ({ type: "init.job", job: { id: "job-1", road: "agent", phase, error: S, log: [S], line: S, place: { id: S, name: S }, workspace: { id: S, name: S } } as unknown as InitJob });

function readAll() {
  let clock = 1_000_000;
  const got: Array<{ event: string; properties: AnalyticsProps }> = [];
  const reader = usageReader((event, properties) => got.push({ event, properties }), () => clock);
  const tick = (ms: number) => (clock += ms);
  reader.bus(turnStart("t1", true));
  reader.bus(turnDone("t1"));
  reader.bus(placeJoined);
  reader.bus(setupLine("mcp", "running"));
  tick(3_000);
  reader.bus(setupLine("mcp", "failed"));
  reader.bus(setupEnd);
  reader.bus(projectAdded);
  reader.init(initJob("reading"));
  reader.init(initJob("building"));
  tick(60_000);
  reader.init(initJob("failed"));
  reader.failed("sessions.start", Object.assign(new Error(S), { kind: S }));
  reader.started({ projects: 2, computers: 1, workspaces: 3, firstRun: true });
  return { got, reader, tick };
}

describe("what each event carries", () => {
  it("every event is one of the eight and every property is on its list", () => {
    const { got } = readAll();
    expect(new Set(got.map(g => g.event))).toEqual(new Set(Object.keys(ALLOWED)));
    for (const { event, properties } of got) {
      expect(ALLOWED[event], event).toBeDefined();
      for (const key of Object.keys(properties)) expect(ALLOWED[event], `${event} carries ${key}`).toContain(key);
      for (const value of Object.values(properties)) {
        const ok = typeof value === "number" || typeof value === "boolean" || typeof value === "string" || (Array.isArray(value) && value.every(v => typeof v === "string"));
        expect(ok, `${event}: ${JSON.stringify(value)}`).toBe(true);
      }
    }
  });

  it("never a prompt, a folder, a reply, an error, a name, a path or a model's free text", () => {
    const { got } = readAll();
    expect(JSON.stringify(got)).not.toContain("SENTINEL");
  });

  it("reads each field into a catalog id, a fixed word, a count or a time", () => {
    const { got } = readAll();
    const of = (event: string) => got.find(g => g.event === event)?.properties;
    expect(of("thread.started")).toEqual({ agent: "claude", startedBy: "agent", model: "other", permissionMode: "bypassPermissions" });
    expect(of("turn.done")).toEqual({
      agent: "claude",
      status: "failed",
      startedBy: "agent",
      refusal: "sign-in",
      model: "claude-opus-5-5",
      models: 1,
      durationMs: 1200,
      waitedMs: 200,
      costUsd: 0.12,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 50,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
    });
    expect(of("computer.added")).toEqual({ os: "linux", agents: 2 });
    expect(of("computer.setup.ended")).toEqual({ end: "needs-you", failedSteps: ["mcp"], durationMs: 3_000 });
    expect(of("project.added")).toEqual({ source: "folder", here: true });
    expect(of("init.ended")).toEqual({ road: "agent", outcome: "failed", durationMs: 60_000, stoppedAt: "building" });
    expect(of("op.failed")).toEqual({ op: "sessions.start", class: "provider" });
    expect(of("host.started")).toEqual({ projects: 2, computers: 1, workspaces: 3, firstRun: true });
  });

  it("an agent the catalog does not know is other, and so are its model and its access", () => {
    const got: Array<{ event: string; properties: AnalyticsProps }> = [];
    const reader = usageReader((event, properties) => got.push({ event, properties }));
    reader.bus(turnStart("t9", true, S));
    expect(got[0]!.properties).toEqual({ agent: "other", startedBy: "agent", model: "other", permissionMode: "other" });
  });

  it("a stamped kind is sent only where it is one the exit contract knows", () => {
    const got: Array<{ event: string; properties: AnalyticsProps }> = [];
    const reader = usageReader((event, properties) => got.push({ event, properties }));
    reader.failed("projects.add", usageRefusal(S, S));
    expect(got[0]!.properties).toEqual({ op: "projects.add", class: "usage", kind: "usage" });
  });

  it("reads a computer's os line as darwin, linux or other", () => {
    expect([osWord("macOS 15.0"), osWord("Darwin 25.4.0"), osWord("Ubuntu 24.04"), osWord("Debian GNU/Linux 12"), osWord(S), osWord(undefined)]).toEqual(["darwin", "darwin", "linux", "linux", "other", "other"]);
  });
});

describe("counting once", () => {
  it("a thread is started only by the turn that opened it", () => {
    const got: string[] = [];
    const reader = usageReader(event => got.push(event));
    reader.bus(turnStart("a", true));
    reader.bus(turnDone("a"));
    reader.bus(turnStart("b", false));
    reader.bus(turnDone("b"));
    expect(got).toEqual(["thread.started", "turn.done", "turn.done"]);
  });

  it("a turn whose end is reported twice is one turn", () => {
    const got: string[] = [];
    const reader = usageReader(event => got.push(event));
    reader.bus(turnStart("a", false));
    reader.bus(turnDone("a"));
    reader.bus(turnDone("a"));
    expect(got).toEqual(["turn.done"]);
  });

  it("an init job is ended once, however often its ended view is sent again", () => {
    const got: string[] = [];
    const reader = usageReader(event => got.push(event));
    reader.init(initJob("answering"));
    reader.init(initJob("done"));
    reader.init(initJob("done"));
    expect(got).toEqual(["init.ended"]);
  });

  it("an op failing the same way is counted once a minute", () => {
    let clock = 0;
    const got: string[] = [];
    const reader = usageReader(event => got.push(event), () => clock);
    const boom = new Error("no");
    reader.failed("sessions.start", boom);
    reader.failed("sessions.start", boom);
    reader.failed("sessions.start", usageRefusal("no", "fix"));
    reader.failed("workspaces.list", boom);
    clock += OP_FAILED_EVERY_MS;
    reader.failed("sessions.start", boom);
    expect(got).toEqual(["op.failed", "op.failed", "op.failed", "op.failed"]);
  });
});

/** A runtime's bus and the reads the follower makes, and nothing else. */
function fakeRuntime(productUsage: boolean) {
  const listeners = new Map<string, Set<(e: EventUnion) => void>>();
  let prefs = { productUsage } as Preferences;
  return {
    rt: {
      events: {
        on: (type: string, l: (e: EventUnion) => void) => {
          const set = listeners.get(type) ?? new Set();
          listeners.set(type, set);
          set.add(l);
          return () => set.delete(l);
        },
        since: () => ({ stream: "s", head: 0, events: [], gap: false }),
      },
      preferences: { get: async () => prefs, set: async () => ({ preferences: prefs }) },
      projects: { list: async () => [{}, {}] },
      workspaces: { list: async () => [{}] },
      places: { list: async () => [{ kind: "computer", joinedAt: "x" }, { kind: "computer" }, { kind: "provider" }] },
    } as unknown as Parameters<typeof followUsage>[1],
    emit(e: EventUnion) {
      for (const l of listeners.get(e.type) ?? []) l(e);
    },
    setPrefs(p: boolean) {
      prefs = { productUsage: p } as Preferences;
      this.emit({ type: "preferences.changed", preferences: prefs, seq: 9 } as unknown as EventUnion);
    },
  };
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function wired(productUsage: boolean) {
  const home = mkdtempSync(join(tmpdir(), "wsp-usage-"));
  homes.push(home);
  const bodies: string[] = [];
  const fetch = (async (_url: string | URL, init: RequestInit = {}) => {
    bodies.push(String(init.body));
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  const client = hostAnalytics({ off: undefined, key: "phc_test", host: "http://capture.test", idDir: join(home, "config"), fetch, flushMs: 3_600_000, common: { wspVersion: "0.2.0", os: "darwin", arch: "arm64", host: "app" } });
  const runtime = fakeRuntime(productUsage);
  let initListener: ((e: InitJobEvent) => void) | undefined;
  const usage = followUsage(client, runtime.rt, { on: fn => ((initListener = fn), () => (initListener = undefined)) });
  return { client, runtime, usage, bodies, init: (e: InitJobEvent) => initListener?.(e) };
}

describe("following a runtime", () => {
  it("sends every event off the bus, the init job and the ops, and no sentinel reaches the posted body", async () => {
    const { client, runtime, usage, bodies, init } = wired(true);
    usage.begin();
    await new Promise(r => setTimeout(r, 10));
    for (const e of [turnStart("t1", true), turnDone("t1"), placeJoined, setupLine("mcp", "failed"), setupEnd, projectAdded]) runtime.emit(e);
    init(initJob("reading"));
    init(initJob("done"));
    usage.failed("sessions.start", new Error(S));
    await client.flush();
    usage.close();
    await client.close();
    const batch = bodies.flatMap(b => (JSON.parse(b) as { batch: Array<{ event: string; properties: Record<string, unknown> }> }).batch);
    expect(new Set(batch.map(e => e.event))).toEqual(new Set(Object.keys(ALLOWED)));
    for (const e of batch) for (const key of Object.keys(e.properties)) expect([...ALLOWED[e.event]!, ...COMMON], `${e.event} carries ${key}`).toContain(key);
    expect(bodies.join("\n")).not.toContain("SENTINEL");
    expect(batch.find(e => e.event === "host.started")!.properties).toMatchObject({ projects: 2, workspaces: 1, computers: 1, firstRun: true });
  });

  it("sends nothing, and makes no id, where the switch reads off at the start", async () => {
    const { client, runtime, usage, bodies } = wired(false);
    usage.begin();
    await new Promise(r => setTimeout(r, 10));
    runtime.emit(turnStart("t1", true));
    await client.flush();
    usage.close();
    await client.close();
    expect(bodies).toEqual([]);
  });

  it("stops at the next flush once the switch is turned off, and starts again when it is turned on", async () => {
    const { client, runtime, usage, bodies } = wired(true);
    usage.begin();
    await new Promise(r => setTimeout(r, 10));
    runtime.emit(turnStart("t1", true));
    runtime.setPrefs(false);
    runtime.emit(turnDone("t1"));
    await client.flush();
    expect(bodies).toEqual([]);
    runtime.setPrefs(true);
    runtime.emit(turnStart("t2", true));
    await client.flush();
    usage.close();
    await client.close();
    expect(bodies.flatMap(b => (JSON.parse(b) as { batch: Array<{ event: string }> }).batch.map(e => e.event))).toEqual(["thread.started"]);
  });

  it("follows nothing and reads nothing where the build has no key, so a dev host and a test host pay for none of it", async () => {
    const reads: string[] = [];
    const rt = {
      events: { on: (type: string) => (reads.push(`on ${type}`), () => {}) },
      preferences: { get: async () => (reads.push("preferences"), { productUsage: true }) },
      projects: { list: async () => (reads.push("projects"), []) },
      workspaces: { list: async () => (reads.push("workspaces"), []) },
      places: { list: async () => (reads.push("places"), []) },
    } as unknown as Parameters<typeof followUsage>[1];
    let initFollowed = false;
    const usage = followUsage(NO_ANALYTICS, rt, { on: () => ((initFollowed = true), () => {}) });
    usage.begin();
    usage.failed("sessions.start", new Error("no"));
    await new Promise(r => setTimeout(r, 10));
    usage.close();
    expect(reads).toEqual([]);
    expect(initFollowed).toBe(false);
  });

  it("a mapping that throws never reaches the emitter", () => {
    const { runtime, usage } = wired(true);
    expect(() => runtime.emit({ type: "place.joined", seq: 1 } as unknown as EventUnion)).not.toThrow();
    usage.close();
  });
});
