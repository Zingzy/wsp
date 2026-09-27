// SPDX-License-Identifier: AGPL-3.0-only
// What a place's cap is and what it counts, read off the rows the host lists
// and nowhere else. The host folds `running` at list time and the window can
// fold its own live rows through the same function, so the two cannot count
// one computer two ways. One rule per kind of place, so a third kind is one
// entry in the table below.
import { plural, SPEND_LIMIT_LINE } from "./format.js";
import type { CloudCap, PlaceCap, PlaceCapSet, PlaceKind, PlaceView, ThreadView, WorkspaceSize, WorkspaceView } from "./index.js";
import { HERE_PLACE_ID } from "./place-word.js";
import { isLocalWorkspace, workspaceState } from "./workspace-state.js";

/** Which computer a workspace stands on, by place id: a workspace forked on a joined computer carries that
 * computer's id on its record. Undefined for everything on this computer or at a provider. Written once because
 * the host asks it to know whether anything can be asked of the machine, and the app asks it to know which row of
 * the places table a workspace belongs to. */
export function workspacePlace(view: Pick<WorkspaceView, "place">): string | undefined {
  return view.place;
}

/** Which row of the places list a workspace stands on, by id: the computer its record names, this computer for a
 * workspace that is this computer, and for a fork the provider its record was stamped with. A fork written before
 * records carried that word stands at the first provider row, which is where a host that forks at one provider put
 * it. Nothing for a workspace whose row this list does not hold, a stamped fork included: a provider that has been
 * removed takes its money off the list with it, and standing its workspaces on whatever provider is left would put
 * one provider's spend on another's row.
 *
 * The one reading, so the settings table, the sidebar's rows and the host's own spend fold cannot disagree about
 * which row a workspace belongs to. */
export function workspacePlaceId(view: Pick<WorkspaceView, "kind" | "machineId" | "place" | "provider">, places: readonly Pick<PlaceView, "id" | "kind">[]): string | undefined {
  const named = workspacePlace(view);
  if (named !== undefined) return places.find(p => p.id === named)?.id;
  if (isLocalWorkspace(view)) return places.find(p => p.id === HERE_PLACE_ID)?.id ?? places[0]?.id;
  const providers = places.filter(p => p.kind === "provider");
  return view.provider === undefined ? providers[0]?.id : providers.find(p => p.id === view.provider)?.id;
}

/** The memory one running thread is given room for by default: an agent process and whatever it runs. A 4 GB box
 * held two threads and lost every turn at three; a 16 GB Mac held six and stopped answering at eight. */
export const THREAD_MEM_MB = 2560;

/** Threads at once on a computer of this shape until the person sets a number: one per THREAD_MEM_MB, rounded to
 * the nearest, at least one, and never more than its cores, since two agents on one core wait on each other. */
export const threadsAtOnce = (s: WorkspaceSize): number => Math.max(1, Math.min(Math.floor(s.cpu), Math.round(s.memMb / THREAD_MEM_MB)));

export const CLOUD_CAP_DEFAULT: CloudCap = { machines: 3, spendPerDayUsd: 10 };

/** Whether a machine in this phase holds one of its cloud's slots: a napping machine holds none and a gone one is
 * not there, while one creating or waking already does. Phase alone, so a refusal can read it without asking the
 * provider about every machine. */
export const phaseHoldsSlot = (w: Pick<WorkspaceView, "phase">): boolean => {
  const state = workspaceState({ phase: w.phase });
  return state !== "paused" && state !== "gone";
};

/** What the count reads of a workspace and of a thread. */
export type PlacedWorkspace = Pick<WorkspaceView, "id" | "kind" | "machineId" | "place" | "provider" | "phase">;
export type PlacedThread = Pick<ThreadView, "workspaceId" | "status">;

/** Every number a person can set on a place, in the words a row says it in. */
const CAP_WORDS: Record<keyof PlaceCapSet, string> = { threads: "threads at once", machines: "machines at once", spendPerDayUsd: "spend per day" };

interface PlaceCapRule {
  /** The numbers this kind takes. */
  keys: readonly (keyof PlaceCapSet)[];
  /** The set numbers over this kind's defaults; nothing where there is no default and nothing was set. */
  capOf(place: Pick<PlaceView, "shape">, set: PlaceCapSet): PlaceCap | undefined;
  /** How many at once the cap allows. */
  atOnce(cap: PlaceCap): number;
  /** What one of those is called in a sentence and a column. */
  noun: string;
  /** The spend a day stops new work at, where this kind has one. */
  spendLimit(cap: PlaceCap): number | undefined;
  /** How many of what the cap counts stand on the place, given the workspaces on it and every thread. */
  count(on: readonly PlacedWorkspace[], threads: readonly PlacedThread[]): number;
}

const PLACE_CAPS: Record<PlaceKind, PlaceCapRule> = {
  computer: {
    keys: ["threads"],
    capOf: (place, set) => {
      const threads = set.threads ?? (place.shape === undefined ? undefined : threadsAtOnce(place.shape));
      return threads === undefined ? undefined : { threads };
    },
    atOnce: cap => ("threads" in cap ? cap.threads : 0),
    noun: "thread",
    spendLimit: () => undefined,
    count: (on, threads) => {
      const ids = new Set(on.map(w => w.id));
      return threads.filter(t => t.status === "running" && ids.has(t.workspaceId)).length;
    },
  },
  provider: {
    keys: ["machines", "spendPerDayUsd"],
    capOf: (_place, set) => ({ machines: set.machines ?? CLOUD_CAP_DEFAULT.machines, spendPerDayUsd: set.spendPerDayUsd ?? CLOUD_CAP_DEFAULT.spendPerDayUsd }),
    atOnce: cap => ("machines" in cap ? cap.machines : 0),
    noun: "machine",
    spendLimit: cap => ("spendPerDayUsd" in cap ? cap.spendPerDayUsd : undefined),
    count: on => on.filter(phaseHoldsSlot).length,
  },
};

/** A place's cap: the numbers the person set over its kind's defaults. */
export function placeCapOf(place: Pick<PlaceView, "kind" | "shape">, set: PlaceCapSet = {}): PlaceCap | undefined {
  return PLACE_CAPS[place.kind].capOf(place, set);
}

/** Why a set is refused on this place: no number at all, or one its kind does not take. Nothing when every key fits. */
export function placeCapRefusal(place: Pick<PlaceView, "kind" | "name">, set: PlaceCapSet): string | undefined {
  const takes = PLACE_CAPS[place.kind].keys;
  if (Object.values(set).every(value => value === undefined)) return `nothing to set on ${place.name}: it takes ${takes.map(key => CAP_WORDS[key]).join(" and ")}`;
  const wrong = (Object.keys(CAP_WORDS) as (keyof PlaceCapSet)[]).filter(key => set[key] !== undefined && !takes.includes(key));
  if (wrong.length === 0) return undefined;
  return `${place.name} takes ${takes.map(key => CAP_WORDS[key]).join(" and ")}, not ${wrong.map(key => CAP_WORDS[key]).join(" and ")}`;
}

/** How many of what a place's cap counts run there now: threads whose latest turn is running on a workspace that
 * stands on that computer, or on a cloud the machines holding a slot there. */
export function runningOn(placeId: string, places: readonly Pick<PlaceView, "id" | "kind">[], workspaces: readonly PlacedWorkspace[], threads: readonly PlacedThread[]): number {
  const place = places.find(p => p.id === placeId);
  if (place === undefined) return 0;
  return PLACE_CAPS[place.kind].count(
    workspaces.filter(w => workspacePlaceId(w, places) === placeId),
    threads,
  );
}

/** What runs on a place against its cap, and how many more it takes under it. Nothing for a place with no cap. */
export function placeRoom(place: Pick<PlaceView, "kind" | "cap" | "running">): { running: number; atOnce: number; room: number; noun: string } | undefined {
  if (place.cap === undefined) return undefined;
  const rule = PLACE_CAPS[place.kind];
  const running = place.running ?? 0;
  const atOnce = rule.atOnce(place.cap);
  return { running, atOnce, room: Math.max(0, atOnce - running), noun: rule.noun };
}

/** The sentence a full place says: the person's number reached, else a computer that has no room for one more
 * fork under it. Nothing while there is room. */
export function placeFullLine(place: Pick<PlaceView, "kind" | "name" | "cap" | "running" | "forks">): string | undefined {
  const room = placeRoom(place);
  if (room !== undefined && room.running >= room.atOnce) return `full: ${room.running} of ${plural(room.atOnce, room.noun)} running`;
  return place.forks?.room === 0 ? `no room on ${place.name}` : undefined;
}

/** The spend a day stops new work on this place at: nothing on a kind with no spend limit or a row with no cap. */
export function placeSpendLimit(place: Pick<PlaceView, "kind" | "cap">): number | undefined {
  return place.cap === undefined ? undefined : PLACE_CAPS[place.kind].spendLimit(place.cap);
}

/** The sentence a cloud at its day's spend says. Nothing without a spend figure, which is never guessed. */
export function placeAtLimitLine(place: Pick<PlaceView, "kind" | "cap">, spentTodayUsd: number | undefined): string | undefined {
  const limit = placeSpendLimit(place);
  return limit !== undefined && spentTodayUsd !== undefined && spentTodayUsd >= limit ? SPEND_LIMIT_LINE : undefined;
}
