// SPDX-License-Identifier: AGPL-3.0-only
// One matcher for the count and the highlights: the find model runs it over the parts an entry draws, and the page
// runs it over the text the same parts hold on screen, so both agree on what a match is.

export interface FindOptions {
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

/** Where a match sits in one segment: its start and its end, in UTF-16 code units. */
export type Span = readonly [number, number];

/** Counting stops here and the bar reads "9,999+", as VS Code's chat find does: a pattern like `.` over a whole thread
 * would otherwise list every character. */
export const MATCH_CAP = 9_999;

/** A query the matcher reads: a literal one lowercased once when case is ignored, or a compiled pattern. */
export type Needle =
  | { readonly kind: "literal"; readonly text: string; readonly matchCase: boolean; readonly wholeWord: boolean }
  | { readonly kind: "regex"; readonly pattern: RegExp; readonly wholeWord: boolean };

const WORD = /[\p{L}\p{N}_]/u;
const isWord = (char: string | undefined): boolean => char !== undefined && WORD.test(char);

/** The needle a query makes, null for an empty query, or the pattern's own refusal for one that does not parse. */
export function needleOf(query: string, o: FindOptions): Needle | null | { readonly invalid: string } {
  if (query.length === 0) return null;
  if (!o.regex) return { kind: "literal", text: o.matchCase ? query : query.toLowerCase(), matchCase: o.matchCase, wholeWord: o.wholeWord };
  try {
    return { kind: "regex", pattern: new RegExp(query, o.matchCase ? "gu" : "giu"), wholeWord: o.wholeWord };
  } catch (cause) {
    return { invalid: cause instanceof Error ? cause.message : String(cause) };
  }
}

const bounded = (text: string, start: number, end: number): boolean => !isWord(text[start - 1]) && !isWord(text[end]) && end > start;

/** Every match in one segment, at most `room` of them; `lower` is the segment lowercased, when case is ignored. */
export function spansIn(text: string, needle: Needle, room: number, lower?: string): Span[] {
  const spans: Span[] = [];
  if (room <= 0) return spans;
  if (needle.kind === "literal") {
    const hay = needle.matchCase ? text : (lower ?? text.toLowerCase());
    const length = needle.text.length;
    for (let at = hay.indexOf(needle.text); at !== -1; at = hay.indexOf(needle.text, at + Math.max(1, length))) {
      if (needle.wholeWord && !bounded(text, at, at + length)) continue;
      spans.push([at, at + length]);
      if (spans.length >= room) break;
    }
    return spans;
  }
  const pattern = needle.pattern;
  pattern.lastIndex = 0;
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    const start = found.index;
    const end = start + found[0].length;
    // An empty match draws nothing; step past it so the scan moves on.
    if (end === start) {
      pattern.lastIndex = start + 1;
      continue;
    }
    if (needle.wholeWord && !bounded(text, start, end)) continue;
    spans.push([start, end]);
    if (spans.length >= room) break;
  }
  return spans;
}
