// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's two picks, the project and the computer its list is filtered
// to: where this window keeps them, and what the list holds under them. The
// sidebar draws that list and the jump to the next thread that needs the
// person walks it, so both read it here and neither reaches a thread the picks
// hide.
import type { PlaceView, ProjectView } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { getLocalStorageItem, type Codec } from "../hooks/useLocalStorage.js";
import { workspacesOn } from "./computerPick.js";
import { projectGroups, type ProjectGroup } from "./threadTree.js";

/** The project the list is filtered to. A view of this window alone, so it never follows a person to another one. */
export const PROJECT_PICK_KEY = "wsp:sidebar-project";
/** The computer the list is filtered to, of this window alone as the project pick is. */
export const COMPUTER_PICK_KEY = "wsp:sidebar-computer";

export const pickCodec: Codec<string | null> = {
  decode: raw => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "string") throw new Error(`Expected an id, got ${raw}.`);
    return parsed;
  },
  encode: value => JSON.stringify(value),
};

/** The picks as this window stored them, read outside the sidebar. */
export const storedPicks = (): { project: string | null; computer: string | null } => ({
  project: getLocalStorageItem(PROJECT_PICK_KEY, pickCodec),
  computer: getLocalStorageItem(COMPUTER_PICK_KEY, pickCodec),
});

/** The workspaces and projects the list holds under the stored picks, and the picks that hold: a pick for a computer
 * or a project this host no longer holds reads as every one. */
export function underPicks(
  fleet: SidebarProjectSnapshot[],
  { places, recorded, order, stored }: { places: readonly PlaceView[]; recorded: ReadonlyArray<ProjectView>; order: ReadonlyArray<string>; stored: { project: string | null; computer: string | null } },
): { projects: SidebarProjectSnapshot[]; groups: ProjectGroup[]; computer: string | null; picked: ProjectGroup | null } {
  const computer = places.some(place => place.id === stored.computer) ? stored.computer : null;
  const projects = workspacesOn(fleet, places, computer);
  const groups = projectGroups(recorded, projects, order);
  const picked = stored.project === null ? null : (groups.find(group => group.project.id === stored.project) ?? null);
  return { projects, groups, computer, picked };
}
