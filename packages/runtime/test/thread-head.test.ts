// SPDX-License-Identifier: AGPL-3.0-only
// A thread's head and its history pages: a click on a tile draws the facts and
// the tail of one thread, and older events page in by position, without the
// whole workspace's transcript crossing the socket.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HEAD_BYTES, HEAD_RESULT_CHARS, HISTORY_PAGE_BYTES, isSessionEvent, type AdapterEvent, type EventUnion, type SessionEvent, type ThreadHeadEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";

/** One delta of a scripted turn: its kind and its text. */
type Line = { kind: "text" | "tool_use" | "tool_result"; text: string };

/** A harness whose turn writes the lines the test gives it for the prompt, then replies and exits. `hold` keeps the
 * turn open until the test lets it end. It keeps a name of a person's, so a rename lands. */
function scripted(lines: (prompt: string) => Line[], hold?: () => Promise<void>): HarnessAdapterFactory {
  return () => ({
    steers: false,
    renameSession: async () => ({ kind: "written" }),
    start: o => {
      const sessionId = o.resume ?? randomUUID();
      const result: TurnResult = { status: "completed", text: "done" };
      const finished = (async () => {
        await Promise.resolve();
        o.onEvent({ type: "session.start", sessionId, cwd: o.cwd ?? "/root/app", model: "claude-sonnet-4-5" });
        lines(o.prompt).forEach((l, n) =>
          o.onEvent({ type: "turn.delta", sessionId, kind: l.kind, text: l.text, ...(l.kind === "text" ? { messageId: `m${n}` } : { toolUseId: `t${n}`, toolName: "Bash" }) } as AdapterEvent),
        );
        await hold?.();
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
}

/** A harness the agent refused before it announced a session: a thread no turn ran on, the kind forget takes. */
const refused: HarnessAdapterFactory = () => ({
  steers: false,
  start: o => {
    const localId = randomUUID();
    const result: TurnResult = { status: "failed", error: "exited with code 1 before emitting a result" };
    const finished = Promise.resolve().then(() => {
      o.onEvent({ type: "turn.done", sessionId: localId, result });
      o.onEvent({ type: "session.end", sessionId: localId, exitCode: 1, sawResult: false });
      return result;
    });
    return { localId, finished, interrupt: async () => {} };
  },
});

const texts = (n: number, word = "line"): Line[] => Array.from({ length: n }, (_, i) => ({ kind: "text", text: `${word} ${i}` }));

async function seeded(store: Store, lines: (prompt: string) => Line[]) {
  const backend = stubBackend();
  const rt = createRuntime({ backend, store, adapters: { claude: scripted(lines) } });
  const ws = await createOn(rt, { golden: "snap_g", name: "a" });
  return { rt, ws, backend };
}

describe("positions on the transcript", () => {
  it("stamps every recorded event with its place in the workspace's transcript, the same on the bus and in history", async () => {
    const { rt, ws } = await seeded(memoryStore(), () => texts(3));
    const heard: EventUnion[] = [];
    rt.events.on("*", e => void heard.push(e));
    const one = await rt.sessions.start(ws.id, { prompt: "one" });
    await one.finished;
    await (await rt.sessions.start(ws.id, { prompt: "two" })).finished;
    const history = await rt.sessions.history(ws.id);
    expect(history.map(e => e.pos)).toEqual(history.map((_, i) => i + 1));
    const live = heard.filter(isSessionEvent).filter(e => e.pos !== undefined);
    expect(live.map(e => [e.type, e.pos])).toEqual(history.map(e => [e.type, e.pos]));
    await rt.close();
  });

  it("never issues a position twice: a restart goes on after the newest, and a forgotten thread's are not issued again", async () => {
    const store = memoryStore();
    const { rt, ws, backend } = await seeded(store, () => texts(2));
    const first = await rt.sessions.start(ws.id, { prompt: "one" });
    await first.finished;
    const threadId = first.view().threadId!;
    await (await rt.sessions.start(ws.id, { prompt: "two", thread: threadId })).finished;
    const before = await rt.sessions.history(ws.id);
    const newest = before.at(-1)!.pos!;
    await rt.close();

    const again = createRuntime({ backend, store, adapters: { claude: scripted(() => texts(2)), codex: refused } });
    await (await again.sessions.start(ws.id, { prompt: "three" })).finished;
    const after = await again.sessions.history(ws.id);
    const added = after.slice(before.length);
    expect(added.map(e => e.pos)).toEqual(added.map((_, i) => newest + 1 + i));
    // The newest thread goes with its events, and the next event comes after the positions it held.
    const junk = await again.sessions.start(ws.id, { prompt: "four", harness: "codex" });
    await junk.finished.catch(() => {});
    const dropped = (await again.sessions.history(ws.id)).at(-1)!;
    expect(dropped.threadId).toBe(junk.view().threadId);
    await again.sessions.forget(junk.view().threadId!);
    expect((await again.sessions.history(ws.id)).at(-1)!.pos).toBeLessThan(dropped.pos!);
    await (await again.sessions.start(ws.id, { prompt: "five", thread: threadId })).finished;
    const last = (await again.sessions.history(ws.id)).filter(e => e.pos! > added.at(-1)!.pos!);
    expect(last.map(e => e.pos)).toEqual(last.map((_, i) => dropped.pos! + 1 + i));
    await again.close();
  });

  it("numbers a transcript an older build wrote from one, and records the next event after them", async () => {
    const store = memoryStore();
    const { rt, ws, backend } = await seeded(store, () => texts(2));
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    await rt.close();
    // As an older build left it: no positions on the events, and an index that knows nothing of them.
    const file = JSON.parse((await store.getBlob("transcripts", ws.id))!.toString("utf8")) as { workspaceId: string; events: SessionEvent[] };
    const stripped = file.events.map(({ pos: _pos, ...e }) => e);
    await store.putBlob("transcripts", ws.id, Buffer.from(JSON.stringify({ workspaceId: ws.id, events: stripped })));
    const index = JSON.parse((await store.getBlob("transcript-index", ws.id))!.toString("utf8")) as Record<string, unknown>;
    delete index["pos"];
    index["of"] = await store.statBlob("transcripts", ws.id);
    await store.putBlob("transcript-index", ws.id, Buffer.from(JSON.stringify(index)));

    const again = createRuntime({ backend, store, adapters: { claude: scripted(() => texts(2)) } });
    await (await again.sessions.start(ws.id, { prompt: "two" })).finished;
    const history = await again.sessions.history(ws.id);
    expect(history.map(e => e.pos)).toEqual(history.map((_, i) => i + 1));
    await again.close();
  });
});

describe("a thread's head", () => {
  it("answers the thread's facts and its newest events under the head's bytes, tool results cut and marked", async () => {
    const long = "x".repeat(HEAD_RESULT_CHARS * 3);
    const lines: Line[] = Array.from({ length: 300 }, (_, i) => (i % 3 === 2 ? { kind: "tool_result", text: long } : i % 3 === 1 ? { kind: "tool_use", text: `{"command":"ls ${i}"}` } : { kind: "text", text: `step ${i}` }));
    const { rt, ws } = await seeded(memoryStore(), p => (p === "busy" ? lines : texts(2, "other")));
    const busy = await rt.sessions.start(ws.id, { prompt: "busy", permissionMode: "acceptEdits" });
    await busy.finished;
    await (await rt.sessions.start(ws.id, { prompt: "quiet" })).finished;
    const threadId = busy.view().threadId!;

    const head = await rt.sessions.head(threadId);
    expect(Buffer.byteLength(JSON.stringify(head))).toBeLessThan(HEAD_BYTES);
    const all = (await rt.sessions.history(ws.id)).filter(e => e.threadId === threadId);
    expect(head.total).toBe(all.length);
    expect(head.pos).toBe((await rt.sessions.history(ws.id)).at(-1)!.pos);
    // The newest of the thread's events, in order and with no gap, and none of the other thread's.
    expect(head.events.length).toBeGreaterThan(10);
    expect(head.events.length).toBeLessThan(all.length);
    expect(head.events.map(e => e.pos)).toEqual(all.slice(-head.events.length).map(e => e.pos));
    expect(head.events.at(-1)!.type).toBe("session.end");
    const results = head.events.filter(e => e.type === "session.delta" && e.kind === "tool_result");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r).toMatchObject({ text: long.slice(0, HEAD_RESULT_CHARS), cut: long.length });
    // What the host holds is not cut.
    expect(all.find(e => e.type === "session.delta" && e.kind === "tool_result")).toMatchObject({ text: long });
    expect(head.facts).toMatchObject({ id: threadId, workspaceId: ws.id, harness: "claude", status: "completed", title: "busy", model: "claude-sonnet-4-5", permissionMode: "acceptEdits", cwd: busy.view().cwd });
    expect(head.facts.turnId).toBeUndefined();
    await rt.close();
  });

  it("names the running turn while one runs", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: scripted(() => texts(2), () => held) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    await new Promise(resolve => setTimeout(resolve, 0));
    const head = await rt.sessions.head(handle.view().threadId!);
    expect(head.facts).toMatchObject({ status: "running", turnId: handle.turnId });
    expect(head.events.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta"]);
    release();
    await handle.finished;
    await rt.close();
  });

  it("stays under the head's bytes on the wire, multi-byte text and the commas between events counted", async () => {
    const { rt, ws } = await seeded(memoryStore(), () => Array.from({ length: 2000 }, (_, i) => ({ kind: "text" as const, text: `${i} ✓ réponse: ` + "日本語".repeat(20) })));
    const handle = await rt.sessions.start(ws.id, { prompt: "wide" });
    await handle.finished;
    const head = await rt.sessions.head(handle.view().threadId!);
    // The reply as the socket sends it, with its id and ok beside the head.
    const wire = Buffer.byteLength(JSON.stringify({ id: 123456, ok: true, ...head }));
    expect(wire).toBeLessThan(HEAD_BYTES);
    expect(wire).toBeGreaterThan(HEAD_BYTES * 0.9);
    await rt.close();
  });

  it("is not found for a thread the host holds no row of", async () => {
    const { rt } = await seeded(memoryStore(), () => texts(1));
    await expect(rt.sessions.head("no-such-thread")).rejects.toMatchObject({ kind: "not-found" });
    await rt.close();
  });

  it("goes out on the bus when a turn starts and ends, on a rename and on an access change", async () => {
    const { rt, ws } = await seeded(memoryStore(), () => texts(2));
    const heads: ThreadHeadEvent[] = [];
    rt.events.on("thread.head", e => void heads.push(e as ThreadHeadEvent));
    const handle = await rt.sessions.start(ws.id, { prompt: "go" });
    await handle.finished;
    const threadId = handle.view().threadId!;
    expect(heads.map(h => [h.threadId, h.facts.status])).toEqual([
      [threadId, "running"],
      [threadId, "completed"],
    ]);
    expect(heads[0]!.facts.turnId).toBe(handle.turnId);
    expect(heads[1]!.pos).toBe((await rt.sessions.history(ws.id)).at(-1)!.pos);

    expect(await rt.sessions.rename(handle.id, "a better name")).toEqual({ outcome: "renamed" });
    expect(heads.at(-1)).toMatchObject({ type: "thread.head", workspaceId: ws.id, threadId, facts: { title: "a better name" } });
    expect(await rt.sessions.access(handle.id, "acceptEdits")).toEqual({ outcome: "set" });
    expect(heads.at(-1)).toMatchObject({ threadId, facts: { permissionMode: "acceptEdits" } });
    expect(heads).toHaveLength(4);
    await rt.close();
  });
});

describe("a history page", () => {
  it("pages one thread back by position, newest page first, and the pages put together are the thread", async () => {
    const { rt, ws } = await seeded(memoryStore(), p => texts(p === "long" ? 4900 : 40, p));
    await (await rt.sessions.start(ws.id, { prompt: "short" })).finished;
    const long = await rt.sessions.start(ws.id, { prompt: "long" });
    await long.finished;
    const threadId = long.view().threadId!;
    const whole = (await rt.sessions.history(ws.id)).filter(e => e.threadId === threadId);

    const first = await rt.sessions.page(ws.id, { threadId, limit: 200 });
    expect(first.events).toEqual(whole.slice(-200));
    expect(first.total).toBe(whole.length);
    expect(first.pos).toBe(whole.at(-1)!.pos);
    expect(JSON.stringify(first).length).toBeLessThan(500 * 1024);

    const pages = [first.events];
    for (let before = first.events[0]!.pos; ; ) {
      const page = await rt.sessions.page(ws.id, { threadId, before, limit: 1000 });
      if (page.events.length === 0) break;
      pages.unshift(page.events);
      before = page.events[0]!.pos;
    }
    expect(pages.flat()).toEqual(whole);
    // The default page.
    expect((await rt.sessions.page(ws.id, { threadId })).events).toHaveLength(200);
    await rt.close();
  });

  it("stops at the page's bytes past its first event", async () => {
    const big = "y".repeat(12 * 1024);
    const { rt, ws } = await seeded(memoryStore(), () => Array.from({ length: 100 }, () => ({ kind: "tool_result" as const, text: big })));
    const handle = await rt.sessions.start(ws.id, { prompt: "big" });
    await handle.finished;
    const page = await rt.sessions.page(ws.id, { threadId: handle.view().threadId!, limit: 200 });
    expect(page.events.length).toBeLessThan(100);
    expect(JSON.stringify(page.events).length).toBeLessThanOrEqual(HISTORY_PAGE_BYTES + 2);
    expect(page.events.at(-1)!.type).toBe("session.end");
    await rt.close();
  });

  it("answers a thread the caller reaches no row of with nothing", async () => {
    const { rt, ws } = await seeded(memoryStore(), () => texts(1));
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    expect(await rt.sessions.page(ws.id, { threadId: "elsewhere" })).toMatchObject({ events: [], total: 0 });
    await rt.close();
  });
});
