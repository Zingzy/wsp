// SPDX-License-Identifier: AGPL-3.0-only
// The archive a folder on this computer seeds a project with: the menu paths
// the person ticked at their own relative paths, the agent's memory folder and
// the commits the remote does not have as a patch, both under one folder of
// wsp's own the landing unpacks and removes. Nothing else of theirs travels:
// no .git, no login, no path the plan marked as one that never leaves.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runChild, tarOf, type TarEntry } from "@wsp/engine";
import { claudeMemoryDir, neverTravelsLine, notInTheMenuLine, SEED_MEMORY_DIR, SEED_PATCH, type SeedChoice, type SeedPlan } from "@wsp/protocol";

/** What a pack of one seed carries and how much of it, for the record's own seeded row. */
export interface PackedSeed {
  tar: Buffer;
  files: number;
  bytes: number;
  commits: number;
}

/** How long git gets to write the patch of one branch's unpushed commits. */
const PATCH_MS = 60_000;

/** The archive of what the person ticked. The plan is the one authority on what the menu offered: a path it does
 * not carry is refused by name, and one it marked as never travelling is refused even when the choice names it,
 * since a login is signed in once per computer and a copy of one is a second place it lives. */
export async function packSeed(o: {
  plan: SeedPlan;
  choice: SeedChoice;
  /** Where Claude Code keeps its projects on this computer, so the memory folder is found the way the menu found it. */
  claudeStateHome: string;
  run?: typeof runChild;
}): Promise<PackedSeed> {
  const { plan, choice } = o;
  const known = new Map(plan.files.map(f => [f.path, f]));
  const entries: TarEntry[] = [];
  let files = 0;
  let bytes = 0;
  for (const path of choice.files) {
    const file = known.get(path);
    if (file === undefined) throw new Error(notInTheMenuLine(path, [...known.keys()]));
    if (file.kind === "never") throw new Error(neverTravelsLine(path, file.row?.name));
    // git's own listing never names the repository's own folder; this is the wall in front of a choice that came
    // from somewhere else, since the one thing a seed must never carry is the history the computer clones itself.
    if (path === ".git" || path.startsWith(".git/")) throw new Error(neverGitLine(path));
    for (const found of filesAt(join(plan.source, path))) {
      entries.push(fileEntry(relative(plan.source, found), found));
      files += 1;
      bytes += statSync(found).size;
    }
  }
  if (choice.memory && plan.memory !== null) {
    const dir = claudeMemoryDir(o.claudeStateHome, plan.memory.key);
    for (const found of filesAt(dir)) {
      entries.push(fileEntry(join(SEED_MEMORY_DIR, relative(dir, found)), found));
      files += 1;
      bytes += statSync(found).size;
    }
  }
  let commits = 0;
  if (choice.commits && plan.unpushed !== null) {
    const run = o.run ?? runChild;
    const patch = await run("git", ["-C", plan.source, "format-patch", "--stdout", `${plan.unpushed.base}..HEAD`], { timeoutMs: PATCH_MS });
    if (patch.exitCode !== 0) throw new Error(`git format-patch over ${plan.unpushed.commits} commits: ${patch.stderr.trim().split("\n").at(-1) ?? `exit ${patch.exitCode}`}`);
    entries.push({ path: SEED_PATCH, mode: 0o600, content: patch.stdout });
    commits = plan.unpushed.commits;
    bytes += Buffer.byteLength(patch.stdout);
    files += 1;
  }
  return { tar: tarOf(entries), files, bytes, commits };
}

/** Why the repository's own folder is refused: the computer clones the repo itself, so its history never rides a
 * seed, and a choice naming it is a choice built from something other than the menu. */
export const neverGitLine = (path: string): string => `${path} is the repository's own folder, which a seed never carries: the computer clones the repo itself`;

/** Every regular file at a path: the file itself, or every one under it where it is a directory. Links are left
 * behind rather than followed, so nothing outside the folder is read through one. */
function filesAt(at: string): string[] {
  const stat = statSync(at, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [at];
  if (!stat.isDirectory()) return [];
  const found: string[] = [];
  for (const name of readdirSync(at).sort()) found.push(...filesAt(join(at, name)));
  return found;
}

/** One file in the archive, at its path inside it, with its own mode and its bytes as they are on disk. */
function fileEntry(path: string, from: string): TarEntry {
  return { path, mode: statSync(from).mode & 0o7777, content: readFileSync(from) };
}
