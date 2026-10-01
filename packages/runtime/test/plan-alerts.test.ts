// SPDX-License-Identifier: AGPL-3.0-only
// The host's plan alerts on a clock the test turns by hand: a blocked account is
// told it is back at its reset, once, whether the timer or a reading gets there
// first, and an account blocked when the host starts has its comeback armed.
import { describe, expect, it } from "vitest";
import type { AccountLimit, UsageAlertEvent } from "@wsp/protocol";
import type { Clock } from "../src/clock.js";
import { planAlerts } from "../src/plan-alerts.js";

function handClock(start = 1_000_000) {
  let now = start;
  const due: { at: number; fn: () => void; live: boolean }[] = [];
  const clock: Clock = {
    now: () => now,
    schedule: (fn, ms) => {
      const timer = { at: now + ms, fn, live: true };
      due.push(timer);
      return () => void (timer.live = false);
    },
  };
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    for (const t of due.filter(t => t.live && t.at <= now)) {
      t.live = false;
      t.fn();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { clock, advance, pending: () => due.filter(t => t.live).length };
}

const HOUR = 3_600_000;
const limit = (over: Partial<AccountLimit>): AccountLimit => ({ key: "claude:acct", agent: "claude", label: "Claude Max", windows: [], readAt: 0, computers: ["here"], ...over });

function keeper(start?: number) {
  const { clock, advance, pending } = handClock(start);
  const said: UsageAlertEvent["alert"][] = [];
  let kept: AccountLimit[] = [];
  const alerts = planAlerts({ clock, emit: e => void said.push(e.alert), limits: async () => kept });
  return { alerts, said, advance, pending, clock, keep: (l: AccountLimit[]) => void (kept = l) };
}

describe("the host's plan alerts", () => {
  it("says a blocked account is back at its reset, by the timer, and the next reading does not say it again", async () => {
    const k = keeper();
    const blocked = limit({ status: "reached", windows: [{ kind: "session", usedPercent: 100, resetsAt: k.clock.now() + 2 * HOUR }] });
    k.keep([blocked]);
    k.alerts.read(limit({ windows: [{ kind: "session", usedPercent: 85 }] }), blocked);
    expect(k.said).toEqual([{ kind: "blocked" }]);
    await k.advance(HOUR);
    expect(k.said).toHaveLength(1);
    await k.advance(HOUR);
    expect(k.said).toEqual([{ kind: "blocked" }, { kind: "back" }]);
    const free = limit({ status: "ok", windows: [{ kind: "session", usedPercent: 3, resetsAt: k.clock.now() + 5 * HOUR }] });
    k.alerts.read(blocked, free);
    expect(k.said).toHaveLength(2);
  });

  it("a reading free of the block before the reset says it is back and the timer says nothing after", async () => {
    const k = keeper();
    const blocked = limit({ status: "reached", windows: [{ kind: "session", usedPercent: 100, resetsAt: k.clock.now() + 2 * HOUR }] });
    k.alerts.read(undefined, blocked);
    const free = limit({ status: "ok", windows: [{ kind: "session", usedPercent: 3 }] });
    k.keep([free]);
    k.alerts.read(blocked, free);
    await k.advance(3 * HOUR);
    expect(k.said).toEqual([{ kind: "blocked" }, { kind: "back" }]);
    expect(k.pending()).toBe(0);
  });

  it("arms the comeback of an account blocked when the host starts, and none for one whose reset has passed", async () => {
    const k = keeper();
    k.keep([limit({ status: "reached", windows: [{ kind: "week", usedPercent: 100, resetsAt: k.clock.now() + HOUR }] }), limit({ key: "codex:a", status: "reached", windows: [{ kind: "week", usedPercent: 100, resetsAt: k.clock.now() - HOUR }] })]);
    await k.alerts.resume();
    expect(k.pending()).toBe(1);
    await k.advance(HOUR);
    expect(k.said).toEqual([{ kind: "back" }]);
  });

  it("a reset further off than one wait reads again on waking and waits on", async () => {
    const k = keeper();
    const blocked = limit({ status: "reached", windows: [{ kind: "month", usedPercent: 100, resetsAt: k.clock.now() + 40 * 24 * HOUR }] });
    k.keep([blocked]);
    k.alerts.read(undefined, blocked);
    await k.advance(24 * HOUR);
    expect(k.said).toEqual([{ kind: "blocked" }]);
    expect(k.pending()).toBe(1);
  });

  it("closing lets every timer go", () => {
    const k = keeper();
    k.alerts.read(undefined, limit({ status: "reached", windows: [{ kind: "session", usedPercent: 100, resetsAt: k.clock.now() + HOUR }] }));
    expect(k.pending()).toBe(1);
    k.alerts.close();
    expect(k.pending()).toBe(0);
  });
});
