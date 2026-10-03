// SPDX-License-Identifier: AGPL-3.0-only
// The slate's own thread, from its rows in the store. The figures folded over its turns (context, tokens, the last
// turn) are the host's, asked again whenever a row or a turn's end moves.
import { threadKeyOf } from "@wsp/protocol";
import { threadStatusOf } from "../../components/status/threadStatusOf.js";
import { walk } from "../paths.js";
import { ASK_HOST, type SourceModule } from "./source.js";

/** Figures folded over every turn, which the host reads off the transcript; a turn ending here asks again. */
const HOST_FIELDS = new Set(["context", "lastTurn", "tokens", "turns", "computer", "project"]);

export const thread: SourceModule = {
  name: "thread",
  input: ctx => [ctx.thread, ctx.lastTurn],
  select(steps, ctx) {
    const [first] = steps;
    if (typeof first === "string" && HOST_FIELDS.has(first)) return ASK_HOST;
    const t = ctx.thread;
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
