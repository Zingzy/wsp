// SPDX-License-Identifier: AGPL-3.0-only
// An edit's hunks as a tool result carries them: a whole file as one hunk, which both agents' adapters write, and the
// lines that fit a count of characters, which the transcript and a thread's head keep.
import type { FilePatch, PatchHunk } from "./index.js";

/** A file written whole or deleted, as the one hunk of its every line added or removed. */
export function wholeFileHunk(content: string, sign: "+" | "-"): PatchHunk {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const count = lines.length;
  const at = count === 0 ? 0 : 1;
  return sign === "+"
    ? { oldStart: 0, oldLines: 0, newStart: at, newLines: count, lines: lines.map(l => `+${l}`) }
    : { oldStart: at, oldLines: count, newStart: 0, newLines: 0, lines: lines.map(l => `-${l}`) };
}

/** A unified diff's hunk head; a count of one may be left out. */
export const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The hunks of a patch that fit within `chars` characters of lines, in order, by the event's own fields: the hunk
 * that crosses the cap keeps its lines before it, counted again, and patchCut says lines were left out. A file none
 * of whose lines fit is left out with them. */
export function keptPatch(patch: readonly FilePatch[], chars: number): { patch: FilePatch[]; patchCut?: true } {
  const kept: FilePatch[] = [];
  let used = 0;
  for (const file of patch) {
    const hunks: PatchHunk[] = [];
    for (const hunk of file.hunks) {
      const size = hunk.lines.reduce((n, l) => n + l.length, 0);
      if (used + size > chars) {
        const lines: string[] = [];
        for (const l of hunk.lines) {
          if ((used += l.length) > chars) break;
          lines.push(l);
        }
        const counted = (other: "+" | "-") => lines.filter(l => !l.startsWith(other) && !l.startsWith("\\")).length;
        if (lines.length > 0) hunks.push({ ...hunk, oldLines: counted("+"), newLines: counted("-"), lines });
        return { patch: hunks.length > 0 ? [...kept, { ...file, hunks }] : kept, patchCut: true };
      }
      used += size;
      hunks.push(hunk);
    }
    kept.push(file);
  }
  return { patch: kept };
}
