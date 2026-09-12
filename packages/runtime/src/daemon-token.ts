// SPDX-License-Identifier: AGPL-3.0-only
// The daemon token lives in one file on the machine, read by the daemon at
// every auth frame. The host mints one per process and writes it here: the
// deploy for a fresh daemon, the rotation for a machine that already has one,
// so a token leaked from an earlier run dies with that run. Which road the
// bytes take is the machine's to say, since on a machine somebody else may
// hold an account the command itself must never name the token.
import { hasByteRoad, landBytes, type Machine } from "@wsp/engine";
import { DAEMON_TOKEN_PATH, shellQuote } from "@wsp/protocol";

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

/** Whether the machine had a token file to replace, having replaced it. A machine wsp made is root's alone and
 * takes the whole rotation as one command; a machine somebody already owns may carry other accounts, and a
 * command sits in a world readable /proc/<pid>/cmdline while it runs, so there the token travels the machine's
 * own byte road and the command names only the path it is looking for. */
export async function rotateDaemonToken(machine: Machine, token: string, path: string = DAEMON_TOKEN_PATH): Promise<boolean> {
  assertTokenShape(token);
  if (!hasByteRoad(machine)) {
    const rotated = await machine.exec(rotateDaemonTokenScript(token, path));
    return rotated.exitCode === 0 && rotated.stdout.includes(DAEMON_TOKEN_SET);
  }
  const there = await machine.exec(`test -f ${shellQuote(path)} && echo ${DAEMON_TOKEN_SET} || echo ${DAEMON_TOKEN_NONE}`);
  if (there.exitCode !== 0 || !there.stdout.includes(DAEMON_TOKEN_SET)) return false;
  await landBytes(machine, path, new TextEncoder().encode(token));
  return true;
}
