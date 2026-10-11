// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { keptPatch, wholeFileHunk, type FilePatch } from "../src/index.js";

const hunk = (at: number, lines: string[]) => ({ oldStart: at, oldLines: lines.length, newStart: at, newLines: lines.length, lines });

describe("an edit's hunks", () => {
  it("write a whole file as one hunk of every line, its last newline ending a line rather than adding one", () => {
    expect(wholeFileHunk("hi\nthere\n", "+")).toEqual({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+hi", "+there"] });
    expect(wholeFileHunk("gone", "-")).toEqual({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-gone"] });
    expect(wholeFileHunk("", "+")).toEqual({ oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [] });
  });

  it("keep the hunks that fit, in order across files, the one that crosses the cap cut to its lines before it, and say when any were left out", () => {
    const patch: FilePatch[] = [
      { path: "a", hunks: [hunk(1, ["-aaaa", "+bbbb"]), hunk(9, ["-cccc", "+dddd"])] },
      { path: "b", hunks: [hunk(1, ["-eeee", "+ffff"])] },
    ];
    expect(keptPatch(patch, 100)).toEqual({ patch });
    expect(keptPatch(patch, 20)).toEqual({ patch: [patch[0]!], patchCut: true });
    expect(keptPatch(patch, 15)).toEqual({ patch: [{ path: "a", hunks: [patch[0]!.hunks[0]!, { oldStart: 9, oldLines: 1, newStart: 9, newLines: 0, lines: ["-cccc"] }] }], patchCut: true });
    expect(keptPatch(patch, 4)).toEqual({ patch: [], patchCut: true });
    const created = { path: "n", hunks: [wholeFileHunk("one\ntwo\nthree\n", "+")] };
    expect(keptPatch([created], 9)).toEqual({ patch: [{ path: "n", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+one", "+two"] }] }], patchCut: true });
  });
});
