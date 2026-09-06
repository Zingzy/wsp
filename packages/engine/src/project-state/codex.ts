// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { filesUnder, rewriteCwd, type MovedState, type ProjectStateResolver } from "./resolver.js";
import { movedColumn, pathParams, underPath, updateRows } from "./sqlite.js";

export const codexResolver: ProjectStateResolver = {
  agent: "codex",
  states: ["thread index", "rollout transcript"],
  async move(home, from, to) {
    const moved: MovedState[] = [];
    const index = join(home, "state_5.sqlite");
    const [threads = 0] = updateRows(index, [{ sql: `update threads set cwd = ${movedColumn("cwd")} where ${underPath("cwd")}`, params: pathParams(from, to) }]) ?? [];
    if (threads > 0) moved.push({ state: "thread index", files: [index], changed: threads });
    const files: string[] = [];
    let changed = 0;
    for (const f of filesUnder(join(home, "sessions"), ".jsonl")) {
      const n = await rewriteCwd(f, from, to, line => line.payload);
      if (n > 0) {
        files.push(f);
        changed += n;
      }
    }
    if (changed > 0) moved.push({ state: "rollout transcript", files, changed });
    return moved;
  },
};
