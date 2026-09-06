// SPDX-License-Identifier: AGPL-3.0-only
// A project folder on this computer, read for the trip to a workspace: the tracked tree, the state beside it
// that is not a cache, and the repository whole. A cache is recreated on the machine, never carried.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CACHE_WORD, INSTALL_NAMES, OUTPUT_NAMES, fileSignals } from "@wsp/collect";
import { TAR_MAX_FILE_BYTES, fitsTar, tarOf, type TarEntry } from "@wsp/engine";
import type { ProjectPlan, ProjectSecret } from "@wsp/protocol";
import type { PackedProject, ProjectBundler } from "@wsp/runtime";

/** A virtual environment goes by any name; this file inside it says what it is. */
const VENV_MARKER = "pyvenv.cfg";
const GIT_DIR = ".git";
const LS_FILES_MAX_BYTES = 256 * 1024 * 1024;

/** The cache rule, from the collector's name sets: what an install recreates, what a build regenerates, or a name that says cache. */
export function isCacheName(name: string): boolean {
  return INSTALL_NAMES.has(name) || OUTPUT_NAMES.has(name) || CACHE_WORD.test(name);
}

interface BundlePath {
  /** Relative to the folder, slash-separated: the path in the archive. */
  rel: string;
  abs: string;
  mode: number;
}
export type BundleFile = BundlePath &
  (
    | {
        kind: "file";
        bytes: number;
        /** Secret-shaped by the collector's credential rules; travels only when named. */
        secret: boolean;
      }
    | { kind: "dir" }
    | {
        kind: "link";
        /** The target as written, never followed. */
        target: string;
      }
  );

export interface ProjectListing {
  plan: ProjectPlan;
  files: BundleFile[];
}

async function trackedPaths(source: string): Promise<Set<string>> {
  const out = await new Promise<string>((res, rej) => {
    execFile("git", ["-C", source, "ls-files", "-z"], { maxBuffer: LS_FILES_MAX_BYTES }, (err, stdout, stderr) => {
      if (err) rej(new Error(`git ls-files failed in ${source}: ${String(stderr).trim() || err.message}`));
      else res(stdout);
    });
  });
  return new Set(out.split("\0").filter(p => p !== ""));
}

/** Every directory that holds a tracked path, so a cache-named directory git tracks part of is entered for those. */
function ancestors(paths: ReadonlySet<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) for (let cut = p.lastIndexOf("/"); cut > 0; cut = p.lastIndexOf("/", cut - 1)) dirs.add(p.slice(0, cut));
  return dirs;
}

interface Walk {
  source: string;
  tracked: ReadonlySet<string>;
  trackedDirs: ReadonlySet<string>;
  files: BundleFile[];
  secrets: ProjectSecret[];
  excluded: string[];
  skipped: { path: string; note: string }[];
  scans: Promise<void>[];
}

const insideFolder = (source: string, abs: string): boolean => abs === source || abs.startsWith(`${source}/`);

/** One directory level. Under .git nothing is judged; under a cache-named directory only tracked paths are kept. */
function walk(w: Walk, dir: string, relDir: string, inGit: boolean, onlyTracked: boolean): void {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = relDir === "" ? name : `${relDir}/${name}`;
    const st = lstatSync(abs);
    const mode = st.mode & 0o7777;
    const isTracked = w.tracked.has(rel);
    if (onlyTracked && !isTracked && !w.trackedDirs.has(rel)) continue;
    if (rel === GIT_DIR && st.isFile()) {
      w.skipped.push({ path: rel, note: `a worktree or submodule checkout: its repository is at ${readFileSync(abs, "utf8").trim().replace(/^gitdir: /, "")} and does not travel` });
      continue;
    }
    if (st.isSymbolicLink()) {
      const target = readlinkSync(abs);
      if (isAbsolute(target) || !insideFolder(w.source, resolve(dirname(abs), target))) w.skipped.push({ path: rel, note: `a link to ${target}, outside the folder; not followed` });
      else if (!fitsTar(rel, target)) w.skipped.push({ path: rel, note: "a link the archive cannot hold: the path or the target is too long" });
      else w.files.push({ rel, abs, kind: "link", mode, target });
      continue;
    }
    if (st.isDirectory()) {
      const git = inGit || name === GIT_DIR;
      const cache = !git && !isTracked && (isCacheName(name) || existsSync(join(abs, VENV_MARKER)));
      if (cache) {
        w.excluded.push(rel);
        if (!w.trackedDirs.has(rel)) continue;
      }
      if (!fitsTar(rel)) {
        w.skipped.push({ path: rel, note: "a path too long for the archive" });
        continue;
      }
      w.files.push({ rel, abs, kind: "dir", mode });
      walk(w, abs, rel, git, onlyTracked || cache);
      continue;
    }
    if (!st.isFile()) {
      w.skipped.push({ path: rel, note: "not a regular file" });
      continue;
    }
    if (!inGit && !isTracked && isCacheName(name)) {
      w.excluded.push(rel);
      continue;
    }
    if (st.size > TAR_MAX_FILE_BYTES) {
      w.skipped.push({ path: rel, note: "over 8 GB, more than a tar header holds" });
      continue;
    }
    if (!fitsTar(rel)) {
      w.skipped.push({ path: rel, note: "a path too long for the archive" });
      continue;
    }
    const file: BundleFile = { rel, abs, kind: "file", mode, bytes: st.size, secret: false };
    w.files.push(file);
    if (inGit) continue;
    const read = async (): Promise<string | undefined> => {
      try {
        return readFileSync(abs, "utf8");
      } catch {
        return undefined;
      }
    };
    w.scans.push(
      fileSignals(name, { bytes: st.size, mode: st.mode }, read, false).then(signals => {
        if (signals === undefined) return;
        file.secret = true;
        w.secrets.push({ path: rel, bytes: st.size, signals });
      }),
    );
  }
}

/** What an import of the folder would carry. Names and sizes are read, file bodies only for the secret scan of small
 * structured files; a .git file (a worktree or a submodule checkout) is named and left, since its repository lives
 * elsewhere. Throws when the folder is not an absolute path to a directory. */
export async function planProject(source: string): Promise<ProjectListing> {
  if (!isAbsolute(source)) throw new Error(`the folder must be an absolute path, got ${source}`);
  const root = source.replace(/\/+$/, "") || "/";
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${root} is not a folder on this computer`);
  const repo = existsSync(join(root, GIT_DIR));
  const tracked = repo ? await trackedPaths(root) : new Set<string>();
  const w: Walk = { source: root, tracked, trackedDirs: ancestors(tracked), files: [], secrets: [], excluded: [], skipped: [], scans: [] };
  walk(w, root, "", false, false);
  await Promise.all(w.scans);
  w.secrets.sort((a, b) => (a.path < b.path ? -1 : 1));
  const regular = w.files.filter((f): f is BundleFile & { kind: "file" } => f.kind === "file");
  const plan: ProjectPlan = {
    source: root,
    repo,
    files: regular.length,
    bytes: regular.reduce((n, f) => n + f.bytes, 0),
    secrets: w.secrets,
    excluded: w.excluded,
    skipped: w.skipped,
  };
  return { plan, files: w.files };
}

/** The gzipped archive of a listing, every entry at its path relative to the folder with its mode; a secret-shaped
 * file travels only when `carry` names its path. Bytes are read now, so a file that changed since the plan travels
 * as it is at this moment. */
export function packProject(listing: ProjectListing, carry: ReadonlySet<string>): PackedProject {
  const entries: TarEntry[] = [];
  const cut: string[] = [];
  let files = 0;
  let bytes = 0;
  for (const f of listing.files) {
    if (f.kind === "dir") entries.push({ path: f.rel, mode: f.mode, dir: true });
    else if (f.kind === "link") entries.push({ path: f.rel, target: f.target });
    else if (f.secret && !carry.has(f.rel)) cut.push(f.rel);
    else {
      const content = readFileSync(f.abs);
      entries.push({ path: f.rel, mode: f.mode, content });
      files += 1;
      bytes += content.length;
    }
  }
  return { tar: tarOf(entries), files, bytes, cut };
}

/** The folder as the runtime's project.import op reads it: planned once, packed when consent is known. */
export function projectBundler(source: string): ProjectBundler {
  let listing: Promise<ProjectListing> | undefined;
  const listed = (): Promise<ProjectListing> => (listing ??= planProject(source));
  return {
    plan: async () => (await listed()).plan,
    pack: async carry => packProject(await listed(), carry),
  };
}
