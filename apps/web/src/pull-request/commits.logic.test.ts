// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { commitDays, mergeFrom } from "./commits.logic.js";

const NOW = new Date("2026-09-27T12:00:00").getTime();
const commit = (oid: string, subject: string, at: string) => ({ oid: oid.padEnd(40, "0"), subject, body: "", at: new Date(at).toISOString(), author: "Zingzy" });

describe("the commits tab's rows", () => {
  it("groups the commits by day, the newest day and the newest commit first", () => {
    const days = commitDays(
      [
        commit("449f8e6", "feat: a finished thread reads Done", "2026-09-26T01:09:45"),
        commit("9703d1f", "fix: settled tiles rest muted", "2026-09-27T03:02:15"),
        commit("7502c31", "merge origin/main into ticket/1398 before the gate", "2026-09-27T04:15:23"),
        commit("1111111", "older", "2026-09-20T09:00:00"),
      ],
      NOW,
    );
    expect(days.map(d => [d.day, d.rows.map(r => r.sha)])).toEqual([
      ["Today", ["7502c31", "9703d1f"]],
      ["Yesterday", ["449f8e6"]],
      ["Sep 20", ["1111111"]],
    ]);
  });

  it("marks a merge commit and names the branch it brought in, as git and the landings here write it", () => {
    expect(
      [
        "merge: origin/main into ticket/1398-done-and-settle",
        "merge origin/main into ticket/1398-done-and-settle before the gate",
        "Merge branch 'main' into fix",
        "Merge remote-tracking branch 'origin/release' into fix",
        "Merge pull request #12 from o/feature",
        "fix: merge the two lists",
      ].map(mergeFrom),
    ).toEqual([{ from: "main" }, { from: "main" }, { from: "main" }, { from: "release" }, {}, null]);
  });

  it("carries the merge mark and the branch on a merge's row, and the line counts on every other row", () => {
    const [today] = commitDays(
      [
        { ...commit("c6318b7", "merge: origin/main into x", "2026-09-27T11:00:00"), parents: 2, additions: 426, deletions: 166 },
        { ...commit("9703d1f", "fix: settled tiles rest muted", "2026-09-27T10:00:00"), parents: 1, additions: 136, deletions: 41 },
      ],
      NOW,
    );
    expect(today!.rows[0]).toMatchObject({ sha: "c6318b7", merge: true, from: "main" });
    expect(today!.rows[0]).not.toHaveProperty("lines");
    expect(today!.rows[1]).toMatchObject({ sha: "9703d1f", merge: false, lines: { additions: 136, deletions: 41 } });
  });
});
