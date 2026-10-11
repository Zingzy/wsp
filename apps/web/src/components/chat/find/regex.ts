// SPDX-License-Identifier: AGPL-3.0-only
// The page's side of the regex worker: one pattern at a time, the thread's parts sent again only when they changed,
// and a worker that has not answered in REGEX_LIMIT_MS ended and replaced, so a pattern that never ends costs the
// page nothing.
import type { FindOptions } from "./match";
import type { FindResult, SearchAt } from "./search";
import type { FindDoc } from "./text";

export const REGEX_LIMIT_MS = 250;

export interface RegexAsk {
  readonly id: number;
  readonly docs?: ReadonlyArray<FindDoc>;
  readonly query: string;
  readonly options: Omit<FindOptions, "regex">;
  readonly tools: boolean;
  readonly at: SearchAt;
}

export type RegexReply = { readonly id: number; readonly result: FindResult } | { readonly id: number; readonly invalid: string };

/** What a search came to: matches, a pattern the engine refused, too slow, or overtaken by a newer search. */
export type RegexAnswer = { readonly result: FindResult } | { readonly invalid: string } | "slow" | "stale";

/** The part of a Worker this reads, so a test can stand one in. */
export interface WorkerLike {
  postMessage(message: RegexAsk): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<RegexReply>) => void) | null;
}

const browserWorker = (): WorkerLike => new Worker(new URL("./regexWorker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;

export interface RegexSearch {
  search(docs: ReadonlyArray<FindDoc>, query: string, options: Omit<FindOptions, "regex">, tools: boolean, at?: SearchAt): Promise<RegexAnswer>;
  dispose(): void;
}

export function regexSearch(make: () => WorkerLike = browserWorker, limitMs = REGEX_LIMIT_MS): RegexSearch {
  let worker: WorkerLike | null = null;
  let sent: ReadonlyArray<FindDoc> | null = null;
  let asked = 0;
  let waiting: { id: number; settle: (answer: RegexAnswer) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  const end = (): void => {
    worker?.terminate();
    worker = null;
    sent = null;
  };
  const settle = (answer: RegexAnswer): void => {
    if (waiting === null) return;
    clearTimeout(waiting.timer);
    const { settle: done } = waiting;
    waiting = null;
    done(answer);
  };

  return {
    search(docs, query, options, tools, at = {}) {
      // A worker still busy with an older pattern may be busy for good: it goes, and the new pattern starts fresh.
      if (waiting !== null) {
        end();
        settle("stale");
      }
      if (worker === null) {
        worker = make();
        worker.onmessage = event => {
          if (waiting === null || event.data.id !== waiting.id) return;
          settle("invalid" in event.data ? { invalid: event.data.invalid } : { result: event.data.result });
        };
      }
      const id = ++asked;
      const ask: RegexAsk = { id, query, options, tools, at, ...(sent === docs ? {} : { docs }) };
      sent = docs;
      return new Promise<RegexAnswer>(resolve => {
        const timer = setTimeout(() => {
          end();
          settle("slow");
        }, limitMs);
        waiting = { id, settle: resolve, timer };
        worker!.postMessage(ask);
      });
    },
    dispose() {
      end();
      settle("stale");
    },
  };
}
