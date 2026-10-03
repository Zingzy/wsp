// SPDX-License-Identifier: AGPL-3.0-only
// What the picks weigh on a box, read on this computer before anything is
// sent: the catalog's measured size for an agent or a CLI, the bytes a skill
// carries, and for a folder the history a clone brings with the ignored files
// it keeps. A row nobody measured is counted apart rather than guessed.
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMPILER_ROW, catalogEntry, catalogIdOfRow, sizeBytes } from "@wsp/catalog";
import { expand } from "@wsp/collect";
import { toolRowId, type RecipeFile } from "@wsp/protocol";
import { folderFiles } from "./folder-files.js";

/** Room a box needs past what goes on it: what its first agents and folders work in. */
export const PICKS_SPARE_BYTES = 1024 ** 3;

/** How many entries a folder's walk reads before it stops counting: a history this large is said as at least this. */
const WALK_CAP = 200_000;

/** A catalog row's measured size, or nothing where no build measured it. */
const rowBytes = (id: string | undefined): number | undefined => {
  const entry = id === undefined ? undefined : catalogEntry(id);
  return entry === undefined ? undefined : sizeBytes(entry.size);
};

/** A CLI's size by the manager it came from here, off the catalog's row for it. */
export const cliBytes = (via: string, name: string): number | undefined => rowBytes(catalogIdOfRow({ id: toolRowId(via, name) }));

/** An agent's size off its catalog row. */
export const agentBytes = (id: string): number | undefined => rowBytes(id);

/** The bytes under a path, links not followed, up to the walk's cap. */
function treeBytes(path: string): number {
  let bytes = 0;
  let seen = 0;
  const walk = (at: string): void => {
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (st === undefined || seen++ > WALK_CAP) return;
    if (st.isDirectory()) for (const name of readdirSync(at)) walk(join(at, name));
    else if (st.isFile()) bytes += st.size;
  };
  walk(path);
  return bytes;
}

/** A folder as a box gets it: its history, which the clone brings, and the ignored files it keeps; the working files
 * are the history's own. */
export const folderBytes = (path: string, keep: readonly string[]): number => treeBytes(join(path, ".git")) + keep.reduce((n, rel) => n + treeBytes(join(path, rel)), 0);

/** What the picks weigh on a box with the room it needs past them: the agents, the CLIs, the C toolchain where a
 * picked row builds with it, the skills and the folders. The floor already stands by the time anyone picks, so it is
 * not counted. `unmeasured` counts the rows nobody measured, plugins among them. */
export function estimatePicks(picks: RecipeFile, home: string): { bytes: number; unmeasured: number } {
  let bytes = PICKS_SPARE_BYTES;
  let unmeasured = 0;
  const add = (n: number | undefined): void => {
    if (n === undefined) unmeasured++;
    else bytes += n;
  };
  for (const id of Object.keys(picks.agents)) add(agentBytes(id));
  for (const [name, row] of Object.entries(picks.clis)) add(cliBytes(row.via, name));
  if (Object.values(picks.clis).some(row => row.needs?.includes(COMPILER_ROW) === true)) add(rowBytes(COMPILER_ROW));
  for (const [name, row] of Object.entries(picks.skills)) {
    const at = join(expand({ home }, row.from), name);
    try {
      bytes += folderFiles(at).files.reduce((n, f) => n + (statSync(f.path, { throwIfNoEntry: false })?.size ?? 0), 0);
    } catch {
      unmeasured++;
    }
  }
  for (const folder of Object.values(picks.folders)) bytes += folderBytes(expand({ home }, folder.from), folder.keep);
  unmeasured += Object.keys(picks.plugins).length;
  return { bytes, unmeasured };
}
