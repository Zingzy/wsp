import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_SHAPE, StateShape, stateWriterWords } from "@wsp/protocol";

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

/** Why a host will not read a state file that is there and does not parse: the records are still in it, and a read
 * that answered an empty store would have the next save write one record and this build's document over all of
 * them. A file that is not there is not this: that is a fresh home, which reads empty and writes at its first save. */
export const stateUnreadableLine = (statePath: string, why: string): string =>
  `${statePath} does not parse as JSON (${why}), so no wsp can read the records in it: move the file aside, or put back a copy a wsp wrote`;

/** Why a host will not read a state file whose shape document is not one: the document is what says which build
 * wrote the file and in which shape its records are, so a key that is present and unreadable leaves no reading of
 * the file at all, where an absent key is a file written before the document existed and is read as one. */
export const stateShapeUnreadableLine = (statePath: string, document: unknown): string =>
  `${statePath} has a ${STATE_SHAPE_KEY} that is not a shape document (${JSON.stringify(document)}), so no wsp can say which build wrote it or in which shape: move the file aside, or put back the document a wsp writes`;

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

export function jsonFileStore(path: string, writer: StateWriter): Store {
  /** The file as it stands: its collections, and the shape document apart from them. A file that is not there is
   * an empty store, which is the first wsp up on a fresh home; a file that is there and cannot be read whole, its
   * bytes or its shape document, is refused here, before a read answers anything and before a save could write one
   * record and this build's document over records nothing read. */
  const read = (): { data: Data; wrote?: StateShape } => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return { data: {} };
      throw e;
    }
    let held: Record<string, unknown> | null;
    try {
      held = JSON.parse(text) as Record<string, unknown> | null;
    } catch (e) {
      throw new Error(stateUnreadableLine(path, e instanceof Error ? e.message : String(e)));
    }
    const { [STATE_SHAPE_KEY]: document, ...collections } = held ?? {};
    if (document === undefined) return { data: collections as Data };
    const wrote = StateShape.safeParse(document);
    if (!wrote.success) throw new Error(stateShapeUnreadableLine(path, document));
    return { data: collections as Data, wrote: wrote.data };
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
