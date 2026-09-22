// SPDX-License-Identifier: AGPL-3.0-only
// The one grammar the sidebar's rows share: the rows' inset and hover, the
// muted mono every machine word wears (a count, a branch, a time, a computer's
// name), the prose ink a state word or a sentence takes, the one-line row and
// the two-line row, the lead slot a mark or a spinner sits in, the tree's child
// list and the rail each of its items draws, and the one id each row wears,
// which the keyboard traversal walks and the name box is opened by.

export const TOP_ROW_CLASS = "px-2 transition-[background-color,color] duration-150";
const ROW_META_GRAMMAR = "font-mono text-[11px] tabular-nums";
export const ROW_META_CLASS = `${ROW_META_GRAMMAR} text-[var(--top-row-meta)]`;
/** The same grammar for a word a person reads rather than glances at: a state word or a sentence. The counts'
 * whisper sits under AA on purpose; a word that has to be read takes the ink that clears it. */
export const ROW_PROSE_CLASS = `${ROW_META_GRAMMAR} text-[var(--sidebar-prose)]`;
/** Every row's text: the sans at 13 px, the kit's medium weight kept for the one selected row. A project row, the
 * search row and the head read in the rest ink; a workspace's name and a working thread's title take the sidebar's
 * foreground, since the rest ink on the dark side sits under the muted ink a settled title wears. */
const ROW_TEXT_CLASS = "text-[13px] font-normal";
/** A one-line row: the search row, the switcher head, a project, a thread, a fold, a leaf. 28 px whatever its words. */
export const ONE_LINE_ROW_CLASS = `h-7 gap-2 rounded-[var(--control-radius)] px-2 py-0 text-left ${ROW_TEXT_CLASS}`;
/** A two-line row: a workspace, a creation. 44 px: the first line is a one-line row's height, so the tree's tick
 * lands on it as on every other row, and the second line takes the rest. */
export const TWO_LINE_ROW_CLASS = `h-11 items-start gap-2 rounded-[var(--control-radius)] px-2 py-0 text-left ${ROW_TEXT_CLASS}`;
export const TWO_LINE_FIRST_CLASS = "flex h-7 items-center gap-2";
export const TWO_LINE_SECOND_CLASS = "flex h-4 items-center leading-4";
export const ROW_LEAD_CLASS = "flex size-3.5 shrink-0 items-center justify-center";
/** A row whose frame puts glyphs beside it on hover keeps its text running to its own inset: the glyphs land in the
 * slot at the row's right edge, where the word or the count yields to them, rather than taking room off the row. */
export const GLYPH_ROW_CLASS = "group-has-data-[sidebar=menu-action]/menu-item:pe-2";

/** A child list of the tree: 15 px in, so its rail runs under the centre of the parent's lead (the 8 px inset plus
 * half the 14 px mark), no gap between rows, so the rail segments read as one line. */
export const CHILD_LIST_CLASS = "ml-[15px] flex min-w-0 flex-col";
/** One item of a child list: the rail down its left edge for its whole height, a tick into its row's first line,
 * and the rail stopping at that tick on the last item, which is the elbow. Its row starts 1 px in, past the rail. */
export const RAIL_ITEM_CLASS =
  "relative pl-px before:absolute before:top-0 before:left-0 before:h-full before:w-px before:bg-sidebar-border last:before:h-[14px] after:absolute after:top-[14px] after:left-0 after:h-px after:w-1.5 after:bg-sidebar-border";

/** The sidebar footer's own row: 28 px, muted mono, the whole width. Every row in the foot wears it, so the foot
 * reads as one column whether the row is a button or a line with a link at its edge. */
export const FOOT_ROW_GRAMMAR = "flex h-7 w-full items-center gap-1.5 rounded-md px-2 font-mono text-[11px] text-sidebar-muted-foreground";
/** A foot row the whole width of which is pressed, with the same hover and focus every other row wears. The host
 * switcher and the Settings row are both one of these. */
export const FOOT_ROW_CLASS = `${FOOT_ROW_GRAMMAR} transition-colors duration-150 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`;

export const workspaceRowId = (workspaceId: string): string => `ws:${workspaceId}`;
/** A project's row, which the keyboard walks like every other and a test and a screenshot step name it by. */
export const projectRowK = (projectId: string): string => `project:${projectId}`;
export const threadRowId = (threadId: string): string => `thread:${threadId}`;
/** The header over a group of one workspace's thread rows: the idle shelf, and the archive nested inside it. */
export const groupRowId = (group: "settled" | "archived", workspaceId: string): string => `${group}:${workspaceId}`;
