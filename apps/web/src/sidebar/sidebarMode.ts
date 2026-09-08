// SPDX-License-Identifier: AGPL-3.0-only
// Which body the sidebar draws: the list of every workspace, or Spaces, one
// workspace at a time under its own header, and which workspace that is. The
// pick is one field of the host's preferences record, so the palette, the
// section menu, the chords, the settings page and the sidebar itself read one
// value, every surface follows a toggle at once, and a browser tab on the same
// host shows the same body. The current workspace is resolved here too, since
// the shell paints its hue on a surface the sidebar does not own.
import { useMemo } from "react";
import type { SidebarMode, WorkspaceTint } from "@wsp/protocol";
import { sidebarWorkspaceOrder } from "../adapt/workspaces.js";
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

/** That rule off the one order the sidebar draws its rows in, for the callers that have no list of their own. A
 * selection that is no workspace of the list, which is what a creation in flight leaves behind, falls back to a
 * first row, so a caller ordering its own ids would land on a different workspace than the body draws. */
export function useSpaceWorkspaceId(): string | null {
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const sessions = useStore(s => s.sessions);
  const selectedId = useStore(s => s.selectedId);
  const ordered = useMemo(() => sidebarWorkspaceOrder({ workspaces, statuses, sessions }), [workspaces, statuses, sessions]);
  return spaceWorkspaceId(ordered, selectedId);
}

/** The hue the shell paints the sidebar's surface with: the current space's, and none outside Spaces mode, where the
 * hue draws on the rails alone. */
export function useSpaceTint(): WorkspaceTint | undefined {
  const [mode] = useSidebarMode();
  const current = useSpaceWorkspaceId();
  const workspaces = useStore(s => s.workspaces);
  if (mode !== "spaces") return undefined;
  return workspaces.find(w => w.id === current)?.tint;
}
