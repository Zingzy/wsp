// SPDX-License-Identifier: AGPL-3.0-only
// Find in thread. The count reads the words of every row as if each fold stood open, so a match a settled turn, a tool
// group, a closed call or the list's window hides counts the same as one on screen. What is on screen is painted from
// the page's own text, so typing redraws no row.
import { createContext, use, useSyncExternalStore } from "react";
import { deriveMessagesTimelineRows, openedGroupOf, type ChatMessage, type DeriveRowsInput, type WorkLogEntry } from "../adapt";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "../../../lib/proposedPlan";
import { workEntryDisplayLabel, workEntryIsVisibleInGroup, workEntryLabelText, workEntryOpensOnto } from "../MessagesTimeline.logic";

/** One stretch of text a match can stand in: a message, a plan, or one tool call. */
export interface FindUnit {
  /** What the page marks it with, `data-find-unit`. */
  readonly key: string;
  /** The transcript row it stands in once its folds are open. */
  readonly rowId: string;
  /** Where that row comes among every row with every fold open. */
  readonly order: number;
  /** The turn whose fold hides it, and the tool group it is a call of. */
  readonly turnId: string | null;
  readonly groupId: string | null;
  readonly text: string;
}

/** Every match in reading order, as the unit it stands in and its offset there. */
export interface FindMatches {
  readonly unit: readonly number[];
  readonly at: readonly number[];
}

export const NO_MATCHES: FindMatches = { unit: [], at: [] };

const EVERY = { has: (_id: string) => true };

/** The units of a transcript, read off the rows it would draw with every turn and every tool group open. */
export function findUnits(input: DeriveRowsInput, workspaceRoot: string | undefined): FindUnit[] {
  const rows = deriveMessagesTimelineRows({ ...input, expandedTurnIds: EVERY, expandedWorkGroupIds: EVERY });
  const units: FindUnit[] = [];
  rows.forEach((row, order) => {
    if (row.kind === "message") {
      units.push({ key: row.id, rowId: row.id, order, turnId: row.message.role === "assistant" ? row.message.turnId : null, groupId: null, text: messageText(row.message) });
    } else if (row.kind === "proposed-plan") {
      units.push({ key: row.id, rowId: row.id, order, turnId: row.proposedPlan.turnId, groupId: null, text: planText(row.proposedPlan.planMarkdown, row.proposedPlan) });
    } else if (row.kind === "work") {
      const groupId = openedGroupOf(row);
      for (const entry of row.groupedEntries) {
        if (!workEntryIsVisibleInGroup(entry, row.isExpandedToolGroup)) continue;
        units.push({ key: entry.id, rowId: row.id, order, turnId: entry.turnId, groupId, text: workEntryText(entry, workspaceRoot) });
      }
    }
  });
  return units;
}

/** Matches never overlap, as a browser's find counts them, and case is ignored. */
export function findMatches(units: readonly FindUnit[], query: string): FindMatches {
  const needle = query.toLowerCase();
  if (needle.length === 0) return NO_MATCHES;
  const unit: number[] = [];
  const at: number[] = [];
  units.forEach(({ text }, index) => {
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
      unit.push(index);
      at.push(i);
    }
  });
  return { unit, at };
}

/** Which match of its unit the match at `index` is, counting from 0. */
export function nthInUnit(matches: FindMatches, index: number): number {
  let nth = 0;
  while (index - nth > 0 && matches.unit[index - nth - 1] === matches.unit[index]) nth++;
  return nth;
}

const texts = new WeakMap<object, { readonly root: string; readonly text: string }>();

/** A row's text, lower-cased once per object: a streamed chunk makes a new message, and every other stays as it was. */
function cached(of: object, root: string, read: () => string): string {
  const held = texts.get(of);
  if (held !== undefined && held.root === root) return held.text;
  const text = read().toLowerCase();
  texts.set(of, { root, text });
  return text;
}

/** A plan as its card draws it opened: the title over the plan without it. */
function planText(planMarkdown: string, of: object): string {
  return cached(of, "", () => `${proposedPlanTitle(planMarkdown) ?? "Proposed plan"}\n${markdownText(stripDisplayedPlanMarkdown(planMarkdown), true)}`);
}

function messageText(message: ChatMessage): string {
  return cached(message, "", () => markdownText(message.text, message.role === "assistant"));
}

/** A call's words as it reads opened: its label, unless a command stands where the label would, then what it opens
 * onto. A closed call whose label is its command or the harness's sentence for it paints nothing until it opens. */
function workEntryText(entry: WorkLogEntry, workspaceRoot: string | undefined): string {
  return cached(entry, workspaceRoot ?? "", () => {
    const opensOnto = workEntryOpensOnto(entry, workspaceRoot);
    const label = workEntryLabelText(workEntryDisplayLabel(entry, workspaceRoot));
    if (opensOnto === null) return label;
    return entry.command?.trim() ? opensOnto : `${label}\n${opensOnto}`;
  });
}

/** Whether a call's label is painted: one a command stands behind reads "Command" opened, so it is not searched. */
export const labelIsFound = (entry: WorkLogEntry): boolean => !entry.command?.trim();

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The words markdown draws, near enough that the count matches what the page shows: the marks around words go, a
 * link keeps its words, a fence keeps its code, and a table's cells are kept apart. */
export function markdownText(source: string, rawHtml: boolean): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of source.split("\n")) {
    const opens = FENCE.exec(line);
    if (fence !== null) {
      if (opens !== null && opens[1]!.startsWith(fence)) fence = null;
      else out.push(line);
      continue;
    }
    if (opens !== null) {
      fence = opens[1]!;
      continue;
    }
    out.push(proseText(line, rawHtml));
  }
  return out.join("\n");
}

const CODE_SPAN = /(`+)(.+?)\1/g;

function proseText(line: string, rawHtml: boolean): string {
  if (/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/.test(line) && line.includes("-")) return "";
  const stripped = line
    .replace(/^ {0,3}#{1,6}[ \t]+/, "")
    .replace(/^ {0,3}(>[ \t]?)+/, "")
    .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/, "");
  let text = "";
  let last = 0;
  for (const span of stripped.matchAll(CODE_SPAN)) {
    text += inlineText(stripped.slice(last, span.index), rawHtml) + span[2]!.trim();
    last = span.index + span[0].length;
  }
  return text + inlineText(stripped.slice(last), rawHtml);
}

function inlineText(text: string, rawHtml: boolean): string {
  let out = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
  if (rawHtml) out = out.replace(/<\/?[A-Za-z][^>]*>/g, "");
  return out
    .replace(/(\*\*|__|~~)(?=\S)(.*?\S)\1/g, "$2")
    .replace(/(^|[\s\p{P}])([*_~])(?=\S)(.*?\S)\2(?=$|[\s\p{P}])/gu, "$1$3")
    .replace(/\|/g, "\n")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

// ---------------------------------------------------------------------------
// The current match, which the rows that fold it open to, and the tool group lists that scroll to it.
// ---------------------------------------------------------------------------

export class FindTarget {
  #key: string | null = null;
  readonly #listeners = new Set<() => void>();
  /** Each open tool group's list by its row, which scrolls to one of its calls and says whether it holds it. */
  readonly groups = new Map<string, (key: string) => boolean>();

  get key(): string | null {
    return this.#key;
  }

  set(key: string | null): void {
    if (key === this.#key) return;
    this.#key = key;
    for (const listener of this.#listeners) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

export const TimelineFindCtx = createContext<FindTarget | null>(null);

const NEVER = () => () => {};

/** Whether the current match stands in this unit, which then opens to show it; only the unit it enters or leaves
 * draws again. */
export function useIsFindTarget(key: string): boolean {
  const target = use(TimelineFindCtx);
  const isTarget = () => target !== null && target.key === key;
  return useSyncExternalStore(target?.subscribe ?? NEVER, isTarget, isTarget);
}

// ---------------------------------------------------------------------------
// Painting what is on screen
// ---------------------------------------------------------------------------

export const FIND_HIGHLIGHT = "thread-find";
export const FIND_CURRENT_HIGHLIGHT = "thread-find-current";

/** Text inside these is the page's chrome, not the transcript's words: a code block's language, a button's label, and
 * the copy a shimmer draws over a live row. */
const SKIP = '[data-find-skip], button, [aria-hidden="true"]';

interface TextRun {
  readonly text: string;
  readonly nodes: readonly Text[];
  readonly starts: readonly number[];
}

function textRun(element: Element): TextRun {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const skip = node.parentElement?.closest(SKIP);
      return skip != null && element.contains(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(text.length);
    text += node.nodeValue ?? "";
  }
  return { text: text.toLowerCase(), nodes, starts };
}

function rangeOf(run: TextRun, from: number, to: number): Range | null {
  const start = locate(run, from, false);
  const end = locate(run, to, true);
  if (start === null || end === null) return null;
  const range = run.nodes[0]!.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/** The text node an offset of the run falls in; an end offset on a node's edge stays in the node before it. */
function locate(run: TextRun, offset: number, end: boolean): { node: Text; offset: number } | null {
  let low = 0;
  let high = run.nodes.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (end ? run.starts[mid]! < offset : run.starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  const node = run.nodes[low];
  return node === undefined ? null : { node, offset: offset - run.starts[low]! };
}

/** Every match drawn inside `root`, and the one that is `current`: its unit's `nth` match, or the unit's last where the
 * page draws fewer than the count read. */
export function findRanges(root: Element, query: string, current: { readonly key: string; readonly nth: number } | null): { all: Range[]; current: Range | null } {
  const needle = query.toLowerCase();
  const all: Range[] = [];
  let found: Range | null = null;
  if (needle.length === 0) return { all, current: found };
  let seen = 0;
  for (const element of root.querySelectorAll("[data-find-text]")) {
    const run = textRun(element);
    const inCurrent = current !== null && element.closest("[data-find-unit]")?.getAttribute("data-find-unit") === current.key;
    for (let i = run.text.indexOf(needle); i >= 0; i = run.text.indexOf(needle, i + needle.length)) {
      const range = rangeOf(run, i, i + needle.length);
      if (range === null) continue;
      all.push(range);
      if (inCurrent && seen <= current.nth) {
        found = range;
        seen++;
      }
    }
  }
  return { all, current: found };
}

/** Paints what `findRanges` found with the CSS highlight registry, where the page has one; clears it with none. */
export function paintFind(ranges: { all: Range[]; current: Range | null } | null): void {
  if (typeof CSS === "undefined" || CSS.highlights === undefined) return;
  if (ranges === null || ranges.all.length === 0) CSS.highlights.delete(FIND_HIGHLIGHT);
  else CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...ranges.all));
  if (ranges?.current == null) CSS.highlights.delete(FIND_CURRENT_HIGHLIGHT);
  else CSS.highlights.set(FIND_CURRENT_HIGHLIGHT, new Highlight(ranges.current));
}

/** Scrolls every box between the match and the transcript's own scroller until the match stands in view, clear of the
 * composer that rides over the transcript's foot. */
export function bringIntoView(range: Range, scroller: HTMLElement): void {
  for (let element = range.startContainer.parentElement; element !== null; element = element.parentElement) {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    if (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight) {
      const inset = element === scroller ? parseFloat(style.getPropertyValue("--chat-composer-inset")) || 0 : 0;
      const bottom = box.bottom - inset;
      if (rect.top < box.top + 8 || rect.bottom > bottom - 8) element.scrollTop += rect.top - (box.top + (bottom - box.top) * 0.4);
    }
    if (/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth && (rect.left < box.left || rect.right > box.right)) {
      element.scrollLeft += rect.left - (box.left + box.width * 0.3);
    }
    if (element === scroller) return;
  }
}
