// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { appendCostPoint, COST_HISTORY_CAP, type WorkspaceCostEvent } from "../src/index.js";

const tick = (minute: number, rate: number, accruedUsd: number): WorkspaceCostEvent => ({
  type: "workspace.cost",
  workspaceId: "ws_a",
  phase: rate > 0 ? "running" : "napping",
  rateUsdPerHour: rate,
  awakeMs: minute * 60_000,
  accruedUsd,
  at: new Date(Date.UTC(2026, 8, 5, 9, minute)).toISOString(),
});

describe("appendCostPoint", () => {
  it("keeps the first tick, the newest tick and the ticks either side of a rate change, nothing between", () => {
    let points: WorkspaceCostEvent[] = [];
    for (const t of [tick(0, 0.11, 0), tick(1, 0.11, 0.1), tick(2, 0.11, 0.2), tick(3, 0.11, 0.3)]) points = appendCostPoint(points, t);
    expect(points.map(p => p.at)).toEqual([tick(0, 0, 0).at, tick(3, 0, 0).at]);
    for (const t of [tick(4, 0, 0.3), tick(5, 0, 0.3), tick(6, 0, 0.3)]) points = appendCostPoint(points, t);
    expect(points.map(p => [p.at.slice(14, 16), p.rateUsdPerHour])).toEqual([["00", 0.11], ["03", 0.11], ["04", 0], ["06", 0]]);
    for (const t of [tick(7, 0.22, 0.3), tick(8, 0.22, 0.5)]) points = appendCostPoint(points, t);
    expect(points.map(p => p.at.slice(14, 16))).toEqual(["00", "03", "04", "06", "07", "08"]);
  });

  it("returns a new array and leaves the one given alone", () => {
    const before = [tick(0, 0.11, 0), tick(1, 0.11, 0.1)];
    const after = appendCostPoint(before, tick(2, 0.11, 0.2));
    expect(before).toHaveLength(2);
    expect(after).not.toBe(before);
    expect(after.map(p => p.at.slice(14, 16))).toEqual(["00", "02"]);
  });

  it("drops the oldest points past the cap", () => {
    let points: WorkspaceCostEvent[] = [];
    for (let i = 0; i < COST_HISTORY_CAP + 10; i++) points = appendCostPoint(points, tick(i, i % 2 === 0 ? 0.11 : 0, i));
    expect(points).toHaveLength(COST_HISTORY_CAP);
    expect(points.at(-1)!.awakeMs).toBe((COST_HISTORY_CAP + 9) * 60_000);
  });
});
