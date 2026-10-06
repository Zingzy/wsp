// SPDX-License-Identifier: AGPL-3.0-only
// A thread on this computer keeps its agent process between turns: the shipped Claude adapter over this computer's
// runs, driving an agent that serves turn after turn from one process and names that process in every reply.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { AGENT_KEEP_MS, AGENTS_KEPT, HERE_PLACE_ID, NO_SUCH_TURN, NOTIFY_ME, type SessionEvent, type TurnResult } from "@wsp/protocol";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { localExecStream } from "../src/local-exec.js";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { claudeKeeper, codexKeeper, pidOf, tokenOf } from "./kept-stubs.js";
import { stubBackend, copyingFake, createOn, testPlatform } from "./stub-backend.js";
import { alive, gone, sweepStrays } from "./strays.js";
import { until } from "./until.js";

let root: string;
let runDir: string;
let store: Store;
let gate: string;
let heard: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wsp-keeps-"));
  runDir = join(root, "runs");
  gate = join(root, "gate");
  heard = join(root, "heard");
  store = memoryStore();
  mkdirSync(join(root, "bin"));
  claudeKeeper(join(root, "bin", "claude"));
  codexKeeper(join(root, "bin", "codex"));
});
afterEach(async () => {
  await localExecStream({ root, runDir }).sweep!([]);
  rmSync(root, { recursive: true, force: true });
  sweepStrays();
});

const wiring = (reading?: Set<() => void>, env: Record<string, string> = {}): LocalWiring => ({
  backend: new LocalBackend({ root }),
  execStream: o => localExecStream({ root, runDir, pollMs: 20, ...o, ...(reading !== undefined ? { reading } : {}) }),
  home: () => join(root, ".claude"),
  homeDir: root,
  rootsPath: join(root, "roots"),
  env: () => ({ PATH: `${join(root, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, STUB_GATE: gate, STUB_HEARD: heard, ...env }),
  platform: testPlatform(),
  copier: copyingFake(),
});

const host = (o: { reading?: Set<() => void>; clock?: ReturnType<typeof fakeClock>["clock"]; env?: Record<string, string>; dials?: true } = {}): Runtime =>
  createRuntime({
    backend: stubBackend(),
    store,
    adapters: { claude: HARNESS_ADAPTERS.claude, codex: HARNESS_ADAPTERS.codex },
    local: wiring(o.reading, o.env),
    ...(o.clock !== undefined ? { clock: o.clock } : {}),
    // A host its turns can dial mints each a device of its own, the token a kept process goes on holding.
    ...(o.dials === true ? { agents: { here: { url: "http://127.0.0.1:9" } } } : {}),
  });

/** Whether any process of a run's group is still there, by the leader pid its launch recorded. */
const groupAlive = (leader: number): boolean => {
  try {
    process.kill(-leader, 0);
    return true;
  } catch {
    return false;
  }
};

/** One send into a thread, run to its reply. */
const send = async (rt: Runtime, workspaceId: string, prompt: string, more: { thread?: string; model?: string; harness?: string } = {}): Promise<{ result: TurnResult; threadId: string }> => {
  const handle = await rt.sessions.start(workspaceId, { prompt, ...more });
  const result = await handle.finished;
  return { result, threadId: handle.view().threadId! };
};

describe("a thread on this computer keeps its agent process between turns", () => {
  it("answers the second send from the process its first turn left up, under the same turn token", async () => {
    const rt = host();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const one = await send(rt, ws.id, "one");
    expect(one.result.status).toBe("completed");
    const two = await send(rt, ws.id, "two", { thread: one.threadId });
    expect(two.result.text).toContain("two from");
    expect(pidOf(two.result.text)).toBe(pidOf(one.result.text));
    expect(tokenOf(two.result.text)).toBe(tokenOf(one.result.text));
    expect((await rt.sessions.list(ws.id)).filter(s => s.threadId === one.threadId).every(s => s.status === "completed")).toBe(true);
    await rt.close();
    await gone(pidOf(one.result.text));
  }, 30_000);

  it("a slate write from the kept process, by the token it still holds, lands on its own thread's slate", async () => {
    const rt = host();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const one = await send(rt, ws.id, "one");
    const two = await send(rt, ws.id, "two", { thread: one.threadId });
    expect(pidOf(two.result.text)).toBe(pidOf(one.result.text));
    // Between turns too: the process is up and resting, and its token names its thread until the keep ends.
    const wrote = await rt.slates.write({ turnToken: tokenOf(two.result.text), text: `<slate title="Kept"><column><text>still here</text></column></slate>` });
    expect(wrote.version).toBe(1);
    expect((await rt.slates.get(one.threadId))?.version).toBe(1);
    await rt.close();
    await gone(pidOf(one.result.text));
  }, 30_000);

  it("answers a Codex thread's second send on the app server its first turn left up", async () => {
    const rt = host();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const one = await send(rt, ws.id, "one", { harness: "codex" });
    expect(one.result.status).toBe("completed");
    const two = await send(rt, ws.id, "two", { thread: one.threadId });
    expect(two.result.text).toContain("two from");
    expect(pidOf(two.result.text)).toBe(pidOf(one.result.text));
    const starts = (await rt.sessions.history(ws.id)).filter(e => e.type === "session.start" && e.threadId === one.threadId);
    expect(starts.map(e => (e as { prompt: string }).prompt)).toEqual(["one", "two"]);
    await rt.close();
    await gone(pidOf(one.result.text));
  }, 30_000);

  it("ends the kept process when the model changes between turns, and the next turn boots cold", async () => {
    const rt = host();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const one = await send(rt, ws.id, "one", { model: "claude-opus-5-5" });
    const two = await send(rt, ws.id, "two", { thread: one.threadId, model: "claude-sonnet-5" });
    expect(two.result.status).toBe("completed");
    expect(pidOf(two.result.text)).not.toBe(pidOf(one.result.text));
    await gone(pidOf(one.result.text));
    await rt.close();
  }, 30_000);

  it("reuses the kept process after the host itself wrote the thread's title into its session file", async () => {
    const sessions = join(root, ".claude", "projects", "here");
    mkdirSync(sessions, { recursive: true });
    // The title lands after the turn's end, as the real one does seconds after a quick reply.
    const rt = host({ env: { STUB_SESSIONS: sessions, STUB_TITLE: "Kept thread", STUB_TITLE_MS: "1500" } });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const one = await send(rt, ws.id, "one");
    const session = (await rt.sessions.list(ws.id)).find(s => s.threadId === one.threadId)!.claudeSessionId!;
    await until(() => readFileSync(join(sessions, `${session}.jsonl`), "utf8").includes("custom-title"), 10_000);
    const two = await send(rt, ws.id, "two", { thread: one.threadId });
    expect(pidOf(two.result.text)).toBe(pidOf(one.result.text));
    // And after a rename the person makes.
    const row = (await rt.sessions.list(ws.id)).find(s => s.threadId === one.threadId)!;
    expect(await rt.sessions.rename(row.id, "Renamed")).toMatchObject({ outcome: "renamed" });
    const three = await send(rt, ws.id, "three", { thread: one.threadId });
    expect(pidOf(three.result.text)).toBe(pidOf(one.result.text));
    await rt.close();
  }, 30_000);

  it("ends the kept process when the session file changed since its last turn, since the person resumed it elsewhere", async () => {
    const rt = host();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const one = await send(rt, ws.id, "one");
    const session = (await rt.sessions.list(ws.id)).find(s => s.threadId === one.threadId)!.claudeSessionId!;
    mkdirSync(join(root, ".claude", "projects", "elsewhere"), { recursive: true });
    writeFileSync(join(root, ".claude", "projects", "elsewhere", `${session}.jsonl`), '{"type":"user"}\n');
    const two = await send(rt, ws.id, "two", { thread: one.threadId });
    expect(pidOf(two.result.text)).not.toBe(pidOf(one.result.text));
    await gone(pidOf(one.result.text));
    // Nothing changed it since, so the next send is the cold turn's own process.
    const three = await send(rt, ws.id, "three", { thread: one.threadId });
    expect(pidOf(three.result.text)).toBe(pidOf(two.result.text));
    await rt.close();
  }, 30_000);

  it("ends a kept process after its idle keep with no turn, and its token then names nobody", async () => {
    const fc = fakeClock();
    const rt = host({ clock: fc.clock });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const one = await send(rt, ws.id, "one");
    const token = tokenOf(one.result.text);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    // Between turns the token still names its thread: the process holding it is the thread's.
    const kid = await rt.sessions.start(ws.id, { prompt: "kid", notify: [NOTIFY_ME], turnToken: token });
    await kid.finished;
    await until(async () => (await rt.sessions.history(ws.id)).filter(e => e.type === "session.done" && e.threadId === one.threadId).length === 2, 20_000);
    expect(alive(pidOf(one.result.text))).toBe(true);
    fc.advance(AGENT_KEEP_MS - 1_000);
    expect(alive(pidOf(one.result.text))).toBe(true);
    fc.advance(1_000);
    await gone(pidOf(one.result.text));
    await expect(rt.sessions.start(ws.id, { prompt: "late", notify: [NOTIFY_ME], turnToken: token })).rejects.toThrow(NO_SUCH_TURN);
    await rt.close();
  }, 30_000);

  it(`keeps at most ${AGENTS_KEPT} on this computer, the one idle longest ended first`, async () => {
    const rt = host();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const pids: number[] = [];
    for (let n = 0; n <= AGENTS_KEPT; n++) pids.push(pidOf((await send(rt, ws.id, `thread ${n}`)).result.text));
    await gone(pids[0]!);
    expect(pids.slice(1).every(alive)).toBe(true);
    await rt.close();
  }, 60_000);

  it("ends the kept process when its thread is settled, and when it is deleted", async () => {
    const rt = host();
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const settled = await send(rt, ws.id, "settle me");
    const deleted = await send(rt, ws.id, "delete me");
    await rt.sessions.settle([settled.threadId]);
    await gone(pidOf(settled.result.text));
    expect(alive(pidOf(deleted.result.text))).toBe(true);
    await rt.sessions.delete(deleted.threadId);
    await gone(pidOf(deleted.result.text));
    await rt.close();
  }, 30_000);
});

describe("a host that goes with an agent kept", () => {
  it("ends the kept agent's whole tree, its input pump included, though the agent is slow to exit on its input's end", async () => {
    const rt = host({ env: { STUB_EXIT_MS: "8000" } });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await send(rt, ws.id, "one");
    const leaders = readdirSync(runDir).filter(name => name.endsWith(".pid")).map(name => Number(readFileSync(join(runDir, name), "utf8").trim()));
    expect(leaders).toHaveLength(1);
    expect(groupAlive(leaders[0]!)).toBe(true);
    await rt.close();
    await until(() => !groupAlive(leaders[0]!), 5_000);
  }, 30_000);
});

describe("a host that crashed with an agent kept", () => {
  it("leaves the next host to take away the device the kept process held, since the sweep ends that process", async () => {
    const reading = new Set<() => void>();
    const rt1 = host({ reading, dials: true });
    const ws = await createOn(rt1, { on: HERE_PLACE_ID, name: "mac" });
    await send(rt1, ws.id, "one");
    const minted = (await rt1.devices.list()).filter(d => d.name.startsWith("thread "));
    expect(minted).toHaveLength(1);
    // A crash runs no close: the first host's readers simply stop.
    for (const drop of [...reading]) drop();
    const rt2 = host({ dials: true });
    await rt2.sessions.list(ws.id);
    await until(async () => !(await rt2.devices.list()).some(d => d.id === minted[0]!.id), 5_000);
    await rt2.close();
    await rt1.close();
  }, 30_000);
});

describe("a later turn re-opened by the next host", () => {
  it("writes its missing start row with the message typed for that turn, not the thread's first", async () => {
    const reading = new Set<() => void>();
    const rt1 = host({ reading });
    const ws = await createOn(rt1, { on: HERE_PLACE_ID, name: "mac" });
    const one = await send(rt1, ws.id, "the first message");
    await rt1.sessions.start(ws.id, { prompt: "the second message later", thread: one.threadId });
    // The agent holds the message and has said nothing for it when the host goes.
    await until(() => existsSync(heard) && readFileSync(heard, "utf8").includes("the second message later"), 10_000);
    await rt1.close();
    for (const drop of [...reading]) drop();
    writeFileSync(gate, "go\n");

    const rt2 = host();
    await until(async () => (await rt2.sessions.list(ws.id)).every(s => s.status !== "running"), 20_000);
    const history = await rt2.sessions.history(ws.id);
    const starts = history.filter((e): e is Extract<SessionEvent, { type: "session.start" }> => e.type === "session.start" && e.threadId === one.threadId);
    expect(starts.map(e => e.prompt)).toEqual(["the first message", "the second message later"]);
    const done = history.filter((e): e is Extract<SessionEvent, { type: "session.done" }> => e.type === "session.done" && e.threadId === one.threadId);
    expect(done.at(-1)!.result.text).toContain("the second message later from");
    await rt2.close();
  }, 30_000);
});
