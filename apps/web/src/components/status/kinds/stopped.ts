// SPDX-License-Identifier: AGPL-3.0-only
import { CircleStopIcon } from "lucide-react";
import type { StatusKind } from "./kind.js";

/** The latest turn ended on a stop: nothing is asked of the person, so it keeps the row's muted ink, read or not. */
export const STOPPED: StatusKind = {
  id: "stopped",
  is: thread => thread.status === "interrupted",
  glyph: CircleStopIcon,
  word: "Stopped",
  aged: true,
};
