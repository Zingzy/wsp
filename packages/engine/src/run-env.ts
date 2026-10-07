// SPDX-License-Identifier: AGPL-3.0-only
// Values from this host's vault on a computer somebody owns, for one run and
// no longer. A value in a command line sits in a world-readable
// /proc/<pid>/cmdline there and one in a file sits on its disk, so the run's
// own input is the road: the script reads every NAME=value off it, exports
// them, and only then runs its own lines.

import { ENV_FROM_INPUT, shellQuote, type HarnessExec } from "@wsp/protocol";
import type { ExecResult, Machine } from "./machine.js";

export { ENV_FROM_INPUT };

/** A script that takes its environment off its input before its own lines. */
export const withEnvFromInput = (script: string): string => `${ENV_FROM_INPUT}\n${script}`;

/** The input such a script reads: one NAME=value per entry, each ended by a NUL so a value may hold a newline. */
export const envInput = (env: Readonly<Record<string, string>>): Uint8Array =>
  Buffer.from(
    Object.entries(env)
      .map(([name, value]) => `${name}=${value}\0`)
      .join(""),
  );

/** One command that reads its variables off its input with ENV_FROM_INPUT, run on the road the machine has: the
 * exec's own stdin where the machine takes it, else piped in from the command's text. The pipe is argv there, which
 * the single-login machines wsp makes allow, and the images wsp builds keep sudo and the box login's systemd manager
 * from logging (QUIET_LOGS). */
export function envExec(machine: Pick<Machine, "exec" | "takesStdin">, command: string, env: Readonly<Record<string, string>>, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  if (machine.takesStdin === true) return machine.exec(command, { ...opts, stdin: envInput(env) });
  const pairs = Object.entries(env).map(([name, value]) => shellQuote(`${name}=${value}`));
  return machine.exec(pairs.length === 0 ? `{\n${command}\n} </dev/null` : `printf '%s\\0' ${pairs.join(" ")} | {\n${command}\n}`, opts);
}

/** The exec a harness's questions outside a turn take on a machine: a command with variables goes through envExec,
 * one without runs as it is. */
export const harnessExec =
  (machine: Pick<Machine, "exec" | "takesStdin">, timeoutMs: number): HarnessExec =>
  (command, env) =>
    (env === undefined ? machine.exec(command, { timeoutMs }) : envExec(machine, command, env, { timeoutMs })).then(res => res.stdout);

/** The first line of a script sudo runs as root: sudo's own marks dropped, so the script reads a plain root shell
 * and not a person's shell escalated. The harness vendor's installer refuses to run under sudo (measured
 * 2026-09-11). */
export const DROP_SUDO_MARKS = "unset SUDO_USER SUDO_UID SUDO_GID SUDO_COMMAND";

/** The variable gh reads its token from, which the vault holds under the same name. */
export const GITHUB_TOKEN_ENV = "GH_TOKEN";
