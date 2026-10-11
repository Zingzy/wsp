// SPDX-License-Identifier: AGPL-3.0-only
// The agent's budget of slate writes per thread (V751): 5 a second sustained, a burst of 20, 600 an hour.
const WRITES_BURST = 20;
const WRITES_PER_SECOND = 5;
const WRITES_PER_HOUR = 600;

/** Each thread's bucket. `spend` takes one write, or answers how many seconds to wait and takes nothing. */
export function writeBudget(now: () => number) {
  const writes = new Map<string, { tokens: number; at: number; hour: number[] }>();
  return {
    spend(threadId: string): number | undefined {
      const at = now();
      const b = writes.get(threadId) ?? { tokens: WRITES_BURST, at, hour: [] };
      b.tokens = Math.min(WRITES_BURST, b.tokens + ((at - b.at) / 1000) * WRITES_PER_SECOND);
      b.at = at;
      b.hour = b.hour.filter(t => at - t < 3_600_000);
      writes.set(threadId, b);
      if (b.tokens < 1 || b.hour.length >= WRITES_PER_HOUR) return b.tokens < 1 ? Math.ceil((1 - b.tokens) / WRITES_PER_SECOND) : Math.ceil((3_600_000 - (at - b.hour[0]!)) / 1000);
      b.tokens -= 1;
      b.hour.push(at);
      return undefined;
    },
    delete: (threadId: string): boolean => writes.delete(threadId),
  };
}
