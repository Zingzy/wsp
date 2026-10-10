// SPDX-License-Identifier: AGPL-3.0-only
// The road from the find chord to the transcript on screen. A transcript counts itself while it is mounted, so the
// chord stands down where none is and the browser keeps its own find.
import { create } from "zustand";

export const useThreadFind = create<{ asked: number; shown: number }>(() => ({ asked: 0, shown: 0 }));

export function requestThreadFind(): void {
  useThreadFind.setState(s => ({ asked: s.asked + 1 }));
}

export function isTranscriptShown(): boolean {
  return useThreadFind.getState().shown > 0;
}

/** Counts a mounted transcript in, and out again on the returned call. */
export function showTranscript(): () => void {
  useThreadFind.setState(s => ({ shown: s.shown + 1 }));
  return () => useThreadFind.setState(s => ({ shown: s.shown - 1 }));
}
