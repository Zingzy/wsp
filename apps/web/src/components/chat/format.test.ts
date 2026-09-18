// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { defaultsPickerLabel, DEFAULTS_WORD } from "./format";

const high = { value: "high", label: "High" };
const bypass = { value: "bypassPermissions", label: "Bypass" };
const kept = { value: "bypassPermissions", label: "Bypass on this Mac", short: "Bypass" };

describe("defaultsPickerLabel", () => {
  it("names the effort first and the access after it, either alone when the other is missing", () => {
    expect(defaultsPickerLabel(high, bypass)).toBe("High · Bypass");
    expect(defaultsPickerLabel(high, undefined)).toBe("High");
    expect(defaultsPickerLabel(undefined, bypass)).toBe("Bypass");
  });

  it("takes the short form where a row carries one", () => {
    expect(defaultsPickerLabel(high, kept)).toBe("High · Bypass");
  });

  it("falls back to the picker's own word when neither resolves", () => {
    expect(defaultsPickerLabel(undefined, undefined)).toBe(DEFAULTS_WORD);
  });
});
