// SPDX-License-Identifier: AGPL-3.0-only

/** One POSIX sh word: single quotes keep every byte, and an embedded quote closes, escapes and reopens. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
