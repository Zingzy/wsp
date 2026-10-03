// SPDX-License-Identifier: AGPL-3.0-only
// Values from this host's vault on a computer somebody owns, for one run and
// no longer. A value in a command line sits in a world-readable
// /proc/<pid>/cmdline there and one in a file sits on its disk, so the run's
// own input is the road: the script reads every NAME=value off it, exports
// them, and only then runs its own lines.

/** What a script reads its environment with: every NUL-ended NAME=value on its input, exported in bash. */
export const ENV_FROM_INPUT = "while IFS= read -r -d '' wsp_kv; do export \"$wsp_kv\"; done; unset wsp_kv";

/** A script that takes its environment off its input before its own lines. */
export const withEnvFromInput = (script: string): string => `${ENV_FROM_INPUT}\n${script}`;

/** The input such a script reads: one NAME=value per entry, each ended by a NUL so a value may hold a newline. */
export const envInput = (env: Readonly<Record<string, string>>): Uint8Array =>
  Buffer.from(
    Object.entries(env)
      .map(([name, value]) => `${name}=${value}\0`)
      .join(""),
  );

/** The variable gh reads its token from, which the vault holds under the same name. */
export const GITHUB_TOKEN_ENV = "GH_TOKEN";
