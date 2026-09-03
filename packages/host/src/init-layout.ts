// SPDX-License-Identifier: AGPL-3.0-only
// The few width rules every wsp init screen shares: cut to a width with an
// ellipsis, pad cells into aligned columns, and print a duration.
import type { Writable } from "node:stream";

export const GUTTER = "  ";

/** The text cut to fit width, ending in an ellipsis when anything was dropped. */
export function ellipsize(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

export type Align = "left" | "right";

/** Rows of cells padded so each column lines up, two spaces between columns, nothing after the last cell. */
export function table(rows: readonly (readonly string[])[], align: readonly Align[] = []): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map(row => {
    const cells = row.map((cell, i) => (align[i] === "right" ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)));
    return cells.join(GUTTER).trimEnd();
  });
}

/** Seconds to one decimal under a minute, then minutes and seconds. */
export function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The terminal width when the stream knows it, else clack's 80. Capped so a wide window does not spread the columns. */
export function widthOf(output: Writable | undefined, cap = 100): number {
  const columns = output !== undefined && "columns" in output && typeof output.columns === "number" ? output.columns : 80;
  return Math.min(columns, cap);
}

/** The terminal height when the stream knows it, else clack's 20. */
export function rowsOf(output: Writable | undefined): number {
  return output !== undefined && "rows" in output && typeof output.rows === "number" ? output.rows : 20;
}

/** The slice of `total` rows that fits `height` rows with the cursor kept near the middle. */
export function viewport(total: number, cursor: number, height: number): { start: number; end: number } {
  const h = Math.max(1, height);
  const start = Math.max(0, Math.min(cursor - Math.floor(h / 2), total - h));
  return { start, end: Math.min(total, start + h) };
}

/** The first labels then "+N more", naming up to three and fewer when the width is short; the last label is cut rather than dropped. */
export function summarize(labels: readonly string[], width: number, named = 3): string {
  const more = (n: number): string => (labels.length > n ? ` +${labels.length - n} more` : "");
  for (let n = Math.min(named, labels.length); n > 1; n--) {
    const line = `${labels.slice(0, n).join(", ")}${more(n)}`;
    if (line.length <= width) return line;
  }
  return labels.length === 0 ? "" : `${ellipsize(labels[0]!, width - more(1).length)}${more(1)}`;
}
