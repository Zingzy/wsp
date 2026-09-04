// SPDX-License-Identifier: AGPL-3.0-only
import type { Entry, Fs } from "./host.js";

export interface Tree {
  bytes: number;
  files: number;
  mtime: number;
}

export const EMPTY: Tree = { bytes: 0, files: 0, mtime: 0 };

export function add(t: Tree, e: Tree): Tree {
  return { bytes: t.bytes + e.bytes, files: t.files + e.files, mtime: Math.max(t.mtime, e.mtime) };
}

export function fileTree(e: Entry): Tree {
  return { bytes: e.bytes, files: 1, mtime: e.mtime };
}

export const WALK_ENTRIES = 5_000;
export const WALK_MS = 2_000;
/** A split-out cache or state subtree is display only and never ticked by default, so it gets a smaller allowance than the app's own files. */
export const SPLIT_ENTRIES = 1_000;
export const SPLIT_MS = 500;

/** One root's allowance of entries and time; a walk that runs out stops and says so. */
export interface Budget {
  entries: number;
  deadline: number;
  clock: () => number;
  capped: boolean;
}

export function budget(clock: () => number, entries = WALK_ENTRIES, ms = WALK_MS): Budget {
  return { entries, deadline: clock() + ms, clock, capped: false };
}

/** Takes one entry from the budget; false once it is spent. */
export function spend(b: Budget): boolean {
  if (b.entries <= 0 || b.clock() > b.deadline) {
    b.capped = true;
    return false;
  }
  b.entries -= 1;
  return true;
}

export interface WalkOptions {
  /** Entries not entered or visited at any depth, by name; the path is there for a caller that records what it skipped. */
  skip?: (name: string, path: string) => boolean;
  /** Directories whose listing satisfies this are left whole, files included. */
  skipTree?: (names: string[]) => boolean;
  maxDepth?: number;
  budget?: Budget;
  /** Called for a symlink met on the way; the walk itself never follows one. */
  onLink?: (path: string, e: Entry) => void;
}

/** Visits every regular file under dir, never following symlinks. */
export async function walk(fs: Fs, dir: string, opts: WalkOptions, visit: (path: string, e: Entry) => void): Promise<void> {
  const step = async (d: string, depth: number): Promise<void> => {
    const names = await fs.list(d);
    if (opts.skipTree?.(names) === true) return;
    await Promise.all(names.map(async name => {
      const p = `${d}/${name}`;
      if (opts.skip?.(name, p) === true) return;
      if (opts.budget !== undefined && !spend(opts.budget)) return;
      const e = await fs.stat(p);
      if (e === undefined) return;
      if (e.kind === "link") {
        opts.onLink?.(p, e);
        return;
      }
      if (e.kind === "file") {
        visit(p, e);
        return;
      }
      if (opts.maxDepth === undefined || depth < opts.maxDepth) await step(p, depth + 1);
    }));
  };
  await step(dir, 1);
}

/** A symlink is an entry of no size. */
export function linkTree(e: Entry): Tree {
  return { bytes: 0, files: 1, mtime: e.mtime };
}

/** Sums a tree the way pass 2 counts it: regular files by size, symlinks as entries of no size. */
export async function summarize(fs: Fs, dir: string, opts: WalkOptions = {}): Promise<Tree> {
  let t = EMPTY;
  await walk(fs, dir, { ...opts, onLink: (_, e) => { t = add(t, linkTree(e)); } }, (_, e) => {
    t = add(t, fileTree(e));
  });
  return t;
}
