// SPDX-License-Identifier: AGPL-3.0-only
/** A count with its noun, the noun pluralised by an s: the one rule every line that counts rows, sessions, calls,
 * threads or a plan's files reads, so none of them says "1 sessions". A noun that does not take an s is spelled by
 * its caller. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A sentence opening read mid-line: its first letter lowered, the rest as written. */
export const lowerFirst = (words: string): string => `${words.charAt(0).toLowerCase()}${words.slice(1)}`;

/** One name inside a comma-joined list of names: quoted when the name carries that comma itself, so a free-text
 * label an agent wrote reads as one entry and not as two nameless ones. */
export function listedName(name: string): string {
  return name.includes(",") ? JSON.stringify(name) : name;
}

/** A list of names as every tally that names its rows prints it, each name by the rule above. */
export function nameList(names: readonly string[]): string {
  return names.map(listedName).join(", ");
}

/** A thread count with its noun, as the sidebar's counts and the verbs' lines say it. */
export function fmtThreads(n: number): string {
  return plural(n, "thread");
}

export const ELLIPSIS = "\u2026";

/** Text cut to at most room characters, at a word boundary where one fits, with the ellipsis counted inside the
 * room and drawn only where something was taken off. One rule for every line a surface cuts itself: a thread's
 * title from its opening turn, a sidebar row's third line. */
export function cutLine(text: string, room: number): string {
  if (text.length <= room) return text;
  const head = room - ELLIPSIS.length;
  return `${wordsWithin(text, head) ?? wholeCharacters(text, head).replace(SEPARATOR_TAIL, "")}${ELLIPSIS}`;
}

/** The text's first units up to room, with a pair the edge would split left out whole: half of one is no character,
 * and a JSON reader such as the Rust tool server's refuses the escape it is written as. */
function wholeCharacters(text: string, room: number): string {
  const head = text.slice(0, room);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** What a cut leaves dangling at its edge: the space it broke on and the punctuation that hung off the word before. */
const SEPARATOR_TAIL = /[\s,;:]+$/;

/** The whole words of a line that fit in the room, the separator they ended on taken off; nothing when the line's
 * first word alone overruns it. A word that ends exactly at the room's edge is kept whole. */
export function wordsWithin(line: string, room: number): string | undefined {
  const head = line.slice(0, room + 1);
  const boundary = head.lastIndexOf(" ");
  return boundary > 0 ? head.slice(0, boundary).replace(SEPARATOR_TAIL, "") : undefined;
}

/** Text cut to its last line: the last non-empty line with the whitespace collapsed, or nothing when the text has
 * none. The notify line ends with it and a switcher card shows it under the thread's title, so both read one rule. */
export function lastLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  const last = lines[lines.length - 1];
  return last === undefined ? undefined : last.replace(/\s+/g, " ").trim();
}

export const marked = (e: unknown, mark: string): e is Error => e instanceof Error && (e as unknown as Record<string, unknown>)[mark] === true;
