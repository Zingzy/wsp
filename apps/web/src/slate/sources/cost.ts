// SPDX-License-Identifier: AGPL-3.0-only
import { walk } from "../paths.js";
import type { SourceModule } from "./source.js";

/** The thread's workspace's spend, as workspace.cost pushes it. */
export const cost: SourceModule = {
  name: "cost",
  input: ctx => (ctx.workspaceId === null ? null : ctx.app.costs[ctx.workspaceId]),
  select(steps, ctx) {
    const tick = ctx.workspaceId === null ? undefined : ctx.app.costs[ctx.workspaceId];
    return tick === undefined ? undefined : walk({ rateUsdPerHour: tick.rateUsdPerHour, accruedUsd: tick.accruedUsd }, steps);
  },
};
