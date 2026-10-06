// SPDX-License-Identifier: AGPL-3.0-only
// Every workspace's transcript as rows of the state database, one per event, so a
// flush appends what a turn wrote where it rewrote the whole transcript, and one
// thread's window is read off an index without the rest of its workspace.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { SessionEvent } from "@wsp/protocol";
import type { StoreModule } from "./sqlite-store.js";
import { eventJson, numbered } from "./transcript-reader.js";

export const TRANSCRIPTS_MODULE: StoreModule = {
  name: "transcripts",
  migrations: [
    // thread is '' for an event that names none, so the index holds every event. size is the event's JSON length,
    // what the transcript's byte cap counts, so a trim chooses without reading an event.
    `create table events (workspace text not null, pos integer not null, thread text not null, type text not null, size integer not null, json text not null, primary key (workspace, pos));
     create index events_thread on events (workspace, thread, pos);
     create table transcript_index (workspace text primary key, json text not null);`,
  ],
};

/** The blobs the transcripts were kept in before this module, by workspace: the events, and the index read off them. */
const TRANSCRIPT_BLOBS = "transcripts";
const INDEX_BLOBS = "transcript-index";

/** An event as a trim weighs it, with nothing of it read but its place, its thread, its type and its size. */
export interface EventSize {
  pos: number;
  threadId?: string;
  type: SessionEvent["type"];
  size: number;
}

/** The transcripts module of a state database. Every call is one statement or one transaction, so a reader on
 * another connection sees a flush whole or not at all. */
export interface TranscriptRows {
  /** Every event the workspace's transcript keeps, oldest first, and their sizes summed. */
  all(workspaceId: string): { events: SessionEvent[]; size: number };
  /** One thread's events newest first, below `before` where it is given; a caller that stops reading stops the read. */
  newest(workspaceId: string, threadId: string, before?: number): Iterable<SessionEvent>;
  /** How many events of the thread the transcript keeps. */
  count(workspaceId: string, threadId: string): number;
  /** How many events the transcript keeps and their sizes summed. */
  total(workspaceId: string): { count: number; size: number };
  /** The newest position the transcript keeps, 0 where it keeps none. */
  newestPos(workspaceId: string): number;
  sizes(workspaceId: string): EventSize[];
  at(workspaceId: string, positions: readonly number[]): SessionEvent[];
  /** Events after every one the transcript keeps. */
  append(workspaceId: string, events: readonly SessionEvent[]): void;
  remove(workspaceId: string, positions: readonly number[]): void;
  /** The transcript and its index, gone. */
  clear(workspaceId: string): void;
  index(workspaceId: string): string | undefined;
  putIndex(workspaceId: string, json: string): void;
  /** fn in one transaction, undone whole if it throws. */
  atomically<T>(fn: () => T): T;
  /** Moves every transcript still kept as a blob into rows, each workspace in a transaction of its own; one that cannot
   * move is set aside rather than stopping the rest. */
  moveBlobs(): MovedBlobs;
}

export interface MovedBlobs {
  moved: number;
  events: number;
  /** Blobs that could not move, each kept under transcripts-unparsed/<aside>. */
  setAside: { workspaceId: string; aside: string; why: string }[];
}

/** The module's rows on the database `db` answers, which may be opened afresh between calls. */
export function transcriptRows(db: () => DatabaseSync): TranscriptRows {
  let held: { d: DatabaseSync; s: Statements } | undefined;
  const s = (): Statements => {
    const d = db();
    if (held?.d !== d) held = { d, s: statements(d) };
    return held.s;
  };
  const parse = (rows: unknown[]): SessionEvent[] => (rows as { json: string }[]).map(r => JSON.parse(r.json) as SessionEvent);
  let depth = 0;
  const atomically = <T>(fn: () => T): T => {
    // A transaction inside one is part of it: SQLite has no nested begin.
    if (depth > 0) return fn();
    const d = db();
    d.exec("begin immediate");
    depth++;
    try {
      const out = fn();
      d.exec("commit");
      return out;
    } catch (e) {
      d.exec("rollback");
      throw e;
    } finally {
      depth--;
    }
  };
  const append = (workspaceId: string, events: readonly SessionEvent[]): void => {
    const insert = s().insert;
    for (const e of events) {
      const { json, bytes } = eventJson(e);
      insert.run(workspaceId, e.pos!, e.threadId ?? "", e.type, bytes, json);
    }
  };
  const newestPos = (workspaceId: string): number => Number((s().newestPos.get(workspaceId) as { pos: number | null }).pos ?? 0);

  return {
    all(workspaceId) {
      let size = 0;
      const events = (s().all.all(workspaceId) as { json: string; size: number }[]).map(r => {
        size += r.size;
        return JSON.parse(r.json) as SessionEvent;
      });
      return { events, size };
    },
    *newest(workspaceId, threadId, before) {
      for (const r of s().newest.iterate(workspaceId, threadId, before ?? Number.MAX_SAFE_INTEGER)) yield JSON.parse((r as { json: string }).json) as SessionEvent;
    },
    count(workspaceId, threadId) {
      return Number((s().count.get(workspaceId, threadId) as { n: number }).n);
    },
    total(workspaceId) {
      const r = s().total.get(workspaceId) as { n: number; size: number | null };
      return { count: Number(r.n), size: Number(r.size ?? 0) };
    },
    newestPos,
    sizes(workspaceId) {
      return (s().sizes.all(workspaceId) as { pos: number; thread: string; type: SessionEvent["type"]; size: number }[]).map(r => ({
        pos: r.pos,
        ...(r.thread !== "" ? { threadId: r.thread } : {}),
        type: r.type,
        size: r.size,
      }));
    },
    at(workspaceId, positions) {
      const at = s().at;
      return positions.flatMap(pos => parse(at.all(workspaceId, pos)));
    },
    append: (workspaceId, events) => atomically(() => append(workspaceId, events)),
    remove(workspaceId, positions) {
      const remove = s().remove;
      atomically(() => {
        for (const pos of positions) remove.run(workspaceId, pos);
      });
    },
    clear(workspaceId) {
      atomically(() => {
        s().clear.run(workspaceId);
        s().clearIndex.run(workspaceId);
      });
    },
    index(workspaceId) {
      return (s().index.get(workspaceId) as { json: string } | undefined)?.json;
    },
    putIndex(workspaceId, json) {
      s().putIndex.run(workspaceId, json);
    },
    atomically,
    moveBlobs() {
      const done: MovedBlobs = { moved: 0, events: 0, setAside: [] };
      for (const { id } of s().blobbed.all(TRANSCRIPT_BLOBS) as { id: string }[]) {
        try {
          // Each workspace whole in its own transaction: a host stopped part way leaves every transcript either moved,
          // its blob gone with it, or still a blob the next start moves, and none of them in both places.
          atomically(() => {
            const blob = s().blob.get(TRANSCRIPT_BLOBS, id) as { bytes: Uint8Array; at: number } | undefined;
            if (blob === undefined) return;
            const read = (JSON.parse(Buffer.from(blob.bytes).toString("utf8")) as { events?: unknown }).events;
            if (!Array.isArray(read)) throw new Error("it holds no events");
            const events = numbered(read as SessionEvent[]);
            const newest = newestPos(id);
            // A workspace with rows and a blob had an older build run on it since its move, which wrote the blob: its
            // events go after the rows with positions of their own, never over theirs, and the index is read again off
            // the rows.
            append(id, newest === 0 ? events : events.map((e, i) => ({ ...e, pos: newest + i + 1 })));
            const index = s().blob.get(INDEX_BLOBS, id) as { bytes: Uint8Array } | undefined;
            const kept = newest === 0 && index !== undefined ? indexOfBlob(Buffer.from(index.bytes).toString("utf8"), { bytes: blob.bytes.byteLength, at: blob.at }) : undefined;
            if (kept !== undefined) s().putIndex.run(id, kept);
            else s().clearIndex.run(id);
            s().dropBlob.run(TRANSCRIPT_BLOBS, id);
            s().dropBlob.run(INDEX_BLOBS, id);
            done.moved++;
            done.events += events.length;
          });
        } catch (e) {
          // A blob that does not parse, or whose events the table refuses (one position twice), would stop every boot
          // after it: its bytes are kept aside whole and the next workspace moves.
          atomically(() => {
            const blob = s().blob.get(TRANSCRIPT_BLOBS, id) as { bytes: Uint8Array; at: number } | undefined;
            if (blob === undefined) return;
            const aside = `${id}.${Date.now()}`;
            s().putBlob.run(`${TRANSCRIPT_BLOBS}-unparsed`, aside, blob.bytes, blob.at);
            s().dropBlob.run(TRANSCRIPT_BLOBS, id);
            s().dropBlob.run(INDEX_BLOBS, id);
            done.setAside.push({ workspaceId: id, aside, why: e instanceof Error ? e.message : String(e) });
          });
        }
      }
      return done;
    },
  };
}

/** The index a transcript blob had beside it, where it was read off that blob as the move found it: an index older
 * than its blob is left behind, and the host reads a new one off the rows. */
function indexOfBlob(json: string, mark: { bytes: number; at: number }): string | undefined {
  try {
    const held = JSON.parse(json) as { of?: { bytes: number; at: number } };
    return held.of?.bytes === mark.bytes && held.of.at === mark.at ? json : undefined;
  } catch {
    return undefined;
  }
}

interface Statements {
  all: StatementSync;
  newest: StatementSync;
  count: StatementSync;
  total: StatementSync;
  sizes: StatementSync;
  at: StatementSync;
  insert: StatementSync;
  remove: StatementSync;
  clear: StatementSync;
  index: StatementSync;
  putIndex: StatementSync;
  clearIndex: StatementSync;
  newestPos: StatementSync;
  blobbed: StatementSync;
  blob: StatementSync;
  putBlob: StatementSync;
  dropBlob: StatementSync;
}

const statements = (d: DatabaseSync): Statements => ({
  all: d.prepare("select json, size from events where workspace = ? order by pos"),
  newest: d.prepare("select json from events where workspace = ? and thread = ? and pos < ? order by pos desc"),
  count: d.prepare("select count(*) as n from events where workspace = ? and thread = ?"),
  total: d.prepare("select count(*) as n, sum(size) as size from events where workspace = ?"),
  sizes: d.prepare("select pos, thread, type, size from events where workspace = ? order by pos"),
  at: d.prepare("select json from events where workspace = ? and pos = ?"),
  insert: d.prepare("insert into events (workspace, pos, thread, type, size, json) values (?, ?, ?, ?, ?, ?)"),
  remove: d.prepare("delete from events where workspace = ? and pos = ?"),
  clear: d.prepare("delete from events where workspace = ?"),
  index: d.prepare("select json from transcript_index where workspace = ?"),
  putIndex: d.prepare("insert into transcript_index (workspace, json) values (?, ?) on conflict (workspace) do update set json = excluded.json"),
  clearIndex: d.prepare("delete from transcript_index where workspace = ?"),
  newestPos: d.prepare("select max(pos) as pos from events where workspace = ?"),
  blobbed: d.prepare("select id from blobs where collection = ? order by id"),
  blob: d.prepare("select bytes, at from blobs where collection = ? and id = ?"),
  putBlob: d.prepare("insert into blobs (collection, id, bytes, at) values (?, ?, ?, ?) on conflict (collection, id) do update set bytes = excluded.bytes, at = excluded.at"),
  dropBlob: d.prepare("delete from blobs where collection = ? and id = ?"),
});
