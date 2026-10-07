// SPDX-License-Identifier: AGPL-3.0-only
import { HourglassIcon } from "lucide-react";
import { resetsWord } from "@wsp/protocol";
import type { StatusKind } from "./kind.js";

/** Resume at reset is armed: the turn goes on at the reset the slot words as the Usage page does, and nothing is asked of the person, so the
 * slot keeps the row's own ink and the title recedes as a working row's does. */
export const RESUMING: StatusKind = {
  id: "resuming",
  is: thread => thread.status === "failed" && (thread.limit ?? null) !== null && (thread.resumeAt ?? null) !== null,
  glyph: HourglassIcon,
  wordOf: (thread, now) => resetsWord(thread.resumeAt ?? 0, now),
};
