// Adapted from pingdotgg/t3code apps/web/src/composer-logic.ts at 57a66608 (MIT),
// with the pull-request arm of detectComposerTrigger from c9a0e8a1.
// Differs from upstream: the citation formatter went with T3's citation links;
// a chip's expanded length is the text it is sent as, read off its segment,
// so a block chip spanning lines maps like a one-line mention; the skill arm
// reads `$` alone; parseStandaloneComposerSlashCommand went with the built-in
// plan and default commands.
import { splitPromptIntoComposerSegments, type ComposerPromptSegment } from "./composer-editor-mentions";

export type ComposerTriggerKind = "path" | "pull-request" | "slash-command" | "skill";
export type ComposerSubmissionIntent = "foreground" | "background";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export function composerSubmissionIntentForEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
  modifierKey: boolean;
  isDraftThread: boolean;
}): ComposerSubmissionIntent | null {
  if (input.isMobileViewport || input.shiftKey) {
    return null;
  }
  return input.modifierKey && input.isDraftThread ? "background" : "foreground";
}

const isInlineTokenSegment = (segment: ComposerPromptSegment): boolean => segment.type !== "text";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

const expandedLength = (segment: ComposerPromptSegment): number => (segment.type === "text" ? segment.text.length : segment.source.length);
const collapsedLength = (segment: ComposerPromptSegment): number => (segment.type === "text" ? segment.text.length : 1);

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const segments = splitPromptIntoComposerSegments(text);
  let remaining = clampCollapsedComposerCursor(text, cursorInput);
  let expanded = 0;
  for (const segment of segments) {
    if (segment.type !== "text") {
      if (remaining <= 1) return expanded + (remaining === 0 ? 0 : expandedLength(segment));
      remaining -= 1;
      expanded += expandedLength(segment);
      continue;
    }
    if (remaining <= segment.text.length) return expanded + remaining;
    remaining -= segment.text.length;
    expanded += segment.text.length;
  }
  return expanded;
}

function clampCollapsedForSegments(segments: ReadonlyArray<ComposerPromptSegment>, cursorInput: number): number {
  const length = segments.reduce((total, segment) => total + collapsedLength(segment), 0);
  if (!Number.isFinite(cursorInput)) return length;
  return Math.max(0, Math.min(length, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  return clampCollapsedForSegments(splitPromptIntoComposerSegments(text), cursorInput);
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const segments = splitPromptIntoComposerSegments(text);
  let remaining = clampCursor(text, cursorInput);
  let collapsed = 0;
  for (const segment of segments) {
    if (segment.type !== "text") {
      if (remaining === 0) return collapsed;
      if (remaining <= expandedLength(segment)) return collapsed + 1;
      remaining -= expandedLength(segment);
      collapsed += 1;
      continue;
    }
    if (remaining <= segment.text.length) return collapsed + remaining;
    remaining -= segment.text.length;
    collapsed += segment.text.length;
  }
  return collapsed;
}

export function isCollapsedCursorAdjacentToInlineToken(text: string, cursorInput: number, direction: "left" | "right"): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some(isInlineTokenSegment)) return false;
  const cursor = clampCollapsedForSegments(segments, cursorInput);
  let offset = 0;
  for (const segment of segments) {
    if (isInlineTokenSegment(segment)) {
      if (direction === "left" && cursor === offset + 1) return true;
      if (direction === "right" && cursor === offset) return true;
    }
    offset += collapsedLength(segment);
  }
  return false;
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch) {
    return { kind: "pull-request", query: pullRequestMatch[1] ?? "", rangeStart: tokenStart, rangeEnd: cursor };
  }
  if (token.startsWith("$")) {
    return { kind: "skill", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
  }
  if (!token.startsWith("@")) {
    return null;
  }
  return { kind: "path", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}

/** A block chip at the expanded caret, on lines of its own: a newline goes before it unless the caret opens a line,
 * and one after it unless a newline already follows. The cursor lands after the block. */
export function insertComposerBlock(text: string, expandedCursor: number, block: string): { text: string; cursor: number } {
  const at = clampCursor(text, expandedCursor);
  const before = at === 0 || text[at - 1] === "\n" ? "" : "\n";
  const after = text[at] === "\n" ? "" : "\n";
  return replaceTextRange(text, at, at, `${before}${block}${after}`);
}
