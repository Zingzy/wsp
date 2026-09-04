// SPDX-License-Identifier: AGPL-3.0-only
// The few rules every wsp init screen shares: cut to a width with an
// ellipsis, pad cells into aligned columns, print a duration, the bar down the
// left of the screen being answered, the help line, and a card in the frame.
import type { Writable } from "node:stream";
import { WriteStream } from "node:tty";
import { styleText } from "node:util";
import { S_STEP_SUBMIT, log, unicode } from "@clack/prompts";

export const GUTTER = "  ";
/** The bar and its end on the screen being answered; finished screens keep clack's thin ones. Both one cell wide, so focus moving never shifts a column. */
export const S_BAR_FOCUS = unicode ? "┃" : "|";
export const S_BAR_FOCUS_END = unicode ? "┗" : "+";

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

/** The line broken at word ends to fit the width, the rest indented (by two unless the caller says); a line that fits is left
 * as it is, a word longer than the width is cut on its own and the words after it go on. */
export function wrap(text: string, width: number, indent = "  "): string[] {
  if (text.length <= width) return [text];
  const lead = text.length - text.trimStart().length;
  let cut = text.lastIndexOf(" ", width);
  if (cut < lead) cut = text.indexOf(" ", lead);
  if (cut < 0) return [ellipsize(text, width)];
  return [ellipsize(text.slice(0, cut).trimEnd(), width), ...wrap(`${indent}${text.slice(cut + 1).trimStart()}`, width, indent)];
}

/** Whether the stream is a terminal. */
export const isTTY = (output: Writable | undefined): boolean => output !== undefined && "isTTY" in output && output.isTTY === true;

/** Colour depth in bits for what this process draws: 1 (none) off a terminal and when the env says so (NO_COLOR, TERM=dumb), else Node's reading of TERM and COLORTERM; FORCE_COLOR wins, as it does for styleText. */
export function colourDepth(tty: boolean, env: NodeJS.ProcessEnv = process.env): number {
  if (!tty && env["FORCE_COLOR"] === undefined) return 1;
  return WriteStream.prototype.getColorDepth(env);
}

/** One 256-colour grey around text; written only where colourDepth says the terminal has 256 colours (8 bits) or more. */
export const grey = (n: number, s: string): string => `\x1b[38;5;${n}m${s}\x1b[39m`;
// Greys from the middle of the ramp, so they read on dark and light backgrounds alike; the keys a step brighter than what they do.
const KEY_GREY = 247;
const DESC_GREY = 243;
const DOT = unicode ? " • " : "   ";

export interface HelpKey {
  key: string;
  does: string;
}

/** The help line under a screen at a colour depth: keys in one grey and what they do in a dimmer one from 256 colours up, plain keys and dim words at 16, plain text at none; entries joined with a dot. */
export function helpLine(keys: readonly HelpKey[], depth: number): string {
  if (depth <= 1) return keys.map(k => `${k.key} ${k.does}`).join(DOT);
  if (depth < 8) return keys.map(k => `${k.key} ${styleText("dim", k.does)}`).join(styleText("dim", DOT));
  return keys.map(k => `${grey(KEY_GREY, k.key)} ${grey(DESC_GREY, k.does)}`).join(grey(DESC_GREY, DOT));
}

/** The columns a card's bar and its two spaces take before each line. clack's log.message writes lines as they are
 * (its note is what wraps, at the columns minus 6), so a line kept inside widthOf minus this is never wrapped again. */
export const CARD_FRAME = 3;

/** A block in the frame: a bold title on the step glyph, then its lines down the bar, wrapped to the width. */
export function card(title: string, lines: readonly string[], output: Writable): void {
  const width = widthOf(output) - CARD_FRAME;
  log.message([styleText("bold", title), ...lines.flatMap(l => wrap(l, width))], { output, symbol: styleText("green", S_STEP_SUBMIT) });
}
