// SPDX-License-Identifier: AGPL-3.0-only
// The tree's connector, one rule for every tree in the sidebar and for the lead's Threads block. A child list stands
// so its line falls under the centre of the parent's mark (every mark is 12 px at 8 px in, so 13 px from the parent
// row's edge), and each child sits 8 px past the line. Each item draws its own part, and no column is drawn twice:
// the elbow (::after) is an L from the top of the item into its row at the row's mark line, its corner rounded; on
// every item but the last the line (::before) carries on from where that corner starts down to the item's foot,
// where the next item's elbow takes it up. Both are borders, never a background, so the browser snaps them to the
// same device column at any zoom; a background line beside a border elbow landed one column apart under browser
// zoom and read as one bold bar (312-double-rail.png). The mark line is 35 px on a tile (its title row) and 18 px on
// a one-line row, which the item says with data-slim; no item reads its children. Both places draw it in the
// sidebar rail's ink, so it is one line wherever a tree stands. ?rail=guide draws the line alone with no elbows.
const guide = new URLSearchParams(window.location.search).get("rail") === "guide";

/** A child list in the sidebar: its line under the parent's mark. */
export const CHILD_LIST = "ml-[13px] flex min-w-0 flex-col";

const SIDEBAR_ELBOW =
  "relative min-w-0 pl-2 [--mark-y:35px] data-[slim]:[--mark-y:18px] before:pointer-events-none before:absolute before:top-[calc(var(--mark-y)-5px)] before:bottom-0 before:left-0 before:w-0 before:border-l before:border-[var(--sidebar-rail)] last:before:hidden after:pointer-events-none after:absolute after:top-0 after:left-0 after:h-[calc(var(--mark-y)+1px)] after:w-2 after:rounded-bl-[6px] after:border-b after:border-l after:border-[var(--sidebar-rail)]";
const SIDEBAR_GUIDE = "relative min-w-0 pl-2 before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-0 before:border-l before:border-[var(--sidebar-rail)]";

/** One item of a sidebar child list. */
export const RAIL_ITEM = guide ? SIDEBAR_GUIDE : SIDEBAR_ELBOW;

/** A child list in the transcript: the transcript's mark is 13 px at 8 px in, so its centre is 14 px in. */
export const TRANSCRIPT_LIST = "ml-[14px] flex min-w-0 flex-col";

const TRANSCRIPT_ELBOW =
  "relative min-w-0 pl-2 [--mark-y:18px] data-[two]:[--mark-y:24px] before:pointer-events-none before:absolute before:top-[calc(var(--mark-y)-5px)] before:bottom-0 before:left-0 before:w-0 before:border-l before:border-[var(--sidebar-rail)] last:before:hidden after:pointer-events-none after:absolute after:top-0 after:left-0 after:h-[calc(var(--mark-y)+1px)] after:w-2 after:rounded-bl-[6px] after:border-b after:border-l after:border-[var(--sidebar-rail)]";
const TRANSCRIPT_GUIDE = "relative min-w-0 pl-2 before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-0 before:border-l before:border-[var(--sidebar-rail)]";

/** One item of a transcript child list; data-two on a row with a note, whose mark stands at its middle. */
export const TRANSCRIPT_ITEM = guide ? TRANSCRIPT_GUIDE : TRANSCRIPT_ELBOW;
