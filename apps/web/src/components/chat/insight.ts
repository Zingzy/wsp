// SPDX-License-Identifier: AGPL-3.0-only

/** A reply's text cut where Claude Code's Explanatory and Learning output styles wrote an insight block: plain text,
 * an opener line `` `★ Insight ───…` `` and a closer line `` `───…` ``, with no event marking it. `offset` is where the
 * segment's text starts in the reply's, which names a shell block's run. */
export type ReplySegment = { kind: "markdown" | "insight"; text: string; offset: number };

// The star is U+2736 on Windows; the backticks are optional, but a backticked opener ends in one too.
const OPENER = /^ {0,3}(`?)[★✶]\s?Insights?[ \t]+─{3,}\1[ \t]*$/u;
const CLOSER = /^ {0,3}(`?)─{3,}\1[ \t]*$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

/** Marks each line that sits inside a fenced code block, fence lines included, by CommonMark's rules: a backtick
 * fence's info has no backtick, a closer is the same character at least as long with nothing after it, and an
 * unclosed fence runs to the end. */
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced = lines.map(() => false);
  let open: string | null = null;
  lines.forEach((line, i) => {
    const match = FENCE.exec(line);
    if (open === null) {
      if (match === null || (match[1]!.startsWith("`") && match[2]!.includes("`"))) return;
      open = match[1]!;
      fenced[i] = true;
      return;
    }
    fenced[i] = true;
    if (match !== null && match[1]![0] === open[0] && match[1]!.length >= open.length && match[2]!.trim() === "") open = null;
  });
  return fenced;
}

/** Splits a reply into markdown and insight segments. An opener with no closer below it is drawn open to the end
 * while the reply streams, and left as text once it is done. */
export function splitInsights(text: string, streaming: boolean): ReplySegment[] {
  const raw = text.split("\n");
  const lines = raw.map(line => line.replace(/\r$/u, ""));
  let at = 0;
  const starts = raw.map(line => {
    const start = at;
    at += line.length + 1;
    return start;
  });
  const fenced = fencedLines(lines);
  const segments: ReplySegment[] = [];
  /** The text of lines `from` to `to` inclusive, less blank lines at either edge. */
  const push = (kind: ReplySegment["kind"], from: number, to: number) => {
    while (from <= to && lines[from]!.trim() === "") from++;
    while (to >= from && lines[to]!.trim() === "") to--;
    if (kind === "markdown" && from > to) return;
    const offset = from > to ? starts[from] ?? text.length : starts[from]!;
    segments.push({ kind, text: from > to ? "" : text.slice(offset, starts[to]! + lines[to]!.length), offset });
  };
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || !OPENER.test(lines[i]!)) continue;
    let closer = i + 1;
    while (closer < lines.length && (fenced[closer] || !CLOSER.test(lines[closer]!))) closer++;
    if (closer === lines.length && !streaming) break;
    push("markdown", start, i - 1);
    push("insight", i + 1, closer - 1);
    start = closer + 1;
    i = closer;
  }
  if (start === 0) return [{ kind: "markdown", text, offset: 0 }];
  push("markdown", start, lines.length - 1);
  return segments;
}
