// SPDX-License-Identifier: AGPL-3.0-only
// The one clamp a long block of text takes: the last lines fade out over a band and the toggle stands in its clear
// bottom, so it ends in words going to nothing rather than a hard edge. A person's message bubble and the pull
// request pane's body both read from here, so the fade and the rule live once.

/** Fades the last lines over the band the toggle stands clear of. */
export const CLAMP_FADE_MASK = "linear-gradient(to bottom, black calc(100% - 5rem), transparent calc(100% - 1.5rem))";

const MAX_CLAMPED_LINES = 8;
const MAX_CLAMPED_LENGTH = 600;

/** Whether a block is long enough to clamp, read off its own text so the rule is stable across renders. */
export function shouldClampText(text: string): boolean {
  if (text.trim().length === 0) return false;
  return text.length > MAX_CLAMPED_LENGTH || text.split("\n").length > MAX_CLAMPED_LINES;
}
