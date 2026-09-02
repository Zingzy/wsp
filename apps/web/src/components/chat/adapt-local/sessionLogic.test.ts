// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { workEntryIndicatesToolNeutralStatus } from "./sessionLogic";
import type { WorkLogEntry } from "./types";

const base = { id: "w1", createdAt: "2026-09-01T00:00:00.000Z", turnId: "t1" };

describe("workEntryIndicatesToolNeutralStatus", () => {
  it("keeps reasoning with text out of the neutral filter so it survives a settled turn", () => {
    const thinking: WorkLogEntry = { ...base, tone: "thinking", label: "Thinking", detail: "quiet reasoning" };
    expect(workEntryIndicatesToolNeutralStatus(thinking)).toBe(false);
  });

  it("still treats an empty thinking marker and an in-progress tool as neutral", () => {
    expect(workEntryIndicatesToolNeutralStatus({ ...base, tone: "thinking", label: "Thinking" })).toBe(true);
    expect(workEntryIndicatesToolNeutralStatus({ ...base, tone: "tool", label: "Bash", command: "ls", toolLifecycleStatus: "inProgress" })).toBe(true);
  });
});
