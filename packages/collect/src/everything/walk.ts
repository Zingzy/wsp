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

export interface WalkOptions {
  /** Directory names not entered at any depth. */
  skip?: (name: string) => boolean;
  /** Directories whose listing satisfies this are left whole, files included. */
  skipTree?: (names: string[]) => boolean;
  maxDepth?: number;
}

/** Visits every regular file under dir, never following symlinks. */
export async function walk(fs: Fs, dir: string, opts: WalkOptions, visit: (path: string, e: Entry) => void): Promise<void> {
  const step = async (d: string, depth: number): Promise<void> => {
    const names = await fs.list(d);
    if (opts.skipTree?.(names) === true) return;
    await Promise.all(names.map(async name => {
      if (opts.skip?.(name) === true) return;
      const p = `${d}/${name}`;
      const e = await fs.stat(p);
      if (e === undefined || e.kind === "link") return;
      if (e.kind === "file") {
        visit(p, e);
        return;
      }
      if (opts.maxDepth === undefined || depth < opts.maxDepth) await step(p, depth + 1);
    }));
  };
  await step(dir, 1);
}

export async function summarize(fs: Fs, dir: string, opts: WalkOptions = {}): Promise<Tree> {
  let t = EMPTY;
  await walk(fs, dir, opts, (_, e) => {
    t = add(t, fileTree(e));
  });
  return t;
}
