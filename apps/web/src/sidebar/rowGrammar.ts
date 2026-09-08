// SPDX-License-Identifier: AGPL-3.0-only
// The one grammar the sidebar's rows share: the top rows' inset and hover,
// the muted mono every row's meta wears (a section row's count, a workspace
// row's state word and second line, a thread row's time and second line, a
// switcher card's thread title), the two-line row's height, and the leading
// slot the workspace dot and the thread glyph sit in so a title starts where
// a name starts, and the one id each row wears, which the keyboard traversal
// walks and the name box is opened by.
export const TOP_ROW_CLASS = "px-2 transition-[background-color,color] duration-150";
const ROW_META_GRAMMAR = "font-mono text-[11px] tabular-nums";
export const ROW_META_CLASS = `${ROW_META_GRAMMAR} text-[var(--top-row-meta)]`;
/** The same grammar for a meta line that carries a sentence instead of a figure: the counts' whisper is
 * read at a glance and sits under AA on purpose, prose has to be read and takes the ink that clears it. */
export const ROW_PROSE_CLASS = `${ROW_META_GRAMMAR} text-[var(--sidebar-prose)]`;
export const TWO_LINE_ROW_CLASS = "h-11 items-start py-1.5 text-left";
export const ROW_LEAD_CLASS = "mt-0.5 flex size-3.5 shrink-0 items-center justify-center";

export const workspaceRowId = (workspaceId: string): string => `ws:${workspaceId}`;
export const threadRowId = (threadId: string): string => `thread:${threadId}`;
