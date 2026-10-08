// SPDX-License-Identifier: AGPL-3.0-only
import { HourglassIcon } from "lucide-react";
import type { StatusKind } from "./kind.js";

/** The latest turn is held back by its computer's threads at once and starts on its own when a slot frees: nothing
 * runs yet, so no crab and no time, and the reason rides the tile's card rather than the slot. */
export const WAITING: StatusKind = {
  id: "waiting",
  is: thread => thread.status === "running" && thread.capped !== undefined,
  glyph: HourglassIcon,
  word: "Waiting",
};
