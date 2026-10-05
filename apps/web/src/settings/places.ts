// SPDX-License-Identifier: AGPL-3.0-only
// What the Computers pages compute beyond the words the protocol already
// carries: the name a person reads a row as, and the sentence the Remove
// dialog computes from what the computer holds. The facts of a row, the
// state word after a name, how long a computer has been away and an hourly
// rate are all the protocol's (absentComputer, fmtSize, fmtBytes, offlineFor,
// fmtRate) and are not copied here.
import type { MarkState } from "../components/status/markState.js";
import { FREE_WORD, JOINED_COMPUTER, hereName, isHere, isProviderPlace, placeName, placeOf, absentComputer, placeDaemonBehind, awayMsOf, chargesNothing, daemonSilent, fmtBytes, fmtRate, imageCopyStaysLine, isLocalWorkspace, landsOn, namesPlace, ownDaemonDown, plural, placeWord, SETUP_WORDS, type AbsentComputer, type CpuWord, type InitSetup, type PlaceKind, type PlaceProvisionRow, type PlaceView, type ProjectView, type SealedImageCopy, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { agentName } from "@wsp/catalog";
import { PLACE_STATE_WORDS, PROVISION_OUTCOME_WORDS, WHERE_WORDS, capitalised } from "./format.js";

export { hereName, isHere, isProviderPlace, placeName, placeOf };

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
 * about the computer the host runs on alone, so a computer holding nothing gets no second sentence.
 *
 * The copy of the image is one of the things left as they are: it sits in that computer's own workspace store,
 * which no sweep walks, and only a computer that runs workspaces ever held one. The clause is the protocol's, the
 * same one the Add sheet says before any of this. */
export function removeSentence(place: PlaceView, holding: PlaceHolding, here: string, imageBytes?: number): string {
  if (here === "") return "";
  const count = holding.workspaces.length;
  const threads = heldThreads(holding);
  const held = count === 1 ? "its task" : `its ${count} tasks`;
  const name = placeName(place);
  const lines: string[] = [];
  if (isProviderPlace(place)) {
    lines.push(count === 0 ? `The key for ${name} is forgotten on ${here}.` : `Its ${count === 1 ? "task is" : `${count} tasks are`} deleted at ${name} and the key is forgotten on ${here}.`);
    if (count > 0) lines.push(`${count === 1 ? "Its record" : "Their records"} and ${threadWord(threads)} leave ${here}.`);
  } else {
    const stays = `, and ${imageCopyStaysLine(imageBytes === undefined ? undefined : fmtBytes(imageBytes))}`;
    lines.push(count === 0 ? `wsp comes off ${name}, which is otherwise left as it is${stays}.` : `wsp and ${held} come off ${name}, which is otherwise left as it is${stays}.`);
    if (count > 0) lines.push(`${count === 1 ? "The task's record" : "The tasks' records"} and ${threadWord(threads)} leave ${here}.`);
  }
  // A computer that is not answering cannot be swept now, and the sentence says when it will be.
  if (placeIsOffline(place)) lines.push("It is offline; what is on it is swept the next time it connects.");
  return lines.join(" ");
}

/** The dialog's own title. */
export const removeTitle = (place: PlaceView): string => `Remove ${placeName(place)}?`;

/** What one row of the places list is, in the words the pane's Where row says after its name. One entry per kind
 * of row, so a third kind is a row here and nowhere else. A computer of the person's own is the protocol's own
 * phrase for a joined computer, the one both the row and every sentence about it read. */
export const PLACE_KIND_WORDS: Record<PlaceKind, string> = { computer: JOINED_COMPUTER, provider: "cloud" };

/** Which wsp and daemon a computer runs, off what the host carries: its own release on the computer it runs on, and
 * the daemon each computer last reported. Nothing on a cloud, whose machines report no daemon to the places list. */
export function versionFact(place: PlaceView, hostVersion: string | undefined): string[] | undefined {
  const parts = WHERE_WORDS.runs(isHere(place) ? hostVersion : undefined, place.daemonVersion);
  return parts.length === 0 ? undefined : parts;
}

/** Whether this row is the place a word names, read the one way every reader of a place word reads it: the id the
 * wire keys it by, or the name a person types. The image record's copies and the build's own frames both carry the
 * word rather than the id, so one predicate answers for both. */
export const placeNamed = (place: PlaceView, word: string): boolean => namesPlace(place, word);

/** The first project whose workspaces land on this place, by the rule the host forks by: the project a task started
 * here is made of, and the one whose landing says what a copy there has. */
export const projectOn = (place: PlaceView, projects: readonly ProjectView[]): ProjectView | undefined => projects.find(project => landsOn(project.computer, place));

/** Whether workspaces can stand on this row at all, off the one fact the row carries: a provider and a computer
 * somebody joined both fork, and the computer the app itself runs on does not, since its local mode is the one
 * workspace it already is. */
export const placeTakesWorkspaces = (place: PlaceView): boolean => place.takesForks === true;

/** The one state of the computer a workspace stands on, while that computer is not answering; null while it is,
 * and on every workspace at a provider, which reports no link at all. The sidebar row, the
 * composer and the terminal pane all read this one reading, so the silence of one computer is not
 * worded six ways again.
 *
 * The computer the host runs on is read off its own workspace's reach rather than off the places list, which
 * holds no link for it: its daemon is a child of the host, so a daemon that is not running is the whole of what
 * this computer's silence can be, and it reads as this computer's own absence in this computer's own words. */
export function absenceOf(
  places: readonly PlaceView[],
  workspace: Pick<WorkspaceView, "kind" | "machineId" | "name" | "place"> | null,
  status: Pick<WorkspaceStatus, "reach"> | null,
  now: number | null,
): AbsentComputer | null {
  if (workspace === null) return null;
  if (isLocalWorkspace(workspace)) return ownDaemonAbsence(hereName(places) || workspace.name, status);
  const at = placeOf(places, workspace);
  return at === undefined ? null : absentOf(at, now);
}

/** The reading for the workspace that is this computer, off the reach its status carries: null before a status has
 * arrived and while the daemon answers. Behind absenceOf, which is the one door: a caller that picked this by the
 * kind itself was the third copy of one dispatch. */
function ownDaemonAbsence(here: string, status: Pick<WorkspaceStatus, "reach"> | null): AbsentComputer | null {
  return daemonSilent(status?.reach.state) ? ownDaemonDown(here) : null;
}

/** The same reading off one row of the places list, for the table that draws that row: null while the computer
 * holds its link. The one door to it, so the table and every surface that asks by workspace read one predicate
 * and compose the words once. A caller with no clock passes none and gets a reading with no figure in its line,
 * which is every caller that shows the sentence alone. */
export function absentOf(place: PlaceView, now: number | null): AbsentComputer | null {
  return placeIsOffline(place) ? absentComputer(placeName(place), now === null ? null : awayMsOf(place, now)) : null;
}

/** What a list row's state cell says: one capitalised word with its whole sentence for the hover, or the one act the
 * row offers. Read in the order a waiting thread reads its computer: blocked first, since only a person fixes it, then
 * not answering, the recipe on it, the daemon behind, an agent there that needs a sign-in, then Ready. */
export type PlaceStateCell =
  | { readonly kind: "word"; readonly word: string; readonly why?: string; readonly mark?: MarkState }
  | { readonly kind: "update"; readonly why: string }
  | { readonly kind: "sign-in"; readonly why: string };

export function placeStateCell(place: PlaceView, absent: AbsentComputer | null, { canUpdate }: { canUpdate: boolean }): PlaceStateCell {
  if (place.blocked !== undefined) return { kind: "word", word: PLACE_STATE_WORDS.blocked, why: place.blocked, mark: "failed" };
  // The setup's own words where it failed or waits on the person, before the silence, and where it runs, after it:
  // the one order wsp computers reads.
  const setup = placeWord(place, absent);
  const said = (word: string, mark: MarkState): PlaceStateCell => ({ kind: "word", word, mark, ...(setup.sentence !== undefined ? { why: setup.sentence } : {}) });
  if (setup.word === SETUP_WORDS.failed) return said(setup.word, "failed");
  if (setup.word === SETUP_WORDS.needsYou) return said(setup.word, "needs-you");
  if (absent !== null) return { kind: "word", word: capitalised(absent.away), why: absent.sentence, mark: "offline" };
  if (setup.word === SETUP_WORDS.settingUp) return said(setup.word, "working");
  const behind = placeDaemonBehind(place);
  if (behind !== undefined) return canUpdate ? { kind: "update", why: behind } : { kind: "word", word: PLACE_STATE_WORDS.behind, why: behind };
  const unsigned = Object.entries(place.signIns ?? {}).flatMap(([agent, state]) => (state === "none" ? [agentName(agent)] : []));
  if (unsigned.length > 0) return { kind: "sign-in", why: PLACE_STATE_WORDS.needsSignIn(unsigned) };
  return { kind: "word", word: PLACE_STATE_WORDS.ready, mark: "ready" };
}

/** The word for what one row of the recipe came to, or nothing for a row no job carried. A present row's note is
 * the one thing its read has to say beyond the outcome, which is a command answering from outside the directories
 * its own road links into; an installed row's note is the road's own and the row already says it installed. */
export function outcomeWord(row: PlaceProvisionRow | undefined): string | undefined {
  if (row === undefined) return undefined;
  const said = PROVISION_OUTCOME_WORDS[row.outcome];
  return row.note === undefined || row.outcome === "installed" ? said : `${said}: ${row.note}`;
}
