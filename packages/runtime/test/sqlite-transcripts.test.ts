// SPDX-License-Identifier: AGPL-3.0-only
// Transcripts as rows of the state database: the module's table and its index,
// the one-time move of the blobs an earlier build kept, and a runtime over it
// appending a turn rather than rewriting its workspace's transcript.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { sqliteBinding } from "@wsp/engine";
import { DAEMON_VERSION, type AdapterEvent, type SessionEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { migrate, sqliteStore, STORE_MODULES } from "../src/sqlite-store.js";
import { transcriptRows } from "../src/sqlite-transcripts.js";
import { jsonFileStore, memoryStore, type Store } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";

const WRITER = { wsp: "test", daemon: DAEMON_VERSION, bin: "/usr/local/bin/wsp" };

const homes: string[] = [];
const home = (): string => {
  const h = mkdtempSync(join(tmpdir(), "wsp-rows-"));
  homes.push(h);
  return h;
};
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function memoryDb(): { d: DatabaseSync; rows: ReturnType<typeof transcriptRows> } {
  const { DatabaseSync } = sqliteBinding();
  const d = new DatabaseSync(":memory:");
  migrate(d, ":memory:", STORE_MODULES);
  return { d, rows: transcriptRows(() => d) };
}

const delta = (workspaceId: string, threadId: string | undefined, pos: number, text = `line ${pos}`): SessionEvent =>
  ({ type: "session.delta", workspaceId, sessionId: "s", ...(threadId !== undefined ? { threadId } : {}), kind: "text", text, pos }) as SessionEvent;

const putBlob = (d: DatabaseSync, collection: string, id: string, bytes: Buffer, at = 1000.5): void =>
  void d.prepare("insert into blobs (collection, id, bytes, at) values (?, ?, ?, ?)").run(collection, id, bytes, at);
const blobIds = (d: DatabaseSync, collection: string): string[] => (d.prepare("select id from blobs where collection = ? order by id").all(collection) as { id: string }[]).map(r => r.id);
const transcriptBlob = (workspaceId: string, events: SessionEvent[]): Buffer => Buffer.from(JSON.stringify({ workspaceId, events }));

describe("the transcripts module", () => {
  it("keeps each event as a row, read back in order, and a thread's newest first under a position", () => {
    const { rows } = memoryDb();
    rows.append("w", [delta("w", "a", 1), delta("w", "b", 2), delta("w", undefined, 3), delta("w", "a", 4)]);
    rows.append("v", [delta("v", "a", 1)]);
    const all = rows.all("w");
    expect(all.events.map(e => e.pos)).toEqual([1, 2, 3, 4]);
    expect(all.size).toBe(all.events.reduce((n, e) => n + JSON.stringify(e).length, 0));
    expect([...rows.newest("w", "a")].map(e => e.pos)).toEqual([4, 1]);
    expect([...rows.newest("w", "a", 4)].map(e => e.pos)).toEqual([1]);
    expect(rows.count("w", "a")).toBe(2);
    expect(rows.total("w")).toEqual({ count: 4, size: all.size });
    expect(rows.sizes("w").map(s => [s.pos, s.threadId, s.type])).toEqual([
      [1, "a", "session.delta"],
      [2, "b", "session.delta"],
      [3, undefined, "session.delta"],
      [4, "a", "session.delta"],
    ]);
    rows.remove("w", [1, 3]);
    expect(rows.all("w").events.map(e => e.pos)).toEqual([2, 4]);
    expect(rows.at("w", [4])).toEqual([delta("w", "a", 4)]);
  });

  it("reads a thread's window off the index on (workspace, thread, pos), never the whole workspace", () => {
    const { d } = memoryDb();
    const plan = (d.prepare("explain query plan select json from events where workspace = ? and thread = ? and pos < ? order by pos desc").all("w", "a", 9) as { detail: string }[]).map(r => r.detail);
    expect(plan.join("\n")).toMatch(/USING INDEX events_thread \(workspace=\? AND thread=\? AND pos<\?\)/);
    expect(plan.join("\n")).not.toMatch(/TEMP B-TREE/);
  });

  it("undoes the whole of a transaction that throws", () => {
    const { rows } = memoryDb();
    rows.append("w", [delta("w", "a", 1)]);
    expect(() =>
      rows.atomically(() => {
        rows.append("w", [delta("w", "a", 2)]);
        rows.putIndex("w", "{}");
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(rows.all("w").events.map(e => e.pos)).toEqual([1]);
    expect(rows.index("w")).toBeUndefined();
  });

  it("clears one workspace's rows and index and leaves every other", () => {
    const { rows } = memoryDb();
    rows.append("w", [delta("w", "a", 1)]);
    rows.append("v", [delta("v", "a", 1)]);
    rows.putIndex("w", "{}");
    rows.putIndex("v", "{}");
    rows.clear("w");
    expect(rows.all("w").events).toEqual([]);
    expect(rows.index("w")).toBeUndefined();
    expect(rows.all("v").events).toHaveLength(1);
    expect(rows.index("v")).toBe("{}");
  });
});

describe("the move of the transcript blobs into rows", () => {
  it("moves each blob with its positions, numbers an older build's events from one, and keeps the index read off that blob", () => {
    const { d, rows } = memoryDb();
    const placed = [delta("w", "a", 1), delta("w", "b", 2), delta("w", "a", 3)];
    const blob = transcriptBlob("w", placed);
    putBlob(d, "transcripts", "w", blob, 1234.25);
    const index = JSON.stringify({ of: { bytes: blob.byteLength, at: 1234.25 }, words: [], pos: 3 });
    putBlob(d, "transcript-index", "w", Buffer.from(index));
    const unplaced = [delta("v", "a", 0), delta("v", "a", 0)].map(({ pos: _pos, ...e }) => e as SessionEvent);
    putBlob(d, "transcripts", "v", transcriptBlob("v", unplaced));
    putBlob(d, "image-vaults", "default@v1", Buffer.from("kept"));

    expect(rows.moveBlobs()).toEqual({ moved: 2, events: 5, setAside: [] });
    expect(rows.all("w").events).toEqual(placed);
    expect(rows.all("v").events.map(e => e.pos)).toEqual([1, 2]);
    expect(rows.index("w")).toBe(index);
    expect(rows.index("v")).toBeUndefined();
    expect(blobIds(d, "transcripts")).toEqual([]);
    expect(blobIds(d, "transcript-index")).toEqual([]);
    expect(blobIds(d, "image-vaults")).toEqual(["default@v1"]);
    expect(rows.moveBlobs()).toEqual({ moved: 0, events: 0, setAside: [] });
    expect(rows.all("w").events).toEqual(placed);
  });

  it("leaves behind an index older than its blob, for the host to read a new one off the rows", () => {
    const { d, rows } = memoryDb();
    const blob = transcriptBlob("w", [delta("w", "a", 1)]);
    putBlob(d, "transcripts", "w", blob, 2000);
    putBlob(d, "transcript-index", "w", Buffer.from(JSON.stringify({ of: { bytes: blob.byteLength, at: 1999 }, pos: 0 })));
    rows.moveBlobs();
    expect(rows.index("w")).toBeUndefined();
    expect(blobIds(d, "transcript-index")).toEqual([]);
  });

  it("keeps a blob that does not parse or whose rows the table refuses aside, whole, and moves every other", () => {
    const { d, rows } = memoryDb();
    putBlob(d, "transcripts", "bad", Buffer.from("{not json"));
    const twice = transcriptBlob("dup", [delta("dup", "a", 1), delta("dup", "a", 1)]);
    putBlob(d, "transcripts", "dup", twice);
    putBlob(d, "transcript-index", "dup", Buffer.from("{}"));
    putBlob(d, "transcripts", "empty", Buffer.from('{"workspaceId":"empty"}'));
    putBlob(d, "transcripts", "w", transcriptBlob("w", [delta("w", "a", 1)]));
    const moved = rows.moveBlobs();
    expect(moved.moved).toBe(1);
    expect(moved.setAside.map(u => [u.workspaceId, u.why])).toEqual([
      ["bad", expect.stringContaining("JSON")],
      ["dup", "UNIQUE constraint failed: events.workspace, events.pos"],
      ["empty", "it holds no events"],
    ]);
    const aside = d.prepare("select id, bytes from blobs where collection = 'transcripts-unparsed' order by id").all() as { id: string; bytes: Uint8Array }[];
    expect(aside.map(a => [a.id.split(".")[0], Buffer.from(a.bytes).toString()])).toEqual([
      ["bad", "{not json"],
      ["dup", twice.toString()],
      ["empty", '{"workspaceId":"empty"}'],
    ]);
    expect(blobIds(d, "transcripts")).toEqual([]);
    expect(blobIds(d, "transcript-index")).toEqual([]);
    expect(rows.all("dup").events).toEqual([]);
    expect(rows.all("w").events).toHaveLength(1);
    expect(rows.moveBlobs()).toEqual({ moved: 0, events: 0, setAside: [] });
  });

  it("puts a blob's events after the rows a workspace already keeps, under positions of their own", () => {
    const { d, rows } = memoryDb();
    rows.append("w", [delta("w", "a", 1, "kept"), delta("w", "a", 2, "kept")]);
    rows.putIndex("w", "{}");
    putBlob(d, "transcripts", "w", transcriptBlob("w", [delta("w", "a", 1, "older build"), delta("w", "a", 2, "older build")]));
    rows.moveBlobs();
    expect(rows.all("w").events.map(e => [e.pos, e.type === "session.delta" ? e.text : ""])).toEqual([
      [1, "kept"],
      [2, "kept"],
      [3, "older build"],
      [4, "older build"],
    ]);
    expect(rows.index("w")).toBeUndefined();
  });
});

/** A harness whose turn says what `lines` gives the prompt, then ends once `hold` lets it. It takes images inline. */
function scripted(lines: (prompt: string) => { kind: "text" | "tool_result"; text: string }[], hold?: (prompt: string) => Promise<void> | undefined): HarnessAdapterFactory {
  return () => ({
    steers: false,
    attachments: "inline",
    start: o => {
      const sessionId = o.resume ?? randomUUID();
      const result: TurnResult = { status: "completed", text: "done" };
      const finished = (async () => {
        await Promise.resolve();
        o.onEvent({ type: "session.start", sessionId });
        lines(o.prompt).forEach((l, n) =>
          o.onEvent({ type: "turn.delta", sessionId, kind: l.kind, text: l.text, ...(l.kind === "text" ? { messageId: `m${n}` } : { toolUseId: `t${n}`, toolName: "Bash" }) } as AdapterEvent),
        );
        await hold?.(o.prompt);
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
}

const freshSqlite = (): { store: Store; statePath: string } => {
  const statePath = join(home(), "state.json");
  return { store: sqliteStore(statePath, WRITER), statePath };
};
const openDb = (statePath: string): DatabaseSync => new (sqliteBinding().DatabaseSync)(join(statePath, "..", "state.db"), { readOnly: true });
/** What a history holds, less the moment each event was stamped, which is each runtime's own clock. */
const shapeOf = (events: SessionEvent[]): unknown[] => events.map(({ at: _at, ...e }) => ({ ...e, workspaceId: "", ...("sessionId" in e ? { sessionId: "" } : {}), ...("turnId" in e ? { turnId: "" } : {}), ...("threadId" in e ? { threadId: "" } : {}) }));

describe("a runtime whose store keeps transcripts as rows", () => {
  it("appends a turn's events as rows, writes no transcript blob, and never rewrites a row an earlier turn wrote", async () => {
    const { store, statePath } = freshSqlite();
    const blobs: string[] = [];
    const watched: Store = { ...store, putBlob: async (c, id, b) => (blobs.push(c), store.putBlob(c, id, b)) };
    const rt = createRuntime({ backend: stubBackend(), store: watched, adapters: { claude: scripted(() => [{ kind: "text", text: "hello" }]) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "one" });
    await first.finished;
    await rt.close();
    const d = openDb(statePath);
    const before = d.prepare("select rowid, pos, json from events where workspace = ? order by pos").all(ws.id).map(r => ({ ...r }));
    expect(before.length).toBeGreaterThan(2);

    const again = createRuntime({ backend: stubBackend(), store: watched, adapters: { claude: scripted(() => [{ kind: "text", text: "again" }]) } });
    await (await again.sessions.start(ws.id, { prompt: "two", thread: first.view().threadId! })).finished;
    await again.close();
    const after = d.prepare("select rowid, pos, json from events where workspace = ? order by pos").all(ws.id).map(r => ({ ...r }));
    d.close();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    expect(blobs.filter(c => c.startsWith("transcript"))).toEqual([]);
  });

  it("drops past the caps exactly the events the blobs drop", async () => {
    const big = "z".repeat(12 * 1024);
    const lines = (prompt: string): { kind: "text" | "tool_result"; text: string }[] =>
      prompt.startsWith("count") ? Array.from({ length: 1800 }, (_, i) => ({ kind: "text", text: `${prompt} ${i}` })) : Array.from({ length: 120 }, () => ({ kind: "tool_result", text: big }));
    const run = async (store: Store): Promise<{ history: SessionEvent[]; search: number }> => {
      const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: scripted(lines) } });
      const ws = await createOn(rt, { golden: "snap_g", name: "a" });
      const a = await rt.sessions.start(ws.id, { prompt: "count a" });
      await a.finished;
      const b = await rt.sessions.start(ws.id, { prompt: "bytes b" });
      await b.finished;
      for (const n of [2, 3, 4]) await (await rt.sessions.start(ws.id, { prompt: `count a${n}`, thread: a.view().threadId! })).finished;
      for (const n of [2, 3]) await (await rt.sessions.start(ws.id, { prompt: `bytes b${n}`, thread: b.view().threadId! })).finished;
      await rt.close();
      const again = createRuntime({ backend: stubBackend(), store, adapters: {} });
      const history = await again.sessions.history(ws.id);
      const search = (await again.sessions.search("count a 5")).hits.length;
      await again.close();
      return { history, search };
    };
    const blobs = await run(memoryStore());
    const rows = await run(freshSqlite().store);
    expect(blobs.history.length).toBeLessThanOrEqual(5000);
    expect(blobs.history.length).toBeLessThan(1800 * 4 + 120 * 3);
    expect(shapeOf(rows.history)).toEqual(shapeOf(blobs.history));
    expect(rows.search).toBe(blobs.search);
  });

  it("marks a thread the caps took events from on its head and its pages, in state.db, across a restart", async () => {
    const lines = (prompt: string): { kind: "text"; text: string }[] => Array.from({ length: prompt.startsWith("busy") ? 1800 : 1 }, (_, i) => ({ kind: "text", text: `${prompt} ${i}` }));
    const { store, statePath } = freshSqlite();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: scripted(lines) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const quiet = await rt.sessions.start(ws.id, { prompt: "quiet" });
    await quiet.finished;
    const busy = await rt.sessions.start(ws.id, { prompt: "busy 1" });
    await busy.finished;
    const busyId = busy.view().threadId!;
    const quietId = quiet.view().threadId!;
    expect((await rt.sessions.page(ws.id, { threadId: busyId })).trimmed).toBeUndefined();
    for (const n of [2, 3]) await (await rt.sessions.start(ws.id, { prompt: `busy ${n}`, thread: busyId })).finished;
    expect((await rt.sessions.page(ws.id, { threadId: busyId })).trimmed).toBe(true);
    expect((await rt.sessions.head(busyId)).trimmed).toBe(true);
    expect((await rt.sessions.page(ws.id, { threadId: quietId })).trimmed).toBeUndefined();
    expect((await rt.sessions.head(quietId)).trimmed).toBeUndefined();
    await rt.close();
    const d = openDb(statePath);
    const index = (d.prepare("select json from transcript_index where workspace = ?").get(ws.id) as { json: string } | undefined)?.json;
    d.close();
    expect(JSON.parse(index!).trimmed).toEqual([busyId]);
    const again = createRuntime({ backend: stubBackend(), store, adapters: {} });
    expect((await again.sessions.page(ws.id, { threadId: busyId })).trimmed).toBe(true);
    expect((await again.sessions.head(busyId)).trimmed).toBe(true);
    expect((await again.sessions.page(ws.id, { threadId: quietId })).trimmed).toBeUndefined();
    await again.close();
  });

  it("forgets a thread's rows, and search no longer finds its words", async () => {
    const { store } = freshSqlite();
    const refused: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        const localId = randomUUID();
        const result: TurnResult = { status: "failed", error: "exited with code 1 before emitting a result" };
        const finished = Promise.resolve().then(() => {
          o.onEvent({ type: "turn.delta", sessionId: localId, kind: "text", text: "forgotten words", messageId: "m0" });
          o.onEvent({ type: "turn.done", sessionId: localId, result });
          o.onEvent({ type: "session.end", sessionId: localId, exitCode: 1, sawResult: false });
          return result;
        });
        return { localId, finished, interrupt: async () => {} };
      },
    });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: scripted(() => [{ kind: "text", text: "stays" }]), codex: refused } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "kept words" })).finished;
    const junk = await rt.sessions.start(ws.id, { prompt: "refused", harness: "codex" });
    await junk.finished.catch(() => {});
    expect((await rt.sessions.search("forgotten words")).hits).toHaveLength(1);
    await rt.sessions.forget(junk.view().threadId!);
    expect((await rt.sessions.search("forgotten words")).hits).toEqual([]);
    expect((await rt.sessions.search("kept words")).hits).toHaveLength(1);
    expect((await rt.sessions.history(ws.id)).filter(e => e.threadId === junk.view().threadId)).toEqual([]);
    await rt.close();
    const again = createRuntime({ backend: stubBackend(), store, adapters: {} });
    expect((await again.sessions.search("forgotten words")).hits).toEqual([]);
    expect((await again.sessions.history(ws.id)).filter(e => e.threadId === junk.view().threadId)).toEqual([]);
    await again.close();
  });

  it("takes over a home whose transcripts were files: moves them into rows once, reads the same history, and reads no index again", async () => {
    const statePath = join(home(), "state.json");
    const files = jsonFileStore(statePath, WRITER);
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: files, adapters: { claude: scripted(p => Array.from({ length: 30 }, (_, i) => ({ kind: "text", text: `${p} ${i}` }))) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const one = await rt.sessions.start(ws.id, { prompt: "one" });
    await one.finished;
    await (await rt.sessions.start(ws.id, { prompt: "two" })).finished;
    const history = await rt.sessions.history(ws.id);
    const page = await rt.sessions.page(ws.id, { threadId: one.view().threadId!, limit: 10 });
    await rt.close();
    const index = (await files.getBlob("transcript-index", ws.id))!.toString("utf8");

    const store = sqliteStore(statePath, WRITER);
    const moved = createRuntime({ backend, store, adapters: {} });
    expect(await moved.sessions.history(ws.id)).toEqual(history);
    expect(await moved.sessions.page(ws.id, { threadId: one.view().threadId!, limit: 10 })).toEqual(page);
    expect((await moved.sessions.search("two 29")).hits).toHaveLength(1);
    expect(await store.getBlob("transcripts", ws.id)).toBeUndefined();
    expect(await store.getBlob("transcript-index", ws.id)).toBeUndefined();
    expect(store.transcripts!.index(ws.id)).toBe(index);
    await moved.close();
  });
});

describe("a runtime over rows, where a step does not go through", () => {
  it("boots past a blob whose rows the table refuses, keeping its bytes aside, and moves the blobs after it", async () => {
    const { store, statePath } = freshSqlite();
    const twice = Buffer.from(JSON.stringify({ workspaceId: "a", events: [delta("a", "t", 1), delta("a", "t", 1)] }));
    await store.putBlob("transcripts", "a", twice);
    await store.putBlob("transcripts", "b", Buffer.from(JSON.stringify({ workspaceId: "b", events: [delta("b", "t", 1)] })));
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {} });
    await rt.sessions.list();
    await rt.close();
    expect(await store.getBlob("transcripts", "a")).toBeUndefined();
    expect(await store.getBlob("transcripts", "b")).toBeUndefined();
    expect(store.transcripts!.all("a").events).toEqual([]);
    expect(store.transcripts!.all("b").events).toEqual([delta("b", "t", 1)]);
    const d = openDb(statePath);
    const aside = d.prepare("select id, bytes from blobs where collection = 'transcripts-unparsed'").all() as { id: string; bytes: Uint8Array }[];
    d.close();
    expect(aside.map(a => [a.id.split(".")[0], Buffer.from(a.bytes).toString()])).toEqual([["a", twice.toString()]]);
    const again = createRuntime({ backend: stubBackend(), store, adapters: {} });
    await again.sessions.list();
    await again.close();
  });

  it("goes on after the newest row when a workspace's index does not read at boot, and leaves the kept index for the next boot", async () => {
    const { store, statePath } = freshSqlite();
    const backend = stubBackend();
    const rt = createRuntime({ backend, store, adapters: { claude: scripted(p => [{ kind: "text", text: `said ${p}` }]) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const first = await rt.sessions.start(ws.id, { prompt: "one" });
    await first.finished;
    await rt.close();
    const d = new (sqliteBinding().DatabaseSync)(join(statePath, "..", "state.db"));
    d.prepare("delete from transcript_index where workspace = ?").run(ws.id);
    d.close();

    let failing = true;
    const rows = store.transcripts!;
    const all = (id: string): ReturnType<typeof rows.all> => {
      if (failing) throw new Error("disk I/O error");
      return rows.all(id);
    };
    const flaky: Store = { ...store, transcripts: { ...rows, all } };
    const again = createRuntime({ backend, store: flaky, adapters: { claude: scripted(p => [{ kind: "text", text: `said ${p}` }]) } });
    await again.sessions.list();
    failing = false;
    await (await again.sessions.start(ws.id, { prompt: "two", thread: first.view().threadId! })).finished;
    await again.close();

    const after = createRuntime({ backend, store, adapters: {} });
    const history = await after.sessions.history(ws.id);
    expect(history.flatMap(e => (e.type === "session.delta" ? [e.text] : []))).toEqual(["said one", "said two"]);
    expect(history.map(e => e.pos)).toEqual(history.map((_, i) => i + 1));
    expect((await after.sessions.search("said one")).hits).toHaveLength(1);
    await after.close();
  });

  it("lets a start's images go when a flush drops the start, not when a read trims a copy of it", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    const lines = (p: string): { kind: "text"; text: string }[] => Array.from({ length: p === "fill" ? 4960 : p === "more" ? 40 : 10 }, (_, i) => ({ kind: "text", text: `${p} ${i}` }));
    const { store } = freshSqlite();
    const backend = stubBackend();
    const rt = createRuntime({ backend, store, adapters: { claude: scripted(lines, p => (p === "more" ? held : undefined)) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const image = { mediaType: "image/png", bytes: Buffer.alloc(64, 7).toString("base64") };
    const first = await rt.sessions.start(ws.id, { prompt: "first", attachments: [image], requestId: "req_a" });
    await first.finished;
    const threadId = first.view().threadId!;
    await (await rt.sessions.start(ws.id, { prompt: "fill", thread: threadId })).finished;
    const more = await rt.sessions.start(ws.id, { prompt: "more", thread: threadId });
    await new Promise(resolve => setTimeout(resolve, 20));
    // The events not yet flushed take the transcript past its count, so the read drops the oldest start from its copy.
    expect((await rt.sessions.history(ws.id)).some(e => e.type === "session.start" && e.requestId === "req_a")).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await rt.sessions.attachment(ws.id, threadId, "req_a", 0)).toEqual(image);
    release();
    await more.finished;
    await rt.close();
    const again = createRuntime({ backend, store, adapters: {} });
    await expect(again.sessions.attachment(ws.id, threadId, "req_a", 0)).rejects.toMatchObject({ kind: "not-found" });
    await again.close();
  });
});
