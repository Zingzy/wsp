// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { join } from "node:path";
import { keyedEntries, keyedSessions, moveKeyedDirectories, type MovedState, type ProjectStateResolver } from "./resolver.js";

/** The projects directory name: the resolved path with every character outside A-Z a-z 0-9 replaced by a dash. */
export const claudeProjectKey = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

export const claudeResolver: ProjectStateResolver = {
  agent: "claude",
  carry: "moves",
  states: ["session transcripts", "auto memory"],
  async move(home, from, to) {
    const { files, changed } = await moveKeyedDirectories(join(home, "projects"), claudeProjectKey, from, to);
    if (changed === 0) return [];
    const moved: MovedState[] = [{ state: "session transcripts", files, changed }];
    const memory = join(home, "projects", claudeProjectKey(to), "memory");
    if (existsSync(memory)) moved.push({ state: "auto memory", files: [memory], changed: 1 });
    return moved;
  },
  sessions: (home, path) => keyedSessions(join(home, "projects"), claudeProjectKey, path),
  entries: (home, path) => keyedEntries(join(home, "projects"), claudeProjectKey, path),
};
