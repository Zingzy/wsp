// SPDX-License-Identifier: AGPL-3.0-only
// What this app needs from a daemon by the version that added it, read
// against the version its hello announced (files/wire.ts keeps that). A pane
// whose own ops a machine's daemon is too old to answer gets one line naming
// what that daemon predates; every other pane, and every other failure, is
// left to say its own thing.
import { DAEMON_VERSION } from "@wsp/protocol";

export interface DaemonFeature {
  /** What a pane names itself by when it asks whether this daemon serves it; the label is for reading, not matching. */
  key: "live" | "procs" | "files";
  label: string;
  since: number;
}

/** Named as the panel names them, so the line points at the section and the tab that read unavailable. Adding an op
 * to the daemon bumps DAEMON_VERSION and adds what it serves here. */
export const DAEMON_FEATURES: readonly DaemonFeature[] = [
  { key: "live", label: "Live", since: 2 },
  { key: "procs", label: "Processes", since: 2 },
  { key: "files", label: "Files in imported projects", since: 3 },
];

export function missingFeatures(version: number): DaemonFeature[] {
  return DAEMON_FEATURES.filter(f => f.since > version);
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** What a pane says in place of a refusal its machine's daemon is too old to avoid: what that daemon predates, and
 * nothing to do about it, since a host with a daemon bundle replaces such a daemon on its own and the machine's row
 * says so while it does. Null before the hello, on a daemon current enough for this pane's own ops whatever else it
 * predates, and on a current daemon; a pane that asked more widely would blame the version for its own failures. */
export function daemonBehindLine(version: number | null, key: DaemonFeature["key"]): string | null {
  if (version === null || version >= DAEMON_VERSION) return null;
  const missing = missingFeatures(version);
  if (!missing.some(f => f.key === key)) return null;
  return `daemon v${version} predates ${listWords(missing.map(f => f.label))}`;
}
