// SPDX-License-Identifier: AGPL-3.0-only
// A checkpoint at every turn's end and a rewind to one: the frames the runtime
// sends the workspace's own daemon, what it keeps of each turn, what a rewind
// cuts and in what order, and every refusal made before anything is written.
// The daemon and the harnesses are fakes, so the runtime's own reading is
// what is under test.
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_LEGACY_HISTORY,
  DEVICE_OPS,
  REWIND_LATEST_LINE,
  REWIND_NO_CHECKPOINT_LINE,
  REWIND_NO_UNDO_LINE,
  REWIND_SHARED_LINE,
  REWIND_WORKING_LINE,
  THREAD_OPS,
  foldThreads,
  rewindBesideLine,
  rewindChildrenLine,
  rewindKeptLine,
  type AdapterEvent,
  type Caller,
  type DaemonFrame,
  type DaemonResponse,
  type EventUnion,
  type SessionReverter,
  type TurnResult,
} from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type Runtime } from "../src/runtime.js";
import type { DaemonChannel, DaemonChannelOptions } from "../src/daemon-channel.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend, tokenGuest } from "./stub-backend.js";

const FIRST_SESSION = "44444444-4444-4444-8444-444444444444";
const DAEMON_TOKEN = "cafef00d".repeat(3);

/** A daemon that answers each checkpoint with a ref of the turn it names and records every frame. */
function fakeDaemon(o: { refuseCheckpoint?: boolean } = {}) {
  const frames: Record<string, unknown>[] = [];
  let seen: string | undefined;
  /** The folder the first checkpoint was asked at: the stub names each checkout it makes by a count of its own. */
  const checkout = (): string => seen ?? "";
  const open = async (_: DaemonChannelOptions): Promise<DaemonChannel> => ({
    send: async (frame: DaemonFrame) => {
      const f = frame as unknown as Record<string, unknown>;
      frames.push(f);
      if (f["op"] === "git.checkpoint") {
        seen ??= String(f["cwd"]);
        if (o.refuseCheckpoint === true) return { id: 1, ok: false, code: "not-a-git-repo", error: "not inside a git repository" } as DaemonResponse;
        return { id: 1, ok: true, ref: `refs/wsp/checkpoints/stub-1/${String(f["thread"])}/${String(f["turn"])}`, commit: `c-${String(f["turn"])}`, changed: true } as DaemonResponse;
      }
      if (f["op"] === "git.restore") return { id: 1, ok: true, before: `${String(f["checkpoint"])}-before-1`, files: 2 } as DaemonResponse;
      return { id: 1, ok: false, error: `no ${String(f["op"])} here` } as DaemonResponse;
    },
    close: () => {},
    closed: new Promise(() => {}),
  });
  return { frames, open, checkout };
}

/** A harness whose every turn announces one session, names its end `a<n>`, says `reply <n>` and replies at once.
 * cuts: "next" takes the cut on its next resume (Claude Code), "revert" cuts at once (Codex), "none" keeps its own. */
function harness(o: {
  cuts: "next" | "revert" | "none";
  reverted?: Parameters<SessionReverter>[0][];
  revertFails?: boolean;
  /** What the harness answers a revert with where it keeps the conversation whole. */
  revertKeeps?: string;
  /** Turns that name no anchor, as a Codex turn from before wsp kept one did; with anchorsFrom, only the turns before
   * that number. */
  anchorless?: boolean;
  anchorsFrom?: number;
  /** Why the harness cannot cut this thread's conversation, said with every anchor, as Codex says it of a legacy thread. */
  keeps?: string;
  /** Turns ended this way instead of completed, by their number. */
  ends?: Record<number, TurnResult>;
  starts?: HarnessStartOptions[];
  hangFrom?: number;
}): HarnessAdapterFactory {
  let turns = 0;
  return () => ({
    steers: false,
    ...(o.cuts === "next" ? { resumesAt: true as const } : {}),
    ...(o.cuts === "revert"
      ? {
          revert: async (r: Parameters<SessionReverter>[0]) => {
            o.reverted?.push(r);
            if (o.revertFails === true) throw new Error(`codex would not cut the thread: timed out shutting down thread ${FIRST_SESSION} before revert`);
            return o.revertKeeps !== undefined ? { kept: o.revertKeeps } : undefined;
          },
        }
      : {}),
    start: (s: HarnessStartOptions) => {
      turns += 1;
      const n = turns;
      // A fresh session per thread, as a harness mints one, and the same one again on its resume.
      const SESSION = s.resume ?? (n === 1 ? FIRST_SESSION : `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`);
      o.starts?.push(s);
      const emit = (e: AdapterEvent): void => s.onEvent(e);
      if (o.hangFrom !== undefined && n >= o.hangFrom) {
        let stop: (r: TurnResult) => void = () => {};
        const finished = new Promise<TurnResult>(resolve => (stop = resolve));
        void Promise.resolve().then(() => emit({ type: "session.start", sessionId: SESSION }));
        return {
          localId: SESSION,
          finished,
          interrupt: async () => {
            emit({ type: "turn.done", sessionId: SESSION, result: { status: "interrupted" } });
            emit({ type: "session.end", sessionId: SESSION, exitCode: null, sawResult: false });
            stop({ status: "interrupted" });
          },
        };
      }
      const result: TurnResult = o.ends?.[n] ?? { status: "completed", text: `reply ${n}` };
      const finished = Promise.resolve().then(() => {
        emit({ type: "session.start", sessionId: SESSION });
        emit({ type: "turn.delta", sessionId: SESSION, kind: "text", text: `reply ${n}` });
        if (o.anchorless !== true || (o.anchorsFrom !== undefined && n >= o.anchorsFrom)) emit({ type: "turn.anchor", sessionId: SESSION, anchor: `a${n}`, ...(o.keeps !== undefined ? { kept: o.keeps } : {}) });
        emit({ type: "turn.done", sessionId: SESSION, result });
        emit({ type: "session.end", sessionId: SESSION, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: SESSION, finished, interrupt: async () => {} };
    },
  });
}

let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

/** A cloud workspace whose daemon answers, as a fork on a box does, with one harness under the claude id. */
async function workspace(adapter: HarnessAdapterFactory, daemon = fakeDaemon()) {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: adapter }, daemonToken: DAEMON_TOKEN, daemonChannel: daemon.open });
  const ws = await createOn(rt, { golden: "snap_g", name: "pricing page", agents: { spawn: true, maxMachines: 2, maxDepth: 2 } });
  backend.machines[0]!.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
  const events: EventUnion[] = [];
  rt.events.on("*", e => events.push(e as EventUnion));
  return { ws, daemon, events };
}

/** Three finished turns on one thread; answers the thread id and each turn's id in order. */
async function threeTurns(workspaceId: string): Promise<{ threadId: string; turns: string[] }> {
  const first = await rt!.sessions.start(workspaceId, { prompt: "one" });
  await first.finished;
  const threadId = first.view().threadId!;
  const turns = [first.turnId];
  for (const prompt of ["two", "three"]) {
    const next = await rt!.sessions.start(workspaceId, { prompt, thread: threadId });
    await next.finished;
    turns.push(next.turnId);
  }
  await settle();
  return { threadId, turns };
}

/** The checkpoint is asked after the turn is over and off its road, so a case waits for it to land. */
const settle = () => new Promise(r => setTimeout(r, 20));

const texts = async (workspaceId: string) => (await rt!.sessions.history(workspaceId)).flatMap(e => (e.type === "session.delta" ? [e.text] : []));

describe("a checkpoint at every turn's end", () => {
  it("asks the workspace's daemon for one at the checkout, named by the record, the thread and the turn, and keeps it with the anchor", async () => {
    const { ws, daemon } = await workspace(harness({ cuts: "next" }));
    const run = await rt!.sessions.start(ws.id, { prompt: "one" });
    await run.finished;
    await settle();
    const threadId = run.view().threadId!;
    expect(daemon.frames.filter(f => f["op"] === "git.checkpoint")).toEqual([{ op: "git.checkpoint", cwd: daemon.checkout(), thread: threadId, turn: run.turnId, scope: ws.id }]);
    const kept = (await rt!.sessions.history(ws.id)).filter(e => e.type === "session.checkpoint");
    expect(kept).toMatchObject([{ type: "session.checkpoint", turnId: run.turnId, threadId, ref: `refs/wsp/checkpoints/stub-1/${threadId}/${run.turnId}`, anchor: "a1" }]);
  });

  it("a checkout that takes none leaves the turn as it ended and keeps the anchor alone", async () => {
    const { ws } = await workspace(harness({ cuts: "next" }), fakeDaemon({ refuseCheckpoint: true }));
    const run = await rt!.sessions.start(ws.id, { prompt: "one" });
    expect((await run.finished).status).toBe("completed");
    await settle();
    expect(run.view().status).toBe("completed");
    const kept = (await rt!.sessions.history(ws.id)).filter(e => e.type === "session.checkpoint");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ anchor: "a1" });
    expect(kept[0]).not.toHaveProperty("ref");
  });
});

describe("rewinding a thread to one of its replies", () => {
  it("puts the files back, cuts the turns after it from the transcript, says so, and cuts the conversation on the next resume", async () => {
    const starts: HarnessStartOptions[] = [];
    const { ws, daemon, events } = await workspace(harness({ cuts: "next", starts }));
    const { threadId, turns } = await threeTurns(ws.id);
    daemon.frames.length = 0;

    const done = await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true });
    expect(done).toEqual({ turns: 2, files: 2 });
    expect(daemon.frames).toEqual([{ op: "git.restore", cwd: daemon.checkout(), checkpoint: `refs/wsp/checkpoints/stub-1/${threadId}/${turns[0]}`, scope: ws.id }]);
    expect(await texts(ws.id)).toEqual(["reply 1"]);
    expect((await rt!.sessions.history(ws.id)).every(e => e.turnId === turns[0])).toBe(true);
    expect(events.filter(e => e.type === "thread.rewound")).toMatchObject([{ type: "thread.rewound", workspaceId: ws.id, threadId }]);
    expect(foldThreads(await rt!.sessions.list(ws.id)).find(t => t.threadId === threadId)?.rewoundAt).toEqual(expect.any(Number));

    // The cut rides the next resume, at the kept turn's own end, and only that one.
    await (await rt!.sessions.start(ws.id, { prompt: "four", thread: threadId })).finished;
    await (await rt!.sessions.start(ws.id, { prompt: "five", thread: threadId })).finished;
    expect(starts.map(s => s.resumeAt)).toEqual([undefined, undefined, undefined, "a1", undefined]);
    await settle();
    // Undo lasts until the turn after the rewind ends.
    expect(foldThreads(await rt!.sessions.list(ws.id)).find(t => t.threadId === threadId)?.rewoundAt).toBeUndefined();
  });

  it("with the conversation alone leaves the files where they are", async () => {
    const { ws, daemon } = await workspace(harness({ cuts: "next" }));
    const { threadId, turns } = await threeTurns(ws.id);
    daemon.frames.length = 0;
    expect(await rt!.sessions.rewind(threadId, { turnId: turns[1]!, files: false })).toEqual({ turns: 1 });
    expect(daemon.frames).toEqual([]);
    expect(await texts(ws.id)).toEqual(["reply 1", "reply 2"]);
    expect(foldThreads(await rt!.sessions.list(ws.id)).find(t => t.threadId === threadId)?.rewoundAt).toBeUndefined();
  });

  it("cuts a harness that reverts at once before the first turn it drops, after the files", async () => {
    const reverted: Parameters<SessionReverter>[0][] = [];
    const { ws, daemon } = await workspace(harness({ cuts: "revert", reverted }));
    const { threadId, turns } = await threeTurns(ws.id);
    daemon.frames.length = 0;
    await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true });
    expect(reverted).toEqual([{ session: FIRST_SESSION, beforeTurn: "a2", cwd: daemon.checkout() }]);
    expect(daemon.frames.map(f => f["op"])).toEqual(["git.restore"]);
  });

  it("refused whole when the harness will not cut: the files go back to how they stood and the transcript keeps every turn", async () => {
    const { ws, daemon } = await workspace(harness({ cuts: "revert", reverted: [], revertFails: true }));
    const { threadId, turns } = await threeTurns(ws.id);
    daemon.frames.length = 0;
    await expect(rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true })).rejects.toThrow(`codex would not cut the thread: timed out shutting down thread ${FIRST_SESSION} before revert`);
    expect(daemon.frames).toEqual([
      { op: "git.restore", cwd: daemon.checkout(), checkpoint: `refs/wsp/checkpoints/stub-1/${threadId}/${turns[0]}`, scope: ws.id },
      { op: "git.restore", cwd: daemon.checkout(), checkpoint: `refs/wsp/checkpoints/stub-1/${threadId}/${turns[0]}-before-1`, scope: ws.id },
    ]);
    expect(await texts(ws.id)).toEqual(["reply 1", "reply 2", "reply 3"]);
  });

  it("a harness whose turns named no anchor is handed how each cut turn ended, and the transcript is cut", async () => {
    const reverted: Parameters<SessionReverter>[0][] = [];
    const refused: TurnResult = { status: "failed", error: "Codex is not signed in where this workspace runs", refusal: "sign-in" };
    const { ws, daemon } = await workspace(harness({ cuts: "revert", reverted, anchorless: true, ends: { 2: refused } }));
    const { threadId, turns } = await threeTurns(ws.id);
    expect(await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true })).toEqual({ turns: 2, files: 2 });
    expect(reverted).toEqual([{ session: FIRST_SESSION, cwd: daemon.checkout(), turns: [{ result: refused }, { result: { status: "completed", text: "reply 3" } }] }]);
    expect(await texts(ws.id)).toEqual(["reply 1"]);
  });

  it("hands the harness each cut turn's anchor beside its end where the turn kept one", async () => {
    const reverted: Parameters<SessionReverter>[0][] = [];
    const { ws, daemon } = await workspace(harness({ cuts: "revert", reverted, anchorless: true, anchorsFrom: 3 }));
    const { threadId, turns } = await threeTurns(ws.id);
    await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: false });
    expect(reverted).toEqual([{ session: FIRST_SESSION, cwd: daemon.checkout(), turns: [{ result: { status: "completed", text: "reply 2" } }, { anchor: "a3", result: { status: "completed", text: "reply 3" } }] }]);
  });

  it("a harness that keeps a thread's conversation whole leaves the files back with Undo, keeps every turn, and says why", async () => {
    const { ws, daemon } = await workspace(harness({ cuts: "revert", reverted: [], revertKeeps: CODEX_LEGACY_HISTORY }));
    const { threadId, turns } = await threeTurns(ws.id);
    daemon.frames.length = 0;
    await expect(rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true })).rejects.toThrow(rewindKeptLine(CODEX_LEGACY_HISTORY, true));
    expect(rewindKeptLine(CODEX_LEGACY_HISTORY, true)).toBe("a Codex older than 0.151.0 made this thread and keeps its history in a form thread/revert cannot cut; the files went back and every turn stays");
    expect(daemon.frames.map(f => f["op"])).toEqual(["git.restore"]);
    expect(await texts(ws.id)).toEqual(["reply 1", "reply 2", "reply 3"]);
    expect(foldThreads(await rt!.sessions.list(ws.id)).find(t => t.threadId === threadId)?.rewoundAt).toEqual(expect.any(Number));
    expect(await rt!.sessions.rewind(threadId, { undo: true })).toEqual({ turns: 0, files: 2 });

    await expect(rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: false })).rejects.toThrow(rewindKeptLine(CODEX_LEGACY_HISTORY, false));
    expect(await texts(ws.id)).toEqual(["reply 1", "reply 2", "reply 3"]);
  });

  it("a thread the harness said it cannot cut is rewound in its files alone without asking the harness, and the conversation alone is refused in its words", async () => {
    const reverted: Parameters<SessionReverter>[0][] = [];
    const { ws, daemon } = await workspace(harness({ cuts: "revert", reverted, keeps: CODEX_LEGACY_HISTORY }));
    const { threadId, turns } = await threeTurns(ws.id);
    const kept = (await rt!.sessions.history(ws.id)).filter(e => e.type === "session.checkpoint");
    expect(kept.map(e => e.kept)).toEqual([CODEX_LEGACY_HISTORY, CODEX_LEGACY_HISTORY, CODEX_LEGACY_HISTORY]);
    daemon.frames.length = 0;
    await expect(rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: false })).rejects.toThrow(rewindKeptLine(CODEX_LEGACY_HISTORY, false));
    expect(daemon.frames).toEqual([]);
    expect(await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true })).toEqual({ turns: 0, files: 2 });
    expect(reverted).toEqual([]);
    expect(await texts(ws.id)).toEqual(["reply 1", "reply 2", "reply 3"]);
  });

  it("tells a window which harness the host rewinds by count, so a reply with no anchor is offered too", async () => {
    const { ws } = await workspace(harness({ cuts: "revert" }));
    expect((await rt!.harnesses.list(ws.id)).find(c => c.harness === "claude")).toMatchObject({ rewindsConversation: true, rewindsByCount: true });
    const other = await workspace(harness({ cuts: "next" }));
    expect((await rt!.harnesses.list(other.ws.id)).find(c => c.harness === "claude")?.rewindsByCount).toBeUndefined();
  });

  it("on a harness that keeps its own history moves the files and keeps every turn, and says it cuts no conversation", async () => {
    const { ws } = await workspace(harness({ cuts: "none" }));
    expect((await rt!.harnesses.list(ws.id)).find(c => c.harness === "claude")?.rewindsConversation).toBeFalsy();
    const { threadId, turns } = await threeTurns(ws.id);
    expect(await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true })).toEqual({ turns: 0, files: 2 });
    expect(await texts(ws.id)).toEqual(["reply 1", "reply 2", "reply 3"]);
  });

  it("tells a window whether a harness cuts its conversation", async () => {
    const { ws } = await workspace(harness({ cuts: "next" }));
    expect((await rt!.harnesses.list(ws.id)).find(c => c.harness === "claude")?.rewindsConversation).toBe(true);
  });

  it("undoes by putting back the files the rewind replaced, once, and says when there is nothing to undo", async () => {
    const { ws, daemon } = await workspace(harness({ cuts: "next" }));
    const { threadId, turns } = await threeTurns(ws.id);
    await expect(rt!.sessions.rewind(threadId, { undo: true })).rejects.toThrow(REWIND_NO_UNDO_LINE);
    await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true });
    daemon.frames.length = 0;
    expect(await rt!.sessions.rewind(threadId, { undo: true })).toEqual({ turns: 0, files: 2 });
    expect(daemon.frames).toEqual([{ op: "git.restore", cwd: daemon.checkout(), checkpoint: `refs/wsp/checkpoints/stub-1/${threadId}/${turns[0]}-before-1`, scope: ws.id }]);
    // The transcript is as the rewind left it: undo brings the files back, not the conversation.
    expect(await texts(ws.id)).toEqual(["reply 1"]);
    await expect(rt!.sessions.rewind(threadId, { undo: true })).rejects.toThrow(REWIND_NO_UNDO_LINE);
  });

  it("leaves the slate as the rewind left it on undo, since undo never puts the conversation back", async () => {
    const { ws } = await workspace(harness({ cuts: "next" }));
    const { threadId, turns } = await threeTurns(ws.id);
    const asThread: Caller = { origin: "here", by: { kind: "thread", threadId, workspaceId: ws.id, rootThreadId: threadId } };
    await rt!.slates.write({ text: `<slate><value name="pick" start="C" /><text id="t">Version {$pick}</text></slate>` }, asThread);
    const fourth = await rt!.sessions.start(ws.id, { prompt: "four", thread: threadId });
    await fourth.finished;
    await settle();
    await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true });
    expect((await rt!.slates.get(threadId))!.empty).toBe("rewound-before");
    expect(await rt!.sessions.rewind(threadId, { undo: true })).toEqual({ turns: 0, files: 2 });
    const after = (await rt!.slates.get(threadId))!;
    expect(after.document).toBeNull();
    expect(after.empty).toBe("rewound-before");
  });

  it("refuses before anything is written: a working thread, the latest reply, and files a turn kept no checkpoint of", async () => {
    const { ws, daemon } = await workspace(harness({ cuts: "next", hangFrom: 3 }));
    const first = await rt!.sessions.start(ws.id, { prompt: "one" });
    await first.finished;
    const threadId = first.view().threadId!;
    const second = await rt!.sessions.start(ws.id, { prompt: "two", thread: threadId });
    await second.finished;
    await settle();
    await expect(rt!.sessions.rewind(threadId, { turnId: second.turnId, files: false })).rejects.toThrow(REWIND_LATEST_LINE);
    const third = await rt!.sessions.start(ws.id, { prompt: "three", thread: threadId });
    await settle();
    daemon.frames.length = 0;
    await expect(rt!.sessions.rewind(threadId, { turnId: first.turnId, files: true })).rejects.toThrow(REWIND_WORKING_LINE);
    expect(daemon.frames).toEqual([]);
    await third.interrupt();
    await settle();
    expect(await texts(ws.id)).toEqual(["reply 1", "reply 2"]);

    const refusing = await workspace(harness({ cuts: "next" }), fakeDaemon({ refuseCheckpoint: true }));
    const { threadId: other, turns } = await threeTurns(refusing.ws.id);
    await expect(rt!.sessions.rewind(other, { turnId: turns[0]!, files: true })).rejects.toThrow(REWIND_NO_CHECKPOINT_LINE);
    // The conversation alone still goes, off the anchor the turn kept.
    expect(await rt!.sessions.rewind(other, { turnId: turns[0]!, files: false })).toEqual({ turns: 2 });
  });

  it("refuses a thread whose threads under it still run, naming them", async () => {
    const { ws } = await workspace(harness({ cuts: "next", hangFrom: 4 }));
    const { threadId, turns } = await threeTurns(ws.id);
    // A thread this one's agent opened, still working; the lead itself is idle.
    const by = { origin: "here", by: { kind: "thread", threadId, workspaceId: ws.id, rootThreadId: threadId } } as const;
    const child = await rt!.sessions.start(ws.id, { prompt: "fix the port list", startedBy: "agent" }, by);
    await settle();
    await expect(rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: false })).rejects.toThrow(rewindChildrenLine(["fix the port list"]));
    await child.interrupt();
    await settle();
    // Stopped, it stands in the way of nothing.
    expect(await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: false })).toEqual({ turns: 2 });
  });

  it("moves no files once another thread worked in the folder after the checkpoint, running or done, and the conversation still goes", async () => {
    const { ws, daemon } = await workspace(harness({ cuts: "next", hangFrom: 4 }));
    const { threadId, turns } = await threeTurns(ws.id);
    // A second thread of the person's on the same workspace, so in the same folder, mid-turn.
    const beside = await rt!.sessions.start(ws.id, { prompt: "move the pricing table" });
    await settle();
    daemon.frames.length = 0;
    expect(await rt!.sessions.rewind(threadId, { turnId: turns[1]!, files: true })).toEqual({ turns: 1, kept: REWIND_SHARED_LINE });
    await beside.interrupt();
    await settle();
    // Its turn is over, and it still ran after every checkpoint this thread holds.
    expect(await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true })).toEqual({ turns: 1, kept: REWIND_SHARED_LINE });
    expect(daemon.frames.filter(f => f["op"] === "git.restore")).toEqual([]);
  });

  it("will not undo while another thread in the folder works, and any turn that ends in the folder closes every undo there", async () => {
    const { ws, daemon, events } = await workspace(harness({ cuts: "next", hangFrom: 4 }));
    const { threadId, turns } = await threeTurns(ws.id);
    await rt!.sessions.rewind(threadId, { turnId: turns[0]!, files: true });
    const beside = await rt!.sessions.start(ws.id, { prompt: "move the pricing table" });
    await settle();
    daemon.frames.length = 0;
    await expect(rt!.sessions.rewind(threadId, { undo: true })).rejects.toThrow(rewindBesideLine("move the pricing table"));
    expect(daemon.frames.filter(f => f["op"] === "git.restore")).toEqual([]);
    // The other thread's turn ends with work the undo's checkpoint predates, so the undo is gone, and a window hears it.
    await beside.interrupt();
    await settle();
    expect(foldThreads(await rt!.sessions.list(ws.id)).find(t => t.threadId === threadId)?.rewoundAt).toBeUndefined();
    expect(events.filter(e => e.type === "thread.marked")).toContainEqual(expect.objectContaining({ workspaceId: ws.id, threadIds: [threadId] }));
    await expect(rt!.sessions.rewind(threadId, { undo: true })).rejects.toThrow(REWIND_NO_UNDO_LINE);
    expect(daemon.frames.filter(f => f["op"] === "git.restore")).toEqual([]);
  });

  it("is a person's act alone: no thread's token and no paired computer may ask it", () => {
    expect(THREAD_OPS).not.toContain("sessions.rewind");
    expect(DEVICE_OPS).not.toContain("sessions.rewind");
  });
});
