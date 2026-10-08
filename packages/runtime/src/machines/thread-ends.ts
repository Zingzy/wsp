// SPDX-License-Identifier: AGPL-3.0-only
// The end of a thread's cgroup on a computer the person joined. A stop or a
// delete runs it over the link; neither needs that computer to go on. A delete
// it could not finish there, the computer away, not answering or holding a
// process that will not die, owes the end to that computer, kept in the state
// file, and its next link pays it. A computer removed is owed nothing.
import { cgroupEndScript, threadCgroup, threadEndOwedLine, threadLeftLine } from "@wsp/protocol";
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
   * could not end there, in the person's words; a delete that could not end it owes it instead. */
  end(placeId: string, threadId: string, o: { remove?: boolean }): Promise<string | undefined>;
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
  /** A turn of the thread running or on its way stands in the same cgroup, and an end there would take it. */
  const busy = (threadId: string): boolean => ctx.runningOn(threadId) !== undefined || ctx.launchingOn(threadId) !== undefined;

  door.on(e => {
    if (e.type === "place.removed") {
      void ctx.store.delete(OWED, e.placeId).catch(() => undefined);
      return;
    }
    if (e.type !== "place.present") return;
    void (async () => {
      await ctx.ready();
      const owed = await owedOn(e.placeId);
      if (owed.length === 0) return;
      const left: string[] = [];
      for (const thread of owed) {
        if (busy(thread) || (await run(e.placeId, thread, { remove: true }).catch(() => [])) !== undefined) left.push(thread);
      }
      // Read again: a delete while these ran owes more.
      const now = await owedOn(e.placeId);
      await keep(e.placeId, [...new Set([...left, ...now.filter(thread => !owed.includes(thread))])]);
    })().catch((err: unknown) => console.warn(`the threads deleted while ${door.nameOf(e.placeId)} was away were not ended there: ${err instanceof Error ? err.message : String(err)}`));
  });

  return {
    async end(placeId, threadId, o) {
      if (door.link(placeId) === undefined) {
        if (o.remove === true) await owe(placeId, threadId);
        return undefined;
      }
      // A computer that stops answering is away once the exec's own bound passes.
      const left = await run(placeId, threadId, o).catch(() => [] as number[]);
      if (left === undefined) return undefined;
      if (o.remove !== true) return threadLeftLine(door.nameOf(placeId), left);
      await owe(placeId, threadId);
      console.warn(threadEndOwedLine(door.nameOf(placeId)));
      return undefined;
    },
  };
}
