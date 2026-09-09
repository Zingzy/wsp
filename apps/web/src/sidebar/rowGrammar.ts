// SPDX-License-Identifier: AGPL-3.0-only
// The one grammar the sidebar's rows share: the top rows' inset and hover,
// the muted mono every row's meta wears (a section row's count, a workspace
// row's state word and lines under it, a thread row's time and second line, a
// switcher card's thread title), the three-line workspace row's height and the
// two-line thread row's, the leading slot the workspace kind's glyph sits in,
// and the one id each row wears, which the keyboard traversal walks and the
// name box is opened by.
export const TOP_ROW_CLASS = "px-2 transition-[background-color,color] duration-150";
const ROW_META_GRAMMAR = "font-mono text-[11px] tabular-nums";
export const ROW_META_CLASS = `${ROW_META_GRAMMAR} text-[var(--top-row-meta)]`;
/** The same grammar for a meta line that carries a sentence instead of a figure: the counts' whisper is
 * read at a glance and sits under AA on purpose, prose has to be read and takes the ink that clears it. */
export const ROW_PROSE_CLASS = `${ROW_META_GRAMMAR} text-[var(--sidebar-prose)]`;
export const TWO_LINE_ROW_CLASS = "h-11 items-start py-1.5 text-left";
/** A workspace row: name, the machine, what it cost, one fixed slot each, so every row has one shape and height. */
export const THREE_LINE_ROW_CLASS = "h-15 items-start py-1.5 text-left";
export const ROW_LEAD_CLASS = "mt-0.5 flex size-3.5 shrink-0 items-center justify-center";

export const workspaceRowId = (workspaceId: string): string => `ws:${workspaceId}`;
export const threadRowId = (threadId: string): string => `thread:${threadId}`;
/** The header over a group of one workspace's thread rows: the idle shelf, and the archive nested inside it. */
export const groupRowId = (group: "settled" | "archived", workspaceId: string): string => `${group}:${workspaceId}`;
