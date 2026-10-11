// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/chat/threadFindHighlights.ts at a8bdfdb5 (MIT).
// Differs from upstream: a scope is one numbered part of an entry (`data-find-part` under `data-find-entry`) rather
// than a row, so a match is found again by its entry, part and ordinal whatever else the row shows; the matcher is
// the find model's own; folds open through the find store rather than `beforematch`; and tool parts drop out of the
// walk while Include tool calls is off.
import { useEffect, useLayoutEffect, useRef } from "react";
import { spansIn, type Needle } from "./match";
import type { FindMatch } from "./search";

export const FIND_HIGHLIGHT = "thread-find";
export const FIND_CURRENT_HIGHLIGHT = "thread-find-current";

/** What a row stamps on the element that draws one part of an entry. */
export const findPartAttrs = (entryId: string, part: number | null): Record<string, string | number> =>
  part === null ? {} : { "data-find-entry": entryId, "data-find-part": part };

const PART = "[data-find-part]";
/** Text a row draws that no part holds: chrome, glyphs, chips, and what math and diagrams draw. A chip's own name, marked
 * `data-find-text`, is read all the same. */
const SKIP = [
  "svg",
  "img",
  "button",
  "[aria-hidden='true']",
  "[data-find-skip]",
  "[data-markdown-copy]",
  "[role='toolbar']",
  ".chat-markdown-codeblock-header",
  ".chat-markdown-codeblock[data-language='mermaid']",
  ".katex",
  ".katex-display",
  ".math-inline",
  ".math-display",
].join(", ");
const BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "pre", "blockquote", "table", "thead", "tbody", "tr", "td", "th", "div", "section", "details", "summary", "dl", "dt", "dd", "hr", "br"]);

/** Every match in one part's element, in reading order, the part's segments cut where the model cuts them. */
export function rangesIn(scope: Element, needle: Needle): Range[] {
  const ranges: Range[] = [];
  const doc = scope.ownerDocument;
  let text = "";
  let nodes: { node: Text; start: number; end: number }[] = [];
  const flush = (): void => {
    const searched = text.replace(/\n+$/, "");
    if (searched.trim().length > 0) {
      let at = 0;
      for (const [start, end] of spansIn(searched, needle, Number.MAX_SAFE_INTEGER)) {
        while (at < nodes.length && nodes[at]!.end <= start) at++;
        let last = at;
        while (last < nodes.length && nodes[last]!.end < end) last++;
        const first = nodes[at];
        const final = nodes[last];
        if (first === undefined || final === undefined) continue;
        const range = doc.createRange();
        range.setStart(first.node, start - first.start);
        range.setEnd(final.node, end - final.start);
        ranges.push(range);
      }
    }
    text = "";
    nodes = [];
  };
  const visit = (node: Node, inPre: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node as Text).data;
      const start = text.length;
      text += inPre ? value : value.replace(/\r?\n/g, " ");
      nodes.push({ node: node as Text, start, end: text.length });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element !== scope && element.hasAttribute("data-find-part")) return;
    // Chrome is skipped whole, but a file chip's name is text the person reads: what it marks as text is walked.
    if (element !== scope && element.matches(SKIP)) {
      for (const text of element.querySelectorAll("[data-find-text]")) visit(text, inPre);
      return;
    }
    const tag = element.tagName.toLowerCase();
    const block = BLOCKS.has(tag);
    if (block) flush();
    for (const child of element.childNodes) visit(child, inPre || tag === "pre");
    if (block) flush();
  };
  visit(scope, scope.closest("pre") !== null);
  flush();
  return ranges;
}

const keyOf = (entryId: string, part: number | string): string => `${entryId}\n${part}`;

/** The parts drawn inside `viewport` that the search reaches, by entry and part, each with its matches in order. */
export function collectRanges(viewport: Element, needle: Needle, tools: boolean, cache?: Map<Element, Range[]>): Map<string, Range[]> {
  const byPart = new Map<string, Range[]>();
  for (const scope of viewport.querySelectorAll(PART)) {
    if (!tools && scope.closest("[data-find-tool]") !== null) continue;
    if (scope.closest("[aria-hidden='true'], [inert]") !== null) continue;
    const entryId = scope.closest("[data-find-entry]")?.getAttribute("data-find-entry");
    if (entryId == null) continue;
    let ranges = cache?.get(scope);
    if (ranges === undefined) {
      ranges = rangesIn(scope, needle);
      cache?.set(scope, ranges);
    }
    const key = keyOf(entryId, scope.getAttribute("data-find-part")!);
    byPart.set(key, [...(byPart.get(key) ?? []), ...ranges]);
  }
  return byPart;
}

const highlightsWork = (): boolean => typeof CSS !== "undefined" && CSS.highlights !== undefined && typeof Highlight !== "undefined";

/** Paints every match in the parts on screen and the current one apart, again whenever rows mount, stream or open,
 * and hands the current match's range back once it is drawn. */
export function useFindHighlights(input: {
  readonly viewport: HTMLElement | null;
  readonly needle: Needle | null;
  readonly tools: boolean;
  readonly current: FindMatch | null;
  readonly onCurrent: (range: Range) => void;
}): void {
  const { viewport, needle, tools, current, onCurrent } = input;
  const latest = useRef({ current, onCurrent });
  useLayoutEffect(() => {
    latest.current = { current, onCurrent };
  });
  const repaintRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!highlightsWork()) return;
    const clear = (): void => {
      CSS.highlights.delete(FIND_HIGHLIGHT);
      CSS.highlights.delete(FIND_CURRENT_HIGHLIGHT);
    };
    if (viewport === null || needle === null) {
      clear();
      return;
    }
    const all = new Highlight();
    const now = new Highlight();
    CSS.highlights.set(FIND_HIGHLIGHT, all);
    CSS.highlights.set(FIND_CURRENT_HIGHLIGHT, now);
    const cache = new Map<Element, Range[]>();
    let byPart = new Map<string, Range[]>();
    let handed: Range | null = null;
    const select = (): void => {
      const { current: match, onCurrent: hand } = latest.current;
      now.clear();
      for (const ranges of byPart.values()) for (const range of ranges) all.add(range);
      const range = match === null ? undefined : byPart.get(keyOf(match.entryId, match.part))?.[match.ordinal];
      if (range === undefined) return;
      all.delete(range);
      now.add(range);
      if (range !== handed) {
        handed = range;
        hand(range);
      }
    };
    const repaint = (): void => {
      all.clear();
      byPart = collectRanges(viewport, needle, tools, cache);
      select();
    };
    repaintRef.current = select;
    let frame: number | null = null;
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const at = record.target.nodeType === Node.ELEMENT_NODE ? (record.target as Element) : record.target.parentElement;
        const scope = at?.closest(PART);
        if (scope != null) cache.delete(scope);
      }
      for (const scope of cache.keys()) if (!scope.isConnected) cache.delete(scope);
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          handed = null;
          repaint();
        });
      }
    });
    observer.observe(viewport, { subtree: true, childList: true, characterData: true });
    repaint();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      repaintRef.current = null;
      clear();
    };
  }, [viewport, needle, tools]);

  useEffect(() => {
    repaintRef.current?.();
  }, [current]);
}

/** Scrolls each box around the range just enough to show it: the transcript's own scroller clear of the find bar
 * above and the composer below, and any scroller inside it, a run of tool calls, a little clear of its edges. */
export function showRange(range: Range, transcript: Element, clearTop: number, clearBottom: number): void {
  for (let box = range.startContainer.parentElement; box !== null; box = box.parentElement) {
    const outer = box === transcript;
    if (outer || (/auto|scroll/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) {
      const rect = range.getBoundingClientRect();
      const frame = box.getBoundingClientRect();
      const top = frame.top + (outer ? clearTop : 8);
      const bottom = frame.bottom - (outer ? clearBottom : 8);
      if (rect.top < top) box.scrollTop -= top - rect.top;
      else if (rect.bottom > bottom) box.scrollTop += Math.min(rect.bottom - bottom, rect.top - top);
    }
    if (outer) return;
  }
}
