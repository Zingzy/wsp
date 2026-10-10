// SPDX-License-Identifier: AGPL-3.0-only
// Which bar stands in the composer's place, per thread and in this window
// alone, never on the host: a remembered bar would greet the next visit with no
// composer. A question the agent opened takes the place on its own until the
// person folds it, which is kept here by its ask id so the next question opens.
import { useEffect, useRef, type KeyboardEvent } from "react";
import { create } from "zustand";
import { ownsKeys } from "../../keyOwners";
import { requestComposerFocus } from "../../shell/shellRequests";

/** A bar a drawer row opens; the question is the prompt dock, which opens itself. */
export type ComposerBar = "usage" | "tasks" | "queue";

interface ComposerBarState {
  /** The bar open on each thread, by thread key. */
  readonly open: Readonly<Record<string, ComposerBar>>;
  /** The question each thread's person folded, by thread key: its ask id. */
  readonly folded: Readonly<Record<string, string>>;
  /** The threads whose open question stands in the composer's place now, by thread key. */
  readonly docked: Readonly<Record<string, true>>;
  dock: (key: string, docked: boolean) => void;
  openBar: (key: string, bar: ComposerBar) => void;
  closeBar: (key: string) => void;
  /** Folds the question to the drawer's first row, and the composer stands. */
  fold: (key: string, askId: string) => void;
  /** Opens the folded question again, over whatever bar stood. */
  unfold: (key: string) => void;
}

const without = <T>(map: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const next = { ...map };
  delete next[key];
  return next;
};

export const useComposerBarStore = create<ComposerBarState>(set => ({
  open: {},
  folded: {},
  docked: {},
  dock: (key, docked) => set(s => (docked === (s.docked[key] === true) ? s : { docked: docked ? { ...s.docked, [key]: true } : without(s.docked, key) })),
  openBar: (key, bar) => set(s => ({ open: { ...s.open, [key]: bar } })),
  closeBar: key => set(s => (s.open[key] === undefined ? s : { open: without(s.open, key) })),
  fold: (key, askId) => set(s => ({ folded: { ...s.folded, [key]: askId }, open: without(s.open, key) })),
  unfold: key => set(s => ({ folded: without(s.folded, key), open: without(s.open, key) })),
}));

/** The bar open on a thread, or null for the composer. */
export const useOpenBar = (key: string): ComposerBar | null => useComposerBarStore(s => s.open[key] ?? null);

/** A bar's foot folding it back: the composer stands again with the caret in it. */
export function foldBar(key: string, workspaceId: string): void {
  useComposerBarStore.getState().closeBar(key);
  requestComposerFocus(workspaceId);
}

const BAR_KEYS = ownsKeys(["Escape"]);

/** A bar's root as its Dock takes it: it holds the focus once the bar opens, and Esc folds the bar back. */
export function useBarRoot(key: string, workspaceId: string) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => rootRef.current?.focus({ preventScroll: true }), []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    foldBar(key, workspaceId);
  };
  return { rootRef, root: { tabIndex: -1, "data-owns-keys": BAR_KEYS, onKeyDown } };
}
