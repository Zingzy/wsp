// Adapted from pingdotgg/t3code apps/web/src/promptStashStore.ts at c9a0e8a1 (MIT).
// Differs from upstream: one list of entries with no versions to migrate, and
// every stashed file, an image or not, keeps its bytes here under the one
// per-entry budget, since wsp has no signed upload to point at; a file past
// the budget is dropped by name. No images are re-encoded, so nothing is
// saved after the entry.
import { create } from "zustand";

export const PROMPT_STASH_STORAGE_KEY = "wsp:prompt-stash";

export const MAX_STASH_ENTRIES = 20;
/** The base64 characters one entry's files may take in local storage, which the origin shares at about 5 MB with the
 * draft store; the files past it are dropped by name rather than filling the quota. */
export const MAX_STASH_ENTRY_FILE_CHARS = 2_700_000;

export interface StashedFile {
  readonly mediaType: string;
  readonly name: string;
  /** Base64, as the wire carries it. */
  readonly bytes: string;
  readonly size: number;
}

export interface PromptStashEntry {
  readonly id: string;
  readonly createdAt: string;
  /** The draft as the composer held it, chips as the text they send. */
  readonly prompt: string;
  readonly files: ReadonlyArray<StashedFile>;
  /** The files past the entry's budget, which were not kept. */
  readonly dropped: ReadonlyArray<string>;
}

const isText = (value: unknown): value is string => typeof value === "string";

/** An entry as storage holds it, or null for anything else; another version of the app may have written the key. */
function entryOf(value: unknown): PromptStashEntry | null {
  const e = value as Partial<Record<keyof PromptStashEntry, unknown>> | null;
  if (e === null || typeof e !== "object" || !isText(e.id) || !isText(e.createdAt) || !isText(e.prompt) || !Array.isArray(e.files) || !Array.isArray(e.dropped)) return null;
  const files = e.files.filter((f: Partial<StashedFile> | null): f is StashedFile => f !== null && isText(f.mediaType) && isText(f.name) && isText(f.bytes) && typeof f.size === "number");
  return { id: e.id, createdAt: e.createdAt, prompt: e.prompt, files, dropped: e.dropped.filter(isText) };
}

/** The files that fit the budget, in the order they were added, and the names of the ones that do not. */
export function partitionStashFiles(files: ReadonlyArray<StashedFile>): { kept: StashedFile[]; dropped: string[] } {
  const kept: StashedFile[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const file of files) {
    if (used + file.bytes.length > MAX_STASH_ENTRY_FILE_CHARS) {
      dropped.push(file.name);
      continue;
    }
    used += file.bytes.length;
    kept.push(file);
  }
  return { kept, dropped };
}

/** Local storage where the page may read it; a sandboxed page throws on the very property. */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Written at once rather than debounced: the composer clears on the strength of this landing. False on a quota
 * refusal or where the page has no storage, and then nothing is kept. */
function persist(entries: ReadonlyArray<PromptStashEntry>): boolean {
  const store = storage();
  if (store === null) return false;
  try {
    store.setItem(PROMPT_STASH_STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

function read(): PromptStashEntry[] {
  try {
    const raw = storage()?.getItem(PROMPT_STASH_STORAGE_KEY);
    const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.flatMap(value => entryOf(value) ?? []) : [];
  } catch {
    return [];
  }
}

interface PromptStashState {
  entries: ReadonlyArray<PromptStashEntry>;
  /** Puts an entry at the head, the oldest past the cap going; false when the write did not land and nothing was kept. */
  stash(entry: PromptStashEntry): boolean;
  /** Takes an entry off the list, for a restore or a delete. */
  take(id: string): PromptStashEntry | null;
  /** Puts an entry taken off the list back at its place, where a restore could not go on. */
  putBack(entry: PromptStashEntry, at: number): void;
  /** Reads the list again from storage, which another tab may have written. */
  reload(): void;
}

export const usePromptStashStore = create<PromptStashState>()((set, get) => ({
  entries: read(),
  stash(entry) {
    const next = [entry, ...get().entries].slice(0, MAX_STASH_ENTRIES);
    if (!persist(next)) return false;
    set({ entries: next });
    return true;
  },
  take(id) {
    const entries = get().entries;
    const entry = entries.find(candidate => candidate.id === id) ?? null;
    if (entry === null) return null;
    const next = entries.filter(candidate => candidate.id !== id);
    persist(next);
    set({ entries: next });
    return entry;
  },
  putBack(entry, at) {
    const next = [...get().entries];
    next.splice(Math.max(0, at), 0, entry);
    const kept = next.slice(0, MAX_STASH_ENTRIES);
    persist(kept);
    set({ entries: kept });
  },
  reload() {
    set({ entries: read() });
  },
}));
