// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from "vitest";

import { MAX_STASH_ENTRIES, MAX_STASH_ENTRY_FILE_CHARS, PROMPT_STASH_STORAGE_KEY, partitionStashFiles, usePromptStashStore, type PromptStashEntry } from "./promptStashStore";

const entry = (id: string, prompt = id): PromptStashEntry => ({ id, createdAt: "2026-09-27T10:00:00Z", prompt, files: [], dropped: [] });

beforeEach(() => {
  localStorage.clear();
  usePromptStashStore.getState().reload();
});

describe("the prompt stash", () => {
  it("keeps the newest first in local storage, and a reload reads the same list back", () => {
    const store = usePromptStashStore.getState();
    expect(store.stash(entry("a", "see @src/app.ts"))).toBe(true);
    expect(store.stash(entry("b"))).toBe(true);
    expect(usePromptStashStore.getState().entries.map(e => e.id)).toEqual(["b", "a"]);
    usePromptStashStore.setState({ entries: [] });
    usePromptStashStore.getState().reload();
    expect(usePromptStashStore.getState().entries.map(e => e.prompt)).toEqual(["b", "see @src/app.ts"]);
    expect(JSON.parse(localStorage.getItem(PROMPT_STASH_STORAGE_KEY)!)).toHaveLength(2);
  });

  it("takes an entry off the list for a restore, and drops the oldest past the cap", () => {
    for (let n = 0; n <= MAX_STASH_ENTRIES; n++) usePromptStashStore.getState().stash(entry(`e${n}`));
    expect(usePromptStashStore.getState().entries).toHaveLength(MAX_STASH_ENTRIES);
    expect(usePromptStashStore.getState().entries.at(-1)!.id).toBe("e1");
    expect(usePromptStashStore.getState().take("e5")?.id).toBe("e5");
    expect(usePromptStashStore.getState().entries.some(e => e.id === "e5")).toBe(false);
  });

  it("keeps a file's bytes within the entry's budget and drops the rest by name", () => {
    const file = (name: string, chars: number) => ({ mediaType: "text/plain", name, bytes: "a".repeat(chars), size: chars });
    const { kept, dropped } = partitionStashFiles([file("one.txt", 2_000_000), file("two.txt", 1_000_000), file("three.txt", MAX_STASH_ENTRY_FILE_CHARS - 2_000_000)]);
    expect(kept.map(f => f.name)).toEqual(["one.txt", "three.txt"]);
    expect(dropped).toEqual(["two.txt"]);
  });
});
