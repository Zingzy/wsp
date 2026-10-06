// SPDX-License-Identifier: AGPL-3.0-only
// A law test's allowed list names the text it lets through and how many times, never the file that holds it, so a
// split that moves an allowed line elsewhere keeps the test green while a new copy anywhere goes over the count.

/** A text a law test lets through wherever it sits in the tree, exactly count times, with why it stays. */
export interface Allowed {
  readonly text: string;
  readonly count: number;
  readonly why: string;
}

/** One thing a scan found: the exact text it matched, and where, for the message. */
export interface Found {
  readonly text: string;
  readonly where: string;
}

/** How many places an over message names before it counts the rest. */
const SHOWN = 5;

/** Holds what a scan found to its allowed list. refused: a hit whose text no entry names. over: an entry the tree
 * holds more times than its count, with the first places it sits. stale: an entry the tree holds fewer times, none
 * included. A text listed twice throws: one text has one count. */
export function holdTo(found: readonly Found[], allowed: readonly Allowed[]): { refused: string[]; over: string[]; stale: string[] } {
  const entries = new Map<string, Allowed>();
  for (const entry of allowed) {
    if (entries.has(entry.text)) throw new Error(`the allowed list names ${JSON.stringify(entry.text)} twice`);
    entries.set(entry.text, entry);
  }
  const at = new Map<string, string[]>();
  for (const hit of found) (at.get(hit.text) ?? at.set(hit.text, []).get(hit.text)!).push(hit.where);
  const refused = found.filter(hit => !entries.has(hit.text)).map(hit => `${hit.where}: ${hit.text}`);
  const over = allowed.flatMap(entry => {
    const places = at.get(entry.text) ?? [];
    if (places.length <= entry.count) return [];
    const more = places.length > SHOWN ? ` and ${places.length - SHOWN} more` : "";
    return [`${entry.text}: found ${places.length}, allowed ${entry.count}, at ${places.slice(0, SHOWN).join(", ")}${more}`];
  });
  const stale = allowed.flatMap(entry => {
    const n = at.get(entry.text)?.length ?? 0;
    return n < entry.count ? [`${entry.text}: found ${n}, allowed ${entry.count}`] : [];
  });
  return { refused, over, stale };
}
