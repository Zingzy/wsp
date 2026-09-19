import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DAEMON_VERSION, STATE_SHAPE, StateShape, stateWriterWords } from "@wsp/protocol";

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
  /** What wrote this state and in which shape, as the last save recorded it; nothing where the store was written
   * before the document existed. Read by a refusal that has to name the build a person should run instead. */
  shape(): Promise<StateShape | undefined>;
}

type Data = Record<string, Record<string, unknown>>;

/** The top-level name the shape document sits under. Every other key of a state file is a collection of documents
 * by id, so the document's own fields would read as ids: a collection read never sees this name and a save always
 * writes it. */
export const STATE_SHAPE_KEY = "$shape";

/** The build a save records as the writer of the file. Handed in by the caller: the version a person reads off
 * `wsp --version` is the binary's own and no package below it knows it. */
export type StateWriter = Omit<StateShape, "shape" | "at">;

/** What a store nobody named a build for records: the daemon this build carries and the binary it ran from, which
 * is the one thing that tells two wsps on a computer apart. */
const writerHere = (): StateWriter => ({ wsp: "unknown", daemon: DAEMON_VERSION, bin: process.argv[1] ?? process.execPath });

const shapeNow = (writer: StateWriter): StateShape => ({ shape: STATE_SHAPE, ...writer, at: new Date().toISOString() });

/** Why a host will not read a state file a newer wsp wrote: the records in it may be in a form this build does not
 * know, and reading them and writing them back in this build's shape is what left another host refusing its own
 * state at boot. The build that wrote it is named, since running that one is the fix. */
export const stateWrittenByNewerLine = (statePath: string, wrote: StateShape): string =>
  `${statePath} was written by a newer wsp (state shape ${wrote.shape}; this wsp reads ${STATE_SHAPE}; written ${wrote.at} by ${stateWriterWords(wrote)}): run that wsp, or move the file aside`;

/** A store with no file behind it carries no shape document: the document says which build wrote a state file and
 * which shape its records are in, and nothing here outlives the process that made it. */
export function memoryStore(): Store {
  const data: Data = {};
  const blobs = new Map<string, Buffer>();
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
    },
    async deleteBlob(collection, id) {
      blobs.delete(`${collection}/${id}`);
    },
    async shape() {
      return undefined;
    },
  };
}

export function jsonFileStore(path: string, writer: StateWriter = writerHere()): Store {
  /** The file as it stands: its collections, and the shape document apart from them. */
  const read = (): { data: Data; wrote?: StateShape } => {
    let held: Record<string, unknown>;
    try {
      held = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return { data: {} };
    }
    const { [STATE_SHAPE_KEY]: document, ...collections } = held;
    const wrote = StateShape.safeParse(document);
    return { data: collections as Data, ...(wrote.success ? { wrote: wrote.data } : {}) };
  };
  /** One state file, one shape: a file a newer wsp wrote is refused here, before a read answers anything and
   * before a write could put this build's shape over it. */
  const load = (): Data => {
    const { data, wrote } = read();
    if (wrote !== undefined && wrote.shape > STATE_SHAPE) throw new Error(stateWrittenByNewerLine(path, wrote));
    return data;
  };
  // Write-through with rename so a crash mid-write never truncates the store.
  const save = (data: Data): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    writeFileSync(tmp, JSON.stringify({ ...data, [STATE_SHAPE_KEY]: shapeNow(writer) }, null, 2));
    renameSync(tmp, path);
  };
  const blobPath = (collection: string, id: string): string => join(dirname(path), "blobs", collection, id);
  return {
    async get(collection, id) {
      return load()[collection]?.[id];
    },
    async put(collection, id, value) {
      const data = load();
      (data[collection] ??= {})[id] = value;
      save(data);
    },
    async list(collection) {
      return Object.values(load()[collection] ?? {});
    },
    async keys(collection) {
      return Object.keys(load()[collection] ?? {});
    },
    async delete(collection, id) {
      const data = load();
      delete data[collection]?.[id];
      save(data);
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
      const target = blobPath(collection, id);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, target);
    },
    async deleteBlob(collection, id) {
      load();
      rmSync(blobPath(collection, id), { force: true });
    },
    async shape() {
      return read().wrote;
    },
  };
}
