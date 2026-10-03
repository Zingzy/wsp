// SPDX-License-Identifier: AGPL-3.0-only
import type { LimitKind } from "@wsp/protocol";
import { json, type HostSlateSource } from "./context.js";

export const usageSource: HostSlateSource = {
  name: "usage",
  async view(ctx) {
    const row = await ctx.account();
    if (row === undefined) return undefined;
    const window = (kind: LimitKind) => {
      const w = row.windows?.find(w => w.kind === kind);
      return { percent: w?.usedPercent ?? null, resetsAt: w?.resetsAt ?? null };
    };
    return json({
      account: { key: row.key, label: row.label, agent: row.agent, plan: row.plan ?? null, address: row.address ?? null, computers: row.computers },
      windows: (row.windows ?? []).map(w => ({ kind: w.kind, usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null })),
      session: window("session"),
      week: window("week"),
      status: row.status ?? null,
      note: row.note ?? null,
      burn: { tokensPerMinute: row.burn?.tokensPerMinute ?? null, threads: row.burn?.threads ?? null },
      credits: { count: row.credits?.count ?? null, nextExpiresAt: row.credits?.nextExpiresAt ?? null },
      readAt: row.readAt ?? null,
    });
  },
};
