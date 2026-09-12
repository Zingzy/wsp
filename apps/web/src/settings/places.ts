// SPDX-License-Identifier: AGPL-3.0-only
// What the Where agents run section computes beyond the cells the protocol
// already words: the name a person reads a row as, and the sentence the Remove
// dialog computes from what the computer holds. The four cells of a row, the
// state word after a name, how long a computer has been away and an hourly
// rate are all the protocol's (placeStateWord, placeWorkspacesCell, fmtSize,
// fmtBytes, offlineFor, fmtRate) and are not copied here.
import { PROVIDER_KEY_WORDS, fmtBytes, hereWord, type CpuWord, type PlaceView } from "@wsp/protocol";
import { PROVIDER_ROWS } from "./providers.js";

/** What a person reads a row as. The first row is the computer the host runs on, which says so rather than giving
 * its hostname; a provider carries the name its own row in the provider table gives it, since the host words it by
 * the id WSP_PROVIDER holds and nobody types that; every other computer carries the name it reported. */
export function placeName(place: PlaceView, here = false): string {
  if (here) return hereWord(true);
  if (!isProviderPlace(place)) return place.name;
  return PROVIDER_ROWS.find(row => row.id === place.name)?.name ?? PROVIDER_KEY_WORDS[place.name]?.keyName ?? place.name;
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
