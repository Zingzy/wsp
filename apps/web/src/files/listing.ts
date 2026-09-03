// SPDX-License-Identifier: AGPL-3.0-only
// One workspace listing shared by the tree, the breadcrumb menus and the
// diff's folder picker, fetched once per workspace and again on demand. The
// last good listing stays up through a refresh or a failed one.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { fsList } from "../terminal/daemon-fs.js";
import type { TerminalWire } from "../terminal/link.js";
import { LIST_DEPTH, toProjectEntries, type ProjectEntry } from "./entries.js";
import { useDaemonWire } from "./wire.js";

/** The daemon root itself; every entry path is relative to it. */
export const ROOT = ".";

export interface ListingState {
  readonly entries: ProjectEntry[] | null;
  readonly truncated: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
}

const IDLE: ListingState = { entries: null, truncated: false, isPending: false, error: null };

class WorkspaceListing {
  #state: ListingState = IDLE;
  #fns = new Set<() => void>();
  #inFlight: Promise<void> | null = null;

  state(): ListingState {
    return this.#state;
  }

  onChange(fn: () => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  load(wire: TerminalWire): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    this.#set({ ...this.#state, isPending: true });
    this.#inFlight = fsList(wire, ROOT, { depth: LIST_DEPTH, gitignore: true })
      .then(reply => {
        this.#set({ entries: toProjectEntries(reply), truncated: reply.truncated, isPending: false, error: null });
      })
      .catch((e: unknown) => {
        this.#set({ ...this.#state, isPending: false, error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }

  #set(next: ListingState): void {
    this.#state = next;
    for (const fn of this.#fns) fn();
  }
}

const registry = new Map<string, WorkspaceListing>();

function listingFor(workspaceId: string): WorkspaceListing {
  let l = registry.get(workspaceId);
  if (!l) {
    l = new WorkspaceListing();
    registry.set(workspaceId, l);
  }
  return l;
}

/** Test isolation: forget every workspace's listing. */
export function resetListings(): void {
  registry.clear();
}

export function useWorkspaceListing(workspaceId: string): ListingState & { refresh: () => void } {
  const wire = useDaemonWire(workspaceId);
  const listing = listingFor(workspaceId);
  const state = useSyncExternalStore(
    fn => listing.onChange(fn),
    () => listing.state(),
  );
  useEffect(() => {
    if (wire && state.entries === null && !state.isPending && state.error === null) void listing.load(wire);
  }, [wire, listing, state.entries, state.isPending, state.error]);
  const refresh = useCallback(() => {
    if (wire) void listing.load(wire);
  }, [wire, listing]);
  return { ...state, refresh };
}
