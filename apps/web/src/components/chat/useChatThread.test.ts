// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@wsp/protocol";
import { CHAT_STREAM, CHAT_WS } from "../../../test/fixtures/chat-stream";
import { deriveChatThread, stabilizeEntries, type ThreadState } from "./useChatThread";

const T0 = "2026-09-01T02:00:00.000Z";
const state = (events: ReadonlyArray<SessionEvent>, extra: Partial<ThreadState> = {}): ThreadState => ({
  events,
  arrivals: events.map(() => T0),
  pendingPrompt: null,
  localErrors: [],
  fresh: false,
  stale: null,
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
