// SPDX-License-Identifier: AGPL-3.0-only
// What a golden's recipe writes into the guest home. The seal hashes these files on the builder and the version
// records them. One read of the recipe's file list.
import { GUEST_HOME } from "@wsp/catalog";
import { shellQuote, type RecipeDigest, type RecipeOwnedFile } from "@wsp/protocol";
import { INLINE_EXEC_MS, execFits } from "./exec-detached.js";
import type { Machine } from "./machine.js";

/** The paths the recipe writes into the guest home and the ones it marks volatile: a tool rewrites those as it runs,
 * or the machine renders them. */
export interface WrittenPaths {
  /** Home-relative, each once. */
  paths: string[];
  /** Those of them the recipe marks volatile, as roots: a file under one is volatile too. */
  volatile: string[];
}

/** The recipe's own list of written paths. Nothing else derives it; a row that names a directory travels as a
 * directory, so the read below expands it into the files under it. */
export function recipeWrittenPaths(recipe: RecipeDigest): WrittenPaths {
  const paths = [...new Set(recipe.files.map(f => f.dest))].sort();
  return { paths, volatile: paths.filter(p => recipe.files.some(f => f.dest === p && f.volatile === true)) };
}

/** The one command that hashes the files: every regular file at or under the paths, from the home they are relative
 * to. A path no longer there is silently nothing; a home the read cannot reach fails, since an empty answer would
 * record a version that wrote no file. */
export function ownedFilesScript(home: string, paths: readonly string[]): string {
  return `cd ${shellQuote(home)} || exit 1\nfind ${paths.map(shellQuote).join(" ")} -type f -print0 2>/dev/null | xargs -0 -r sha256sum --`;
}

/** sha256sum's lines as the manifest holds them. A name it had to escape (a newline or a backslash in the path) is
 * left out: it carries a leading backslash and no recipe path has one. */
export function parseOwnedFiles(stdout: string): RecipeOwnedFile[] {
  return stdout
    .split("\n")
    .map(line => /^([0-9a-f]{64}) {2}(.+)$/.exec(line))
    .flatMap(m => (m === null ? [] : [{ path: m[2]!, sha256: m[1]! }]))
    .sort(byPath);
}

const byPath = (a: RecipeOwnedFile, b: RecipeOwnedFile): number => (a.path < b.path ? -1 : 1);

/** Every file at or under the paths on the machine, with its hash: the seal reads the recipe's paths on the builder. */
export async function readOwnedFiles(machine: Machine, paths: readonly string[], home: string = GUEST_HOME): Promise<RecipeOwnedFile[]> {
  // A version's own manifest is a thousand files on a real image (the recipe's config rows name whole directories),
  // whose paths pass the exec body cap in one command and would be refused whole, so the read goes a page at a time
  // under the same rule every other road that builds a command out of a list reads.
  const pages: string[][] = [[]];
  for (const path of paths) {
    const last = pages.at(-1)!;
    if (last.length > 0 && !execFits(ownedFilesScript(home, [...last, path]))) pages.push([path]);
    else last.push(path);
  }
  const found: RecipeOwnedFile[] = [];
  for (const page of pages) {
    if (page.length === 0) continue;
    const read = await machine.exec(ownedFilesScript(home, page), { timeoutMs: INLINE_EXEC_MS });
    if (read.exitCode !== 0) throw new Error(`reading the recipe's files on ${machine.id} failed (exit ${read.exitCode}): ${read.stderr.slice(-200)}`);
    found.push(...parseOwnedFiles(read.stdout));
  }
  return found.sort(byPath);
}

/** Whether a path is one of the roots or sits under one. */
const at = (path: string, roots: readonly string[]): boolean => roots.some(r => path === r || path.startsWith(`${r}/`));

/** The manifest a seal records: every file the recipe writes into home, hashed on the builder, with the ones under a
 * volatile row marked as it marked them. */
export async function recipeOwnedFiles(machine: Machine, recipe: RecipeDigest, home: string = GUEST_HOME): Promise<RecipeOwnedFile[]> {
  const written = recipeWrittenPaths(recipe);
  return (await readOwnedFiles(machine, written.paths, home)).map(f => (at(f.path, written.volatile) ? { ...f, volatile: true } : f));
}
