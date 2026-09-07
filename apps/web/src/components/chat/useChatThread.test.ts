// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@wsp/protocol";
import { CHAT_STREAM, CHAT_WS } from "../../../test/fixtures/chat-stream";
import { deriveChatThread, dropEvent, leaveView, reduceEvent, reloadTranscript, stabilizeEntries, startedSession, type StaleTurn, type ThreadState } from "./useChatThread";

const T0 = "2026-09-01T02:00:00.000Z";
const REQ = "req_own";
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

describe("reduceEvent with a steer", () => {
  const A = { workspaceId: CHAT_WS, sessionId: "sess_a", turnId: "turn_a", threadId: "thr_a" };
  const B = { workspaceId: CHAT_WS, sessionId: "sess_b", turnId: "turn_b", threadId: "thr_b" };

  it("a steer of the held thread lands in it; a steer of another thread is another client's live turn and is dropped, even while a send is pending", () => {
    const held = state([{ type: "session.start", ...A, prompt: "go" }, { type: "session.delta", ...A, kind: "text", text: "on it" }]);
    const own = reduceEvent(held, { type: "session.steer", ...A, prompt: "and pineapple" }, T0);
    expect(own.events.at(-1)).toMatchObject({ type: "session.steer", prompt: "and pineapple" });
    const other = reduceEvent(held, { type: "session.steer", ...B, prompt: "elsewhere" }, T0);
    expect(other.events).toHaveLength(2);
    const pending = { ...held, sending: { after: "turn_a" }, pendingPrompt: { text: "next", requestId: REQ, at: T0 } };
    const strayed = reduceEvent(pending, { type: "session.steer", ...B, prompt: "elsewhere" }, T0);
    expect(strayed.events).toHaveLength(2);
    expect(strayed.sending).toEqual({ after: "turn_a" });
    expect(strayed.known).toEqual(["thr_b"]);
  });

  it("a session.notify of the held thread lands in it as its turn's event; another thread's is dropped", () => {
    const held = state([{ type: "session.start", ...A, prompt: "build it" }, { type: "session.done", ...A, result: { status: "completed", text: "all green" } }]);
    const own = reduceEvent(held, { type: "session.notify", ...A, notify: "thr_parent", text: "thread thr_a finished (completed): all green" }, T0);
    expect(own.events.at(-1)).toMatchObject({ type: "session.notify", notify: "thr_parent" });
    const other = reduceEvent(held, { type: "session.notify", ...B, notify: "me", text: "thread thr_b finished (completed): x" }, T0);
    expect(other.events).toHaveLength(2);
  });

  it("a fresh view with a send pending never takes a steer for its own send: only a start or a death does", () => {
    const fresh = state([], { fresh: true, sending: { after: undefined }, pendingPrompt: { text: "first", requestId: REQ, at: T0 } });
    const next = reduceEvent(fresh, { type: "session.steer", ...B, prompt: "elsewhere" }, T0);
    expect(next.events).toEqual([]);
    expect(next.sending).toEqual({ after: undefined });
    expect(next.fresh).toBe(true);
  });
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
    const view = deriveChatThread(state(CHAT_STREAM, { pendingPrompt: { text: "next", at: T0, requestId: REQ }, localErrors: [{ message: "socket closed", at: T0 }] }));
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

describe("startedSession", () => {
  const dead = { workspaceId: CHAT_WS, sessionId: "local_0002", turnId: "turn_0002" };
  const DEATH: SessionEvent[] = [
    { type: "session.done", ...dead, result: { status: "failed", error: "claude exited before init" } },
    { type: "session.end", ...dead, exitCode: 1, sawResult: true },
  ];

  it("names the session of the last session.start; a turn that ended without one names nothing", () => {
    expect(startedSession(CHAT_STREAM)).toBe("sess_0001");
    expect(startedSession(DEATH)).toBeUndefined();
    expect(startedSession([])).toBeUndefined();
  });

  it("a death before init on a thread that has a started turn keeps that turn's session", () => {
    expect(startedSession([...CHAT_STREAM, ...DEATH])).toBe("sess_0001");
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
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], stale: A_TURN, pendingPrompt: { text: "start over", at: T0, requestId: REQ } });
    const next = reloadTranscript(fresh, A, T0);
    expect(next).toEqual({ ...fresh, stale: null });
  });

  it("while fresh, a left thread still running keeps its turn as the stale one", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], stale: A_TURN });
    expect(reloadTranscript(fresh, A_RUNNING, T0)).toEqual({ ...fresh, stale: A_TURN });
  });

  it("while fresh with a send in flight, a thread with an id the left one did not have, its start carrying the sent prompt, is the person's own and loads as such", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], sending: { after: undefined }, pendingPrompt: { text: "start over", at: T0, requestId: REQ } });
    const next = reloadTranscript(fresh, [...A, ...B_RUNNING], T0);
    expect(next.events).toEqual(B_RUNNING);
    expect(next.fresh).toBe(false);
    expect(next.pendingPrompt).toBeNull();
    expect(next.stale).toBeNull();
    expect(next.left).toBeUndefined();
  });

  it("while fresh, the left thread alone decides the stale record when the person's thread is present", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], stale: A_TURN, sending: { after: undefined }, pendingPrompt: { text: "start over", at: T0, requestId: REQ } });
    const next = reloadTranscript(fresh, [...A_RUNNING, ...B_RUNNING], T0);
    expect(next.events).toEqual(B_RUNNING);
    expect(next.stale).toEqual(A_TURN);
  });

  it("while fresh from an empty thread, a new id whose start carries the sent prompt is the person's own; a legacy thread is the left one", () => {
    const fresh = state([], { fresh: true, left: undefined });
    const sending = { ...fresh, sending: { after: undefined }, pendingPrompt: { text: "start over", at: T0, requestId: REQ } };
    expect(reloadTranscript(sending, B_RUNNING, T0).events).toEqual(B_RUNNING);
    expect(reloadTranscript(fresh, B_RUNNING, T0).events).toEqual([]);
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
    const own = reloadTranscript(state([], { fresh: true, left: "thr_a", known: ["thr_a"], sending: { after: undefined }, pendingPrompt: { text: "start over", at: T0, requestId: REQ } }), [...A, ...B_RUNNING], T0);
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

  it("while fresh with a send in flight, a reply that holds the person's thread settles the send and names the workspace key its rows waited under; a quiet reply keeps the send and its prompt", () => {
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], sending: { after: undefined }, pendingPrompt: { text: "start over", at: T0, requestId: REQ } });
    const own = reloadTranscript(fresh, [...A, ...B_RUNNING], T0);
    expect(own.events).toEqual(B_RUNNING);
    expect(own.sending).toBeNull();
    expect(own.pendingPrompt).toBeNull();
    expect(own.named).toEqual({ key: CHAT_WS, thread: "thr_b" });
    const waiting = reloadTranscript(fresh, A, T0);
    expect(waiting.sending).toEqual({ after: undefined });
    expect(waiting.pendingPrompt).toEqual({ text: "start over", at: T0, requestId: REQ });
    expect(waiting.named).toBeNull();
  });

  it("a view showing a dead thread with a send in flight folds a reply to that thread: the retry's start under it settles the send, a thread the view never knew with the sent prompt is another client's; a view showing none takes the thread whose start carries the prompt", () => {
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const DEAD: SessionEvent[] = [
      { type: "session.done", ...x, result: { status: "failed", error: "claude exited before init" } },
      { type: "session.end", ...x, exitCode: 1, sawResult: true },
    ];
    const x2 = { workspaceId: CHAT_WS, sessionId: "sess_x2", turnId: "turn_x2", threadId: "thr_x" };
    const X_RETRY: SessionEvent[] = [
      { type: "session.start", ...x2, prompt: "retry" },
      { type: "session.delta", ...x2, kind: "text", text: "Second time lucky." },
    ];
    const X_DEAD_AGAIN: SessionEvent[] = [
      { type: "session.done", ...x2, result: { status: "failed", error: "claude exited before init" } },
      { type: "session.end", ...x2, exitCode: 1, sawResult: true },
    ];
    const z = { workspaceId: CHAT_WS, sessionId: "sess_z", turnId: "turn_z1", threadId: "thr_z" };
    const Z_RUNNING: SessionEvent[] = [
      { type: "session.start", ...z, prompt: "retry" },
      { type: "session.delta", ...z, kind: "text", text: "Second time lucky." },
    ];
    const send = { sending: { after: "turn_x1" }, pendingPrompt: { text: "retry", at: T0, requestId: REQ } };

    const latest = state(DEAD, { known: ["thr_a", "thr_x"], ...send });
    const elsewhere = reloadTranscript(latest, [...A, ...DEAD, ...B_DONE, ...Z_RUNNING], T0);
    expect(elsewhere.events).toEqual(DEAD);
    expect(elsewhere.sending).toEqual(send.sending);
    expect(elsewhere.pendingPrompt).toEqual(send.pendingPrompt);
    expect(elsewhere.named).toBeNull();
    expect(elsewhere.known).toEqual(["thr_a", "thr_x", "thr_b", "thr_z"]);
    const own = reloadTranscript(latest, [...A, ...DEAD, ...B_DONE, ...X_RETRY], T0);
    expect(own.events).toEqual([...DEAD, ...X_RETRY]);
    expect(own.sending).toBeNull();
    expect(own.pendingPrompt).toBeNull();
    expect(own.named).toEqual({ key: CHAT_WS, thread: "thr_x" });
    const diedAgain = reloadTranscript(latest, [...A, ...DEAD, ...B_DONE, ...X_DEAD_AGAIN], T0);
    expect(diedAgain.events).toEqual([...DEAD, ...X_DEAD_AGAIN]);
    expect(diedAgain.sending).toBeNull();
    expect(diedAgain.named).toBeNull();
    expect(reloadTranscript(state(DEAD, { known: ["thr_a", "thr_x"] }), [...A, ...DEAD, ...B_DONE], T0).events).toEqual(B_DONE);

    const empty = state([], send);
    expect(reloadTranscript(empty, B_DONE, T0)).toMatchObject({ events: [], ...send, known: ["thr_b"] });
    expect(reloadTranscript(empty, [...B_DONE, ...Z_RUNNING], T0).events).toEqual(Z_RUNNING);
    expect(reloadTranscript(state([]), B_DONE, T0).events).toEqual(B_DONE);

    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], ...send, sending: { after: undefined } });
    const stillFresh = reloadTranscript(fresh, [...A, ...B_DONE], T0);
    expect(stillFresh).toEqual({ ...fresh, known: ["thr_a", "thr_b"] });
    const opened = reloadTranscript(fresh, [...A, ...B_DONE, ...Z_RUNNING], T0);
    expect(opened.events).toEqual(Z_RUNNING);
    expect(opened.fresh).toBe(false);
    expect(opened.named).toEqual({ key: CHAT_WS, thread: "thr_z" });
    const died = reloadTranscript(fresh, [...A, ...B_DONE, ...DEAD], T0);
    expect(died.events).toEqual(DEAD);
    expect(died.sending).toBeNull();
  });

  it("two clients sending the same text: a reply folds a view showing a dead thread to that thread whatever the request ids, a start elsewhere with the send's own id included; a view showing none follows the start carrying the send's request id, and a start with no id folds by the prompt", () => {
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const DEAD: SessionEvent[] = [
      { type: "session.done", ...x, result: { status: "failed", error: "claude exited before init" } },
      { type: "session.end", ...x, exitCode: 1, sawResult: true },
    ];
    const c = { workspaceId: CHAT_WS, sessionId: "sess_c", turnId: "turn_c1", threadId: "thr_c" };
    const OTHER_RUNNING: SessionEvent[] = [
      { type: "session.start", ...c, prompt: "retry", requestId: "req_other" },
      { type: "session.delta", ...c, kind: "text", text: "Elsewhere." },
    ];
    const z = { workspaceId: CHAT_WS, sessionId: "sess_z", turnId: "turn_z1", threadId: "thr_z" };
    const Z_RUNNING: SessionEvent[] = [
      { type: "session.start", ...z, prompt: "retry", requestId: REQ },
      { type: "session.delta", ...z, kind: "text", text: "Second time lucky." },
    ];
    const x2 = { workspaceId: CHAT_WS, sessionId: "sess_x2", turnId: "turn_x2", threadId: "thr_x" };
    const X_RETRY: SessionEvent[] = [
      { type: "session.start", ...x2, prompt: "retry", requestId: REQ },
      { type: "session.delta", ...x2, kind: "text", text: "Second time lucky." },
    ];
    const send = { sending: { after: "turn_x1" }, pendingPrompt: { text: "retry", at: T0, requestId: REQ } };

    const latest = state(DEAD, { known: ["thr_a", "thr_x"], ...send });
    const elsewhere = reloadTranscript(latest, [...A, ...DEAD, ...OTHER_RUNNING, ...Z_RUNNING], T0);
    expect(elsewhere.events).toEqual(DEAD);
    expect(elsewhere.sending).toEqual(send.sending);
    expect(elsewhere.named).toBeNull();
    expect(elsewhere.known).toEqual(["thr_a", "thr_x", "thr_c", "thr_z"]);
    const own = reloadTranscript(latest, [...A, ...DEAD, ...OTHER_RUNNING, ...X_RETRY], T0);
    expect(own.events).toEqual([...DEAD, ...X_RETRY]);
    expect(own.sending).toBeNull();
    expect(own.named).toEqual({ key: CHAT_WS, thread: "thr_x" });

    expect(reloadTranscript(latest, [...DEAD, ...A, ...OTHER_RUNNING, ...Z_RUNNING], T0, "thr_x").events).toEqual(DEAD);
    const pinned = reloadTranscript(latest, [...DEAD, ...A, ...OTHER_RUNNING, ...X_RETRY], T0, "thr_x");
    expect(pinned.events).toEqual([...DEAD, ...X_RETRY]);
    expect(pinned.named).toEqual({ key: "thr_x", thread: "thr_x" });

    const BARE_RUNNING: SessionEvent[] = [{ type: "session.start", ...z, prompt: "retry" }, Z_RUNNING[1]!];
    const empty = state([], send);
    expect(reloadTranscript(empty, [...OTHER_RUNNING, ...BARE_RUNNING], T0).events).toEqual(BARE_RUNNING);
    expect(reloadTranscript(empty, OTHER_RUNNING, T0)).toMatchObject({ events: [], ...send, known: ["thr_c"] });
    expect(reloadTranscript(empty, [...OTHER_RUNNING, ...Z_RUNNING], T0).events).toEqual(Z_RUNNING);

    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], ...send, sending: { after: undefined } });
    expect(reloadTranscript(fresh, [...A, ...OTHER_RUNNING], T0)).toEqual({ ...fresh, known: ["thr_a", "thr_c"] });
    const opened = reloadTranscript(fresh, [...A, ...OTHER_RUNNING, ...Z_RUNNING], T0);
    expect(opened.events).toEqual(Z_RUNNING);
    expect(opened.fresh).toBe(false);
    expect(opened.named).toEqual({ key: CHAT_WS, thread: "thr_z" });
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

  it("a pending send left behind takes its stale turn from the left thread or one the view never knew, not from a known thread another client runs", () => {
    const pending = state([], { fresh: true, left: "thr_a", known: ["thr_a", "thr_b"], stale: { kind: "pending-send", after: "turn_0001" } });
    expect(reloadTranscript(pending, [...A, ...B_RUNNING], T0).stale).toEqual({ kind: "pending-send", after: "turn_0001" });
    const a2 = { workspaceId: CHAT_WS, sessionId: "sess_0001", turnId: "turn_0002", threadId: "thr_a" };
    expect(reloadTranscript(pending, [...A, ...B_DONE, { type: "session.start", ...a2, prompt: "one" }], T0).stale).toEqual({ kind: "turn", turnId: "turn_0002", sessionId: "sess_0001" });
    const z = { workspaceId: CHAT_WS, sessionId: "sess_z", turnId: "turn_z1", threadId: "thr_z" };
    expect(reloadTranscript(pending, [...A, ...B_DONE, { type: "session.start", ...z, prompt: "one" }], T0).stale).toEqual({ kind: "turn", turnId: "turn_z1", sessionId: "sess_z" });
  });

  it("a pinned thread whose harness died before its start keeps the pin through a send: a reply's retry under it settles the send and names the rows under the pin; another thread's start, known or not, and a quiet reply keep the send, and a started pin keeps its own", () => {
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const DEAD: SessionEvent[] = [
      { type: "session.done", ...x, result: { status: "failed", error: "claude exited before init" } },
      { type: "session.end", ...x, exitCode: 1, sawResult: true },
    ];
    const x2 = { workspaceId: CHAT_WS, sessionId: "sess_x2", turnId: "turn_x2", threadId: "thr_x" };
    const X_RETRY: SessionEvent[] = [
      { type: "session.start", ...x2, prompt: "start over" },
      { type: "session.delta", ...x2, kind: "text", text: "Second time lucky." },
    ];
    const idle = reloadTranscript(state([], { known: ["thr_a"] }), [...DEAD, ...A], T0, "thr_x");
    expect(idle.events).toEqual(DEAD);
    const sending = { ...idle, sending: { after: "turn_x1" }, pendingPrompt: { text: "start over", at: T0, requestId: REQ } };
    const next = reloadTranscript(sending, [...DEAD, ...A, ...X_RETRY], T0, "thr_x");
    expect(next.events).toEqual([...DEAD, ...X_RETRY]);
    expect(next.sending).toBeNull();
    expect(next.pendingPrompt).toBeNull();
    expect(next.named).toEqual({ key: "thr_x", thread: "thr_x" });
    const quiet = reloadTranscript(sending, [...DEAD, ...A], T0, "thr_x");
    expect(quiet.events).toEqual(DEAD);
    expect(quiet.sending).toEqual({ after: "turn_x1" });
    expect(quiet.pendingPrompt).toEqual({ text: "start over", at: T0, requestId: REQ });
    const elsewhere = reloadTranscript(sending, [...DEAD, ...A, ...B_DONE], T0, "thr_x");
    expect(elsewhere.events).toEqual(DEAD);
    expect(elsewhere.sending).toEqual({ after: "turn_x1" });
    expect(elsewhere.named).toBeNull();
    expect(elsewhere.known).toEqual(["thr_a", "thr_x", "thr_b"]);
    expect(reloadTranscript({ ...sending, known: ["thr_a", "thr_b", "thr_x"] }, [...DEAD, ...A, ...B_DONE], T0, "thr_x").events).toEqual(DEAD);
    const pinnedA = reloadTranscript(state(A, { known: ["thr_a"], sending: { after: "turn_0001" } }), [...A, ...B_DONE], T0, "thr_a");
    expect(pinnedA.events).toEqual(A);
    expect(pinnedA.sending).toEqual({ after: "turn_0001" });
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

  it("while fresh, a delta from any thread is dropped: only the session.start carrying the sent prompt opens the person's own thread", () => {
    const fresh = state([], { fresh: true, left: "thr_a", sending: { after: undefined }, pendingPrompt: { text: "start over", at: T0, requestId: REQ } });
    expect(reduceEvent(fresh, B_DELTA, T0).events).toEqual([]);
    expect(reduceEvent(fresh, CHAT_STREAM[1]!, T0)).toBe(fresh);
    expect(reduceEvent(fresh, B_START, T0).events).toEqual([B_START]);
    const c = { workspaceId: CHAT_WS, sessionId: "sess_c", turnId: "turn_c1", threadId: "thr_c" };
    const otherTab = reduceEvent(fresh, { type: "session.start", ...c, prompt: "from another tab" }, T0);
    expect(otherTab.events).toEqual([]);
    expect(otherTab.sending).toEqual({ after: undefined });
    expect(otherTab.known).toEqual(["thr_c"]);
    expect(reduceEvent(otherTab, { type: "session.delta", ...c, kind: "text", text: "Elsewhere." }, T0)).toBe(otherTab);
    expect(reduceEvent(otherTab, B_START, T0).events).toEqual([B_START]);
    const idle = state([], { fresh: true, left: "thr_a" });
    expect(reduceEvent(idle, B_START, T0).events).toEqual([]);
    expect(reduceEvent(idle, B_START, T0).known).toEqual(["thr_b"]);
  });

  it("while fresh, the next session.start opens the thread and the left turn's end still clears the stale record", () => {
    const fresh = state([], { fresh: true, left: "thr_a", stale: A_TURN, sending: { after: undefined }, pendingPrompt: { text: "start over", at: T0, requestId: REQ } });
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
    const sending = state([], { sending: { after: undefined }, pendingPrompt: { text: "start over", at: T0, requestId: REQ } });
    expect(reduceEvent(sending, B_START, T0).named).toEqual({ key: CHAT_WS, thread: "thr_b" });
    expect(reduceEvent(sending, CHAT_STREAM[0]!, T0).named).toEqual({ key: CHAT_WS, thread: CHAT_WS });
    expect(reduceEvent(state([]), B_START, T0).named).toBeNull();
    const stamped = state(A, { sending: { after: "turn_0001" } });
    expect(reduceEvent(stamped, { type: "session.start", ...b, threadId: "thr_a" }, T0).named).toEqual({ key: "thr_a", thread: "thr_a" });
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_a" };
    expect(reduceEvent(stamped, { type: "session.end", ...x, exitCode: 127, sawResult: true }, T0).named).toBeNull();
  });

  it("a view whose harness died before its start shows that thread: the retry's start lands under it and names the rows the workspace id waited under; another thread's start is dropped", () => {
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const died = reduceEvent(state([], { sending: { after: undefined } }), { type: "session.end", ...x, exitCode: 127, sawResult: true }, T0);
    expect(died.events).toHaveLength(1);
    expect(died.sending).toBeNull();
    const sending = { ...died, sending: { after: "turn_x1" }, pendingPrompt: { text: "start over", at: T0, requestId: REQ } };
    const elsewhere = reduceEvent(sending, B_START, T0);
    expect(elsewhere.events).toEqual(died.events);
    expect(elsewhere.sending).toEqual({ after: "turn_x1" });
    expect(elsewhere.known).toEqual(["thr_b"]);
    const x2 = { workspaceId: CHAT_WS, sessionId: "sess_x2", turnId: "turn_x2", threadId: "thr_x" };
    const started = reduceEvent(elsewhere, { type: "session.start", ...x2, prompt: "start over" }, T0);
    expect(started.events).toHaveLength(2);
    expect(started.sending).toBeNull();
    expect(started.pendingPrompt).toBeNull();
    expect(started.named).toEqual({ key: CHAT_WS, thread: "thr_x" });
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

  it("a view whose last thread has no start admits only that thread's events, a send in flight included: the retry's start under it settles the send, a thread it does not know is another client's whatever its prompt", () => {
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
    const sending = { ...dead, sending: { after: "turn_x1" }, pendingPrompt: { text: "retry", at: T0, requestId: REQ } };
    expect(reduceEvent(sending, { type: "session.start", ...b, threadId: "thr_a" }, T0)).toBe(sending);
    const c = { workspaceId: CHAT_WS, sessionId: "sess_c", turnId: "turn_c1", threadId: "thr_c" };
    const otherTab = reduceEvent(sending, { type: "session.start", ...c, prompt: "from another tab" }, T0);
    expect(otherTab.events).toEqual(deadEvents);
    expect(otherTab.sending).toEqual({ after: "turn_x1" });
    expect(otherTab.known).toEqual(["thr_a", "thr_b", "thr_x", "thr_c"]);
    expect(reduceEvent(otherTab, { type: "session.delta", ...c, kind: "text", text: "Elsewhere." }, T0)).toBe(otherTab);
    const z = { workspaceId: CHAT_WS, sessionId: "sess_z", turnId: "turn_z1", threadId: "thr_z" };
    const sameText = reduceEvent(otherTab, { type: "session.start", ...z, prompt: "retry" }, T0);
    expect(sameText.events).toEqual(deadEvents);
    expect(sameText.sending).toEqual({ after: "turn_x1" });
    expect(sameText.known).toEqual(["thr_a", "thr_b", "thr_x", "thr_c", "thr_z"]);
    const x2 = { workspaceId: CHAT_WS, sessionId: "sess_x2", turnId: "turn_x2", threadId: "thr_x" };
    const started = reduceEvent(sameText, { type: "session.start", ...x2, prompt: "retry" }, T0);
    expect(started.events).toHaveLength(3);
    expect(started.sending).toBeNull();
    expect(started.named).toEqual({ key: CHAT_WS, thread: "thr_x" });
    expect(reduceEvent(started, { type: "session.delta", ...x2, kind: "text", text: "Second time lucky." }, T0).events).toHaveLength(4);
    expect(reduceEvent(started, { type: "session.end", ...c, exitCode: 0, sawResult: true }, T0)).toBe(started);
    const diedAgain = reduceEvent(sending, { type: "session.end", ...x2, exitCode: 127, sawResult: true }, T0);
    expect(diedAgain.events).toHaveLength(3);
    expect(diedAgain.sending).toBeNull();
    expect(reduceEvent(sending, { type: "session.end", ...z, exitCode: 127, sawResult: true }, T0).sending).toEqual({ after: "turn_x1" });
  });

  it("a pinned thread whose harness died before its start keeps the pin through a send: the retry's start under it settles the send and names the rows under the pin; an empty pin holds its own thread and its retry the same way", () => {
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const deadEvents: SessionEvent[] = [
      { type: "session.done", ...x, result: { status: "failed", error: "claude exited before init" } },
      { type: "session.end", ...x, exitCode: 1, sawResult: true },
    ];
    const dead = state(deadEvents, { known: ["thr_a", "thr_x"] });
    expect(reduceEvent(dead, A[1]!, T0, "thr_x")).toBe(dead);
    const sending = { ...dead, sending: { after: "turn_x1" }, pendingPrompt: { text: "retry", at: T0, requestId: REQ } };
    expect(reduceEvent(sending, A[1]!, T0, "thr_x")).toBe(sending);
    const c = { workspaceId: CHAT_WS, sessionId: "sess_c", turnId: "turn_c1", threadId: "thr_c" };
    const otherTab = reduceEvent(sending, { type: "session.start", ...c, prompt: "from another tab" }, T0, "thr_x");
    expect(otherTab.events).toEqual(deadEvents);
    expect(otherTab.sending).toEqual({ after: "turn_x1" });
    expect(otherTab.named).toBeNull();
    expect(otherTab.known).toEqual(["thr_a", "thr_x", "thr_c"]);
    const z = { workspaceId: CHAT_WS, sessionId: "sess_z", turnId: "turn_z1", threadId: "thr_z" };
    const sameText = reduceEvent(otherTab, { type: "session.start", ...z, prompt: "retry" }, T0, "thr_x");
    expect(sameText.events).toEqual(deadEvents);
    expect(sameText.sending).toEqual({ after: "turn_x1" });
    expect(sameText.named).toBeNull();
    const x2 = { workspaceId: CHAT_WS, sessionId: "sess_x2", turnId: "turn_x2", threadId: "thr_x" };
    const started = reduceEvent(sameText, { type: "session.start", ...x2, prompt: "retry" }, T0, "thr_x");
    expect(started.events).toHaveLength(3);
    expect(started.sending).toBeNull();
    expect(started.named).toEqual({ key: "thr_x", thread: "thr_x" });
    expect(reduceEvent(started, { type: "session.delta", ...x2, kind: "text", text: "Second time lucky." }, T0, "thr_x").events).toHaveLength(4);
    expect(reduceEvent(started, { type: "session.delta", ...z, kind: "text", text: "Elsewhere." }, T0, "thr_x")).toBe(started);
    const empty = state([], { known: ["thr_a"] });
    expect(reduceEvent(empty, A[0]!, T0, "thr_x")).toBe(empty);
    expect(reduceEvent(empty, deadEvents[0]!, T0, "thr_x").events).toHaveLength(1);
    const emptySending = { ...empty, sending: { after: undefined }, pendingPrompt: { text: "retry", at: T0, requestId: REQ } };
    expect(reduceEvent(emptySending, { type: "session.start", ...z, prompt: "retry" }, T0, "thr_x").events).toEqual([]);
    const emptyStarted = reduceEvent(emptySending, { type: "session.start", ...x2, prompt: "retry" }, T0, "thr_x");
    expect(emptyStarted.events).toHaveLength(1);
    expect(emptyStarted.named).toEqual({ key: "thr_x", thread: "thr_x" });
  });

  it("two clients sending the same text: on a view showing a dead thread every start under it is the thread's, whatever its request id, and a start elsewhere is not, the send's own id included; on a view showing none a start stamped with another request id is another client's whatever its prompt, the start stamped with the send's own id is the send's whatever its prompt, and a start with no id is told by the prompt", () => {
    const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
    const deadEvents: SessionEvent[] = [
      { type: "session.done", ...x, result: { status: "failed", error: "claude exited before init" } },
      { type: "session.end", ...x, exitCode: 1, sawResult: true },
    ];
    const c = { workspaceId: CHAT_WS, sessionId: "sess_c", turnId: "turn_c1", threadId: "thr_c" };
    const z = { workspaceId: CHAT_WS, sessionId: "sess_z", turnId: "turn_z1", threadId: "thr_z" };
    const otherStart: SessionEvent = { type: "session.start", ...c, prompt: "retry", requestId: "req_other" };
    const ownStart: SessionEvent = { type: "session.start", ...z, prompt: "retry", requestId: REQ };
    const send = { sending: { after: "turn_x1" }, pendingPrompt: { text: "retry", at: T0, requestId: REQ } };
    const x2 = { workspaceId: CHAT_WS, sessionId: "sess_x2", turnId: "turn_x2", threadId: "thr_x" };
    const deadViews: ReadonlyArray<[ThreadState, string | null]> = [
      [state(deadEvents, { known: ["thr_a", "thr_x"], ...send }), null],
      [state(deadEvents, { known: ["thr_a", "thr_x"], ...send }), "thr_x"],
    ];
    for (const [view, pin] of deadViews) {
      const elsewhere = reduceEvent(reduceEvent(view, otherStart, T0, pin), ownStart, T0, pin);
      expect(elsewhere.events).toEqual(deadEvents);
      expect(elsewhere.sending).toEqual(send.sending);
      expect(elsewhere.named).toBeNull();
      expect(elsewhere.known).toEqual(["thr_a", "thr_x", "thr_c", "thr_z"]);
      const own = reduceEvent(elsewhere, { type: "session.start", ...x2, prompt: "retry", requestId: REQ }, T0, pin);
      expect(own.events).toHaveLength(3);
      expect(own.sending).toBeNull();
      expect(own.named).toEqual({ key: pin ?? CHAT_WS, thread: "thr_x" });
      const theirs = reduceEvent(elsewhere, { type: "session.start", ...x2, prompt: "something else", requestId: "req_other" }, T0, pin);
      expect(theirs.events).toHaveLength(3);
      expect(theirs.sending).toBeNull();
      expect(theirs.named).toEqual({ key: pin ?? CHAT_WS, thread: "thr_x" });
    }
    const views: ReadonlyArray<[ThreadState, string | null]> = [
      [state([], { known: ["thr_a"], ...send }), null],
      [state([], { fresh: true, left: "thr_a", known: ["thr_a"], ...send, sending: { after: undefined } }), null],
    ];
    for (const [view, pin] of views) {
      const other = reduceEvent(view, otherStart, T0, pin);
      expect(other.events).toEqual(view.events);
      expect(other.sending).toEqual(view.sending);
      expect(other.named).toBeNull();
      expect(other.known).toContain("thr_c");
      expect(reduceEvent(other, { type: "session.delta", ...c, kind: "text", text: "Elsewhere." }, T0, pin)).toBe(other);
      const own = reduceEvent(other, ownStart, T0, pin);
      expect(own.events.at(-1)).toEqual(ownStart);
      expect(own.sending).toBeNull();
      expect(own.named).toEqual({ key: pin ?? CHAT_WS, thread: "thr_z" });
      expect(reduceEvent(other, { ...ownStart, prompt: "edited on the way" }, T0, pin).sending).toBeNull();
      expect(reduceEvent(other, { type: "session.start", ...z, prompt: "retry" }, T0, pin).sending).toBeNull();
      const otherText = reduceEvent(other, { type: "session.start", ...z, prompt: "something else" }, T0, pin);
      expect(otherText.sending).toEqual(view.sending);
      expect(otherText.known).toContain("thr_z");
    }
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
  const stray = { text: "first", requestId: REQ, key: CHAT_WS };
  const pinned = state(A, { known: ["thr_a"], stray });

  const n = { workspaceId: CHAT_WS, sessionId: "sess_n", turnId: "turn_n1", threadId: "thr_n" };
  const c = { workspaceId: CHAT_WS, sessionId: "sess_c", turnId: "turn_c1", threadId: "thr_c" };
  const x = { workspaceId: CHAT_WS, sessionId: "sess_x", turnId: "turn_x1", threadId: "thr_x" };
  const N_START: SessionEvent = { type: "session.start", ...n, prompt: "first" };
  const here = { workspaceId: CHAT_WS, threadId: null };
  const deadEvents: SessionEvent[] = [
    { type: "session.done", ...x, result: { status: "failed", error: "claude exited before init" } },
    { type: "session.end", ...x, exitCode: 1, sawResult: true },
  ];

  it("leaving a start-less view mid-send carries the send with the key its rows waited under, the workspace id from the latest view and the pin from a pinned one, and the thread the view showed, which its start comes under; a started view or an idle one carries nothing", () => {
    const inFlight = { sending: { after: "turn_x1" }, pendingPrompt: { text: "first", at: T0, requestId: REQ } };
    const fromLatest = leaveView(state([], { known: ["thr_a"], ...inFlight }), here, { ...here, threadId: "thr_a" });
    expect(fromLatest).toEqual(state([], { known: ["thr_a"], stray }));
    const fromDeadLatest = leaveView(state(deadEvents, { known: ["thr_a"], ...inFlight }), here, { ...here, threadId: "thr_a" });
    expect(fromDeadLatest).toEqual(state([], { known: ["thr_a", "thr_x"], stray: { text: "first", requestId: REQ, key: CHAT_WS, thread: "thr_x" } }));
    const fromPin = leaveView(state(deadEvents, { known: ["thr_a", "thr_x"], ...inFlight }), { ...here, threadId: "thr_x" }, { ...here, threadId: "thr_a" });
    expect(fromPin).toEqual(state([], { known: ["thr_a", "thr_x"], stray: { text: "first", requestId: REQ, key: "thr_x", thread: "thr_x" } }));
    const fromEmptyPin = leaveView(state([], { known: ["thr_a"], ...inFlight }), { ...here, threadId: "thr_x" }, here);
    expect(fromEmptyPin.stray).toEqual({ text: "first", requestId: REQ, key: "thr_x", thread: "thr_x" });
    expect(leaveView(state(A, { known: ["thr_a"], ...inFlight }), { ...here, threadId: "thr_a" }, here).stray).toBeNull();
    expect(leaveView(state(deadEvents, { known: ["thr_x"] }), { ...here, threadId: "thr_x" }, here).stray).toBeNull();
    expect(leaveView(state([], { known: ["thr_a"], stray }), here, { ...here, threadId: "thr_a" }).stray).toEqual(stray);
    expect(leaveView(state([], { known: ["thr_a"], stray, ...inFlight }), { ...here, threadId: "thr_a" }, { workspaceId: "ws_other", threadId: null })).toEqual(state([]));
  });

  it("the start of a send left from a dead view comes under that thread and names the rows under their key, the pin or the workspace id, on whichever view sees it; a new thread's start with the prompt is another client's", () => {
    const x2 = { workspaceId: CHAT_WS, sessionId: "sess_x2", turnId: "turn_x2", threadId: "thr_x" };
    const X_START: SessionEvent = { type: "session.start", ...x2, prompt: "first" };
    const fromPin = { text: "first", requestId: REQ, key: "thr_x", thread: "thr_x" };
    const dropped = dropEvent(state(A, { known: ["thr_a", "thr_x"], stray: fromPin }), X_START);
    expect(dropped.stray).toBeNull();
    expect(dropped.named).toEqual({ key: "thr_x", thread: "thr_x" });
    const held = reduceEvent(state([], { fresh: true, left: "thr_a", known: ["thr_a", "thr_x"], stray: fromPin }), X_START, T0);
    expect(held.events).toEqual([]);
    expect(held.stray).toBeNull();
    expect(held.named).toEqual({ key: "thr_x", thread: "thr_x" });
    const replayed = reloadTranscript(state([], { known: ["thr_a", "thr_x"], stray: fromPin }), [...deadEvents, ...A, X_START], T0, "thr_a");
    expect(replayed.events).toEqual(A);
    expect(replayed.named).toEqual({ key: "thr_x", thread: "thr_x" });
    const newThread = dropEvent(state(A, { known: ["thr_a", "thr_x"], stray: fromPin }), N_START);
    expect(newThread.stray).toEqual(fromPin);
    expect(newThread.named).toBeNull();
    expect(newThread.known).toEqual(["thr_a", "thr_x", "thr_n"]);
    const fromDeadLatest = { text: "first", requestId: REQ, key: CHAT_WS, thread: "thr_x" };
    const rekeyed = dropEvent(state(A, { known: ["thr_a", "thr_x"], stray: fromDeadLatest }), X_START);
    expect(rekeyed.stray).toBeNull();
    expect(rekeyed.named).toEqual({ key: CHAT_WS, thread: "thr_x" });
    expect(dropEvent(state(A, { known: ["thr_a", "thr_x"], stray: fromDeadLatest }), N_START).stray).toEqual(fromDeadLatest);
  });

  it("a send left from a pinned thread that resumed its row, or named it after a failed launch, starts under that same thread: its start settles it without moving the rows, and another thread's start with the prompt under a known id does not", () => {
    const fromPin = { text: "first", requestId: REQ, key: "thr_x", thread: "thr_x" };
    const resumed = dropEvent(state(A, { known: ["thr_a", "thr_x"], stray: fromPin }), { type: "session.start", ...x, prompt: "first" });
    expect(resumed.stray).toBeNull();
    expect(resumed.named).toEqual({ key: "thr_x", thread: "thr_x" });
    const other = dropEvent(state(A, { known: ["thr_a", "thr_x", "thr_c"], stray: fromPin }), { type: "session.start", ...c, prompt: "first" });
    expect(other.stray).toEqual(fromPin);
    expect(other.named).toBeNull();
    const fresh = reduceEvent(state([], { fresh: true, left: "thr_a", known: ["thr_a", "thr_x"], stray: fromPin }), { type: "session.start", ...x, prompt: "first" }, T0);
    expect(fresh.events).toEqual([]);
    expect(fresh.fresh).toBe(true);
    expect(fresh.stray).toBeNull();
    expect(fresh.named).toEqual({ key: "thr_x", thread: "thr_x" });
  });

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

  it("two clients sending the same text: a stray is settled only by the start stamped with its request id; another client's same-text start under another id is remembered, not taken, on whichever view sees it", () => {
    const otherStart: SessionEvent = { type: "session.start", ...c, prompt: "first", requestId: "req_other" };
    const ownStart: SessionEvent = { type: "session.start", ...n, prompt: "first", requestId: REQ };
    const other = dropEvent(pinned, otherStart);
    expect(other.stray).toEqual(stray);
    expect(other.named).toBeNull();
    expect(other.known).toEqual(["thr_a", "thr_c"]);
    const landed = dropEvent(other, ownStart);
    expect(landed.stray).toBeNull();
    expect(landed.named).toEqual({ key: CHAT_WS, thread: "thr_n" });
    const fresh = state([], { fresh: true, left: "thr_a", known: ["thr_a"], stray });
    expect(reduceEvent(fresh, otherStart, T0)).toMatchObject({ events: [], stray, named: null });
    expect(reduceEvent(fresh, ownStart, T0)).toMatchObject({ events: [ownStart], stray: null, named: { key: CHAT_WS, thread: "thr_n" } });
    const replayed = reloadTranscript(state([], { known: ["thr_a"], stray }), [...A, otherStart, ownStart], T0, "thr_a");
    expect(replayed.stray).toBeNull();
    expect(replayed.named).toEqual({ key: CHAT_WS, thread: "thr_n" });
    const fromPin = { text: "first", requestId: REQ, key: "thr_x", thread: "thr_x" };
    expect(dropEvent(state(A, { known: ["thr_a", "thr_x"], stray: fromPin }), { type: "session.start", ...x, prompt: "first", requestId: "req_other" }).stray).toEqual(fromPin);
    expect(dropEvent(state(A, { known: ["thr_a", "thr_x"], stray: fromPin }), { type: "session.start", ...x, prompt: "first", requestId: REQ }).named).toEqual({ key: "thr_x", thread: "thr_x" });
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
    expect(known.events).toEqual([]);
    expect(known.stray).toEqual(stray);
    expect(known.named).toBeNull();
    expect(known.known).toEqual(["thr_a", "thr_c"]);
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
