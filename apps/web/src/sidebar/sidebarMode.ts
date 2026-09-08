// SPDX-License-Identifier: AGPL-3.0-only
// Which body the sidebar draws: the list of every workspace, or Spaces, one
// workspace at a time under its own header, and which workspace that is. The
// pick is one field of the host's preferences record, so the palette, the
// section menu, the chords, the settings page and the sidebar itself read one
// value, every surface follows a toggle at once, and a browser tab on the same
// host shows the same body.
import type { SidebarMode } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";

export const otherMode = (mode: SidebarMode): SidebarMode => (mode === "spaces" ? "list" : "spaces");

export function useSidebarMode(): [SidebarMode, (mode: SidebarMode) => void] {
  const mode = useStore(s => s.preferences.sidebarMode);
  const setPreferences = useStore(s => s.setPreferences);
  return [mode, mode => void setPreferences({ sidebarMode: mode })];
}


/** The workspace Spaces has on screen: the selected one, or the first in the sidebar's order while what is
 * selected is not a workspace of it. The body and the chords that walk inside it read this one rule. */
export function spaceWorkspaceId(orderedIds: ReadonlyArray<string>, selectedId: string | null): string | null {
  return selectedId !== null && orderedIds.includes(selectedId) ? selectedId : orderedIds[0] ?? null;
}
