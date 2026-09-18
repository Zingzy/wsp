// SPDX-License-Identifier: AGPL-3.0-only
// The computers table, drawn once and read in two places: the Computers
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
import { absentOf, isProviderPlace, placeCpuWord, placeName, placeStateWord } from "./places.js";

const CELL = "font-mono text-xs tabular-nums text-foreground align-top";
/** The name column is the one that gives: it takes what the fact columns and the menu leave, and cuts the name
 * rather than pushing the table past the card it sits in. `max-w-0` is what makes a table cell yield at all, and
 * the cell hides its own overflow so a word narrower than its slot is cut rather than painted over Size. */
const NAME_COLUMN = "w-full max-w-0";
/** What each fact column is worth, written down rather than sized to what a row happens to hold: the Size header
 * stood 37 px apart between a table of one computer and a table of five, since a column that sizes itself moves
 * every column after it. A floor rather than a width, which a table whose first column asks for everything hands
 * back to that column: each is the widest thing its cell says, at the 12 px mono the cells wear (`10 cores ·
 * 16 GB`, `313.7 GB`, and a count with the month's figure under it). */
const FACT_COLUMNS = ["min-w-[132px]", "min-w-[76px]", "min-w-[112px]"];
/** The one column the mock right-aligns, since a disk figure is read against the one above it. */
const RIGHT = 2;
/** Which columns a phone holds, by their place in the protocol's own list. The rest leave the table below 640 px
 * so the column that names the computer has its width back, and the open row's detail says them instead: at 390
 * the four fact columns and the menu took 331 px of a 340 px card, so the name was cut to nothing and the card
 * scrolled sideways. Letting a third column leave is an entry off this list and nothing else. */
const NARROW_COLUMNS = [0, 3];
/** What a column that leaves wears, and what the row standing in for it in the detail wears. One pair, read by
 * the header, by every cell and by that row, so moving the breakpoint moves all three together. */
const WIDE_ONLY = "hidden sm:table-cell";
export const NARROW_ONLY = "sm:hidden";

/** Everything the column at this place in the protocol's list wears: the width it holds to, the side its figures
 * are read from, and the rule that takes it off a phone. The header and every cell read this one function, so a
 * column cannot leave in the head and stay in a row. */
export function columnClass(at: number): string {
  return cn(at === 0 ? NAME_COLUMN : FACT_COLUMNS[at - 1], at === RIGHT && "text-right", !NARROW_COLUMNS.includes(at) && WIDE_ONLY);
}

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
              <TableHead key={column} className={columnClass(at)}>
                {column}
              </TableHead>
            ))}
            {menu ? <TableHead className="min-w-10" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

/** How many workspaces stand on this row, and the note behind it: what it has cost this month, or the copy of the
 * image being built there. The count is the figure a person is reading and stands in the row's own ink; the note
 * is the muted clause the mock draws behind it. */
function Workspaces({ place, count, monthUsd }: { place: PlaceView; count: number; monthUsd?: number }) {
  const parts = placeWorkspacesParts(place, count, monthUsd);
  return (
    <>
      {parts.count}
      {/* On its own line under the count, where the row's second line already is: the month's figure in a cell as
          wide as the words it holds cannot be cut, and a column wide enough to hold it on one line would take the
          width the computer's own state word reads in. */}
      {parts.note === undefined ? null : (
        <span className="block text-muted-foreground" data-k="workspaces-note">
          {parts.note}
        </span>
      )}
    </>
  );
}

/** What a cell holds for a row the fact is not a fact of: a cloud account has no size and no disk of its own,
 * since every workspace there is asked for with its own. A hairline rather than a word or a dash: an empty cell
 * beside loaded rows reads as one still loading, a dash reads as zero, and the sentence belongs on the hover text
 * of the one row it is about. */
const NoFact = ({ right = false }: { right?: boolean }) => (
  <span data-k="no-fact" title={WHERE_WORDS.noFactOfACloud} className={cn("inline-block h-px w-3 bg-border align-middle", right && "float-right")} />
);

/** One computer or provider, two lines: the name with the default mark and the chevron on the first, the state
 * word on its own under them. A computer that is the default and is also away says both, and neither word moves a
 * column, since the columns hold to their own widths. */
export function PlaceRow({ place, now, workspaces = 0, monthUsd, here = false, absent: given, trail, menu, open, onToggle }: { place: PlaceView; now: number; /** How many workspaces stand on this row, counted off the app's own list by placeWorkspaceCounts. */ workspaces?: number; /** What this row has taken since the first of the month, where the host has metered anything on it. */ monthUsd?: number; /** Whether this is the computer the host runs on, which the list puts first. */ here?: boolean; /** The reading for a row whose silence is not its link's: the computer the host runs on holds no link and is read off its own workspace's daemon. */ absent?: AbsentComputer | null; /** The chevron after the state word, where the row opens. */ trail?: ReactNode; menu?: ReactNode; open?: boolean; onToggle?: () => void }) {
  const name = placeName(place, here);
  // The one reading of a computer that is not answering, which the sidebar row, the pane and the composer read
  // too: the row's state line says it in one word.
  const absent = given ?? absentOf(place, now, here);
  // The whole of what a cut name says, and the sentence the state line says in a word. A computer that is not
  // answering is named by its own sentence, so the row does not say the name twice.
  const title = [absent?.sentence ?? name, place.default ? WHERE_WORDS.default : ""].filter(word => word !== "").join(" ");
  return (
    <TableRow
      data-place-row={place.id}
      title={title}
      {...(open === undefined ? {} : { "aria-expanded": open })}
      // One height for every row of one table, whatever a row carries: the name line and the state slot under it
      // set it, both read off the lines they hold, and every cell takes the same padding so nothing else can.
      className={cn("[&>td]:py-2", onToggle !== undefined && "cursor-pointer")}
      onClick={onToggle}
    >
      <TableCell className={cn(columnClass(0), "overflow-hidden align-top")}>
        {/* One line, 20 px of the app's own scale, whatever stands on it: 13 px of name with room for an 11 px
            mono word beside it. Read off the line it holds rather than left to the tallest thing in it, since the
            default mark grew that line by two pixels and with it the whole row: the mark is centred against the
            name rather than sat on its baseline, which is what let a shorter word deepen the line. */}
        <span className="flex min-h-5 min-w-0 items-center gap-2 text-[13px] leading-5">
          <span className="truncate text-[13px] text-foreground">{name}</span>
          {place.default ? (
            <span className={cn(FACT, "shrink-0")} data-k="place-default">
              {WHERE_WORDS.default}
            </span>
          ) : null}
          {trail}
        </span>
        {/* The state word on its own line under the name, never beside it: what is being put on the computer and
            what failed by name is the word this screen exists for, and beside three fact columns it read as
            `7 tools, 1 file, 1 MCP serv…` with hover as the only road to the rest. The slot holds about 75
            characters in either window, which is a job naming five lost rows: two of its own lines where the
            column is 246 px wide and three where it is 168. The height is read off the line rather than written
            as a figure, so every row in one window is one height whether its word is long, short or absent, and
            the wrap is said here because the cell it stands in is nowrap for its fact columns. */}
        <span className={cn(FACT, "min-h-[3lh] line-clamp-3 whitespace-normal sm:min-h-[2lh] sm:line-clamp-2")} data-k="place-state" title={placeStateWord(place, absent)}>
          {placeStateWord(place, absent)}
        </span>
      </TableCell>
      <TableCell className={cn(CELL, columnClass(1))}>
        {place.shape !== undefined ? fmtSize(place.shape, placeCpuWord(place)) : waiting(place) ? <Waiting /> : isProviderPlace(place) ? <NoFact /> : null}
      </TableCell>
      <TableCell className={cn(CELL, columnClass(2))}>
        {place.diskFreeBytes !== undefined ? fmtBytes(place.diskFreeBytes) : waiting(place) ? <Waiting right /> : isProviderPlace(place) ? <NoFact right /> : null}
      </TableCell>
      {/* What this cell says is the caller's count and the host's total, neither of which the row reports, so it
          says them as soon as it has them rather than waiting on facts it does not use. */}
      <TableCell className={cn(CELL, columnClass(3))}>{waiting(place) ? <Waiting /> : <Workspaces place={place} count={workspaces} monthUsd={monthUsd} />}</TableCell>
      {menu === undefined ? null : <TableCell className="min-w-10 text-right align-top">{menu}</TableCell>}
    </TableRow>
  );
}
