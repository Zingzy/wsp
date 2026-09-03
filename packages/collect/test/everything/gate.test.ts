// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { type Row, isLarge, sizeGate } from "../../src/index.js";

const row = (bytes: number, files: number, flags: Row["flags"] = [], measured: Row["measured"] = "exact"): Row => ({ id: ".x", name: "x", kind: "unknown", paths: ["~/.x"], bytes, files, mtime: 0, measured, flags, ticked: false });

describe("pass 7: size gate", () => {
  it("over 1 MB or over 50 files is large; at the boundary is not", () => {
    expect(isLarge(row(1_000_000, 50))).toBe(false);
    expect(isLarge(row(1_000_001, 1))).toBe(true);
    expect(isLarge(row(10, 51))).toBe(true);
  });

  it("adds the flag once and leaves other flags alone", () => {
    expect(sizeGate([row(2_000_000, 1, ["credential"]), row(2_000_000, 1, ["large"]), row(10, 1)]).map(r => r.flags)).toEqual([["credential", "large"], ["large"], []]);
  });

  it("a partial credential scan is its own flag, not large", () => {
    expect(sizeGate([row(10, 1, ["partial"])]).map(r => r.flags)).toEqual([["partial"]]);
  });

  it("a row whose walk hit the cap is large whatever it counted, an unmeasured one is not", () => {
    expect(sizeGate([row(10, 1, [], "lower-bound"), row(0, 0, [], "none")]).map(r => r.flags)).toEqual([["large"], []]);
  });
});
