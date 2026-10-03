// SPDX-License-Identifier: AGPL-3.0-only
// The slate's own thread, from its rows in the store and the latest session.done this window saw. The figures a
// turn carries (context, tokens, the last turn) are the host's until a turn ends with this window open.
import { threadKeyOf } from "@wsp/protocol";
import { threadStatusOf } from "../../components/status/threadStatusOf.js";
import { walk } from "../paths.js";
import { ASK_HOST, type SourceModule } from "./source.js";

const TURN_FIELDS = new Set(["context", "lastTurn", "tokens", "turns"]);

export const thread: SourceModule = {
  name: "thread",
  input: ctx => [ctx.thread, ctx.lastTurn],
  select(steps, ctx) {
    const [first, ...rest] = steps;
    const t = ctx.thread;
    const turn = ctx.lastTurn;
    if (typeof first === "string" && TURN_FIELDS.has(first)) {
      if (first === "turns") return t?.turns ?? ASK_HOST;
      if (turn === undefined) return ASK_HOST;
      const tokens = turn.tokens;
      if (first === "tokens") return walk(tokens ?? null, rest);
      if (first === "lastTurn") return walk({ status: turn.status, durationMs: turn.durationMs ?? null, waitedMs: turn.waitedMs ?? null, model: turn.model ?? null }, rest);
      const used = tokens?.context;
      const window = tokens?.window;
      if (used === undefined) return walk({ used: null, window: window ?? null, free: null, percent: null }, rest);
      const context = {
        used,
        window: window ?? null,
        free: window === undefined ? null : Math.max(0, window - used),
        percent: window === undefined || window <= 0 ? null : (used / window) * 100,
      };
      return walk(context, rest);
    }
    if (t === null) return undefined;
    const rows = ctx.workspaceId === null ? [] : (ctx.app.sessions[ctx.workspaceId] ?? []).filter(row => threadKeyOf(row) === ctx.threadId);
    const latest = rows.at(-1);
    const cost = rows.reduce<number | null>((sum, row) => (row.costUsd === undefined ? sum : (sum ?? 0) + row.costUsd), null);
    const view = {
      id: ctx.threadId,
      title: t.title,
      agent: t.harness,
      model: latest?.model ?? null,
      effort: latest?.effort ?? null,
      access: latest?.permissionMode ?? null,
      folder: t.cwd ?? null,
      status: threadStatusOf({ status: t.status, asking: t.asking ?? null, startedAt: t.startedAt === undefined ? null : new Date(t.startedAt).toISOString(), unread: false }).id,
      waitingOn: t.asking ?? null,
      cost: { usd: cost },
    };
    return walk(view, steps);
  },
};
