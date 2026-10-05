// SPDX-License-Identifier: AGPL-3.0-only
// The closed table of problem codes (10, "The error code table"), each with its word and class, and the helpers
// that make a Problem and find the nearest valid option for its fix.
import type { SlateProblem } from "./types.js";

export const SLATE_CODES = {
  P100: "bad-syntax", P102: "bare-not-boolean", P103: "bad-id", P104: "duplicate-id", P105: "bad-patch-op", P107: "reaction-without-id",
  D200: "schema-unknown", D201: "kit-unknown", D202: "root-ambiguous", D203: "piece-missing", D205: "cycle", D206: "too-deep",
  D207: "too-many-pieces", D208: "too-big",
  T300: "type-unknown", T302: "prop-unknown", T303: "prop-type", T304: "prop-required", T305: "prop-not-bindable", T306: "prop-enum",
  T307: "label-missing", T308: "children-not-allowed", T309: "children-required", T311: "two-loud", T312: "prop-reserved", T314: "item-unknown",
  X400: "expr-syntax", X401: "path-unknown", X402: "path-scope", X403: "path-consent", X404: "fn-unknown", X405: "fn-arity",
  X406: "fn-arg-type", X407: "expr-limit", X408: "expr-type", X409: "item-outside-scope", X410: "two-way-not-value", X420: "javascript",
  Q420: "pipe-syntax", Q422: "step-unknown", Q423: "step-arity", Q424: "step-type", Q425: "step-literal", Q426: "pipe-limit",
  S500: "values-too-big", S501: "name-undeclared", S502: "editable-not-value", S503: "start-not-literal", S510: "derived-cycle",
  S512: "too-many-derived", S513: "too-many-values", S520: "secret-exposed",
  A600: "step-unknown", A601: "step-arg", A602: "event-unknown", A603: "text-not-literal", A606: "too-many-steps", A607: "set-not-value",
  A608: "window-step-in-reaction", A610: "reaction-cycle", A611: "reaction-shape",
  K700: "cmd-not-literal", K701: "run-kind", K702: "run-name", K703: "timer", K704: "run-arg", K705: "tool-name", K706: "tool-unknown",
  K707: "too-many-runs", K708: "file-name", K709: "files-too-big",
  V750: "version-behind", V751: "write-rate", V752: "nothing-to-undo", V753: "send-rate",
  Z800: "thread-not-yours", Z801: "thread-not-in-tree", Z802: "no-slate", Z804: "rewound-before",
  R900: "data-missing", R901: "data-late", R902: "eval-failed", R903: "source-unavailable", R904: "consent-refused", R905: "draw-failed",
  R906: "tool-error", R907: "over-budget", R908: "piece-fallback", R910: "reaction-runaway", R911: "run-runaway", R912: "reaction-failed",
  R913: "run-held",
  W001: "content-looks-like-path", W002: "tone-alone", W003: "series-as-bars", W004: "copy-style", W006: "deprecated", W010: "short-secret",
  W011: "secret-in-argv", W012: "joined-by-mark", W013: "chart-x-index", W014: "mono-on-sentence", W015: "file-undeclared", W016: "icon-unknown",
} as const;
export type SlateCode = keyof typeof SLATE_CODES;

/** Codes that never block a write. */
export const SLATE_WARNINGS: ReadonlySet<string> = new Set<SlateCode>(["T311", "X403", "W001", "W002", "W003", "W004", "W006", "W010", "W011", "W012", "W013", "W014", "W015", "W016"]);

export function slateProblem(code: SlateCode, message: string, extra: Omit<SlateProblem, "code" | "name" | "message"> = {}): SlateProblem {
  const out: SlateProblem = { code, name: SLATE_CODES[code], message };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
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
export function nearest(word: string, options: Iterable<string>, max = word.length >= 7 ? 3 : 2): string | undefined {
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
