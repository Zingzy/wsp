// SPDX-License-Identifier: AGPL-3.0-only
// The Settings section that lists every computer this wsp runs on: this one
// first, then each computer somebody joined, then the provider it forks on.
// One table in a hairline card, and under it the two ways to add another. No
// detail, no row menu and no Remove here: wsp remove is the road for now.
import { PLACES_WORDS, fmtBytes, fmtSize, placeStateWord, placeWorkspacesCell, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { FACT, ZONE_LABEL } from "./format.js";

const CELL = "font-mono text-xs tabular-nums text-foreground";

/** A cell whose fact the computer has not reported yet: the bar stands where the words will, so nothing moves. */
function Waiting() {
  return <Skeleton className="h-3 w-16" />;
}

/** The default mark rides beside the name and the state slot is the state's: a computer that is the default and is
 * also away has both to say, and the slot is where the word that changes lives. */
const DEFAULT_MARK = "default";

export function WhereAgentsRun({ now = Date.now() }: { now?: number }) {
  const places = useStore(s => s.places);
  const openAddComputer = useStore(s => s.openAddComputer);
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-[10px] border border-border">
        <Table data-k="places-table">
          <TableHeader>
            <TableRow>
              {PLACES_WORDS.columns.map(column => (
                <TableHead key={column} className={cn(ZONE_LABEL, "font-normal")}>
                  {column}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {places.map(place => (
              <TableRow key={place.id} data-place-row={place.id}>
                <TableCell>
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] text-foreground">{place.name}</span>
                    {place.default ? (
                      <span className={FACT} data-k="place-default">
                        {DEFAULT_MARK}
                      </span>
                    ) : null}
                    <span className={FACT} data-k="place-state">
                      {placeStateWord(place, now)}
                    </span>
                  </span>
                </TableCell>
                <TableCell className={CELL}>{place.shape === undefined ? <Waiting /> : fmtSize(place.shape, place.kind === "computer" ? "cores" : "vCPU")}</TableCell>
                <TableCell className={CELL}>{place.diskFreeBytes === undefined ? <Waiting /> : fmtBytes(place.diskFreeBytes)}</TableCell>
                <TableCell className={CELL}>{place.shape === undefined ? <Waiting /> : placeWorkspacesCell(place)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex gap-2">
        <Button size="xs" variant="outline" data-k="add-computer-button" onClick={openAddComputer}>
          {PLACES_WORDS.addComputer}
        </Button>
        <Button size="xs" variant="outline" disabled title={PLACES_WORDS.connectProviderHeld}>
          {PLACES_WORDS.connectProvider}
        </Button>
      </div>
    </div>
  );
}
