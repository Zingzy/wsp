// SPDX-License-Identifier: AGPL-3.0-only
import { CircleCheckIcon } from "lucide-react";
import { threadStateWord } from "@wsp/protocol";
import type { StatusKind } from "./kind.js";

/** The latest turn ended and no window has shown the thread since; opening it puts the age back. */
export const DONE: StatusKind = {
  id: "done",
  is: thread => thread.unread,
  tone: "done",
  ink: "text-status-done",
  glyph: CircleCheckIcon,
  word: threadStateWord("done"),
};
