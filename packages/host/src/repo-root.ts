// SPDX-License-Identifier: AGPL-3.0-only
// The repository a folder on this computer sits in: the nearest folder up the
// tree holding a .git entry, a folder or a worktree's file alike, and the main
// folder of that repository when the folder is in one of its worktrees. What a
// thread opened with no project named is matched to a project by.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function gitRootOf(folder: string): string | undefined {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
  }
}

/** The main folder of the repository a folder is in: the root itself, or for a linked worktree the folder holding the
 * git directory its .git file points into (`<main>/.git/worktrees/<name>`). */
export function mainWorktreeOf(folder: string): string | undefined {
  const root = gitRootOf(folder);
  if (root === undefined) return undefined;
  const dotGit = join(root, ".git");
  if (statSync(dotGit).isDirectory()) return root;
  const pointed = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
  if (pointed === undefined) return undefined;
  const gitDir = isAbsolute(pointed) ? pointed : resolve(root, pointed);
  const worktrees = dirname(gitDir);
  return worktrees.endsWith("/.git/worktrees") ? dirname(dirname(worktrees)) : undefined;
}
