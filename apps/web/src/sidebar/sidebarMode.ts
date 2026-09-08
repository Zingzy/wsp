// SPDX-License-Identifier: AGPL-3.0-only
// Which body the sidebar draws: the list of every workspace, or Spaces, one
// workspace at a time under its own header. The pick is one field of the
// host's preferences record, so the palette, the section menu, the settings
// page and the sidebar itself read one value, every surface follows a toggle
// at once, and a browser tab on the same host shows the same body.
import type { SidebarMode } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";

export const otherMode = (mode: SidebarMode): SidebarMode => (mode === "spaces" ? "list" : "spaces");

export function useSidebarMode(): [SidebarMode, (mode: SidebarMode) => void] {
  const mode = useStore(s => s.preferences.sidebarMode);
  const setPreferences = useStore(s => s.setPreferences);
  return [mode, mode => void setPreferences({ sidebarMode: mode })];
}
