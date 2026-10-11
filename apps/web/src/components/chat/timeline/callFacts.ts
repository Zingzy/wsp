// SPDX-License-Identifier: AGPL-3.0-only
// What a command's block and an edit's block say about their call, read off its row: the duration, the lines of
// output or hunks a closed fold shows, and an edit's counts and heading (wsp-map#2027).
import type { FilePatch, PatchHunk } from "@wsp/protocol";
import type { FileDiffMetadata } from "@pierre/diffs";
import { getRenderablePatch } from "../../../lib/diffRendering";

/** Lines of output a block shows before its "+N lines", and of hunks; a text only a few lines over shows whole. */
export const OUTPUT_SHOWN = 10;
export const HUNKS_SHOWN = 16;
const FOLD_SLACK = 4;

/** How many of `lines` a closed fold shows. */
export const foldsAt = (lines: number, shown: number): number => (lines > shown + FOLD_SLACK ? shown : lines);

/** How long a command ran: milliseconds under a second, one decimal under ten, then the working timer's form. */
export function commandDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** The lines a closed output shows and how many it leaves out: the first, or for a failure the last, since a
 * failure's error is at the end. */
export function foldedOutput(text: string, failed: boolean): { shown: string; hidden: number } {
  const lines = text.replace(/\n$/, "").split("\n");
  const keep = foldsAt(lines.length, OUTPUT_SHOWN);
  return { shown: (failed ? lines.slice(lines.length - keep) : lines.slice(0, keep)).join("\n"), hidden: lines.length - keep };
}

export function patchStat(patch: ReadonlyArray<FilePatch>): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of patch)
    for (const hunk of file.hunks)
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
      }
  return { additions, deletions };
}

/** A file written whole: the one hunk both adapters send for it, every line added. */
export const isNewFile = (file: FilePatch): boolean => file.hunks.length === 1 && file.hunks[0]!.oldStart === 0 && file.hunks[0]!.oldLines === 0;
/** A file deleted whole, the same hunk the other way. */
const isGone = (file: FilePatch): boolean => file.hunks.length === 1 && file.hunks[0]!.newStart === 0 && file.hunks[0]!.newLines === 0;

/** An edit's heading: its verb, what it touched and the fact at its right, a count of lines for a new file and the
 * added and removed counts for any other. */
export function editHeading(patch: ReadonlyArray<FilePatch>, named: (path: string) => string): { verb: string; what: string; created: boolean } {
  const one = patch.length === 1 ? patch[0]! : null;
  if (one === null) return { verb: "Edited", what: `${patch.length} files`, created: false };
  if (one.movedTo !== undefined) return { verb: "Moved", what: `${named(one.path)} to ${named(one.movedTo)}`, created: false };
  if (isNewFile(one)) return { verb: "Wrote", what: named(one.path), created: true };
  return { verb: isGone(one) ? "Deleted" : "Edited", what: named(one.path), created: false };
}

/** The first `count` lines of a file's hunks, a hunk cut short counted again, and how many lines were left out. */
export function foldHunks(hunks: ReadonlyArray<PatchHunk>, count: number): { hunks: PatchHunk[]; hidden: number } {
  const kept: PatchHunk[] = [];
  let left = count;
  let total = 0;
  for (const hunk of hunks) {
    total += hunk.lines.length;
    if (left <= 0) continue;
    const lines = hunk.lines.slice(0, left);
    left -= lines.length;
    kept.push(lines.length === hunk.lines.length ? hunk : { ...hunk, oldLines: lines.filter(l => !l.startsWith("+")).length, newLines: lines.filter(l => !l.startsWith("-")).length, lines });
  }
  return { hunks: kept, hidden: Math.max(0, total - count) };
}

/** A file's hunks as the unified patch @pierre/diffs parses, read into what its FileDiff draws. */
export function fileDiffOf(file: FilePatch, hunks: ReadonlyArray<PatchHunk>): FileDiffMetadata | null {
  const path = file.path.replace(/^\//, "");
  const to = file.movedTo?.replace(/^\//, "") ?? path;
  const head = isNewFile(file) ? ["--- /dev/null", `+++ b/${to}`] : isGone(file) ? [`--- a/${path}`, "+++ /dev/null"] : [`--- a/${path}`, `+++ b/${to}`];
  const body = hunks.flatMap(h => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]);
  const parsed = getRenderablePatch([`diff --git a/${path} b/${to}`, ...head, ...body, ""].join("\n"), "transcript");
  return parsed?.kind === "files" ? (parsed.files[0] ?? null) : null;
}
