// SPDX-License-Identifier: AGPL-3.0-only
// The two questions put to a thread's own turns on a server run that runs no
// turn: where a revert cuts the thread, and which turn a fork carries it
// through. Both page thread/turns/list newest first.
import { CODEX_FEWER_TURNS, CODEX_LEGACY_HISTORY, codexNoTurnLine, type SessionForker, type SessionReverter, type TurnResult } from "@wsp/protocol";
import { accessParams } from "./command.js";
import { REQUEST, threadResumeLine, threadRevertLine, threadTurnsListLine, type RequestId } from "./rpc.js";

/** What a side run does with each answer: the next line to send, or how the run ends. */
export type SideRun = (id: RequestId, answer: Record<string, unknown> | undefined) => string | TurnResult;

/** A server run of its own that sends its input after the handshake and hands each answer to sideRun. */
export type SideRunner = (o: { cwd?: string; input: string[]; sideRun: SideRun }) => Promise<TurnResult>;

/** The words a server that refuses to cut a legacy thread says it in (thread_processor.rs, 0.155.1). */
const PAGINATED_ONLY = "only supports paginated threads";

/** The start of every failure the adapter words itself before the server opened the turn. */
const NEVER_OPENED = "codex could not ";

const PAGE_AGAIN = "codex could not list the thread's turns: it handed back a page it already gave";

/** Whether the server opened a cut turn, so the thread's own history holds it: one that kept the server's turn id did;
 * of the rest, a turn refused for want of a sign-in, or one the adapter failed before the server took it, left none
 * there, and one that never said how it ended counts as opened. */
const serverOpened = (turn: { anchor?: string; result?: TurnResult }): boolean =>
  turn.anchor !== undefined || (turn.result?.refusal === undefined && turn.result?.error?.startsWith(NEVER_OPENED) !== true);

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The ids on one page of thread/turns/list, newest first. */
const turnIds = (answer: Record<string, unknown> | undefined): string[] => (Array.isArray(answer?.["data"]) ? answer["data"] : []).flatMap(turn => str(rec(turn)?.["id"]) ?? []);

/** The thread's own history cut before one of its turns: the thread resumed, then thread/revert, then EOF. Without the
 * turn's own id the boundary is found by count, the way T3 Code's CodexThreadRevert.ts does it (MIT): the thread's
 * turns newest first, page by page, the count-th one the first cut. */
export async function revertOn(run: SideRunner, o: Parameters<SessionReverter>[0]): ReturnType<SessionReverter> {
  let legacy = false;
  let remaining = "turns" in o ? o.turns.filter(serverOpened).length : 0;
  let beforeTurnId = "beforeTurn" in o ? o.beforeTurn : undefined;
  let cursor: string | null = null;
  const seen = new Set<string | null>();
  let threadId = o.session;
  const done = (): TurnResult => ({ status: "completed" });
  const page = (): string => {
    seen.add(cursor);
    return threadTurnsListLine({ threadId, cursor, limit: Math.min(remaining, 100) });
  };
  const cutAt = (): string | TurnResult => (beforeTurnId === undefined ? done() : threadRevertLine({ threadId, beforeTurnId }));
  const result = await run({
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    input: [threadResumeLine({ threadId: o.session, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), access: accessParams("read-only") })],
    sideRun: (id, answer) => {
      if (id === REQUEST.thread) {
        const thread = rec(answer?.["thread"]);
        threadId = str(thread?.["id"]) ?? threadId;
        legacy = thread?.["historyMode"] === "legacy";
        if (legacy) return done();
        return beforeTurnId === undefined && remaining > 0 ? page() : cutAt();
      }
      if (id === REQUEST.turns) {
        for (const turnId of turnIds(answer)) {
          beforeTurnId = turnId;
          if (--remaining === 0) break;
        }
        cursor = str(answer?.["nextCursor"]) ?? null;
        if (remaining === 0) return cutAt();
        // wsp's count is rebuilt from its own transcript, so a server that runs out first disagrees with it.
        if (cursor === null) return { status: "failed", error: CODEX_FEWER_TURNS };
        return seen.has(cursor) ? { status: "failed", error: PAGE_AGAIN } : page();
      }
      return done();
    },
  });
  if (legacy || (result.status === "failed" && result.error?.includes(PAGINATED_ONLY) === true)) return { kept: CODEX_LEGACY_HISTORY };
  if (result.status !== "completed") throw new Error(result.error ?? "codex did not cut the thread");
}

/** The turn a fork carries the thread through, on a run that loads no thread: the thread's turns newest first, page by
 * page, until the turn by its id, or the one past the turns after it that the server opened. A thread whose history
 * the server will not list forks at its anchor as given. */
export async function forkSessionOn(run: SideRunner, o: Parameters<SessionForker>[0]): ReturnType<SessionForker> {
  const anchor = "anchor" in o.turn ? o.turn.anchor : undefined;
  let skip = "after" in o.turn ? o.turn.after.filter(serverOpened).length : 0;
  let found: string | undefined;
  let cursor: string | null = null;
  const seen = new Set<string | null>();
  const page = (): string => {
    seen.add(cursor);
    return threadTurnsListLine({ threadId: o.session, cursor, limit: 100 });
  };
  const result = await run({
    input: [page()],
    sideRun: (id, answer) => {
      if (id !== REQUEST.turns) return { status: "completed" };
      for (const turnId of turnIds(answer)) {
        if (anchor !== undefined ? turnId === anchor : skip-- === 0) {
          found = turnId;
          return { status: "completed" };
        }
      }
      cursor = str(answer?.["nextCursor"]) ?? null;
      if (cursor === null) return { status: "failed", error: anchor !== undefined ? codexNoTurnLine(anchor) : CODEX_FEWER_TURNS };
      return seen.has(cursor) ? { status: "failed", error: PAGE_AGAIN } : page();
    },
  });
  if (found !== undefined) return { fork: { session: o.session, turn: found } };
  if (anchor !== undefined && result.error?.includes(PAGINATED_ONLY) === true) return { fork: { session: o.session, turn: anchor } };
  throw new Error(result.error ?? "codex did not find the turn to fork the thread at");
}
