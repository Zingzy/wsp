// SPDX-License-Identifier: AGPL-3.0-only
// The models one send from a project's home goes to when it goes to more than
// one: the model the composer already shows, then every model shift-clicked in
// the picker, each opening its own copy. Held per home in memory only, since a
// list of models is a thing a person is about to send, not a setting; a plain
// pick of one model, the send itself and a reload all end it.
import { create } from "zustand";
import { useComposerOptionsStore } from "./composerOptionsStore";

export interface ModelPick {
  readonly harness: string;
  readonly model: string;
  readonly label: string;
}

const same = (a: ModelPick, b: ModelPick): boolean => a.harness === b.harness && a.model === b.model;

/** The picks after a shift-click on `next`: the first one starts from the model the composer shows, and a model
 * already on the list leaves it. */
export function withPick(picks: ReadonlyArray<ModelPick>, current: ModelPick | null, next: ModelPick): ModelPick[] {
  const base = picks.length > 0 ? [...picks] : current === null ? [] : [current];
  return base.some(p => same(p, next)) ? base.filter(p => !same(p, next)) : [...base, next];
}

const NONE: ReadonlyArray<ModelPick> = [];

interface MultiPickState {
  byKey: Record<string, ReadonlyArray<ModelPick>>;
  /** A list of fewer than two is no list: one model is the composer's own pick. */
  set(key: string, picks: ReadonlyArray<ModelPick>): void;
}

export const useMultiPickStore = create<MultiPickState>()(set => ({
  byKey: {},
  set: (key, picks) =>
    set(s => {
      const { [key]: _gone, ...rest } = s.byKey;
      return { byKey: picks.length < 2 ? rest : { ...rest, [key]: picks } };
    }),
}));

export function useMultiPicks(key: string): ReadonlyArray<ModelPick> {
  return useMultiPickStore(s => s.byKey[key] ?? NONE);
}

/** A shift-click, or a chip's remove, on one home's list. A list left holding one model hands it back to the
 * composer as its pick, so the send goes where the one chip that was left said. */
export function togglePick(key: string, current: ModelPick | null, next: ModelPick): void {
  const picks = withPick(useMultiPickStore.getState().byKey[key] ?? NONE, current, next);
  useMultiPickStore.getState().set(key, picks);
  const left = picks.length === 1 ? picks[0]! : null;
  if (left === null || (current !== null && same(left, current))) return;
  const { pick } = useComposerOptionsStore.getState();
  pick(key, "harness", left.harness);
  pick(key, "model", left.model);
}
