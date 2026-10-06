// SPDX-License-Identifier: AGPL-3.0-only
import { json, type HostSlateSource } from "./context.js";

export const costSource: HostSlateSource = {
  name: "cost",
  view(ctx) {
    const facts = ctx.workspace();
    return json({ rateUsdPerHour: facts?.rateUsdPerHour ?? 0, accruedUsd: facts?.accruedUsd ?? 0 });
  },
};
