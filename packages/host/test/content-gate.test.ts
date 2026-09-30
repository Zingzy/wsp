// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { contentGateEnforced } from "./content-gate.js";

describe("where the daemon content gate is enforced", () => {
  it("enforces in the landing gate, which names the tree its cut has run on", () => {
    expect(contentGateEnforced({ WSP_DAEMON_CUT: "1" })).toBe(true);
  });

  it("enforces in ci on main, which is the tree that lands and the one that carries the cut", () => {
    expect(contentGateEnforced({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" })).toBe(true);
  });

  it("does not enforce on a branch, which carries no version: not on a builder's own computer and not in ci off main", () => {
    expect(contentGateEnforced({})).toBe(false);
    expect(contentGateEnforced({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/ticket/x" })).toBe(false);
    // A pull request run is on the merge ref, never on a branch.
    expect(contentGateEnforced({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/pull/1/merge" })).toBe(false);
  });
});
