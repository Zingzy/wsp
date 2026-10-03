// SPDX-License-Identifier: AGPL-3.0-only
import { useSelectedWorkspaceId } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { workspaceOrHere } from "../terminal/computer.js";
import { TimelineRuleLine } from "../components/chat/TimelineRuleLine.js";

/** The one quiet line under a turn the agent wrote the slate in (decision 11); pressing it opens the tab. */
export function SlateUpdatedLine() {
  const workspaceId = useSelectedWorkspaceId();
  return (
    <button
      type="button"
      data-slate-updated
      className="mt-1 block rounded-md text-left outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&:hover_span]:text-foreground"
      onClick={() => useRightPanelStore.getState().open(workspaceOrHere(workspaceId), "slate")}
    >
      <TimelineRuleLine line="Updated the slate" />
    </button>
  );
}
