// SPDX-License-Identifier: AGPL-3.0-only
// The daemon token lives in one file on the guest, read by the daemon at every
// auth frame. The host mints one per process and writes it here: the deploy
// script for a fresh daemon, the rotation script for a machine that already
// has one, so a token leaked from an earlier run dies with that run.

/** Mirrors @wsp/daemon's DEFAULT_TOKEN_PATH; the runtime cannot import the daemon package (it only runs inside guests).
 * Where a machine wsp forked keeps the file; a machine the person owns keeps it under their own home, and the
 * kind that reaches it says where. */
export const DAEMON_TOKEN_PATH = "/root/.wsp-daemon-token";
/** The rotation script's answer on a machine that has a daemon. */
export const DAEMON_TOKEN_SET = "WSP_DAEMON_TOKEN_SET";
/** Its answer on a machine with no daemon: nothing is written. */
export const DAEMON_TOKEN_NONE = "WSP_DAEMON_TOKEN_NONE";

/** Every token written by wsp is hex; anything else would need quoting the run log cannot redact. */
export function assertTokenShape(token: string): void {
  if (!/^[0-9a-f]+$/.test(token)) throw new Error("a daemon token is lowercase hex");
}

/** Writes the token owner-readable, the whole file replaced at once so a daemon reading it mid-write never sees half.
 * The assignment carries the token, the only shape the run log's redaction knows. */
export function writeDaemonTokenScript(token: string, path: string = DAEMON_TOKEN_PATH): string {
  assertTokenShape(token);
  return [
    `WSP_DAEMON_TOKEN='${token}'`,
    "umask 077",
    `printf '%s' "$WSP_DAEMON_TOKEN" > ${path}.next`,
    `mv -f ${path}.next ${path}`,
  ].join("\n");
}

/** Replaces the token on a machine that has a daemon; a machine without one is left as it is and says so. */
export function rotateDaemonTokenScript(token: string, path: string = DAEMON_TOKEN_PATH): string {
  return [`test -f ${path} || { echo ${DAEMON_TOKEN_NONE}; exit 0; }`, writeDaemonTokenScript(token, path), `echo ${DAEMON_TOKEN_SET}`].join("\n");
}
