// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { type MovedState, type ProjectStateResolver } from "./resolver.js";
import { movedColumn, pathParams, underPath, updateRows } from "./sqlite.js";

const UPDATES = [
  ["project", `update project set worktree = ${movedColumn("worktree")}, sandboxes = '[]' where ${underPath("worktree")}`],
  ["project directories", `update project_directory set directory = ${movedColumn("directory")} where ${underPath("directory")}`],
  ["sessions", `update session set directory = ${movedColumn("directory")} where ${underPath("directory")}`],
] as const;

export const opencodeResolver: ProjectStateResolver = {
  agent: "opencode",
  states: UPDATES.map(([state]) => state),
  async move(home, from, to) {
    const db = join(home, "opencode.db");
    const rows = updateRows(db, UPDATES.map(([, sql]) => ({ sql, params: pathParams(from, to) })));
    if (rows === undefined) return [];
    const moved: MovedState[] = [];
    for (const [i, [state]] of UPDATES.entries()) if (rows[i]! > 0) moved.push({ state, files: [db], changed: rows[i]! });
    return moved;
  },
};
