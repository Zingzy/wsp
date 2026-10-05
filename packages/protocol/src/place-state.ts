// SPDX-License-Identifier: AGPL-3.0-only
// What a place's cap is and what it counts, read off the rows the host lists
// and nowhere else. The host folds `running` at list time and the window can
// fold its own live rows through the same function, so the two cannot count
// one computer two ways. One rule per kind of place, so a third kind is one
// entry in the table below.
import { agentsLine, fmtCost, fmtDuration, fmtLimit, plural, SPEND_LIMIT_LINE } from "./format.js";
import type { CloudCap, PlaceCap, PlaceCapSet, PlaceKind, PlaceSettings, PlaceSettingsAsk, PlaceSettingWord, PlaceView, ThreadView, WorkspaceAgents, WorkspaceSize, WorkspaceView } from "./index.js";
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

/** What a workspace's switch reads as when neither it nor its place sets one, and what it takes when a person names
 * no numbers. Three machines is what one root thread's builders need and few enough that a runaway is a bill a
 * person notices, and two levels let a lead hand work to a sub-lead; threads at once and the machines cap bound cost. */
export const AGENTS_ON: WorkspaceAgents = { spawn: true, maxMachines: 3, maxDepth: 2 };

/** How long a quiet workspace runs before it naps until the person sets another window. */
export const NAP_AFTER_MS = 20 * 60_000;
/** The longest nap window a person may set: the provider's own timer is set behind ours at twice the window, and
 * six hours is the longest it has accepted. */
export const NAP_AFTER_MAX_MS = 3 * 60 * 60_000;

/** The nap window a person names in minutes: none of them never naps. */
export const napMsOf = (minutes: number): number | null => (minutes === 0 ? null : minutes * 60_000);

/** The turn limit on a cloud account until the person sets one: what a forgotten turn there can bill by the hour. A
 * computer the person owns has none by default, since TURN_IDLE_MS already ends a stuck turn and nothing there bills. */
export const TURN_WALL_MS = 6 * 60 * 60_000;

/** The longest turn limit a person may set: past a day the number is more likely minutes typed as hours than a turn
 * anyone means to run, and off is there for one that should never stop. */
export const TURN_LIMIT_MAX_MS = 24 * 60 * 60_000;

/** The turn limit a person names in hours: none of them is no limit. */
export const turnLimitMsOf = (hours: number): number | null => (hours === 0 ? null : hours * 3_600_000);

/** What a workspace runs under for one setting: its own, else its place's, else the default. Null is a value (a nap
 * that is off), so only an absent one falls through. The one chain the host's row and its idle and spawn rules read. */
export function settingFor<T>(own: T | undefined, placed: T | undefined, fallback: T): T {
  return own !== undefined ? own : placed !== undefined ? placed : fallback;
}

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

/** A dollar figure a person typed, in whole dollars where it has no cents. */
const dollars = (usd: number): string => (Number.isInteger(usd) ? `$${usd}` : fmtCost(usd));

/** One number of a cap, off the cap that holds it. */
const capNumber = (cap: PlaceCap | undefined, key: "threads" | "machines" | "spendPerDayUsd"): number | undefined =>
  cap !== undefined && key in cap ? (cap as Record<string, number>)[key] : undefined;

type SettingView = Pick<PlaceView, "cap" | "capDefault" | "napMs" | "napDefault" | "turnLimitMs" | "turnLimitDefault" | "spawn" | "spawnDefault">;
/** What a row says a setting runs at: the whole phrase, and the figure alone that a default beside it takes. */
type SettingSaid = { long: string; short: string };

/** Every setting a person can make on a place: the key it is stored under (and for a part of the agents switch, the
 * parts of it), the words a refusal names it by, and what a row says it runs at now or by default. */
const SETTINGS: Record<PlaceSettingWord, { key: keyof PlaceSettings; parts?: readonly (keyof WorkspaceAgents)[]; words: string; reads(place: SettingView, fallback: boolean): SettingSaid | undefined }> = {
  threads: { key: "threads", words: "threads at once", reads: (p, fallback) => atOnce(capNumber(fallback ? p.capDefault : p.cap, "threads"), "thread") },
  machines: { key: "machines", words: "machines at once", reads: (p, fallback) => atOnce(capNumber(fallback ? p.capDefault : p.cap, "machines"), "machine") },
  spend: {
    key: "spendPerDayUsd",
    words: "spend per day",
    reads: (p, fallback) => {
      const usd = capNumber(fallback ? p.capDefault : p.cap, "spendPerDayUsd");
      return usd === undefined ? undefined : { long: `${dollars(usd)} a day`, short: dollars(usd) };
    },
  },
  nap: {
    key: "napMs",
    words: "nap after",
    reads: (p, fallback) => {
      const ms = fallback ? p.napDefault : p.napMs;
      if (ms === undefined) return undefined;
      return ms === null ? { long: "never naps", short: "never" } : { long: `naps after ${fmtDuration(ms)}`, short: fmtDuration(ms) };
    },
  },
  "turn-limit": {
    key: "turnLimitMs",
    words: "turn limit",
    reads: (p, fallback) => {
      const ms = fallback ? p.turnLimitDefault : p.turnLimitMs;
      if (ms === undefined) return undefined;
      return ms === null ? { long: "no turn limit", short: "off" } : { long: `stops a turn at ${fmtLimit(ms)}`, short: fmtLimit(ms) };
    },
  },
  spawn: {
    key: "spawn",
    parts: ["spawn", "maxMachines"],
    words: "agents may start agents",
    reads: (p, fallback) => {
      const agents = fallback ? p.spawnDefault : p.spawn;
      if (agents === undefined) return undefined;
      return { long: agentsLine(agents), short: agents.spawn ? `on, up to ${agents.maxMachines}` : "off" };
    },
  },
  "max-depth": {
    key: "spawn",
    parts: ["maxDepth"],
    words: "levels deep",
    reads: (p, fallback) => {
      const depth = (fallback ? p.spawnDefault : p.spawn)?.maxDepth;
      return depth === undefined ? undefined : { long: `${depth} ${depth === 1 ? "level" : "levels"} deep`, short: String(depth) };
    },
  },
};

function atOnce(n: number | undefined, noun: string): SettingSaid | undefined {
  return n === undefined ? undefined : { long: `${plural(n, noun)} at once`, short: String(n) };
}

/** Whether settings, held or asked for, name one setting: its key, or any of its parts of the agents switch. */
export function placeSettingNamed(settings: PlaceSettings, word: PlaceSettingWord): boolean {
  const { key, parts } = SETTINGS[word];
  return parts === undefined ? settings[key] !== undefined : parts.some(part => settings.spawn?.[part] !== undefined);
}

/** Settings with one setting taken back to its default: its key dropped, or its parts of the agents switch, and the
 * switch with them once nothing of it is left. */
export function placeSettingDropped(settings: PlaceSettings, word: PlaceSettingWord): PlaceSettings {
  const { key, parts } = SETTINGS[word];
  const kept = Object.fromEntries(Object.entries(settings).filter(([k]) => k !== key)) as PlaceSettings;
  if (parts === undefined || settings.spawn === undefined) return kept;
  const spawn = Object.fromEntries(Object.entries(settings.spawn).filter(([part]) => !parts.includes(part as keyof WorkspaceAgents)));
  return Object.keys(spawn).length === 0 ? kept : { ...kept, spawn };
}

interface PlaceCapRule {
  /** The settings this kind takes. */
  keys: readonly PlaceSettingWord[];
  /** How long one turn runs before it is stopped where the person set no limit; null is none. */
  turnLimit: number | null;
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
    keys: ["threads", "nap", "turn-limit", "spawn", "max-depth"],
    turnLimit: null,
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
    keys: ["machines", "spend", "nap", "turn-limit", "spawn", "max-depth"],
    turnLimit: TURN_WALL_MS,
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

/** How long one turn on a place of this kind runs before the runtime stops it: what the person set there, else the
 * kind's default; null is no limit. The one reading the row and the turn's own reader both take. */
export function placeTurnLimit(kind: PlaceKind, settings: PlaceSettings): number | null {
  return settingFor(undefined, settings.turnLimitMs, PLACE_CAPS[kind].turnLimit);
}

/** Why a set is refused on this place: nothing set or reset at all, a setting its kind does not take, or one both
 * set and reset. Nothing when every key fits. */
export function placeSetRefusal(place: Pick<PlaceView, "kind" | "name" | "takesForks">, set: PlaceSettingsAsk, reset: readonly PlaceSettingWord[] = []): string | undefined {
  const takes = settingsOn(place);
  const said = (words: readonly PlaceSettingWord[]): string => andList(words.map(word => SETTINGS[word].words));
  const named = (Object.keys(SETTINGS) as PlaceSettingWord[]).filter(word => placeSettingNamed(set, word));
  if (named.length === 0 && reset.length === 0) return `nothing to set on ${place.name}: it takes ${said(takes)}`;
  const wrong = [...new Set([...named, ...reset])].filter(word => !takes.includes(word));
  if (wrong.length > 0) return `${place.name} takes ${said(takes)}, not ${said(wrong)}`;
  const both = named.filter(word => reset.includes(word));
  return both.length === 0 ? undefined : `${place.name}: ${said(both)} is both set and reset; name it once`;
}

/** The settings a place takes: its kind's, less the nap on a place that forks nothing, whose workspaces are
 * folders on the computer itself and never nap. */
function settingsOn(place: Pick<PlaceView, "kind" | "takesForks">): readonly PlaceSettingWord[] {
  return PLACE_CAPS[place.kind].keys.filter(word => placeTakes(place, word));
}

/** Whether a place takes one setting: its kind's, less the nap where it forks nothing. */
export function placeTakes(place: Pick<PlaceView, "kind" | "takesForks">, word: PlaceSettingWord): boolean {
  return PLACE_CAPS[place.kind].keys.includes(word) && (word !== "nap" || place.takesForks === true);
}

const andList = (words: readonly string[]): string => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

/** One place's settings in a line: each its kind takes at the value it runs at, and beside one the person set what
 * it reads by default. What wsp computers set answers with. */
export function placeSettingsLine(place: Pick<PlaceView, "kind" | "name" | "settings" | "takesForks"> & SettingView): string {
  const parts = settingsOn(place).flatMap(word => {
    const { reads } = SETTINGS[word];
    const now = reads(place, false);
    if (now === undefined) return [];
    if (!placeSettingNamed(place.settings ?? {}, word)) return [`${now.long} (the default)`];
    const fallback = reads(place, true);
    return [fallback === undefined ? now.long : `${now.long} (${fallback.short} by default)`];
  });
  return `${place.name}: ${parts.join(", ")}`;
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
