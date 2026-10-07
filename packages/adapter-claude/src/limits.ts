// SPDX-License-Identifier: AGPL-3.0-only
// The plan windows a turn's rate_limit_event lines report, and the stop a rejected one puts on the turn.

import type { HarnessLimit, LimitKind, LimitStatus, LimitWindow, TurnResult } from "@wsp/protocol";
import { num, rec, str } from "./fields.js";

/** Claude Code's name for each window as wsp's kind. The overage buckets are one kind: both are use past the plan. */
const LIMIT_KIND: Record<string, LimitKind> = {
  five_hour: "session",
  seven_day: "week",
  seven_day_opus: "week_opus",
  seven_day_sonnet: "week_sonnet",
  seven_day_overage_included: "overage",
  overage: "overage",
};
const LIMIT_STATUS: Record<string, LimitStatus> = { allowed: "ok", allowed_warning: "warning", rejected: "reached" };

/** A rate_limit_event's reading: every window it tracks under unifiedWindows, else the one window it names at the top
 * level, utilization (a fraction, above 1 when a window ran past its cap) as a percent and resetsAt (epoch seconds) in
 * ms. A reading with no utilization for any window says nothing about the plan and is dropped. Claude Code names no
 * account in it. */
export function limitOf(info: Record<string, unknown> | undefined): HarnessLimit | undefined {
  if (info === undefined) return undefined;
  const windows: LimitWindow[] = [];
  const add = (type: string, reading: Record<string, unknown> | undefined): void => {
    const kind = LIMIT_KIND[type];
    const used = num(reading?.utilization);
    if (kind === undefined || used === undefined || windows.some(w => w.kind === kind)) return;
    const resetsAt = num(reading?.resetsAt);
    windows.push({ kind, usedPercent: Math.round(used * 1000) / 10, ...(resetsAt !== undefined ? { resetsAt: resetsAt * 1000 } : {}) });
  };
  for (const [type, reading] of Object.entries(rec(info.unifiedWindows) ?? {})) add(type, rec(reading));
  const top = str(info.rateLimitType);
  if (top !== undefined) add(top, info);
  if (windows.length === 0) return undefined;
  const status = LIMIT_STATUS[str(info.status) ?? ""];
  return { windows, ...(status !== undefined ? { status } : {}) };
}

/** Moves the windows a turn's readings say stop the agent: a rejected window with no overage to run on stops it until
 * its reset (epoch seconds, kept in ms), and any other reading of that window takes the stop back. */
export function noteRejected(info: Record<string, unknown> | undefined, rejected: Map<string, number | undefined>): void {
  if (info === undefined) return;
  const type = str(info.rateLimitType) ?? "";
  const overage = info.isUsingOverage === true || str(info.overageStatus) === "allowed" || str(info.overageStatus) === "allowed_warning";
  if (str(info.status) !== "rejected" || overage) {
    rejected.delete(type);
    return;
  }
  const resetsAt = num(info.resetsAt);
  rejected.set(type, resetsAt === undefined ? undefined : resetsAt * 1000);
}

/** A failed turn the plan's rejected windows stopped, with the limit on it: the reset is the last of theirs, and
 * unknown where any of them named none. */
export function withLimit(result: TurnResult, rejected: ReadonlyMap<string, number | undefined>): TurnResult {
  if (result.status !== "failed" || rejected.size === 0) return result;
  const resets = [...rejected.values()];
  return { ...result, limit: resets.every((r): r is number => r !== undefined) ? { resetsAt: Math.max(...resets) } : {} };
}
