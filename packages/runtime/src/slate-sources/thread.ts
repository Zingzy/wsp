// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionView, TurnTokens } from "@wsp/protocol";
import { json, type HostSlateSource } from "./context.js";

/** The status mark's word for the thread's latest row. */
const statusOf = (latest: SessionView | undefined): string => {
  if (latest === undefined) return "starting";
  if (latest.status === "running") return latest.asking !== undefined || latest.waitingOn !== undefined ? "needs-you" : "working";
  if (latest.status === "failed") return "failed";
  if (latest.status === "interrupted") return "resting";
  return "done";
};

export const threadSource: HostSlateSource = {
  name: "thread",
  view(ctx) {
    const rows = ctx.rows();
    const latest = rows.reduce<SessionView | undefined>((a, r) => (a === undefined || (r.startedAt ?? 0) >= (a.startedAt ?? 0) ? r : a), undefined);
    const results = ctx.results();
    const last = results[results.length - 1];
    const sum = (pick: (t: TurnTokens) => number | undefined): number => results.reduce((n, r) => n + (r.tokens === undefined ? 0 : (pick(r.tokens) ?? 0)), 0);
    const withContext = [...results].reverse().find(r => r.tokens?.context !== undefined);
    const used = withContext?.tokens?.context;
    const window = withContext?.tokens?.window;
    const facts = ctx.workspace();
    return json({
      id: ctx.threadId,
      title: latest?.harnessTitle ?? latest?.prompt?.split("\n")[0]?.slice(0, 80) ?? null,
      agent: latest?.harness ?? null,
      model: latest?.model ?? null,
      effort: latest?.effort ?? null,
      status: statusOf(latest),
      access: latest?.permissionMode ?? null,
      computer: facts?.computer ?? null,
      project: facts?.project ?? null,
      folder: latest?.cwd ?? facts?.folder ?? null,
      turns: rows.length,
      lastTurn: {
        status: last?.status ?? null,
        durationMs: last?.durationMs ?? null,
        waitedMs: last?.waitedMs ?? null,
        startedAt: latest?.startedAt ?? null,
        endedAt: latest?.endedAt ?? null,
        model: latest?.model ?? null,
      },
      cost: { usd: rows.reduce((n, r) => n + (r.costUsd ?? 0), 0) },
      tokens: { input: sum(t => t.input), output: sum(t => t.output), cached: sum(t => t.cached), cacheWrite: sum(t => t.cacheWrite), reasoning: sum(t => t.reasoning) },
      context: {
        used: used ?? null,
        window: window ?? null,
        free: used !== undefined && window !== undefined ? window - used : null,
        percent: used !== undefined && window !== undefined && window > 0 ? (used / window) * 100 : null,
      },
      waitingOn: latest?.asking ?? null,
    });
  },
};
