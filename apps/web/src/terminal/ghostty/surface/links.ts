// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/terminal/ghostty/surface.ts at 57a66608 (MIT).
import { collectWrappedTerminalLinkLine, extractTerminalLinks } from "../../../terminal-links";
import type { GhosttySnapshot } from "../core";
import type { GhosttyCellRange } from "../renderer";

function terminalRowText(row: GhosttySnapshot["rowData"][number], trimRight: boolean): string {
  const text = row.cells.map((cell) => cell.text || " ").join("");
  return trimRight ? text.trimEnd() : text;
}

function terminalColumnOffset(row: GhosttySnapshot["rowData"][number], column: number): number {
  let offset = 0;
  for (let cellIndex = 0; cellIndex < column; cellIndex += 1) {
    offset += row.cells[cellIndex]?.text.length || 1;
  }
  return offset;
}

export function terminalLinkAtPosition(
  rows: GhosttySnapshot["rowData"],
  rowIndex: number,
  column: number,
): string | null {
  return terminalLinkAtPositionWithRange(rows, rowIndex, column)?.text ?? null;
}

export interface TerminalLinkWithRange {
  readonly text: string;
  readonly range: GhosttyCellRange;
}

function terminalColumnAtOffset(row: GhosttySnapshot["rowData"][number], offset: number): number {
  for (let column = 0; column < row.cells.length; column += 1) {
    const nextOffset = terminalColumnOffset(row, column + 1);
    if (offset < nextOffset) return column;
  }
  return Math.max(0, row.cells.length - 1);
}

export function terminalLinkAtPositionWithRange(
  rows: GhosttySnapshot["rowData"],
  rowIndex: number,
  column: number,
): TerminalLinkWithRange | null {
  const wrappedLine = collectWrappedTerminalLinkLine(rowIndex + 1, (index) => {
    const row = rows[index];
    if (!row) return null;
    return {
      isWrapped: row.isWrapContinuation,
      translateToString: (trimRight = false) => terminalRowText(row, trimRight),
    };
  });
  if (!wrappedLine) return null;
  // Only viewport rows are available: a wrapped line whose head scrolled above
  // the viewport would resolve a truncated match into a wrong link.
  const firstSegment = wrappedLine.segments[0];
  if (firstSegment && rows[firstSegment.bufferLineNumber - 1]?.isWrapContinuation) {
    return null;
  }
  const segment = wrappedLine.segments.find((value) => value.bufferLineNumber === rowIndex + 1);
  const row = rows[rowIndex];
  if (!segment || !row) return null;
  const lastSegment = wrappedLine.segments.at(-1);
  const lastRow = lastSegment ? rows[lastSegment.bufferLineNumber - 1] : undefined;
  // Ghostty's soft-wrap flag is authoritative: when the last collected row
  // still wraps onward, its continuation is outside the viewport.
  const continuesBelowViewport = lastRow !== undefined && lastRow.wrapsToNext;
  const offset = segment.startIndex + terminalColumnOffset(row, column);
  for (const match of extractTerminalLinks(wrappedLine.text)) {
    if (offset >= match.start && offset < match.end) {
      // A truncated tail must not activate as a complete link.
      if (match.end === wrappedLine.text.length && continuesBelowViewport) return null;
      const startSegment = wrappedLine.segments.find(
        (value) => match.start >= value.startIndex && match.start < value.endIndex,
      );
      const endSegment = wrappedLine.segments.find(
        (value) => match.end - 1 >= value.startIndex && match.end - 1 < value.endIndex,
      );
      const startRow = startSegment ? rows[startSegment.bufferLineNumber - 1] : undefined;
      const endRow = endSegment ? rows[endSegment.bufferLineNumber - 1] : undefined;
      if (!startSegment || !endSegment || !startRow || !endRow) return null;
      return {
        text: match.text,
        range: {
          start: {
            x: terminalColumnAtOffset(startRow, match.start - startSegment.startIndex),
            y: startSegment.bufferLineNumber - 1,
          },
          end: {
            x: terminalColumnAtOffset(endRow, match.end - 1 - endSegment.startIndex),
            y: endSegment.bufferLineNumber - 1,
          },
        },
      };
    }
  }
  return null;
}

export function terminalLinkAtColumn(row: GhosttySnapshot["rowData"][number], column: number) {
  return terminalLinkAtPosition([row], 0, column);
}
