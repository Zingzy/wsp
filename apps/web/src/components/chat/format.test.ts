// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { effortPickerLabel } from "./format";

const high = { value: "high", label: "High" };
const oneM = { value: "1m", label: "1M" };

describe("effortPickerLabel", () => {
  it("names the effort first and the context window after it, either alone when the other is missing", () => {
    expect(effortPickerLabel(high, oneM)).toBe("High · 1M");
    expect(effortPickerLabel(high, undefined)).toBe("High");
    expect(effortPickerLabel(undefined, oneM)).toBe("1M");
  });

  it("falls back to the picker's own name when neither resolves", () => {
    expect(effortPickerLabel(undefined, undefined)).toBe("Effort");
  });
});
