// SPDX-License-Identifier: AGPL-3.0-only
import type { HostSlateSource } from "./context.js";

export const stateSource: HostSlateSource = {
  name: "state",
  view: ctx => ctx.state,
};
