import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DAEMON_VERSION, STATE_SHAPE, type StateShape } from "@wsp/protocol";
import { writeOwn } from "@wsp/own-file";
import { migrate, sqliteStore, stateDbPath } from "../src/sqlite-store.js";
import { jsonFileStore, memoryStore, STATE_SHAPE_KEY, stateNotAnObjectLine, stateShapeUnreadableLine, stateUnreadableLine, stateWrittenByNewerLine, stateWrittenByOlderLine, type Data, type StateWriter, type Store } from "../src/store.js";

// Counted, so a test can say how often the state file itself was read and written.
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), renameSync: vi.fn(fs.renameSync) };
});

const dir = mkdtempSync(join(tmpdir(), "wsp-store-"));
/** Who a store in this file says wrote its file: every caller names a build, and this one is the suite. */
const WRITER = { wsp: "test", daemon: DAEMON_VERSION, bin: "/usr/local/bin/wsp" };
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/** A store that keeps its state on disk, as each kind lays it out: the suites below run against both. */
interface FileKind {
  name: string;
  make: (statePath: string, writer?: StateWriter) => Store;
  /** The file a refusal names and whose bytes it leaves alone. */
  file: (statePath: string) => string;
  /** Lays down a state holding these collections and this shape document, or none where it is undefined. */
  seed: (statePath: string, collections: Data, document: unknown) => void;
  /** The shape document a save left. */
  shape: (statePath: string) => unknown;
}

const JSON_KIND: FileKind = {
  name: "jsonFileStore",
  make: (path, writer = WRITER) => jsonFileStore(path, writer),
  file: path => path,
  seed: (path, collections, document) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...collections, ...(document !== undefined ? { [STATE_SHAPE_KEY]: document } : {}) }, null, 2));
  },
  shape: path => (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[STATE_SHAPE_KEY],
};

const SQLITE_KIND: FileKind = {
  name: "sqliteStore",
  make: (path, writer = WRITER) => sqliteStore(path, writer),
  file: stateDbPath,
  seed: (path, collections, document) => {
    mkdirSync(join(path, ".."), { recursive: true });
    const d = new DatabaseSync(stateDbPath(path));
    try {
      d.exec("begin");
      migrate(d, stateDbPath(path));
      for (const [c, records] of Object.entries(collections)) for (const [id, value] of Object.entries(records)) d.prepare("insert into collections values (?, ?, ?)").run(c, id, JSON.stringify(value));
      if (document !== undefined) d.prepare("insert into shape values (1, ?)").run(JSON.stringify(document));
      d.exec("commit");
    } finally {
      d.close();
    }
  },
  shape: path => {
    const d = new DatabaseSync(stateDbPath(path), { readOnly: true });
    try {
      return JSON.parse((d.prepare("select json from shape").get() as { json: string }).json);
    } finally {
      d.close();
    }
  },
};

const FILE_KINDS = [JSON_KIND, SQLITE_KIND];

function roundTrip(name: string, make: () => Store) {
  describe(name, () => {
    it("get/put/list/delete round-trips", async () => {
      const store = make();
      expect(await store.get("workspaces", "a")).toBeUndefined();
      await store.put("workspaces", "a", { id: "a", n: 1 });
      await store.put("workspaces", "b", { id: "b", n: 2 });
      expect(await store.get("workspaces", "a")).toEqual({ id: "a", n: 1 });
      const listed = await store.list("workspaces");
      expect(listed.map(v => (v as { id: string }).id).sort()).toEqual(["a", "b"]);
      await store.delete("workspaces", "a");
      expect(await store.get("workspaces", "a")).toBeUndefined();
      expect(await store.list("goldens")).toEqual([]);
    });
    it("blobs round-trip as bytes, latest write wins, delete forgets", async () => {
      const store = make();
      expect(await store.getBlob("vaults", "ws_1")).toBeUndefined();
      await store.putBlob("vaults", "ws_1", Buffer.from("v1"));
      await store.putBlob("vaults", "ws_1", Buffer.from([0, 255, 7]));
      expect(await store.getBlob("vaults", "ws_1")).toEqual(Buffer.from([0, 255, 7]));
      await store.deleteBlob("vaults", "ws_1");
      expect(await store.getBlob("vaults", "ws_1")).toBeUndefined();
    });
  });
}

roundTrip("memoryStore", () => memoryStore());
for (const kind of FILE_KINDS) roundTrip(kind.name, () => kind.make(join(mkdtempSync(join(dir, "round-")), "state.json")));

describe.each(FILE_KINDS)("$name persistence", kind => {
  it("survives a new instance over the same state, in the order the records were first written", async () => {
    const path = join(mkdtempSync(join(dir, "persist-")), "state.json");
    const s1 = kind.make(path);
    await s1.put("goldens", "default", { head: 1 });
    await s1.put("goldens", "b", { head: 2 });
    await s1.put("goldens", "a", { head: 3 });
    await s1.put("goldens", "default", { head: 4 });
    await s1.putBlob("vaults", "ws_1", Buffer.from("tgz"));
    const s2 = kind.make(path);
    expect(await s2.get("goldens", "default")).toEqual({ head: 4 });
    expect(await s2.keys("goldens")).toEqual(["default", "b", "a"]);
    expect(await s2.list("goldens")).toEqual([{ head: 4 }, { head: 2 }, { head: 3 }]);
    expect(await s2.getBlob("vaults", "ws_1")).toEqual(Buffer.from("tgz"));
  });

  it("marks each write of a blob apart, however close together, and names none for a blob that is not there", async () => {
    const store = kind.make(join(mkdtempSync(join(dir, "marks-")), "state.json"));
    expect(await store.statBlob("transcripts", "w")).toBeUndefined();
    await store.putBlob("transcripts", "w", Buffer.from("one"));
    const first = await store.statBlob("transcripts", "w");
    await store.putBlob("transcripts", "w", Buffer.from("two"));
    const second = await store.statBlob("transcripts", "w");
    expect(first?.bytes).toBe(3);
    expect(second?.bytes).toBe(3);
    expect(second?.at).not.toBe(first?.at);
    await store.deleteBlob("transcripts", "w");
    expect(await store.statBlob("transcripts", "w")).toBeUndefined();
  });

  it("and a write another instance made keeps its records beside this one's", async () => {
    const path = join(mkdtempSync(join(dir, "two-")), "state.json");
    const mine = kind.make(path);
    const theirs = kind.make(path);
    await mine.put("workspaces", "a", { id: "a" });
    await theirs.get("workspaces", "a");
    await Promise.all([mine.put("workspaces", "p", { id: "p" }), theirs.put("workspaces", "q", { id: "q" })]);
    expect((await kind.make(path).keys("workspaces")).sort()).toEqual(["a", "p", "q"]);
    expect((await mine.keys("workspaces")).sort()).toEqual(["a", "p", "q"]);
  });

  it("hands out copies, so a caller changing what it read changes nothing the next save writes", async () => {
    const path = join(mkdtempSync(join(dir, "copies-")), "state.json");
    const store = kind.make(path);
    await store.put("workspaces", "a", { id: "a", phase: "running" });
    ((await store.get("workspaces", "a")) as { phase: string }).phase = "paused";
    ((await store.list("workspaces"))[0] as { phase: string }).phase = "gone";
    await store.put("workspaces", "b", { id: "b" });
    expect(await kind.make(path).get("workspaces", "a")).toEqual({ id: "a", phase: "running" });
  });

  it("keeps what was put, not the object the caller goes on changing, nor what JSON drops", async () => {
    const store = kind.make(join(mkdtempSync(join(dir, "kept-")), "state.json"));
    const record = { id: "a", phase: "running", gone: undefined };
    await store.put("workspaces", "a", record);
    record.phase = "paused";
    expect(await store.get("workspaces", "a")).toStrictEqual({ id: "a", phase: "running" });
  });
});

describe("jsonFileStore persistence", () => {
  it("survives a new instance over the same file and writes real JSON", async () => {
    const path = join(dir, "persist.json");
    const s1 = jsonFileStore(path, WRITER);
    await s1.put("goldens", "default", { head: 1 });
    const s2 = jsonFileStore(path, WRITER);
    expect(await s2.get("goldens", "default")).toEqual({ head: 1 });
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });
  it("keeps blobs as files beside the json, never inside it", async () => {
    const path = join(dir, "blobs-home", "state.json");
    const store = jsonFileStore(path, WRITER);
    await store.putBlob("vaults", "ws_2", Buffer.from("tgz"));
    expect(readFileSync(join(dir, "blobs-home", "blobs", "vaults", "ws_2"), "utf8")).toBe("tgz");
    expect(existsSync(path) ? readFileSync(path, "utf8") : "").not.toContain("tgz");
    expect(await jsonFileStore(path, WRITER).getBlob("vaults", "ws_2")).toEqual(Buffer.from("tgz"));
  });
});

describe("jsonFileStore reads the file once", () => {
  const reads = (path: string): number => vi.mocked(readFileSync).mock.calls.filter(([at]) => at === path).length;
  const writes = (path: string): number => vi.mocked(renameSync).mock.calls.filter(([, to]) => to === path).length;

  it("and answers every read and write after from what it holds, until another process writes the file", async () => {
    // Every read parsed the whole file and every write rewrote it: at a few hundred megabytes of transcripts that
    // held a host's loop for seconds per call.
    const path = join(dir, "read-once.json");
    const store = jsonFileStore(path, WRITER);
    await store.put("workspaces", "a", { id: "a" });
    const before = reads(path);
    for (let i = 0; i < 5; i++) {
      await store.get("workspaces", "a");
      await store.list("workspaces");
      await store.put("workspaces", `b${i}`, { id: `b${i}` });
    }
    expect(reads(path) - before).toBe(0);
    await jsonFileStore(path, WRITER).put("projects", "p", { id: "p" });
    expect(await store.get("projects", "p")).toEqual({ id: "p" });
    expect(await store.keys("workspaces")).toHaveLength(6);
  });

  it("and a burst of writes made before the loop turns lands as one", async () => {
    const path = join(dir, "burst.json");
    const store = jsonFileStore(path, WRITER);
    await store.put("workspaces", "a", { id: "a" });
    const before = writes(path);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.put("workspaces", `w${i}`, { id: `w${i}` })));
    expect(writes(path) - before).toBe(1);
    expect(Object.keys((JSON.parse(readFileSync(path, "utf8")) as { workspaces: object }).workspaces)).toHaveLength(21);
  });

  it("and a write another process made while a save waited keeps its records beside this one's", async () => {
    const path = join(dir, "two-writers.json");
    const mine = jsonFileStore(path, WRITER);
    const theirs = jsonFileStore(path, WRITER);
    await mine.put("workspaces", "a", { id: "a" });
    await theirs.get("workspaces", "a");
    await Promise.all([mine.put("workspaces", "p", { id: "p" }), theirs.put("workspaces", "q", { id: "q" })]);
    expect((await jsonFileStore(path, WRITER).keys("workspaces")).sort()).toEqual(["a", "p", "q"]);
  });

});

describe.each(FILE_KINDS)("the shape the $name state was written in", kind => {
  const writer = { wsp: "0.2.0", daemon: DAEMON_VERSION, bin: "/Users/z/.local/bin/wsp" };
  const fresh = (name: string): string => join(mkdtempSync(join(dir, `${name}-`)), "state.json");
  /** Every read and write the store has, each refused in the one sentence. */
  const refusesAll = async (store: Store, refusal: string): Promise<void> => {
    await expect(store.get("workspaces", "a")).rejects.toThrow(refusal);
    await expect(store.list("workspaces")).rejects.toThrow(refusal);
    await expect(store.keys("workspaces")).rejects.toThrow(refusal);
    await expect(store.put("workspaces", "b", { id: "b" })).rejects.toThrow(refusal);
    await expect(store.delete("workspaces", "a")).rejects.toThrow(refusal);
    await expect(store.putBlob("vaults", "ws_1", Buffer.from("x"))).rejects.toThrow(refusal);
    await expect(store.getBlob("vaults", "ws_1")).rejects.toThrow(refusal);
  };

  it("is written beside the collections on every save, and no collection read ever sees it", async () => {
    const path = fresh("shape-written");
    const store = kind.make(path, writer);
    await store.put("workspaces", "a", { id: "a" });
    const held = kind.shape(path) as StateShape;
    expect(held).toMatchObject({ shape: STATE_SHAPE, ...writer });
    expect(Date.parse(held.at)).toBeGreaterThan(0);
    // Every other top-level name is a collection of documents by id; this one is not, so it reads as no collection
    // at all rather than as one whose ids are the document's own fields.
    expect(await store.list(STATE_SHAPE_KEY)).toEqual([]);
    expect(await store.keys(STATE_SHAPE_KEY)).toEqual([]);
    expect(await store.get(STATE_SHAPE_KEY, "shape")).toBeUndefined();
    // A save of a second collection keeps the first: the document sits beside them, it does not replace them.
    await store.put("projects", "p", { id: "p" });
    expect(await store.keys("workspaces")).toEqual(["a"]);
  });

  it("refuses every read and write of a state a newer wsp wrote, in one sentence naming the build, and leaves its bytes alone", async () => {
    const path = fresh("shape-newer");
    const wrote: StateShape = { shape: STATE_SHAPE + 1, wsp: "0.3.0", daemon: DAEMON_VERSION + 1, bin: "/Applications/wsp.app/Contents/Resources/bin.js", at: "2026-09-18T15:15:00.000Z" };
    kind.seed(path, { workspaces: { a: { id: "a" } } }, wrote);
    const before = readFileSync(kind.file(path));
    const refusal = stateWrittenByNewerLine(kind.file(path), wrote);
    expect(refusal).toBe(
      `${kind.file(path)} was written by a newer wsp (state shape ${STATE_SHAPE + 1}; this wsp reads ${STATE_SHAPE}; written 2026-09-18T15:15:00.000Z by /Applications/wsp.app/Contents/Resources/bin.js (wsp 0.3.0, daemon ${DAEMON_VERSION + 1})): run that wsp, or move the file aside`,
    );
    await refusesAll(kind.make(path, writer), refusal);
    expect(readFileSync(kind.file(path))).toEqual(before);
  });

  it("refuses every read and write of a state whose shape document does not parse, and leaves its bytes alone", async () => {
    // A copy of a state file had its $shape set to the bare number 3 by hand: no build can be named off that.
    for (const document of [3, null, { shape: STATE_SHAPE }]) {
      const path = fresh("shape-not-a-document");
      kind.seed(path, { workspaces: { a: { id: "a" } } }, document);
      const before = readFileSync(kind.file(path));
      await refusesAll(kind.make(path, writer), stateShapeUnreadableLine(kind.file(path), document));
      expect(readFileSync(kind.file(path))).toEqual(before);
    }
  });

  it("refuses every read and write of a state in an older shape, or with no shape at all, in one sentence, and leaves its bytes alone", async () => {
    const older: StateShape = { shape: STATE_SHAPE - 1, wsp: "0.1.0", daemon: DAEMON_VERSION - 1, bin: "/Users/z/.local/bin/wsp", at: "2026-09-10T08:00:00.000Z" };
    for (const document of [older, undefined]) {
      const path = fresh("shape-older");
      kind.seed(path, { workspaces: { a: { id: "a" } } }, document);
      const before = readFileSync(kind.file(path));
      await refusesAll(kind.make(path, writer), stateWrittenByOlderLine(kind.file(path), document));
      expect(readFileSync(kind.file(path))).toEqual(before);
    }
    expect(stateWrittenByOlderLine("/Users/z/.wsp/state.json", undefined)).toBe(
      `/Users/z/.wsp/state.json holds state in an older shape (none recorded; this wsp reads shape ${STATE_SHAPE}): move the file aside and this wsp starts a fresh one`,
    );
    expect(stateWrittenByOlderLine("/Users/z/.wsp/state.json", older)).toBe(
      `/Users/z/.wsp/state.json holds state in an older shape (shape ${STATE_SHAPE - 1}, written 2026-09-10T08:00:00.000Z by /Users/z/.local/bin/wsp (wsp 0.1.0, daemon ${DAEMON_VERSION - 1}); this wsp reads shape ${STATE_SHAPE}): move the file aside and this wsp starts a fresh one`,
    );
  });

  it("is 2 on this build, since the seeded record changed shape, and a state at 3 is refused as newer", async () => {
    // The number every save writes, pinned: a record's schema changed, so a host that reads another number meets a
    // file it cannot read and says so instead of reading a record in a form it does not know.
    expect(STATE_SHAPE).toBe(2);
    const path = fresh("shape-three");
    const wrote: StateShape = { shape: 3, wsp: "0.4.0", daemon: DAEMON_VERSION, bin: "/Users/z/.local/bin/wsp", at: "2026-09-19T08:00:00.000Z" };
    kind.seed(path, { projects: { p: { id: "p" } } }, wrote);
    await expect(kind.make(path, writer).get("projects", "p")).rejects.toThrow(stateWrittenByNewerLine(kind.file(path), wrote));
  });

  it("refuses a state that another process moved to a newer shape while this one held it open", async () => {
    const path = fresh("shape-moved");
    const store = kind.make(path, writer);
    await store.put("workspaces", "a", { id: "a" });
    const wrote: StateShape = { shape: STATE_SHAPE + 1, wsp: "0.3.0", daemon: DAEMON_VERSION, bin: "/Users/z/.local/bin/wsp", at: "2026-09-19T08:00:00.000Z" };
    if (kind === SQLITE_KIND) {
      const d = new DatabaseSync(stateDbPath(path));
      d.prepare("update shape set json = ?").run(JSON.stringify(wrote));
      d.close();
    } else kind.seed(path, { workspaces: { a: { id: "a" } } }, wrote);
    await expect(store.get("workspaces", "a")).rejects.toThrow(stateWrittenByNewerLine(kind.file(path), wrote));
  });
});

describe("the shape a state file was written in", () => {
  const writer = { wsp: "0.2.0", daemon: DAEMON_VERSION, bin: "/Users/z/.local/bin/wsp" };

  it("refuses every read and write of a file that is present and does not parse, in one sentence naming the path, and leaves its bytes alone", async () => {
    // A hand edit with a trailing comma, a copy torn by a machine that died mid-write: the file read as an empty
    // store and the next save wrote this build's document over it, holding the one record that save was making.
    const path = join(dir, "does-not-parse.json");
    const bytes = '{"workspaces": {"a": {"id": "a"}},}';
    writeFileSync(path, bytes);
    // The parser's own words, read off the same bytes, since node words them differently from version to version.
    let why = "";
    try {
      JSON.parse(bytes);
    } catch (e) {
      why = (e as Error).message;
    }
    const store = jsonFileStore(path, writer);
    const refusal = stateUnreadableLine(path, why);
    await expect(store.get("workspaces", "a")).rejects.toThrow(refusal);
    await expect(store.list("workspaces")).rejects.toThrow(refusal);
    await expect(store.keys("workspaces")).rejects.toThrow(refusal);
    await expect(store.put("workspaces", "b", { id: "b" })).rejects.toThrow(refusal);
    await expect(store.delete("workspaces", "a")).rejects.toThrow(refusal);
    await expect(store.putBlob("vaults", "ws_1", Buffer.from("x"))).rejects.toThrow(refusal);
    expect(readFileSync(path, "utf8")).toBe(bytes);

    // A path with no file behind it is not this rule: that is the first wsp up on a fresh home, which reads an
    // empty store and writes one at its first save.
    const fresh = join(dir, "fresh-home", "state.json");
    const first = jsonFileStore(fresh, writer);
    expect(await first.keys("workspaces")).toEqual([]);
    await first.put("workspaces", "a", { id: "a" });
    expect(await first.get("workspaces", "a")).toEqual({ id: "a" });
  });

  it("refuses a file whose bytes parse and are no state file, naming what it holds, and leaves its bytes alone", async () => {
    // Every top-level name of a state file is a collection of documents by id, so a number, a string, a list or
    // null leaves nothing to read records out of; each read as an empty store, and the next save wrote over it.
    for (const held of [3, null, [{ id: "a" }], "state"]) {
      const path = join(dir, `not-a-state-${typeof held}-${Array.isArray(held) ? "list" : String(held)}.json`);
      writeFileSync(path, JSON.stringify(held));
      const before = readFileSync(path, "utf8");
      const store = jsonFileStore(path, writer);
      const refusal = stateNotAnObjectLine(path, held);
      await expect(store.get("workspaces", "a")).rejects.toThrow(refusal);
      await expect(store.list("workspaces")).rejects.toThrow(refusal);
      await expect(store.keys("workspaces")).rejects.toThrow(refusal);
      await expect(store.put("workspaces", "b", { id: "b" })).rejects.toThrow(refusal);
      await expect(store.delete("workspaces", "a")).rejects.toThrow(refusal);
      await expect(store.putBlob("vaults", "ws_1", Buffer.from("x"))).rejects.toThrow(refusal);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });
});

describe("sqliteStore", () => {
  const home = (): string => mkdtempSync(join(dir, "sqlite-"));
  const tables = (path: string): string[] => {
    const d = new DatabaseSync(path, { readOnly: true });
    try {
      return (d.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[]).map(r => r.name);
    } finally {
      d.close();
    }
  };

  it("keeps its records in state.db beside the state file, in WAL mode, and writes no state.json", async () => {
    const h = home();
    const store = sqliteStore(join(h, "state.json"), WRITER);
    await store.put("workspaces", "a", { id: "a" });
    await store.putBlob("transcripts", "a", Buffer.from("events"));
    expect(existsSync(join(h, "state.json"))).toBe(false);
    expect(existsSync(join(h, "blobs"))).toBe(false);
    expect(tables(join(h, "state.db"))).toEqual(["blobs", "collections", "events", "migrations", "shape", "transcript_index"]);
    const d = new DatabaseSync(join(h, "state.db"), { readOnly: true });
    try {
      expect(d.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(d.prepare("select collection, id, json from collections").all().map(r => ({ ...r }))).toEqual([{ collection: "workspaces", id: "a", json: '{"id":"a"}' }]);
      expect(d.prepare("select module, version from migrations order by module").all().map(r => ({ ...r }))).toEqual([
        { module: "store", version: 1 },
        { module: "transcripts", version: 1 },
      ]);
    } finally {
      d.close();
    }
  });

  it("makes the state's folder where it is not made yet, the database in it the owner's alone", async () => {
    const folder = join(home(), "not", "made", "yet");
    const store = sqliteStore(join(folder, "state.json"), WRITER);
    await store.put("workspaces", "a", { id: "a" });
    expect(await store.keys("workspaces")).toEqual(["a"]);
    expect(statSync(join(folder, "state.db")).mode & 0o777).toBe(0o600);
  });

  it("refuses a state.db that is no database, naming it, and leaves its bytes alone", async () => {
    const h = home();
    writeFileSync(join(h, "state.db"), "not a database at all, just some bytes someone left here");
    const before = readFileSync(join(h, "state.db"));
    const store = sqliteStore(join(h, "state.json"), WRITER);
    await expect(store.keys("workspaces")).rejects.toThrow(`${join(h, "state.db")} does not read as a state file (`);
    await expect(store.put("workspaces", "a", { id: "a" })).rejects.toThrow("move the file aside, or put back a copy a wsp wrote");
    expect(readFileSync(join(h, "state.db"))).toEqual(before);
  });

  describe("the one-time import of a state file", () => {
    const seedJson = (h: string): void => {
      writeFileSync(
        join(h, "state.json"),
        JSON.stringify({ workspaces: { b: { id: "b" }, a: { id: "a", n: 1 } }, sessions: { a: { workspaceId: "a", sessions: [] } }, [STATE_SHAPE_KEY]: { shape: STATE_SHAPE, ...WRITER, at: "2026-10-01T00:00:00.000Z" } }),
      );
      writeOwn(h, join("blobs", "transcripts", "a"), Buffer.from('{"workspaceId":"a","events":[]}'));
      writeOwn(h, join("blobs", "image-vaults", "default@v1"), Buffer.from([0, 1, 2, 255]));
    };

    it("moves every collection and every blob into state.db, keeps their order and marks, and moves state.json aside", async () => {
      const h = home();
      seedJson(h);
      const marks = { transcripts: statSync(join(h, "blobs", "transcripts", "a")).mtimeMs };
      const json = readFileSync(join(h, "state.json"));
      const store = sqliteStore(join(h, "state.json"), WRITER);
      expect(await store.keys("workspaces")).toEqual(["b", "a"]);
      expect(await store.get("workspaces", "a")).toEqual({ id: "a", n: 1 });
      expect(await store.list("sessions")).toEqual([{ workspaceId: "a", sessions: [] }]);
      expect(await store.getBlob("image-vaults", "default@v1")).toEqual(Buffer.from([0, 1, 2, 255]));
      // The index a transcript left beside it names the transcript by its size and the moment it was written, so the
      // move keeps both, and the first boot after it reads every index it already had.
      expect(await store.statBlob("transcripts", "a")).toEqual({ bytes: 31, at: marks.transcripts });
      expect(existsSync(join(h, "state.json"))).toBe(false);
      expect(readFileSync(join(h, "state.json.imported"))).toEqual(json);
      expect(readdirSync(h).filter(f => f.includes("importing"))).toEqual([]);
    });

    it("runs once: a second store over the same home reads the database and imports nothing again", async () => {
      const h = home();
      seedJson(h);
      await sqliteStore(join(h, "state.json"), WRITER).put("workspaces", "c", { id: "c" });
      expect(await sqliteStore(join(h, "state.json"), WRITER).keys("workspaces")).toEqual(["b", "a", "c"]);
      expect(readdirSync(h).filter(f => f.startsWith("state.json"))).toEqual(["state.json.imported"]);
    });

    it("cut short between the link and the move, is finished at the next start: state.json moved aside, the database the state", async () => {
      // A crash after the database was linked into place and before state.json was moved left both, and a later run
      // on the JSON store, or an older wsp, read the stale file as the state.
      const h = home();
      seedJson(h);
      await sqliteStore(join(h, "state.json"), WRITER).put("workspaces", "c", { id: "c" });
      const stale = readFileSync(join(h, "state.json.imported"));
      writeFileSync(join(h, "state.json"), stale);
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await sqliteStore(join(h, "state.json"), WRITER).keys("workspaces")).toEqual(["b", "a", "c"]);
        expect(existsSync(join(h, "state.json"))).toBe(false);
        const aside = readdirSync(h).filter(f => f.startsWith("state.json.imported."));
        expect(aside).toHaveLength(1);
        expect(readFileSync(join(h, aside[0]!))).toEqual(stale);
        expect(readFileSync(join(h, "state.json.imported"))).toEqual(stale);
        expect(warned.mock.calls.map(c => String(c[0]))).toEqual([`${join(h, "state.json")} stood beside ${join(h, "state.db")}, which holds the state, so it was moved to ${join(h, aside[0]!)}`]);
      } finally {
        warned.mockRestore();
      }
    });

    it("refuses a state file in a newer shape in the JSON store's own words, and makes no database", async () => {
      const h = home();
      const wrote: StateShape = { shape: STATE_SHAPE + 1, wsp: "0.3.0", daemon: DAEMON_VERSION, bin: "/Users/z/.local/bin/wsp", at: "2026-09-19T08:00:00.000Z" };
      JSON_KIND.seed(join(h, "state.json"), { workspaces: { a: { id: "a" } } }, wrote);
      const before = readFileSync(join(h, "state.json"));
      const store = sqliteStore(join(h, "state.json"), WRITER);
      await expect(store.keys("workspaces")).rejects.toThrow(stateWrittenByNewerLine(join(h, "state.json"), wrote));
      await expect(store.put("workspaces", "b", { id: "b" })).rejects.toThrow(stateWrittenByNewerLine(join(h, "state.json"), wrote));
      expect(readFileSync(join(h, "state.json"))).toEqual(before);
      expect(readdirSync(h).sort()).toEqual(["state.json"]);
    });

    it("that fails part way leaves state.json as the state and no database, and the next start imports it whole", async () => {
      const h = home();
      seedJson(h);
      // A blob that cannot be read stops the import after every collection and the first blob went in.
      chmodSync(join(h, "blobs", "transcripts", "a"), 0o000);
      const store = sqliteStore(join(h, "state.json"), WRITER);
      await expect(store.keys("workspaces")).rejects.toThrow("EACCES");
      expect(readdirSync(h).sort()).toEqual(["blobs", "state.json"]);
      chmodSync(join(h, "blobs", "transcripts", "a"), 0o600);
      expect(await store.keys("workspaces")).toEqual(["b", "a"]);
      expect(await store.getBlob("transcripts", "a")).toEqual(Buffer.from('{"workspaceId":"a","events":[]}'));
    });
  });

  describe("the module list", () => {
    it("holds the store's own tables and the transcripts", async () => {
      const { STORE_MODULES } = await import("../src/sqlite-store.js");
      expect(STORE_MODULES.map(m => [m.name, m.migrations.length])).toEqual([
        ["store", 1],
        ["transcripts", 1],
      ]);
    });

    it("runs a module's migrations in order and each once, recorded per module, and a later migration only once the earlier ran", async () => {
      const h = home();
      const usage = { name: "usage", migrations: ["create table usage_rows (at integer not null, tokens integer not null)"] };
      const { STORE_MODULES } = await import("../src/sqlite-store.js");
      const first = sqliteStore(join(h, "state.json"), WRITER, [...STORE_MODULES, usage]);
      await first.put("workspaces", "a", { id: "a" });
      const grown = { ...usage, migrations: [...usage.migrations, "create index usage_at on usage_rows (at)"] };
      await sqliteStore(join(h, "state.json"), WRITER, [...STORE_MODULES, grown]).keys("workspaces");
      await sqliteStore(join(h, "state.json"), WRITER, [...STORE_MODULES, grown]).keys("workspaces");
      const d = new DatabaseSync(join(h, "state.db"), { readOnly: true });
      try {
        expect(d.prepare("select module, version from migrations order by module").all().map(r => ({ ...r }))).toEqual([
          { module: "store", version: 1 },
          { module: "transcripts", version: 1 },
          { module: "usage", version: 2 },
        ]);
        expect(d.prepare("select name from sqlite_master where name like 'usage%' order by name").all().map(r => r["name"])).toEqual(["usage_at", "usage_rows"]);
      } finally {
        d.close();
      }
    });

    it("refuses a database a newer wsp migrated past what this build knows, naming the module and the build", async () => {
      const h = home();
      await sqliteStore(join(h, "state.json"), WRITER).put("workspaces", "a", { id: "a" });
      const d = new DatabaseSync(join(h, "state.db"));
      d.prepare("update migrations set version = 2 where module = 'store'").run();
      d.close();
      await expect(sqliteStore(join(h, "state.json"), WRITER).keys("workspaces")).rejects.toThrow(
        `${join(h, "state.db")} was migrated by a newer wsp (store at migration 2; this wsp knows 1; written `,
      );
    });
  });
});

describe("what the owner's state folder stands at", () => {
  const modeOf = (path: string): number => statSync(path).mode & 0o777;

  it("the state file, the blobs and the folders over them are this user's alone, whatever the umask", async () => {
    const home = mkdtempSync(join(dir, "own-"));
    const path = join(home, "state.json");
    const store = jsonFileStore(path, WRITER);
    await store.put("workspaces", "a", { id: "a" });
    await store.putBlob("image-vaults", "default@v1", Buffer.from("sign-ins"));
    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(path)).toBe(0o600);
    expect(modeOf(join(home, "blobs"))).toBe(0o700);
    expect(modeOf(join(home, "blobs", "image-vaults"))).toBe(0o700);
    expect(modeOf(join(home, "blobs", "image-vaults", "default@v1"))).toBe(0o600);
  });

  it("a folder and a file an older build left wider are repaired at the next write", async () => {
    const home = mkdtempSync(join(dir, "wide-"));
    const path = join(home, "state.json");
    mkdirSync(join(home, "blobs", "image-vaults"), { recursive: true });
    for (const wide of [home, join(home, "blobs"), join(home, "blobs", "image-vaults")]) chmodSync(wide, 0o755);
    writeFileSync(path, JSON.stringify({ [STATE_SHAPE_KEY]: { shape: STATE_SHAPE, ...WRITER, at: "2026-09-27T00:00:00.000Z" } }), { mode: 0o644 });
    chmodSync(path, 0o644);
    const store = jsonFileStore(path, WRITER);
    await store.put("workspaces", "a", { id: "a" });
    await store.putBlob("image-vaults", "default@v1", Buffer.from("sign-ins"));
    expect([modeOf(home), modeOf(join(home, "blobs")), modeOf(join(home, "blobs", "image-vaults"))]).toEqual([0o700, 0o700, 0o700]);
    expect(modeOf(path)).toBe(0o600);
    expect(await store.get("workspaces", "a")).toEqual({ id: "a" });
  });

  it("the database, its WAL and the folder over it are this user's alone, whatever the umask", async () => {
    const home = mkdtempSync(join(dir, "own-db-"));
    chmodSync(home, 0o755);
    const was = process.umask(0o022);
    try {
      const store = sqliteStore(join(home, "state.json"), WRITER);
      await store.put("workspaces", "a", { id: "a" });
      await store.putBlob("image-vaults", "default@v1", Buffer.from("sign-ins"));
    } finally {
      process.umask(was);
    }
    expect(modeOf(home)).toBe(0o700);
    expect(["state.db", "state.db-wal", "state.db-shm"].map(f => [f, modeOf(join(home, f))])).toEqual([
      ["state.db", 0o600],
      ["state.db-wal", 0o600],
      ["state.db-shm", 0o600],
    ]);
  });

  it("nothing above the folder the writer was handed is touched", () => {
    const over = mkdtempSync(join(dir, "over-"));
    chmodSync(over, 0o755);
    const home = join(over, "wsp");
    writeOwn(home, "state.json", "{}");
    expect(modeOf(over)).toBe(0o755);
    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(join(home, "state.json"))).toBe(0o600);
  });
});
