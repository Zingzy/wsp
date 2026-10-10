// SPDX-License-Identifier: AGPL-3.0-only
// The find bar's state over one transcript: what is typed, every match it finds, which one is current, the folds that
// open to show it, and the paint over what is on screen.
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { DeriveRowsInput, MessagesTimelineRow } from "../adapt";
import { bringIntoView, findMatches, findRanges, findUnits, FindTarget, nthInUnit, paintFind, type FindMatches, type FindUnit } from "./find";
import { showTranscript, useThreadFind } from "../threadFind";

/** The current match by the unit it stands in and which of that unit's matches it is, so it keeps its place while
 * rows arrive above it. */
interface At {
  readonly key: string;
  readonly nth: number;
}

/** Where a match stands in reading order. */
interface Place {
  readonly order: number;
  readonly offset: number;
}

const before = (a: Place, b: Place): boolean => a.order < b.order || (a.order === b.order && a.offset < b.offset);

/** Frames a reveal waits for its rows to open and draw before it gives up. */
const REVEAL_FRAMES = 60;

export interface TranscriptFind {
  readonly open: boolean;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  /** The 1-based place of the current match, 0 with none. */
  readonly current: number;
  readonly total: number;
  readonly step: (by: 1 | -1) => void;
  readonly close: () => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly target: FindTarget;
}

export function useTranscriptFind({
  input,
  workspaceRoot,
  rowsRef,
  listRef,
  viewport,
  openTurn,
  openGroup,
  readOlder,
}: {
  input: DeriveRowsInput;
  workspaceRoot: string | undefined;
  rowsRef: RefObject<readonly MessagesTimelineRow[]>;
  listRef: RefObject<LegendListRef | null>;
  viewport: HTMLElement | null;
  openTurn: (turnId: string) => void;
  openGroup: (groupId: string) => void;
  /** Reads the thread's next older page, answering whether one is left after it. */
  readOlder: (() => Promise<boolean> | void) | undefined;
}): TranscriptFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = useDeferredValue(query);
  const [target] = useState(() => new FindTarget());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focusAsked, setFocusAsked] = useState(0);
  const returnFocus = useRef<Element | null>(null);

  useEffect(showTranscript, []);
  useEffect(
    () =>
      useThreadFind.subscribe((now, was) => {
        if (now.asked === was.asked) return;
        if (!inputRef.current?.isConnected) returnFocus.current = document.activeElement;
        setOpen(true);
        setFocusAsked(n => n + 1);
      }),
    [],
  );
  useLayoutEffect(() => {
    if (focusAsked === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusAsked]);

  const units = useMemo(() => (open ? findUnits(input, workspaceRoot) : []), [open, input, workspaceRoot]);
  const unitIndex = useMemo(() => new Map(units.map((unit, index) => [unit.key, index])), [units]);
  const matches = useMemo(() => findMatches(units, needle), [units, needle]);

  const [at, setAt] = useState<At | null>(null);
  const [seen, setSeen] = useState<FindMatches | null>(null);
  const placeRef = useRef<Place | null>(null);
  const [revealAsked, setRevealAsked] = useState(0);
  // New matches keep the current one where it still stands; otherwise the first at or after where the reader was.
  if (seen !== matches) {
    setSeen(matches);
    if (indexOfAt(matches, unitIndex, at) < 0) {
      const from = placeRef.current ?? topPlace(listRef.current, units);
      const index = firstFrom(matches, units, from);
      setAt(index < 0 ? null : atOf(matches, units, index));
      setRevealAsked(n => n + 1);
    }
  }
  const index = indexOfAt(matches, unitIndex, at);
  const unit = index < 0 ? null : units[matches.unit[index]!]!;
  if (unit !== null) placeRef.current = { order: unit.order, offset: matches.at[index]! };

  const step = useCallback(
    (by: 1 | -1) => {
      const total = matches.unit.length;
      if (total === 0) return;
      const next = ((index < 0 ? (by === 1 ? -1 : 0) : index) + by + total) % total;
      setAt(atOf(matches, units, next));
      setRevealAsked(n => n + 1);
    },
    [index, matches, units],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setAt(null);
    placeRef.current = null;
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  }, []);

  // The whole thread is searched, not the pages read so far: older pages come in while there is something to find.
  const searching = open && needle.length > 0;
  useEffect(() => {
    if (!searching || readOlder === undefined) return;
    let live = true;
    void (async () => {
      while (live && (await readOlder()) === true);
    })();
    return () => {
      live = false;
    };
  }, [searching, readOlder]);

  const currentRef = useRef<{ at: At | null; needle: string }>({ at, needle });
  currentRef.current = { at, needle };

  // The current match's folds open, its row comes into the list's window, its tool group scrolls to it, and the page
  // scrolls until it stands in view.
  useEffect(() => {
    target.set(open && at !== null ? at.key : null);
    if (!open || at === null || unit === null || viewport === null) return;
    if (unit.turnId !== null) openTurn(unit.turnId);
    if (unit.groupId !== null) openGroup(unit.groupId);
    let frame = 0;
    let waited = 0;
    let scrolled = false;
    let grouped = unit.groupId === null;
    const tick = (): void => {
      if (++waited > REVEAL_FRAMES) return;
      const element = [...viewport.querySelectorAll("[data-find-unit]")].find(e => e.getAttribute("data-find-unit") === unit.key) ?? null;
      if (element === null && !scrolled) {
        const row = rowsRef.current.findIndex(r => r.id === unit.rowId);
        if (row >= 0) {
          scrolled = true;
          void listRef.current?.scrollToIndex({ index: row, animated: false, viewPosition: 0.4 });
        }
      }
      if (!grouped) grouped = target.groups.get(unit.rowId)?.(unit.key) === true;
      if (element !== null) {
        const ranges = findRanges(element, needle, at);
        const scroller = listRef.current?.getScrollableNode();
        if (ranges.current !== null && scroller instanceof HTMLElement) {
          bringIntoView(ranges.current, scroller);
          paintFind(findRanges(viewport, needle, at));
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // A reveal runs when the current match moves or a step asks for it again, not when its unit's text grows.
  }, [open, at?.key, at?.nth, revealAsked, viewport]);

  // What is on screen is painted again whenever the page's rows change under it: the list's window moving, a fold
  // opening, a streamed chunk.
  useEffect(() => {
    if (!open || viewport === null) return;
    let frame = 0;
    const paint = (): void => {
      frame = 0;
      const { at: now, needle: words } = currentRef.current;
      paintFind(findRanges(viewport, words, now));
    };
    paint();
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    });
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      paintFind(null);
    };
  }, [open, viewport, needle, at]);

  useEffect(() => () => target.set(null), [target]);

  return { open, query, setQuery, current: index + 1, total: matches.unit.length, step, close, inputRef, target };
}

function indexOfAt(matches: FindMatches, unitIndex: ReadonlyMap<string, number>, at: At | null): number {
  if (at === null) return -1;
  const unit = unitIndex.get(at.key);
  if (unit === undefined) return -1;
  let low = 0;
  let high = matches.unit.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (matches.unit[mid]! < unit) low = mid + 1;
    else high = mid;
  }
  const index = low + at.nth;
  return matches.unit[index] === unit ? index : -1;
}

function atOf(matches: FindMatches, units: readonly FindUnit[], index: number): At {
  return { key: units[matches.unit[index]!]!.key, nth: nthInUnit(matches, index) };
}

/** The first match at or after `from`, wrapping to the first of all; -1 with none. */
function firstFrom(matches: FindMatches, units: readonly FindUnit[], from: Place | null): number {
  if (matches.unit.length === 0) return -1;
  if (from === null) return 0;
  for (let i = 0; i < matches.unit.length; i++) {
    if (!before({ order: units[matches.unit[i]!]!.order, offset: matches.at[i]! }, from)) return i;
  }
  return 0;
}

/** Where the reader is: the first unit at or after the top row the list draws. */
function topPlace(list: LegendListRef | null, units: readonly FindUnit[]): Place | null {
  const state = list?.getState?.();
  if (state === undefined) return null;
  const orders = new Map(units.map(unit => [unit.rowId, unit.order]));
  for (let i = state.start; i < state.data.length; i++) {
    const order = orders.get((state.data[i] as MessagesTimelineRow).id);
    if (order !== undefined) return { order, offset: 0 };
  }
  return null;
}
