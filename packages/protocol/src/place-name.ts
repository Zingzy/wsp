// SPDX-License-Identifier: AGPL-3.0-only
// The name a person reads a computer by, and which computer a workspace runs
// on: the Computers pages, the sidebar's tiles and the desktop's menu bar all
// read these, so one machine is never named two ways.
import type { PlaceView, WorkspaceView } from "./index.js";
import { HERE_PLACE_ID } from "./place-word.js";
import { workspacePlaceId } from "./place-state.js";
import { providerKeyName } from "./format.js";
import { isLocalWorkspace, whereWord } from "./workspace-state.js";

/** Whether this row is the computer the host runs on: the one predicate, read by id and never by position. */
export const isHere = (place: PlaceView | undefined): boolean => place?.id === HERE_PLACE_ID;

/** Whether this row is the provider this host forks on rather than a computer somebody owns. */
export const isProviderPlace = (place: PlaceView): boolean => place.kind === "provider";

/** What a person reads a row as: the name its owner gave the computer where it keeps one, a Mac's own "zingzy's
 * MacBook Pro"; a provider carries the name its own row in the provider table gives it, since the host words it by
 * the id WSP_PROVIDER holds and nobody types that; every other computer carries the name it reported. */
export function placeName(place: PlaceView): string {
  if (place.label !== undefined) return place.label;
  if (!isProviderPlace(place)) return place.name;
  return providerKeyName(place.name);
}

/** The computer the host runs on, by its own name; empty until the places list holds that row. */
export function hereName(places: readonly PlaceView[]): string {
  const here = places.find(isHere);
  return here === undefined ? "" : placeName(here);
}

/** Which row a workspace stands on, or nothing for one this list cannot place. */
export function placeOf(places: readonly PlaceView[], workspace: Pick<WorkspaceView, "kind" | "machineId" | "place" | "provider">): PlaceView | undefined {
  const at = workspacePlaceId(workspace, places);
  return at === undefined ? undefined : places.find(p => p.id === at);
}

/** The computer or the provider a workspace runs on, by the name its own row in the places list carries, this
 * computer's included; one no row holds is named by the protocol's one word for where it is. */
export function workspaceComputerName(places: readonly PlaceView[], workspace: Parameters<typeof whereWord>[0] & Pick<WorkspaceView, "kind" | "machineId" | "place" | "provider">): string {
  const at = placeOf(places, workspace);
  if (at !== undefined) return placeName(at);
  if (isLocalWorkspace(workspace)) return hereName(places);
  // A provider's rows arrive a moment after a host restarts: until then it goes by the name its words row gives it,
  // never by the id its record holds.
  return whereWord(workspace, workspace.provider === undefined ? undefined : providerKeyName(workspace.provider));
}
