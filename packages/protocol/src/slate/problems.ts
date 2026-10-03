// SPDX-License-Identifier: AGPL-3.0-only
// The closed table of problem codes this build can raise, each with its word, and the helpers that make a Problem
// and find the nearest valid option for its fix.
import type { SlateProblem } from "./types.js";

export const SLATE_CODES = {
  P100: "bad-line", P101: "bad-indent", P102: "unknown-flag", P103: "bad-id", P104: "duplicate-id", P105: "unknown-op", P106: "bad-json",
  P999: "not-built",
  D200: "schema-unknown", D201: "kit-unknown", D202: "root-ambiguous", D203: "piece-missing", D204: "piece-orphan", D205: "cycle",
  D206: "too-deep", D207: "too-many-pieces", D208: "too-big",
  T300: "type-unknown", T301: "type-fallback", T302: "prop-unknown", T303: "prop-type", T304: "prop-required", T305: "prop-not-bindable",
  T306: "prop-enum", T307: "label-missing", T308: "children-not-allowed", T309: "children-required", T310: "string-too-long",
  T311: "two-loud", T312: "prop-reserved", T313: "too-many-announce", T314: "item-unknown",
  X400: "expr-syntax", X401: "path-unknown", X402: "path-scope", X404: "fn-unknown", X405: "fn-arity", X406: "fn-arg-type",
  X407: "expr-limit", X408: "expr-type", X409: "item-outside-scope", X410: "two-way-not-state", X411: "state-undeclared",
  S500: "state-too-big", S501: "state-key", S502: "state-type",
  A600: "action-unknown", A601: "action-arg", A602: "action-event", A603: "action-text-not-literal", A606: "too-many-actions",
  R900: "data-missing", R902: "eval-failed",
  W001: "content-looks-like-path", W002: "tone-alone", W004: "copy-style",
} as const;
export type SlateCode = keyof typeof SLATE_CODES;

/** Codes that never block a write. */
export const SLATE_WARNINGS: ReadonlySet<SlateCode> = new Set<SlateCode>(["D204", "T301", "T311", "T313", "W001", "W002", "W004"]);

export function slateProblem(code: SlateCode, message: string, extra: Omit<SlateProblem, "code" | "name" | "message"> = {}): SlateProblem {
  return { code, name: SLATE_CODES[code], message, ...extra };
}

/** Levenshtein distance, capped: past cap the answer is cap + 1. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** The option closest to word within max edits, ties to the first listed; undefined when none is close. */
export function nearest(word: string, options: Iterable<string>, max = 2): string | undefined {
  let found: string | undefined;
  let best = max + 1;
  for (const option of options) {
    const d = editDistance(word.toLowerCase(), option.toLowerCase(), max);
    if (d < best) [found, best] = [option, d];
  }
  if (found === undefined && word.length >= 3) for (const option of options) if (option.toLowerCase().startsWith(word.toLowerCase())) return option;
  return found;
}

/** "a, b or c". */
export const orList = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
