// SPDX-License-Identifier: AGPL-3.0-only
// Row labels for the workspace sidebar. The adapter names the state; this file
// turns it into the words and classes a row shows. What a workspace is made of
// and what its ports are is the protocol's word table (madeOfWord, portsWord),
// read here and never respelled. Pure but for the one hook beside the where
// word, which reads that word off the store for the surfaces that hold a
// workspace's id and no snapshot.
import { HERE_PLACE_ID, isLocalWorkspace, madeOfWord, portsWord, whereWord as whereOf, workspaceKind, type Capabilities, type PlaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import type { ProjectRef } from "./threadTree.js";
import { PLACE_KIND_WORDS, hereName, isHere, placeName, placeOf } from "../settings/places.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { shortcutLabelForCommand } from "../keybindings.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { usePlaces, useStatus, useWorkspace } from "../protocol/store.js";

const NEW_THREAD_SHORTCUT = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "chat.new");
export const NEW_THREAD_TITLE = NEW_THREAD_SHORTCUT ? `New thread (${NEW_THREAD_SHORTCUT})` : "New thread";

/** What a workspace is made of, the row's second line: the word for its copy, the computer it stands on where
 * that is not the computer this window runs on (`here` names that one, whose ports a copy there shares), and what
 * the copy has for a network. Every word is the protocol's table, so this line and the command line's two cells
 * cannot say two things about one workspace. A workspace with no copy of a folder is a fork, whose line is its
 * network alone; a caller with no landing for the project has no flags to read the network off and says the copy
 * and the computer.  */
export function madeOfLine({ project, landing, computer, here }: { project: Pick<SidebarProjectSnapshot, "workspace">; landing: Pick<Capabilities, "copies" | "ownNetwork"> | null; computer: string | null; here: string }): string[] {
  const copy = project.workspace.copy;
  const on = computer ?? here;
  return [
    copy === undefined ? undefined : madeOfWord(copy.road),
    computer ?? undefined,
    landing === null || on === "" ? undefined : portsWord(landing, project.workspace.portBase, on) || undefined,
  ].filter((part): part is string => part !== undefined);
}

/** The branch the agent is working on, off the record the copy was made with; empty where the record carries
 * none, which is a workspace whose copy was made with no branch of its own. */
export function branchLine(project: Pick<SidebarProjectSnapshot, "workspace">): string {
  return project.workspace.copy?.branch ?? "";
}

/** The fuller reading of computerName, for the pane that has a whole row for it: the name, then what that row is.
 * The computer the host runs on gets its name alone, being the one row a person needs no kind word for. */
export function whereRuns(places: readonly PlaceView[], project: Pick<SidebarProjectSnapshot, "status" | "workspace">): string {
  const at = placeOf(places, liveRecord(project));
  const name = computerName(places, project);
  return at === undefined || isHere(at) ? name : `${name} (${PLACE_KIND_WORDS[at.kind]})`;
}

/** The workspace's record as the live status has it once one has arrived, kind read off the record. */
const liveRecord = (project: Pick<SidebarProjectSnapshot, "status" | "workspace">) => ({ ...(project.status ?? project.workspace), kind: workspaceKind(project.workspace) });

/** The computer or the provider a workspace runs on, by the name its own row in the places list carries, the
 * computer the host runs on included: a person waiting on a machine is waiting on the name their own list shows,
 * never on a machine id or on the kind's word. A workspace this host holds no row for is named through the
 * protocol's one reading of the question, off the live record once a status has arrived, so this row, the command
 * line's table and the pane cannot name one machine three ways. */
export function computerName(places: readonly PlaceView[], project: Pick<SidebarProjectSnapshot, "status" | "workspace">): string {
  const live = liveRecord(project);
  const at = placeOf(places, live);
  if (at !== undefined) return placeName(at);
  if (isLocalWorkspace(live)) return hereName(places);
  return whereOf(live);
}

/** The same name off the store for a surface that holds the workspace's id and no snapshot, and the id itself
 * until the record has arrived, which is what a window opened straight onto a workspace has for the first frames. */
export function useComputerName(workspaceId: string): string {
  const places = usePlaces();
  const workspace = useWorkspace(workspaceId);
  const status = useStatus(workspaceId);
  return workspace === null ? workspaceId : computerName(places, { workspace, status });
}

/** The computer a project lives on, as the switcher and a project row name it: nothing for a project on the
 * computer this window runs on, which every row would otherwise carry, and the name this host has for the computer
 * otherwise, through the protocol's one rule for the question. */
export function projectComputerWord(project: Pick<ProjectRef, "computer">, named: ReadonlyMap<string, string>): string | null {
  if (project.computer === undefined || project.computer === HERE_PLACE_ID) return null;
  return named.get(project.computer) ?? project.computer;
}

/** Every computer this host holds by the name a person reads it as, keyed by its id, which is what a project record
 * names its computer by. */
export function placeNames(places: readonly PlaceView[]): ReadonlyMap<string, string> {
  return new Map(places.map(place => [place.id, placeName(place)]));
}

/** t3code's row label: "just now" reads "now", "3m ago" reads "3m". */
export function compactTimeLabel(iso: string | null): string {
  if (iso === null) return "";
  const label = formatRelativeTimeLabel(iso);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

