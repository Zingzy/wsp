// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID, landsOn, type PlaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/view-model.js";
import { placeOf } from "../settings/places.js";
import type { ProjectGroup } from "./threadTree.js";

/** The workspaces standing on the picked computer, or every workspace while none is picked. */
export function workspacesOn(rows: SidebarProjectSnapshot[], places: readonly PlaceView[], placeId: string | null): SidebarProjectSnapshot[] {
  return placeId === null ? rows : rows.filter(row => placeOf(places, row.workspace)?.id === placeId);
}

/** The projects a computer pick keeps: the ones that live on it, and the ones with a workspace on it. */
export function groupsOn(groups: ProjectGroup[], places: readonly PlaceView[], placeId: string | null): ProjectGroup[] {
  const place = places.find(p => p.id === placeId);
  return place === undefined ? groups : groups.filter(group => landsOn(group.project.computer ?? HERE_PLACE_ID, place) || group.workspaces.length > 0);
}
