// SPDX-License-Identifier: AGPL-3.0-only
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HARNESS_CLIENTS } from "../src/adapt/index.js";
import { HarnessMark, harnessInitials } from "../src/components/chat/HarnessMark.js";

describe("HarnessMark", () => {
  it("draws the glyph a harness's module registers, and initials for a harness without one", () => {
    for (const c of HARNESS_CLIENTS) {
      if (c.mark === undefined) continue;
      const { container } = render(<HarnessMark harness={c.harness} label="Whatever" />);
      const svg = container.querySelector(`svg[data-harness-mark="${c.harness}"]`);
      expect(svg?.getAttribute("viewBox")).toBe(c.mark.viewBox);
      expect(svg?.querySelector("path")?.getAttribute("d")).toBe(c.mark.path);
      expect(container.textContent).toBe("");
    }
    const { container } = render(<HarnessMark harness="codex" label="Codex" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector('[data-harness-mark="codex"]')?.textContent).toBe("CO");
  });

  it("initials: two letters of one word, first letters of two", () => {
    expect(harnessInitials("Codex")).toBe("CO");
    expect(harnessInitials("Gemini CLI")).toBe("GC");
    expect(harnessInitials("")).toBe("");
  });
});
