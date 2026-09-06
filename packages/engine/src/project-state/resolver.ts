// SPDX-License-Identifier: AGPL-3.0-only
// Moving a project's agent state to a new absolute path: the interface every
// agent module implements, the report it returns, and the file operations the
// modules share. Every agent stores the resolved path, so callers pass real
// paths and the core resolves what still exists.
import { createReadStream, createWriteStream, existsSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { chmod, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import type { ProjectCarry } from "@wsp/protocol";

/** One catalog projectState row the module moved: the files it touched and how many directories, keys, lines or rows changed. */
export interface MovedState {
  state: string;
  files: readonly string[];
  changed: number;
}

/** Moves one agent's project state from an old absolute path to a new one inside that agent's home. */
export interface ProjectStateResolver {
  /** The catalog id of the agent whose state this moves. */
  agent: string;
  /** The catalog projectState rows this module moves, by their `state`. */
  states: readonly string[];
  /** How the files `entries` names travel: whether they carry every key the agent needs to find the project's
   * sessions at the new path, or a shared store left behind holds one. */
  carry: ProjectCarry;
  /** Applies the move; an empty list means nothing in this home was keyed to `from`. */
  move(home: string, from: string, to: string): Promise<MovedState[]>;
  /** How many sessions in this home ran at `path` or in a folder under it. */
  sessions(home: string, path: string): Promise<number>;
  /** The files under home holding state for `path` and the folders under it alone, absolute; a store shared with
   * other projects (an index, a registry) is never one. */
  entries(home: string, path: string): Promise<string[]>;
}

/** The path as the agents store it: absolute, no trailing slash, symlinks resolved when it exists. */
export function resolveProjectPath(path: string): string {
  const abs = resolve(path);
  try {
    return statSync(abs).isDirectory() ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

/** Whether path is the project root or sits inside it; a sibling that shares the prefix is not. */
export function underProject(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Where a path lands when the project moves: `to` for the project root, the same tail under `to` for a folder
 * inside it, nothing for anything else. */
export function movedPath(path: string, from: string, to: string): string | undefined {
  return underProject(path, from) ? to + path.slice(from.length) : undefined;
}

/** The `cwd` recorded in the first transcript line under dir that carries one, or nothing. */
export async function recordedCwd(dir: string): Promise<string | undefined> {
  for (const file of filesUnder(dir, ".jsonl")) {
    let rest = "";
    for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
      rest += chunk as string;
      let nl: number;
      while ((nl = rest.indexOf("\n")) >= 0) {
        const cwd = cwdOf(rest.slice(0, nl));
        if (cwd !== undefined) return cwd;
        rest = rest.slice(nl + 1);
      }
    }
    const cwd = cwdOf(rest);
    if (cwd !== undefined) return cwd;
  }
  return undefined;
}
function cwdOf(line: string): string | undefined {
  try {
    const cwd = (JSON.parse(line) as Record<string, unknown>).cwd;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every directory under parent keyed to the project or a folder inside it, with the cwd it is keyed to: the key is
 * lossy (a slash and a dash key alike), so the transcript's recorded cwd decides, and a directory with no transcript
 * belongs only when it is the project's own key. A directory two projects share through the key belongs, or not, on
 * its first transcript.
 */
export async function keyedDirectories(parent: string, keyOf: (path: string) => string, from: string): Promise<{ dir: string; cwd: string }[]> {
  if (!existsSync(parent)) return [];
  const own = keyOf(from);
  const stem = commonPrefix(own, keyOf(`${from}/x`));
  const out: { dir: string; cwd: string }[] = [];
  for (const name of readdirSync(parent).filter(n => n.startsWith(stem)).sort()) {
    const dir = join(parent, name);
    if (!statSync(dir).isDirectory()) continue;
    const cwd = (await recordedCwd(dir)) ?? (name === own ? from : undefined);
    if (cwd === undefined || !underProject(cwd, from)) continue;
    out.push({ dir, cwd });
  }
  return out;
}

/** Moves every directory keyed to the project to its key under `to`; returns the renamed directories and every
 * transcript whose cwd was rewritten. */
export async function moveKeyedDirectories(parent: string, keyOf: (path: string) => string, from: string, to: string): Promise<{ files: string[]; changed: number }> {
  const files: string[] = [];
  let changed = 0;
  for (const { dir, cwd } of await keyedDirectories(parent, keyOf, from)) {
    const target = movedPath(cwd, from, to);
    if (target === undefined) continue;
    const moved = join(parent, keyOf(target));
    if (existsSync(moved)) throw new Error(`${moved} already exists`);
    renameSync(dir, moved);
    files.push(moved);
    changed++;
    for (const f of filesUnder(moved, ".jsonl")) {
      const n = await rewriteCwd(f, from, to);
      if (n > 0) {
        files.push(f);
        changed += n;
      }
    }
  }
  return { files, changed };
}

/** The transcripts directly under the directories keyed to the project, one per session; a subagent's transcript
 * sits a level down and is not one. */
export async function keyedSessions(parent: string, keyOf: (path: string) => string, path: string): Promise<number> {
  let n = 0;
  for (const { dir } of await keyedDirectories(parent, keyOf, path)) n += readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(".jsonl")).length;
  return n;
}

/** Every file under the directories keyed to the project. */
export async function keyedEntries(parent: string, keyOf: (path: string) => string, path: string): Promise<string[]> {
  return (await keyedDirectories(parent, keyOf, path)).flatMap(({ dir }) => filesUnder(dir, ""));
}

/** What the project's own key and every key under it start with, whatever the key wraps around the path. */
function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** Every regular file under dir with the extension, sorted by path. */
export function filesUnder(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(ext))
    .map(e => join(e.parentPath, e.name))
    .sort();
}

/**
 * Rewrites the JSON lines `edit` returns true for and leaves every other byte alone, including a truncated last line.
 * A rewritten line is re-serialized, so integer-like keys reorder and integers past 2^53 round on that line alone.
 * Returns the count of lines rewritten; a file with none is not touched.
 */
export async function rewriteJsonl(file: string, edit: (line: Record<string, unknown>) => boolean): Promise<number> {
  const tmp = `${file}.wsp-move`;
  const out = createWriteStream(tmp);
  const write = async (s: string): Promise<void> => {
    if (!out.write(s)) await once(out, "drain");
  };
  let changed = 0;
  let rest = "";
  const emit = async (line: string): Promise<void> => {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      obj = undefined;
    }
    if (typeof obj === "object" && obj !== null && edit(obj as Record<string, unknown>)) {
      changed++;
      await write(JSON.stringify(obj));
    } else await write(line);
  };
  try {
    for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
      rest += chunk as string;
      let nl: number;
      while ((nl = rest.indexOf("\n")) >= 0) {
        await emit(rest.slice(0, nl));
        await write("\n");
        rest = rest.slice(nl + 1);
      }
    }
    if (rest !== "") await emit(rest);
    out.end();
    await finished(out);
  } catch (e) {
    out.destroy();
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  if (changed === 0) {
    await unlink(tmp);
    return 0;
  }
  await chmod(tmp, statSync(file).mode);
  await rename(tmp, file);
  return changed;
}

/** Rewrites the `cwd` field of every line where it is `from` or a folder under it; `at` picks the object holding it. */
export const rewriteCwd = (file: string, from: string, to: string, at: (line: Record<string, unknown>) => unknown = l => l): Promise<number> =>
  rewriteJsonl(file, line => {
    const holder = at(line);
    if (typeof holder !== "object" || holder === null) return false;
    const cwd = (holder as Record<string, unknown>).cwd;
    const moved = typeof cwd === "string" ? movedPath(cwd, from, to) : undefined;
    if (moved === undefined) return false;
    (holder as Record<string, unknown>).cwd = moved;
    return true;
  });
