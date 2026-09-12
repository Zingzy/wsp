// SPDX-License-Identifier: AGPL-3.0-only
// What the Where agents run section computes beyond the cells the protocol
// already words: the name a person reads a row as, and the sentence the Remove
// dialog computes from what the computer holds. The four cells of a row, the
// state word after a name, how long a computer has been away and an hourly
// rate are all the protocol's (absentComputer, placeWorkspacesCell, fmtSize,
// fmtBytes, offlineFor, fmtRate) and are not copied here.
//
// The New workspace dialog's Where control reads its rows and its caption from
// the bottom of this file rather than wording a second set of place facts.
import { FREE_WORD, JOINED_COMPUTER, absentComputer, awayMsOf, daemonSilent, fmtBytes, fmtRate, hereWord, isLocalWorkspace, ownDaemonDown, plural, thisComputer, workspacePlace, type AbsentComputer, type CpuWord, type PlaceKind, type PlaceView, type SealedImageCopy, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { PROVIDER_ROWS } from "./providers.js";

/** What a person reads a row as. The first row is the computer the host runs on, which says so rather than giving
 * its hostname; a provider carries the name its own row in the provider table gives it, since the host words it by
 * the id WSP_PROVIDER holds and nobody types that; every other computer carries the name it reported. */
export function placeName(place: PlaceView, here = false): string {
  if (here) return hereWord(true);
  if (!isProviderPlace(place)) return place.name;
  return PROVIDER_ROWS.find(row => row.id === place.name)?.name ?? place.name;
}

/** Whether this row is the provider this host forks on rather than a computer somebody owns. The one reading, so a
 * third kind of row is a change here and at placeCpuWord and nowhere else. */
export const isProviderPlace = (place: PlaceView): boolean => place.kind === "provider";

/** What one of this row's cpus is called: a provider's are virtual and a computer's are the cores it has. */
export const placeCpuWord = (place: PlaceView): CpuWord => (isProviderPlace(place) ? "vCPU" : "cores");

/** Whether this row is a computer that is not holding its link right now, read the one way the protocol's own state
 * word reads it. This computer and a provider are never absent: one is the computer the host runs on and the other
 * is a key, not a socket, so neither reports a link at all. */
export const placeIsOffline = (place: PlaceView): boolean => place.present === false;

/** What stands on a computer right now, as the Remove dialog is given it: the workspaces by name, the state word
 * each is in and the threads each holds. The table's Workspaces cell asks a smaller question and reads the
 * protocol's own rule off the row. */
export interface PlaceHolding {
  workspaces: readonly { name: string; state: string; threads: number }[];
}

export const NOTHING_HELD: PlaceHolding = { workspaces: [] };

/** How many threads stand on a computer, over every workspace it holds. */
export const heldThreads = (holding: PlaceHolding): number => holding.workspaces.reduce((sum, w) => sum + w.threads, 0);

/** How many threads, with the noun the count takes. */
export const threadWord = (n: number): string => `${n} ${n === 1 ? "thread" : "threads"}`;

/** What a remove takes, computed from what the computer holds. A computer keeps its own files and is left as it
 * was; a provider's workspaces are deleted where they stand and its key is forgotten here. The second sentence is
 * about this Mac alone, so a computer holding nothing gets no second sentence. */
export function removeSentence(place: PlaceView, holding: PlaceHolding, imageBytes?: number): string {
  const count = holding.workspaces.length;
  const threads = heldThreads(holding);
  const image = imageBytes === undefined ? "your image" : `your image (${fmtBytes(imageBytes)})`;
  const held = count === 1 ? "its workspace" : `its ${count} workspaces`;
  const name = placeName(place);
  const lines: string[] = [];
  if (isProviderPlace(place)) {
    lines.push(count === 0 ? `The key for ${name} is forgotten on this Mac.` : `Its ${count === 1 ? "workspace is" : `${count} workspaces are`} deleted at ${name} and the key is forgotten on this Mac.`);
    if (count > 0) lines.push(`${count === 1 ? "Its record" : "Their records"} and ${threadWord(threads)} leave this Mac.`);
  } else {
    lines.push(count === 0 ? `wsp and ${image} come off ${name}, which is otherwise left as it is.` : `wsp, ${image} and ${held} come off ${name}, which is otherwise left as it is.`);
    if (count > 0) lines.push(`${count === 1 ? "The workspace's record" : "The workspaces' records"} and ${threadWord(threads)} leave this Mac.`);
  }
  // A computer that is not answering cannot be swept now, and the sentence says when it will be.
  if (placeIsOffline(place)) lines.push("It is offline; what is on it is swept the next time it connects.");
  return lines.join(" ");
}

/** The dialog's own title. */
export const removeTitle = (place: PlaceView): string => `Remove ${placeName(place)}?`;

/** What this computer is called inside a sentence. One home for the word, so the day the app is told which
 * platform it runs on, the Mac's word becomes the platform's in one edit rather than in every sentence that says
 * it. The places table's first column says it capitalised, as a name in a column (hereWord); everything that says
 * it mid-sentence reads this. */
export const THIS_COMPUTER_WORD = thisComputer("darwin");

/** What one row of the places list is, in the words the pane's Where row says after its name. One entry per kind
 * of row, so a third kind is a row here and nowhere else. A computer of the person's own is the protocol's own
 * phrase for a joined computer, the one both the row and every sentence about it read. */
export const PLACE_KIND_WORDS: Record<PlaceKind, string> = { computer: JOINED_COMPUTER, provider: "a provider" };

/** Whether this row is the place a word names, read the one way every reader of a place word reads it: the id the
 * wire keys it by, or the name a person types. The image record's copies and the build's own frames both carry the
 * word rather than the id, so one predicate answers for both. */
export const placeNamed = (place: PlaceView, word: string): boolean => word === place.id || word === place.name;

/** Whether workspaces of their own can stand on this row at all: a provider forks by definition, and a computer
 * does once it has said it runs Docker. A computer that runs agents alone holds the one workspace it already is,
 * so it is never offered as somewhere to put another. */
export const placeTakesWorkspaces = (place: PlaceView): boolean => isProviderPlace(place) || place.docker === true;

/** Which row a workspace stands on, or nothing for one this list cannot place. The id a joined computer's machine
 * carries names its row; what runs on this computer is the first row, which is the computer the host runs on; and
 * anything else was forked at the provider. The one reading, so the pane's Where row and the table's own holdings
 * cannot disagree about which computer a workspace is on. */
export function placeOf(places: readonly PlaceView[], workspace: Pick<WorkspaceView, "kind" | "machineId" | "place">): PlaceView | undefined {
  const named = workspacePlace(workspace);
  if (named !== undefined) return places.find(p => p.id === named);
  if (isLocalWorkspace(workspace)) return places[0];
  return places.find(isProviderPlace);
}

/** The one state of the computer a workspace stands on, while that computer is not answering; null while it is,
 * and on every workspace at a provider, which reports no link at all. The sidebar row, the Workspace panel, the
 * composer and the terminal and processes panes all read this one reading, so the silence of one computer is not
 * worded six ways again.
 *
 * The computer the host runs on is read off its own workspace's reach rather than off the places list, which
 * holds no link for it: its daemon is a child of the host, so a daemon that is not running is the whole of what
 * this computer's silence can be, and it reads as this computer's own absence in this computer's own words. */
export function absenceOf(
  places: readonly PlaceView[],
  workspace: Pick<WorkspaceView, "kind" | "machineId" | "place"> | null,
  status: Pick<WorkspaceStatus, "reach"> | null,
  now: number | null,
): AbsentComputer | null {
  if (workspace === null) return null;
  if (isLocalWorkspace(workspace)) return ownDaemonAbsence(status);
  const at = placeOf(places, workspace);
  return at === undefined ? null : absentOf(at, now);
}

/** The reading for the workspace that is this computer, off the reach its status carries: null before a status has
 * arrived and while the daemon answers. Behind absenceOf, which is the one door: a caller that picked this by the
 * kind itself was the third copy of one dispatch. */
function ownDaemonAbsence(status: Pick<WorkspaceStatus, "reach"> | null): AbsentComputer | null {
  return daemonSilent(status?.reach.state) ? ownDaemonDown(THIS_COMPUTER_WORD) : null;
}

/** The same reading off one row of the places list, for the table that draws that row: null while the computer
 * holds its link. The one door to it, so the table and every surface that asks by workspace read one predicate
 * and compose the words once. A caller with no clock passes none and gets a reading with no figure in its line,
 * which is every caller that shows the sentence alone. */
export function absentOf(place: PlaceView, now: number | null, here = false): AbsentComputer | null {
  return placeIsOffline(place) ? absentComputer(placeName(place, here), now === null ? null : awayMsOf(place, now)) : null;
}

/** How many workspaces stand on each row, by the id of the row: every workspace the app holds goes to exactly one
 * row through placeOf, which is this computer's own workspace on the first row, a fork at the provider it was made
 * at, and the one workspace a joined computer is. Keyed by id rather than counted per row, so the whole table is
 * one walk of the list. A row nothing stands on is not in the record and reads as none. */
export function placeWorkspaceCounts(places: readonly PlaceView[], workspaces: readonly Pick<WorkspaceView, "kind" | "machineId">[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const workspace of workspaces) {
    const place = placeOf(places, workspace);
    if (place !== undefined) counts[place.id] = (counts[place.id] ?? 0) + 1;
  }
  return counts;
}

/** The rows the New workspace dialog offers as somewhere to put one, in the list's own order. The computer the host
 * runs on is never among them: it is already the one workspace it can be. */
export const whereSegments = (places: readonly PlaceView[]): PlaceView[] => places.filter((place, at) => at !== 0 && placeTakesWorkspaces(place));

/** The words the Where control says about the row a person has picked, and the two notes it says instead when
 * there is no row to pick. Each clause is a fact of the place; what joins them is the caption below. */
export const WHERE_PICK_WORDS = {
  label: "Where",
  /** What a workspace on a computer of the person's own costs them: nothing, which is the point of having one. */
  free: FREE_WORD,
  whileAwake: "while awake",
  napsToZero: "naps to $0",
  room: (n: number): string => `room for ${plural(n, "workspace")}`,
  /** The room clause when there is none left, and what to do about it. */
  full: (n: number): string => `${n} of ${plural(n, "workspace")}`,
  fullFix: "pause or delete one there",
  /** How long the first workspace there takes, which is the image being built before it. */
  firstBuild: "builds your image there first, about 4 min",
  imageThere: (version: number): string => `your image is there, v${version}`,
  /** The dialog with nowhere to put a workspace: what is missing, and what to do about it. */
  nowhereYet: "Nowhere to put a new workspace yet.",
  addOne: "Add a computer you own or connect a provider, and workspaces can be created there.",
  /** Why Create is held with no name typed. */
  nameFirst: "give the workspace a name",
} as const;

/** The one caption line under the Where control, built from the facts the row itself carries: what a workspace
 * there costs, how much room is left on it, and whether the image is there already or is built first. A fact the
 * row has not reported is left out rather than guessed, so a caption says only what this host knows.
 *
 * Every figure is the protocol's own formatter (fmtRate, plural), never a second spelling of one. */
export function whereCaption(place: PlaceView, copy: SealedImageCopy | undefined): string {
  const cost = place.rateUsdPerHour === undefined ? [WHERE_PICK_WORDS.free] : [`${fmtRate(place.rateUsdPerHour)} ${WHERE_PICK_WORDS.whileAwake}`, WHERE_PICK_WORDS.napsToZero];
  const forks = place.forks;
  // A row with no room left ends on what to do about it: where the image stands is no longer the question, since
  // nothing can be created there until a workspace goes.
  if (forks !== undefined && forks.room === 0) return [...cost, WHERE_PICK_WORDS.full(forks.running), WHERE_PICK_WORDS.fullFix].join(" · ");
  const room = forks === undefined ? [] : [WHERE_PICK_WORDS.room(forks.room)];
  const image = copy === undefined ? WHERE_PICK_WORDS.firstBuild : WHERE_PICK_WORDS.imageThere(copy.version);
  return [...cost, ...room, image].join(" · ");
}

/** Whether a row is out of room for another workspace, which holds Create with the caption as its reason. A row
 * that has not said what it forks with is not refused: nothing here knows it is full. */
export const placeIsFull = (place: PlaceView): boolean => place.forks !== undefined && place.forks.room === 0;
