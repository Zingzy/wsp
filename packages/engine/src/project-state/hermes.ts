// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { type ProjectStateResolver } from "./resolver.js";
import { movedColumn, pathParams, underPath, updateRows } from "./sqlite.js";

export const hermesResolver: ProjectStateResolver = {
  agent: "hermes",
  states: ["sessions"],
  async move(home, from, to) {
    const db = join(home, "state.db");
    const [changed = 0] = updateRows(db, [{
      sql: `update sessions set cwd = ${movedColumn("cwd")}, git_repo_root = ${movedColumn("git_repo_root")} where ${underPath("cwd")} or ${underPath("git_repo_root")}`,
      params: pathParams(from, to),
    }]) ?? [];
    return changed > 0 ? [{ state: "sessions", files: [db], changed }] : [];
  },
};
