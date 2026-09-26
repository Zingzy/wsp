// SPDX-License-Identifier: AGPL-3.0-only
import { CircleAlertIcon } from "lucide-react";
import { threadStateWord } from "@wsp/protocol";
import { resolveSidebarThreadStatus } from "../../../sidebar/Sidebar.logic.js";
import type { StatusKind } from "./kind.js";

export const FAILED: StatusKind = {
  id: "failed",
  is: thread => resolveSidebarThreadStatus(thread) === "failed",
  tone: "failed",
  ink: "text-status-failed",
  glyph: CircleAlertIcon,
  word: threadStateWord("failed"),
};
