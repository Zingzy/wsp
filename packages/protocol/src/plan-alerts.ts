// SPDX-License-Identifier: AGPL-3.0-only
// When an account's plan running low is worth telling the person: at 70% and
// at 90% of a window, once each, only as the reading gets worse; when the
// account is blocked; and when it comes back. Read off the same windows the
// Usage page's Limits draw.
import { z } from "zod";
import { LimitKind, type AccountLimit, type LimitWindow } from "./usage.js";

/** The share of a window used at which the person is told it runs low. */
export const PLAN_ALERT_STEPS = [70, 90] as const;

export const PlanAlert = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("low"), window: LimitKind, step: z.number() }),
  z.object({ kind: z.literal("blocked") }),
  z.object({ kind: z.literal("back") }),
]);
export type PlanAlert = z.infer<typeof PlanAlert>;

type Reading = Pick<AccountLimit, "windows" | "status">;

/** Overage is use past the plan, not a window of it, so it neither runs low nor blocks. */
const counted = (w: LimitWindow): boolean => w.kind !== "overage";

/** Whether the account is blocked: its agent said so, or a window of its plan is used up. */
export const planBlocked = (r: Reading): boolean => r.status === "reached" || r.windows.some(w => counted(w) && w.usedPercent >= 100);

/** When a blocked account starts again: the latest reset among its used-up windows, else among all of them; nothing
 * where it is not blocked or no window named a reset. */
export function blockEndsAt(r: Reading): number | undefined {
  if (!planBlocked(r)) return undefined;
  const resets = (ws: readonly LimitWindow[]): number[] => ws.flatMap(w => (counted(w) && w.resetsAt !== undefined ? [w.resetsAt] : []));
  const ends = resets(r.windows.filter(w => w.usedPercent >= 100));
  const all = ends.length > 0 ? ends : resets(r.windows);
  return all.length === 0 ? undefined : Math.max(...all);
}

/** How much of a window the reading before used, 0 where there was none or that window has started again since. */
function usedBefore(before: Reading | undefined, w: LimitWindow, at: number): number {
  const prior = before?.windows.find(p => p.kind === w.kind);
  if (prior === undefined || (prior.resetsAt !== undefined && prior.resetsAt <= at)) return 0;
  return prior.usedPercent;
}

/** What one reading tells the person against the one before it. A block says itself and nothing lower, a window that
 * crossed both steps in one reading says the higher, and a reading no longer blocked after a blocked one says the
 * account is back. */
export function planAlertsOf(before: Reading | undefined, after: Reading, at: number): PlanAlert[] {
  const was = before !== undefined && planBlocked(before);
  if (planBlocked(after)) return was ? [] : [{ kind: "blocked" }];
  if (was) return [{ kind: "back" }];
  return after.windows.filter(counted).flatMap((w): PlanAlert[] => {
    const prior = usedBefore(before, w, at);
    const step = [...PLAN_ALERT_STEPS].reverse().find(s => prior < s && w.usedPercent >= s);
    return step === undefined ? [] : [{ kind: "low", window: w.kind, step }];
  });
}

const WINDOW_WORDS: Readonly<Record<LimitKind, string>> = { session: "session", week: "week", week_opus: "Opus week", week_sonnet: "Sonnet week", month: "month", overage: "extra usage" };

/** The notice and the notification's line for an alert on the account the label names. */
export function planAlertLine(label: string, alert: PlanAlert): string {
  if (alert.kind === "low") return `${label} has used ${alert.step}% of its ${WINDOW_WORDS[alert.window]}`;
  return alert.kind === "blocked" ? `${label} reached its plan limit` : `${label} can run again: its plan limit reset`;
}

/** An account's plan crossed a step, was blocked or came back, for every client to tell the person as they chose. */
export const UsageAlertEvent = z.object({ type: z.literal("usage.alert"), key: z.string(), agent: z.string(), label: z.string(), alert: PlanAlert });
export type UsageAlertEvent = z.infer<typeof UsageAlertEvent>;
