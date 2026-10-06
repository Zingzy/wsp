// SPDX-License-Identifier: AGPL-3.0-only
import { GaugeIcon } from "lucide-react";
import { LIMIT_WORDS } from "@wsp/protocol";
import type { StatusKind } from "./kind.js";

/** The latest turn stopped at the agent's usage limit and nobody has armed the resume: the person is the only one
 * who can move it, so it reads in the ink the Usage page gives a reached limit and files under Needs you. */
export const LIMITED: StatusKind = {
  id: "limited",
  is: thread => thread.status === "failed" && (thread.limit ?? null) !== null && (thread.resumeAt ?? null) === null,
  tone: "limited",
  ink: "text-warning-foreground",
  glyph: GaugeIcon,
  word: LIMIT_WORDS.tile,
};
