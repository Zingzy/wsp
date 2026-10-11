// SPDX-License-Identifier: AGPL-3.0-only
// The text find in thread searches, built from the entries the way their rows draw them. Each entry is cut into
// numbered parts, the same numbers the rows stamp on what they draw (`data-find-part`), and each part into the
// segments a match never crosses: a markdown block, a line break, a code block. A reply's markdown is parsed with the
// renderer's own plugins and read to the text the page shows, so a count here and the highlights there agree on bold,
// links and fences; a chip naming a file counts what it shows, and a diagram, math and an image count nothing.
import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import type { Nodes, Parents, Root } from "mdast";
import { CHAT_MARKDOWN_REMARK_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS } from "../../ChatMarkdown";
import { fileChipLabel, messageFileChips, normalizeMarkdownLinkHrefKey } from "../../markdown/links";
import { resolveInlineCodeFileLinkMeta, resolveMarkdownFileLinkMeta, rewriteMarkdownFileUriHref } from "../../../lib/markdownLinks";
import { stripDisplayedPlanMarkdown } from "../../../lib/proposedPlan";
import { workEntryBody, workEntryCanExpand, workEntryDisplayLabel, workEntryIsVisibleInGroup, workEntryLabelText } from "../MessagesTimeline.logic";
import type { TimelineEntry, WorkLogEntry } from "../adapt";
import { splitInsights } from "../insight";

/** How a part's text meets the page: a markdown body, a `<pre>` kept as written, or a line whose breaks read as spaces. */
export type PartKind = "markdown" | "pre" | "line";

export interface FindPart {
  readonly part: number;
  readonly segments: ReadonlyArray<string>;
  /** Searched only with Include tool calls on: a tool row, a Thinking row, a subagent's own tool lines. */
  readonly tool: boolean;
}

export interface FindDoc {
  readonly entryId: string;
  readonly parts: ReadonlyArray<FindPart>;
}

/** What a part of a row draws when the row is opened: the label, then the body under it. */
export const WORK_LABEL_PART = 0;
export const WORK_BODY_PART = 1;
/** A subagent's line i draws its label as part 2i and its detail as 2i + 1. */
export const subagentPart = (line: number, detail: boolean): number => line * 2 + (detail ? 1 : 0);

/** The text a part of the page shows, as the DOM walk reads it: a break outside a `<pre>` is a space. */
export const lineText = (text: string): string => text.replace(/\r?\n/g, " ");

const keep = (segments: string[]): string[] => segments.filter(s => s.trim().length > 0);

type MarkdownOptions = {
  readonly breaks: boolean;
  readonly rawHtml: boolean;
  readonly cwd: string | undefined;
  /** A reply, which the row cuts at its insight blocks and draws a piece at a time, as `splitInsights` says. */
  readonly reply?: { readonly streaming: boolean };
};

const processors = new Map<boolean, Processor<Root, Root, Root>>();
function processorFor(breaks: boolean): Processor<Root, Root, Root> {
  let processor = processors.get(breaks);
  if (processor === undefined) {
    processor = unified()
      .use(remarkParse)
      .use(breaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS) as unknown as Processor<Root, Root, Root>;
    processors.set(breaks, processor);
  }
  return processor;
}

const stripTags = (html: string): string => html.replace(/<[^>]*>/g, "");

/** Text with nothing markdown reads as syntax: no marks, no block starts, no hard breaks, no indented code. */
const PLAIN = /(?<![\s\S])(?![\s\S]*[\\`*_[\]<>#|~$!&=:])(?![\s\S]*^[ \t]*(?:[-+]|\d+[.)])(?:[ \t]|$))(?![\s\S]*(?:^ {4}|^\t| {2}$))[\s\S]*$/m;

/** Plain text read the way the parser would: paragraphs at blank lines, each line's edges trimmed, a single break a
 * space or, with breaks on, a segment of its own. */
function plainSegments(text: string, breaks: boolean): string[] {
  return text.split(/\n[ \t]*\n/).flatMap(paragraph => {
    const lines = paragraph.split("\n").map(line => line.trim()).filter(line => line.length > 0);
    return breaks ? lines : [lines.join(" ")];
  });
}

/** A message's markdown as the segments the renderer's page holds. */
export function markdownSegments(text: string, o: MarkdownOptions): string[] {
  if (text.trim().length === 0) return [];
  if (o.reply !== undefined) return splitInsights(text, o.reply.streaming).flatMap(piece => markdownSegments(piece.text, { ...o, reply: undefined }));
  return PLAIN.test(text) ? keep(plainSegments(text, o.breaks)) : parsedSegments(text, o);
}

/** The segments read off the parser itself, which plain text reaches without it. */
export function parsedSegments(text: string, o: MarkdownOptions): string[] {
  const processor = processorFor(o.breaks);
  const tree = processor.runSync(processor.parse(text)) as Root;
  const chips = messageFileChips(text, o.cwd);
  const chip = (meta: ReturnType<typeof resolveMarkdownFileLinkMeta>): void => {
    if (meta !== null) open += fileChipLabel(meta, chips.suffixByPath).join(" ");
  };
  const segments: string[] = [];
  let open = "";
  const flush = (): void => {
    segments.push(lineText(open));
    open = "";
  };
  const phrasing = (node: Nodes, insideLink: boolean): void => {
    switch (node.type) {
      case "text":
        open += node.value;
        return;
      case "inlineCode": {
        const meta = insideLink ? null : (chips.byCode.get(node.value.trim()) ?? resolveInlineCodeFileLinkMeta(node.value, o.cwd, o.cwd));
        if (meta !== null) chip(meta);
        else open += node.value;
        return;
      }
      case "html":
        open += o.rawHtml ? stripTags(node.value) : node.value;
        return;
      case "break":
        flush();
        return;
      case "link": {
        const href = normalizeMarkdownLinkHrefKey(rewriteMarkdownFileUriHref(node.url) ?? node.url);
        const meta = chips.byHref.get(href) ?? resolveMarkdownFileLinkMeta(href, o.cwd, o.cwd);
        if (meta !== null) return chip(meta);
        for (const child of node.children) phrasing(child, true);
        return;
      }
      case "linkReference":
        for (const child of node.children) phrasing(child, true);
        return;
      case "emphasis":
      case "strong":
      case "delete":
        for (const child of node.children) phrasing(child, insideLink);
        return;
      default:
        return;
    }
  };
  const block = (node: Nodes): void => {
    switch (node.type) {
      case "paragraph":
      case "heading":
      case "tableCell":
        flush();
        for (const child of node.children) phrasing(child, false);
        flush();
        return;
      case "code":
        flush();
        if (node.lang !== "mermaid") segments.push(node.value);
        return;
      case "html":
        flush();
        open = o.rawHtml ? stripTags(node.value) : node.value;
        flush();
        return;
      case "math":
      case "thematicBreak":
      case "definition":
      case "footnoteDefinition":
        return;
      default:
        if ("children" in node) for (const child of (node as Parents).children) block(child as Nodes);
    }
  };
  block(tree);
  flush();
  return keep(segments);
}

/** Markdown parts are read once per text: a finished message keeps its segments for as long as the thread is shown. */
export class FindTextCache {
  private readonly markdown = new Map<string, { readonly source: string; readonly key: string; readonly segments: ReadonlyArray<string> }>();

  segmentsOf(id: string, source: string, o: MarkdownOptions): ReadonlyArray<string> {
    const key = `${o.breaks}:${o.rawHtml}:${o.reply?.streaming ?? "-"}:${o.cwd ?? ""}`;
    const held = this.markdown.get(id);
    if (held !== undefined && held.source === source && held.key === key) return held.segments;
    const segments = markdownSegments(source, o);
    this.markdown.set(id, { source, key, segments });
    return segments;
  }

  /** Whether the entry's markdown is read already, so building it again costs nothing. */
  has(id: string, source: string): boolean {
    return this.markdown.get(id)?.source === source;
  }

  /** Lets go of every entry the thread no longer holds. */
  keepOnly(ids: ReadonlySet<string>): void {
    for (const id of this.markdown.keys()) if (!ids.has(id)) this.markdown.delete(id);
  }

  get size(): number {
    return this.markdown.size;
  }
}

function workParts(entry: WorkLogEntry, cwd: string | undefined): FindPart[] {
  if (!workEntryIsVisibleInGroup(entry, true)) return [];
  const label = workEntryDisplayLabel(entry, cwd);
  const labelText = workEntryLabelText(label);
  const parts: FindPart[] = [];
  // A label read off the command is the command's first line, which the body holds whole.
  if (!label.mono) parts.push({ part: WORK_LABEL_PART, segments: keep([lineText(labelText)]), tool: true });
  const body = workEntryCanExpand(entry, labelText) ? workEntryBody(entry, cwd) : null;
  if (body !== null) parts.push({ part: WORK_BODY_PART, segments: [body], tool: true });
  return parts;
}

/** One entry's parts, as its row draws them with every fold open. */
export function docOf(entry: TimelineEntry, cwd: string | undefined, cache: FindTextCache): FindDoc | null {
  const parts: FindPart[] = [];
  switch (entry.kind) {
    case "message": {
      const { text, role } = entry.message;
      if (role === "user") parts.push({ part: 0, segments: cache.segmentsOf(entry.id, text, { breaks: true, rawHtml: false, cwd }), tool: false });
      else if (role === "assistant") parts.push({ part: 0, segments: cache.segmentsOf(entry.id, text, { breaks: false, rawHtml: true, cwd, reply: { streaming: entry.message.streaming === true } }), tool: false });
      break;
    }
    case "proposed-plan":
      parts.push({ part: 0, segments: cache.segmentsOf(entry.id, stripDisplayedPlanMarkdown(entry.proposedPlan.planMarkdown), { breaks: false, rawHtml: true, cwd }), tool: false });
      break;
    case "subagent":
      entry.subagent.lines.forEach((line, i) => {
        const tool = line.kind !== "text";
        if (line.label !== "") parts.push({ part: subagentPart(i, false), segments: keep([lineText(line.label)]), tool });
        if (line.detail !== undefined) parts.push({ part: subagentPart(i, true), segments: keep([lineText(line.detail)]), tool });
      });
      break;
    case "work":
      parts.push(...workParts(entry.entry, cwd));
      break;
    case "permission":
      break;
    default: {
      const _exhaustive: never = entry;
      return null;
    }
  }
  const drawn = parts.filter(p => p.segments.length > 0);
  return drawn.length === 0 ? null : { entryId: entry.id, parts: drawn };
}
