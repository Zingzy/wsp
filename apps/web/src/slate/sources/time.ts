// SPDX-License-Identifier: AGPL-3.0-only
import { walk } from "../paths.js";
import type { SourceModule } from "./source.js";

/** The clock: the binder ticks it once a second while a drawn piece reads time.now, else every 30 s. */
export const time: SourceModule = {
  name: "time",
  input: ctx => ctx.now,
  select(steps, ctx) {
    const at = new Date(ctx.now);
    const today = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    return walk({ now: ctx.now, today, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }, steps);
  },
};
