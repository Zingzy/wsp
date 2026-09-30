// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { TurnSummary } from "../../adapt/view-model";
import { composerTasks } from "./composerTasks.logic";

const turn = (turnId: string, state: TurnSummary["state"] = "running"): TurnSummary =>
  ({ turnId, sessionId: "s", state, replied: false, prompt: "go", model: null, durationMs: null, waitedMs: null, costUsd: null, tokens: null, changes: null, error: null, startedAt: null, completedAt: null, checkpoint: null }) as TurnSummary;
const steps = [
  { text: "read the tests", key: "read the tests\n0", state: "done" as const, durationMs: 4_000 },
  { text: "fix the rounding", key: "fix the rounding\n0", state: "working" as const },
  { text: "push", key: "push\n0", state: "pending" as const },
];

describe("the tasks row on the composer's edge", () => {
  it("names the step the running turn is on, with how many of its own steps are done", () => {
    expect(composerTasks({ latestTurn: turn("t1"), running: true, plan: { turnId: "t1", steps }, asking: false })).toEqual({ step: "fix the rounding", done: 1, total: 3, steps });
  });

  it("names the first step still to do when none is working", () => {
    const waiting = steps.map(s => (s.state === "working" ? { ...s, state: "pending" as const } : s));
    expect(composerTasks({ latestTurn: turn("t1"), running: true, plan: { turnId: "t1", steps: waiting }, asking: false })?.step).toBe("fix the rounding");
  });

  it("is gone once the turn ends", () => {
    expect(composerTasks({ latestTurn: turn("t1", "completed"), running: false, plan: { turnId: "t1", steps }, asking: false })).toBeNull();
  });

  it("stands aside while the agent asks the person something", () => {
    expect(composerTasks({ latestTurn: turn("t1"), running: true, plan: { turnId: "t1", steps }, asking: true })).toBeNull();
  });

  it("carries no earlier turn's list into this one", () => {
    expect(composerTasks({ latestTurn: turn("t2"), running: true, plan: { turnId: "t1", steps }, asking: false })).toBeNull();
  });

  it("is gone when every step is done, or the list holds none", () => {
    const done = steps.map(s => ({ ...s, state: "done" as const }));
    expect(composerTasks({ latestTurn: turn("t1"), running: true, plan: { turnId: "t1", steps: done }, asking: false })).toBeNull();
    expect(composerTasks({ latestTurn: turn("t1"), running: true, plan: { turnId: "t1", steps: [] }, asking: false })).toBeNull();
  });
});
