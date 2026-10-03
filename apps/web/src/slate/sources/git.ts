// SPDX-License-Identifier: AGPL-3.0-only
import { walk } from "../paths.js";
import { ASK_HOST, type SourceModule } from "./source.js";

/** The thread's checkout as the workspace's status carries it; the entries list is the host's to read. */
export const git: SourceModule = {
  name: "git",
  held: true,
  input: ctx => (ctx.workspaceId === null ? null : ctx.app.statuses[ctx.workspaceId]?.checkout ?? null),
  select(steps, ctx) {
    if (steps[0] === "status") return ASK_HOST;
    const status = ctx.workspaceId === null ? undefined : ctx.app.statuses[ctx.workspaceId];
    if (status === undefined) return ASK_HOST;
    const c = status.checkout;
    if (c === undefined) return ASK_HOST;
    return walk(
      {
        branch: c.branch,
        head: c.head ?? null,
        ahead: c.ahead,
        behind: c.behind,
        changed: c.changed,
        stashes: c.stashes ?? 0,
        editsUnread: c.editsUnread ?? false,
        countsUnknown: c.countsUnknown ?? false,
        readAt: c.readAt,
      },
      steps,
    );
  },
};
