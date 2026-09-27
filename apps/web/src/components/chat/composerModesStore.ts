// SPDX-License-Identifier: AGPL-3.0-only
// The composer's two modes, kept per thread in local storage: fast and plan
// where the person turned them on or off by hand, over what the thread's own
// rows say it last ran at, and the access the plan toggle came from, so
// turning plan off puts the thread back at that mode rather than at the
// list's default. Plan is the thread's alone and never the workspace's
// default access. A thread that has not started yet keeps all three under the
// workspace's key, and its first start moves them onto the thread.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ComposerModesState {
  fast: Record<string, boolean>;
  plan: Record<string, boolean>;
  planFrom: Record<string, string>;
  setFast(key: string, on: boolean): void;
  setPlan(key: string, on: boolean): void;
  setPlanFrom(key: string, mode: string | null): void;
  /** Moves what a thread's key held onto the id its first start gave it. */
  rekey(from: string, to: string): void;
}

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _gone, ...rest } = record;
  return rest;
};

export const useComposerModesStore = create<ComposerModesState>()(
  persist(
    set => ({
      fast: {},
      plan: {},
      planFrom: {},
      setFast: (key, on) => set(s => ({ fast: { ...s.fast, [key]: on } })),
      setPlan: (key, on) => set(s => ({ plan: { ...s.plan, [key]: on } })),
      setPlanFrom: (key, mode) => set(s => ({ planFrom: mode === null ? without(s.planFrom, key) : { ...s.planFrom, [key]: mode } })),
      rekey: (from, to) =>
        set(s => ({
          fast: from in s.fast ? { ...without(s.fast, from), [to]: s.fast[from]! } : s.fast,
          plan: from in s.plan ? { ...without(s.plan, from), [to]: s.plan[from]! } : s.plan,
          planFrom: from in s.planFrom ? { ...without(s.planFrom, from), [to]: s.planFrom[from]! } : s.planFrom,
        })),
    }),
    { name: "wsp:composer-modes", storage: createJSONStorage(() => localStorage), partialize: s => ({ fast: s.fast, plan: s.plan, planFrom: s.planFrom }) },
  ),
);
