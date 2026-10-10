// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { splitInsights } from "./insight";

/** The segments' kinds and texts, after checking each text sits at its offset in the reply's. */
function cut(text: string, streaming: boolean) {
  return splitInsights(text, streaming).map(segment => {
    expect(text.slice(segment.offset, segment.offset + segment.text.length)).toBe(segment.text);
    return { kind: segment.kind, text: segment.text };
  });
}

// The exact lines Claude Code 2.1.296's Explanatory output style asks for.
const OPENER = "`★ Insight " + "─".repeat(37) + "`";
const CLOSER = "`" + "─".repeat(49) + "`";

describe("splitInsights", () => {
  it("cuts the probe's exact bytes into text, insight and text", () => {
    const text = ["Reading the store first.", "", OPENER, "- The list remounts rows on scroll.", "- So no row takes focus.", CLOSER, "", "Now the edit."].join("\n");
    expect(cut(text, false)).toEqual([
      { kind: "markdown", text: "Reading the store first." },
      { kind: "insight", text: "- The list remounts rows on scroll.\n- So no row takes focus." },
      { kind: "markdown", text: "Now the edit." },
    ]);
  });

  it("reads the bare form, the Windows star and a blank-edged body", () => {
    const bare = ["★ Insight ─────", "", "One point.", "", "─────────"].join("\n");
    expect(cut(bare, false)).toEqual([{ kind: "insight", text: "One point." }]);
    const windows = ["`✶ Insight " + "─".repeat(37) + "`", "One point.", CLOSER].join("\n");
    expect(cut(windows, false)).toEqual([{ kind: "insight", text: "One point." }]);
  });

  it("keeps offsets on Windows line ends", () => {
    const text = ["Before.", OPENER, "Point.", CLOSER, "After."].join("\r\n");
    expect(cut(text, false)).toEqual([
      { kind: "markdown", text: "Before." },
      { kind: "insight", text: "Point." },
      { kind: "markdown", text: "After." },
    ]);
  });

  it("pairs each opener with its own closer", () => {
    const text = [OPENER, "First.", CLOSER, "Between.", OPENER, "Second.", CLOSER].join("\n");
    expect(cut(text, false)).toEqual([
      { kind: "insight", text: "First." },
      { kind: "markdown", text: "Between." },
      { kind: "insight", text: "Second." },
    ]);
  });

  it("leaves a block inside a fence alone, and skips a fenced dash line inside a block", () => {
    for (const fence of ["```", "~~~", "````md"]) {
      const close = fence.replace(/[a-z]+$/u, "");
      const text = [fence, OPENER, "Quoted.", CLOSER, close].join("\n");
      expect(cut(text, false)).toEqual([{ kind: "markdown", text }]);
    }
    const inner = [OPENER, "Look:", "```", "───────", "```", "Done.", CLOSER].join("\n");
    expect(cut(inner, false)).toEqual([{ kind: "insight", text: "Look:\n```\n───────\n```\nDone." }]);
  });

  it("never touches a dash line with no opener above it, nor a thematic break", () => {
    for (let length = 20; length <= 82; length++) {
      for (const line of ["─".repeat(length), "`" + "─".repeat(length) + "`"]) {
        const text = ["Tool output:", line, "more", line].join("\n");
        expect(cut(text, false)).toEqual([{ kind: "markdown", text }]);
        expect(cut(text, true)).toEqual([{ kind: "markdown", text }]);
      }
    }
    expect(cut("Above\n\n---\n\nBelow", false)).toEqual([{ kind: "markdown", text: "Above\n\n---\n\nBelow" }]);
  });

  it("draws an unclosed block open while streaming and leaves it as text once done", () => {
    const text = ["Before.", OPENER, "Still writing"].join("\n");
    expect(cut(text, true)).toEqual([
      { kind: "markdown", text: "Before." },
      { kind: "insight", text: "Still writing" },
    ]);
    expect(cut(text, false)).toEqual([{ kind: "markdown", text }]);
    const halfCloser = [OPENER, "Point.", "`" + "─".repeat(20)].join("\n");
    expect(cut(halfCloser, true)).toEqual([{ kind: "insight", text: "Point.\n`" + "─".repeat(20) }]);
  });
});
