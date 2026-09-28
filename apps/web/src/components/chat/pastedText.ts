// Adapted from pingdotgg/t3code packages/client-runtime/src/textPaste.ts at c9a0e8a1 (MIT).
// Differs from upstream: a paste also becomes a file at 200 lines, since a
// log of a few hundred short lines stays under upstream's byte threshold; the
// first file is numbered like the rest; and there is no paste-as-text key.

/** Bytes of clipboard text past which a paste lands as a file rather than in the box. */
export const PASTED_TEXT_FILE_BYTES = 32 * 1024;
/** Lines of clipboard text past which a paste lands as a file rather than in the box. */
export const PASTED_TEXT_FILE_LINES = 200;

const encoder = new TextEncoder();

/** How many lines the text holds, a trailing newline closing the last rather than opening another. */
function lineCount(text: string): number {
  let lines = text.endsWith("\n") ? 0 : 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) lines++;
  return lines;
}

/** Whether a paste lands as a file: long text goes to the agent as something it can read in parts, and the box
 * keeps the words the person typed. The byte count is the one that matters for wide characters. */
export function pastesAsFile(text: string): boolean {
  if (text.length === 0) return false;
  return lineCount(text) >= PASTED_TEXT_FILE_LINES || text.length >= PASTED_TEXT_FILE_BYTES || encoder.encode(text).byteLength >= PASTED_TEXT_FILE_BYTES;
}

/** The next free pasted-text-N.txt among the names the composer already holds. */
export function nextPastedTextName(names: ReadonlyArray<string>): string {
  const taken = new Set(names.map(name => name.toLowerCase()));
  for (let n = 1; ; n++) if (!taken.has(`pasted-text-${n}.txt`)) return `pasted-text-${n}.txt`;
}
