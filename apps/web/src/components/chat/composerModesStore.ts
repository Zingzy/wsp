// SPDX-License-Identifier: AGPL-3.0-only
// Fast mode, kept per thread in local storage where the person turned it on
// or off by hand, over what the thread's own rows say it last ran at. A
// thread that has not started yet keeps it under the workspace's key, and its
// first start moves it onto the thread.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ComposerModesState {
  fast: Record<string, boolean>;
  setFast(key: string, on: boolean): void;
  /** Moves what a thread's key held onto the id its first start gave it. */
  rekey(from: string, to: string): void;
}

export const useComposerModesStore = create<ComposerModesState>()(
  persist(
    set => ({
      fast: {},
      setFast: (key, on) => set(s => ({ fast: { ...s.fast, [key]: on } })),
      rekey: (from, to) =>
        set(s => {
          if (!(from in s.fast)) return s;
          const { [from]: moved, ...rest } = s.fast;
          return { fast: { ...rest, [to]: moved! } };
        }),
    }),
    { name: "wsp:composer-modes", storage: createJSONStorage(() => localStorage), partialize: s => ({ fast: s.fast }) },
  ),
);
