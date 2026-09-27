// Adapted from pingdotgg/t3code apps/web/src/composer-editor-mentions.ts and
// packages/shared/src/composerInlineTokens.ts at 57a66608 (MIT).
// Differs from upstream: every chip is sent as the plain text an agent reads,
// so the prompt carries no placeholder and no side list: a file is @path, a
// skill is $name, a terminal excerpt is a fenced block under one header line,
// and a quote or a pull request or issue is a Markdown blockquote under one.
// Each segment keeps the text it was read from, which is what a chip sends.
// A bare @scope/package stays a file here, since @path is the wire form.
import type { HostItem, HostItemKind } from "@wsp/protocol";

export type ComposerCitationKind = "quote" | HostItemKind;

export type ComposerPromptSegment =
  | { type: "text"; text: string }
  | { type: "mention"; path: string; source: string }
  | { type: "skill"; name: string; source: string }
  | { type: "terminal"; label: string; text: string; source: string }
  | {
      type: "citation";
      kind: ComposerCitationKind;
      /** The item's number; 0 for a quote. */
      number: number;
      /** A quote's is the prompt its reply answered, empty where there was none. */
      title: string;
      body: string;
      url: string;
      source: string;
    };

export type ComposerTokenSegment = Exclude<ComposerPromptSegment, { type: "text" }>;

const SIMPLE_MENTION_PATH = /^[^\s@"\\]+$/;

export function serializeComposerMention(path: string): string {
  return SIMPLE_MENTION_PATH.test(path) ? `@${path}` : `@"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function quoted(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

export function terminalExcerptText(input: { label: string; text: string }): string {
  const body = input.text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map(run => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `Terminal output from ${oneLine(input.label)}:\n${fence}\n${body}\n${fence}`;
}

/** How many characters of the prompt a quote's header names its reply by. */
const REPLY_TO_CHARS = 60;

export function quoteText(input: { replyTo: string | null; text: string }): string {
  const replyTo = input.replyTo === null ? "" : oneLine(input.replyTo).replaceAll('"', "'");
  const named = replyTo.length > REPLY_TO_CHARS ? `${replyTo.slice(0, REPLY_TO_CHARS - 1)}…` : replyTo;
  const header = named.length > 0 ? `Quoting your reply to "${named}":` : "Quoting your reply:";
  return `${header}\n${quoted(input.text.trim())}`;
}

const ITEM_NOUN: Record<HostItemKind, string> = { "pull-request": "Pull request", issue: "Issue" };

export function hostItemText(item: HostItem): string {
  const body = item.body.trim();
  return `${ITEM_NOUN[item.kind]} #${item.number} "${oneLine(item.title)}" (${item.url}):\n${quoted(body.length > 0 ? body : "(no description)")}`;
}

const MENTION_TOKEN = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g;
const SKILL_TOKEN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s)/g;
const TERMINAL_BLOCK = /(^|\n)(Terminal output from ([^\n]+):\n(`{3,})\n([\s\S]*?)\n\4)(?=\n|$)/g;
const QUOTE_LINES = String.raw`>[^\n]*(?:\n>[^\n]*)*`;
const QUOTE_BLOCK = new RegExp(String.raw`(^|\n)(Quoting your reply(?: to "([^"\n]*)")?:\n(${QUOTE_LINES}))(?=\n|$)`, "g");
const ITEM_BLOCK = new RegExp(String.raw`(^|\n)((Pull request|Issue) #(\d+) "([^\n]*)" \((\S+)\):\n(${QUOTE_LINES}))(?=\n|$)`, "g");

const unquoted = (lines: string): string =>
  lines
    .split("\n")
    .map(line => line.replace(/^> ?/, ""))
    .join("\n");

interface Found {
  start: number;
  end: number;
  segment: ComposerTokenSegment;
}

type Unsourced<T> = T extends unknown ? Omit<T, "source"> : never;

function found(match: RegExpMatchArray, source: string, segment: Unsourced<ComposerTokenSegment>): Found {
  const start = (match.index ?? 0) + (match[1] ?? "").length;
  return { start, end: start + source.length, segment: { ...segment, source } as ComposerTokenSegment };
}

/** Every chip in the text, earliest first; a match inside a block already taken is text of that block. */
function collectTokens(text: string): Found[] {
  const all: Found[] = [];
  for (const m of text.matchAll(TERMINAL_BLOCK)) all.push(found(m, m[2]!, { type: "terminal", label: m[3]!, text: m[5]! }));
  for (const m of text.matchAll(QUOTE_BLOCK)) all.push(found(m, m[2]!, { type: "citation", kind: "quote", number: 0, title: m[3] ?? "", body: unquoted(m[4]!), url: "" }));
  for (const m of text.matchAll(ITEM_BLOCK)) {
    const kind: HostItemKind = m[3] === "Issue" ? "issue" : "pull-request";
    const body = unquoted(m[7]!);
    all.push(found(m, m[2]!, { type: "citation", kind, number: Number(m[4]), title: m[5]!, body: body === "(no description)" ? "" : body, url: m[6]! }));
  }
  for (const m of text.matchAll(MENTION_TOKEN)) {
    const path = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "");
    if (path.length > 0) all.push(found(m, m[0].slice((m[1] ?? "").length), { type: "mention", path }));
  }
  for (const m of text.matchAll(SKILL_TOKEN)) all.push(found(m, `$${m[2]!}`, { type: "skill", name: m[2]! }));
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Found[] = [];
  let reached = 0;
  for (const token of all) {
    if (token.start < reached) continue;
    kept.push(token);
    reached = token.end;
  }
  return kept;
}

export function splitPromptIntoComposerSegments(prompt: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  let cursor = 0;
  for (const token of collectTokens(prompt)) {
    if (token.start > cursor) segments.push({ type: "text", text: prompt.slice(cursor, token.start) });
    segments.push(token.segment);
    cursor = token.end;
  }
  if (cursor < prompt.length) segments.push({ type: "text", text: prompt.slice(cursor) });
  return segments;
}

/** The block chips a pasted text carries, which read one way only; a pasted @word stays text, since code is full of
 * decorators and scoped packages. */
export function collectPastedBlockTokens(text: string): ReadonlyArray<{ start: number; end: number; segment: ComposerTokenSegment }> {
  return collectTokens(text).filter(token => token.segment.type === "terminal" || token.segment.type === "citation");
}

/** Whether a selection's edges fall on the whitespace a mention needs around it, where wrapping it in a pair of
 * symbols would join the mention to its neighbour. */
export function selectionTouchesMentionBoundary(prompt: string, start: number, end: number): boolean {
  if (!prompt || start >= end) return false;
  const inRange = (index: number) => start <= index && index < end;
  return collectTokens(prompt).some(({ segment, start: tokenStart, end: tokenEnd }) => {
    if (segment.type !== "mention") return false;
    const before = tokenStart - 1;
    return (before >= 0 && /\s/.test(prompt[before] ?? "") && inRange(before)) || (tokenEnd < prompt.length && /\s/.test(prompt[tokenEnd] ?? "") && inRange(tokenEnd));
  });
}
