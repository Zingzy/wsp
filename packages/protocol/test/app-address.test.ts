// SPDX-License-Identifier: AGPL-3.0-only
// The address that opens the app on one workspace: wsp init writes it after
// its first fork and the app's store reads it.
import { describe, expect, it } from "vitest";
import { workspaceFromHash, workspaceHash } from "../src/index.js";

describe("the workspace a page opens on", () => {
  it("round-trips an id through the hash", () => {
    expect(workspaceHash("ws_a1b2")).toBe("#w/ws_a1b2");
    expect(workspaceFromHash(workspaceHash("ws_a1b2"))).toBe("ws_a1b2");
  });

  it("names no workspace for the app's own hashes, an empty one, or no hash at all", () => {
    expect(workspaceFromHash("#gallery")).toBeUndefined();
    expect(workspaceFromHash("")).toBeUndefined();
    expect(workspaceFromHash("#w/")).toBeUndefined();
  });
});
