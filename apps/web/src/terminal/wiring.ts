// SPDX-License-Identifier: AGPL-3.0-only
// Fills the terminal registry from the store: one WorkspaceTerminals per
// workspace for as long as it exists, one daemon link while it runs. A
// napping workspace keeps its model (tabs, scrollback mirror) with the socket
// down; wake dials again and the model re-attaches its ptys. The same link
// is the browser's only source of ports: the daemon pushes port events only
// to sockets that asked with ports.watch, and a subscription dies with its
// socket, so every live transition asks again.
import { getBrowser } from "../browser/model.js";
import type { useStore } from "../protocol/store.js";
import { connectDaemonLink, type DaemonLink, type DaemonLinkOptions } from "./daemon-link.js";
import { provideTerminals, WorkspaceTerminals } from "./link.js";

export type WiringOptions = Pick<DaemonLinkOptions, "WebSocketCtor" | "heartbeatMs" | "backoffMs">;

interface Wired {
  wt: WorkspaceTerminals;
  link: DaemonLink | null;
}

export function wireTerminals(store: typeof useStore, opts: WiringOptions = {}): () => void {
  const wired = new Map<string, Wired>();

  const unlink = (entry: Wired): void => {
    entry.link?.close();
    entry.link = null;
  };

  const sync = (): void => {
    const { api, workspaces } = store.getState();
    if (!api) return;
    const seen = new Set<string>();
    for (const w of workspaces) {
      seen.add(w.id);
      let entry = wired.get(w.id);
      if (!entry) {
        const fresh: Wired = { link: null, wt: undefined as unknown as WorkspaceTerminals };
        fresh.wt = new WorkspaceTerminals({
          request: (op, params) => (fresh.link ? fresh.link.request(op, params) : Promise.reject(new Error("daemon unreachable"))),
        });
        entry = fresh;
        wired.set(w.id, entry);
        provideTerminals(w.id, entry.wt);
      }
      const { wt } = entry;
      if (w.phase === "running" && !entry.link) {
        const browser = getBrowser(w.id);
        const link = connectDaemonLink({
          ...opts,
          reach: () => api.daemonReach(w.id),
          onEvent: e => {
            if (e.type === "port.open" || e.type === "port.close") browser.feedEvent({ ...e, workspaceId: w.id });
            else wt.feedEvent(e);
          },
          // "dead" is the link we closed on purpose; the model hears "connecting" instead.
          onStatus: s => {
            if (s === "live") {
              link.request("ports.watch").then(r => browser.syncPorts(r["ports"]), () => {});
            }
            if (s !== "dead") wt.feedStatus(s);
          },
        });
        entry.link = link;
      } else if (w.phase !== "running" && entry.link) {
        unlink(entry);
        wt.feedStatus("connecting");
      }
    }
    for (const [id, entry] of wired) {
      if (seen.has(id)) continue;
      unlink(entry);
      wired.delete(id);
      provideTerminals(id, null);
    }
  };

  const unsubscribe = store.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    for (const [id, entry] of wired) {
      unlink(entry);
      provideTerminals(id, null);
    }
    wired.clear();
  };
}
