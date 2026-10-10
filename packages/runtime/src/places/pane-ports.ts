// SPDX-License-Identifier: AGPL-3.0-only
// The ports a Browser pane opens on this computer for a folder on a computer the
// person joined: that computer's port at the same number here where it is free.
// One stands while a pane shows its address, which the pane says by asking for
// it again every minute, and goes when the pane stops asking, after a quiet hour
// or when the person stops it in Ports; the pane asking after a quiet hour or a
// stop is told so and drops the address. Held to the relay's own rules, the port floor and the cap
// per workspace, and listed and stopped beside the relay's forwards.
import type { Socket } from "node:net";
import { FORWARD_MAX_PER_TARGET, RelayPort, paneForwardCapLine, paneForwardFloorLine, paneForwardGoneLine, paneForwardQuietLine, paneForwardStoppedLine, type ForwardEvent, type PortForward } from "@wsp/protocol";
import { listenNear, type Forward } from "./helpers.js";

/** How long a pane's forward stands after the pane last asked for it; the pane asks again every minute. */
export const PANE_HOLD_MS = 2 * 60_000;
/** How long a pane's forward stands with nothing connecting through it, the pane showing it or not. */
export const PANE_QUIET_MS = 60 * 60_000;
/** How long a forward with a connection open through it waits before it is read against both again. */
export const PANE_BUSY_RECHECK_MS = 15_000;

/** The pane forwards as the app lists and stops them, beside the relay's. */
export interface PaneForwards {
  list(): PortForward[];
  stop(workspaceId: string, port: number): boolean;
  on(fn: (e: ForwardEvent) => void): () => void;
}

interface Held {
  forward: Forward;
  view: PortForward;
  heldAt: number;
  usedAt: number;
  /** Cancels the read of it due next. */
  due: () => void;
}

export interface PanePorts extends PaneForwards {
  /** The port on this computer a pane reaches that computer's port by, opened or held another hold. */
  reach(key: string, port: number, asker: { workspaceId: string; name: string }, onConn: (conn: Socket, used: () => void) => void): Promise<number>;
  /** The port on this computer of the forward that stands for that computer's port, held no longer and opened by no one. */
  standing(key: string, port: number): number;
}

export function panePorts(deps: { forwards: Map<string, Forward>; now: () => number; schedule: (fn: () => void, ms: number) => () => void }): PanePorts {
  const held = new Map<string, Held>();
  const listeners = new Set<(e: ForwardEvent) => void>();
  /** A forward the quiet hour or the person ended while its pane still asked, with what that pane's next ask is told:
   * the pane drops the address, and the ask after that, the person opening it again, opens it again. */
  const ended = new Map<string, (port: number) => string>();
  const emit = (e: ForwardEvent): void => {
    for (const fn of listeners) fn(e);
  };

  const close = (key: string): void => {
    const h = held.get(key);
    if (h === undefined) return;
    held.delete(key);
    h.due();
    if (deps.forwards.get(key) === h.forward) deps.forwards.delete(key);
    h.forward.stop?.();
    emit({ type: "forward.close", workspaceId: h.view.workspaceId, port: h.view.port });
  };

  /** Reads the forward at the first moment it could be over: the pane's hold running out, or the quiet hour. */
  const arm = (key: string, h: Held): void => {
    h.due();
    const now = deps.now();
    const at = h.forward.conns.size > 0 ? now + PANE_BUSY_RECHECK_MS : Math.min(h.heldAt + PANE_HOLD_MS, h.usedAt + PANE_QUIET_MS);
    h.due = deps.schedule(() => {
      if (held.get(key) !== h) return;
      const later = deps.now();
      if (h.forward.conns.size > 0 || (later - h.heldAt < PANE_HOLD_MS && later - h.usedAt < PANE_QUIET_MS)) return arm(key, h);
      close(key);
      if (later - h.usedAt >= PANE_QUIET_MS && later - h.heldAt < PANE_HOLD_MS) ended.set(key, paneForwardQuietLine);
    }, Math.max(0, at - now));
  };

  return {
    async reach(key, port, asker, onConn) {
      const now = deps.now();
      const standing = held.get(key);
      if (standing !== undefined) {
        standing.heldAt = now;
        arm(key, standing);
        return standing.forward.localPort;
      }
      const told = ended.get(key);
      if (told !== undefined) {
        ended.delete(key);
        throw Object.assign(new Error(told(port)), { kind: "usage" });
      }
      if (!RelayPort.safeParse(port).success) throw Object.assign(new Error(paneForwardFloorLine(port)), { kind: "usage" });
      if ([...held.values()].filter(h => h.view.workspaceId === asker.workspaceId).length >= FORWARD_MAX_PER_TARGET) {
        throw Object.assign(new Error(paneForwardCapLine(asker.name, FORWARD_MAX_PER_TARGET)), { kind: "usage" });
      }
      let h: Held | undefined;
      const used = (): void => {
        if (h !== undefined) h.usedAt = deps.now();
      };
      const [servers, localPort] = await listenNear(port, conn => onConn(conn, used));
      const forward: Forward = {
        server: servers[0]!,
        localPort,
        conns: new Map(),
        stop: () => {
          for (const conn of forward.conns.values()) conn.destroy();
          for (const server of servers) server.close();
        },
      };
      h = { forward, view: { workspaceId: asker.workspaceId, port: localPort, startedAt: new Date(now).toISOString(), name: asker.name, kind: "url" }, heldAt: now, usedAt: now, due: () => {} };
      held.set(key, h);
      arm(key, h);
      deps.forwards.set(key, forward);
      emit({ type: "forward.open", forward: h.view });
      return localPort;
    },
    standing(key, port) {
      const h = held.get(key);
      if (h === undefined) throw Object.assign(new Error(paneForwardGoneLine(port)), { kind: "usage" });
      return h.forward.localPort;
    },
    list: () => [...held.values()].map(h => h.view),
    stop(workspaceId, port) {
      const [key, h] = [...held].find(([, h]) => h.view.workspaceId === workspaceId && h.view.port === port) ?? [];
      if (key === undefined || h === undefined) return false;
      close(key);
      if (deps.now() - h.heldAt < PANE_HOLD_MS) ended.set(key, paneForwardStoppedLine);
      return true;
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
