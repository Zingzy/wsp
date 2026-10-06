// SPDX-License-Identifier: AGPL-3.0-only
// The transcripts a window holds: a thread held from its head and grown by pages, each live event folded once by its
// position, a gap read again for the thread on screen alone, and what is held kept under its byte and thread budget
// by cutting the thread shown longest ago back to its head.
import { describe, expect, it } from "vitest";
import { HEAD_BYTES, type HistoryPage, type SessionEvent, type ThreadFacts, type ThreadHead } from "@wsp/protocol";
import type { Api } from "../../protocol/client";
import { BUDGET_BYTES, BUDGET_THREADS, createTranscripts, eventBytes, overlay } from "./transcripts";

const WS = "ws_t";

function facts(threadId: string, status: ThreadFacts["status"] = "completed", workspaceId = WS): ThreadFacts {
  return { id: `row_${threadId}`, threadId, workspaceId, harness: "claude", startedBy: "person", status, title: threadId, sessionId: `s_${threadId}`, turns: 1, ran: true, model: "claude-opus-5" };
}

/** A host holding one transcript per workspace, positions from one, answering heads and pages as the runtime does. */
function fakeHost(transcript: SessionEvent[] = []) {
  const events = transcript.map((e, i) => ({ ...e, pos: i + 1 }));
  const asked: Array<{ op: "head" | "page"; threadId: string; before?: number }> = [];
  const gates: Array<() => void> = [];
  let held = false;
  const wait = async () => {
    if (held) await new Promise<void>(resolve => gates.push(resolve));
  };
  const newest = () => events.at(-1)?.pos ?? 0;
  const api = {
    sessionHead: async (threadId: string): Promise<ThreadHead> => {
      asked.push({ op: "head", threadId });
      const read = newest();
      const own = events.filter(e => e.threadId === threadId && e.pos <= read);
      await wait();
      return { facts: facts(threadId, "completed", own[0]?.workspaceId ?? WS), events: own.slice(-3).map(e => (e.type === "session.delta" && e.text.length > 10 ? { ...e, text: e.text.slice(0, 10), cut: e.text.length } : e)), pos: read, total: own.length };
    },
    sessionPage: async (_workspaceId: string, threadId: string, window: { before?: number; limit?: number } = {}): Promise<HistoryPage> => {
      asked.push({ op: "page", threadId, ...(window.before === undefined ? {} : { before: window.before }) });
      const read = newest();
      const own = events.filter(e => e.threadId === threadId && e.pos <= read);
      const under = own.filter(e => window.before === undefined || e.pos < window.before);
      await wait();
      return { events: under.slice(-(window.limit ?? 200)), pos: read, total: own.length };
    },
  } as unknown as Api;
  return {
    api,
    asked,
    events,
    /** Records an event as the runtime does, with the next position, and hands it back for the bus. */
    record(e: SessionEvent): SessionEvent {
      const placed = { ...e, pos: newest() + 1 };
      events.push(placed);
      return placed;
    },
    hold() {
      held = true;
    },
    release() {
      held = false;
      for (const go of gates.splice(0)) go();
    },
  };
}

const delta = (threadId: string, text: string, turnId = `t_${threadId}`, workspaceId = WS): SessionEvent => ({ type: "session.delta", workspaceId, sessionId: `s_${threadId}`, turnId, threadId, kind: "text", text });

describe("a thread read from its head and its newest window", () => {
  it("the window lays its whole results over the head's cut ones, and the live events its read missed land once", async () => {
    const host = fakeHost([delta("a", "first words"), delta("a", "a long reply that the head cuts"), delta("b", "other thread")]);
    const store = createTranscripts();
    store.bind(host.api);
    host.hold();
    const opening = store.open(WS, "a");
    // Pushed between the host's read and its reply, as a busy socket does.
    const missed = host.record(delta("a", "said while the read was out"));
    store.apply(missed as never);
    host.release();
    await opening;
    const held = store.get("a")!;
    expect(held.events.map(e => (e.type === "session.delta" ? e.text : e.type))).toEqual(["first words", "a long reply that the head cuts", "said while the read was out"]);
    expect(held.whole).toBe(true);
    expect(held.through).toBe(4);
    expect(host.asked).toEqual([{ op: "page", threadId: "a" }, { op: "head", threadId: "a" }]);
  });

  it("no event is applied twice: a page and the same events off the bus hold one row each", async () => {
    const host = fakeHost([delta("a", "one"), delta("a", "two")]);
    const store = createTranscripts();
    store.bind(host.api);
    await store.open(WS, "a");
    for (const e of host.events) store.apply(e as never);
    expect(store.get("a")!.events.map(e => e.pos)).toEqual([1, 2]);
    expect(host.events.every(e => store.dropped(e))).toBe(true);
    const next = host.record(delta("a", "three"));
    store.apply(next as never);
    store.apply(next as never);
    expect(store.get("a")!.events.map(e => e.pos)).toEqual([1, 2, 3]);
  });

  it("a thread already held whole is opened again with no request", async () => {
    const host = fakeHost([delta("a", "one")]);
    const store = createTranscripts();
    store.bind(host.api);
    await store.open(WS, "a");
    const asked = host.asked.length;
    await store.open(WS, "a");
    expect(host.asked.length).toBe(asked);
  });

  it("older pages prepend until the host has nothing older, one at a time", async () => {
    const host = fakeHost(Array.from({ length: 450 }, (_, i) => delta("a", `line ${i}`)));
    const store = createTranscripts();
    store.bind(host.api);
    await store.open(WS, "a");
    expect(store.get("a")!.events.length).toBe(200);
    const first = store.older("a");
    expect(store.older("a")).toBe(first);
    await first;
    expect(store.get("a")!.events.length).toBe(400);
    await store.older("a");
    const held = store.get("a")!;
    expect(held.events.length).toBe(450);
    expect(held.complete).toBe(true);
    expect(held.events.map(e => e.pos)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
    const asked = host.asked.length;
    await store.older("a");
    expect(host.asked.length).toBe(asked);
  });
});

describe("warming tiles", () => {
  it("reads two heads at a time, and a thread opened meanwhile is asked for at once with no head of warming ahead of it", async () => {
    const tiles = Array.from({ length: 12 }, (_, i) => `w${i}`);
    const host = fakeHost([...tiles.map(id => delta(id, `words of ${id}`)), delta("open", "the thread clicked")]);
    const store = createTranscripts();
    store.bind(host.api);
    host.hold();
    for (const id of tiles) store.warm(id);
    expect(host.asked.map(a => `${a.op} ${a.threadId}`)).toEqual(["head w0", "head w1"]);
    const opening = store.open(WS, "open");
    expect(host.asked.slice(2).map(a => `${a.op} ${a.threadId}`).sort()).toEqual(["head open", "page open"]);
    host.release();
    await opening;
    // Warming held while the open read was out; it goes on once the thread is drawn.
    expect(host.asked.slice(0, 4).filter(a => a.threadId.startsWith("w")).map(a => a.threadId)).toEqual(["w0", "w1"]);
    await new Promise(r => setTimeout(r, 0));
    for (let i = 0; i < 12 && store.weight().threads < 13; i++) await new Promise(r => setTimeout(r, 0));
    expect(store.weight().threads).toBe(13);
    expect(host.asked.filter(a => a.op === "head" && a.threadId.startsWith("w")).map(a => a.threadId)).toEqual(tiles);
  });

  it("a tile that leaves view before its head is read is not read", async () => {
    const host = fakeHost([delta("w0", "a"), delta("w1", "b"), delta("w2", "c")]);
    const store = createTranscripts();
    store.bind(host.api);
    host.hold();
    for (const id of ["w0", "w1", "w2"]) {
      store.see(id, true);
      store.warm(id);
    }
    store.see("w2", false);
    host.release();
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
    expect(host.asked.map(a => a.threadId)).toEqual(["w0", "w1"]);
  });
});

describe("freshness by position", () => {
  it("an event past the next position marks that workspace's threads stale and no other's; the shown one reads one head and one window", async () => {
    const host = fakeHost([delta("a", "a1"), delta("b", "b1"), delta("x", "x1", "t_x", "ws_other")]);
    const store = createTranscripts();
    store.bind(host.api);
    await Promise.all([store.open(WS, "a"), store.open(WS, "b"), store.open("ws_other", "x")]);
    for (const e of host.events) store.apply(e as never);
    host.record(delta("a", "missed"));
    const after = host.record(delta("b", "b2"));
    store.apply(after as never);
    expect(store.get("a")!.stale).toBe("gap");
    expect(store.get("b")!.stale).toBe("gap");
    expect(store.get("x")!.stale).toBe(false);
    host.asked.length = 0;
    await store.open(WS, "a");
    expect(host.asked).toEqual([{ op: "page", threadId: "a" }, { op: "head", threadId: "a" }]);
    const held = store.get("a")!;
    expect(held.stale).toBe(false);
    expect(held.events.map(e => (e.type === "session.delta" ? e.text : ""))).toEqual(["a1", "missed"]);
  });

  it("a re-read after a gap longer than a page never joins the old rows to the new window: every missing event can be paged in", async () => {
    const host = fakeHost(Array.from({ length: 100 }, (_, i) => delta("a", `old ${i}`)));
    const store = createTranscripts();
    store.bind(host.api);
    await store.open(WS, "a");
    for (const e of host.events) store.apply(e as never);
    for (let i = 0; i < 500; i += 1) host.record(delta("a", `unseen ${i}`));
    store.apply(host.record(delta("a", "seen")) as never);
    expect(store.get("a")!.stale).toBe("gap");
    await store.open(WS, "a");
    expect(store.get("a")!.complete).toBe(false);
    for (let k = 0; k < 10 && !store.get("a")!.complete; k += 1) await store.older("a");
    expect(store.get("a")!.events.map(e => e.pos)).toEqual(Array.from({ length: 601 }, (_, i) => i + 1));
  });

  it("a socket the host could not replay to resets every thread, read again from its head when shown", async () => {
    const host = fakeHost([delta("a", "a1")]);
    const store = createTranscripts();
    store.bind(host.api);
    await store.open(WS, "a");
    store.gap();
    expect(store.get("a")!.stale).toBe("reset");
  });
});

describe("the budget", () => {
  /** Twenty threads of about 2 MB each: what a day of builders shown one after another leaves. */
  function bigHost() {
    const text = "x".repeat(10_000);
    const transcript: SessionEvent[] = [];
    for (let t = 0; t < 20; t += 1) for (let i = 0; i < 200; i += 1) transcript.push(delta(`t${t}`, text));
    return fakeHost(transcript);
  }

  it("never holds more than 24 MB of event text or 16 threads past their heads, and cuts the one shown longest ago first", async () => {
    let now = 0;
    const host = bigHost();
    const store = createTranscripts(() => now);
    store.bind(host.api);
    const order: string[] = [];
    for (let t = 0; t < 20; t += 1) {
      const id = `t${t}`;
      now += 1;
      const leave = store.show(id);
      await store.open(WS, id);
      expect(store.get(id)!.bytes).toBeGreaterThan(1_900_000);
      now += 1;
      leave();
      order.push(id);
      const weight = store.weight();
      expect(weight.bytes).toBeLessThanOrEqual(BUDGET_BYTES);
      expect(weight.full).toBeLessThanOrEqual(BUDGET_THREADS);
    }
    const cut = order.filter(id => !store.get(id)!.whole);
    // 24 MB holds eleven threads of 2 MB beside the heads of the rest; the first shown went first.
    expect(cut).toEqual(order.slice(0, cut.length));
    expect(cut.length).toBeGreaterThan(0);
    for (const id of cut) expect(store.get(id)!.bytes).toBeLessThanOrEqual(HEAD_BYTES);
  });

  it("a thread read on a hover is not cut the moment it lands: the one shown longest ago goes", async () => {
    let now = 0;
    const host = bigHost();
    const store = createTranscripts(() => now);
    store.bind(host.api);
    for (let t = 0; t < 12; t += 1) {
      now += 1;
      const leave = store.show(`t${t}`);
      await store.open(WS, `t${t}`);
      leave();
    }
    now += 1;
    await store.open(WS, "t12");
    expect(store.get("t12")!.whole).toBe(true);
    expect(store.get("t0")!.whole).toBe(false);
    expect(store.weight().bytes).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("live events on a held thread nobody is shown stay within the budget", async () => {
    const host = fakeHost([delta("a", "start")]);
    const store = createTranscripts();
    store.bind(host.api);
    await store.open(WS, "a");
    store.apply(host.events[0] as never);
    for (let i = 0; i < 30; i += 1) store.apply(host.record(delta("a", "y".repeat(1024 * 1024))) as never);
    expect(store.weight().bytes).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("the thread on screen and a running one in view are never cut", async () => {
    let now = 0;
    const host = bigHost();
    const store = createTranscripts(() => now);
    store.bind(host.api);
    now += 1;
    store.show("t0");
    await store.open(WS, "t0");
    await store.open(WS, "t1");
    store.see("t1", true);
    store.apply({ type: "thread.head", workspaceId: WS, threadId: "t1", facts: facts("t1", "running"), pos: 1 } as never);
    for (let t = 2; t < 20; t += 1) {
      now += 1;
      const leave = store.show(`t${t}`);
      await store.open(WS, `t${t}`);
      leave();
    }
    expect(store.get("t0")!.whole).toBe(true);
    expect(store.get("t1")!.whole).toBe(true);
    expect(store.weight().bytes).toBeLessThanOrEqual(BUDGET_BYTES);
  });
});

describe("a page laid over the rows held", () => {
  it("keeps older rows only where they share a row with the page", () => {
    const at = "2026-10-06T00:00:00.000Z";
    const row = (pos: number): SessionEvent => ({ ...delta("a", `p${pos}`), pos });
    const held = { events: [row(1), row(2), row(5)], arrivals: [at, at, at] };
    expect(overlay(held, [row(5), row(6)], 6, at).events.map(e => e.pos)).toEqual([1, 2, 5, 6]);
    expect(overlay(held, [row(7), row(8)], 8, at).events.map(e => e.pos)).toEqual([7, 8]);
    expect(overlay({ events: [row(1), row(9)], arrivals: [at, at] }, [row(1)], 3, at).events.map(e => e.pos)).toEqual([1, 9]);
  });

  it("weighs an event by its text", () => {
    expect(eventBytes(delta("a", "x".repeat(1000)))).toBe(1200);
  });
});
