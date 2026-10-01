// SPDX-License-Identifier: AGPL-3.0-only
// The plan alerts as the host says them: each limit reading a turn printed is
// read against the one it replaced, and a blocked account is told it is back at
// its reset by a timer, since no turn runs on an account that cannot run one.
// A comeback the timer said is not said again by the next reading.
import { blockEndsAt, planAlertsOf, planBlocked, type AccountLimit, type PlanAlert, type UsageAlertEvent } from "@wsp/protocol";
import type { Clock } from "./clock.js";

/** How long one timer waits at most: a month's window resets further off than a timer can count, so it wakes and
 * reads again. */
const LONGEST_WAIT_MS = 24 * 60 * 60_000;

export interface PlanAlertsDeps {
  clock: Clock;
  emit(event: UsageAlertEvent): void;
  /** Every account's last reading, as the ledger keeps it. */
  limits(): Promise<AccountLimit[]>;
}

export interface PlanAlerts {
  /** One reading kept, against the one it replaced. */
  read(before: AccountLimit | undefined, after: AccountLimit): void;
  /** Arms the comeback of every account blocked when the host starts. */
  resume(): Promise<void>;
  close(): void;
}

export function planAlerts(deps: PlanAlertsDeps): PlanAlerts {
  const timers = new Map<string, () => void>();
  const backSaid = new Set<string>();
  const said = (l: AccountLimit, end: number | undefined): string => `${l.key}@${end ?? ""}`;
  const say = (l: AccountLimit, alert: PlanAlert): void => deps.emit({ type: "usage.alert", key: l.key, agent: l.agent, label: l.label, alert });
  const cancel = (key: string): void => {
    timers.get(key)?.();
    timers.delete(key);
  };

  const arm = (blocked: AccountLimit): void => {
    const end = blockEndsAt(blocked);
    cancel(blocked.key);
    if (end === undefined) return;
    const fire = async (): Promise<void> => {
      timers.delete(blocked.key);
      const now = (await deps.limits()).find(l => l.key === blocked.key);
      // A reading since the block said the comeback itself.
      if (now === undefined || !planBlocked(now)) return;
      const next = blockEndsAt(now);
      if (next !== undefined && next > deps.clock.now()) return arm(now);
      backSaid.add(said(now, next));
      say(now, { kind: "back" });
    };
    timers.set(blocked.key, deps.clock.schedule(() => void fire().catch(() => {}), Math.min(Math.max(0, end - deps.clock.now()), LONGEST_WAIT_MS), { unref: true }));
  };

  return {
    read: (before, after) => {
      for (const alert of planAlertsOf(before, after, deps.clock.now())) {
        if (alert.kind === "back") {
          cancel(after.key);
          if (before !== undefined && backSaid.delete(said(before, blockEndsAt(before)))) continue;
        }
        say(after, alert);
        if (alert.kind === "blocked") arm(after);
      }
    },
    resume: async () => {
      for (const l of await deps.limits()) {
        const end = blockEndsAt(l);
        if (end !== undefined && end > deps.clock.now()) arm(l);
      }
    },
    close: () => {
      for (const stop of timers.values()) stop();
      timers.clear();
    },
  };
}
