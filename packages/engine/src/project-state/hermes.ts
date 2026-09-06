// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { type ProjectStateResolver } from "./resolver.js";
import { countRows, movedColumn, pathParams, underPath, updateRows } from "./sqlite.js";

const DB = "state.db";
const AT_PATH = `${underPath("cwd")} or ${underPath("git_repo_root")}`;

export const hermesResolver: ProjectStateResolver = {
  agent: "hermes",
  carry: "transcript-only",
  states: ["sessions"],
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
};
