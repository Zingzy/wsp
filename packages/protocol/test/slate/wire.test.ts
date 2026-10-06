// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { RUNTIME_OPS, SLATE_OPS } from "../../src/index.js";

describe("the slate's wire", () => {
  it("takes every op SLATE_OPS declares, so an op added there alone is not refused as unknown", () => {
    for (const op of Object.keys(SLATE_OPS)) expect(RUNTIME_OPS).toContain(op);
  });
});
