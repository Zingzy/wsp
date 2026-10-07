// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import type { EventUnion } from "@wsp/protocol";

// --- events -------------------------------------------------------------------

export type EventListener = (event: EventUnion) => void;

export interface EventBus {
  on(type: EventUnion["type"] | "*", listener: EventListener): () => void;
  /** The retained events after sequence `after`, oldest first, with head, the newest sequence issued (0 before any),
   * and stream, the id minted for this process's sequences. gap: `after` is not a cursor into this stream, because it
   * came with another stream id, is older than what is retained, or is past head, so nothing is replayed and the
   * caller must refetch. */
  since(after: number | undefined, stream: string | undefined): { stream: string; head: number; events: EventUnion[]; gap: boolean };
}

/** Events kept for a socket that comes back: one ring shared by every workspace, holding the status and cost ticks
 * that no transcript keeps. 5000 bounds it at one transcript's worth of memory (TRANSCRIPT_CAP); a cursor that fell
 * off it gets a gap, and the client refetches the list, the statuses and sessions.history and converges from those. */
export const EVENT_RING_CAP = 5000;
/** How often a pull request with a pending check is read while a slate watches its checks. */
export const SLATE_PR_POLL_MS = 30_000;

/** How long a machine's catalog answer stands before the binary is asked again; t3code's provider health cadence. */
export const CATALOG_TTL_MS = 5 * 60_000;
/** The probe measured 1 to 3 s on a Mac; a guest that takes longer than this is answered from the table. Under the
 * provider's 26 s exec cap, so the probe is one call and not a detached run on every fork. */
export const CATALOG_PROBE_TIMEOUT_MS = 25_000;
/** A look at the agent's command and its installer's record, which runs nothing; past this the agent is just starting. */
export const FIRST_RUN_READ_MS = 3_000;

/** How long a harness's title for a session stands before its store is read again on a refresh. Clients reload the
 * index on every session event, and a person renaming a session in the harness waits at most this long to see it. */
export const SESSION_TITLE_TTL_MS = 10_000;

/** How long a copy's checkout, once read, answers a tile or a pane asking again without asking git: every tile reads
 * it as it mounts, and a sidebar of twenty is one read, not twenty. */
export const CHECKOUT_TTL_MS = 10_000;

/** How long a pull request's page read stands for another open of it. */
export const PR_PAGE_HOLD_MS = 60_000;

/** How long a git host's rate limit refusal answers every read on the road that met it. */
export const RATE_LIMIT_HOLD_MS = 60_000;
/** A grep of one session file or a row out of one sqlite; a guest slower than this keeps the title it last gave. */
export const SESSION_TITLE_TIMEOUT_MS = 15_000;
/** How many of a workspace's harness sessions one refresh asks about, newest first: a store read is an exec on the
 * machine, and an index at SESSION_INDEX_CAP must not cost one per row. */
export const SESSION_TITLE_REFRESH_MAX = 20;
/** How long the harness has to answer the one title question a thread costs. A claude-sonnet-5 answer measured 1.4 s
 * of model time on 2026-09-07; this is the wedged case, and a thread that hits it keeps its opening words. Under the
 * provider's 26 s exec cap, so the question is one call on every thread. */
export const TITLE_MAKE_TIMEOUT_MS = 25_000;

export function eventBus(): EventBus & { emit(event: EventUnion): void } {
  const listeners = new Map<string, Set<EventListener>>();
  const ring: EventUnion[] = [];
  const stream = randomUUID();
  let head = 0;
  return {
    on(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    since(after, from) {
      if (after === undefined) return { stream, head, events: [], gap: false };
      const oldest = head - ring.length + 1;
      const foreign = from !== undefined && from !== stream;
      if (foreign || after > head || after < oldest - 1) return { stream, head, events: [], gap: true };
      return { stream, head, events: ring.slice(after - oldest + 1), gap: false };
    },
    emit(event) {
      const stamped: EventUnion = { ...event, seq: ++head };
      ring.push(stamped);
      if (ring.length > EVENT_RING_CAP) ring.splice(0, ring.length - EVENT_RING_CAP);
      for (const type of [event.type, "*"] as const) {
        for (const l of listeners.get(type) ?? []) l(stamped);
      }
    },
  };
}
