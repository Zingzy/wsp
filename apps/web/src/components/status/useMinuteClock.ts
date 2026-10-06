// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from "react";

/** The one clock words counted in minutes read, a reset's "resets in 14 min" among them: every reader shares one
 * timer, which runs only while something reads it. */
const readers = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(onTick: () => void): () => void {
  readers.add(onTick);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const read of readers) read();
    }, 60_000);
  }
  return () => {
    readers.delete(onTick);
    if (readers.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Read with no timer running, the clock catches up first; held steady within a second, as React reads it twice. */
function snapshot(): number {
  if (timer === undefined && Math.abs(Date.now() - now) >= 1000) now = Date.now();
  return now;
}

/** Now, ms epoch, moved once a minute. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, snapshot);
}
