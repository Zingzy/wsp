// SPDX-License-Identifier: AGPL-3.0-only
// This computer's own folders, one level at a time, for the folder picker a
// browser tab has: the desktop shell opens the system dialog and hands the
// page a path, and no web picker can give one. Folders only, nothing here
// reads a file, and only inside the roots, which are the home folder and each
// imported project's folder. The lexical check runs before anything under a
// path is read and the realpath check refuses a symlink that leaves the roots,
// so neither a typed path nor a link inside home reaches the rest of the disk.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { hiddenFolder, workspaceProjects, type HostFolder, type HostFolderListing, type WorkspaceView } from "@wsp/protocol";
import type { HostFolders } from "@wsp/runtime";
import { under } from "./init-import.js";
import { isRepoFolder } from "./project-bundle.js";

export interface HostFolderPaths {
  /** This computer's home folder: the first root, and where a listing starts. */
  home?: string;
  /** Each imported project's own folder, so a project the home folder does not hold is browsable too. */
  projects?: readonly string[];
  /** What this computer runs, for the one folder a Mac keeps in every home; absent reads the process's own. */
  platform?: string;
}

/** The project folders the records name, each once: an import lands a folder on the machine at the path it has here,
 * so a record's dest names the folder on this computer as well. */
export function importedProjectFolders(workspaces: readonly WorkspaceView[]): string[] {
  return [...new Set(workspaces.flatMap(w => workspaceProjects(w).map(p => p.dest)))];
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The folders every level is browsed from: the home folder, then each imported project folder that is a folder here
 * and that the home folder does not already hold. */
export function hostFolderRoots(paths: HostFolderPaths = {}): string[] {
  const home = resolve(paths.home ?? homedir());
  const projects = (paths.projects ?? []).map(p => resolve(p)).filter(p => !under(p, home) && isFolder(p));
  return [home, ...new Set(projects)];
}

function outside(dir: string, roots: readonly string[]): Error {
  return new Error(`${dir} is outside the folders wsp browses on this computer: ${roots.join(", ")}`);
}

/** Which folder a listing is for: absent gives the first root, and so does one inside the roots that is gone, which
 * is what a picker opening on a folder that has since moved should show. Anything outside them is refused. */
function folderToList(dir: string | undefined, roots: readonly string[], realRoots: readonly string[]): string {
  if (dir === undefined || dir === "") return roots[0]!;
  if (!isAbsolute(dir)) throw outside(dir, roots);
  const asked = resolve(dir);
  if (!roots.some(root => under(asked, root))) throw outside(dir, roots);
  if (!isFolder(asked)) return roots[0]!;
  const real = realOf(asked);
  if (real === null || !realRoots.some(root => under(real, root))) throw outside(dir, roots);
  return asked;
}

/** One level: the folders directly inside `dir`, sorted by name, each marked when git tracks it, with the hidden ones
 * counted rather than listed unless `hidden`. The one rule both folder browsers read, told the home it is walking
 * and what this computer is, since the Library a Mac hides is the home's own and not every folder of that name. A
 * folder that exists and cannot be read raises, as does a path outside the roots. A symlink is a row when it points
 * at a folder the roots hold, so no row leads out of them. */
export function listHostFolders(req: { dir?: string; hidden?: boolean } = {}, paths: HostFolderPaths = {}): HostFolderListing {
  const roots = hostFolderRoots(paths);
  const realRoots = roots.map(realOf).filter((root): root is string => root !== null);
  const dir = folderToList(req.dir, roots, realRoots);
  const names = readdirSync(dir, { withFileTypes: true })
    .filter(e => {
      const path = join(dir, e.name);
      if (!isFolder(path)) return false;
      if (!e.isSymbolicLink()) return true;
      const real = realOf(path);
      return real !== null && realRoots.some(root => under(real, root));
    })
    .map(e => e.name)
    .sort();
  const machine = { home: roots[0]!, mac: (paths.platform ?? process.platform) === "darwin" };
  const named = names.filter(name => !hiddenFolder(join(dir, name), machine));
  const shown = req.hidden === true ? names : named;
  const folders: HostFolder[] = shown.map(name => join(dir, name)).map(path => ({ path, repo: isRepoFolder(path) }));
  return { dir, roots, folders, hidden: names.length - named.length };
}

/** The host's side of host.folders. The records are read on every ask, so a project imported while the app is open is
 * browsable at once, and the home folder is this computer's own. */
export function hostFolders(workspaces: () => Promise<readonly WorkspaceView[]>): HostFolders {
  return { list: async req => listHostFolders(req, { projects: importedProjectFolders(await workspaces()) }) };
}
