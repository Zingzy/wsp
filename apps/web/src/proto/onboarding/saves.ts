// SPDX-License-Identifier: AGPL-3.0-only
// How many saves have landed in this dialog: every tick, pick or select bumps it, and the foot's auto-save check
// draws in once more on each.
import { create } from "zustand";

export const useSaves = create<{ n: number }>(() => ({ n: 0 }));
export const markSaved = (): void => useSaves.setState(s => ({ n: s.n + 1 }));
