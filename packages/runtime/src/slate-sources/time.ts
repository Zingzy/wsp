// SPDX-License-Identifier: AGPL-3.0-only
import { json, type HostSlateSource } from "./context.js";

export const timeSource: HostSlateSource = {
  name: "time",
  view(ctx) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ctx.now));
    return json({ now: ctx.now, today, zone });
  },
};
