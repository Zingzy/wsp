// SPDX-License-Identifier: AGPL-3.0-only
// The end of a thread's cgroup on a computer the person joined. A stop or a
// delete runs it over the link; neither needs that computer to go on. A delete
// it could not finish there, the computer away, not answering or holding a
// process that will not die, owes the end to that computer, kept in the state
// file, and its next link pays it; so does a stop of a running turn that could
// not reach that computer in time. A computer removed is owed nothing.
import { cgroupEndScript, STOP_REACH_MS, threadCgroup, threadEndAwayLine, threadEndLateLine, threadEndOwedLine, threadLeftLine } from "@wsp/protocol";
import { INLINE_EXEC_MS } from "@wsp/engine";
import type { RuntimeContext } from "../context.js";
import type { PlaceDoor } from "../places/types.js";

/** The threads each computer is owed an end of, by its id. */
const OWED = "thread-ends";

interface Owed {
  threads: string[];
}

export interface ThreadEnds {
  /** Ends what a thread left running on that computer, and with `remove` takes its cgroup away. Answers what a stop
   * could not end there, in the person's words; a delete that could not end it owes it instead. With `away` the stop
   * could not reach that computer in time: the end is owed before anything is asked of it, and the answer says so. */
  end(placeId: string, threadId: string, o: { remove?: boolean; away?: boolean }): Promise<string | undefined>;
  /** The end of the thread that computer is owed, read off the state file, with `paid` resolving once that computer
   * has run it or was removed; nothing where none is owed. */
  owed(placeId: string, threadId: string): Promise<{ paid: Promise<void> } | undefined>;
}

/** The pids the end script names as still standing, off its last words. */
const survivorsOf = (stderr: string): number[] => (/processes((?: \d+)+) of /.exec(stderr)?.[1] ?? "").trim().split(" ").filter(Boolean).map(Number);

export function threadEnds(ctx: RuntimeContext, door: PlaceDoor): ThreadEnds {
  const owedOn = async (placeId: string): Promise<string[]> => ((await ctx.store.get(OWED, placeId)) as Owed | undefined)?.threads ?? [];
  const keep = async (placeId: string, threads: string[]): Promise<void> => {
    if (threads.length === 0) await ctx.store.delete(OWED, placeId);
    else await ctx.store.put(OWED, placeId, { threads } satisfies Owed);
  };
  const owe = async (placeId: string, threadId: string): Promise<void> => {
    const owed = await owedOn(placeId);
    if (!owed.includes(threadId)) await keep(placeId, [...owed, threadId]);
  };

  /** Runs the end there: nothing when it ended all, else the pids still standing, none where it said no pids. */
  const run = async (placeId: string, threadId: string, o: { remove?: boolean }): Promise<number[] | undefined> => {
    const ended = await door.exec(placeId, cgroupEndScript(threadCgroup(threadId), o), { timeoutMs: INLINE_EXEC_MS });
    return ended.exitCode === 0 ? undefined : survivorsOf(ended.stderr);
  };
  /** A turn of the thread running or on its way stands in the same cgroup, and an end there would take it; one a stop
   * holds back waits for this very end. */
  const busy = (threadId: string): boolean => ctx.runningOn(threadId) !== undefined || (ctx.launchingOn(threadId) !== undefined && !ctx.stopHolds(threadId));
  /** What waits on a thread's owed end, by computer and thread. */
  const waiting = new Map<string, (() => void)[]>();
  const waitKey = (placeId: string, threadId: string): string => `${placeId}\n${threadId}`;
  const settle = (key: string): void => {
    for (const resolve of waiting.get(key) ?? []) resolve();
    waiting.delete(key);
  };

  /** An end that ran there pays the thread's debt, whatever survived it, so no send waits on a computer that is
   * connected: off the state file before its waiters go, so a send reading it after this end finds nothing owed. Read
   * again, since a stop or a delete meanwhile owes more. */
  const clear = async (placeId: string, threadId: string): Promise<void> => {
    const owed = await owedOn(placeId);
    if (owed.includes(threadId)) await keep(placeId, owed.filter(owing => owing !== threadId));
    settle(waitKey(placeId, threadId));
  };
  /** The end once run there: what survived it, none when all ended; nothing where that computer did not answer. */
  const ran = (placeId: string, threadId: string, o: { remove?: boolean }): Promise<{ left: number[] | undefined } | undefined> =>
    run(placeId, threadId, o).then(left => ({ left }), () => undefined);

  /** Runs every end owed to that computer, and keeps the ones it did not answer or a turn of the thread stood in. */
  const pay = async (placeId: string): Promise<void> => {
    await ctx.ready();
    const owed = await owedOn(placeId);
    if (owed.length === 0) return;
    for (const thread of owed) {
      const end = busy(thread) ? undefined : await ran(placeId, thread, { remove: true });
      if (end === undefined) continue;
      if (end.left !== undefined) console.warn(threadLeftLine(door.nameOf(placeId), end.left));
      await clear(placeId, thread);
    }
  };
  const paying = (placeId: string): void =>
    void pay(placeId).catch((err: unknown) => console.warn(`the threads stopped or deleted while ${door.nameOf(placeId)} was away were not ended there: ${err instanceof Error ? err.message : String(err)}`));

  door.on(e => {
    if (e.type === "place.removed") {
      void ctx.store.delete(OWED, e.placeId).catch(() => undefined);
      for (const key of [...waiting.keys()]) if (key.startsWith(`${e.placeId}\n`)) settle(key);
      return;
    }
    if (e.type === "place.present") paying(e.placeId);
  });

  return {
    async end(placeId, threadId, o) {
      if (o.away === true) {
        await owe(placeId, threadId);
        // A computer slow to answer rather than gone still takes the end the moment it does.
        if (door.link(placeId) === undefined) return threadEndAwayLine(door.nameOf(placeId));
        paying(placeId);
        return threadEndLateLine(door.nameOf(placeId), STOP_REACH_MS / 1000);
      }
      if (door.link(placeId) === undefined) {
        if (o.remove === true) await owe(placeId, threadId);
        return undefined;
      }
      // A computer that stops answering is away once the exec's own bound passes.
      const end = await ran(placeId, threadId, o);
      const name = door.nameOf(placeId);
      if (o.remove !== true) {
        if (end === undefined) return threadLeftLine(name, []);
        await clear(placeId, threadId);
        return end.left === undefined ? undefined : threadLeftLine(name, end.left);
      }
      if (end !== undefined && end.left === undefined) {
        await clear(placeId, threadId);
        return undefined;
      }
      await owe(placeId, threadId);
      console.warn(threadEndOwedLine(name));
      return undefined;
    },
    async owed(placeId, threadId) {
      const key = waitKey(placeId, threadId);
      // Waiting before the read, so a payment that lands during it is not missed.
      const paid = new Promise<void>(resolve => waiting.set(key, [...(waiting.get(key) ?? []), resolve]));
      if ((await owedOn(placeId)).includes(threadId)) return { paid };
      settle(key);
      return undefined;
    },
  };
}
