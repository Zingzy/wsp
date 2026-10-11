// SPDX-License-Identifier: AGPL-3.0-only
// Find in thread's own state, outside any one view: the bar keeps its query and its toggles when the person moves to
// another thread, and the key commands reach it from the dispatcher. The rows read `reveal` alone: a fold, a clamped
// message or a tool row that holds the current match opens itself when it names that row.
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { FindMatch } from "./search";

export type FindToggle = "matchCase" | "wholeWord" | "regex" | "tools";

/** The last ask to focus the bar that a bar took, so a bar drawn again after a thread switch does not take focus. */
let focusTaken = 0;
export function takeFocusAsk(ask: number): boolean {
  if (ask === focusTaken) return false;
  focusTaken = ask;
  return true;
}

export interface ThreadFindState {
  readonly open: boolean;
  readonly query: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
  readonly tools: boolean;
  /** Moves each time the bar is asked to take focus and select its text. */
  readonly focusAsk: number;
  /** The match whose row must open to show it, with a count that moves on each step so a row opens again. */
  readonly reveal: (FindMatch & { readonly ask: number }) | null;
}

const CLOSED: ThreadFindState = { open: false, query: "", matchCase: false, wholeWord: false, regex: false, tools: false, focusAsk: 0, reveal: null };

export const useThreadFind = create<ThreadFindState>(() => CLOSED);

/** The thread on screen that find searches, set by the view while it draws a transcript. */
export interface FindTarget {
  /** Whether a selection lies in this transcript, for seeding the query. */
  holds(node: Node): boolean;
  step(direction: -1 | 1): void;
}

let target: FindTarget | null = null;

/** Registers the thread find searches until the returned call lets it go. */
export function findTargetIs(next: FindTarget): () => void {
  target = next;
  return () => {
    if (target === next) target = null;
  };
}

/** A thread's transcript is on screen: the context key `threadOpen` reads this. */
export const threadOnScreen = (): boolean => target !== null;

/** The bar is open over a thread on screen: the context key `threadFindOpen`. */
export const threadFindOpen = (): boolean => target !== null && useThreadFind.getState().open;

/** Where focus stood when the bar opened, so Escape can hand it back. */
let returnTo: Element | null = null;
export const focusBeforeFind = (): Element | null => returnTo;

const SEED_MAX = 200;

/** Opens the bar, or focuses it again with its text selected. A selection inside the transcript seeds the query. */
export function openThreadFind(): void {
  if (target === null) return;
  const state = useThreadFind.getState();
  if (!state.open) returnTo = document.activeElement;
  const selection = window.getSelection();
  const anchor = selection?.anchorNode ?? null;
  const picked = selection !== null && !selection.isCollapsed && anchor !== null && target.holds(anchor) ? selection.toString().trim() : "";
  const seed = picked.length > 0 && !picked.includes("\n") ? picked.slice(0, SEED_MAX) : null;
  useThreadFind.setState({ open: true, focusAsk: state.focusAsk + 1, ...(seed === null ? {} : { query: seed }) });
}

export function closeThreadFind(): void {
  useThreadFind.setState({ open: false, reveal: null });
}

export function stepThreadFind(direction: -1 | 1): void {
  if (useThreadFind.getState().open) target?.step(direction);
}

export function setFindQuery(query: string): void {
  useThreadFind.setState({ query });
}

export function toggleFind(toggle: FindToggle): void {
  useThreadFind.setState(s => ({ [toggle]: !s[toggle] }));
}

let asks = 0;
export function revealMatch(match: FindMatch | null): void {
  useThreadFind.setState({ reveal: match === null ? null : { ...match, ask: ++asks } });
}

/** A row's own open state, opened when find reveals a match in `entryId` (and in `part` where given). Starts open when
 * a reveal already names the row as it mounts, since a virtualized row mounts after the step that opened it. */
export function useRevealOpen(entryId: string, initial: boolean, part?: (n: number) => boolean): [boolean, (open: boolean | ((open: boolean) => boolean)) => void] {
  const reveal = useThreadFind(s => (s.reveal !== null && s.reveal.entryId === entryId && (part === undefined || part(s.reveal.part)) ? s.reveal.ask : null));
  const [open, setOpen] = useState(() => initial || reveal !== null);
  const [seen, setSeen] = useState(reveal);
  if (reveal !== seen) {
    setSeen(reveal);
    if (reveal !== null && !open) setOpen(true);
  }
  return [open, setOpen];
}

/** Runs `effect` each time find reveals a match in one of these entries. */
export function useOnReveal(entryIds: ReadonlyArray<string>, effect: (entryId: string) => void): void {
  const reveal = useThreadFind(s => (s.reveal !== null && entryIds.includes(s.reveal.entryId) ? s.reveal : null));
  const run = useRef(effect);
  run.current = effect;
  useEffect(() => {
    if (reveal !== null) run.current(reveal.entryId);
  }, [reveal]);
}
