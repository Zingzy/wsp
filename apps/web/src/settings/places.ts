// SPDX-License-Identifier: AGPL-3.0-only
// Where agents run, in words: the four cells of a row, the state word that
// sits in the mono slot after a name, and the sentence the Remove dialog
// computes from what the computer holds. Every line is here rather than in the
// components, so the table, the sheets and the dialog read one rule and a test
// can put a row to it with no browser. The app says computer and provider and
// never place, machine or fork.
import { fmtBytes, fmtSize, type PlaceView } from "@wsp/protocol";
import { WHERE_WORDS } from "./format.js";
import { PROVIDER_ROWS } from "./providers.js";

/** An hourly rate at the precision the rate is quoted in. The shipped `fmtRate` rounds to cents, which reads a
 * $0.018 workspace as $0.02: a fifth of the price, on the figure somebody picks a provider by. */
export const hourlyRate = (usdPerHour: number): string => `$${usdPerHour < 0.1 ? usdPerHour.toFixed(3) : usdPerHour.toFixed(2)}/h`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a computer has been quiet, coarse on purpose: the figure says "a while", never a stopwatch. */
export function quietFor(ms: number): string {
  const held = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (held < HOUR) return `${Math.max(1, Math.floor(held / MINUTE))} m`;
  if (held < DAY) return `${Math.floor(held / HOUR)} h`;
  return `${Math.floor(held / DAY)} d`;
}

/** What a person reads a row as. A computer carries the name it reported; a provider carries the name its own row
 * in the provider table gives it, since the host words it by the id WSP_PROVIDER holds and nobody types that. */
export function placeName(place: PlaceView): string {
  if (place.kind !== "provider") return place.name;
  return PROVIDER_ROWS.find(row => row.id === place.name)?.name ?? place.name;
}

/** Whether this row is a computer that joined and is not holding its link right now. This computer and a provider
 * are never absent: one is the computer the host runs on and the other is a key, not a socket. */
export const placeIsOffline = (place: PlaceView): boolean => place.joinedAt !== undefined && place.present !== true;

/** The state word in the slot after the name: the default mark, and whether the computer is answering. Empty for a
 * row that is neither, so the slot stands at one width and a word arriving moves nothing. */
export function placeStateWord(place: PlaceView, now: number): string {
  const parts: string[] = [];
  if (place.default) parts.push(WHERE_WORDS.default);
  if (placeIsOffline(place)) parts.push(`offline · ${quietFor(now - Date.parse(place.lastSeenAt ?? place.joinedAt ?? ""))}`);
  return parts.join(" · ");
}

/** The Size cell. A provider is quoted from the smallest shape it offers, so the word reads "from"; a computer is
 * the one shape it is. The cpu word follows the kind: a provider's are virtual, a computer's are the cores it has. */
export function placeSize(place: PlaceView): string {
  if (place.shape === undefined) return "";
  const size = fmtSize(place.shape, place.kind === "provider" ? "vCPU" : "cores");
  return place.kind === "provider" ? `from ${size}` : size;
}

/** The Disk free cell: what the computer last reported it had. A provider gives each workspace its own disk, so the
 * figure is per workspace and says so. */
export function placeDiskFree(place: PlaceView): string {
  if (place.diskFreeBytes === undefined) return "";
  return place.kind === "provider" ? `${fmtBytes(place.diskFreeBytes)} each` : fmtBytes(place.diskFreeBytes);
}

/** What stands on a computer right now, as the rows that read it are given it: the workspaces by name with the
 * threads each holds, what they have run up, and the room for more where anything knows it. */
export interface PlaceHolding {
  workspaces: readonly { name: string; threads: number }[];
  /** How many workspaces this computer can hold at once, where the host knows; absent leaves the cell a tally. */
  rooms?: number;
  /** What the workspaces on it have run up, for a provider's row. */
  spentUsd?: number;
}

export const NOTHING_HELD: PlaceHolding = { workspaces: [] };

/** The Workspaces cell in its two inks: the figure, which is the tally and the room for more where the host knows
 * it, and the aside beside it, which is what the person needs to know before taking another one. */
export function placeWorkspaces(place: PlaceView, holding: PlaceHolding): { figure: string; note: string } {
  const count = holding.workspaces.length;
  if (place.kind === "provider") return { figure: `${count}`, note: place.rateUsdPerHour === undefined ? "" : hourlyRate(place.rateUsdPerHour) };
  if (placeIsOffline(place)) return { figure: `${count}`, note: WHERE_WORDS.notAnswering };
  if (place.docker === false) return { figure: `${count}`, note: WHERE_WORDS.agentsOnly };
  return { figure: holding.rooms === undefined ? `${count}` : `${count} of ${holding.rooms}`, note: "" };
}

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
  const lines: string[] = [];
  if (place.kind === "provider") {
    lines.push(count === 0 ? `The key for ${placeName(place)} is forgotten on this Mac.` : `Its ${count === 1 ? "workspace is" : `${count} workspaces are`} deleted at ${placeName(place)} and the key is forgotten on this Mac.`);
    if (count > 0) lines.push(`${count === 1 ? "Its record" : "Their records"} and ${threadWord(threads)} leave this Mac.`);
  } else {
    lines.push(count === 0 ? `wsp and ${image} come off ${placeName(place)}, which is otherwise left as it is.` : `wsp, ${image} and ${held} come off ${placeName(place)}, which is otherwise left as it is.`);
    if (count > 0) lines.push(`${count === 1 ? "The workspace's record" : "The workspaces' records"} and ${threadWord(threads)} leave this Mac.`);
  }
  // A computer that is not answering cannot be swept now, and the sentence says when it will be.
  if (placeIsOffline(place)) lines.push("It is offline; what is on it is swept the next time it connects.");
  return lines.join(" ");
}

/** The dialog's own title. */
export const removeTitle = (place: PlaceView): string => `Remove ${placeName(place)}?`;
