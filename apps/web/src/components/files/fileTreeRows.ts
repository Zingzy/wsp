// SPDX-License-Identifier: AGPL-3.0-only
// The tree's rows from the folders listed so far under one root: every entry
// as a path relative to the root (directories with a trailing slash, as the
// tree registers them), plus one note row under a folder the daemon cut at
// its cap or could not list. Folders nobody expanded yet are rows without
// children; expanding one asks for its listing.
import type { FileTreeSortComparator } from "@pierre/trees";
import { relativeTo, type ProjectEntry } from "../../files/entries";
import type { Levels } from "../../files/listing";

/** Note rows start with this so the sort keeps them under their folder's files and the picker ignores them. */
export const NOTE_PREFIX = "… ";

export interface FileTreeRows {
  readonly paths: string[];
  /** Tree path without its trailing slash to what it is; note rows are absent. */
  readonly kinds: ReadonlyMap<string, ProjectEntry["kind"]>;
  /** Tree path of every folder row (with its slash) to the folder as the daemon names it. */
  readonly directories: ReadonlyMap<string, string>;
  /** Folders whose listing the tree shows; a refresh asks for these again. */
  readonly loaded: string[];
}

function noteRow(relDir: string, text: string): string {
  return relDir === "" ? `${NOTE_PREFIX}${text}` : `${relDir}/${NOTE_PREFIX}${text}`;
}

export function fileTreeRows(root: string, levels: Levels): FileTreeRows {
  const paths: string[] = [];
  const kinds = new Map<string, ProjectEntry["kind"]>();
  const directories = new Map<string, string>();
  const loaded: string[] = [];
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const dir = queue[i]!;
    const level = levels.get(dir);
    if (!level) continue;
    const relDir = relativeTo(root, dir);
    if (level.entries === null) {
      if (level.error !== null) paths.push(noteRow(relDir, level.error));
      continue;
    }
    loaded.push(dir);
    for (const entry of level.entries) {
      const rel = relativeTo(root, entry.path);
      kinds.set(rel, entry.kind);
      if (entry.kind === "directory") {
        paths.push(`${rel}/`);
        directories.set(`${rel}/`, entry.path);
        queue.push(entry.path);
      } else {
        paths.push(rel);
      }
    }
    if (level.truncated) {
      const hidden = level.total - level.entries.length;
      paths.push(noteRow(relDir, `${hidden.toLocaleString("en-US")} more ${hidden === 1 ? "entry" : "entries"} not shown`));
    }
  }
  return { paths, kinds, directories, loaded };
}

/** Folders first, note rows last, names in natural order. */
export const sortTreeRows: FileTreeSortComparator = (left, right) => {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  const leftNote = left.basename.startsWith(NOTE_PREFIX);
  const rightNote = right.basename.startsWith(NOTE_PREFIX);
  if (leftNote !== rightNote) return leftNote ? 1 : -1;
  return left.basename.localeCompare(right.basename, undefined, { numeric: true, sensitivity: "base" });
};
