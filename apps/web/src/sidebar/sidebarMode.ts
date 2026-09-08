// SPDX-License-Identifier: AGPL-3.0-only
// Which body the sidebar draws: the list of every workspace, or Spaces, one
// workspace at a time under its own header. The pick is this computer's, kept
// on the road the sidebar's width is kept on, so the palette, the section
// menu and the sidebar itself read one value and every surface follows a
// toggle at once.
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
