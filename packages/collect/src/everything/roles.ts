// SPDX-License-Identifier: AGPL-3.0-only
// Pass 2. Every dot entry in HOME, ~/.config/*, ~/.local/share/* and, on
// macOS, ~/Library/Preferences/* and ~/Library/Application Support/* becomes
// one record. Cache and state are marked by the spec'd roots and by
// subdirectory name at any depth; what an app directory has of each is
// gathered into one record per role so the app's own size is what could travel.
import { type Machine, basename } from "./host.js";
import type { Measured } from "./row.js";
import { type Budget, EMPTY, type Tree, add, budget, fileTree, spend } from "./walk.js";

export type Role = "config" | "state" | "cache" | "unknown";

export interface Dir extends Tree {
  /** The record's directory: an app directory, a spec root, or a lone file. Shared by an app and its split-out cache and state. */
  path: string;
  kind: "file" | "dir";
  role: Role;
  /** What the record covers: path itself, or the subtrees split out of it. */
  paths: string[];
  measured: Measured;
  /** Where path points when it is a symlink; the tree was measured there. */
  linkTarget?: string;
}

export interface RolesOptions {
  /** Monotonic milliseconds for the walk budget; tests pin it. */
  clock?: () => number;
}

const STATE_NAMES = new Set(["node_modules", "venv", ".venv", "virtenv", "logs", "extensions", "installs", "versions", "builds", "projects", "sessions", ".git", "toolchains", "registry", "avd", "_npx"]);

/** Cache or state from the name alone, at any depth; undefined when the name says nothing. */
export function roleByName(name: string): Role | undefined {
  if (/cache/i.test(name)) return "cache";
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

/** Sums dir within the budget. With a split map, a subdirectory the name rule marks is summed into that role's record instead. */
async function scan(m: Machine, dir: string, root: string, split: Map<Role, Dir> | undefined, b: Budget): Promise<Tree> {
  let t = EMPTY;
  const names = await m.fs.list(dir);
  const parts = await Promise.all(names.map(async (name): Promise<Tree> => {
    if (!spend(b)) return EMPTY;
    const p = `${dir}/${name}`;
    const e = await m.fs.stat(p);
    if (e === undefined || e.kind === "link") return EMPTY;
    if (e.kind === "file") return fileTree(e);
    const role = split === undefined ? undefined : roleByName(name);
    if (split === undefined || role === undefined) return scan(m, p, root, split, b);
    const sub = await scan(m, p, root, undefined, b);
    const acc = split.get(role) ?? { path: root, kind: "dir", role, paths: [], measured: "exact", ...EMPTY };
    split.set(role, { ...acc, ...add(acc, sub), paths: [...acc.paths, p] });
    return EMPTY;
  }));
  for (const part of parts) t = add(t, part);
  return t;
}

async function record(m: Machine, path: string, out: Dir[], clock: () => number): Promise<void> {
  let e = await m.fs.stat(path);
  let linkTarget: string | undefined;
  if (e?.kind === "link") {
    linkTarget = await m.fs.realpath(path);
    e = linkTarget === undefined ? undefined : await m.fs.stat(linkTarget);
  }
  if (e === undefined || e.kind === "link") return;
  const where = linkTarget ?? path;
  const link = linkTarget === undefined ? {} : { linkTarget };
  if (e.kind === "file") {
    out.push({ path, kind: "file", role: roleByName(basename(path)) ?? "unknown", paths: [path], measured: "exact", ...link, ...fileTree(e) });
    return;
  }
  const b = budget(clock);
  const role = roleByName(basename(path));
  if (role !== undefined || linkTarget !== undefined) {
    const tree = await scan(m, where, path, undefined, b);
    out.push({ path, kind: "dir", role: role ?? "unknown", paths: [path], measured: b.capped ? "lower-bound" : "exact", ...link, ...tree });
    return;
  }
  const split = new Map<Role, Dir>();
  const tree = await scan(m, path, path, split, b);
  const measured: Measured = b.capped ? "lower-bound" : "exact";
  out.push({ path, kind: "dir", role: "unknown", paths: [path], measured, ...tree });
  for (const d of split.values()) out.push({ ...d, measured, paths: [...d.paths].sort() });
}

export async function roles(m: Machine, opts: RolesOptions = {}): Promise<Dir[]> {
  const clock = opts.clock ?? Date.now;
  const out: Dir[] = [];
  const spec = specRoots(m);
  for (const root of spec) {
    const e = await m.fs.stat(root.path);
    if (e?.kind === "dir") out.push({ path: root.path, kind: "dir", role: root.role, paths: [root.path], measured: "none", ...EMPTY });
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
      for (const name of await m.fs.list(dir)) if (!name.startsWith(APPLE)) candidates.push(`${dir}/${name}`);
    }
  }
  for (const c of candidates) {
    if (!specPaths.has(c)) await record(m, c, out, clock);
  }

  for (const rel of EXCEPTIONS) {
    const p = `${m.home}/${rel}`;
    const e = await m.fs.stat(p);
    if (e?.kind === "file") out.push({ path: p, kind: "file", role: "unknown", paths: [p], measured: "exact", ...fileTree(e) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.role.localeCompare(b.role));
}
