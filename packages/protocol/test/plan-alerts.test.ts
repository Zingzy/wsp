// SPDX-License-Identifier: AGPL-3.0-only
// When an account's plan running low is said: each step once per window as the
// reading gets worse, a block once, and a comeback once the block lifts.
import { describe, expect, it } from "vitest";
import { blockEndsAt, planAlertLine, planAlertsOf, type AccountLimit } from "../src/index.js";

const AT = 1_000_000;
const reading = (windows: AccountLimit["windows"], status?: AccountLimit["status"]): Pick<AccountLimit, "windows" | "status"> => ({ windows, ...(status !== undefined ? { status } : {}) });

describe("plan alerts", () => {
  it("says 70% and 90% of a window once each, and only as the reading gets worse", () => {
    expect(planAlertsOf(undefined, reading([{ kind: "session", usedPercent: 40 }]), AT)).toEqual([]);
    expect(planAlertsOf(reading([{ kind: "session", usedPercent: 40 }]), reading([{ kind: "session", usedPercent: 72 }]), AT)).toEqual([{ kind: "low", window: "session", step: 70 }]);
    expect(planAlertsOf(reading([{ kind: "session", usedPercent: 72 }]), reading([{ kind: "session", usedPercent: 80 }]), AT)).toEqual([]);
    expect(planAlertsOf(reading([{ kind: "session", usedPercent: 80 }]), reading([{ kind: "session", usedPercent: 78 }]), AT)).toEqual([]);
    expect(planAlertsOf(reading([{ kind: "session", usedPercent: 80 }]), reading([{ kind: "session", usedPercent: 91 }]), AT)).toEqual([{ kind: "low", window: "session", step: 90 }]);
    expect(planAlertsOf(reading([{ kind: "session", usedPercent: 91 }]), reading([{ kind: "session", usedPercent: 91 }]), AT)).toEqual([]);
  });

  it("a reading that jumps past both steps says the higher, and each window speaks for itself", () => {
    const before = reading([{ kind: "session", usedPercent: 10 }, { kind: "week", usedPercent: 60 }]);
    expect(planAlertsOf(before, reading([{ kind: "session", usedPercent: 95 }, { kind: "week", usedPercent: 71 }]), AT)).toEqual([{ kind: "low", window: "session", step: 90 }, { kind: "low", window: "week", step: 70 }]);
  });

  it("a window that started again since the last reading counts from nothing, so its new run says 70% again", () => {
    expect(planAlertsOf(reading([{ kind: "session", usedPercent: 95, resetsAt: AT - 1 }]), reading([{ kind: "session", usedPercent: 74, resetsAt: AT + 5 * 3_600_000 }]), AT)).toEqual([{ kind: "low", window: "session", step: 70 }]);
  });

  it("overage is use past the plan and says nothing", () => {
    expect(planAlertsOf(reading([{ kind: "overage", usedPercent: 0 }]), reading([{ kind: "overage", usedPercent: 99 }]), AT)).toEqual([]);
  });

  it("a block is said once, as itself and nothing lower, and a reading free of it after says the account is back", () => {
    const blocked = reading([{ kind: "session", usedPercent: 100, resetsAt: AT + 60_000 }], "reached");
    expect(planAlertsOf(reading([{ kind: "session", usedPercent: 80 }]), blocked, AT)).toEqual([{ kind: "blocked" }]);
    expect(planAlertsOf(blocked, blocked, AT)).toEqual([]);
    expect(planAlertsOf(blocked, reading([{ kind: "session", usedPercent: 2 }], "ok"), AT)).toEqual([{ kind: "back" }]);
    // A used-up window is a block where the agent printed no state at all.
    expect(planAlertsOf(reading([{ kind: "week", usedPercent: 95 }]), reading([{ kind: "week", usedPercent: 100 }]), AT)).toEqual([{ kind: "blocked" }]);
  });

  it("a block ends at the latest reset among its used-up windows, and nowhere for an account that is not blocked", () => {
    expect(blockEndsAt(reading([{ kind: "session", usedPercent: 100, resetsAt: AT + 10 }, { kind: "week", usedPercent: 100, resetsAt: AT + 99 }, { kind: "week_opus", usedPercent: 50, resetsAt: AT + 500 }], "reached"))).toBe(AT + 99);
    expect(blockEndsAt(reading([{ kind: "session", usedPercent: 60, resetsAt: AT + 10 }], "reached"))).toBe(AT + 10);
    expect(blockEndsAt(reading([{ kind: "session", usedPercent: 60, resetsAt: AT + 10 }]))).toBeUndefined();
  });

  it("says each alert in a line that names the account", () => {
    expect(planAlertLine("Claude Max", { kind: "low", window: "session", step: 70 })).toBe("Claude Max has used 70% of its session");
    expect(planAlertLine("Claude Max", { kind: "blocked" })).toBe("Claude Max reached its plan limit");
    expect(planAlertLine("Claude Max", { kind: "back" })).toBe("Claude Max can run again: its plan limit reset");
  });
});
