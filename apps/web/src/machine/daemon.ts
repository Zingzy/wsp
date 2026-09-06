// SPDX-License-Identifier: AGPL-3.0-only
// What this app needs from a daemon by the version that added it, read
// against the version its hello announced (files/wire.ts keeps that). A
// machine whose daemon is behind gets one line naming what it predates.
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
  { label: "Files in imported projects", since: 3 },
];

export function missingFeatures(version: number): DaemonFeature[] {
  return DAEMON_FEATURES.filter(f => f.since > version);
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** What a pane says in place of the daemon's own refusal when the machine's daemon is older than this app: what it
 * predates, and nothing to do about it, since the runtime replaces such a daemon on its own and the machine's row
 * says so while it does. Null before the hello and for a current daemon. */
export function daemonBehindLine(version: number | null): string | null {
  if (version === null || version >= DAEMON_VERSION) return null;
  return `daemon v${version} predates ${listWords(missingFeatures(version).map(f => f.label))}`;
}
