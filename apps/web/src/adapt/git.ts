// SPDX-License-Identifier: AGPL-3.0-only
// What a failed git.status says about the folder: the daemon's not-a-git-repo
// code means the folder sits outside any repository; every other failure, a
// refused read or a dropped wire among them, leaves the question open.
import type { DaemonErrorCode } from "@wsp/protocol";

const NOT_A_GIT_REPO: DaemonErrorCode = "not-a-git-repo";

export function repoAbsence(e: unknown): "none" | "unknown" {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return code === NOT_A_GIT_REPO ? "none" : "unknown";
}
