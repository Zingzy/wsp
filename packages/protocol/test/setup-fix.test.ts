// SPDX-License-Identifier: AGPL-3.0-only
// Every row of a setup that did not land says what to do beside what
// happened, in words a person reads in the app: no internal word and no line
// for a terminal.
import { describe, expect, it } from "vitest";
import { NEEDS_GITHUB_LINE, SETUP_STEP_CLASS, setupRowFix, type PlaceSetupStep } from "../src/index.js";

describe("the fix half of a row that did not land", () => {
  it("names what to do for a row of every step, and the reason's own fix where the reason is known", () => {
    for (const step of Object.keys(SETUP_STEP_CLASS) as PlaceSetupStep[]) {
      const fix = setupRowFix({ step, note: "exit 1" }, "studio");
      expect(fix, step).toMatch(/^[A-Z].*\.$/);
      expect(fix).not.toMatch(/\bdaemons?\b|\bwsp [a-z]+ |this Mac|\u2014|\u00b7/i);
    }
    expect(setupRowFix({ step: "folders", note: NEEDS_GITHUB_LINE }, "studio")).toBe("Sign GitHub in on studio, then retry.");
    expect(setupRowFix({ step: "agents", note: "exit 1" }, "studio")).toContain("studio");
  });

  it("says nothing for a row with no step to read it by", () => {
    expect(setupRowFix({ note: "exit 1" }, "studio")).toBeUndefined();
  });
});
