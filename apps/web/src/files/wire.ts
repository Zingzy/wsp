// SPDX-License-Identifier: AGPL-3.0-only
// The per-workspace daemon wire the files, diff and process surfaces call
// fs.*, git.* and proc.* over, and the root the daemon's hello announced,
// which every path must resolve inside, so pickers, pins and session starts
// are built absolute. terminal/wiring.ts provides both alongside the terminal
// model, so they ride the same socket; a test provides fakes.
import { useSyncExternalStore } from "react";
import type { TerminalWire } from "../terminal/link.js";

export interface DaemonHello {
  root: string;
  /** The daemon's protocol version as its hello named it; absent on a hello that named none. */
  version?: number;
}

const wires = new Map<string, TerminalWire>();
const hellos = new Map<string, DaemonHello>();
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

export function getDaemonWire(workspaceId: string): TerminalWire | null {
  return wires.get(workspaceId) ?? null;
}

/** The protocol version the workspace's daemon named in its hello, or null before one arrived or where it named none. */
export function getDaemonVersion(workspaceId: string): number | null {
  return hellos.get(workspaceId)?.version ?? null;
}

export function getDaemonRoot(workspaceId: string): string | null {
  return hellos.get(workspaceId)?.root ?? null;
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


