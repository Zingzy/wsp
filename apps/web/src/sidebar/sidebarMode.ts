// SPDX-License-Identifier: AGPL-3.0-only
// Which body the sidebar draws: the list of every workspace, or Spaces, one
// workspace at a time under its own header, and which workspace that is. The
// pick is this computer's, kept on the road the sidebar's width is kept on,
// so the palette, the section menu and the sidebar itself read one value and
// every surface follows a toggle at once.
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";

export type SidebarMode = "list" | "spaces";

export const SIDEBAR_MODE_KEY = "wsp:sidebar-mode";
/** The list is what the sidebar opens as until a person picks Spaces. */
export const DEFAULT_SIDEBAR_MODE: SidebarMode = "list";

const MODES: ReadonlyArray<SidebarMode> = ["list", "spaces"];

export const sidebarModeCodec: Codec<SidebarMode> = {
  decode: raw => {
    const mode = MODES.find(candidate => candidate === raw);
    if (mode === undefined) throw new Error(`Expected a sidebar mode, got ${raw}.`);
    return mode;
  },
  encode: mode => mode,
};

export const otherMode = (mode: SidebarMode): SidebarMode => (mode === "spaces" ? "list" : "spaces");

export function useSidebarMode(): [SidebarMode, (mode: SidebarMode) => void] {
  return useLocalStorage(SIDEBAR_MODE_KEY, DEFAULT_SIDEBAR_MODE, sidebarModeCodec);
}


/** The workspace Spaces has on screen: the selected one, or the first in the sidebar's order while what is
 * selected is not a workspace of it. The body and the chords that walk inside it read this one rule. */
export function spaceWorkspaceId(orderedIds: ReadonlyArray<string>, selectedId: string | null): string | null {
  return selectedId !== null && orderedIds.includes(selectedId) ? selectedId : orderedIds[0] ?? null;
}
