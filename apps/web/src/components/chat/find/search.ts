// SPDX-License-Identifier: AGPL-3.0-only
// The search over a thread's parts: every match in thread order, each named by its entry, its part and its place
// among that part's matches, which is how the page finds the same match among the ranges it draws.
import { MATCH_CAP, spansIn, type Needle } from "./match";
import type { FindDoc } from "./text";

export interface FindMatch {
  readonly entryId: string;
  readonly part: number;
  /** Its place among the matches of its part, from the part's start. */
  readonly ordinal: number;
}

export interface FindResult {
  readonly matches: ReadonlyArray<FindMatch>;
  /** More than MATCH_CAP matched, and counting stopped there. */
  readonly capped: boolean;
}

const lowered = new WeakMap<ReadonlyArray<string>, string[]>();
const lowerOf = (segments: ReadonlyArray<string>): string[] => {
  let held = lowered.get(segments);
  if (held === undefined) {
    held = segments.map(s => s.toLowerCase());
    lowered.set(segments, held);
  }
  return held;
};

/** Where the reader is, as the index of the doc at the bottom of what they see (the newest when absent), and how many
 * matches to keep. */
export interface SearchAt {
  readonly anchor?: number;
  readonly cap?: number;
}

/** Every match in thread order, at most `cap` of them: past the cap, the ones nearest the reader, read outward from
 * the anchor's doc, the docs above it before the ones below. A part keeps its matches from its start, so a match is
 * the same ordinal whichever way the walk reached it. */
export function searchDocs(docs: ReadonlyArray<FindDoc>, needle: Needle, tools: boolean, at: SearchAt = {}): FindResult {
  const cap = at.cap ?? MATCH_CAP;
  const lower = needle.kind === "literal" && !needle.matchCase;
  const byDoc = new Map<number, FindMatch[]>();
  let kept = 0;
  let capped = false;
  const read = (index: number): void => {
    const doc = docs[index]!;
    const found: FindMatch[] = [];
    for (const part of doc.parts) {
      if (part.tool && !tools) continue;
      let ordinal = 0;
      const lows = lower ? lowerOf(part.segments) : undefined;
      for (let i = 0; i < part.segments.length; i++) {
        for (const _span of spansIn(part.segments[i]!, needle, cap + 1 - kept - found.length, lows?.[i])) {
          found.push({ entryId: doc.entryId, part: part.part, ordinal: ordinal++ });
        }
        if (kept + found.length > cap) break;
      }
      if (kept + found.length > cap) break;
    }
    if (kept + found.length > cap) {
      capped = true;
      found.length = cap - kept;
    }
    kept += found.length;
    if (found.length > 0) byDoc.set(index, found);
  };
  const anchor = Math.min(Math.max(at.anchor ?? docs.length - 1, 0), docs.length - 1);
  for (let step = 0; !capped && (anchor - step >= 0 || anchor + step < docs.length); step++) {
    if (anchor - step >= 0) read(anchor - step);
    if (!capped && step > 0 && anchor + step < docs.length) read(anchor + step);
  }
  const matches = [...byDoc.keys()].sort((a, b) => a - b).flatMap(index => byDoc.get(index)!);
  return { matches, capped };
}
