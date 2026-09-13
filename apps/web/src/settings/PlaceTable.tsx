// SPDX-License-Identifier: AGPL-3.0-only
// The computers table, drawn once and read in two places: the Where agents run
// section, and the Add a computer sheet's joined screen, where the computer
// that just joined is the one row. Four columns and, where the caller has one,
// a last cell for the row's menu. A cell whose fact the computer has not
// reported yet holds a bar, so the table keeps its shape while it reports.
//
// Every column word and every cell rule is the protocol's: PLACES_WORDS.columns,
// fmtSize, fmtBytes, absentOf and placeWorkspacesCell, so the app and the
// command line read one table. How many workspaces stand on a row is the
// caller's to count, since only the app holds the workspace list a count is read
// off. The head is the shipped TableHead's own style, which is a tier above the
// zone label over the section.
import type { ReactNode } from "react";
import { PLACES_WORDS, fmtBytes, fmtSize, placeWorkspacesParts, type AbsentComputer, type PlaceView } from "@wsp/protocol";
import { Skeleton } from "../components/ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { cn } from "../lib/utils.js";
import { FACT, WHERE_WORDS } from "./format.js";
import { absentOf, isProviderPlace, placeCpuWord, placeName } from "./places.js";

const CELL = "font-mono text-xs tabular-nums text-foreground";
/** The name column is the one that gives: it takes what the three fact columns and the menu leave, and cuts the
 * name rather than pushing the table past the card it sits in. `max-w-0` is what makes a table cell yield at all,
 * and the cell hides its own overflow so a state word narrower than its slot is cut rather than painted over Size. */
const NAME_COLUMN = "w-full max-w-0";
/** The one column the mock right-aligns, since a disk figure is read against the one above it. */
const RIGHT = 2;

/** A cell whose fact the computer has not reported yet: the bar stands where the words will, so nothing moves. */
const Waiting = ({ right = false }: { right?: boolean }) => <Skeleton className={cn("h-3 w-16", right && "ml-auto")} />;

/** Whether this row is still waiting on the report its facts come in: a computer that has said nothing yet. A
 * provider reports none of them ever, so a bar there is a bar that never becomes a word. */
const waiting = (place: PlaceView): boolean => !isProviderPlace(place) && place.shape === undefined;

/** The table card: a hairline box around the shipped table and the four column words. */
export function PlaceTable({ children, menu = true, k = "places-table" }: { children: ReactNode; menu?: boolean; k?: string }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border">
      <Table data-k={k}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {PLACES_WORDS.columns.map((column, at) => (
              <TableHead key={column} className={cn(at === 0 && NAME_COLUMN, at === RIGHT && "text-right")}>
                {column}
              </TableHead>
            ))}
            {menu ? <TableHead className="w-10" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

/** How many workspaces stand on this row, and the note behind it: what it has cost this month, or that the
 * computer runs agents and no workspace of its own. The count is the figure a person is reading and stands in the
 * row's own ink; the note is the muted clause the mock draws behind it. */
function Workspaces({ place, count, monthUsd }: { place: PlaceView; count: number; monthUsd?: number }) {
  const parts = placeWorkspacesParts(place, count, monthUsd);
  return (
    <>
      {parts.count}
      {parts.note === undefined ? null : <span className="text-muted-foreground" data-k="workspaces-note">{` · ${parts.note}`}</span>}
    </>
  );
}

/** One computer or provider. The default mark rides beside the name and the state slot is the state's, so a
 * computer that is the default and is also away says both and no column moves when either word arrives.
 * The chevron, where the row opens, comes after them. */
export function PlaceRow({ place, now, workspaces = 0, monthUsd, here = false, absent: given, trail, menu, open, onToggle }: { place: PlaceView; now: number; /** How many workspaces stand on this row, counted off the app's own list by placeWorkspaceCounts. */ workspaces?: number; /** What this row has taken since the first of the month, where the host has metered anything on it. */ monthUsd?: number; /** Whether this is the computer the host runs on, which the list puts first. */ here?: boolean; /** The reading for a row whose silence is not its link's: the computer the host runs on holds no link and is read off its own workspace's daemon. */ absent?: AbsentComputer | null; /** The chevron after the state word, where the row opens. */ trail?: ReactNode; menu?: ReactNode; open?: boolean; onToggle?: () => void }) {
  const name = placeName(place, here);
  // The one reading of a computer that is not answering, which the sidebar row, the pane and the composer read
  // too: the slot beside the name holds the one word.
  const absent = given ?? absentOf(place, now, here);
  // The whole of what the cut cell says, and the sentence the state slot has no room for beside the fact columns.
  // A computer that is not answering is named by its own sentence, so the row does not say the name twice.
  const title = [absent?.sentence ?? name, place.default ? WHERE_WORDS.default : ""].filter(word => word !== "").join(" ");
  return (
    <TableRow
      data-place-row={place.id}
      title={title}
      {...(open === undefined ? {} : { "aria-expanded": open })}
      // Every row is the head's own height, whatever it carries: the rows with a menu button stood 6 px taller than
      // the one without, and a table of three heights is the first thing a person reads as wrong. The cells give up
      // their own padding to the row's height, so a 24 px button no longer sets it.
      className={cn("h-10 [&>td]:py-0", onToggle !== undefined && "cursor-pointer")}
      onClick={onToggle}
    >
      <TableCell className={cn(NAME_COLUMN, "overflow-hidden")}>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] text-foreground">{name}</span>
          {place.default ? (
            <span className={cn(FACT, "shrink-0")} data-k="place-default">
              {WHERE_WORDS.default}
            </span>
          ) : null}
          <span className={cn(FACT, "shrink-0")} data-k="place-state">
            {absent?.away ?? ""}
          </span>
          {trail}
        </span>
      </TableCell>
      <TableCell className={CELL}>{place.shape !== undefined ? fmtSize(place.shape, placeCpuWord(place)) : waiting(place) ? <Waiting /> : null}</TableCell>
      <TableCell className={cn(CELL, "text-right")}>{place.diskFreeBytes !== undefined ? fmtBytes(place.diskFreeBytes) : waiting(place) ? <Waiting right /> : null}</TableCell>
      {/* What this cell says is the caller's count and the host's total, neither of which the row reports, so it
          says them as soon as it has them rather than waiting on facts it does not use. */}
      <TableCell className={CELL}>{waiting(place) ? <Waiting /> : <Workspaces place={place} count={workspaces} monthUsd={monthUsd} />}</TableCell>
      {menu === undefined ? null : <TableCell className="text-right">{menu}</TableCell>}
    </TableRow>
  );
}
