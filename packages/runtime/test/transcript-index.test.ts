// SPDX-License-Identifier: AGPL-3.0-only
// The host holds no transcript whole until one is opened: each is an index
// (every thread's words, the facts a send reads) and the events written since
// its last flush. Opening one reads its file, the last few opened stay held,
// and search and a resume read the index alone.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DAEMON_VERSION, type AdapterEvent, type TurnResult } from "@wsp/protocol";
import { TRANSCRIPTS_HELD, createRuntime, type HarnessAdapterFactory, type HarnessStartOptions } from "../src/runtime.js";
import { jsonFileStore, memoryStore, type Store } from "../src/store.js";
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

describe("a transcript file that did not read", () => {
  it("is never written over: the flush waits, says so once, and writes everything once the file reads again", async () => {
    // One failed read of the file, taken for no file at all, had the flush write the newest turn over every turn before.
    const home = mkdtempSync(join(tmpdir(), "wsp-unread-"));
    const statePath = join(home, "state.json");
    const writer = { wsp: "test", daemon: DAEMON_VERSION, bin: "/usr/local/bin/wsp" };
    const { adapter } = replying(p => `reply to ${p}`);
    // One backend for every host over this state, so the machine the record names is still there when the next one reads it.
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: jsonFileStore(statePath, writer), adapters: { claude: adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    await rt.close();

    // The file is there and no read answers it: root reads a file at mode 000, so a link to itself stands in, which
    // fails the read with ELOOP for anybody. Put back only if nothing wrote over it, as a chmod put back would be.
    const file = join(home, "blobs", "transcripts", ws.id);
    renameSync(file, `${file}.aside`);
    symlinkSync(file, file);
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(line => void warned.push(String(line)));
    const after = createRuntime({ backend, store: jsonFileStore(statePath, writer), adapters: { claude: adapter } });
    try {
      await (await after.sessions.start(ws.id, { prompt: "two" })).finished;
      await (await after.sessions.start(ws.id, { prompt: "three" })).finished;
      await new Promise(r => setTimeout(r, 50));
    } finally {
      warn.mockRestore();
    }
    if (lstatSync(file).isSymbolicLink()) {
      rmSync(file);
      renameSync(`${file}.aside`, file);
    }
    await after.close();

    const third = createRuntime({ backend, store: jsonFileStore(statePath, writer), adapters: {} });
    const replies = (await third.sessions.history(ws.id)).flatMap(e => (e.type === "session.delta" && e.kind === "text" ? [e.text] : []));
    expect(replies.join("")).toBe("reply to onereply to tworeply to three");
    expect(warned.filter(line => line.startsWith(`the transcript of ${ws.id} does not read`) && line.endsWith("its newest events wait for the next flush"))).toHaveLength(1);
    await third.close();
    rmSync(home, { recursive: true, force: true });
  });
});

describe("a transcript file that reads and does not parse", () => {
  it("is kept aside under a name of its own, and every turn after it is written and read again", async () => {
    // A refusal on bad JSON kept each later turn's events unwritten, and each restart dropped them: it never parses.
    const home = mkdtempSync(join(tmpdir(), "wsp-unparsed-"));
    const statePath = join(home, "state.json");
    const writer = { wsp: "test", daemon: DAEMON_VERSION, bin: "/usr/local/bin/wsp" };
    const { adapter } = replying(p => `reply to ${p}`);
    // One backend for every host over this state, so the machine the record names is still there when the next one reads it.
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: jsonFileStore(statePath, writer), adapters: { claude: adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    await rt.close();
    const torn = '{"workspaceId":"x","events":[{"ty';
    writeFileSync(join(home, "blobs", "transcripts", ws.id), torn);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const prompt of ["two", "three"]) {
        const next = createRuntime({ backend, store: jsonFileStore(statePath, writer), adapters: { claude: adapter } });
        await (await next.sessions.start(ws.id, { prompt })).finished;
        await next.close();
      }
    } finally {
      warn.mockRestore();
    }

    const last = createRuntime({ backend, store: jsonFileStore(statePath, writer), adapters: {} });
    const replies = (await last.sessions.history(ws.id)).flatMap(e => (e.type === "session.delta" && e.kind === "text" ? [e.text] : []));
    expect(replies.join("")).toBe("reply to tworeply to three");
    expect((await last.sessions.search("reply to two")).hits).toHaveLength(1);
    await last.close();
    const aside = readdirSync(join(home, "blobs", "transcripts-unparsed"));
    expect(aside.map(name => readFileSync(join(home, "blobs", "transcripts-unparsed", name), "utf8"))).toEqual([torn]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("an index file that does not parse", () => {
  it("is made again from its transcript at boot, as a missing one is", async () => {
    const store = memoryStore();
    const { adapter } = replying(p => (p === "one" ? "a periwinkle answer" : "an ordinary answer"));
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    await rt.close();
    await store.putBlob("transcript-index", ws.id, Buffer.from('{"of":{"by'));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const after = createRuntime({ backend: stubBackend(), store, adapters: {} });
    try {
      expect((await after.sessions.search("periwinkle")).hits).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    await after.close();
  });
});

describe("an index write", () => {
  it("that fails leaves nothing to be written twice, and boot reads that transcript again", async () => {
    const inner = memoryStore();
    let failIndex = false;
    const store: Store = {
      ...inner,
      putBlob: async (collection, id, bytes) => {
        if (collection === "transcript-index" && failIndex) {
          failIndex = false;
          throw new Error("disk full");
        }
        return inner.putBlob(collection, id, bytes);
      },
    };
    const { adapter } = replying(p => `reply to ${p}`);
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failIndex = true;
    await (await rt.sessions.start(ws.id, { prompt: "two" })).finished;
    await new Promise(r => setTimeout(r, 20));
    warn.mockRestore();
    await rt.close();
    const texts = async (runtime: typeof rt): Promise<string[]> => (await runtime.sessions.history(ws.id)).flatMap(e => (e.type === "session.delta" && e.kind === "text" ? [e.text] : []));

    const after = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter } });
    await (await after.sessions.start(ws.id, { prompt: "three" })).finished;
    expect((await texts(after)).join("")).toBe("reply to onereply to tworeply to three");
    await after.close();
  });

  it("left older than its transcript, as a crash between the two writes leaves it, is made again at boot", async () => {
    const { store } = countingStore();
    const { adapter } = replying(p => (p === "one" ? "an ordinary answer" : "a marmalade answer"));
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "one" });
    await first.finished;
    const stale = await store.getBlob("transcript-index", ws.id);
    await (await rt.sessions.start(ws.id, { prompt: "two" })).finished;
    await rt.close();
    await store.putBlob("transcript-index", ws.id, stale!);

    const after = createRuntime({ backend: stubBackend(), store, adapters: {} });
    expect((await after.sessions.search("marmalade")).hits).toHaveLength(1);
    await after.close();
  });
});
