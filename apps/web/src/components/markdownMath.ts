// SPDX-License-Identifier: AGPL-3.0-only
// KaTeX for a reply's formulas, in a chunk of its own that loads the first
// time a message holds math. It runs after the sanitizer, on the math nodes
// the sanitizer kept, and trusts nothing the formula asks for: no links, no
// classes, no pictures, and macro expansion bounded.
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

export const REHYPE_KATEX = [
  rehypeKatex,
  { throwOnError: false, trust: false, strict: "ignore", maxSize: 100, maxExpand: 100, errorColor: "var(--error-foreground)" },
] as const;
