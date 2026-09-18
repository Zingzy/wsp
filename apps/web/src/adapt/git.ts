// SPDX-License-Identifier: AGPL-3.0-only
// What a failed git.status says about the folder: the daemon's not-a-git-repo
// code means the folder sits outside any repository, and any other code it
// typed is a read the machine refused. A failure the daemon never typed is a
// read that did not happen at all (the wire was not there, the socket went),
// and nothing is known about the folder's git: the slot stays as it was rather
// than saying a word about a read nobody made.
import type { DaemonErrorCode } from "@wsp/protocol";

const NOT_A_GIT_REPO: DaemonErrorCode = "not-a-git-repo";

export function repoAbsence(e: unknown): "none" | "refused" | "unknown" {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (code === NOT_A_GIT_REPO) return "none";
  return typeof code === "string" ? "refused" : "unknown";
}
