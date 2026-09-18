// SPDX-License-Identifier: AGPL-3.0-only
// The one grammar the sidebar's rows share: the top rows' inset and hover,
// the muted mono every row's meta wears (a section row's count, a workspace
// row's state word and lines under it, a thread row's time and second line, a
// switcher card's thread title), the three-line workspace row's height and the
// two-line thread row's, the leading slot the workspace kind's glyph sits in,
// and the one id each row wears, which the keyboard traversal walks and the
// name box is opened by.
import { TWO_LINE_SLOT } from "../settings/format.js";

export const TOP_ROW_CLASS = "px-2 transition-[background-color,color] duration-150";
const ROW_META_GRAMMAR = "font-mono text-[11px] tabular-nums";
export const ROW_META_CLASS = `${ROW_META_GRAMMAR} text-[var(--top-row-meta)]`;
/** The same grammar for a meta line that carries a sentence instead of a figure: the counts' whisper is
 * read at a glance and sits under AA on purpose, prose has to be read and takes the ink that clears it. */
export const ROW_PROSE_CLASS = `${ROW_META_GRAMMAR} text-[var(--sidebar-prose)]`;
export const TWO_LINE_ROW_CLASS = "h-11 items-start py-1.5 text-left";
/** A workspace row: the name, what it is made of, and the branch or the one sentence it is waiting on. Four lines
 * of room for three slots, since the made-of line takes two of them at the sidebar's width: the words that say
 * what a copy is and whose ports it has are the row's own, and cut to one line the ports half was the first thing
 * a 256 px sidebar dropped. Fixed, so every row has one shape and one height whatever its words. */
export const THREE_LINE_ROW_CLASS = "h-20 items-start py-1.5 text-left";
/** The made-of line's own slot: the two-line slot every fact that may wrap wears, held at that height whether the
 * words take one line or two. The row's column is a truncating one for the name's sake, so the wrap is turned back
 * on here or the line would be cut at the first space past the edge. */
export const ROW_MADE_OF_SLOT = `${TWO_LINE_SLOT} whitespace-normal`;
export const ROW_LEAD_CLASS = "mt-0.5 flex size-3.5 shrink-0 items-center justify-center";

/** The sidebar footer's own row: 28 px, muted mono, the whole width. Every row in the foot wears it, so the foot
 * reads as one column whether the row is a button or a line with a link at its edge. */
export const FOOT_ROW_GRAMMAR = "flex h-7 w-full items-center gap-1.5 rounded-md px-2 font-mono text-[11px] text-sidebar-muted-foreground";
/** A foot row the whole width of which is pressed, with the same hover and focus every other row wears. The host
 * switcher and the Settings row are both one of these. */
export const FOOT_ROW_CLASS = `${FOOT_ROW_GRAMMAR} transition-colors duration-150 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`;

export const workspaceRowId = (workspaceId: string): string => `ws:${workspaceId}`;
/** A project's header row, which the keyboard does not walk and a test and a screenshot step name it by. */
export const projectRowK = (projectId: string): string => `project:${projectId}`;
export const threadRowId = (threadId: string): string => `thread:${threadId}`;
/** The header over a group of one workspace's thread rows: the idle shelf, and the archive nested inside it. */
export const groupRowId = (group: "settled" | "archived", workspaceId: string): string => `${group}:${workspaceId}`;
