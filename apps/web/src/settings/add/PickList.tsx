// SPDX-License-Identifier: AGPL-3.0-only
// One pick list, drawn the same way on every step that ticks rows: a filter,
// the order the rows stand in, and select all, none and invert over the rows
// the filter leaves, then the rows in the settings card. A shift-click ticks
// or clears every row from the one clicked before to this one, as this one
// went.
import { useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { cn } from "../../lib/utils.js";
import { Grid } from "../grid.js";
import { CARD_INSET, NOTE, ROW_FIELD, SELECT_WIDTH } from "../layout.js";

/** A row as the list orders, filters and ticks it: its key in the picks, the name it is filtered and sorted by, and
 * whether the picks hold it. */
export interface PickItem {
  key: string;
  name: string;
  on: boolean;
}

/** Each row's new tick, by key. */
export type PickChanges = readonly (readonly [string, boolean])[];

type Order = "own" | "name" | "ticked";

/** The words on a row's hover: what a shift-click does. */
export const RANGE_HOVER = "Shift-click to tick or clear every row from the last one you clicked.";

/** The rows in the order picked. Ticked first stands as the rows were ticked when the person picked it, `held`, the
 * order they saw before it kept among each, so a tick moves no row and a shift-click ranges over the rows as shown. */
function ordered<T extends PickItem>(items: readonly T[], order: Order, held: readonly string[]): T[] {
  if (order === "name") return [...items].sort((a, b) => a.name.localeCompare(b.name));
  if (order === "own") return [...items];
  const at = new Map(held.map((key, i) => [key, i]));
  return [...items].sort((a, b) => (at.get(a.key) ?? held.length) - (at.get(b.key) ?? held.length));
}

/** `own` names the order the rows come in where it is not by name (Most used, or as found); a list whose rows arrive
 * by name leaves it out and opens on Name. `tools` false draws the rows alone, for a list that only shows what a
 * recipe holds. `row` draws one row with the tick that goes through the list, so a shift-click reaches its range. */
export function PickList<T extends PickItem>({ id, items, onSet, row, own, tools = true, children }: { id: string; items: readonly T[]; onSet: (changes: PickChanges) => void; row: (item: T, tick: (next: boolean) => void) => ReactNode; own?: string; tools?: boolean; children?: ReactNode }) {
  const [filter, setFilter] = useState("");
  const [order, setOrder] = useState<Order>(own === undefined ? "name" : "own");
  const [held, setHeld] = useState<readonly string[]>([]);
  const shift = useRef(false);
  const anchor = useRef<string | null>(null);
  const words = filter.trim().toLowerCase();
  const shown = ordered(
    items.filter(item => words === "" || item.name.toLowerCase().includes(words) || item.key.toLowerCase().includes(words)),
    order,
    held,
  );
  const tick = (item: T, next: boolean): void => {
    const from = shift.current && anchor.current !== null ? shown.findIndex(i => i.key === anchor.current) : -1;
    const to = shown.findIndex(i => i.key === item.key);
    anchor.current = item.key;
    shift.current = false;
    const range = from === -1 || to === -1 ? [item] : shown.slice(Math.min(from, to), Math.max(from, to) + 1);
    onSet(range.map(i => [i.key, next] as const));
  };
  const orderWords: Partial<Record<Order, string>> = { ...(own === undefined ? {} : { own }), name: "Name", ticked: "Ticked first" };
  const pickOrder = (next: Order): void => {
    setOrder(next);
    setHeld(next === "ticked" ? ordered(items, order, held).sort((a, b) => Number(b.on) - Number(a.on)).map(i => i.key) : []);
  };
  return (
    <div data-pick-list={id} className="flex flex-col gap-3">
      {tools ? (
        // Below 640 px the filter takes its own full-width line under the other controls rather than squeezing beside them.
        <div data-pick-tools className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
          <Input data-k="pick-filter" aria-label="Filter" nativeInput type="search" autoComplete="off" spellCheck={false} value={filter} placeholder="Filter" onChange={e => setFilter(e.target.value)} className={cn(ROW_FIELD, "min-w-0 sm:flex-1")} />
          <div className="flex items-center gap-2">
            <Select value={order} onValueChange={next => pickOrder(next as Order)}>
              <SelectTrigger size="sm" data-k="pick-order" aria-label="Order" className={SELECT_WIDTH}>
                <SelectValue>{(value: Order) => orderWords[value]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(orderWords) as Order[]).map(o => (
                  <SelectItem key={o} value={o}>
                    {orderWords[o]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button size="xs" variant="outline" data-k="pick-all" onClick={() => onSet(shown.filter(i => !i.on).map(i => [i.key, true] as const))}>
              All
            </Button>
            <Button size="xs" variant="outline" data-k="pick-none" onClick={() => onSet(shown.filter(i => i.on).map(i => [i.key, false] as const))}>
              None
            </Button>
            <Button size="xs" variant="outline" data-k="pick-invert" onClick={() => onSet(shown.map(i => [i.key, !i.on] as const))}>
              Invert
            </Button>
          </div>
        </div>
      ) : null}
      <div
        className="contents"
        onMouseDownCapture={e => {
          shift.current = e.shiftKey;
          // A shift-press on a row's words would select text from the last press; the click still ticks.
          if (e.shiftKey) e.preventDefault();
        }}
        onKeyDownCapture={e => {
          shift.current = e.shiftKey;
        }}
      >
        <Grid id={id}>
          {shown.map(item => row(item, next => tick(item, next)))}
          {shown.length === 0 && items.length > 0 ? (
            <div data-k="pick-none-match" className={cn("flex min-h-12 items-center py-3", CARD_INSET)}>
              <span className={NOTE}>No row matches {filter.trim()}.</span>
            </div>
          ) : null}
          {children}
        </Grid>
      </div>
    </div>
  );
}
