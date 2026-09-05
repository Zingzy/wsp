// SPDX-License-Identifier: AGPL-3.0-only
// Fills the terminal registry from the store: one WorkspaceTerminals per
// workspace for as long as it exists, one daemon link while it runs. A
// napping workspace keeps its model (tabs, scrollback mirror) with the socket
// down; wake dials again and the model re-attaches its ptys. The same link
// is the browser's only source of ports: the daemon pushes port events only
// to sockets that asked with ports.watch, and a subscription dies with its
// socket, so every live transition asks again.
import { getBrowser } from "../browser/model.js";
import { provideDaemonRoot, provideDaemonWire } from "../files/wire.js";
import { getLive } from "../machine/live.js";
import type { useStore } from "../protocol/store.js";
import { useSignInStore } from "../shell/signInStore.js";
import { connectDaemonLink, type DaemonLink, type DaemonLinkOptions } from "./daemon-link.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "./link.js";

export interface WiringOptions extends Pick<DaemonLinkOptions, "WebSocketCtor" | "heartbeatMs" | "backoffMs"> {
  /** Keystrokes reach the runtime as one workspaces.touch per this window; the idle window is minutes, so 30 s loses nothing. */
  touchMinMs?: number;
}

interface Wired {
  wt: WorkspaceTerminals;
  link: DaemonLink | null;
  /** When the runtime last heard this workspace was typed into. */
  touched: number;
}

export function wireTerminals(store: typeof useStore, opts: WiringOptions = {}): () => void {
  const wired = new Map<string, Wired>();
  const { touchMinMs = 30_000, ...linkOpts } = opts;

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
        const fresh: Wired = { link: null, touched: 0, wt: undefined as unknown as WorkspaceTerminals };
        const wire: TerminalWire = {
          request: (op, params) => {
            if (op === "pty.write" && Date.now() - fresh.touched >= touchMinMs) {
              fresh.touched = Date.now();
              store.getState().api?.touch?.(w.id).catch(() => {});
            }
            return fresh.link ? fresh.link.request(op, params) : Promise.reject(new Error("daemon unreachable"));
          },
        };
        fresh.wt = new WorkspaceTerminals(wire);
        entry = fresh;
        wired.set(w.id, entry);
        provideTerminals(w.id, entry.wt);
        provideDaemonWire(w.id, wire);
      }
      const { wt } = entry;
      if (w.phase === "running" && !entry.link) {
        const browser = getBrowser(w.id);
        const link = connectDaemonLink({
          ...linkOpts,
          reach: () => api.daemonReach(w.id),
          onEvent: e => {
            if (e.type === "port.open" || e.type === "port.close") browser.feedEvent({ ...e, workspaceId: w.id });
            else if (e.type === "browser.open") useSignInStore.getState().announce(w.id, e.url);
            else if (e.type === "daemon.hello") provideDaemonRoot(w.id, e.root);
            else if (e.type === "sys.sample") getLive(w.id).feedSample(e);
            else wt.feedEvent(e);
          },
          // "dead" is the link we closed on purpose; the model hears "connecting" instead.
          onStatus: s => {
            if (s === "live") {
              link.request("ports.watch").then(r => browser.syncPorts(r["ports"]), () => {});
              link.request("sys.watch").catch(() => {});
            }
            if (s !== "dead") {
              wt.feedStatus(s);
              getLive(w.id).feedStatus(s);
            }
          },
        });
        entry.link = link;
      } else if (w.phase !== "running" && entry.link) {
        unlink(entry);
        wt.feedStatus("connecting");
        getLive(w.id).feedStatus("connecting");
      }
    }
    for (const [id, entry] of wired) {
      if (seen.has(id)) continue;
      unlink(entry);
      wired.delete(id);
      provideTerminals(id, null);
      provideDaemonWire(id, null);
      provideDaemonRoot(id, null);
      // A bar for a workspace that is gone would name it by id.
      useSignInStore.getState().dismiss(id);
    }
  };

  const unsubscribe = store.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    for (const [id, entry] of wired) {
      unlink(entry);
      provideTerminals(id, null);
      provideDaemonWire(id, null);
      provideDaemonRoot(id, null);
    }
    wired.clear();
  };
}
