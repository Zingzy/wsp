// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AgentSignInState,
  PlaceEvent,
} from "@wsp/protocol";
import type { MachineBackend } from "@wsp/engine";
import type { DeviceDoor } from "../devices.js";
import type { Store } from "../store.js";
import type { PlaceRecord, PlaceWiring, PlaceRecording, PlaceDoorOptions, PlaceDoor } from "./types.js";
import { signInsOf, SEEN_EVERY_MS, type Live, type Forward, LINK_FRAME_MS, RELINK_WAIT_MS, DIAL_MS } from "./helpers.js";

/** What every area of the place door reads: the options it was made with and what the whole door shares. */
export interface PlaceDoorContext {
  opts: PlaceDoorOptions;
  store: Store;
  devices: DeviceDoor;
  wiring: PlaceWiring;
  recording: PlaceRecording;
  clockNow: () => number;
  seenEveryMs: number;
  dialWaitMs: number;
  frameWaitMs: number;
  relinkWaitMs: number;
  live: Map<string, Live>;
  kept: Map<string, PlaceRecord>;
  signInsHere: (placeId: string) => Record<string, AgentSignInState> | undefined;
  backends: Map<string, MachineBackend>;
  forwards: Map<string, Forward>;
  schedule: (fn: () => void, ms: number) => () => void;
  asking: Map<string, Promise<MachineBackend>>;
  watchers: Set<(e: PlaceEvent) => void>;
  emit: (e: PlaceEvent) => void;
  /** Set once every area is built, so an area reads it inside a call and never while it is being built. */
  door: PlaceDoor;
}

export function placeDoorContext(opts: PlaceDoorOptions): PlaceDoorContext {
  const { store, devices, wiring, recording } = opts;
  const clockNow = opts.now ?? Date.now;
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const seenEveryMs = opts.seenEveryMs ?? SEEN_EVERY_MS;
  const dialWaitMs = opts.dialWaitMs ?? DIAL_MS;
  const frameWaitMs = opts.frameWaitMs ?? LINK_FRAME_MS;
  const relinkWaitMs = opts.relinkWaitMs ?? RELINK_WAIT_MS;
  const live = new Map<string, Live>();
  /** The records as they stand, by id: `load` fills it and every write below keeps it, so the one road that must
   * answer without waiting (which backend a fork's record stands on) can. */
  const kept = new Map<string, PlaceRecord>();
  /** What stands for each agent on that computer as its last report and this host's vault say, the one read the
   * agent row and the setup's sign-ins both take. */
  const signInsHere = (placeId: string): Record<string, AgentSignInState> | undefined => {
    const record = kept.get(placeId);
    return record === undefined ? undefined : signInsOf(record.report, opts.vault?.() ?? {}, record.applied?.rows);
  };
  /** The backend each place offers, built once from what that place said about it and swapped when it says
   * something else; the link under it is the door's, so the same object serves a place that comes and goes. */
  const backends = new Map<string, MachineBackend>();
  const forwards = new Map<string, Forward>();
  /** The read of one place's backend facts that is in flight, so two roads asking at once send one frame. */
  const asking = new Map<string, Promise<MachineBackend>>();
  const watchers = new Set<(e: PlaceEvent) => void>();
  const emit = (e: PlaceEvent): void => {
    for (const fn of watchers) fn(e);
  };
  return {
    opts, store, devices, wiring, recording, clockNow, schedule, seenEveryMs, dialWaitMs, frameWaitMs, relinkWaitMs, live, kept,
    signInsHere, backends, forwards, asking, watchers, emit, door: undefined as unknown as PlaceDoor,
  };
}
