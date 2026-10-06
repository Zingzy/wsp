// SPDX-License-Identifier: AGPL-3.0-only
// The host's state in one SQLite database beside the state file, through node's
// own binding. A save is one row written, where the JSON document rewrote every
// record on every save. Each module of the database owns its tables and its
// numbered migrations, and the migrations table says how far each one has run.
import { closeSync, existsSync, linkSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { sqliteBinding } from "@wsp/engine";
import { OWN_FILE_MODE, ownFolder } from "@wsp/own-file";
import { StateShape, stateWriterWords } from "@wsp/protocol";
import { TRANSCRIPTS_MODULE, transcriptRows } from "./sqlite-transcripts.js";
import { readStateFile, refuseOtherShape, shapeNow, stateShapeUnreadableLine, stateUnreadableLine, type BlobMark, type StateWriter, type Store } from "./store.js";

/** One module of the state database: the tables it owns, made and changed by its migrations, which run in order
 * and each once. A migration is never edited once it has shipped; a change is the next one in the list. */
export interface StoreModule {
  name: string;
  migrations: readonly string[];
}

/** Every module of the state database. A later one (usage, a response cache, search) is one entry here and the
 * module that holds its tables. */
export const STORE_MODULES: readonly StoreModule[] = [
  {
    name: "store",
    migrations: [
      `create table collections (collection text not null, id text not null, json text not null, primary key (collection, id));
       create table blobs (collection text not null, id text not null, bytes blob not null, at real not null, primary key (collection, id));
       create table shape (one integer primary key check (one = 1), json text not null);`,
    ],
  },
  TRANSCRIPTS_MODULE,
];

/** The database a state file's records live in, beside it. */
export const stateDbPath = (statePath: string): string => join(dirname(statePath), "state.db");

/** Where an imported state file is moved, beside the database, so a person can still read what it held. */
const importedStatePath = (statePath: string): string => `${statePath}.imported`;

/** Moves the state file aside, never over a file an earlier move left there, and answers where it went. */
function moveAside(statePath: string): string {
  const aside = existsSync(importedStatePath(statePath)) ? `${importedStatePath(statePath)}.${Date.now()}` : importedStatePath(statePath);
  renameSync(statePath, aside);
  return aside;
}

/** How long a write waits on another process's write before it fails: the doctor and init run a runtime of their
 * own over the same database. */
const BUSY_MS = 10_000;

/** How often the checkpointer copies the WAL into the database while writes happen. Left to SQLite's own threshold,
 * the commit that crosses it does the copy on the host's loop, since node's binding is synchronous: under a 5000-event
 * turn's flushes 13 commits in 40 paid 10 to 30 ms for it, and each run's worst 17 to 340 ms. A checkpoint every second
 * competed with the flushes' reads for the disk over a cold page cache. */
const CHECKPOINT_EVERY_MS = 2_000;

/** The WAL past which a commit checkpoints after all, so a checkpointer that stalled or died cannot let it grow
 * without end. */
export const WAL_BOUND_BYTES = 64 * 1024 * 1024;

/** The WAL file a commit cuts back to once a checkpoint has copied it, so a burst does not keep its size on disk. */
export const WAL_KEPT_BYTES = 16 * 1024 * 1024;

/** Threads in a row that may end early before the checkpoints are left to the bound. One that ran this long checkpointed
 * and counts as no failure. */
const CHECKPOINTER_TRIES = 3;
const CHECKPOINTER_LIVED_MS = 10 * CHECKPOINT_EVERY_MS;

/** A passive checkpoint waits on no writer and no writer waits on it. It retries until the WAL is whole in the
 * database, since a reader holding an old snapshot leaves the rest for later. The store is never closed, so the
 * thread ends with the process or with the database's file, which it opens read-write so it never makes one. Every
 * module is reached through getBuiltinModule, since a worker of a process run with --input-type=module is a module,
 * where require is not defined. */
const CHECKPOINTER = `
const { workerData } = process.getBuiltinModule("node:worker_threads");
const { existsSync } = process.getBuiltinModule("node:fs");
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
let version, checkpoint, d, done;
const end = () => {
  clearInterval(tick);
  d?.close();
};
const tick = setInterval(() => {
  try {
    if (!existsSync(workerData.path)) return end();
    if (d === undefined) {
      d = new DatabaseSync(new URL(workerData.url));
      d.exec("pragma busy_timeout = " + workerData.busyMs);
      version = d.prepare("pragma data_version");
      checkpoint = d.prepare("pragma wal_checkpoint(passive)");
    }
    const now = version.get().data_version;
    if (now === done) return;
    const r = checkpoint.get();
    if (r.log === r.checkpointed) done = now;
  } catch (e) {
    if (!existsSync(workerData.path)) return end();
    throw e;
  }
}, workerData.every);
`;

/** Checkpoints the database on a thread of its own, with a connection of its own, off the loop that writes it. A
 * thread that cannot be made or ends while the database is there is made again one interval later. */
function checkpointer(dbPath: string, tries = CHECKPOINTER_TRIES): void {
  const born = Date.now();
  const again = (why: string): void => {
    const left = Date.now() - born >= CHECKPOINTER_LIVED_MS ? CHECKPOINTER_TRIES : tries - 1;
    if (left > 0) setTimeout(() => checkpointer(dbPath, left), CHECKPOINT_EVERY_MS).unref();
    else console.warn(`the checkpoints of ${dbPath} stopped (${why}), so a commit takes one past ${WAL_BOUND_BYTES / 1048576} MB of WAL`);
  };
  const url = pathToFileURL(dbPath);
  url.searchParams.set("mode", "rw");
  let w: Worker;
  try {
    w = new Worker(CHECKPOINTER, { eval: true, workerData: { path: dbPath, url: url.href, every: CHECKPOINT_EVERY_MS, busyMs: BUSY_MS } });
  } catch (e) {
    again(e instanceof Error ? e.message : String(e));
    return;
  }
  w.unref();
  let why = "the thread ended";
  w.on("error", (e: unknown) => (why = e instanceof Error ? e.message : String(e)));
  w.on("exit", () => {
    if (existsSync(dbPath)) again(why);
  });
}

/** Why a host will not open a database a newer wsp migrated: its tables may be in a form this build cannot write. */
export const stateMigratedByNewerLine = (dbPath: string, module: string, at: number, knows: number, wrote: StateShape | undefined): string =>
  `${dbPath} was migrated by a newer wsp (${module} at migration ${at}; this wsp knows ${knows}${wrote === undefined ? "" : `; written ${wrote.at} by ${stateWriterWords(wrote)}`}): run that wsp, or move the file aside`;

const migrationsTable = "create table if not exists migrations (module text primary key, version integer not null)";

/** Runs every module's migrations this database has not had yet, each module's in order, in the caller's
 * transaction. A module the database is past is refused, since this build does not know its tables. */
export function migrate(d: DatabaseSync, dbPath: string, modules: readonly StoreModule[] = STORE_MODULES): void {
  d.exec(migrationsTable);
  const at = d.prepare("select version from migrations where module = ?");
  const set = d.prepare("insert into migrations (module, version) values (?, ?) on conflict (module) do update set version = excluded.version");
  for (const m of modules) {
    const done = Number((at.get(m.name) as { version: number } | undefined)?.version ?? 0);
    if (done > m.migrations.length) throw new Error(stateMigratedByNewerLine(dbPath, m.name, done, m.migrations.length, shapeIn(d, dbPath)));
    for (let i = done; i < m.migrations.length; i++) d.exec(m.migrations[i]!);
    if (done < m.migrations.length) set.run(m.name, m.migrations.length);
  }
}

const hasTable = (d: DatabaseSync, name: string): boolean => d.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== undefined;

/** The shape document the database holds, nothing where it holds none, and a refusal where it holds one that does
 * not parse. */
function shapeIn(d: DatabaseSync, dbPath: string): StateShape | undefined {
  if (!hasTable(d, "shape")) return undefined;
  const row = d.prepare("select json from shape where one = 1").get() as { json: string } | undefined;
  if (row === undefined) return undefined;
  let document: unknown;
  try {
    document = JSON.parse(row.json);
  } catch {
    document = row.json;
  }
  const wrote = StateShape.safeParse(document);
  if (!wrote.success) throw new Error(stateShapeUnreadableLine(dbPath, document));
  return wrote.data;
}

/** A file of the owner's at 0600, made empty when it is not there and never truncated when it is: an empty file is
 * an empty database, and the WAL and shared memory files SQLite makes beside it take its mode. */
function ownEmpty(path: string): void {
  ownFolder(dirname(path));
  try {
    closeSync(openSync(path, "wx", OWN_FILE_MODE));
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
  }
}

function open(path: string): DatabaseSync {
  const { DatabaseSync } = sqliteBinding();
  const d = new DatabaseSync(path);
  d.exec(`pragma busy_timeout = ${BUSY_MS}`);
  return d;
}

/** A leftover of writeOwn's, which a crash mid-write left beside the blob it was writing. */
const writeOwnLeftover = /\.\d+-\d+-[a-z0-9]+\.tmp$/;

/** Every blob the JSON store kept as a file under blobs/<collection>/<id>, with its mark as it stood, so the index
 * a transcript left beside it still matches the transcript after the move. */
function* fileBlobs(statePath: string): Generator<{ collection: string; id: string; path: string }> {
  const root = join(dirname(statePath), "blobs");
  if (!existsSync(root)) return;
  for (const c of readdirSync(root, { withFileTypes: true })) {
    if (!c.isDirectory()) continue;
    for (const b of readdirSync(join(root, c.name), { withFileTypes: true })) {
      if (b.isDirectory() || writeOwnLeftover.test(b.name)) continue;
      yield { collection: c.name, id: b.name, path: join(root, c.name, b.name) };
    }
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
};

/** The databases an import whose process is gone left half built, and this process's own from a pid used before:
 * nothing will ever link them, and one is as large as the state. */
function clearDeadBuilds(dbPath: string): void {
  const prefix = `${basename(dbPath)}.importing-`;
  for (const name of readdirSync(dirname(dbPath))) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length).split("-")[0]);
    if (pid === process.pid || !alive(pid)) rmSync(join(dirname(dbPath), name), { force: true });
  }
}

/** The state file's records and blobs, moved into a new database in one transaction. The database is built under a
 * name of this process's own and linked into place only once it is whole, so a crash anywhere before leaves the state
 * file as the state and no database; a second start importing at the same time links nothing over the first's. The
 * state file is moved aside after, never deleted. A state file this build cannot read is refused before anything is
 * made, in the JSON store's own words. */
function importStateFile(statePath: string, writer: StateWriter, modules: readonly StoreModule[] = STORE_MODULES): void {
  const data = readStateFile(statePath);
  if (data === undefined) return;
  const dbPath = stateDbPath(statePath);
  const building = `${dbPath}.importing-${process.pid}`;
  clearDeadBuilds(dbPath);
  ownEmpty(building);
  try {
    const d = open(building);
    try {
      d.exec("begin");
      migrate(d, building, modules);
      d.prepare("insert into shape (one, json) values (1, ?)").run(JSON.stringify(shapeNow(writer)));
      const put = d.prepare("insert into collections (collection, id, json) values (?, ?, ?)");
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, value] of Object.entries(records ?? {})) {
          const json = JSON.stringify(value);
          if (json !== undefined) put.run(collection, id, json);
        }
      }
      const blob = d.prepare("insert into blobs (collection, id, bytes, at) values (?, ?, ?, ?)");
      for (const b of fileBlobs(statePath)) blob.run(b.collection, b.id, readFileSync(b.path), statSync(b.path).mtimeMs);
      d.exec("commit");
    } finally {
      d.close();
    }
    try {
      linkSync(building, dbPath);
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") return;
      throw e;
    }
    moveAside(statePath);
  } finally {
    rmSync(building, { force: true });
  }
}

/** The state in SQLite. Opened at the first call, which is where a state file an earlier build left is imported and
 * where a database in another shape is refused; each call after re-reads the shape only when another process has
 * written the database since. */
export function sqliteStore(statePath: string, writer: StateWriter, modules: readonly StoreModule[] = STORE_MODULES): Store {
  const dbPath = stateDbPath(statePath);
  let held: Held | undefined;
  /** Monotonic, so two writes of one blob inside a millisecond are still two marks. */
  let last = 0;
  const stamp = (): number => (last = Math.max(performance.timeOrigin + performance.now(), last + 0.001));
  /** A database holding no shape table yet is a fresh one; one that holds the table is read in no other shape. */
  const refuseShape = (d: DatabaseSync): void => {
    if (hasTable(d, "shape")) refuseOtherShape(dbPath, shapeIn(d, dbPath));
  };

  const ready = (): Held => {
    if (held !== undefined) {
      const now = dataVersion(held.s);
      if (now !== held.seen) {
        refuseShape(held.d);
        held.seen = now;
      }
      return held;
    }
    if (!existsSync(dbPath)) importStateFile(statePath, writer, modules);
    ownEmpty(dbPath);
    let d: DatabaseSync;
    try {
      d = open(dbPath);
      // The first read is where a file that is no database fails; opening it reads nothing.
      hasTable(d, "shape");
    } catch (e) {
      throw new Error(stateUnreadableLine(dbPath, e instanceof Error ? e.message : String(e)));
    }
    try {
      // Before the switch to WAL, which rewrites the header of a database that was not in it: a refused database is
      // left as it was found.
      refuseShape(d);
      d.exec("pragma journal_mode = wal");
      d.exec("pragma synchronous = normal");
      const page = Number((d.prepare("pragma page_size").get() as { page_size: number }).page_size);
      d.exec(`pragma wal_autocheckpoint = ${Math.ceil(WAL_BOUND_BYTES / page)}`);
      d.exec(`pragma journal_size_limit = ${WAL_KEPT_BYTES}`);
      d.exec("begin immediate");
      try {
        refuseShape(d);
        migrate(d, dbPath, modules);
        if (shapeIn(d, dbPath) === undefined) d.prepare("insert into shape (one, json) values (1, ?)").run(JSON.stringify(shapeNow(writer)));
        d.exec("commit");
      } catch (e) {
        d.exec("rollback");
        throw e;
      }
    } catch (e) {
      d.close();
      throw e;
    }
    const s = statements(d);
    held = { d, s, seen: dataVersion(s), stamped: false };
    checkpointer(dbPath);
    // An import cut short between the link and the move leaves the state file beside a whole database. Left there,
    // a run on the JSON store or an older wsp would read it as the state, so the move is finished here.
    if (existsSync(statePath)) console.warn(`${statePath} stood beside ${dbPath}, which holds the state, so it was moved to ${moveAside(statePath)}`);
    return held;
  };
  /** The first write of this process says which build wrote the database last, as every save of the JSON document did. */
  const writing = (): Statements => {
    const h = ready();
    if (!h.stamped) {
      h.s.stamp.run(JSON.stringify(shapeNow(writer)));
      h.stamped = true;
    }
    return h.s;
  };

  return {
    transcripts: transcriptRows(() => ready().d),
    async get(collection, id) {
      const row = ready().s.get.get(collection, id) as { json: string } | undefined;
      return row === undefined ? undefined : JSON.parse(row.json);
    },
    async put(collection, id, value) {
      const json = JSON.stringify(value);
      const s = writing();
      if (json === undefined) s.delete.run(collection, id);
      else s.put.run(collection, id, json);
    },
    async list(collection) {
      return (ready().s.list.all(collection) as { json: string }[]).map(r => JSON.parse(r.json));
    },
    async keys(collection) {
      return (ready().s.keys.all(collection) as { id: string }[]).map(r => r.id);
    },
    async delete(collection, id) {
      writing().delete.run(collection, id);
    },
    async getBlob(collection, id) {
      const row = ready().s.getBlob.get(collection, id) as { bytes: Uint8Array } | undefined;
      return row === undefined ? undefined : Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
    },
    async putBlob(collection, id, bytes) {
      writing().putBlob.run(collection, id, bytes, stamp());
    },
    async deleteBlob(collection, id) {
      writing().deleteBlob.run(collection, id);
    },
    async statBlob(collection, id): Promise<BlobMark | undefined> {
      const row = ready().s.statBlob.get(collection, id) as { bytes: number; at: number } | undefined;
      return row === undefined ? undefined : { bytes: Number(row.bytes), at: row.at };
    },
  };
}

/** What another connection's commit moves and this connection's own does not. */
const dataVersion = (s: Statements): number => Number((s.dataVersion.get() as { data_version: number }).data_version);

interface Held {
  d: DatabaseSync;
  s: Statements;
  seen: number;
  stamped: boolean;
}

interface Statements {
  get: StatementSync;
  put: StatementSync;
  list: StatementSync;
  keys: StatementSync;
  delete: StatementSync;
  getBlob: StatementSync;
  putBlob: StatementSync;
  deleteBlob: StatementSync;
  statBlob: StatementSync;
  stamp: StatementSync;
  dataVersion: StatementSync;
}

/** Rows are listed in the order they were first written, as the JSON document's keys were. */
const statements = (d: DatabaseSync): Statements => ({
  get: d.prepare("select json from collections where collection = ? and id = ?"),
  put: d.prepare("insert into collections (collection, id, json) values (?, ?, ?) on conflict (collection, id) do update set json = excluded.json"),
  list: d.prepare("select json from collections where collection = ? order by rowid"),
  keys: d.prepare("select id from collections where collection = ? order by rowid"),
  delete: d.prepare("delete from collections where collection = ? and id = ?"),
  getBlob: d.prepare("select bytes from blobs where collection = ? and id = ?"),
  putBlob: d.prepare("insert into blobs (collection, id, bytes, at) values (?, ?, ?, ?) on conflict (collection, id) do update set bytes = excluded.bytes, at = excluded.at"),
  deleteBlob: d.prepare("delete from blobs where collection = ? and id = ?"),
  statBlob: d.prepare("select length(bytes) as bytes, at from blobs where collection = ? and id = ?"),
  stamp: d.prepare("insert into shape (one, json) values (1, ?) on conflict (one) do update set json = excluded.json"),
  dataVersion: d.prepare("pragma data_version"),
});
