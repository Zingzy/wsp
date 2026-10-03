// SPDX-License-Identifier: AGPL-3.0-only
// The copier with git doing the worktree half for real, for the tests of
// threads in a project's folder and of the sweep of worktrees wsp made.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeCopier } from "@wsp/engine";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();

/** The copier with git doing the worktree half for real, as the daemon binary's verbs do: the branch checked out
 * anywhere answers that worktree, an existing branch is checked out as it stands, a new one starts at HEAD; a
 * removal is refused over files no commit holds and for a worktree outside the host's folder. */
export function gitCopier(): ReturnType<typeof fakeCopier> {
  const inner = fakeCopier();
  return {
    ...inner,
    async worktree(ask) {
      inner.worktrees.push(ask);
      const ours = join(ask.home, "worktrees");
      const listed = git(ask.from, "worktree", "list", "--porcelain").split("\n\n");
      const held = listed.find(block => block.includes(`branch refs/heads/${ask.branch}`));
      const heldAt = held?.split("\n")[0]!.slice("worktree ".length);
      // One deleted by hand is dropped and made again, as the verb does.
      if (heldAt !== undefined && !existsSync(heldAt)) git(ask.from, "worktree", "prune");
      else if (heldAt !== undefined) return { path: heldAt, branch: ask.branch, made: heldAt.startsWith(`${ours}/`), carried: [], ms: 1 };
      const path = join(ours, ask.project, ask.branch.replace(/[^A-Za-z0-9._-]/g, "-"));
      mkdirSync(join(ours, ask.project), { recursive: true });
      const exists = execFileSync("git", ["-C", ask.from, "branch", "--list", ask.branch], { encoding: "utf8" }).trim() !== "";
      if (exists) git(ask.from, "worktree", "add", "-q", path, ask.branch);
      else git(ask.from, "worktree", "add", "-q", "-b", ask.branch, path, "HEAD");
      return { path, branch: ask.branch, made: true, carried: [], ms: 1 };
    },
    async worktreeRemove(o) {
      inner.worktreesRemoved.push(o);
      if (!o.path.startsWith(`${join(o.home, "worktrees")}/`)) throw new Error(`${o.path} is not a worktree wsp made for this project, so nothing was removed`);
      const changed = git(o.path, "status", "--porcelain").split("\n").filter(l => l !== "").length;
      if (changed > 0 && !o.force) throw new Error(`${o.path} has ${changed} files not committed, so it was not removed; commit them, or remove it with --force`);
      git(o.from, "worktree", "remove", "--force", o.path);
      return { path: o.path };
    },
  };
}

