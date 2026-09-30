// SPDX-License-Identifier: AGPL-3.0-only
// The Changes pane's host half: the checkout fact read through the copy's own daemon at a turn's end, on view and
// after a write and never on a timer; a discard and a commit sent down that same road; a commit message drafted by
// the workspace's own agent with no thread; and the viewed marks kept on the workspace's record.
import { afterEach, describe, expect, it } from "vitest";
import { agentsOffRefusal, cleanCheckoutLine, DRAFT_NOTES, type AdapterEvent, type Caller, type DaemonFrame, type DaemonResponse, type EventUnion, type TurnResult } from "@wsp/protocol";
import { CHECKOUT_TTL_MS, createRuntime, type HarnessAdapter, type HarnessAdapterFactory, type Runtime } from "../src/runtime.js";
import type { DaemonChannel, DaemonChannelOptions } from "../src/daemon-channel.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { createOn, projectOn, stubBackend, tokenGuest, type StubBackend } from "./stub-backend.js";
import { until } from "./until.js";

const DAEMON_TOKEN = "cafef00d".repeat(3);
const SESSION = "44444444-4444-4444-8444-444444444444";
/** The copy's checkout on the stub's machine, whose number counts up across the file. */
const CWD = expect.stringMatching(/^\/root\/stub-\d+$/);

const BRANCH = { oid: "abc", head: "fix/cart", upstream: "origin/fix/cart", ahead: 1, behind: 0 };
const STATUS: DaemonResponse = {
  id: 1,
  ok: true,
  branch: BRANCH,
  entries: [
    { xy: ".M", path: "a.ts" },
    { xy: "??", path: "b.ts" },
    { xy: "!!", path: "x.log" },
  ],
  root: "/root/stub",
};

/** A daemon that records every frame and answers each op the way one on a machine would. */
function fakeDaemon(answers: Partial<Record<string, (frame: Record<string, unknown>) => DaemonResponse>> = {}) {
  const frames: Record<string, unknown>[] = [];
  const all: Record<string, (frame: Record<string, unknown>) => DaemonResponse> = {
    "git.status": () => STATUS,
    "git.discard": f => ({ id: 1, ok: true, path: String(f["path"]) }),
    "git.commit": () => ({ id: 1, ok: true, oid: "5f1c0e2b9a7d4c3e8f6a1b2c3d4e5f60718293a4", subject: "Round the cart total once", filesChanged: 2, insertions: 10, deletions: 4 }),
    "git.diff": () => ({ id: 1, ok: true, base: null, files: [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0, patch: "diff --git a/a.ts b/a.ts\n+one\n" }], truncated: false }),
    ...answers,
  } as Record<string, (frame: Record<string, unknown>) => DaemonResponse>;
  return {
    frames,
    open: async (_o: DaemonChannelOptions): Promise<DaemonChannel> => ({
      send: async (frame: DaemonFrame) => {
        const held = frame as unknown as Record<string, unknown>;
        frames.push(held);
        return all[String(held["op"])]!(held);
      },
      close: () => {},
      closed: new Promise(() => {}),
    }),
  };
}

/** An adapter whose turn runs to its end on its own, and which drafts with one line to the machine naming the file
 * its question is in. */
function drafting(o: { asked?: { promptFile: string; model?: string }[]; answer?: string } = {}): HarnessAdapterFactory {
  const draftFor: HarnessAdapter["draftFor"] = (ask, exec) => {
    o.asked?.push(ask);
    return exec(`wsp-draft ${ask.promptFile}`).then(() => o.answer ?? "Round the cart total once\n\nThe total rounded per line.");
  };
  return () => ({
    steers: false,
    draftFor,
    start: s => {
      const result: TurnResult = { status: "completed", text: "ok" };
      const emit = (e: AdapterEvent): void => s.onEvent(e);
      const finished = (async () => {
        emit({ type: "session.start", sessionId: SESSION });
        emit({ type: "turn.done", sessionId: SESSION, result });
        emit({ type: "session.end", sessionId: SESSION, exitCode: 0, sawResult: true });
        return result;
      })();
      return { localId: SESSION, finished, interrupt: async () => {} };
    },
  });
}

let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

async function withWorkspace(
  daemon: ReturnType<typeof fakeDaemon>,
  o: { adapters?: Record<string, HarnessAdapterFactory>; store?: Store; clock?: ReturnType<typeof fakeClock>["clock"]; agents?: boolean } = {},
): Promise<{ backend: StubBackend; id: string; name: string }> {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  rt = createRuntime({
    backend,
    store: o.store ?? memoryStore(),
    adapters: o.adapters ?? {},
    daemonToken: DAEMON_TOKEN,
    daemonChannel: daemon.open,
    ...(o.clock !== undefined ? { clock: o.clock } : {}),
  });
  const project = await projectOn(rt, undefined, undefined, { base: "main" });
  const ws = await createOn(rt, { project: project.id, golden: "snap_g", name: "cart", ...(o.agents === true ? { agents: { spawn: true, maxMachines: 2, maxDepth: 2 } } : o.agents === false ? { agents: { spawn: false } } : {}) });
  backend.machines[0]!.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
  return { backend, id: ws.id, name: ws.name };
}

const statuses = (runtime: Runtime): EventUnion[] => {
  const seen: EventUnion[] = [];
  runtime.events.on("*", e => {
    if (e.type === "workspace.status") seen.push(e);
  });
  return seen;
};

describe("the checkout fact", () => {
  it("is read through the copy's daemon when asked, rides the workspace's status, and is asked again only past its window", async () => {
    const daemon = fakeDaemon();
    const { clock, advance } = fakeClock();
    const { id } = await withWorkspace(daemon, { clock });
    const seen = statuses(rt!);
    const got = await rt!.workspaces.checkout(id);
    expect(got.checkout).toEqual({ branch: "fix/cart", ahead: 1, behind: 0, changed: 2, readAt: expect.any(Number) });
    // The pull request's read rides the same ask and is its own file's subject; this one is the branch line's.
    const reads = (): Record<string, unknown>[] => daemon.frames.filter(f => f["op"] === "git.status");
    expect(reads()).toEqual([{ op: "git.status", cwd: CWD }]);
    expect(seen.some(e => e.type === "workspace.status" && e.status.checkout?.branch === "fix/cart")).toBe(true);
    await rt!.workspaces.checkout(id);
    expect(reads()).toHaveLength(1);
    advance(CHECKOUT_TTL_MS + 1);
    await rt!.workspaces.checkout(id);
    expect(reads()).toHaveLength(2);
  });

  it("carries a stopped copy's unread edits and unknown counts as the daemon said them", async () => {
    const daemon = fakeDaemon({ "git.status": () => ({ ...STATUS, entries: [], editsUnread: true, countsUnknown: true }) });
    const { id } = await withWorkspace(daemon);
    expect((await rt!.workspaces.checkout(id)).checkout).toMatchObject({ changed: 0, editsUnread: true, countsUnknown: true });
  });

  it("carries the commit the head is on, and none where git has no commit yet", async () => {
    const oid = "0123456789abcdef0123456789abcdef01234567";
    const daemon = fakeDaemon({ "git.status": () => ({ ...STATUS, branch: { ...BRANCH, head: "(detached)", oid } }) });
    const { id } = await withWorkspace(daemon);
    expect((await rt!.workspaces.checkout(id)).checkout).toMatchObject({ branch: "(detached)", head: oid });
    const fresh = fakeDaemon({ "git.status": () => ({ ...STATUS, branch: { ...BRANCH, oid: "(initial)" } }) });
    const { id: freshId } = await withWorkspace(fresh);
    expect((await rt!.workspaces.checkout(freshId)).checkout).not.toHaveProperty("head");
  });

  it("is read again when a turn ends, and never on a timer", async () => {
    const daemon = fakeDaemon();
    const { clock, advance } = fakeClock();
    const { id } = await withWorkspace(daemon, { adapters: { claude: drafting() }, clock });
    await (await rt!.sessions.start(id, { prompt: "fix the cart" })).finished;
    const reads = (): Record<string, unknown>[] => daemon.frames.filter(f => f["op"] === "git.status");
    await until(async () => reads().length > 0);
    const read = reads().length;
    advance(10 * CHECKOUT_TTL_MS);
    await new Promise(r => setTimeout(r, 20));
    expect(reads()).toHaveLength(read);
  });

  it("keeps the last fact while the machine naps and asks nothing of it", async () => {
    const daemon = fakeDaemon();
    const { clock, advance } = fakeClock();
    const { id } = await withWorkspace(daemon, { clock });
    const first = (await rt!.workspaces.checkout(id)).checkout;
    await rt!.workspaces.nap(id);
    advance(CHECKOUT_TTL_MS + 1);
    expect((await rt!.workspaces.checkout(id)).checkout).toEqual(first);
    expect(daemon.frames.filter(f => f["op"] === "git.status")).toHaveLength(1);
  });
});

describe("a discard and a commit", () => {
  it("discards one file down the copy's daemon, then reads the checkout again", async () => {
    const daemon = fakeDaemon();
    const { id } = await withWorkspace(daemon);
    expect(await rt!.workspaces.discard({ workspaceId: id, path: "a*b.ts" })).toEqual({ path: "a*b.ts" });
    expect(daemon.frames).toEqual([
      { op: "git.discard", cwd: CWD, path: "a*b.ts" },
      { op: "git.status", cwd: CWD },
    ]);
  });

  it("commits the files named with the message, then reads the checkout again", async () => {
    const daemon = fakeDaemon();
    const { id } = await withWorkspace(daemon);
    const made = await rt!.workspaces.commit({ workspaceId: id, message: "Round the cart total once\n\nWhy.", paths: ["a.ts", "b.ts"] });
    expect(made).toEqual({ oid: "5f1c0e2b9a7d4c3e8f6a1b2c3d4e5f60718293a4", subject: "Round the cart total once", filesChanged: 2, insertions: 10, deletions: 4 });
    expect(daemon.frames).toEqual([
      { op: "git.commit", cwd: CWD, message: "Round the cart total once\n\nWhy.", paths: ["a.ts", "b.ts"] },
      { op: "git.status", cwd: CWD },
    ]);
  });

  it("commits every changed file where none is named, as the head diff lists them", async () => {
    const daemon = fakeDaemon();
    const { id } = await withWorkspace(daemon);
    await rt!.workspaces.commit({ workspaceId: id, message: "m" });
    expect(daemon.frames.slice(0, 2)).toEqual([
      { op: "git.diff", cwd: CWD, scope: "head" },
      { op: "git.commit", cwd: CWD, message: "m", paths: ["a.ts"] },
    ]);
  });

  it("says a clean checkout has nothing to commit, rather than that no file was named", async () => {
    const daemon = fakeDaemon({ "git.diff": () => ({ id: 1, ok: true, base: null, files: [], truncated: false }) });
    const { id, name } = await withWorkspace(daemon);
    await expect(rt!.workspaces.commit({ workspaceId: id, message: "m" })).rejects.toThrow(cleanCheckoutLine(name));
    expect(daemon.frames.map(f => f["op"])).toEqual(["git.diff"]);
  });

  it("is refused to a thread whose workspace lets its agents do nothing, by the act's own word", async () => {
    const daemon = fakeDaemon();
    const { id, name } = await withWorkspace(daemon, { agents: false });
    const thread: Caller = { origin: "here", by: { kind: "thread", threadId: "thr_1", workspaceId: id, rootThreadId: "thr_1" } };
    await expect(rt!.workspaces.commit({ workspaceId: id, message: "m", paths: ["a.ts"] }, thread)).rejects.toThrow(agentsOffRefusal(name, "commit"));
    // The draft is the commit's first half and runs the agent's command line, so it is held by the same word.
    await expect(rt!.workspaces.commitDraft({ workspaceId: id, paths: ["a.ts"] }, thread)).rejects.toThrow(agentsOffRefusal(name, "commit"));
    expect(daemon.frames).toEqual([]);
  });
});

describe("a drafted commit message", () => {
  it("is asked of the workspace's newest thread's agent from the head diff of the files named and the thread's task, and the question's file goes after", async () => {
    const daemon = fakeDaemon();
    const asked: { promptFile: string; model?: string }[] = [];
    const { backend, id } = await withWorkspace(daemon, { adapters: { claude: drafting({ asked }) } });
    await (await rt!.sessions.start(id, { prompt: "Fix the flaky cart test" })).finished;
    const drafted = await rt!.workspaces.commitDraft({ workspaceId: id, paths: ["a.ts"] });
    expect(drafted).toEqual({ message: "Round the cart total once\n\nThe total rounded per line." });
    expect(daemon.frames.filter(f => f["op"] === "git.diff")).toEqual([{ op: "git.diff", cwd: CWD, scope: "head", paths: ["a.ts"] }]);
    const file = asked[0]!.promptFile;
    const log = backend.machines[0]!.execLog;
    const upload = log.find(cmd => cmd.includes(file) && cmd.includes("base64 -d"))!;
    const question = Buffer.from(/printf %s '([^']+)'/.exec(upload)![1]!, "base64").toString("utf8");
    expect(question).toContain("+one");
    expect(question).toContain("The task the agent was given:\nFix the flaky cart test");
    expect(log.some(cmd => cmd === `wsp-draft ${file}`)).toBe(true);
    expect(log.findIndex(cmd => cmd.includes("rm -f") && cmd.includes(file))).toBeGreaterThan(log.indexOf(`wsp-draft ${file}`));
  });

  it("is none with the line saying why where no agent here drafts, or where nothing is named", async () => {
    const daemon = fakeDaemon();
    const { id } = await withWorkspace(daemon);
    expect(await rt!.workspaces.commitDraft({ workspaceId: id, paths: ["a.ts"] })).toEqual({ message: null, note: DRAFT_NOTES.noAgent });
    expect(await rt!.workspaces.commitDraft({ workspaceId: id, paths: [] })).toEqual({ message: null, note: DRAFT_NOTES.nothing });
  });
});

describe("the viewed marks", () => {
  it("are kept by path against the blob, said to every window, and outlive the host", async () => {
    const daemon = fakeDaemon();
    const store = memoryStore();
    const { backend, id } = await withWorkspace(daemon, { store });
    const said: EventUnion[] = [];
    rt!.events.on("*", e => {
      if (e.type === "workspace.viewed") said.push(e);
    });
    expect(await rt!.workspaces.viewed({ workspaceId: id, path: "a.ts", blob: "b1" })).toEqual({ viewed: { "a.ts": "b1" } });
    expect(await rt!.workspaces.viewed({ workspaceId: id, path: "b.ts", blob: "b2" })).toEqual({ viewed: { "a.ts": "b1", "b.ts": "b2" } });
    expect(await rt!.workspaces.viewed({ workspaceId: id, path: "b.ts", blob: null })).toEqual({ viewed: { "a.ts": "b1" } });
    expect(said.at(-1)).toMatchObject({ type: "workspace.viewed", workspaceId: id, viewed: { "a.ts": "b1" } });
    await rt!.close();
    rt = createRuntime({ backend, store, adapters: {}, daemonToken: DAEMON_TOKEN, daemonChannel: daemon.open });
    expect(await rt.workspaces.viewed({ workspaceId: id })).toEqual({ viewed: { "a.ts": "b1" } });
  });

  it("go with the workspace", async () => {
    const daemon = fakeDaemon();
    const store = memoryStore();
    const { id } = await withWorkspace(daemon, { store });
    await rt!.workspaces.viewed({ workspaceId: id, path: "a.ts", blob: "b1" });
    await rt!.workspaces.delete(id);
    const kept = (await store.get("sessions", id)) as { viewed?: unknown } | undefined;
    expect(kept?.viewed).toBeUndefined();
  });
});
