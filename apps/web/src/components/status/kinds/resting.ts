// SPDX-License-Identifier: AGPL-3.0-only
import type { StatusKind } from "./kind.js";

/** Every thread nobody is waiting on and nothing is running in: its age alone, in the row's muted ink. */
export const RESTING: StatusKind = {
  id: "resting",
  is: () => true,
  aged: true,
};
