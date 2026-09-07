// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { join } from "node:path";
import { keyedStep, listScript } from "./listing.js";
import { pyData } from "./py.js";
import { keyedEntries, keyedSessions, moveKeyedDirectories, type MovedState, type ProjectStateResolver } from "./resolver.js";

/** The projects directory name: the resolved path with every character outside A-Z a-z 0-9 replaced by a dash. */
export const claudeProjectKey = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");
/** The same rule for the machine, where nothing can run this one. */
const KEY_PY = `lambda p: re.sub(${pyData("[^A-Za-z0-9]")}, "-", p)`;
const PROJECTS = "projects";
const ROOTS = [PROJECTS];

export const claudeResolver: ProjectStateResolver = {
  agent: "claude",
  carry: "moves",
  states: ["session transcripts", "auto memory"],
  roots: ROOTS,
  async move(home, from, to) {
    const { files, changed } = await moveKeyedDirectories(join(home, PROJECTS), claudeProjectKey, from, to);
    if (changed === 0) return [];
    const moved: MovedState[] = [{ state: "session transcripts", files, changed }];
    const memory = join(home, "projects", claudeProjectKey(to), "memory");
    if (existsSync(memory)) moved.push({ state: "auto memory", files: [memory], changed: 1 });
    return moved;
  },
  sessions: (home, path) => keyedSessions(join(home, PROJECTS), claudeProjectKey, path),
  entries: (home, path) => keyedEntries(join(home, PROJECTS), claudeProjectKey, path),
  listing: (home, path) => listScript(home, path, ROOTS, [keyedStep(join(home, PROJECTS), KEY_PY)]),
};
