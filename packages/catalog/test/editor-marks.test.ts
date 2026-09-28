// SPDX-License-Identifier: AGPL-3.0-only
import { EditorId } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { EDITOR_MARKS, editorMark } from "../src/index.js";

describe("editor marks", () => {
  it("every editor the host opens has its mark, Finder's among them, each editor under one mark", () => {
    expect(EditorId.options.filter(id => editorMark(id) === undefined)).toEqual([]);
    const claimed = EDITOR_MARKS.flatMap(m => m.editors);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(editorMark("rustrover")?.id).toBe("jetbrains");
    expect(editorMark("cursor")?.svg).toContain("M22.106 5.68");
  });

  it("every mark is T3's drawing, simple-icons' path or lucide's folder at a pinned release, under its license", () => {
    for (const m of EDITOR_MARKS) {
      expect(m.source, m.id).toMatch(/^https:\/\/github\.com\/(pingdotgg\/t3code\/blob\/d15210c\/apps\/web\/src\/components\/Icons\.tsx|simple-icons\/simple-icons\/blob\/16\.30\.0\/icons\/[a-z]+\.svg|lobehub\/lobe-icons\/blob\/[0-9a-f]+\/src\/Cursor\/components\/Mono\.tsx|lucide-icons\/lucide\/blob\/0\.564\.0\/icons\/folder\.svg)$/);
      expect(["MIT", "CC0-1.0", "ISC"], m.id).toContain(m.license);
    }
  });
});
