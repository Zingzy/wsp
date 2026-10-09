// SPDX-License-Identifier: AGPL-3.0-only
// A finished thread a window or its lead has read, inside a Finished fold: Done's check in the row's own ink, so
// every row of the fold ends in the same mark and green stays for the unread. Never in the registry, since the fold,
// not the thread, decides it.
import { CircleCheckIcon } from "lucide-react";
import { threadStateWord } from "@wsp/protocol";
import type { StatusKind } from "./kind.js";

export const FINISHED: StatusKind = {
  id: "finished",
  is: () => false,
  glyph: CircleCheckIcon,
  word: threadStateWord("done"),
  aged: true,
};
