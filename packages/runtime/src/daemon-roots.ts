// SPDX-License-Identifier: AGPL-3.0-only
// The folders the daemon browses beside its home live in one file on the
// guest, read at every files and diff op. The runtime writes it when a project
// lands, whole and in one rename, so a daemon reading mid-write never sees half.
import { posix } from "node:path";
import { DAEMON_ROOTS_PATH, shellQuote } from "@wsp/protocol";

export function writeDaemonRootsScript(roots: readonly string[]): string {
  const next = `${DAEMON_ROOTS_PATH}.next`;
  return [
    `mkdir -p ${shellQuote(posix.dirname(DAEMON_ROOTS_PATH))}`,
    `printf '%s\\n' ${roots.map(shellQuote).join(" ")} > ${shellQuote(next)}`,
    `mv -f ${shellQuote(next)} ${shellQuote(DAEMON_ROOTS_PATH)}`,
  ].join("\n");
}
