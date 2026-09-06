// SPDX-License-Identifier: AGPL-3.0-only
// Pass 2. Every dot entry in HOME, ~/.config/*, ~/.local/share/* and, on
// macOS, ~/Library/Preferences/* and ~/Library/Application Support/* becomes
// one record; a plist means nothing on a Linux machine and is left out. Cache
// and state are marked by the spec'd roots and by
// subdirectory name at any depth; what an app directory has of each is
// gathered into one record per role so the app's own size is what could travel.
import { type Machine, basename, tilde } from "./host.js";
import type { Measured } from "./row.js";
import { type Budget, EMPTY, SPLIT_ENTRIES, SPLIT_MS, type Tree, add, budget, fileTree, linkTree, spend } from "./walk.js";

export type Role = "config" | "state" | "cache" | "unknown";

export interface Dir extends Tree {
  /** The record's directory: an app directory, a spec root, or a lone file. Shared by an app and its split-out cache and state. */
  path: string;
  kind: "file" | "dir";
  role: Role;
  /** What the record covers: path itself, or the subtrees split out of it. */
  paths: string[];
  /** Subtrees under paths that other records hold and this one did not count. */
  excludes: string[];
  measured: Measured;
  /** Where path points when it is a symlink; the tree was measured there. */
  linkTarget?: string;
}

export interface RolesOptions {
  /** Monotonic milliseconds for the walk budget; tests pin it. */
  clock?: () => number;
  /** Collects what was left out and why. */
  notes?: string[];
  /** Directories holding PATH binaries; split out of their app directory as state, since a binary is reinstalled, never copied. */
  binDirs?: ReadonlySet<string>;
  /** The binaries themselves, for one that sits directly in its app directory. */
  binFiles?: ReadonlySet<string>;
  /** Absolute directories to record besides the dot entries (a dotfiles manager's home under a plain name); one a candidate already covers is left to it. */
  extra?: readonly string[];
}

interface Scan {
  m: Machine;
  clock: () => number;
  binDirs: ReadonlySet<string>;
  binFiles: ReadonlySet<string>;
}

/** Directories an install recreates, under a home or in a project; never copied. */
export const INSTALL_NAMES: ReadonlySet<string> = new Set(["node_modules", "venv", ".venv", "virtenv", "site-packages", "__pycache__"]);
/** What a project's own tooling regenerates: build output, coverage, framework and task-runner caches. */
export const OUTPUT_NAMES: ReadonlySet<string> = new Set(["dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".turbo", ".tox", ".gradle"]);
const STATE_NAMES = new Set([...INSTALL_NAMES, "logs", "extensions", "installs", "versions", "builds", "projects", "sessions", ".git", "toolchains", "registry", "avd", "_npx"]);

/** Files a shell or an app regenerates: compiled completions, sqlite journals, lock and temp files, Finder metadata. */
const CACHE_FILES = [/^\.DS_Store$/, /^\.zcompdump/, /\.zwc$/, /-(shm|wal)$/, /\.lock$/, /\.tmp\./];

/** A name that says cache, wherever the word sits: .cache, .eslintcache, .parcel-cache, __pycache__. */
export const CACHE_WORD = /cache/i;

/** Cache or state from the name alone, at any depth; undefined when the name says nothing. */
export function roleByName(name: string): Role | undefined {
  if (CACHE_WORD.test(name) || CACHE_FILES.some(p => p.test(name))) return "cache";
  if (STATE_NAMES.has(name) || /history|sessions$/i.test(name)) return "state";
  return undefined;
}

/** Tokens some tools keep under a cache root; these stay visible to the credential pass. */
const EXCEPTIONS = [".cache/huggingface/token", ".cache/huggingface/stored_tokens"];

const IGNORED = new Set([".Trash", ".config", ".local"]);
const APPLE = "com.apple.";

function specRoots(m: Machine): { path: string; role: Role }[] {
  const roots = [
    { path: `${m.home}/.cache`, role: "cache" as const },
    { path: `${m.home}/.local/state`, role: "state" as const },
  ];
  if (m.platform === "darwin") roots.push({ path: `${m.home}/Library/Caches`, role: "cache" as const });
  return roots;
}

/** Sums dir within the budget; a symlink is one entry of no size, never followed. With a split map, a subdirectory the name rule or the binary list marks is summed into that role's record with a budget of its own, so the app's own files are always counted. */
async function scan(c: Scan, dir: string, root: string, split: Map<Role, Dir> | undefined, b: Budget): Promise<Tree> {
  let t = EMPTY;
  const names = await c.m.fs.list(dir);
  const parts = await Promise.all(names.map(async (name): Promise<Tree> => {
    if (!spend(b)) return EMPTY;
    const p = `${dir}/${name}`;
    const e = await c.m.fs.stat(p);
    if (e === undefined) return EMPTY;
    if (e.kind === "link") return linkTree(e);
    const carve = (role: Role, sub: Tree, capped: boolean): Tree => {
      const acc = split?.get(role) ?? { path: root, kind: "dir", role, paths: [], excludes: [], measured: "exact", ...EMPTY };
      split?.set(role, { ...acc, ...add(acc, sub), paths: [...acc.paths, p], measured: capped || acc.measured === "lower-bound" ? "lower-bound" : "exact" });
      return EMPTY;
    };
    if (e.kind === "file") return split !== undefined && c.binFiles.has(p) ? carve("state", fileTree(e), false) : fileTree(e);
    const role = split === undefined ? undefined : c.binDirs.has(p) ? "state" : roleByName(name);
    if (split === undefined || role === undefined) return scan(c, p, root, split, b);
    const own = budget(c.clock, SPLIT_ENTRIES, SPLIT_MS);
    return carve(role, await scan(c, p, root, undefined, own), own.capped);
  }));
  for (const part of parts) t = add(t, part);
  return t;
}

/** A cap reached before anything was counted is no measure at all. */
function settle(d: Dir): Dir {
  return d.measured === "lower-bound" && d.files === 0 ? { ...d, measured: "none" } : d;
}

async function record(c: Scan, path: string, out: Dir[], notes: string[]): Promise<void> {
  const m = c.m;
  let e = await m.fs.stat(path);
  let linkTarget: string | undefined;
  if (e?.kind === "link") {
    linkTarget = await m.fs.realpath(path);
    e = linkTarget === undefined ? undefined : await m.fs.stat(linkTarget);
    if (e === undefined) notes.push(`${tilde(m.home, path)} is a broken symlink and is not listed`);
  }
  if (e === undefined || e.kind === "link") return;
  const where = linkTarget ?? path;
  const link = linkTarget === undefined ? {} : { linkTarget };
  if (e.kind === "file") {
    out.push({ path, kind: "file", role: roleByName(basename(path)) ?? "unknown", paths: [path], excludes: [], measured: "exact", ...link, ...fileTree(e) });
    return;
  }
  const b = budget(c.clock);
  const role = roleByName(basename(path));
  if (role !== undefined || linkTarget !== undefined) {
    const tree = await scan(c, where, path, undefined, b);
    out.push(settle({ path, kind: "dir", role: role ?? "unknown", paths: [path], excludes: [], measured: b.capped ? "lower-bound" : "exact", ...link, ...tree }));
    return;
  }
  const split = new Map<Role, Dir>();
  const tree = await scan(c, path, path, split, b);
  const carved = [...split.values()].flatMap(d => d.paths).sort();
  out.push(settle({ path, kind: "dir", role: "unknown", paths: [path], excludes: carved, measured: b.capped ? "lower-bound" : "exact", ...tree }));
  for (const d of split.values()) out.push(settle({ ...d, paths: [...d.paths].sort() }));
}

export async function roles(m: Machine, opts: RolesOptions = {}): Promise<Dir[]> {
  const c: Scan = { m, clock: opts.clock ?? Date.now, binDirs: opts.binDirs ?? new Set(), binFiles: opts.binFiles ?? new Set() };
  const notes = opts.notes ?? [];
  const out: Dir[] = [];
  const spec = specRoots(m);
  for (const root of spec) {
    const e = await m.fs.stat(root.path);
    if (e?.kind === "dir") out.push({ path: root.path, kind: "dir", role: root.role, paths: [root.path], excludes: [], measured: "none", ...EMPTY });
  }
  const specPaths = new Set(spec.map(r => r.path));

  const candidates: string[] = [];
  for (const name of await m.fs.list(m.home)) {
    if (name.startsWith(".") && !IGNORED.has(name)) candidates.push(`${m.home}/${name}`);
  }
  for (const name of await m.fs.list(`${m.home}/.config`)) candidates.push(`${m.home}/.config/${name}`);
  for (const name of await m.fs.list(`${m.home}/.local/share`)) candidates.push(`${m.home}/.local/share/${name}`);
  for (const name of await m.fs.list(`${m.home}/.local`)) {
    if (name !== "share" && name !== "bin") candidates.push(`${m.home}/.local/${name}`);
  }
  if (m.platform === "darwin") {
    for (const dir of [`${m.home}/Library/Preferences`, `${m.home}/Library/Application Support`]) {
      for (const name of await m.fs.list(dir)) if (!name.startsWith(APPLE) && !name.endsWith(".plist")) candidates.push(`${dir}/${name}`);
    }
  }
  const extras = (opts.extra ?? []).filter(p => !candidates.some(x => p === x || p.startsWith(`${x}/`)) && !specPaths.has(p));
  if (extras.length > 0) {
    // A candidate that is a link to the extra already records that directory, under the link.
    const reals = new Set(await Promise.all(candidates.map(c => m.fs.realpath(c))));
    for (const p of extras) {
      const e = await m.fs.stat(p);
      if ((e?.kind === "dir" || e?.kind === "link") && !reals.has(await m.fs.realpath(p))) candidates.push(p);
    }
  }
  for (const path of candidates) {
    if (!specPaths.has(path)) await record(c, path, out, notes);
  }

  for (const rel of EXCEPTIONS) {
    const p = `${m.home}/${rel}`;
    const e = await m.fs.stat(p);
    if (e?.kind === "file") out.push({ path: p, kind: "file", role: "unknown", paths: [p], excludes: [], measured: "exact", ...fileTree(e) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.role.localeCompare(b.role));
}
