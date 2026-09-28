// SPDX-License-Identifier: AGPL-3.0-only
// The host holds no transcript whole until one is opened: each is an index
// (every thread's words, the facts a send reads) and the events written since
// its last flush. Opening one reads its file, the last few opened stay held,
// and search and a resume read the index alone.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AdapterEvent, TurnResult } from "@wsp/protocol";
import { TRANSCRIPTS_HELD, createRuntime, type HarnessAdapterFactory, type HarnessStartOptions } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";

/** A memory store that counts the transcript files read. */
function countingStore(): { store: Store; reads: () => number } {
  const inner = memoryStore();
  let reads = 0;
  return {
    store: {
      ...inner,
      getBlob: async (collection, id) => {
        if (collection === "transcripts") reads++;
        return inner.getBlob(collection, id);
      },
    },
    reads: () => reads,
  };
}

/** A harness that replies with the words the test gives it, in two pieces of one message, and records every start. */
function replying(reply: (prompt: string) => string): { adapter: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? randomUUID();
      const text = reply(o.prompt);
      const result: TurnResult = { status: "completed", text };
      const cut = Math.floor(text.length / 2);
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, cwd: o.cwd ?? "/root/app", model: "claude-sonnet-4-5" });
        o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: text.slice(0, cut), messageId: "m1" });
        o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: text.slice(cut), messageId: "m1" });
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

describe("a transcript read on demand", () => {
  it("is read from its file when it is opened, and not again while it is one of the last few opened", async () => {
    const { store, reads } = countingStore();
    const { adapter } = replying(p => `reply to ${p}`);
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter } });
    const spaces = [];
    for (let n = 0; n < TRANSCRIPTS_HELD + 2; n++) spaces.push(await createOn(rt, { golden: "snap_g", name: `w${n}` }));
    for (const ws of spaces) await (await rt.sessions.start(ws.id, { prompt: `work on ${ws.name}` })).finished;
    await rt.close();

    const before = reads();
    const after = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter } });
    await after.workspaces.list();
    // The host came up on the indexes alone.
    expect(reads()).toBe(before);
    const [first, ...rest] = spaces;
    const history = await after.sessions.history(first!.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.done", "session.end"]);
    expect(reads()).toBe(before + 1);
    expect(await after.sessions.history(first!.id)).toEqual(history);
    expect(reads()).toBe(before + 1);
    // Opening as many others as the host holds lets the first one go, and the next open reads its file again.
    for (const ws of rest.slice(0, TRANSCRIPTS_HELD)) await after.sessions.history(ws.id);
    expect(reads()).toBe(before + 1 + TRANSCRIPTS_HELD);
    expect(await after.sessions.history(first!.id)).toEqual(history);
    expect(reads()).toBe(before + 2 + TRANSCRIPTS_HELD);
    await after.close();
  });

  it("carries the events a running turn wrote since the last flush, in what an open reads and in what search finds", async () => {
    const { store } = countingStore();
    let emit: ((e: AdapterEvent) => void) | undefined;
    let finish: (() => void) | undefined;
    const sessionId = randomUUID();
    const held: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        emit = o.onEvent;
        const result: TurnResult = { status: "completed", text: "done" };
        const finished = new Promise<TurnResult>(resolve => (finish = () => resolve(result)));
        o.onEvent({ type: "session.start", sessionId });
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: held } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await rt.sessions.start(ws.id, { prompt: "stream something" });
    emit!({ type: "turn.delta", sessionId, kind: "text", text: "a periwinkle answer", messageId: "m1" });
    expect((await rt.sessions.history(ws.id)).at(-1)).toMatchObject({ type: "session.delta", text: "a periwinkle answer" });
    expect((await rt.sessions.search("periwinkle")).hits).toHaveLength(1);
    // Written after the open: the held transcript takes it too.
    emit!({ type: "turn.delta", sessionId, kind: "text", text: " and more", messageId: "m1" });
    expect((await rt.sessions.history(ws.id)).at(-1)).toMatchObject({ text: " and more" });
    expect((await rt.sessions.search("answer and more")).hits).toHaveLength(1);
    emit!({ type: "turn.done", sessionId, result: { status: "completed", text: "done" } });
    emit!({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
    finish!();
    await rt.close();
    const again = createRuntime({ backend: stubBackend(), store, adapters: {} });
    expect((await again.sessions.history(ws.id)).map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.done", "session.end"]);
    await again.close();
  });
});

describe("search off the index", () => {
  const replies: Record<string, string> = {
    "fix the redirect": "Done. The redirect now sends every old path to the canonical host and keeps the query string.",
    "tidy the readme": "Rewrote the install section.",
    "add a test": "Added one that proves the canonical host answers.",
  };
  const queries = ["canonical", "CANONICAL HOST", "rewrote", "readme", "old path to the", "st and kee", "nowhere at all", "the"];

  it("finds after a restart what it found while the transcripts were held, reading no transcript", async () => {
    const { store, reads } = countingStore();
    const { adapter } = replying(p => replies[p] ?? "ok");
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter } });
    const a = await createOn(rt, { golden: "snap_g", name: "a" });
    const b = await createOn(rt, { golden: "snap_g", name: "b" });
    const redirect = await rt.sessions.start(a.id, { prompt: "fix the redirect" });
    await redirect.finished;
    await (await rt.sessions.start(a.id, { prompt: "tidy the readme" })).finished;
    await (await rt.sessions.start(b.id, { prompt: "add a test" })).finished;
    await (await rt.sessions.start(a.id, { prompt: "fix the redirect", thread: redirect.view().threadId! })).finished;
    const live = await Promise.all(queries.map(q => rt.sessions.search(q)));
    expect(live[0]!.hits.length).toBeGreaterThan(1);
    await rt.close();

    const before = reads();
    const after = createRuntime({ backend: stubBackend(), store, adapters: {} });
    expect(await Promise.all(queries.map(q => after.sessions.search(q)))).toEqual(live);
    expect(reads()).toBe(before);
    await after.close();
  });

  it("makes a missing index again from its transcript, once, and finds what the transcript holds", async () => {
    const { store, reads } = countingStore();
    const { adapter } = replying(p => replies[p] ?? "ok");
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter } });
    const a = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(a.id, { prompt: "fix the redirect" })).finished;
    const live = await rt.sessions.search("canonical");
    await rt.close();
    // A transcript a build before the index wrote has no index beside it.
    await store.deleteBlob("transcript-index", a.id);

    const before = reads();
    const after = createRuntime({ backend: stubBackend(), store, adapters: {} });
    expect(await after.sessions.search("canonical")).toEqual(live);
    expect(reads()).toBe(before + 1);
    expect(await store.getBlob("transcript-index", a.id)).toBeDefined();
    await after.close();
    const third = createRuntime({ backend: stubBackend(), store, adapters: {} });
    expect(await third.sessions.search("canonical")).toEqual(live);
    expect(reads()).toBe(before + 1);
    await third.close();
  });
});

describe("a send read off the index", () => {
  it("resumes a thread whose rows fell off the index cap in its session and folder, without opening its transcript", async () => {
    const { store, reads } = countingStore();
    const first = replying(() => "ok");
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: first.adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const opened = await rt.sessions.start(ws.id, { prompt: "start", cwd: "/root/app/sub" });
    await opened.finished;
    const threadId = opened.view().threadId!;
    const session = opened.view().claudeSessionId!;
    await rt.close();
    // The state the cap leaves: no row of the thread, its record and its transcript standing.
    const doc = (await store.get("sessions", ws.id)) as { sessions: unknown[] };
    await store.put("sessions", ws.id, { ...doc, sessions: [] });

    const before = reads();
    const next = replying(() => "again");
    // Read as the harness is handed the turn: the turn's own flush reads the file afterwards, which is the write.
    let atStart = -1;
    const counted: HarnessAdapterFactory = (...args) => {
      const harness = next.adapter(...args);
      return { ...harness, start: o => ((atStart = reads()), harness.start(o)) };
    };
    const after = createRuntime({ backend: stubBackend(), store, adapters: { claude: counted } });
    await (await after.sessions.start(ws.id, { prompt: "more", thread: threadId })).finished;
    expect(next.starts[0]).toMatchObject({ resume: session, cwd: "/root/app/sub" });
    expect(atStart).toBe(before);
    await after.close();
  });
});
