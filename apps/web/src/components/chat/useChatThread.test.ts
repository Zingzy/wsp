// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@wsp/protocol";
import { CHAT_STREAM, CHAT_WS } from "../../../test/fixtures/chat-stream";
import { deriveChatThread, dropEvent, reduceEvent, reloadTranscript, stabilizeEntries, type StaleTurn, type ThreadState } from "./useChatThread";

const T0 = "2026-09-01T02:00:00.000Z";
const state = (events: ReadonlyArray<SessionEvent>, extra: Partial<ThreadState> = {}): ThreadState => ({
  events,
  arrivals: events.map(() => T0),
  pendingPrompt: null,
  localErrors: [],
  fresh: false,
  stale: null,
  sending: null,
  left: undefined,
  known: [],
  named: null,
  stray: null,
  ...extra,
});

describe("deriveChatThread", () => {
  it("keeps every untouched entry's object across a text chunk, replacing only the streaming message", () => {
    const upToTool = CHAT_STREAM.slice(0, 6);
    const before = deriveChatThread(state(upToTool));
    const withChunk = deriveChatThread(state([...upToTool, CHAT_STREAM[6]!]), before.entries);
    expect(before.entries.length).toBeGreaterThanOrEqual(3);
    expect(withChunk.entries.length).toBe(before.entries.length + 1);
    for (let i = 0; i < before.entries.length; i += 1) expect(withChunk.entries[i]).toBe(before.entries[i]);
    const tail = withChunk.entries.at(-1);
    expect(tail?.kind === "message" && tail.message.streaming && tail.message.text).toBe("Server is live at :3000.");

    const second: SessionEvent = { type: "session.delta", workspaceId: CHAT_WS, sessionId: "sess_0001", turnId: "turn_0001", kind: "text", text: " Enjoy." };
    const twoChunks = deriveChatThread(state([...upToTool, CHAT_STREAM[6]!, second]), withChunk.entries);
    for (let i = 0; i < before.entries.length; i += 1) expect(twoChunks.entries[i]).toBe(before.entries[i]);
    expect(twoChunks.entries.at(-1)).not.toBe(tail);
  });

  it("replaces an entry whose content changed and keeps the rest", () => {
    const first = deriveChatThread(state(CHAT_STREAM.slice(0, 4)));
    const toolRow = first.entries.find(e => e.kind === "work");
    const done = deriveChatThread(state(CHAT_STREAM.slice(0, 5)), first.entries);
    const updated = done.entries.find(e => e.kind === "work");
    expect(toolRow).toBeDefined();
    expect(updated).not.toBe(toolRow);
    expect(updated?.kind === "work" && updated.entry.toolLifecycleStatus).toBe("completed");
    expect(done.entries[0]).toBe(first.entries[0]);
  });

  it("reads the wire's at and turnId through the adapter rather than the arrival clock", () => {
    const view = deriveChatThread(state(CHAT_STREAM));
    expect(view.turns.map(t => t.turnId)).toEqual(["turn_0001"]);
    // The fixture's session.start carries no prompt, so the first entry is the first text delta.
    expect(view.entries[0]?.createdAt).toBe(new Date(CHAT_STREAM[1]!.at!).toISOString());
    expect(view.settled?.durationMs).toBe(10458);
  });

  it("stamps unstamped history with the arrival clock", () => {
    const unstamped = CHAT_STREAM.map(({ at: _at, ...e }) => e as SessionEvent);
    const view = deriveChatThread(state(unstamped));
    expect(view.entries[0]?.createdAt).toBe(T0);
  });

  it("appends the optimistic prompt and local errors after the wire's entries", () => {
    const view = deriveChatThread(state(CHAT_STREAM, { pendingPrompt: { text: "next", at: T0 }, localErrors: [{ message: "socket closed", at: T0 }] }));
    const tail = view.entries.slice(-2);
    expect(tail[0]?.kind === "message" && tail[0].message.text).toBe("next");
    expect(tail[1]?.kind === "work" && tail[1].entry.label).toBe("socket closed");
    expect(view.settled?.turnId).toBe("turn_0001");
  });
});

describe("stabilizeEntries", () => {
  it("returns the previous objects for equal content and the new ones otherwise", () => {
    const a = deriveChatThread(state(CHAT_STREAM)).entries;
    const b = deriveChatThread(state(CHAT_STREAM)).entries;
    expect(b[0]).not.toBe(a[0]);
    const stable = stabilizeEntries(b, a);
    expect(stable).toEqual(a);
    stable.forEach((entry, i) => expect(entry).toBe(a[i]));
    expect(stabilizeEntries([], a)).toEqual([]);
  });
});

describe("reloadTranscript", () => {
  const A = CHAT_STREAM.map(e => ({ ...e, threadId: "thr_a" }));
  const A_RUNNING = A.slice(0, 3);
  const A_TURN: StaleTurn = { kind: "turn", turnId: "turn_0001", sessionId: "sess_0001" };
  const b = { workspaceId: CHAT_WS, sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_b" };
  const B_RUNNING: SessionEvent[] = [
    { type: "session.start", ...b, prompt: "start over" },
    { type: "session.delta", ...b, kind: "text", text: "Fresh start." },
  ];
  const B_DONE: SessionEvent[] = [
    ...B_RUNNING,
    { type: "session.done", ...b, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
    { type: "session.end", ...b, exitCode: 0, sawResult: true },
  ];
  const B_TURN: StaleTurn = { kind: "turn", turnId: "turn_0002", sessionId: "sess_0002" };
  const unstamped = CHAT_STREAM;

  it("keeps only the last thread of a transcript, arrivals alongside", () => {
    const next = reloadTranscript(state([]), [...A, ...B_DONE], T0);
    expect(next.events).toEqual(B_DONE);
    expect(next.arrivals).toEqual(B_DONE.map(() => T0));
    expect(next.fresh).toBe(false);
    expect(next.stale).toBeNull();
  });

  it("a selected thread keeps that thread's events wherever they sit, and none of the others", () => {
    const events = [A[0]!, A[1]!, B_RUNNING[0]!, A[2]!, B_RUNNING[1]!, ...B_DONE.slice(2)];
    const next = reloadTranscript(state([]), events, T0, "thr_a");
    expect(next.events).toEqual(A_RUNNING);
    expect(next.arrivals).toEqual(A_RUNNING.map(() => T0));
    expect(reloadTranscript(state([]), events, T0, "thr_b").events).toEqual(B_DONE);
    expect(reloadTranscript(state([]), events, T0, "thr_none").events).toEqual([]);
  });

  it("a transcript without thread ids is one thread", () => {
    const second = unstamped.map(e => ({ ...e, sessionId: "sess_0009", turnId: "turn_0009" }));
    const next = reloadTranscript(state([]), [...unstamped, ...second], T0);
    expect(next.events.length).toBe(unstamped.length * 2);
  });

  it("folds by the last event's id, not by runs, so interleaved turns keep every event of the last thread", () => {
    const events = [A[0]!, A[1]!, B_RUNNING[0]!, A[2]!, B_RUNNING[1]!, ...B_DONE.slice(2)];
    expect(reloadTranscript(state([]), events, T0).events).toEqual(B_DONE);
  });

  it("while fresh, a left thread that ended in the dark leaves nothing stale and keeps the fresh state", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], stale: A_TURN, pendingPrompt: { text: "start over", at: T0 } });
    const next = reloadTranscript(fresh, A, T0);
    expect(next).toEqual({ ...fresh, stale: null });
  });

  it("while fresh, a left thread still running keeps its turn as the stale one", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], stale: A_TURN });
    expect(reloadTranscript(fresh, A_RUNNING, T0)).toEqual({ ...fresh, stale: A_TURN });
  });

  it("while fresh, a thread with an id the left one did not have is the person's own and loads as such", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], pendingPrompt: { text: "start over", at: T0 } });
    const next = reloadTranscript(fresh, [...A, ...B_RUNNING], T0);
    expect(next.events).toEqual(B_RUNNING);
    expect(next.fresh).toBe(false);
    expect(next.pendingPrompt).toBeNull();
    expect(next.stale).toBeNull();
    expect(next.left).toBeUndefined();
  });

  it("while fresh, the left thread alone decides the stale record when the person's thread is present", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], stale: A_TURN });
    const next = reloadTranscript(fresh, [...A_RUNNING, ...B_RUNNING], T0);
    expect(next.events).toEqual(B_RUNNING);
    expect(next.stale).toEqual(A_TURN);
  });

  it("while fresh from an empty thread, a new id is the person's own; a legacy thread is the left one", () => {
    const fresh = state([], { fresh: true, left: undefined });
    expect(reloadTranscript(fresh, B_RUNNING, T0).events).toEqual(B_RUNNING);
    const legacy = reloadTranscript(fresh, unstamped.slice(0, 3), T0);
    expect(legacy.events).toEqual([]);
    expect(legacy.stale).toEqual(A_TURN);
  });

  it("a pending send is never read as the person's thread: its turn in the transcript is the stale one", () => {
    const pending = state([], { fresh: true, left: undefined, stale: { kind: "pending-send", after: undefined } });
    expect(reloadTranscript(pending, B_RUNNING, T0)).toEqual({ ...pending, stale: B_TURN, known: ["thr_b"] });
    expect(reloadTranscript(pending, B_DONE, T0)).toEqual({ ...pending, known: ["thr_b"] });
  });

  it("remembers every thread id a reply carried, once each, on top of the ones already known", () => {
    expect(reloadTranscript(state([]), [...A, ...B_DONE], T0).known).toEqual(["thr_a", "thr_b"]);
    expect(reloadTranscript(state([]), unstamped, T0).known).toEqual([]);
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"] });
    expect(reloadTranscript(fresh, [...A, ...B_RUNNING], T0).known).toEqual(["thr_a", "thr_b"]);
  });

  it("while fresh, a known thread that is last in the reply is not the person's own, whether or not it is the left one", () => {
    const fresh = state([], { fresh: true, left: "thr_b", known: ["thr_a", "thr_b"] });
    const next = reloadTranscript(fresh, [...B_DONE, ...A_RUNNING], T0);
    expect(next.events).toEqual([]);
    expect(next.fresh).toBe(true);
    expect(next.left).toBe("thr_b");
    const own = reloadTranscript(state([], { fresh: true, left: "thr_a", known: ["thr_a"] }), [...A, ...B_RUNNING], T0);
    expect(own.events).toEqual(B_RUNNING);
    expect(own.fresh).toBe(false);
  });

  it("a rebuild during a send settles it from the reply the way a live event would: a start names the key the rows waited under, an end alone settles it unnamed, nothing new keeps it", () => {
    const sending = state(A, { sending: { after: "turn_0001" } });
    const a2 = { workspaceId: CHAT_WS, sessionId: "sess_0001", turnId: "turn_0002", threadId: "thr_a" };
    const started = reloadTranscript(sending, [...A, { type: "session.start", ...a2, prompt: "again" }], T0);
    expect(started.sending).toBeNull();
    expect(started.named).toEqual({ key: "thr_a", thread: "thr_a" });
    expect(started.events).toHaveLength(A.length + 1);
    const quiet = reloadTranscript(sending, A, T0);
    expect(quiet.sending).toEqual({ after: "turn_0001" });
    expect(quiet.named).toBeNull();
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_a" };
    const died = reloadTranscript(sending, [...A, { type: "session.done", ...x, result: { status: "failed", error: "gone" } }, { type: "session.end", ...x, exitCode: 127, sawResult: true }], T0);
    expect(died.sending).toBeNull();
    expect(died.named).toBeNull();
    expect(reloadTranscript(state(A), [...A, { type: "session.start", ...a2, prompt: "again" }], T0).named).toBeNull();
  });

  it("while fresh with a send in flight, a reply that holds the person's thread settles the send and names the workspace key its rows waited under", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], sending: { after: undefined } });
    const own = reloadTranscript(fresh, [...A, ...B_RUNNING], T0);
    expect(own.events).toEqual(B_RUNNING);
    expect(own.sending).toBeNull();
    expect(own.named).toEqual({ key: CHAT_WS, thread: "thr_b" });
    const waiting = reloadTranscript(fresh, A, T0);
    expect(waiting.sending).toEqual({ after: undefined });
    expect(waiting.named).toBeNull();
  });

  it("while a send is pending on a view with a start, a reply that ends in another thread folds to the held one and keeps the send for its own start", () => {
    const sending = state(A, { known: ["thr_a"], sending: { after: "turn_0001" } });
    const c = { workspaceId: CHAT_WS, sessionId: "sess_c", turnId: "turn_c1", threadId: "thr_c" };
    const elsewhere: SessionEvent[] = [
      { type: "session.start", ...c, prompt: "from another tab" },
      { type: "session.delta", ...c, kind: "text", text: "Elsewhere." },
    ];
    const next = reloadTranscript(sending, [...A, ...elsewhere], T0);
    expect(next.events).toEqual(A);
    expect(next.sending).toEqual({ after: "turn_0001" });
    expect(next.named).toBeNull();
    expect(next.known).toEqual(["thr_a", "thr_c"]);
    const a2 = { workspaceId: CHAT_WS, sessionId: "sess_0001", turnId: "turn_0002", threadId: "thr_a" };
    const own = reduceEvent(next, { type: "session.start", ...a2, prompt: "one" }, T0);
    expect(own.sending).toBeNull();
    expect(own.named).toEqual({ key: "thr_a", thread: "thr_a" });
    expect(reloadTranscript(state(A), [...A, ...elsewhere], T0).events).toEqual(elsewhere);
  });

  it("while fresh, a known older thread running last in the reply is not the stale turn: only the left thread can be", () => {
    const fresh = state([], { fresh: true, left: "thr_b", known: ["thr_a", "thr_b"] });
    expect(reloadTranscript(fresh, [...B_DONE, ...A_RUNNING], T0).stale).toBeNull();
    const leftA = state([], { fresh: true, left: "thr_a", known: ["thr_a", "thr_b"] });
    expect(reloadTranscript(leftA, [...B_DONE, ...A_RUNNING], T0).stale).toEqual(A_TURN);
  });
});

describe("reduceEvent", () => {
  const A = CHAT_STREAM.map(e => ({ ...e, threadId: "thr_a" }));
  const A_RUNNING = A.slice(0, 3);
  const A_TURN: StaleTurn = { kind: "turn", turnId: "turn_0001", sessionId: "sess_0001" };
  const b = { workspaceId: CHAT_WS, sessionId: "sess_0002", turnId: "turn_0002", threadId: "thr_b" };
  const B_START: SessionEvent = { type: "session.start", ...b, prompt: "start over" };
  const B_DELTA: SessionEvent = { type: "session.delta", ...b, kind: "text", text: "Fresh start." };

  it("drops an event from another thread once the held events carry a thread id; an empty or unstamped state takes any", () => {
    const held = state(A_RUNNING);
    expect(reduceEvent(held, B_DELTA, T0).events).toEqual(A_RUNNING);
    expect(reduceEvent(held, A[3]!, T0).events).toEqual([...A_RUNNING, A[3]]);
    expect(reduceEvent(state([]), B_START, T0).events).toEqual([B_START]);
    expect(reduceEvent(state(CHAT_STREAM.slice(0, 3)), B_DELTA, T0).events).toHaveLength(4);
  });

  it("while fresh, a delta from any thread is dropped: only a session.start can open the person's own thread", () => {
    const fresh = state([], { fresh: true, left: "thr_a" });
    expect(reduceEvent(fresh, B_DELTA, T0).events).toEqual([]);
    expect(reduceEvent(fresh, CHAT_STREAM[1]!, T0)).toBe(fresh);
    expect(reduceEvent(fresh, B_START, T0).events).toEqual([B_START]);
  });

  it("while fresh, the next session.start opens the thread and the left turn's end still clears the stale record", () => {
    const fresh = state([], { fresh: true, left: "thr_a", stale: A_TURN });
    const opened = reduceEvent(fresh, B_START, T0);
    expect(opened.events).toEqual([B_START]);
    expect(opened.fresh).toBe(false);
    expect(reduceEvent(opened, A[2]!, T0)).toBe(opened);
    const ended = reduceEvent(opened, A.at(-1)!, T0);
    expect(ended.stale).toBeNull();
    expect(ended.events).toEqual([B_START]);
  });

  it("a send settles at its start or at the end of a turn other than the one settled when it began; that turn's trailing end keeps it", () => {
    const sending = state(A.slice(0, -1), { sending: { after: "turn_0001" } });
    const trailing = reduceEvent(sending, A.at(-1)!, T0);
    expect(trailing.events).toEqual(A);
    expect(trailing.sending).toEqual({ after: "turn_0001" });
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_a" };
    expect(reduceEvent(trailing, { type: "session.end", ...x, exitCode: 127, sawResult: true }, T0).sending).toBeNull();
    expect(reduceEvent(trailing, { type: "session.start", ...x, prompt: "next" }, T0).sending).toBeNull();
    expect(reduceEvent(trailing, { type: "session.done", ...x, result: { status: "failed", error: "gone" } }, T0).sending).toEqual({ after: "turn_0001" });
  });

  it("named is the key a send's rows waited under when its start lands: the thread id the view held, or the workspace id before it had one", () => {
    const sending = state([], { sending: { after: undefined } });
    expect(reduceEvent(sending, B_START, T0).named).toEqual({ key: CHAT_WS, thread: "thr_b" });
    expect(reduceEvent(sending, CHAT_STREAM[0]!, T0).named).toEqual({ key: CHAT_WS, thread: CHAT_WS });
    expect(reduceEvent(state([]), B_START, T0).named).toBeNull();
    const stamped = state(A, { sending: { after: "turn_0001" } });
    expect(reduceEvent(stamped, { type: "session.start", ...b, threadId: "thr_a" }, T0).named).toEqual({ key: "thr_a", thread: "thr_a" });
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_a" };
    expect(reduceEvent(stamped, { type: "session.end", ...x, exitCode: 127, sawResult: true }, T0).named).toBeNull();
  });

  it("a view named by its last start, not by a harness that died before one: the dead events keep the workspace key", () => {
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const died = reduceEvent(state([], { sending: { after: undefined } }), { type: "session.end", ...x, exitCode: 127, sawResult: true }, T0);
    expect(died.events).toHaveLength(1);
    expect(died.sending).toBeNull();
    const started = reduceEvent({ ...died, sending: { after: "turn_x1" } }, B_START, T0);
    expect(started.events).toHaveLength(2);
    expect(started.named).toEqual({ key: CHAT_WS, thread: "thr_b" });
    expect(reduceEvent(started, A[1]!, T0).events).toEqual(started.events);
  });

  it("while fresh with a send in flight, a known thread waking is dropped and does not settle the send; a thread the view never knew is the send's own", () => {
    const fresh = state([], { fresh: true, left: "thr_b", known: ["thr_a", "thr_b"], sending: { after: undefined } });
    expect(reduceEvent(fresh, A[1]!, T0)).toBe(fresh);
    expect(reduceEvent(fresh, A.at(-2)!, T0)).toBe(fresh);
    expect(reduceEvent(fresh, A.at(-1)!, T0)).toBe(fresh);
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const died = reduceEvent(fresh, { type: "session.done", ...x, result: { status: "failed", error: "gone" } }, T0);
    expect(died.events).toHaveLength(1);
    expect(died.sending).toEqual({ after: undefined });
    expect(reduceEvent(died, { type: "session.end", ...x, exitCode: 127, sawResult: true }, T0).sending).toBeNull();
  });

  it("a pending send left behind clears at the end of a thread the view never knew, or of the left thread under a new turn; the left turn's trailing end, another known thread's end and its own done do not", () => {
    const pending = state([], { fresh: true, left: "thr_a", known: ["thr_a", "thr_b"], stale: { kind: "pending-send", after: "turn_0001" } });
    expect(reduceEvent(pending, A.at(-1)!, T0)).toBe(pending);
    expect(reduceEvent(pending, { type: "session.end", ...b, exitCode: 0, sawResult: true }, T0)).toBe(pending);
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    expect(reduceEvent(pending, { type: "session.done", ...x, result: { status: "failed", error: "gone" } }, T0)).toBe(pending);
    const cleared = reduceEvent(pending, { type: "session.end", ...x, exitCode: 127, sawResult: true }, T0);
    expect(cleared.stale).toBeNull();
    expect(cleared.events).toEqual([]);
    expect(cleared.fresh).toBe(true);
    const resumed = { workspaceId: CHAT_WS, sessionId: "sess_0001", turnId: "turn_0009", threadId: "thr_a" };
    expect(reduceEvent(pending, { type: "session.end", ...resumed, exitCode: 127, sawResult: true }, T0).stale).toBeNull();
    expect(reduceEvent(pending, { type: "session.start", ...x, prompt: "hello" }, T0).stale).toEqual({ kind: "turn", turnId: "turn_x1", sessionId: "sess_x" });
  });

  it("while fresh with a send in flight, a harness that dies before its start lands and settles the send; the left thread's trailing end is still dropped", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], sending: { after: undefined } });
    expect(reduceEvent(fresh, A.at(-1)!, T0)).toBe(fresh);
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const died: SessionEvent = { type: "session.done", ...x, result: { status: "failed", error: "claude: command not found" } };
    const failed = reduceEvent(fresh, died, T0);
    expect(failed.events).toEqual([died]);
    expect(failed.sending).toEqual({ after: undefined });
    const ended = reduceEvent(failed, { type: "session.end", ...x, exitCode: 127, sawResult: true }, T0);
    expect(ended.sending).toBeNull();
    expect(ended.fresh).toBe(true);
    expect(ended.named).toBeNull();
    expect(deriveChatThread(ended).settled?.state).toBe("error");
    const idle = state([], { fresh: true, left: "thr_a", known: ["thr_a"] });
    expect(reduceEvent(idle, died, T0).events).toEqual([]);
  });

  it("a view whose last thread has no start admits only that thread's events, and while a send is in flight a thread it does not know", () => {
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const deadEvents: SessionEvent[] = [
      { type: "session.done", ...x, result: { status: "failed", error: "claude: command not found" } },
      { type: "session.end", ...x, exitCode: 127, sawResult: true },
    ];
    const dead = state(deadEvents, { known: ["thr_a", "thr_b", "thr_x"] });
    expect(reduceEvent(dead, A[1]!, T0)).toBe(dead);
    expect(reduceEvent(dead, A.at(-1)!, T0)).toBe(dead);
    expect(reduceEvent(dead, B_START, T0)).toBe(dead);
    expect(reduceEvent(dead, { type: "session.delta", ...x, kind: "text", text: "late" }, T0).events).toHaveLength(3);
    const sending = { ...dead, sending: { after: "turn_x1" } };
    expect(reduceEvent(sending, { type: "session.start", ...b, threadId: "thr_a" }, T0)).toBe(sending);
    const z = { workspaceId: CHAT_WS, sessionId: "sess_z", turnId: "turn_z1", threadId: "thr_z" };
    const started = reduceEvent(sending, { type: "session.start", ...z, prompt: "retry" }, T0);
    expect(started.events).toHaveLength(3);
    expect(started.sending).toBeNull();
    expect(started.named).toEqual({ key: CHAT_WS, thread: "thr_z" });
    expect(reduceEvent(started, deadEvents[0]!, T0)).toBe(started);
    const diedAgain = reduceEvent(sending, { type: "session.end", ...z, exitCode: 127, sawResult: true }, T0);
    expect(diedAgain.events).toHaveLength(3);
    expect(diedAgain.sending).toBeNull();
  });

  it("the thread of a dropped event becomes known, once, so it cannot pass for the person's own send later", () => {
    const held = state(A_RUNNING);
    const saw = reduceEvent(held, B_DELTA, T0);
    expect(saw.events).toEqual(A_RUNNING);
    expect(saw.known).toEqual(["thr_b"]);
    expect(reduceEvent(saw, B_DELTA, T0)).toBe(saw);
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"] });
    const c = { workspaceId: CHAT_WS, sessionId: "sess_c", turnId: "turn_c1", threadId: "thr_c" };
    const knew = reduceEvent(fresh, { type: "session.delta", ...c, kind: "text", text: "elsewhere" }, T0);
    expect(knew.events).toEqual([]);
    expect(knew.known).toEqual(["thr_a", "thr_c"]);
    const sending = { ...knew, sending: { after: undefined } };
    expect(reduceEvent(sending, { type: "session.delta", ...c, kind: "text", text: "C LEAKED" }, T0)).toBe(sending);
    expect(reduceEvent(sending, { type: "session.end", ...c, exitCode: 0, sawResult: true }, T0)).toBe(sending);
  });

  it("a pending send left behind remembers the thread of a start or a delta it sees, so that thread's end cannot clear it; a done alone is not remembered", () => {
    const pending = state([], { fresh: true, left: "thr_a", known: ["thr_a"], stale: { kind: "pending-send", after: "turn_0001" } });
    const c = { workspaceId: CHAT_WS, sessionId: "sess_c", turnId: "turn_c1", threadId: "thr_c" };
    const saw = reduceEvent(pending, { type: "session.delta", ...c, kind: "text", text: "elsewhere" }, T0);
    expect(saw.known).toEqual(["thr_a", "thr_c"]);
    expect(saw.stale).toEqual(pending.stale);
    expect(saw.events).toEqual([]);
    expect(reduceEvent(saw, { type: "session.end", ...c, exitCode: 0, sawResult: true }, T0)).toBe(saw);
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const started = reduceEvent(pending, { type: "session.start", ...x, prompt: "hello" }, T0);
    expect(started.known).toEqual(["thr_a", "thr_x"]);
    expect(started.stale).toEqual({ kind: "turn", turnId: "turn_x1", sessionId: "sess_x" });
    expect(reduceEvent(pending, { type: "session.done", ...x, result: { status: "failed", error: "gone" } }, T0)).toBe(pending);
  });
});

describe("a send a view change left in flight", () => {
  const A = CHAT_STREAM.map(e => ({ ...e, threadId: "thr_a" }));
  const stray = { prompt: "first" };
  const pinned = state(A, { known: ["thr_a"], stray });
  const n = { workspaceId: CHAT_WS, sessionId: "sess_n", turnId: "turn_n1", threadId: "thr_n" };
  const c = { workspaceId: CHAT_WS, sessionId: "sess_c", turnId: "turn_c1", threadId: "thr_c" };
  const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
  const N_START: SessionEvent = { type: "session.start", ...n, prompt: "first" };

  it("its start, told by the prompt it carries, names the rows under the workspace id on whichever view drops it", () => {
    const landed = dropEvent(pinned, N_START);
    expect(landed.stray).toBeNull();
    expect(landed.named).toEqual({ key: CHAT_WS, thread: "thr_n" });
    expect(landed.events).toEqual(A);
    expect(dropEvent(landed, { type: "session.delta", ...n, kind: "text", text: "On first." })).toEqual({ ...landed, known: ["thr_a", "thr_n"] });
  });

  it("another client's start is remembered, not taken, and that thread's end does not settle it", () => {
    const other = dropEvent(pinned, { type: "session.start", ...c, prompt: "from another tab" });
    expect(other.stray).toEqual(stray);
    expect(other.named).toBeNull();
    expect(other.known).toEqual(["thr_a", "thr_c"]);
    expect(dropEvent(other, { type: "session.end", ...c, exitCode: 0, sawResult: true })).toBe(other);
    expect(dropEvent(pinned, { type: "session.start", ...c, prompt: "first" }).stray).toBeNull();
  });

  it("a harness that dies before its start settles it without a name; its done alone keeps waiting for the end", () => {
    const died = dropEvent(pinned, { type: "session.done", ...x, result: { status: "failed", error: "claude: command not found" } });
    expect(died).toBe(pinned);
    const ended = dropEvent(died, { type: "session.end", ...x, exitCode: 127, sawResult: true });
    expect(ended.stray).toBeNull();
    expect(ended.named).toBeNull();
    expect(dropEvent(state(A, { known: ["thr_a"] }), N_START)).toEqual(state(A, { known: ["thr_a", "thr_n"] }));
  });

  it("a fresh view that holds the start takes the rows with it", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], stray });
    const opened = reduceEvent(fresh, N_START, T0);
    expect(opened.events).toEqual([N_START]);
    expect(opened.stray).toBeNull();
    expect(opened.named).toEqual({ key: CHAT_WS, thread: "thr_n" });
    const known = reduceEvent(fresh, { type: "session.start", ...c, prompt: "from another tab" }, T0);
    expect(known.events).toHaveLength(1);
    expect(known.stray).toEqual(stray);
    expect(known.named).toBeNull();
  });

  it("a reply read on the next view settles it the way dropped live events would", () => {
    const next = reloadTranscript(state([], { known: ["thr_a"], stray }), [...A, N_START, { type: "session.delta", ...n, kind: "text", text: "On first." }], T0, "thr_a");
    expect(next.events).toEqual(A);
    expect(next.stray).toBeNull();
    expect(next.named).toEqual({ key: CHAT_WS, thread: "thr_n" });
    const quiet = reloadTranscript(state([], { known: ["thr_a"], stray }), A, T0, "thr_a");
    expect(quiet.stray).toEqual(stray);
    expect(quiet.named).toBeNull();
    const died = reloadTranscript(state([], { known: ["thr_a"], stray }), [...A, { type: "session.done", ...x, result: { status: "failed", error: "gone" } }, { type: "session.end", ...x, exitCode: 127, sawResult: true }], T0, "thr_a");
    expect(died.stray).toBeNull();
    expect(died.named).toBeNull();
    const latest = reloadTranscript(state([], { known: ["thr_a"], stray }), [...A, N_START], T0);
    expect(latest.events).toEqual([N_START]);
    expect(latest.named).toEqual({ key: CHAT_WS, thread: "thr_n" });
  });
});
