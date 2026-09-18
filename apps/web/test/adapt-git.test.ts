// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { repoAbsence } from "../src/adapt/index.js";

describe("repoAbsence", () => {
  it("reads the daemon's not-a-git-repo code as a folder outside any repository", () => {
    expect(repoAbsence(Object.assign(new Error("not inside a git repository"), { code: "not-a-git-repo" }))).toBe("none");
  });

  it("reads every other code the daemon typed as a read the machine refused", () => {
    expect(repoAbsence(Object.assign(new Error("outside the browsable roots"), { code: "outside-root" }))).toBe("refused");
  });

  it("reads a failure the daemon never typed as nothing known: the read did not happen, so no word is said about it", () => {
    expect(repoAbsence(new Error("socket closed"))).toBe("unknown");
    expect(repoAbsence(null)).toBe("unknown");
    expect(repoAbsence("not-a-git-repo")).toBe("unknown");
  });
});
