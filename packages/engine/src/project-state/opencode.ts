// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { mergeScript } from "./merge.js";
import { movedOr, type MovedState, type ProjectStateResolver } from "./resolver.js";
import { countRows, movedColumn, pathParams, selectRows, sqliteMergeStep, underPath, updateRows, type MergeMode, type MergeTable } from "./sqlite.js";

const UPDATES = [
  ["project", `update project set worktree = ${movedColumn("worktree")}, sandboxes = '[]' where ${underPath("worktree")}`],
  ["project directories", `update project_directory set directory = ${movedColumn("directory")} where ${underPath("directory")}`],
  ["sessions", `update session set directory = ${movedColumn("directory")} where ${underPath("directory")}`],
] as const;
const DB = "opencode.db";
/** The same three tables for the machine's store, then each session's messages and their parts: the project keeps
 * its id (the first commit's hash, the same on both), so the merge names it by id and moves its worktree; a directory
 * row is its own key; messages and parts carry string ids of their own and hold no path. */
type Row = MergeTable["rows"][number];
const SESSION_IDS = `select id from session where ${underPath("directory")}`;
const same = (r: Row): Row => r;
const MERGES: readonly ({ table: string; where: string; move: (row: Row, from: string, to: string) => Row } & MergeMode)[] = [
  { table: "project", key: ["id"], set: ["worktree", "sandboxes"], where: underPath("worktree"), move: (r, from, to) => ({ ...r, worktree: movedOr(r["worktree"] ?? null, from, to), sandboxes: "[]" }) },
  { table: "project_directory", key: ["project_id", "directory"], set: [], where: underPath("directory"), move: (r, from, to) => ({ ...r, directory: movedOr(r["directory"] ?? null, from, to) }) },
  { table: "session", key: ["id"], set: ["directory"], where: underPath("directory"), move: (r, from, to) => ({ ...r, directory: movedOr(r["directory"] ?? null, from, to) }) },
  { table: "message", key: ["id"], set: [], where: `session_id in (${SESSION_IDS})`, move: same },
  { table: "part", key: ["id"], set: [], where: `message_id in (select id from message where session_id in (${SESSION_IDS}))`, move: same },
];

export const opencodeResolver: ProjectStateResolver = {
  agent: "opencode",
  carry: "transcript-only",
  states: UPDATES.map(([state]) => state),
  async move(home, from, to) {
    const db = join(home, DB);
    const rows = updateRows(db, UPDATES.map(([, sql]) => ({ sql, params: pathParams(from, to) })));
    if (rows === undefined) return [];
    const moved: MovedState[] = [];
    for (const [i, [state]] of UPDATES.entries()) if (rows[i]! > 0) moved.push({ state, files: [db], changed: rows[i]! });
    return moved;
  },
  sessions: async (home, path) => countRows(join(home, DB), `select count(*) as n from session where ${underPath("directory")}`, { $from: path }),
  entries: async () => [],
  async merge(home, from, to, guestHome) {
    const tables: MergeTable[] = MERGES.map(({ where, move, ...mode }) => ({
      ...mode,
      rows: (selectRows(join(home, DB), `select * from ${mode.table} where ${where} order by 1, 2`, { $from: from }) ?? []).map(r => move(r, from, to)),
    }));
    if (tables.every(t => t.rows.length === 0)) return undefined;
    return mergeScript(from, to, [sqliteMergeStep(join(guestHome, DB), tables)]);
  },
};
