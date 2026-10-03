// SPDX-License-Identifier: AGPL-3.0-only
// A thread's slate on the host: writes by the thread's own token, the one-step undo and clear, a press that starts
// the thread's next turn with the slate line, the snapshot every turn's end keeps, and a rewind that restores it.
// The harness and the daemon are fakes and the store is in memory, so the runtime's own reading is under test.
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterEvent, Caller, DaemonFrame, DaemonResponse, EventUnion, SessionEvent, TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type Runtime } from "../src/runtime.js";
import type { DaemonChannel } from "../src/daemon-channel.js";
import { memoryStore, type Store } from "../src/store.js";
import { SLATES, type SlateRecord } from "../src/slates.js";
import { createOn, stubBackend, tokenGuest } from "./stub-backend.js";

const DAEMON_TOKEN = "cafef00d".repeat(3);

/** A daemon that keeps a checkpoint of every turn and answers a restore. */
const daemon = async (): Promise<DaemonChannel> => ({
  send: async (frame: DaemonFrame) => {
    const f = frame as unknown as Record<string, unknown>;
    if (f["op"] === "git.checkpoint") return { id: 1, ok: true, ref: `refs/wsp/checkpoints/${String(f["turn"])}`, commit: "c", changed: true } as DaemonResponse;
    if (f["op"] === "git.restore") return { id: 1, ok: true, before: "before-1", files: 1 } as DaemonResponse;
    return { id: 1, ok: false, error: `no ${String(f["op"])} here` } as DaemonResponse;
  },
  close: () => {},
  closed: new Promise(() => {}),
});

/** A harness that cuts its conversation on its next resume, as Claude Code does, and replies at once. */
function harness(prompts: string[]): HarnessAdapterFactory {
  let turns = 0;
  return () => ({
    steers: false,
    resumesAt: true as const,
    start: (s: HarnessStartOptions) => {
      const n = ++turns;
      prompts.push(s.prompt);
      const session = s.resume ?? "55555555-5555-4555-8555-555555555555";
      const emit = (e: AdapterEvent): void => s.onEvent(e);
      const result: TurnResult = { status: "completed", text: `reply ${n}` };
      const finished = Promise.resolve().then(() => {
        emit({ type: "session.start", sessionId: session });
        emit({ type: "turn.delta", sessionId: session, kind: "text", text: `reply ${n}` });
        emit({ type: "turn.anchor", sessionId: session, anchor: `a${n}` });
        emit({ type: "turn.done", sessionId: session, result });
        emit({ type: "session.end", sessionId: session, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: session, finished, interrupt: async () => {} };
    },
  });
}

const settle = () => new Promise(r => setTimeout(r, 30));

let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

async function setup() {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  const store: Store = memoryStore();
  const prompts: string[] = [];
  rt = createRuntime({ backend, store, adapters: { claude: harness(prompts) }, daemonToken: DAEMON_TOKEN, daemonChannel: daemon });
  const ws = await createOn(rt, { golden: "snap_g", name: "slate" });
  backend.machines[0]!.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
  const events: EventUnion[] = [];
  rt.events.on("*", e => events.push(e as EventUnion));
  const first = await rt.sessions.start(ws.id, { prompt: "keep an eye on my steps" });
  await first.finished;
  await settle();
  const threadId = first.view().threadId!;
  /** The thread's own token as the scoped wsp mcp presents it. */
  const asThread: Caller = { origin: "here", by: { kind: "thread", threadId, workspaceId: ws.id, rootThreadId: threadId } };
  return { ws, store, prompts, events, threadId, firstTurn: first.turnId, asThread };
}

const TRACKER = `slate 1 "Steps"

state.done = 1
state.total = 3

root: column
  progress: meter label="Steps" value={state.done} max={state.total}
  next: button label="Go on"
    @press send text="Go on to the next step." with=[state.done]
`;

describe("a thread's slate on the host", () => {
  it("is written, patched, read, set by state, undone and cleared through the thread's own token, and refuses another thread's", async () => {
    const { ws, store, events, threadId, asThread } = await setup();
    const set = await rt!.slates.set({ lines: TRACKER }, asThread);
    expect(set).toMatchObject({ version: 1, problems: [] });
    expect(set.sketch.split("\n")[0]).toMatch(/^slate v1 "Steps", \d+ pieces/);
    expect(set.sketch).toContain("[progress meter]");
    expect(events.filter(e => e.type === "session.slate")).toMatchObject([{ type: "session.slate", threadId, cause: "set", version: 1, by: "agent" }]);
    expect((await rt!.sessions.history(ws.id)).some(e => e.type === "session.slate")).toBe(true);

    const patched = await rt!.slates.patch({ lines: '+ eta: text value="Soon" under=root at=1', ifVersion: 1 }, asThread);
    expect(patched.version).toBe(2);
    await expect(rt!.slates.patch({ lines: "~ eta value=\"Later\"", ifVersion: 1 }, asThread)).rejects.toMatchObject({ code: "V700" });

    const ticked = await rt!.slates.state({ values: { "state.done": 2 }, sketch: true }, asThread);
    expect(ticked.version).toBe(3);
    expect(events.filter(e => e.type === "slate.state").at(-1)).toMatchObject({ threadId, version: 3, values: { "state.done": 2 } });

    const read = await rt!.slates.read({ values: ["state.done", "time.now"], lines: true }, asThread);
    expect(read).toMatchObject({ version: 3, state: { done: 2, total: 3 }, values: { "state.done": 2, "time.now": expect.any(Number) } });
    expect(Object.keys(read.document!.pieces)).toContain("eta");
    expect(read.lines).toContain("eta");

    // The undo swaps with the document before the last whole write, the patch; the state write left it alone.
    const undone = await rt!.slates.undo({}, asThread);
    expect(undone.version).toBe(4);
    expect(Object.keys((await rt!.slates.get(threadId))!.document!.pieces)).not.toContain("eta");
    expect((await rt!.slates.undo({}, asThread)).version).toBe(5);
    expect(Object.keys((await rt!.slates.get(threadId))!.document!.pieces)).toContain("eta");

    expect((await rt!.slates.clear({}, asThread)).version).toBe(6);
    expect(await rt!.slates.get(threadId)).toMatchObject({ document: null, empty: "cleared", state: { done: 2 }, canUndo: true });
    await rt!.slates.undo({}, asThread);
    expect((await rt!.slates.get(threadId))!.document).not.toBeNull();

    const other: Caller = { origin: "here", by: { kind: "thread", threadId: "someone-else", workspaceId: ws.id, rootThreadId: "someone-else" } };
    await expect(rt!.slates.set({ lines: TRACKER, threadId }, other)).rejects.toMatchObject({ code: "Z800", kind: "usage" });
    await expect(rt!.slates.read({ threadId }, other)).rejects.toMatchObject({ code: "Z801", kind: "not-found" });

    // A refused write lists every error and stores nothing.
    await expect(rt!.slates.set({ lines: "slate 1\n\nweek: meter label=\"Weekly\" value={usage.weekley.percent} colour=red" }, asThread)).rejects.toMatchObject({ kind: "invalid", errors: expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]) });
    expect((await rt!.slates.get(threadId))!.version).toBe(7);
    // Persisted through the store port, so a host over the same store finds it.
    expect(((await store.get(SLATES, threadId)) as SlateRecord).version).toBe(7);
  });

  it("a press starts the thread's next turn with the action's text and the slate line, once per request id", async () => {
    const { ws, prompts, threadId, asThread } = await setup();
    await rt!.slates.set({ lines: TRACKER }, asThread);
    const press = { threadId, version: 1, piece: "next", event: "press", action: 0, requestId: `${threadId}:1:next:1` };
    const answer = await rt!.slates.act(press);
    expect(answer).toMatchObject({ outcome: "started", said: "Sent", turnId: expect.any(String) });
    await settle();
    const sent = prompts.at(-1)!;
    const [text, blank, line] = sent.split("\n");
    expect(text).toBe("Go on to the next step.");
    expect(blank).toBe("");
    expect(JSON.parse(line!.slice("slate: ".length))).toMatchObject({ v: 1, kind: "action", thread: threadId.slice(0, 8), version: 1, piece: "next", label: "Go on", event: "press", action: "send", with: { "state.done": 1 }, by: "person" });
    const start = (await rt!.sessions.history(ws.id)).filter((e): e is Extract<SessionEvent, { type: "session.start" }> => e.type === "session.start").at(-1)!;
    expect(start).toMatchObject({ via: "slate", requestId: press.requestId, prompt: sent });
    // The same press sent again answers the first outcome and starts nothing.
    const turns = prompts.length;
    expect(await rt!.slates.act(press)).toEqual(answer);
    expect(prompts.length).toBe(turns);
    // A second send inside two seconds is too fast.
    await expect(rt!.slates.act({ ...press, requestId: `${threadId}:1:next:2` })).rejects.toMatchObject({ code: "V703" });
  });

  it("keeps a snapshot at every turn's end, and a rewind restores that turn's slate, or empties it before the slate existed, and undo rewind puts it back", async () => {
    const { ws, threadId, firstTurn, asThread } = await setup();
    await rt!.slates.set({ lines: TRACKER }, asThread);
    const second = await rt!.sessions.start(ws.id, { prompt: "two", thread: threadId });
    await second.finished;
    await settle();
    await rt!.slates.patch({ lines: '+ eta: text value="Soon" under=root at=1' }, asThread);
    const third = await rt!.sessions.start(ws.id, { prompt: "three", thread: threadId });
    await third.finished;
    await settle();
    const kept = (await rt!.slates.get(threadId))!;
    expect(kept.version).toBe(2);

    // Rewound to the second turn's end: the slate as it stood then, without the piece the third turn's patch added.
    await rt!.sessions.rewind(threadId, { turnId: second.turnId, files: false });
    const back = (await rt!.slates.get(threadId))!;
    expect(back).toMatchObject({ version: 3, rewound: true });
    expect(Object.keys(back.document!.pieces)).not.toContain("eta");

    await rt!.sessions.rewind(threadId, { undo: true });
    const again = (await rt!.slates.get(threadId))!;
    expect(again).toMatchObject({ version: 4, rewound: false });
    expect(Object.keys(again.document!.pieces)).toContain("eta");

    // The first turn ended before the slate was written, so a rewind there empties it.
    await rt!.sessions.rewind(threadId, { turnId: firstTurn, files: false });
    expect(await rt!.slates.get(threadId)).toMatchObject({ document: null, empty: "rewound-before", version: 5 });
    expect((await rt!.slates.read({}, asThread)).problems).toEqual([expect.objectContaining({ code: "Z804" })]);
  });
});
