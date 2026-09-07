// SPDX-License-Identifier: AGPL-3.0-only
// The one grammar the sidebar's rows share: the top rows' inset and hover,
// the muted mono every row's meta wears (a section row's count, a workspace
// row's state word and second line, a thread row's time and second line, a
// switcher card's thread title), the two-line row's height, and the leading
// slot the workspace dot and the thread glyph sit in so a title starts where
// a name starts.
export const TOP_ROW_CLASS = "px-2 transition-[background-color,color] duration-150";
export const ROW_META_CLASS = "font-mono text-[11px] text-[var(--top-row-meta)] tabular-nums";
export const TWO_LINE_ROW_CLASS = "h-11 items-start py-1.5 text-left";
export const ROW_LEAD_CLASS = "mt-0.5 flex size-3.5 shrink-0 items-center justify-center";
