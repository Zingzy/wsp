// SPDX-License-Identifier: AGPL-3.0-only
// The computers table, drawn once and read in three places: the Where agents
// run section, and each Add a computer road's joined screen, where the computer
// that just joined is the one row. Four columns and a menu cell; a cell whose
// fact has not come in yet holds a skeleton bar, so the table keeps its shape
// while the computer reports. Every word and every cell comes from places.ts.
import type { ReactNode } from "react";
import type { PlaceView } from "@wsp/protocol";
import { Skeleton } from "../components/ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { cn } from "../lib/utils.js";
import { WHERE_WORDS } from "./format.js";
import { placeDiskFree, placeName, placeSize, placeStateWord, placeWorkspaces, type PlaceHolding } from "./places.js";

const CELL = "font-mono text-xs tabular-nums text-foreground";
const QUIET = "text-muted-foreground";

/** The table card: a hairline box around the shipped table, with the head row's four columns and, where rows carry
 * one, a last cell for the row's menu. */
export function PlaceTable({ children, menu = true }: { children: ReactNode; menu?: boolean }) {
  return (
    <div data-k="place-table" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{WHERE_WORDS.computer}</TableHead>
            <TableHead>{WHERE_WORDS.size}</TableHead>
            <TableHead className="text-right">{WHERE_WORDS.diskFree}</TableHead>
            <TableHead>{WHERE_WORDS.workspaces}</TableHead>
            {menu ? <TableHead className="w-10" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

/** One computer or provider. The name carries the state word in a mono slot beside it, so a word arriving or
 * leaving moves nothing; the three facts read as the protocol words them. */
export function PlaceRow({ place, holding, now, trail, menu, open, onToggle }: { place: PlaceView; holding: PlaceHolding; now: number; /** The chevron after the state word, where the row opens. */ trail?: ReactNode; menu?: ReactNode; open?: boolean; onToggle?: () => void }) {
  const state = placeStateWord(place, now);
  const size = placeSize(place);
  const disk = placeDiskFree(place);
  const { figure, note } = placeWorkspaces(place, holding);
  const name = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-xs text-foreground">{placeName(place)}</span>
      <span data-k="state" className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {state}
      </span>
      {trail}
    </span>
  );
  return (
    <TableRow data-k="place-row" data-place={place.id} {...(open === undefined ? {} : { "aria-expanded": open })} className={cn(onToggle !== undefined && "cursor-pointer")} onClick={onToggle}>
      <TableCell>{name}</TableCell>
      <TableCell className={CELL}>{size === "" ? <Skeleton className="h-3 w-22" /> : size}</TableCell>
      <TableCell className={cn(CELL, "text-right")}>{disk === "" ? <Skeleton className="ml-auto h-3 w-11" /> : disk}</TableCell>
      <TableCell className={CELL}>
        {figure}
        {note === "" ? null : <span className={QUIET}>{` · ${note}`}</span>}
      </TableCell>
      {menu === undefined ? null : <TableCell className="text-right">{menu}</TableCell>}
    </TableRow>
  );
}
