// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rewriteCwd, type MovedState, type ProjectStateResolver } from "./resolver.js";
import { inTransaction, movedColumn, pathParams, runUpdate, underPath } from "./sqlite.js";

const SESSIONS = "/sessions/";

/** The rollout under this home: rollout_path is absolute on the machine that wrote it, so only its tail past sessions/ carries over. */
function rolloutUnder(home: string, recorded: string): string | undefined {
  const i = recorded.lastIndexOf(SESSIONS);
  return i < 0 ? undefined : join(home, "sessions", recorded.slice(i + SESSIONS.length));
}

export const codexResolver: ProjectStateResolver = {
  agent: "codex",
  states: ["thread index", "rollout transcript"],
  async move(home, from, to) {
    const moved: MovedState[] = [];
    const index = join(home, "state_5.sqlite");
    const params = pathParams(from, to);
    const indexed = inTransaction(index, d => {
      const rollouts = d.prepare(`select rollout_path from threads where ${underPath("cwd")} order by rollout_path`).all({ $from: from }).map(r => String(r.rollout_path));
      const threads = runUpdate(d, { sql: `update threads set cwd = ${movedColumn("cwd")} where ${underPath("cwd")}`, params });
      return { rollouts, threads };
    });
    if (indexed === undefined) return moved;
    if (indexed.threads > 0) moved.push({ state: "thread index", files: [index], changed: indexed.threads });
    const files: string[] = [];
    let changed = 0;
    for (const f of new Set(indexed.rollouts.map(r => rolloutUnder(home, r)).filter((f): f is string => f !== undefined && existsSync(f)))) {
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
