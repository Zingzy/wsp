// SPDX-License-Identifier: AGPL-3.0-only
// Pass 2. Every dot entry in HOME, ~/.config/* and ~/.local/share/* becomes
// one record. Cache and state are marked by the spec'd roots and by
// subdirectory name at any depth; what an app directory has of each is
// gathered into one record per role so the app's own size is what could travel.
import { type Machine, basename } from "./host.js";
import { EMPTY, type Tree, add, fileTree } from "./walk.js";

export type Role = "config" | "state" | "cache" | "unknown";

export interface Dir extends Tree {
  /** The record's directory: an app directory, a spec root, or a lone file. Shared by an app and its split-out cache and state. */
  path: string;
  role: Role;
  /** What the record covers: path itself, or the subtrees split out of it. */
  paths: string[];
}

const STATE_NAMES = new Set(["node_modules", "venv", ".venv", "virtenv", "logs", "extensions", "installs", "versions", "builds", "projects", "sessions", ".git"]);

/** Cache or state from the name alone, at any depth; undefined when the name says nothing. */
export function roleByName(name: string): Role | undefined {
  if (/cache/i.test(name)) return "cache";
  if (STATE_NAMES.has(name) || /history|sessions$/i.test(name)) return "state";
  return undefined;
}

/** Tokens some tools keep under a cache root; these stay visible to the credential pass. */
const EXCEPTIONS = [".cache/huggingface/token", ".cache/huggingface/stored_tokens"];

const IGNORED = new Set([".Trash", ".config", ".local"]);

function specRoots(m: Machine): { path: string; role: Role }[] {
  const roots = [
    { path: `${m.home}/.cache`, role: "cache" as const },
    { path: `${m.home}/.local/state`, role: "state" as const },
  ];
  if (m.platform === "darwin") roots.push({ path: `${m.home}/Library/Caches`, role: "cache" as const });
  return roots;
}

/** Sums dir. With a split map, a subdirectory the name rule marks is summed into that role's record instead. */
async function scan(m: Machine, dir: string, root: string, split: Map<Role, Dir> | undefined): Promise<Tree> {
  let t = EMPTY;
  const names = await m.fs.list(dir);
  const parts = await Promise.all(names.map(async (name): Promise<Tree> => {
    const p = `${dir}/${name}`;
    const e = await m.fs.stat(p);
    if (e === undefined || e.kind === "link") return EMPTY;
    if (e.kind === "file") return fileTree(e);
    const role = split === undefined ? undefined : roleByName(name);
    if (split === undefined || role === undefined) return scan(m, p, root, split);
    const sub = await scan(m, p, root, undefined);
    const acc = split.get(role) ?? { path: root, role, paths: [], ...EMPTY };
    split.set(role, { ...acc, ...add(acc, sub), paths: [...acc.paths, p] });
    return EMPTY;
  }));
  for (const part of parts) t = add(t, part);
  return t;
}

async function record(m: Machine, path: string, out: Dir[]): Promise<void> {
  const e = await m.fs.stat(path);
  if (e === undefined || e.kind === "link") return;
  if (e.kind === "file") {
    out.push({ path, role: roleByName(basename(path)) ?? "unknown", paths: [path], ...fileTree(e) });
    return;
  }
  const role = roleByName(basename(path));
  if (role !== undefined) {
    out.push({ path, role, paths: [path], ...(await scan(m, path, path, undefined)) });
    return;
  }
  const split = new Map<Role, Dir>();
  out.push({ path, role: "unknown", paths: [path], ...(await scan(m, path, path, split)) });
  for (const d of split.values()) out.push({ ...d, paths: [...d.paths].sort() });
}

export async function roles(m: Machine): Promise<Dir[]> {
  const out: Dir[] = [];
  const spec = specRoots(m);
  for (const root of spec) {
    const e = await m.fs.stat(root.path);
    if (e?.kind === "dir") out.push({ path: root.path, role: root.role, paths: [root.path], ...(await scan(m, root.path, root.path, undefined)) });
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
  for (const c of candidates) {
    if (!specPaths.has(c)) await record(m, c, out);
  }

  for (const rel of EXCEPTIONS) {
    const p = `${m.home}/${rel}`;
    const e = await m.fs.stat(p);
    if (e?.kind === "file") out.push({ path: p, role: "unknown", paths: [p], ...fileTree(e) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.role.localeCompare(b.role));
}
