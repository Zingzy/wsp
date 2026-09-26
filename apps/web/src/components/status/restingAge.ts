// SPDX-License-Identifier: AGPL-3.0-only
import type { SidebarThreadSnapshot } from "../../adapt/index.js";
import { resolveSettledTimestamp } from "../../sidebar/Sidebar.logic.js";
import { compactTimeLabel } from "../../sidebar/workspaceRows.js";

/** How long ago a thread last settled, the age a resting thread's status slot shows outside the sidebar. */
export function restingAge(thread: Pick<SidebarThreadSnapshot, "startedAt" | "endedAt">): string {
  return compactTimeLabel(resolveSettledTimestamp(thread));
}
