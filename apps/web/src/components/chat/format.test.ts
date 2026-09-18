// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { defaultsPickerLabel, DEFAULTS_WORD } from "./format";

const high = { value: "high", label: "High" };
const bypass = { value: "bypassPermissions", label: "Bypass" };
const kept = { value: "bypassPermissions", label: "Bypass on this Mac", short: "Bypass" };

describe("defaultsPickerLabel", () => {
  // The row's copy is sentence case, so the values on the button are too; the menu rows keep the catalog's capital.
  it("names the effort first and the access after it, either alone when the other is missing", () => {
    expect(defaultsPickerLabel(high, bypass)).toBe("high · bypass");
    expect(defaultsPickerLabel(high, undefined)).toBe("high");
    expect(defaultsPickerLabel(undefined, bypass)).toBe("bypass");
  });

  it("takes the short form where a row carries one, and leaves a name the binary spells in capitals", () => {
    expect(defaultsPickerLabel(high, kept)).toBe("high · bypass");
    expect(defaultsPickerLabel({ value: "xl", label: "XL" }, undefined)).toBe("XL");
  });

  it("falls back to the picker's own word when neither resolves", () => {
    expect(defaultsPickerLabel(undefined, undefined)).toBe(DEFAULTS_WORD);
  });
});
