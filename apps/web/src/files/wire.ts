// SPDX-License-Identifier: AGPL-3.0-only
// The per-workspace daemon wire the files and diff surfaces call fs.* and
// git.* over, and the daemon's root as its hello announced it: the absolute
// directory every path must resolve inside, so pickers, pins and session
// starts are built absolute. terminal/wiring.ts provides both alongside the
// terminal model, so they ride the same socket; a test provides fakes.
import { useSyncExternalStore } from "react";
import type { TerminalWire } from "../terminal/link.js";

const wires = new Map<string, TerminalWire>();
const roots = new Map<string, string>();
const fns = new Set<() => void>();

function notify(): void {
  for (const fn of fns) fn();
}

export function provideDaemonWire(workspaceId: string, wire: TerminalWire | null): void {
  if (wire) wires.set(workspaceId, wire);
  else wires.delete(workspaceId);
  notify();
}

export function provideDaemonRoot(workspaceId: string, root: string | null): void {
  if (root !== null) roots.set(workspaceId, root);
  else roots.delete(workspaceId);
  notify();
}

export function getDaemonWire(workspaceId: string): TerminalWire | null {
  return wires.get(workspaceId) ?? null;
}

export function getDaemonRoot(workspaceId: string): string | null {
  return roots.get(workspaceId) ?? null;
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
