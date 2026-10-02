// SPDX-License-Identifier: AGPL-3.0-only
// Words off the network as a message to an agent carries them: folded onto one line where they name something, and
// fenced where they are quoted, so nothing in them reads as the person's own line or closes the fence early.

/** Text folded onto one line: every run of whitespace, line breaks included, as one space. */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A fence one backtick longer than any run of backticks inside the text, so nothing in it can close the fence. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}
