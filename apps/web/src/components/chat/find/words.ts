// SPDX-License-Identifier: AGPL-3.0-only
// What find in thread says, in one table.

const count = new Intl.NumberFormat("en-US");

export const FIND_WORDS = {
  field: "Find in thread",
  matchCase: "Match case",
  wholeWord: "Match whole word",
  regex: "Use regular expression",
  tools: "Include tool calls",
  older: "Older match",
  newer: "Newer match",
  close: "Close",
  noResults: "No results",
  invalid: "This is not a valid regular expression.",
  slow: "This pattern took too long.",
  trimmed: "Older messages are past what wsp keeps.",
  /** "3 of 12", with a plus while more may come or where counting stopped. */
  count: (at: number, total: number, more: boolean): string => `${count.format(at)} of ${count.format(total)}${more ? "+" : ""}`,
} as const;
