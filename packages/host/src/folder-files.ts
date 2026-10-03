// SPDX-License-Identifier: AGPL-3.0-only
// The one rule every file a recipe ships or digests is read by: under a
// folder, a link is followed only to a file. A linked folder is somebody's
// checkout or somebody's keys, so it never travels and is named instead.
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** What one folder holds by that rule: each file folder-relative with the path it is read from, and each link that
 * was not followed. */
export interface FolderFiles {
  files: { rel: string; path: string }[];
  links: string[];
}

/** Every file under `dir` in order, `leave` naming the entries passed over at any depth. */
export function folderFiles(dir: string, leave: (name: string) => boolean = name => name === ".git"): FolderFiles {
  const out: FolderFiles = { files: [], links: [] };
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (leave(name)) continue;
      const at = rel === "" ? name : `${rel}/${name}`;
      const path = join(dir, at);
      const own = lstatSync(path, { throwIfNoEntry: false });
      if (own === undefined) continue;
      if (own.isSymbolicLink()) {
        if (statSync(path, { throwIfNoEntry: false })?.isFile() === true) out.files.push({ rel: at, path });
        else out.links.push(at);
      } else if (own.isDirectory()) walk(at);
      else if (own.isFile()) out.files.push({ rel: at, path });
    }
  };
  walk("");
  return out;
}

/** The note a link left out says. */
export const LINKED_FOLDER_NOTE = "links to a folder, which a recipe never sends";
