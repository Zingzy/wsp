// SPDX-License-Identifier: AGPL-3.0-only
// What Claude Code says of a call's result beyond the words its model read, off the line's tool_use_result
// (measured on 2.1.296). A command that exits non-zero is an error whose words open with "Exit code N", and its
// tool_use_result is those words behind "Error: "; a clean one carries stdout and stderr and no code, which is also
// how a code the CLI took as fine reads (grep with no match, diff that differs: returnCodeInterpretation), so no
// code is read off it. An output too large for the model reaches it as a short preview while stdout keeps the
// CLI's own first 30000 characters and persistedOutputSize the bytes of the whole. An edit or a write carries
// structuredPatch, empty for a new file, whose content it carries instead.
import { wholeFileHunk, type FilePatch, type PatchHunk } from "@wsp/protocol";
import { num, rec, str, strArr } from "./fields.js";
import type { TurnDelta } from "./handback.js";

const EXIT_CODE = /^Exit code (-?\d+)(?:\n|$)/;
const FAILED_COMMAND = "Error: Exit code ";

function hunkOf(value: unknown): PatchHunk | undefined {
  const h = rec(value);
  const lines = strArr(h?.lines);
  const [oldStart, oldLines, newStart, newLines] = [num(h?.oldStart), num(h?.oldLines), num(h?.newStart), num(h?.newLines)];
  if (lines === undefined || oldStart === undefined || oldLines === undefined || newStart === undefined || newLines === undefined) return undefined;
  return { oldStart, oldLines, newStart, newLines, lines };
}

function patchOf(result: Record<string, unknown>): FilePatch[] | undefined {
  const path = str(result.filePath);
  if (path === undefined || !Array.isArray(result.structuredPatch)) return undefined;
  const hunks = result.structuredPatch.map(hunkOf).filter((h): h is PatchHunk => h !== undefined);
  const created = str(result.type) === "create" ? str(result.content) : undefined;
  if (hunks.length === 0 && created !== undefined && created !== "") hunks.push(wholeFileHunk(created, "+"));
  return hunks.length === 0 ? undefined : [{ path, hunks }];
}

/** The fields a result's delta takes off the line's tool_use_result, over the words the model read (`text`). The
 * tool_use_result is one call's, so a line answering more than one call (`blocks`) gives none. */
export function resultFacts(blocks: readonly unknown[], text: string, isError: boolean, toolUseResult: unknown): Partial<Pick<TurnDelta, "text" | "bytes" | "exitCode" | "patch">> {
  if (blocks.filter(b => str(rec(b)?.type) === "tool_result").length !== 1) return {};
  if (isError) {
    const code = typeof toolUseResult === "string" && toolUseResult.startsWith(FAILED_COMMAND) ? EXIT_CODE.exec(text)?.[1] : undefined;
    return code === undefined ? {} : { exitCode: Number(code) };
  }
  const result = rec(toolUseResult);
  if (result === undefined) return {};
  const patch = patchOf(result);
  if (patch !== undefined) return { patch };
  const whole = num(result.persistedOutputSize);
  const stdout = str(result.stdout);
  if (whole === undefined || stdout === undefined) return {};
  return { text: [stdout, str(result.stderr) ?? ""].filter(s => s !== "").join("\n"), bytes: whole };
}
