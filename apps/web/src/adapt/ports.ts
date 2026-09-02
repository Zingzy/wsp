// SPDX-License-Identifier: AGPL-3.0-only
// The daemon's listening ports into the browser pane's server list. Shape
// from t3code useDiscoveredLocalServers.ts PreviewableServer (commit
// 57a66608). The ports.watch reply seeds the set and port.open/port.close keep
// it current; the runtime's PortOpenEvent/PortCloseEvent (workspace-scoped)
// fold the same way. The daemon reports pid only, so processName stays null.
import type { DaemonEvent, EventUnion } from "@wsp/protocol";
import type { PreviewableServer } from "./view-model.js";

export interface KnownPort {
  readonly port: number;
  readonly pid: number | null;
}

/** ports.watch's reply payload. */
export interface PortsSnapshot {
  readonly ports: ReadonlyArray<{ readonly port: number; readonly pid?: number | null }>;
}

type PortEvent =
  | Extract<DaemonEvent, { type: "port.open" | "port.close" }>
  | Extract<EventUnion, { type: "port.open" | "port.close" }>;

export function applyPortsSnapshot(snapshot: PortsSnapshot): KnownPort[] {
  const byPort = new Map<number, KnownPort>();
  for (const p of snapshot.ports) if (!byPort.has(p.port)) byPort.set(p.port, { port: p.port, pid: p.pid ?? null });
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Folds one port event; a re-open of a known port keeps the first pid, a close of an unknown port is a no-op. */
export function applyPortEvent(ports: ReadonlyArray<KnownPort>, event: PortEvent): KnownPort[] {
  switch (event.type) {
    case "port.open":
      if (ports.some(p => p.port === event.port)) return [...ports];
      return [...ports, { port: event.port, pid: event.pid ?? null }].sort((a, b) => a.port - b.port);
    case "port.close":
      return ports.filter(p => p.port !== event.port);
    default: {
      const _exhaustive: never = event;
      return [...ports];
    }
  }
}

export interface PreviewableServersInput {
  readonly ports: ReadonlyArray<KnownPort>;
  /** The minted preview route for a port, when the browser has one; else the loopback url is the target. */
  readonly reachUrl?: (port: number) => string | undefined;
}

export function toPreviewableServers(input: PreviewableServersInput): PreviewableServer[] {
  return input.ports.map(p => {
    const requestedUrl = `http://localhost:${p.port}`;
    return {
      host: "localhost",
      port: p.port,
      url: input.reachUrl?.(p.port) ?? requestedUrl,
      processName: null,
      pid: p.pid,
      terminal: null,
      source: "scanner",
      requestedUrl,
    };
  });
}
