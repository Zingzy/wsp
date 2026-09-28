// SPDX-License-Identifier: AGPL-3.0-only
import { PROVIDER_KEY_WORDS } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { PROVIDER_MARKS, providerMark } from "../src/index.js";

describe("provider marks", () => {
  it("every provider a person can add has its mark, one module each, found by the provider's id", () => {
    expect(Object.keys(PROVIDER_KEY_WORDS).map(id => providerMark(id)?.provider)).toEqual(Object.keys(PROVIDER_KEY_WORDS));
    expect(new Set(PROVIDER_MARKS.map(m => m.provider)).size).toBe(PROVIDER_MARKS.length);
    expect(providerMark("not-a-provider")).toBeUndefined();
  });

  it("Solari's mark is an outline at the glyphs' 2px stroke, so it weighs what the computers beside it weigh", () => {
    expect(providerMark("solari")!.svg).toMatch(/^<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" [^>]*\/><\/svg>$/);
  });

  it("a provider's mark says which of its own pages it was read off and when", () => {
    for (const m of PROVIDER_MARKS) expect(m.source, m.id).toMatch(/^https:\/\/[^ ]+ \(read \d{4}-\d{2}-\d{2}(, [^)]+)?\)$/);
  });
});
