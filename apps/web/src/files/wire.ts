// SPDX-License-Identifier: AGPL-3.0-only
// The per-workspace daemon wire the files, diff and process surfaces call
// fs.*, git.* and proc.* over, and the daemon's hello as it announced itself:
// the root every path must resolve inside, so pickers, pins and session
// starts are built absolute, and the version that says which ops it answers.
// terminal/wiring.ts provides both alongside the terminal model, so they ride
// the same socket; a test provides fakes. An update of that daemon is also
// held here by workspace, so the keycap that started it reads the same phase
// after the machine tab was left and reopened.
import { useSyncExternalStore } from "react";
import type { TerminalWire } from "../terminal/link.js";

export interface DaemonHello {
  root: string;
  version: number;
}

/** How long after the runtime's update resolves the keycap waits for the new daemon's hello. The link the update
 * killed redials with backoff up to 10 s, plus one more round when a redial beat the token rotation. */
export const DAEMON_HELLO_WAIT_MS = 45_000;

/** Deploying while the runtime works; awaiting the hello from when it resolves until the bound passes. */
export type DaemonUpdatePhase = "deploying" | "awaiting-hello";

const wires = new Map<string, TerminalWire>();
const hellos = new Map<string, DaemonHello>();
const updates = new Map<string, { phase: DaemonUpdatePhase; bound?: ReturnType<typeof setTimeout> }>();
const fns = new Set<() => void>();

function notify(): void {
  for (const fn of fns) fn();
}

export function provideDaemonWire(workspaceId: string, wire: TerminalWire | null): void {
  if (wire) wires.set(workspaceId, wire);
  else wires.delete(workspaceId);
  notify();
}

export function provideDaemonHello(workspaceId: string, hello: DaemonHello | null): void {
  if (hello !== null) hellos.set(workspaceId, hello);
  else hellos.delete(workspaceId);
  notify();
}

export function provideDaemonUpdate(workspaceId: string, phase: DaemonUpdatePhase | null): void {
  const bound = updates.get(workspaceId)?.bound;
  if (bound !== undefined) clearTimeout(bound);
  if (phase === null) updates.delete(workspaceId);
  else if (phase === "deploying") updates.set(workspaceId, { phase });
  else updates.set(workspaceId, { phase, bound: setTimeout(() => provideDaemonUpdate(workspaceId, null), DAEMON_HELLO_WAIT_MS) });
  notify();
}

export function getDaemonWire(workspaceId: string): TerminalWire | null {
  return wires.get(workspaceId) ?? null;
}

export function getDaemonRoot(workspaceId: string): string | null {
  return hellos.get(workspaceId)?.root ?? null;
}

export function getDaemonVersion(workspaceId: string): number | null {
  return hellos.get(workspaceId)?.version ?? null;
}

export function getDaemonUpdate(workspaceId: string): DaemonUpdatePhase | null {
  return updates.get(workspaceId)?.phase ?? null;
}

function subscribe(fn: () => void): () => void {
  fns.add(fn);
  return () => fns.delete(fn);
}

export function useDaemonWire(workspaceId: string): TerminalWire | null {
  return useSyncExternalStore(subscribe, () => getDaemonWire(workspaceId));
}

/** null until the daemon's hello arrived on this workspace's link. */
export function useDaemonRoot(workspaceId: string): string | null {
  return useSyncExternalStore(subscribe, () => getDaemonRoot(workspaceId));
}

/** null until the daemon's hello arrived on this workspace's link. */
export function useDaemonVersion(workspaceId: string): number | null {
  return useSyncExternalStore(subscribe, () => getDaemonVersion(workspaceId));
}

/** null while no update of this workspace's daemon is in flight. */
export function useDaemonUpdate(workspaceId: string): DaemonUpdatePhase | null {
  return useSyncExternalStore(subscribe, () => getDaemonUpdate(workspaceId));
}
