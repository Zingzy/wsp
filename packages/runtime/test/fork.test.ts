// SPDX-License-Identifier: AGPL-3.0-only
// A thread forked from one of its finished turns: the source read and every
// refusal made before anything is written, the session the fork's turns run
// on (a copy it resumes, or a fork the start makes), the history it opens on,
// what it carries of its source, and the source left as it was. The harnesses
// and the daemon are fakes, so the runtime's own reading is under test; git is
// real where a fork lands on a new branch.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import {
  FORK_BESIDE_FIX,
  FORK_NO_CHECKPOINT_FIX,
  FORK_NO_CHECKPOINT_LINE,
  FORK_RUNNING_FIX,
  FORK_RUNNING_LINE,
  FORK_REFUSED_FIX,
  REWIND_COPIED_LINE,
  codexNoTurnLine,
  copiedFromOf,
  foldThreads,
  forkAgentLine,
  forkNoAnchorLine,
  forkRefusedLine,
  forkTurnsLine,
  type AdapterEvent,
  type Attachment,
  type DaemonFrame,
  type DaemonResponse,
  type SessionEvent,
  type SessionForker,
  type TurnResult,
} from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type LocalWiring, type Runtime } from "../src/runtime.js";
import type { DaemonChannel } from "../src/daemon-channel.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { SESSIONS, type SessionIndexRecord } from "../src/types/internal.js";
import { gitCopier } from "./git-copier.js";
import { createOn, stubBackend, testPlatform, tokenGuest } from "./stub-backend.js";

const DAEMON_TOKEN = "cafef00d".repeat(3);
const PNG: Attachment = { mediaType: "image/png", bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", name: "dot.png" };
const sessionOf = (prefix: string, n: number): string => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** What a fake agent was asked: each start, each fork it readied, each copy it dropped. */
interface Asked {
  starts: HarnessStartOptions[];
  forks: Parameters<SessionForker>[0][];
  drops: string[];
}

/** An agent whose every turn announces its session, says `reply <n>`, names its end `a<n>` and replies at once. "copy"
 * forks onto a copy of the session that its start resumes, as Claude Code does; "start" hands the start the turn and
 * the start forks, answering a new session, as Codex does, and counts a turn that named no anchor. */
function agent(road: "copy" | "start", asked: Asked, o: { refuse?: string; anchorless?: number[]; hangFrom?: number; counter?: { n: number } } = {}): HarnessAdapterFactory {
  const counter = o.counter ?? { n: 0 };
  return () => ({
    steers: false,
    attachments: "inline",
    ...(road === "start" ? { forksByCount: true as const } : {}),
    forkSession: async f => {
      asked.forks.push(f);
      if (o.refuse !== undefined) throw new Error(o.refuse);
      if (road === "start") return { fork: { session: f.session, turn: "anchor" in f.turn ? f.turn.anchor : `counted-${f.turn.after.length}` } };
      const copy = sessionOf("c0c0c0c0", asked.forks.length);
      return { resume: copy, drop: async () => void asked.drops.push(copy) };
    },
    start: (s: HarnessStartOptions) => {
      counter.n += 1;
      const n = counter.n;
      asked.starts.push(s);
      const session = s.fork !== undefined ? sessionOf("f0f0f0f0", n) : (s.resume ?? sessionOf("50505050", n));
      const emit = (e: AdapterEvent): void => s.onEvent(e);
      if (o.hangFrom !== undefined && n >= o.hangFrom) {
        let stop: (r: TurnResult) => void = () => {};
        const finished = new Promise<TurnResult>(resolve => (stop = resolve));
        void Promise.resolve().then(() => emit({ type: "session.start", sessionId: session }));
        return {
          localId: session,
          finished,
          interrupt: async () => {
            emit({ type: "turn.done", sessionId: session, result: { status: "interrupted" } });
            emit({ type: "session.end", sessionId: session, exitCode: null, sawResult: false });
            stop({ status: "interrupted" });
          },
        };
      }
      const result: TurnResult = { status: "completed", text: `reply ${n}` };
      const finished = Promise.resolve().then(() => {
        emit({ type: "session.start", sessionId: session, model: s.model ?? "default-model" });
        emit({ type: "turn.delta", sessionId: session, kind: "text", text: `reply ${n}` });
        if (!(o.anchorless ?? []).includes(n)) emit({ type: "turn.anchor", sessionId: session, anchor: `a${n}` });
        emit({ type: "turn.done", sessionId: session, result });
        emit({ type: "session.end", sessionId: session, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: session, finished, interrupt: async () => {} };
    },
  });
}

/** A daemon that answers each checkpoint with a ref of the turn it names, or makes it for real in `repo`. */
function fakeDaemon(repo?: string) {
  const frames: Record<string, unknown>[] = [];
  const open = async (): Promise<DaemonChannel> => ({
    send: async (frame: DaemonFrame) => {
      const f = frame as unknown as Record<string, unknown>;
      frames.push(f);
      if (f["op"] === "git.checkpoint") {
        const ref = `refs/wsp/checkpoints/${String(f["scope"])}/${String(f["thread"])}/${String(f["turn"])}`;
        if (repo !== undefined) checkpointIn(repo, ref);
        return { id: 1, ok: true, ref, commit: "c", changed: true } as DaemonResponse;
      }
      if (f["op"] === "git.checkpointDrop") return { id: 1, ok: true, dropped: 0 } as DaemonResponse;
      return { id: 1, ok: false, error: `no ${String(f["op"])} here` } as DaemonResponse;
    },
    close: () => {},
    closed: new Promise(() => {}),
  });
  return { frames, open };
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
/** The folder's whole tree under the ref, its HEAD as the commit's parent, as the daemon's checkpoint takes it. */
function checkpointIn(repo: string, ref: string): void {
  const index = join(repo, ".git", "fork-test.index");
  const env = { ...GIT_ENV, GIT_INDEX_FILE: index };
  execFileSync("git", ["-C", repo, "add", "-A"], { env });
  const tree = execFileSync("git", ["-C", repo, "write-tree"], { env, encoding: "utf8" }).trim();
  rmSync(index, { force: true });
  const commit = execFileSync("git", ["-C", repo, "commit-tree", tree, "-p", "HEAD", "-m", "wsp checkpoint"], { env: GIT_ENV, encoding: "utf8" }).trim();
  git(repo, "update-ref", ref, commit);
}

let rt: Runtime | undefined;
const roots: string[] = [];
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
});
const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-fork-")));
  roots.push(root);
  return root;
};
const settle = () => new Promise(r => setTimeout(r, 20));

/** A box workspace with the claude id on the copy road and the codex id on the start road. */
async function box(o: { claude?: Parameters<typeof agent>[2]; codex?: Parameters<typeof agent>[2]; store?: Store } = {}) {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  const claude: Asked = { starts: [], forks: [], drops: [] };
  const codex: Asked = { starts: [], forks: [], drops: [] };
  const counter = { n: 0 };
  rt = createRuntime({
    backend,
    store: o.store ?? memoryStore(),
    adapters: { claude: agent("copy", claude, { counter, ...o.claude }), codex: agent("start", codex, { counter, ...o.codex }) },
    daemonToken: DAEMON_TOKEN,
    daemonChannel: fakeDaemon().open,
  });
  const ws = await createOn(rt, { golden: "snap_g", name: "pricing page" });
  backend.machines[0]!.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
  return { ws, claude, codex, backend, again: (store: Store) => createRuntime({ backend, store, adapters: { claude: agent("copy", claude, { counter, ...o.claude }) }, daemonToken: DAEMON_TOKEN, daemonChannel: fakeDaemon().open }) };
}

/** Turns teaching ALPHA, BETA and GAMMA on one thread of the agent; answers the thread and each turn's id. */
async function threeTurns(workspaceId: string, harness: string, picks: { model?: string; effort?: string } = {}, attachments?: Attachment[]): Promise<{ threadId: string; turns: string[] }> {
  const first = await rt!.sessions.start(workspaceId, { prompt: "Remember ALPHA.", harness, requestId: "req_alpha", ...picks, ...(attachments !== undefined ? { attachments } : {}) });
  await first.finished;
  const threadId = first.view().threadId!;
  const turns = [first.turnId];
  for (const word of ["BETA", "GAMMA"]) {
    const next = await rt!.sessions.start(workspaceId, { prompt: `Remember ${word}.`, thread: threadId });
    await next.finished;
    turns.push(next.turnId);
  }
  await settle();
  return { threadId, turns };
}

const threadOf = async (workspaceId: string, threadId: string) => foldThreads(await rt!.sessions.list(workspaceId)).find(t => t.threadId === threadId);
const promptsOf = (events: readonly SessionEvent[], threadId: string): string[] => events.flatMap(e => (e.threadId === threadId && e.type === "session.start" && e.prompt !== undefined ? [e.prompt] : []));
const refusalOf = async (p: Promise<unknown>): Promise<{ message: string; fix?: string; kind?: string }> => {
  const e = (await p.then(() => undefined, (x: unknown) => x)) as { message: string; fix?: string; kind?: string } | undefined;
  if (e === undefined) throw new Error("the fork was not refused");
  return e;
};

describe("a fork of a Claude Code thread at a finished turn", () => {
  it("resumes a copy of the source's session through that turn's anchor, on the source's agent, model and effort, and its next send resumes the copy", async () => {
    const { ws, claude } = await box();
    const { threadId, turns } = await threeTurns(ws.id, "claude", { model: "claude-opus-5", effort: "high" });
    const source = await threadOf(ws.id, threadId);
    const run = await rt!.sessions.fork({ prompt: "list every code word you remember", fork: { threadId, turnId: turns[1]! } });
    await run.finished;
    expect(claude.forks).toEqual([{ session: source!.claudeSessionId, turn: { anchor: "a2" } }]);
    const COPY = "c0c0c0c0-0000-4000-8000-000000000001";
    const first = claude.starts.at(-1)!;
    expect(first).toMatchObject({ prompt: "list every code word you remember", resume: COPY, model: "claude-opus-5", effort: "high" });
    expect(first).not.toHaveProperty("fork");
    const forkId = run.view().threadId!;
    expect(forkId).not.toBe(threadId);
    // The fork's second send resumes its own session, never the source's.
    await (await rt!.sessions.start(ws.id, { prompt: "and now?", thread: forkId })).finished;
    expect(claude.starts.at(-1)).toMatchObject({ resume: COPY });
    expect(claude.starts.filter(s => s.resume === source!.claudeSessionId)).toHaveLength(2);
    // A start that names another model or effort runs at it.
    const named = await rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: turns[0]! }, model: "claude-sonnet-5", effort: "low" });
    await named.finished;
    expect(claude.starts.at(-1)).toMatchObject({ model: "claude-sonnet-5", effort: "low" });
  });

  it("opens on copies of the source's events through that turn under its own thread, and says where it came from on its record and every view", async () => {
    const { ws } = await box();
    const { threadId, turns } = await threeTurns(ws.id, "claude");
    const title = (await threadOf(ws.id, threadId))!.title;
    const run = await rt!.sessions.fork({ prompt: "list every code word you remember", fork: { threadId, turnId: turns[1]! } });
    await run.finished;
    const forkId = run.view().threadId!;
    const page = await rt!.sessions.page(ws.id, { threadId: forkId });
    expect(promptsOf(page.events, forkId)).toEqual(["Remember ALPHA.", "Remember BETA.", "list every code word you remember"]);
    const copied = page.events.filter(e => copiedFromOf(e) !== undefined);
    expect(new Set(copied.map(e => e.turnId))).toEqual(new Set(turns.slice(0, 2)));
    expect(copied.every(e => e.threadId === forkId && copiedFromOf(e) === threadId)).toBe(true);
    expect(page.events.filter(e => copiedFromOf(e) === undefined).every(e => e.turnId === run.turnId)).toBe(true);
    expect(page.events.findIndex(e => copiedFromOf(e) === undefined)).toBe(copied.length);
    const from = { threadId, turnId: turns[1]!, title };
    expect(run.view()).toMatchObject({ threadId: forkId });
    expect((await rt!.sessions.list(ws.id)).find(r => r.threadId === forkId)).toMatchObject({ forkedFrom: from });
    expect(await threadOf(ws.id, forkId)).toMatchObject({ forkedFrom: from });
    expect((await threadOf(ws.id, threadId))!.forkedFrom).toBeUndefined();
    // The fork's own turns rewind; the turns it was handed do not.
    await expect(rt!.sessions.rewind(forkId, { turnId: turns[0]! })).rejects.toThrow(REWIND_COPIED_LINE);
  });

  it("leaves the source's transcript, rows, read stamp and status as they were", async () => {
    const { ws } = await box();
    const { threadId, turns } = await threeTurns(ws.id, "claude");
    await rt!.sessions.read(threadId);
    const before = { events: (await rt!.sessions.page(ws.id, { threadId })).events, rows: (await rt!.sessions.list(ws.id)).filter(r => r.threadId === threadId), thread: await threadOf(ws.id, threadId) };
    await (await rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: turns[0]! } })).finished;
    await settle();
    expect((await rt!.sessions.page(ws.id, { threadId })).events).toEqual(before.events);
    expect((await rt!.sessions.list(ws.id)).filter(r => r.threadId === threadId)).toEqual(before.rows);
    expect(await threadOf(ws.id, threadId)).toEqual(before.thread);
  });

  it("forks the latest finished turn without one named, counts --at from 1, and with 0 carries no turn at all", async () => {
    const { ws, claude } = await box();
    const { threadId, turns } = await threeTurns(ws.id, "claude");
    const latest = await rt!.sessions.fork({ prompt: "x", fork: { threadId } });
    await latest.finished;
    expect(claude.forks.at(-1)).toMatchObject({ turn: { anchor: "a3" } });
    await (await rt!.sessions.fork({ prompt: "x", fork: { threadId, at: 2 } })).finished;
    expect(claude.forks.at(-1)).toMatchObject({ turn: { anchor: "a2" } });
    const none = await rt!.sessions.fork({ prompt: "Remember ALPHA.", fork: { threadId, at: 0 } });
    await none.finished;
    expect(claude.forks).toHaveLength(2);
    expect(claude.starts.at(-1)).not.toHaveProperty("resume");
    expect((await threadOf(ws.id, none.view().threadId!))!.forkedFrom).toEqual({ threadId, title: expect.any(String) });
    const refused = await refusalOf(rt!.sessions.fork({ prompt: "x", fork: { threadId, at: 4 } }));
    expect(refused).toMatchObject({ kind: "usage" });
    expect(refused.message).toContain(forkTurnsLine(3));
    expect(turns).toHaveLength(3);
  });

  it("refuses in two halves where the session holds no such message, and leaves no thread, row, event, copy or image behind", async () => {
    const { ws, claude } = await box({ claude: { refuse: "the session holds no message a2" } });
    const { threadId, turns } = await threeTurns(ws.id, "claude", {}, [PNG]);
    const rows = (await rt!.sessions.list(ws.id)).map(r => r.id);
    const events = (await rt!.sessions.history(ws.id)).length;
    const refused = await refusalOf(rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: turns[1]! } }));
    expect(refused).toMatchObject({ fix: FORK_REFUSED_FIX, kind: "conflict" });
    expect(refused.message).toBe(`${forkRefusedLine("Claude Code", "the session holds no message a2")}. ${FORK_REFUSED_FIX}`);
    expect(claude.forks).toHaveLength(1);
    expect((await rt!.sessions.list(ws.id)).map(r => r.id)).toEqual(rows);
    expect((await rt!.sessions.history(ws.id)).length).toBe(events);
    expect(claude.starts).toHaveLength(3);
  });

  it("refuses a turn that named no anchor in the agent's words, and an agent other than the source's", async () => {
    const { ws, claude } = await box({ claude: { anchorless: [2] } });
    const { threadId, turns } = await threeTurns(ws.id, "claude");
    const refused = await refusalOf(rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: turns[1]! } }));
    expect(refused.message).toContain(forkNoAnchorLine("Claude Code"));
    expect(claude.forks).toEqual([]);
    const agentOther = await refusalOf(rt!.sessions.fork({ prompt: "x", fork: { threadId }, harness: "codex" }));
    expect(agentOther).toMatchObject({ kind: "usage" });
    expect(agentOther.message).toContain(forkAgentLine("Claude Code", "Codex"));
    expect(claude.forks).toEqual([]);
  });
});

describe("a Claude Code thread a host before copied rewinds left owing a cut", () => {
  it("resumes a copy through that cut on its next send, every row of it moved onto the copy, and owes it no more", async () => {
    const store = memoryStore();
    const { ws, claude, again } = await box({ store });
    const { threadId } = await threeTurns(ws.id, "claude");
    const session = (await threadOf(ws.id, threadId))!.claudeSessionId!;
    await rt!.close();
    // What a host from before wrote for a thread rewound to its first turn: the anchor under resumeAt.
    const doc = (await store.get(SESSIONS, ws.id)) as SessionIndexRecord;
    await store.put(SESSIONS, ws.id, { ...doc, threads: { ...doc.threads, [threadId]: { ...doc.threads![threadId]!, resumeAt: "a1" } } });
    rt = again(store);
    await (await rt.sessions.start(ws.id, { prompt: "what do you remember?", thread: threadId })).finished;
    expect(claude.forks).toEqual([{ session, turn: { anchor: "a1" } }]);
    const COPY = "c0c0c0c0-0000-4000-8000-000000000001";
    expect(claude.starts.at(-1)).toMatchObject({ resume: COPY });
    expect((await rt.sessions.list(ws.id)).filter(r => r.threadId === threadId).every(r => r.claudeSessionId === COPY)).toBe(true);
    await (await rt.sessions.start(ws.id, { prompt: "and now?", thread: threadId })).finished;
    expect(claude.forks).toHaveLength(1);
    expect(claude.starts.at(-1)).toMatchObject({ resume: COPY });
    await rt.close();
    const kept = (await store.get(SESSIONS, ws.id)) as SessionIndexRecord;
    expect(kept.threads![threadId]).not.toHaveProperty("resumeAt");
    expect(kept.threads![threadId]).not.toHaveProperty("cutOwed");
    rt = undefined;
  });
});

describe("a Claude Code thread owing a cut whose session file is gone", () => {
  it("drops the cut on the first send and resumes as before it, so the lost-session road runs, and is never refused again", async () => {
    const store = memoryStore();
    const { ws, claude, again } = await box({ store, claude: { refuse: "No conversation found with session ID: gone" } });
    const { threadId } = await threeTurns(ws.id, "claude");
    const session = (await threadOf(ws.id, threadId))!.claudeSessionId!;
    await rt!.close();
    const doc = (await store.get(SESSIONS, ws.id)) as SessionIndexRecord;
    await store.put(SESSIONS, ws.id, { ...doc, threads: { ...doc.threads, [threadId]: { ...doc.threads![threadId]!, resumeAt: "a1" } } });
    rt = again(store);
    for (const prompt of ["one", "two", "three"]) {
      const result = await (await rt.sessions.start(ws.id, { prompt, thread: threadId })).finished;
      expect(result.status).toBe("completed");
      expect(claude.starts.at(-1)).toMatchObject({ resume: session });
    }
    expect(claude.forks).toEqual([{ session, turn: { anchor: "a1" } }]);
    await rt.close();
    const kept = (await store.get(SESSIONS, ws.id)) as SessionIndexRecord;
    expect(kept.threads![threadId]).not.toHaveProperty("resumeAt");
    expect(kept.threads![threadId]).not.toHaveProperty("cutOwed");
    rt = undefined;
  });
});

describe("a fork of a Codex thread at a finished turn", () => {
  it("hands the start the turn to fork through, resuming nothing, and its next send resumes the thread the fork answered", async () => {
    const { ws, codex } = await box();
    const { threadId, turns } = await threeTurns(ws.id, "codex", { model: "gpt-5.5" });
    const source = (await threadOf(ws.id, threadId))!.claudeSessionId;
    const run = await rt!.sessions.fork({ prompt: "list every code word you remember", fork: { threadId, turnId: turns[1]! } });
    await run.finished;
    expect(codex.forks).toEqual([{ session: source, turn: { anchor: "a2" } }]);
    const start = codex.starts.at(-1)!;
    expect(start).toMatchObject({ fork: { session: source, turn: "a2" }, model: "gpt-5.5" });
    expect(start).not.toHaveProperty("resume");
    const forkId = run.view().threadId!;
    const announced = (await threadOf(ws.id, forkId))!.claudeSessionId;
    expect(announced).toMatch(/^f0f0f0f0/);
    await (await rt!.sessions.start(ws.id, { prompt: "and now?", thread: forkId })).finished;
    expect(codex.starts.at(-1)).toMatchObject({ resume: announced });
    expect(codex.starts.at(-1)).not.toHaveProperty("fork");
  });

  it("finds a turn that named no anchor by the source's turns after it, a compaction's turn among them", async () => {
    const { ws, codex } = await box({ codex: { anchorless: [1] } });
    const { threadId, turns } = await threeTurns(ws.id, "codex");
    await (await rt!.sessions.start(ws.id, { prompt: "/compact", thread: threadId })).finished;
    await settle();
    await (await rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: turns[0]! } })).finished;
    expect(codex.forks.at(-1)!.turn).toMatchObject({ after: [{ anchor: "a2" }, { anchor: "a3" }, { anchor: "a4" }] });
  });

  it("refuses in two halves a turn Codex does not list, leaving nothing behind", async () => {
    const { ws, codex } = await box({ codex: { refuse: codexNoTurnLine("a2") } });
    const { threadId, turns } = await threeTurns(ws.id, "codex");
    const rows = (await rt!.sessions.list(ws.id)).length;
    const refused = await refusalOf(rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: turns[1]! } }));
    expect(refused).toMatchObject({ message: `${forkRefusedLine("Codex", codexNoTurnLine("a2"))}. ${FORK_REFUSED_FIX}`, kind: "conflict" });
    expect((await rt!.sessions.list(ws.id)).length).toBe(rows);
    expect(codex.starts).toHaveLength(3);
  });
});

describe("a fork while its source runs", () => {
  it.each(["claude", "codex"] as const)("refuses a fork through the source's running turn before anything is written, and forks an earlier turn while it runs, on %s", async harness => {
    const made = await box({ [harness]: { hangFrom: 3 } });
    const { ws } = made;
    const asked = made[harness];
    const first = await rt!.sessions.start(ws.id, { prompt: "Remember ALPHA.", harness });
    await first.finished;
    const threadId = first.view().threadId!;
    await (await rt!.sessions.start(ws.id, { prompt: "Remember BETA.", thread: threadId })).finished;
    const running = await rt!.sessions.start(ws.id, { prompt: "Remember GAMMA.", thread: threadId });
    await settle();
    const rows = (await rt!.sessions.list(ws.id)).length;
    const refused = await refusalOf(rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: running.turnId } }));
    expect(refused).toMatchObject({ message: `${FORK_RUNNING_LINE}. ${FORK_RUNNING_FIX}`, fix: FORK_RUNNING_FIX, kind: "conflict" });
    expect(asked.forks).toEqual([]);
    expect((await rt!.sessions.list(ws.id)).length).toBe(rows);
    const earlier = await rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: first.turnId } });
    expect(asked.forks).toEqual([{ session: expect.any(String), turn: { anchor: "a1" } }]);
    expect(earlier.view().threadId).not.toBe(threadId);
    await rt!.sessions.interrupt(running.id);
  });
});

describe("what a fork's agent offers", () => {
  it("the catalog says forks off the adapter, and by count where it counts", async () => {
    const { ws } = await box();
    const listed = await rt!.harnesses.list(ws.id);
    expect(listed.find(c => c.harness === "claude")).toMatchObject({ forks: true });
    expect(listed.find(c => c.harness === "claude")!.forksByCount).toBeUndefined();
    expect(listed.find(c => c.harness === "codex")).toMatchObject({ forks: true, forksByCount: true });
  });
});

/** A host on this computer over a git project, its agent on the copy road, its daemon checkpointing the repo for real. */
async function here(o: Parameters<typeof agent>[2] = {}) {
  const root = scratch();
  const repo = join(root, "acme");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const copier = gitCopier();
  const asked: Asked = { starts: [], forks: [], drops: [] };
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier,
    daemonRoad: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }),
  };
  rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: agent("copy", asked, o) }, local, statePath: join(state, "state.json"), daemonChannel: fakeDaemon(repo).open });
  const project = await rt.projects.add({ source: repo });
  const at = await rt.workspaces.folderFor({ project: project.id });
  return { repo, copier, asked, ws: at.workspace, state };
}

describe("a fork onto a new branch", () => {
  it("makes a worktree at the turn's checkpoint, a child record of the source's folder, and launches the fork there", async () => {
    const { repo, copier, asked, ws } = await here();
    const first = await rt!.sessions.start(ws.id, { prompt: "edit A" });
    writeFileSync(join(repo, "a.txt"), "A edited\n");
    await first.finished;
    await settle();
    const threadId = first.view().threadId!;
    const turnOne = (await rt!.sessions.history(ws.id)).find(e => e.type === "session.checkpoint" && e.turnId === first.turnId) as { ref: string };
    const run = await rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: first.turnId }, branch: "main-fork" });
    await run.finished;
    expect(copier.worktrees).toMatchObject([{ branch: "main-fork", checkpoint: turnOne.ref }]);
    const made = (await rt!.workspaces.list()).find(w => w.worktree?.branch === "main-fork")!;
    expect(made.parentWorkspaceId).toBe(ws.id);
    expect(run.view().workspaceId).toBe(made.id);
    expect(asked.starts.at(-1)).toMatchObject({ cwd: made.worktree!.path, resume: "c0c0c0c0-0000-4000-8000-000000000001" });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("A edited\n");
  });

  it("refuses in two halves a turn whose checkpoint is gone by the send, and makes no worktree, thread or row", async () => {
    const { repo, copier, asked, ws } = await here();
    const first = await rt!.sessions.start(ws.id, { prompt: "edit A" });
    await first.finished;
    await settle();
    const threadId = first.view().threadId!;
    const turnOne = (await rt!.sessions.history(ws.id)).find(e => e.type === "session.checkpoint" && e.turnId === first.turnId) as { ref: string };
    git(repo, "update-ref", "-d", turnOne.ref);
    const rows = (await rt!.sessions.list(ws.id)).length;
    const refused = await refusalOf(rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: first.turnId }, branch: "main-fork" }));
    expect(refused).toMatchObject({ message: `${FORK_NO_CHECKPOINT_LINE}. ${FORK_NO_CHECKPOINT_FIX}`, fix: FORK_NO_CHECKPOINT_FIX, kind: "conflict" });
    expect(copier.worktrees).toEqual([]);
    expect(asked.forks).toEqual([]);
    expect((await rt!.sessions.list(ws.id)).length).toBe(rows);
    expect(git(repo, "branch", "--list", "main-fork")).toBe("");
  });

  it("takes the worktree and its branch away again where the agent then refuses, leaving no thread", async () => {
    const { repo, copier, asked, ws } = await here({ refuse: "the session holds no message a1" });
    const first = await rt!.sessions.start(ws.id, { prompt: "edit A" });
    await first.finished;
    await settle();
    const threadId = first.view().threadId!;
    const records = (await rt!.workspaces.list()).length;
    const refused = await refusalOf(rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: first.turnId }, branch: "main-fork" }));
    expect(refused).toMatchObject({ fix: FORK_REFUSED_FIX, kind: "conflict" });
    expect(asked.forks).toHaveLength(1);
    expect(copier.worktrees).toHaveLength(1);
    expect(copier.worktreesRemoved).toHaveLength(1);
    expect(git(repo, "branch", "--list", "main-fork")).toBe("");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect((await rt!.workspaces.list()).length).toBe(records);
    expect(foldThreads(await rt!.sessions.list()).map(t => t.threadId)).toEqual([threadId]);
  });

  it("keeps an image of the copied history openable in the fork after the source is deleted", async () => {
    const { ws } = await here();
    const first = await rt!.sessions.start(ws.id, { prompt: "what is this?", requestId: "req_png", attachments: [PNG] });
    await first.finished;
    await settle();
    const threadId = first.view().threadId!;
    const run = await rt!.sessions.fork({ prompt: "x", fork: { threadId, turnId: first.turnId } });
    await run.finished;
    const forkId = run.view().threadId!;
    await rt!.sessions.delete(threadId);
    expect(await rt!.sessions.attachment(ws.id, forkId, "req_png", 0)).toEqual({ mediaType: PNG.mediaType, bytes: PNG.bytes });
    await expect(rt!.sessions.attachment(ws.id, threadId, "req_png", 0)).rejects.toMatchObject({ kind: "not-found" });
    // The source gone, the fork names the title it had at the fork.
    expect((await threadOf(ws.id, forkId))!.forkedFrom).toEqual({ threadId, turnId: first.turnId, title: "what is this?" });
  });
});

describe("a fork's start beside what its source decides", () => {
  it("is refused as usage beside a thread or a restart", async () => {
    const { ws } = await box();
    const { threadId } = await threeTurns(ws.id, "claude");
    const refused = await refusalOf(rt!.sessions.start(ws.id, { prompt: "x", fork: { threadId }, thread: threadId }));
    expect(refused).toMatchObject({ fix: FORK_BESIDE_FIX, kind: "usage" });
  });
});
