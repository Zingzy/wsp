// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { ROW_LINE_MAX, absentComputer, awayMsOf, workspacePlace, workspaceState } from "../src/index.js";

describe("the one state of a computer that is not answering", () => {
  const now = Date.parse("2026-09-12T13:30:00.000Z");
  const reading = absentComputer("old-laptop", awayMsOf({ lastSeenAt: "2026-09-12T12:52:00.000Z" }, now));

  it("says the same thing in every slot that has to hold it", () => {
    expect(reading.word).toBe("Unreachable");
    // The table's slot stands beside three fact columns and holds one word; how long it has been is on the row's
    // title and in its detail's Answered row, which is where the figure already was.
    expect(reading.away).toBe("no answer");
    expect(reading.line).toBe("no answer 38 min · is it on?");
    expect(reading.said).toBe("old-laptop is not answering");
    expect(reading.will).toBe("it connects on its own when it is on");
    expect(reading.sentence).toBe("old-laptop is not answering; it connects on its own when it is on");
  });

  it("writes the row's line under the cap the row cuts at, so the half that says what to do is never the half that goes", () => {
    for (const ms of [0, 59 * 60_000, 23 * 3_600_000, 400 * 86_400_000, null]) {
      expect(absentComputer("old-laptop", ms).line.length).toBeLessThanOrEqual(ROW_LINE_MAX);
    }
  });

  it("says nothing about how long it has been when this host never heard from it", () => {
    expect(awayMsOf({}, now)).toBeNull();
    expect(absentComputer("old-laptop", null).away).toBe("no answer");
    expect(absentComputer("old-laptop", null).line).toBe("no answer · is it on?");
  });

  it("states the silence and asks, and never claims the computer is off, which this host cannot know", () => {
    // A computer that is on and simply not answering reads the same line, so the line may not diagnose: the host
    // knows the silence and that the computer dials in by itself, and nothing else.
    for (const ms of [0, 38 * 60_000, 23 * 3_600_000, null]) {
      const line = absentComputer("hetzner", ms).line;
      expect(line).not.toContain("turn it on");
      expect(line).not.toContain("switch");
      expect(line.startsWith("no answer")).toBe(true);
    }
  });

  it("names the computer a workspace stands on however the workspace got there", () => {
    expect(workspacePlace({ machineId: "place:p_oldlaptop" })).toBe("p_oldlaptop");
    expect(workspacePlace({ machineId: "ctr_9f", place: "p_oldlaptop" })).toBe("p_oldlaptop");
    expect(workspacePlace({ machineId: "sbx_44" })).toBeUndefined();
  });

  it("folds a computer that answers nothing into the state word every surface reads", () => {
    expect(workspaceState({ phase: "running", reach: "unreachable" })).toBe("unreachable");
  });
});
