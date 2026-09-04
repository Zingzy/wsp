// SPDX-License-Identifier: AGPL-3.0-only
// Pass 8. A dotfiles manager keeps copies of the rc files under a home of
// its own, under names of its own: chezmoi's private_dot_zshrc.tmpl, a
// plain repository's zshrc, stow's zsh/.zshrc. This pass names those homes,
// says which files in them stand for an rc file and carry secret-shaped
// exports (the pack strips those by the same mapping), and hands pass 4
// what a copy of the home would ship whole: a file with exports under a
// name the mapping does not reach, and the git history, which holds every
// version of every file.
import type { Credential } from "./credentials.js";
import { type Entry, type Machine, basename, tilde } from "./host.js";
import { roleByName } from "./roles.js";
import type { Manager } from "./row.js";
import { FISH_CONF_D, RC_NAMES, type RcScan, isRcPath, rcFiles, stripExports } from "./shell-rc.js";
import { budget, summarize, walk } from "./walk.js";

export interface ManagerHome {
  /** Absolute. */
  path: string;
  manager: Manager;
}

/** The homes known by their usual `~`-relative path alone; a recipe saved before the collector named managers still maps under these. */
export const MANAGER_HOMES: readonly string[] = [".dotfiles", "dotfiles", ".local/share/chezmoi", ".local/share/yadm", ".config/yadm"];

const PLAIN = [".dotfiles", "dotfiles"];
const CHEZMOI_DEFAULT = ".local/share/chezmoi";

/** chezmoi's target attributes, any of them, in front of the name; `dot_` comes after them and becomes the dot. */
const ATTRIBUTES = /^(?:(?:encrypted|private|readonly|executable|empty|create|modify|remove|symlink|once|onchange|before|after|exact|external|literal)_)+/;

/** The target name a source-state entry stands for: `private_dot_zshrc.tmpl` is `.zshrc`; a plain name is itself. */
export function managedName(name: string): string {
  const bare = name.replace(ATTRIBUTES, "");
  return (bare.startsWith("dot_") ? `.${bare.slice(4)}` : bare).replace(/\.tmpl$/, "").replace(/\.literal$/, "");
}

/** Whether a path inside a manager home stands for an rc file, at any depth. A manager home holds config and nothing
 * else, so a deep copy is a real rc file (`dot_config/zsh/dot_zshrc` under a ZDOTDIR layout, `zsh/aliases`), and
 * cutting a secret-shaped line from a file that only looked like one costs a listed name where a miss ships a value.
 * The basename maps with a missing dot restored; a stow package or a chezmoi directory in front is unwound by
 * matching the mapped path's tail against the rc paths. */
export function managedRc(rel: string): boolean {
  const segs = rel.split("/").map(managedName);
  const name = segs.at(-1) ?? "";
  if (RC_NAMES.has(name) || (!name.startsWith(".") && RC_NAMES.has(`.${name}`))) return true;
  for (let i = 0; i < segs.length; i += 1) {
    const [head = "", ...rest] = segs.slice(i);
    if (isRcPath([head, ...rest].join("/"))) return true;
    if (!head.startsWith(".") && isRcPath([`.${head}`, ...rest].join("/"))) return true;
  }
  return false;
}

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

async function isDir(m: Machine, path: string): Promise<boolean> {
  const real = await m.fs.realpath(path);
  return real !== undefined && (await m.fs.stat(real))?.kind === "dir";
}

/** What a stow directory carries besides its packages; a hand-linked repository two levels down has none of these in its parent. */
const STOW_MARKERS = new Set([".git", ".stowrc", ".stow-local-ignore"]);

/** The directories dotfiles managers keep their copies in, each named once: chezmoi's own answer or its markers first,
 * then yadm's, then a stow directory (an rc file at home resolving to `<dir>/<package>/<its own path>`, with the
 * directory corroborated by name or by its own files), then a plain one. Claims are by realpath: a directory reached
 * two ways is one home under the path first claimed, a claim at or under a claimed home is dropped, and an inner
 * one gives way to its outer (chezmoi's `.chezmoiroot` answers below the marked directory). */
export async function managerHomes(m: Machine): Promise<ManagerHome[]> {
  const found = new Map<string, ManagerHome>();
  const claim = async (path: string, manager: Manager): Promise<void> => {
    const real = await m.fs.realpath(path);
    if (real === undefined) return;
    for (const r of found.keys()) {
      if (under(real, r)) return;
      if (under(r, real)) found.delete(r);
    }
    found.set(real, { path, manager });
  };
  if (await m.exec.which("chezmoi")) {
    const answer = (await m.exec.run("chezmoi", ["source-path"]))?.trim().replace(/\/+$/, "");
    if (answer !== undefined && answer !== m.home && under(answer, m.home) && (await isDir(m, answer))) await claim(answer, "chezmoi");
  }
  for (const rel of [CHEZMOI_DEFAULT, ...PLAIN]) {
    const path = `${m.home}/${rel}`;
    if ((await m.fs.list(path)).some(n => n.startsWith(".chezmoi"))) await claim(path, "chezmoi");
  }
  if (await isDir(m, `${m.home}/.local/share/yadm/repo.git`)) {
    await claim(`${m.home}/.local/share/yadm`, "yadm");
    if (await isDir(m, `${m.home}/.config/yadm`)) await claim(`${m.home}/.config/yadm`, "yadm");
  }
  for (const rel of rcFiles(await m.fs.list(`${m.home}/${FISH_CONF_D}`))) {
    const path = `${m.home}/${rel}`;
    const real = await m.fs.realpath(path);
    if (real === undefined || real === path || !under(real, m.home)) continue;
    const target = real.slice(m.home.length + 1);
    if (!target.endsWith(`/${rel}`)) continue;
    const pkg = target.slice(0, -(rel.length + 1));
    const cut = pkg.lastIndexOf("/");
    if (cut <= 0) continue;
    const dir = pkg.slice(0, cut);
    // A repository linked by hand (`~/.zshrc -> ~/src/dotfiles/.zshrc`) has stow's shape; the repository is the home then, and its parent is never named.
    if (await isDir(m, `${m.home}/${pkg}/.git`)) await claim(`${m.home}/${pkg}`, "dotfiles");
    else if (PLAIN.includes(dir) || (await m.fs.list(`${m.home}/${dir}`)).some(n => STOW_MARKERS.has(n))) await claim(`${m.home}/${dir}`, "stow");
  }
  for (const rel of PLAIN) if (await isDir(m, `${m.home}/${rel}`)) await claim(`${m.home}/${rel}`, "dotfiles");
  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

export interface ManagerScan {
  home: ManagerHome;
  /** Files inside the home that stand for an rc file, relative to it, sorted. */
  rcCopies: string[];
  /** Those among them that carry secret-shaped exports. */
  rcSecrets: string[];
  /** Pass 6 entries for the copies with exports, under the copy's own path. */
  shell: RcScan[];
  /** What a copy of the home would ship whole: a file with exports the mapping does not reach, and a git repository. */
  credentials: Credential[];
}

export interface ScanOptions {
  clock?: () => number;
  /** Files the rc files source, resolved: the pack strips those by identity, so they are never split out. */
  sourced?: ReadonlySet<string>;
  notes?: string[];
}

/** Names a shell might read: no extension, or a shell's own. */
const SHELL_EXTENSIONS = new Set(["", "sh", "zsh", "bash", "fish", "env", "local"]);

function shellLike(name: string): boolean {
  const n = managedName(name);
  const dot = n.lastIndexOf(".");
  return SHELL_EXTENSIONS.has(dot <= 0 ? "" : n.slice(dot + 1).toLowerCase());
}

export async function scanManagers(m: Machine, homes: readonly ManagerHome[], opts: ScanOptions = {}): Promise<ManagerScan[]> {
  const clock = opts.clock ?? Date.now;
  const out: ManagerScan[] = [];
  for (const home of homes) {
    const scan: ManagerScan = { home, rcCopies: [], rcSecrets: [], shell: [], credentials: [] };
    const files: [string, Entry][] = [];
    const repos: string[] = [];
    const b = budget(clock);
    // A repository at any depth (a package that is its own repo, a submodule) is a history whatever else the walk leaves out.
    const skip = (n: string, p: string): boolean => {
      if (n.endsWith(".git")) repos.push(p);
      return roleByName(n) !== undefined || n.endsWith(".git");
    };
    await walk(m.fs, home.path, { budget: b, skip }, (p, e) => void files.push([p, e]));
    if (b.capped) opts.notes?.push(`${tilde(m.home, home.path)}: the scan for rc copies stopped at the cap`);
    files.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    for (const [p, e] of files) {
      const rel = p.slice(home.path.length + 1);
      const copy = managedRc(rel);
      if (copy) scan.rcCopies.push(rel);
      if (!copy && (!shellLike(basename(p)) || opts.sourced?.has((await m.fs.realpath(p)) ?? p) === true)) continue;
      const text = await m.fs.readText(p);
      if (text === undefined) continue;
      const s = stripExports(text);
      if (s.names.length === 0) continue;
      if (copy) {
        scan.rcSecrets.push(rel);
        scan.shell.push({ path: tilde(m.home, p), ...s });
      } else {
        scan.credentials.push({ path: p, bytes: e.bytes, files: 1, mode: e.mode, mtime: e.mtime, signals: ["exports"] });
      }
    }
    for (const p of repos.sort()) {
      const e = await m.fs.stat(p);
      if (e?.kind !== "dir") continue;
      scan.credentials.push({ path: p, ...(await summarize(m.fs, p, { budget: budget(clock) })), mode: e.mode, signals: ["history"] });
    }
    out.push(scan);
  }
  return out;
}
