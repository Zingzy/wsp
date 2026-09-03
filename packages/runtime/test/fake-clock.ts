// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock } from "../src/clock.js";

/** A clock that moves only when the test says so; advance() runs the timers that fall due, earliest first.
 * holding() counts the pending timers that would keep a real process alive. */
export function fakeClock(start = Date.now()) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; unref: boolean }>();
  const clock: Clock = {
    now: () => now,
    schedule: (fn, ms, o) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn, unref: o?.unref === true });
      return () => void timers.delete(id);
    },
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; unref: boolean }] | undefined;
      for (const t of timers) if (t[1].at <= target && (next === undefined || t[1].at < next[1].at)) next = t;
      if (next === undefined) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = target;
  };
  return { clock, advance, pending: () => timers.size, holding: () => [...timers.values()].filter(t => !t.unref).length };
}
