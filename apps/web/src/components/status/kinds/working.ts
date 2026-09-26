// SPDX-License-Identifier: AGPL-3.0-only
import { threadStateWord } from "@wsp/protocol";
import { isThreadWorking } from "../../../sidebar/Sidebar.logic.js";
import type { StatusKind } from "./kind.js";

export const WORKING: StatusKind = {
  id: "working",
  is: isThreadWorking,
  tone: "working",
  ink: "text-status-working",
  word: threadStateWord("running"),
  timed: true,
  crab: true,
};
