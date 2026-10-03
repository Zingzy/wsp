// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compileSlate, sketchSlate, type Slate, type SlateJson } from "../../src/index.js";
import { PR_LINES, TRACKER_LINES, USAGE_LINES } from "./examples.js";

const NOW = Date.parse("2026-10-04T09:16:00Z");
const doc = (lines: string): Slate => compileSlate(lines).document!;
const world = (values: Record<string, SlateJson>) => ({ resolve: (p: string) => values[p], now: NOW });

describe("the sketch", () => {
  it("draws appendix G as the person sees it", () => {
    const week = NOW + (3 * 24 + 7) * 3_600_000;
    const sketch = sketchSlate(doc(USAGE_LINES), {}, world({
      "usage.account": { label: "zingzy", plan: "Max" },
      "thread.context": { used: 164_000, window: 1_000_000, free: 836_000, percent: 16.4 },
      "usage.session": { percent: 8, resetsAt: NOW + (3 * 60 + 24) * 60_000 },
      "usage.week": { percent: 46, resetsAt: week },
      "usage.note": null,
    }), { version: 1 });
    const weekday = new Date(week).toLocaleDateString("en-GB", { weekday: "long" });
    expect(sketch).toBe([
      'slate v1 "Usage", 11 pieces, 13 bound, 0 problems',
      "zingzy on Max  [who text muted small]",
      "Context  [context section]",
      "  16% used  [used text]",
      "  836k free of 1M  [free text muted]",
      "  This thread  [##........] 164k  [context-bar meter]",
      "5 hour  [#.........] 8%  resets in 3h 24m  [session meter]",
      `Weekly  [#####.....] 46%  resets in 3d 7h, ${weekday}  [week meter]`,
      "(hidden) [why text muted small]",
    ].join("\n"));
  });

  it("draws a table's rows, a row action where its when holds, and hides by when", () => {
    const sketch = sketchSlate(doc(PR_LINES), {}, world({
      "pr.number": 12, "pr.word": "checks failing", "pr.review": "none", "pr.mergeable": "unknown", "pr.additions": 3, "pr.deletions": 1,
      "pr.checks": [{ name: "lint", state: "pass", startedAt: "2026-10-04T09:10:00Z", completedAt: "2026-10-04T09:11:04Z" }, { name: "test", state: "fail" }],
    }), { version: 4 });
    expect(sketch.split("\n")).toEqual([
      'slate v4 "Pull request", 6 pieces, 11 bound, 0 problems',
      "(hidden) [none empty]",
      "State: checks failing  Review: none  Mergeable: unknown  [head facts]",
      "| Check | State | Took |  [checks table]",
      "| lint | pass | 1m 4s |",
      "| test | fail | running | [Send to agent]",
      "2 checks, 3 added, 1 removed  [summary text muted]",
      "[ Fix the failing checks ]  [fix button primary]",
    ]);
  });

  it("reads state from the live state, and says not read yet for a missing figure", () => {
    const sketch = sketchSlate(doc(TRACKER_LINES), { done: 3, total: 4, note: "ship it" }, world({ "thread.status": "working" }));
    expect(sketch).toContain("Steps  [########..] 3/4  3 of 4 done  [progress meter]");
    expect(sketch).toContain('Note for the agent: "ship it"  [note input]');
    expect(sketch).toContain("(hidden) [next button]");
    expect(sketch).toContain("  Nothing changed yet");
    expect(sketchSlate(doc('m: meter label="Weekly" value={usage.week.percent}'), {}, world({}))).toBe("slate, 1 piece, 1 bound, 0 problems\nWeekly  [..........] not read yet  [m meter]");
  });

  it("shows bindings in braces for a check with no thread, and lists problems", () => {
    const sketch = sketchSlate(doc('m: meter label="Weekly" value={usage.week.percent}'), {}, world({}), { unbound: true, problems: [{ code: "R900", name: "data-missing", message: "usage.week.percent has no value", piece: "m", prop: "value" }] });
    expect(sketch).toBe("slate, 1 piece, 1 bound, 1 problem\nWeekly  [{usage.week.percent} of 100]  [m meter]\nproblems:\n  R900 m.value: usage.week.percent has no value");
  });

  it("folds past 40 piece lines and caps the width", () => {
    const lines = ["root: column", ...Array.from({ length: 45 }, (_, i) => `  t${i}: text value="${"x".repeat(150)}"`)];
    const sketch = sketchSlate(doc(lines.join("\n")), {}, world({}));
    expect(sketch.split("\n").every(l => l.length <= 100)).toBe(true);
    expect(sketch).toContain("... and 5 more pieces");
  });

  it("says a cleared slate is empty", () => {
    expect(sketchSlate(null, {}, world({}), { version: 9 })).toBe("slate v9, empty: write one with slate set");
  });
});
