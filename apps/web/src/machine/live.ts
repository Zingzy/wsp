// SPDX-License-Identifier: AGPL-3.0-only
// Per-workspace utilisation that outlives any mounted pane. Samples arrive
// over the workspace's own daemon link (terminal/wiring.ts asks with sys.watch
// on every live transition and feeds the pushes here); the link's status says
// whether the newest sample is current or the last one before the socket went.
import { useSyncExternalStore } from "react";
import type { DaemonLinkStatus, SysSample } from "@wsp/protocol";

/** Two minutes at the daemon's two-second interval. */
export const LIVE_WINDOW = 60;

export interface LiveState {
  samples: SysSample[];
  reach: "live" | "unreachable";
}

export class WorkspaceLive {
  #state: LiveState = { samples: [], reach: "unreachable" };
  #fns = new Set<() => void>();

  feedSample(s: SysSample): void {
    const samples = [...this.#state.samples, s];
    if (samples.length > LIVE_WINDOW) samples.splice(0, samples.length - LIVE_WINDOW);
    this.#set({ ...this.#state, samples });
  }

  feedStatus(s: DaemonLinkStatus): void {
    const reach = s === "live" ? "live" : "unreachable";
    if (reach !== this.#state.reach) this.#set({ ...this.#state, reach });
  }

  onChange(fn: () => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  /** The same object until a sample or the reach changes. */
  snapshot(): LiveState {
    return this.#state;
  }

  #set(next: LiveState): void {
    this.#state = next;
    for (const fn of this.#fns) fn();
  }
}

const registry = new Map<string, WorkspaceLive>();

export function getLive(workspaceId: string): WorkspaceLive {
  let live = registry.get(workspaceId);
  if (!live) {
    live = new WorkspaceLive();
    registry.set(workspaceId, live);
  }
  return live;
}

/** Test isolation: forget every workspace's samples. */
export function resetLive(): void {
  registry.clear();
}

export function useWorkspaceLive(workspaceId: string): LiveState {
  return useSyncExternalStore(
    fn => getLive(workspaceId).onChange(fn),
    () => getLive(workspaceId).snapshot(),
  );
}
