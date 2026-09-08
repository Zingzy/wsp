// SPDX-License-Identifier: AGPL-3.0-only
// Which body the sidebar draws: the list of every workspace, or Spaces, one
// workspace at a time under its own header, and which workspace that is. The
// pick is this computer's, kept on the road the sidebar's width is kept on, so
// the palette, the section menu and the sidebar itself read one value and
// every surface follows a toggle at once; the current workspace is resolved
// here too, since the shell paints its hue on a surface the sidebar does not
// own.
import { useMemo } from "react";
import type { WorkspaceTint } from "@wsp/protocol";
import { sidebarWorkspaceOrder } from "../adapt/workspaces.js";
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";
import { useStore } from "../protocol/store.js";

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

/** The workspace Spaces holds: the selected one, and the first in the sidebar's order until something is selected.
 * The body and the shell's own surface both read this, so one workspace is the current one in one place. */
export function currentSpaceId(ids: ReadonlyArray<string>, selectedId: string | null): string | null {
  return selectedId !== null && ids.includes(selectedId) ? selectedId : ids[0] ?? null;
}

/** The workspace Spaces has on screen, off the one order the sidebar draws its rows in. A selection that is no
 * workspace of the list, which is what a creation in flight leaves behind, falls back to a first row, so a caller
 * ordering its own ids would fall back to a different workspace than the body draws. */
export function useCurrentSpaceId(): string | null {
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const sessions = useStore(s => s.sessions);
  const selectedId = useStore(s => s.selectedId);
  const ordered = useMemo(() => sidebarWorkspaceOrder({ workspaces, statuses, sessions }), [workspaces, statuses, sessions]);
  return currentSpaceId(ordered, selectedId);
}

/** The hue the shell paints the sidebar's surface with: the current space's, and none outside Spaces mode, where the
 * hue draws on the rails alone. */
export function useSpaceTint(): WorkspaceTint | undefined {
  const [mode] = useSidebarMode();
  const current = useCurrentSpaceId();
  const workspaces = useStore(s => s.workspaces);
  if (mode !== "spaces") return undefined;
  return workspaces.find(w => w.id === current)?.tint;
}
