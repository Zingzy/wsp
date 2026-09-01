import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Persistence port. Hosted Postgres impl is Plan 2's problem. */
export interface Store {
  get(collection: string, id: string): Promise<unknown | undefined>;
  put(collection: string, id: string, value: unknown): Promise<void>;
  list(collection: string): Promise<unknown[]>;
  delete(collection: string, id: string): Promise<void>;
}

type Data = Record<string, Record<string, unknown>>;

export function memoryStore(): Store {
  const data: Data = {};
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
    async delete(collection, id) {
      delete data[collection]?.[id];
    },
  };
}

export function jsonFileStore(path: string): Store {
  const load = (): Data => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Data;
    } catch {
      return {};
    }
  };
  // Write-through with rename so a crash mid-write never truncates the store.
  const save = (data: Data): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  };
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
    async delete(collection, id) {
      const data = load();
      delete data[collection]?.[id];
      save(data);
    },
  };
}
