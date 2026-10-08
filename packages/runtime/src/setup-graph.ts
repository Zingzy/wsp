// SPDX-License-Identifier: AGPL-3.0-only
// The steps of a setup after the base tools, run as their work allows: each
// once the steps and marks it waits on ended, never two on one lane (the
// package managers, the folder the files rounds stage in), and no more than
// the computer's width at once.

export interface GraphStep<S extends string, M extends string = never> {
  name: S;
  /** The steps and marks this one waits on; a name no step in the graph is or marks counts as ended. */
  after: readonly (S | M)[];
  /** The part of its work another step may wait on alone, each let go once that part is done and at its end at the latest. */
  marks?: readonly M[];
  /** What it must hold alone while it runs. */
  lanes: readonly string[];
  /** Holds no room of the width: it starts what waits on the person and ends at once. */
  light?: boolean;
  /** Answers whether the run goes on; `stop` starts nothing more and lets what runs end. */
  run(release: (mark: M) => void): Promise<"go" | "stop">;
}

/** Runs the steps, in the order given wherever two could start, and answers the ones that never started. A step
 * that throws stops the run the same way, and the first such error is thrown once every running step has ended. */
export function runGraph<S extends string, M extends string = never>(steps: readonly GraphStep<S, M>[], width: number, onMove?: (running: readonly S[]) => void): Promise<S[]> {
  const names = new Set<S | M>(steps.flatMap(s => [s.name, ...(s.marks ?? [])]));
  const ended = new Set<S | M>();
  const running = new Map<S, GraphStep<S, M>>();
  const waiting = [...steps];
  let stopped = false;
  let failure: { error: unknown } | undefined;
  return new Promise((resolve, reject) => {
    const busy = (lane: string): boolean => [...running.values()].some(r => r.lanes.includes(lane));
    const heavy = (): number => [...running.values()].filter(r => r.light !== true).length;
    const ready = (s: GraphStep<S, M>): boolean => s.after.every(a => ended.has(a) || !names.has(a)) && !s.lanes.some(busy) && (s.light === true || heavy() < width);
    const pump = (): void => {
      if (!stopped) {
        for (let at = 0; at < waiting.length; ) {
          const s = waiting[at]!;
          if (!ready(s)) {
            at++;
            continue;
          }
          waiting.splice(at, 1);
          running.set(s.name, s);
          onMove?.([...running.keys()]);
          s.run(mark => {
            if (!s.marks?.includes(mark) || ended.has(mark)) return;
            ended.add(mark);
            queueMicrotask(pump);
          }).then(
            next => finish(s, next === "stop"),
            (e: unknown) => {
              failure ??= { error: e };
              finish(s, true);
            },
          );
        }
      }
      if (running.size > 0) return;
      if (failure !== undefined) return reject(failure.error);
      resolve(waiting.map(s => s.name));
    };
    const finish = (s: GraphStep<S, M>, stop: boolean): void => {
      running.delete(s.name);
      ended.add(s.name);
      for (const mark of s.marks ?? []) ended.add(mark);
      if (stop) stopped = true;
      onMove?.([...running.keys()]);
      pump();
    };
    pump();
  });
}
