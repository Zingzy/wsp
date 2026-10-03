// SPDX-License-Identifier: AGPL-3.0-only
// The account the thread runs on, from the Usage ledger's rows: fetched once while bound, and moved by every
// usage.account push. Which account is the host's to say; it answers usage.account.key once.
import type { AccountRow } from "@wsp/protocol";
import { walk } from "../paths.js";
import { ASK_HOST, type SourceContext, type SourceModule } from "./source.js";

function accountOf(ctx: SourceContext): AccountRow | undefined | typeof ASK_HOST {
  const rows = ctx.app.usageAccounts;
  if (rows === null) return undefined;
  const key = ctx.fromHost["usage.account.key"];
  if (typeof key === "string") return rows[key];
  if (!("usage.account.key" in ctx.fromHost)) return ASK_HOST;
  // The host could not say: the one account of the thread's agent, where there is one.
  const agent = ctx.thread?.harness;
  const mine = Object.values(rows).filter(row => row.agent === agent);
  return mine.length === 1 ? mine[0] : undefined;
}

export const usage: SourceModule = {
  name: "usage",
  input: ctx => ctx.app.usageAccounts,
  wants: ctx => ctx.app.loadUsageAccounts(),
  select(steps, ctx) {
    const row = accountOf(ctx);
    if (row === ASK_HOST) return ASK_HOST;
    if (row === undefined) return undefined;
    const window = (kind: string) => {
      const found = row.windows?.find(w => w.kind === kind);
      return found === undefined ? null : { percent: found.usedPercent, resetsAt: found.resetsAt ?? null };
    };
    const view = {
      account: { key: row.key, label: row.label, agent: row.agent, plan: row.plan ?? null, address: row.address ?? null, computers: row.computers },
      windows: (row.windows ?? []).map(w => ({ kind: w.kind, usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null })),
      session: window("session"),
      week: window("week"),
      status: row.status ?? null,
      note: row.note ?? null,
      burn: row.burn ?? null,
      credits: row.credits === undefined ? null : { count: row.credits.count ?? null, nextExpiresAt: row.credits.nextExpiresAt ?? null },
      readAt: row.readAt ?? null,
    };
    return walk(view, steps);
  },
};
