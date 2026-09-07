// SPDX-License-Identifier: AGPL-3.0-only

/** One POSIX sh word: single quotes keep every byte, and an embedded quote closes, escapes and reopens. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** The command run from a folder: a cd into the quoted folder, or into `~` when none was named. Guest exec carries no
 * HOME (measured on Solari sandboxes), so `~` and never "$HOME": tilde expansion falls back to the passwd entry. */
export function inFolder(cwd: string | undefined, command: string): string {
  return `cd ${cwd === undefined ? "~" : shellQuote(cwd)} && ${command}`;
}
