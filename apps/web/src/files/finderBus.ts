// SPDX-License-Identifier: AGPL-3.0-only
// Opens the file finder from a chord or a palette row without owning its
// state: quick open finds a file by name, search finds a line of text.
import type { FsSearchMode } from "@wsp/protocol";

const OPEN_FILE_FINDER_EVENT = "wsp:open-file-finder";

export function openFileFinder(mode: FsSearchMode): void {
  window.dispatchEvent(new CustomEvent<FsSearchMode>(OPEN_FILE_FINDER_EVENT, { detail: mode }));
}

export function onOpenFileFinder(listener: (mode: FsSearchMode) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<FsSearchMode>).detail);
  window.addEventListener(OPEN_FILE_FINDER_EVENT, handler);
  return () => window.removeEventListener(OPEN_FILE_FINDER_EVENT, handler);
}
