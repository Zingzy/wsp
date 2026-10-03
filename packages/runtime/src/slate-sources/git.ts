// SPDX-License-Identifier: AGPL-3.0-only
import { json, type HostSlateSource } from "./context.js";

export const gitSource: HostSlateSource = {
  name: "git",
  view(ctx) {
    const c = ctx.workspace()?.checkout;
    if (c === undefined) return undefined;
    return json({
      branch: c.branch,
      head: c.head ?? null,
      ahead: c.ahead,
      behind: c.behind,
      changed: c.changed,
      stashes: c.stashes ?? 0,
      editsUnread: c.editsUnread ?? false,
      countsUnknown: c.countsUnknown ?? false,
      readAt: c.readAt,
    });
  },
};
