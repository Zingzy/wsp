// SPDX-License-Identifier: AGPL-3.0-only
// The per-workspace daemon wire the files and diff surfaces call fs.* and
// git.* over. terminal/wiring.ts provides it alongside the terminal model, so
// both ride the same socket and reconnect together; a test provides a fake.
import { useSyncExternalStore } from "react";
import type { TerminalWire } from "../terminal/link.js";

const registry = new Map<string, TerminalWire>();
const fns = new Set<() => void>();

export function provideDaemonWire(workspaceId: string, wire: TerminalWire | null): void {
  if (wire) registry.set(workspaceId, wire);
  else registry.delete(workspaceId);
  for (const fn of fns) fn();
}

export function getDaemonWire(workspaceId: string): TerminalWire | null {
  return registry.get(workspaceId) ?? null;
}

function subscribe(fn: () => void): () => void {
  fns.add(fn);
  return () => fns.delete(fn);
}

export function useDaemonWire(workspaceId: string): TerminalWire | null {
  return useSyncExternalStore(subscribe, () => getDaemonWire(workspaceId));
}
