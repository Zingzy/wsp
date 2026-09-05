// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@wsp/protocol";
import { CHAT_STREAM, CHAT_WS } from "../../../test/fixtures/chat-stream";
import { deriveChatThread, reloadTranscript, stabilizeEntries, type StaleTurn, type ThreadState } from "./useChatThread";

const T0 = "2026-09-01T02:00:00.000Z";
const state = (events: ReadonlyArray<SessionEvent>, extra: Partial<ThreadState> = {}): ThreadState => ({
  events,
  arrivals: events.map(() => T0),
  pendingPrompt: null,
  localErrors: [],
  fresh: false,
  stale: null,
  sending: false,
  left: undefined,
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
    const fresh = state([], { fresh: true, left: "thr_a", stale: A_TURN, pendingPrompt: { text: "start over", at: T0 } });
    const next = reloadTranscript(fresh, A, T0);
    expect(next).toEqual({ ...fresh, stale: null });
  });

  it("while fresh, a left thread still running keeps its turn as the stale one", () => {
    const fresh = state([], { fresh: true, left: "thr_a", stale: A_TURN });
    expect(reloadTranscript(fresh, A_RUNNING, T0)).toEqual({ ...fresh, stale: A_TURN });
  });

  it("while fresh, a thread with an id the left one did not have is the person's own and loads as such", () => {
    const fresh = state([], { fresh: true, left: "thr_a", pendingPrompt: { text: "start over", at: T0 } });
    const next = reloadTranscript(fresh, [...A, ...B_RUNNING], T0);
    expect(next.events).toEqual(B_RUNNING);
    expect(next.fresh).toBe(false);
    expect(next.pendingPrompt).toBeNull();
    expect(next.stale).toBeNull();
    expect(next.left).toBeUndefined();
  });

  it("while fresh, the left thread alone decides the stale record when the person's thread is present", () => {
    const fresh = state([], { fresh: true, left: "thr_a", stale: A_TURN });
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
    const pending = state([], { fresh: true, left: undefined, stale: { kind: "pending-send" } });
    expect(reloadTranscript(pending, B_RUNNING, T0)).toEqual({ ...pending, stale: B_TURN });
    expect(reloadTranscript(pending, B_DONE, T0)).toEqual(pending);
  });
});
