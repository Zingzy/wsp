// SPDX-License-Identifier: AGPL-3.0-only
// The computers table, drawn once and read in two places: the Where agents run
// section, and the Add a computer sheet's joined screen, where the computer
// that just joined is the one row. Four columns and, where the caller has one,
// a last cell for the row's menu. A cell whose fact the computer has not
// reported yet holds a bar, so the table keeps its shape while it reports.
//
// Every column word and every cell rule is the protocol's: PLACES_WORDS.columns,
// fmtSize, fmtBytes, placeStateWord and placeWorkspacesCell, so the app and the
// command line read one table. How many workspaces stand on a row is the
// caller's to count, since only the app holds the workspace list a count is read
// off. The head is the shipped TableHead's own style, which is a tier above the
// zone label over the section.
import type { ReactNode } from "react";
import { PLACES_WORDS, fmtBytes, fmtSize, placeStateWord, placeWorkspacesCell, type PlaceView } from "@wsp/protocol";
import { Skeleton } from "../components/ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { cn } from "../lib/utils.js";
import { FACT, WHERE_WORDS } from "./format.js";
import { placeCpuWord, placeName } from "./places.js";

const CELL = "font-mono text-xs tabular-nums text-foreground";
/** The one column the mock right-aligns, since a disk figure is read against the one above it. */
const RIGHT = 2;

/** A cell whose fact the computer has not reported yet: the bar stands where the words will, so nothing moves. */
const Waiting = ({ right = false }: { right?: boolean }) => <Skeleton className={cn("h-3 w-16", right && "ml-auto")} />;

/** The table card: a hairline box around the shipped table and the four column words. */
export function PlaceTable({ children, menu = true, k = "places-table" }: { children: ReactNode; menu?: boolean; k?: string }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border">
      <Table data-k={k}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {PLACES_WORDS.columns.map((column, at) => (
              <TableHead key={column} className={cn(at === RIGHT && "text-right")}>
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

/** One computer or provider. The default mark rides beside the name and the state slot is the state's, so a
 * computer that is the default and is also away says both and no column moves when either word arrives.
 * The chevron, where the row opens, comes after them. */
export function PlaceRow({ place, now, workspaces = 0, here = false, trail, menu, open, onToggle }: { place: PlaceView; now: number; /** How many workspaces stand on this row, counted off the app's own list by placeWorkspaceCounts. */ workspaces?: number; /** Whether this is the computer the host runs on, which the list puts first. */ here?: boolean; /** The chevron after the state word, where the row opens. */ trail?: ReactNode; menu?: ReactNode; open?: boolean; onToggle?: () => void }) {
  return (
    <TableRow data-place-row={place.id} {...(open === undefined ? {} : { "aria-expanded": open })} className={cn(onToggle !== undefined && "cursor-pointer")} onClick={onToggle}>
      <TableCell>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] text-foreground">{placeName(place, here)}</span>
          {place.default ? (
            <span className={FACT} data-k="place-default">
              {WHERE_WORDS.default}
            </span>
          ) : null}
          <span className={FACT} data-k="place-state">
            {placeStateWord(place, now)}
          </span>
          {trail}
        </span>
      </TableCell>
      <TableCell className={CELL}>{place.shape === undefined ? <Waiting /> : fmtSize(place.shape, placeCpuWord(place))}</TableCell>
      <TableCell className={cn(CELL, "text-right")}>{place.diskFreeBytes === undefined ? <Waiting right /> : fmtBytes(place.diskFreeBytes)}</TableCell>
      <TableCell className={CELL}>{place.shape === undefined ? <Waiting /> : placeWorkspacesCell(place, workspaces)}</TableCell>
      {menu === undefined ? null : <TableCell className="text-right">{menu}</TableCell>}
    </TableRow>
  );
}
