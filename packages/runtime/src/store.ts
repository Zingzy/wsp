import { readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { STATE_SHAPE, StateShape, stateWriterWords } from "@wsp/protocol";
import { writeOwn } from "@wsp/own-file";

/** Persistence port. Hosted Postgres impl is Plan 2's problem. Blobs are
 * bytes too large for the JSON document (vault archives); one per id. */
export interface Store {
  get(collection: string, id: string): Promise<unknown | undefined>;
  put(collection: string, id: string, value: unknown): Promise<void>;
  list(collection: string): Promise<unknown[]>;
  /** The ids in the collection; what a migration that has to move a document to another key reads. */
  keys(collection: string): Promise<string[]>;
  delete(collection: string, id: string): Promise<void>;
  getBlob(collection: string, id: string): Promise<Buffer | undefined>;
  putBlob(collection: string, id: string, bytes: Buffer): Promise<void>;
  deleteBlob(collection: string, id: string): Promise<void>;
  /** Which write a blob is: its size and the moment it was written, nothing where there is no blob. A blob that is
   * there and cannot be read answers here where getBlob answers nothing, which is how a reader tells them apart. */
  statBlob(collection: string, id: string): Promise<BlobMark | undefined>;
}

export interface BlobMark {
  bytes: number;
  at: number;
}

type Data = Record<string, Record<string, unknown>>;

/** The top-level name the shape document sits under. Every other key of a state file is a collection of documents
 * by id, so the document's own fields would read as ids: a collection read never sees this name and a save always
 * writes it. */
export const STATE_SHAPE_KEY = "$shape";

/** The build a save records as the writer of the file, which every caller says for itself: the version a person
 * reads off `wsp --version` is the binary's own and no package below it knows it, and a file whose writer nobody
 * could name would tell the next host to run a build with no name. */
export type StateWriter = Omit<StateShape, "shape" | "at">;

const shapeNow = (writer: StateWriter): StateShape => ({ shape: STATE_SHAPE, ...writer, at: new Date().toISOString() });

/** Why a host will not read a state file a newer wsp wrote: the records in it may be in a form this build does not
 * know, and reading them and writing them back in this build's shape is what left another host refusing its own
 * state at boot. The build that wrote it is named, since running that one is the fix. */
export const stateWrittenByNewerLine = (statePath: string, wrote: StateShape): string =>
  `${statePath} was written by a newer wsp (state shape ${wrote.shape}; this wsp reads ${STATE_SHAPE}; written ${wrote.at} by ${stateWriterWords(wrote)}): run that wsp, or move the file aside`;

/** Why a host will not read a state file an older wsp wrote, or one written before the shape document existed:
 * nothing reads an older shape, so the file is moved aside and this host starts a fresh one. */
export const stateWrittenByOlderLine = (statePath: string, wrote: StateShape | undefined): string =>
  `${statePath} holds state in an older shape (${wrote === undefined ? "none recorded" : `shape ${wrote.shape}, written ${wrote.at} by ${stateWriterWords(wrote)}`}; this wsp reads shape ${STATE_SHAPE}): move the file aside and this wsp starts a fresh one`;

/** Why a host will not read a state file that is there and is not one this build can read, whether its bytes do not
 * parse or what they parse to is no object of collections: whatever is in it is still in it, and a read that
 * answered an empty store would have the next save write one record and this build's document over all of it. A
 * file that is not there is not this: that is a fresh home, which reads empty and writes at its first save. */
export const stateUnreadableLine = (statePath: string, why: string): string =>
  `${statePath} does not read as a state file (${why}), so no wsp can read the records in it: move the file aside, or put back a copy a wsp wrote`;

/** What a file holds where a state file holds an object, in the words its refusal names it by. */
const jsonKind = (held: unknown): string => (Array.isArray(held) ? "a list" : held === null ? "null" : `a ${typeof held}`);

/** The same refusal for a file whose bytes parse and are no state: every top-level name of a state file is a
 * collection of documents by id, so a number, a string, a list or null leaves nothing to read them out of. */
export const stateNotAnObjectLine = (statePath: string, held: unknown): string => stateUnreadableLine(statePath, `it holds ${jsonKind(held)} where every state file is an object of collections`);

/** Why a host will not read a state file whose shape document is not one: the document is what says which build
 * wrote the file and in which shape its records are, so a key that is present and unreadable leaves no reading of
 * the file at all. */
export const stateShapeUnreadableLine = (statePath: string, document: unknown): string =>
  `${statePath} has a ${STATE_SHAPE_KEY} that is not a shape document (${JSON.stringify(document)}), so no wsp can say which build wrote it or in which shape: move the file aside, or put back the document a wsp writes`;

export function memoryStore(): Store {
  const data: Data = {};
  const blobs = new Map<string, Buffer>();
  const marks = new Map<string, BlobMark>();
  let writes = 0;
  return {
    async get(collection, id) {
      return data[collection]?.[id];
    },
    async put(collection, id, value) {
      (data[collection] ??= {})[id] = structuredClone(value);
    },
    async list(collection) {
      return Object.values(data[collection] ?? {});
    },
    async keys(collection) {
      return Object.keys(data[collection] ?? {});
    },
    async delete(collection, id) {
      delete data[collection]?.[id];
    },
    async getBlob(collection, id) {
      return blobs.get(`${collection}/${id}`);
    },
    async putBlob(collection, id, bytes) {
      blobs.set(`${collection}/${id}`, Buffer.from(bytes));
      marks.set(`${collection}/${id}`, { bytes: bytes.length, at: ++writes });
    },
    async deleteBlob(collection, id) {
      blobs.delete(`${collection}/${id}`);
      marks.delete(`${collection}/${id}`);
    },
    async statBlob(collection, id) {
      return marks.get(`${collection}/${id}`);
    },
  };
}

export function jsonFileStore(path: string, writer: StateWriter): Store {
  /** The file as it stands: its collections, and the shape document apart from them. A file that is not there is
   * an empty store, which is the first wsp up on a fresh home; a file that is there and is no state this build can
   * read, its bytes, what they parse to or its shape document, is refused here, before a read answers anything and
   * before a save could write one record and this build's document over records nothing read. */
  const read = (): { data: Data; wrote?: StateShape; fresh?: true } => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return { data: {}, fresh: true };
      throw e;
    }
    let held: unknown;
    try {
      held = JSON.parse(text);
    } catch (e) {
      throw new Error(stateUnreadableLine(path, e instanceof Error ? e.message : String(e)));
    }
    if (typeof held !== "object" || held === null || Array.isArray(held)) throw new Error(stateNotAnObjectLine(path, held));
    const { [STATE_SHAPE_KEY]: document, ...collections } = held as Record<string, unknown>;
    if (document === undefined) return { data: collections as Data };
    const wrote = StateShape.safeParse(document);
    if (!wrote.success) throw new Error(stateShapeUnreadableLine(path, document));
    return { data: collections as Data, wrote: wrote.data };
  };
  /** One state file, one shape: a file in any other is refused here, before a read answers anything and before a
   * write could put this build's shape over it. A file that is not there is a fresh home and reads empty. */
  const loadFile = (): Data => {
    const { data, wrote, fresh } = read();
    if (fresh) return data;
    if (wrote === undefined || wrote.shape < STATE_SHAPE) throw new Error(stateWrittenByOlderLine(path, wrote));
    if (wrote.shape > STATE_SHAPE) throw new Error(stateWrittenByNewerLine(path, wrote));
    return data;
  };
  // The file as this process last read or wrote it, and which file that was. Parsing it whole on every read held a
  // host's loop for seconds at a time once its transcripts made it hundreds of megabytes; a stat is what tells a
  // write from another process on this file (the doctor runs a runtime of its own over it) from none.
  let held: { data: Data; mark: string } | undefined;
  const markOf = (): string => {
    try {
      const st = statSync(path);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return "";
    }
  };
  let saving: Promise<void> | undefined;
  /** The records changed since the last save, by collection, so a save that finds another process wrote the file
   * meanwhile writes its own records over that write and keeps the rest of it, as a read-and-rewrite per put did. */
  const touched: [string, string][] = [];
  const load = (): Data => {
    // A save that is still to run holds changes the file does not have yet, and it writes over whatever is there.
    if (held !== undefined && (saving !== undefined || held.mark === markOf())) return held.data;
    const mark = markOf();
    held = { data: loadFile(), mark };
    return held.data;
  };
  // The file holds every running turn's token and every unspent pairing code, so it is the owner's: writeOwn says
  // what that means, and its rename is also what keeps a crash mid-write from truncating the store.
  const save = (data: Data): void => {
    writeOwn(dirname(path), basename(path), JSON.stringify({ ...data, [STATE_SHAPE_KEY]: shapeNow(writer) }, null, 2));
    held = { data, mark: markOf() };
  };
  /** Every change made before the loop turns lands in one write, so a burst of puts costs one serialization. */
  const saveSoon = (collection: string, id: string): Promise<void> => {
    touched.push([collection, id]);
    return (saving ??= new Promise<void>((done, fail) =>
      setImmediate(() => {
        saving = undefined;
        const mine = touched.splice(0);
        try {
          let data = held!.data;
          if (held!.mark !== markOf()) {
            const theirs = loadFile();
            for (const [c, i] of mine) {
              const value = data[c]?.[i];
              if (value === undefined) delete theirs[c]?.[i];
              else (theirs[c] ??= {})[i] = value;
            }
            data = theirs;
          }
          save(data);
          done();
        } catch (e) {
          // What this save held never reached the file, so the next read reads the file rather than it.
          held = undefined;
          fail(e);
        }
      }),
    ));
  };
  const blobPath = (collection: string, id: string): string => join(dirname(path), "blobs", collection, id);
  return {
    // Copies, so a caller changing what it read changes nothing the next save writes.
    async get(collection, id) {
      const value = load()[collection]?.[id];
      return value === undefined ? undefined : structuredClone(value);
    },
    async put(collection, id, value) {
      // What the file will hold, not the caller's object: the document is kept, and a caller moving its object on
      // afterwards must not move what the next save writes, nor read back what JSON drops.
      (load()[collection] ??= {})[id] = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      await saveSoon(collection, id);
    },
    async list(collection) {
      return structuredClone(Object.values(load()[collection] ?? {}));
    },
    async keys(collection) {
      return Object.keys(load()[collection] ?? {});
    },
    async delete(collection, id) {
      delete load()[collection]?.[id];
      await saveSoon(collection, id);
    },
    async getBlob(collection, id) {
      load();
      try {
        return readFileSync(blobPath(collection, id));
      } catch {
        return undefined;
      }
    },
    async putBlob(collection, id, bytes) {
      load();
      // The image's blob is the person's sign-ins in the clear, so it and the two folders over it are the owner's.
      writeOwn(dirname(path), join("blobs", collection, id), bytes);
    },
    async deleteBlob(collection, id) {
      load();
      rmSync(blobPath(collection, id), { force: true });
    },
    async statBlob(collection, id) {
      try {
        const st = statSync(blobPath(collection, id));
        return { bytes: st.size, at: st.mtimeMs };
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return undefined;
        throw e;
      }
    },
  };
}
