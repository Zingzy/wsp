// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { mergeScript } from "./merge.js";
import { movedOr, type ProjectStateResolver } from "./resolver.js";
import { countRows, movedColumn, pathParams, selectRows, sqliteMergeStep, underPath, updateRows } from "./sqlite.js";

const DB = "state.db";
const AT_PATH = `${underPath("cwd")} or ${underPath("git_repo_root")}`;
const AT_PATH_IDS = `select id from sessions where ${AT_PATH}`;

export const hermesResolver: ProjectStateResolver = {
  agent: "hermes",
  carry: "transcript-only",
  states: ["sessions"],
  roots: [DB],
  async move(home, from, to) {
    const db = join(home, DB);
    const [changed = 0] = updateRows(db, [{
      sql: `update sessions set cwd = ${movedColumn("cwd")}, git_repo_root = ${movedColumn("git_repo_root")} where ${AT_PATH}`,
      params: pathParams(from, to),
    }]) ?? [];
    return changed > 0 ? [{ state: "sessions", files: [db], changed }] : [];
  },
  sessions: async (home, path) => countRows(join(home, DB), `select count(*) as n from sessions where ${AT_PATH}`, { $from: path }),
  entries: async () => [],
  async merge(home, from, to, guestHome) {
    const sessions = selectRows(join(home, DB), `select * from sessions where ${AT_PATH} order by id`, { $from: from }) ?? [];
    if (sessions.length === 0) return undefined;
    const rows = sessions.map(r => ({ ...r, cwd: movedOr(r["cwd"] ?? null, from, to), git_repo_root: movedOr(r["git_repo_root"] ?? null, from, to) }));
    // A message's id is an autoincrement integer, its own on each computer, so a session's messages land whole or not at all.
    const messages = selectRows(join(home, DB), `select * from messages where session_id in (${AT_PATH_IDS}) order by id`, { $from: from }) ?? [];
    return mergeScript(from, to, [
      sqliteMergeStep(join(guestHome, DB), [
        { table: "sessions", key: ["id"], set: ["cwd", "git_repo_root"], rows },
        { table: "messages", by: "session_id", drop: ["id"], rows: messages },
      ]),
    ]);
  },
};
