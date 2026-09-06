// SPDX-License-Identifier: AGPL-3.0-only
// The version each workspace's daemon announced in its hello, and what this
// app needs from a daemon by the version that added it. A machine whose
// daemon is behind gets one line naming what it predates and the update.
import { useSyncExternalStore } from "react";
import { DAEMON_VERSION } from "@wsp/protocol";

export interface DaemonFeature {
  label: string;
  since: number;
}

/** Named as the panel names them, so the line points at the section and the tab that read unavailable. Adding an op
 * to the daemon bumps DAEMON_VERSION and adds what it serves here. */
export const DAEMON_FEATURES: readonly DaemonFeature[] = [
  { label: "Live", since: 2 },
  { label: "Processes", since: 2 },
];

export function missingFeatures(version: number): DaemonFeature[] {
  return DAEMON_FEATURES.filter(f => f.since > version);
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The machine tab's line for a daemon behind this app; null before the hello and for a current daemon. */
export function daemonBehindLine(version: number | null): string | null {
  if (version === null || version >= DAEMON_VERSION) return null;
  return `daemon v${version} predates ${listWords(missingFeatures(version).map(f => f.label))}`;
}

const versions = new Map<string, number>();
const fns = new Set<() => void>();

export function provideDaemonVersion(workspaceId: string, version: number | null): void {
  if (version !== null) versions.set(workspaceId, version);
  else versions.delete(workspaceId);
  for (const fn of fns) fn();
}

/** null until the daemon's hello arrived on this workspace's link. */
export function getDaemonVersion(workspaceId: string): number | null {
  return versions.get(workspaceId) ?? null;
}

function subscribe(fn: () => void): () => void {
  fns.add(fn);
  return () => fns.delete(fn);
}

export function useDaemonVersion(workspaceId: string): number | null {
  return useSyncExternalStore(subscribe, () => getDaemonVersion(workspaceId));
}

/** Test isolation: forget every workspace's daemon version. */
export function resetDaemonVersions(): void {
  versions.clear();
}
