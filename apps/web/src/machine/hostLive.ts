// SPDX-License-Identifier: AGPL-3.0-only
// The Live rows of the workspace that is this computer. Its figures are read
// in the host process and pushed on the socket this page already holds, so
// they arrive whether or not this computer's daemon ever started: nothing
// about cpu, memory or disk needs a port, a token or a pty. Which workspaces
// take this road is the kind table's to say, and the terminal wiring reads the
// same table before it asks a daemon for the same thing, so no workspace is
// sampled twice.
import { readingRoad, workspaceKind } from "@wsp/protocol";
import { noticeFailure } from "../notices/store.js";
import type { Api } from "../protocol/client.js";
import type { useStore } from "../protocol/store.js";
import { getLive, liveWatched, onLiveWatched } from "./live.js";

/** Keeps the host's readings flowing for every workspace whose kind reads them here while a pane draws them, and
 * stops them when the last one goes. A subscription dies with the socket that made it, so a socket that comes back
 * is asked again. */
export function wireHostLive(store: typeof useStore): () => void {
  /** The workspaces this page has asked the socket it holds now about. */
  const asked = new Set<string>();
  /** The workspaces whose refused readings have been said on the socket it holds now: each refusal comes again. */
  const said = new Set<string>();
  let offSamples: (() => void) | null = null;
  /** The transport the readings are being taken off, so a page that binds another is listened to on that one. */
  let bound: Api | null = null;

  const sync = (): void => {
    const { api, workspaces, conn } = store.getState();
    if (api?.watchSys === undefined || api.onSysSample === undefined) return;
    if (api !== bound) {
      offSamples?.();
      bound = api;
      asked.clear();
      said.clear();
      offSamples = api.onSysSample(e => getLive(e.workspaceId).feedSample(e.sample));
    }
    const here = new Set(workspaces.filter(w => readingRoad(workspaceKind(w), "metrics") === "host" && liveWatched(w.id)).map(w => w.id));
    if (conn !== "live") {
      // The readings ride this socket: one that is not live is a row whose newest figure is the last one before it went.
      for (const id of asked) getLive(id).feedReach("unreachable");
      asked.clear();
      return;
    }
    for (const id of asked) {
      if (here.has(id)) continue;
      asked.delete(id);
      getLive(id).feedReach("unreachable");
      void api.unwatchSys?.(id).catch(() => undefined);
    }
    for (const id of here) {
      if (asked.has(id)) continue;
      asked.add(id);
      void api.watchSys(id).then(
        () => getLive(id).feedReach("live"),
        (e: unknown) => {
          asked.delete(id);
          getLive(id).feedReach("unreachable");
          if (said.has(id)) return;
          said.add(id);
          const name = store.getState().workspaces.find(w => w.id === id)?.name ?? id;
          noticeFailure(e, words => `Live readings for ${name} are not coming from the host: ${words}`);
        },
      );
    }
  };

  const unsubscribe = store.subscribe(sync);
  const unwatched = onLiveWatched(sync);
  sync();
  return () => {
    unsubscribe();
    unwatched();
    offSamples?.();
    offSamples = null;
    for (const id of asked) getLive(id).feedReach("unreachable");
    asked.clear();
  };
}
