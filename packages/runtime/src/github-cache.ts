// SPDX-License-Identifier: AGPL-3.0-only
// What the host keeps of its reads off a git host, by a key the reader names: the body that read answered, the tag
// the next read compares to ask whether it moved (an ETag, or the words the reader keeps for that), and when it was
// read. Held in memory here; a store that outlives the host implements the same three calls.

export interface GitHubCacheEntry {
  body: unknown;
  tag?: string;
  fetchedAt: number;
}

export interface GitHubCache {
  get(key: string): GitHubCacheEntry | undefined;
  set(key: string, entry: GitHubCacheEntry): void;
  delete(key: string): void;
}

export function memoryGitHubCache(): GitHubCache {
  const held = new Map<string, GitHubCacheEntry>();
  return {
    get: key => held.get(key),
    set: (key, entry) => void held.set(key, entry),
    delete: key => void held.delete(key),
  };
}
