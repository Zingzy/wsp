// SPDX-License-Identifier: AGPL-3.0-only
// One rung of wsp init as a screen: a searchable list with group headings that
// tick as a unit, an all row, rows that always come along shown as bullets the
// cursor skips, a window sized to the terminal, and a detail pane for the
// highlighted item. Built on @clack/core so the frame diffing, raw mode, and
// cancel handling are clack's; the keys and the layout are ours.
import type { Key } from "node:readline";
import { createInterface, emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { Prompt, isCancel } from "@clack/core";
import { S_BAR, S_BAR_END, S_STEP_ACTIVE, S_STEP_CANCEL, S_STEP_SUBMIT } from "@clack/prompts";
import { GUTTER, ellipsize, rowsOf, summarize, viewport, widthOf } from "./init-layout.js";

export interface SelectItem {
  id: string;
  label: string;
  /** One dim word or size in the second column. */
  hint?: string;
  group?: string;
  /** Lines for the detail pane while this item is highlighted; the reason a row is locked belongs here. */
  detail: string[];
  /** on: always ticked, shown as a bullet the cursor skips. off: never ticked. */
  lock?: "on" | "off";
  /** A row that cycles through answers on space instead of ticking; the first one is the tick. */
  choices?: readonly { value: string; label: string }[];
}

export type Entry =
  | { type: "all" }
  | { type: "locked"; items: SelectItem[] }
  | { type: "bullet"; item: SelectItem }
  | { type: "more"; count: number }
  | { type: "group"; group: string; items: SelectItem[]; folded: boolean }
  | { type: "item"; item: SelectItem };

export interface RungSelectOptions {
  title: string;
  /** The section counter shown after the title ("2/7"). */
  counter: string;
  items: SelectItem[];
  initial: ReadonlySet<string>;
  /** Current answer per row that has choices. */
  initialChoices?: ReadonlyMap<string, string>;
  input?: Readable;
  output?: Writable;
}

export interface RungAnswer {
  ticks: Set<string>;
  /** Answer per row that has choices. */
  choices: Map<string, string>;
}
export type RungSelectResult = ({ kind: "next" } & RungAnswer) | ({ kind: "back" } & RungAnswer) | { kind: "cancel" };

const DETAIL_LINES = 2;
/** The bar, a space, the focus marker, a space before every row. */
const EDGE = 4;
/** Title, search, blank, the detail pane, the selected line, the hint; the two more-lines come on top when the list is windowed. */
const FIXED_LINES = 5 + DETAIL_LINES;
/** A locked group longer than this shows its first rows and "…and N more". */
export const LOCKED_CAP = 12;
/** The label column stops here; one long label is cut rather than pushing every second cell to the far edge. */
export const LABEL_CAP = 40;
const dim = (s: string): string => styleText("dim", s);
const LOCKED_WORD = "always included";
const SELECTED = "Selected: ";

export function matches(item: SelectItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
}

export const focusable = (e: Entry): boolean => e.type === "all" || e.type === "group" || e.type === "item";

export function buildEntries(items: readonly SelectItem[], query: string, folded: ReadonlySet<string>): Entry[] {
  const shown = items.filter(i => matches(i, query));
  const locked = shown.filter(i => i.lock === "on");
  const rest = shown.filter(i => i.lock !== "on");
  const out: Entry[] = [];
  if (locked.length > 0) {
    out.push({ type: "locked", items: locked });
    const bullets = locked.length > LOCKED_CAP ? locked.slice(0, LOCKED_CAP - 1) : locked;
    for (const item of bullets) out.push({ type: "bullet", item });
    if (bullets.length < locked.length) out.push({ type: "more", count: locked.length - bullets.length });
  }
  if (query.trim() === "" && rest.some(tickable)) out.push({ type: "all" });
  let i = 0;
  while (i < rest.length) {
    const item = rest[i]!;
    if (item.group === undefined) {
      out.push({ type: "item", item });
      i += 1;
      continue;
    }
    const group = item.group;
    const members: SelectItem[] = [];
    while (i < rest.length && rest[i]!.group === group) members.push(rest[i++]!);
    const isFolded = folded.has(group);
    out.push({ type: "group", group, items: members, folded: isFolded });
    if (!isFolded) for (const m of members) out.push({ type: "item", item: m });
  }
  return out;
}

/** The nearest focusable index from `at`, looking in `dir` first and back the other way when that side has none. */
export function settle(entries: readonly Entry[], at: number, dir: 1 | -1 = 1): number {
  const bounded = Math.min(Math.max(0, at), Math.max(0, entries.length - 1));
  for (let i = bounded; i >= 0 && i < entries.length; i += dir) if (focusable(entries[i]!)) return i;
  for (let i = bounded; i >= 0 && i < entries.length; i -= dir) if (focusable(entries[i]!)) return i;
  return 0;
}

const tickable = (i: SelectItem): boolean => i.lock === undefined && i.choices === undefined;

function flipAll(ticks: Set<string>, items: readonly SelectItem[]): void {
  const free = items.filter(tickable);
  const allOn = free.length > 0 && free.every(i => ticks.has(i.id));
  for (const i of free) {
    if (allOn) ticks.delete(i.id);
    else ticks.add(i.id);
  }
}

export function toggleEntry(ticks: Set<string>, entry: Entry, items: readonly SelectItem[]): void {
  switch (entry.type) {
    case "all":
      flipAll(ticks, items);
      return;
    case "group":
      flipAll(ticks, entry.items);
      return;
    case "item":
      if (!tickable(entry.item)) return;
      if (ticks.has(entry.item.id)) ticks.delete(entry.item.id);
      else ticks.add(entry.item.id);
      return;
    case "locked":
    case "bullet":
    case "more":
      return;
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

function fmtCount(on: number, of: number): string {
  return `${on} of ${of}`;
}

/** Ticks for a group of tick rows; the row count for a group of choice rows. */
function groupCount(items: readonly SelectItem[], ticks: ReadonlySet<string>): string {
  if (items.some(i => i.choices !== undefined)) return String(items.length);
  const free = items.filter(tickable);
  return fmtCount(free.filter(i => ticks.has(i.id)).length, free.length);
}

/** How the choice rows answered, the answers with none left out: "6 copy, 2 sign in". */
export function spreadOf(items: readonly SelectItem[], choices: ReadonlyMap<string, string>): string {
  const first = items.find(i => i.choices !== undefined)?.choices ?? [];
  return first
    .map(c => ({ n: items.filter(i => choices.get(i.id) === c.value).length, label: c.label }))
    .filter(p => p.n > 0)
    .map(p => `${p.n} ${p.label}`)
    .join(", ");
}

class RungPrompt extends Prompt<Set<string>> {
  cursor = 0;
  back = false;
  readonly folded = new Set<string>();
  readonly choices = new Map<string, string>();
  private lastQuery = "";

  constructor(private readonly o: RungSelectOptions) {
    super({ render: () => this.frame(), ...(o.input ? { input: o.input } : {}), ...(o.output ? { output: o.output } : {}) }, true);
    const ticks = new Set([...o.initial].filter(id => o.items.some(i => i.id === id)));
    for (const i of o.items) {
      if (i.lock === "on") ticks.add(i.id);
      if (i.lock === "off") ticks.delete(i.id);
      if (i.choices !== undefined) {
        const first = i.choices[0]?.value;
        const chosen = o.initialChoices?.get(i.id) ?? first;
        if (chosen !== undefined) this.choices.set(i.id, chosen);
        if (chosen === first) ticks.add(i.id);
        else ticks.delete(i.id);
      }
    }
    this.value = ticks;
    this.cursor = settle(this.entries(), 0);
    this.on("cursor", action => this.onCursor(action));
    this.on("key", (_char, key) => {
      if (key.name === "escape") this.back = true;
    });
    this.on("userInput", q => {
      if (q !== this.lastQuery) {
        this.lastQuery = q;
        this.cursor = settle(this.entries(), 0);
      }
    });
  }

  /** Space ticks instead of typing into the search. */
  protected override _isActionKey(_char: string | undefined, key: Key): boolean {
    return key.name === "space";
  }

  private entries(): Entry[] {
    return buildEntries(this.o.items, this.userInput, this.folded);
  }

  private ticks(): Set<string> {
    return this.value ?? new Set();
  }

  private onCursor(action?: string): void {
    const entries = this.entries();
    const at = entries[this.cursor];
    switch (action) {
      case "up":
        this.cursor = settle(entries, this.cursor - 1, -1);
        return;
      case "down":
        this.cursor = settle(entries, this.cursor + 1, 1);
        return;
      case "space":
        if (at?.type === "item" && at.item.choices !== undefined) this.cycle(at.item);
        else if (at) toggleEntry(this.ticks(), at, this.o.items);
        return;
      case "left": {
        const group = at?.type === "group" ? at.group : at?.type === "item" ? at.item.group : undefined;
        if (group === undefined) return;
        this.folded.add(group);
        this.cursor = Math.max(0, this.entries().findIndex(e => e.type === "group" && e.group === group));
        return;
      }
      case "right":
        if (at?.type === "group") this.folded.delete(at.group);
        return;
      default:
        return;
    }
  }

  /** Next answer for a choice row; the first answer is what the tick means. */
  private cycle(item: SelectItem): void {
    const choices = item.choices ?? [];
    if (item.lock !== undefined || choices.length === 0) return;
    const at = choices.findIndex(c => c.value === this.choices.get(item.id));
    const next = choices[(at + 1) % choices.length]!;
    this.choices.set(item.id, next.value);
    if (next.value === choices[0]!.value) this.ticks().add(item.id);
    else this.ticks().delete(item.id);
  }

  /** Two columns: labels as wide as the widest one up to the cap, leaving room for the second column, which is flush right. */
  private columns(width: number): { label: number; second: number } {
    const items = this.o.items;
    const hasLocked = items.some(i => i.lock === "on");
    const labels = [3, ...items.map(i => i.label.length + (i.group !== undefined || i.lock === "on" ? 2 : 0)), ...items.map(i => i.group?.length ?? 0), hasLocked ? this.o.title.length : 0];
    const second = Math.max(
      fmtCount(items.length, items.length).length,
      hasLocked ? LOCKED_WORD.length : 0,
      ...items.map(i => this.second(i).length),
      ...[...new Set(items.map(i => i.group))].map(g => (g === undefined ? 0 : groupCount(items.filter(i => i.group === g), this.ticks()).length)),
    );
    const room = width - EDGE - 2 - GUTTER.length - second;
    return { label: Math.max(8, Math.min(Math.max(...labels), room, LABEL_CAP)), second };
  }

  /** The second column of an item row: its answer, its lock, or its hint. */
  private second(i: SelectItem): string {
    if (i.choices !== undefined) return i.choices.find(c => c.value === this.choices.get(i.id))?.label ?? "";
    if (i.lock === "off") return "stays here";
    return i.hint ?? "";
  }

  private line(glyph: string, label: string, second: string, indent: number, cols: { label: number; second: number }, current: boolean, primary: boolean): string {
    const field = ellipsize(label, cols.label - indent).padEnd(cols.label - indent);
    const text = current || primary ? field : dim(field);
    return `${current ? styleText("cyan", "❯") : " "} ${" ".repeat(indent)}${glyph} ${text}${second !== "" ? `${GUTTER}${dim(second.padStart(cols.second))}` : ""}`.trimEnd();
  }

  private row(entry: Entry, current: boolean, cols: { label: number; second: number }): string {
    const ticks = this.ticks();
    const box = (on: boolean): string => (on ? styleText("cyan", "●") : dim("○"));
    switch (entry.type) {
      case "all": {
        const free = this.o.items.filter(tickable);
        const on = free.filter(i => ticks.has(i.id)).length;
        return this.line(box(free.length > 0 && on === free.length), "all", fmtCount(on, free.length), 0, cols, current, false);
      }
      case "locked":
        return this.line(dim("▾"), this.o.title, LOCKED_WORD, 0, cols, false, false);
      case "bullet":
        return this.line(dim("•"), entry.item.label, entry.item.hint ?? "", 2, cols, false, false);
      case "more":
        return `      ${dim(`…and ${entry.count} more`)}`;
      case "group":
        return this.line(entry.folded ? "▸" : "▾", entry.group, groupCount(entry.items, ticks), 0, cols, current, true);
      case "item": {
        const i = entry.item;
        return this.line(box(ticks.has(i.id)), i.label, this.second(i), i.group !== undefined ? 2 : 0, cols, current, false);
      }
      default: {
        const _exhaustive: never = entry;
        return _exhaustive;
      }
    }
  }

  private detail(at: Entry | undefined): string[] {
    const lines =
      at === undefined
        ? []
        : at.type === "all"
          ? ["every row on this screen that can be ticked"]
          : at.type === "group"
            ? [`${at.items.length} in ${at.group}`, "space ticks or clears the group"]
            : at.type === "item"
              ? at.item.detail
              : [];
    return Array.from({ length: DETAIL_LINES }, (_, i) => lines[i] ?? "");
  }

  /** The ticked labels in list order: the rows that always come along first, then the rest. */
  private selected(width: number): string {
    const ticks = this.ticks();
    const items = this.o.items;
    const labels = [...items.filter(i => i.lock === "on"), ...items.filter(i => i.lock !== "on" && ticks.has(i.id))].map(i => i.label);
    return labels.length === 0 ? "none" : summarize(labels, width);
  }

  private frame(): string {
    const width = widthOf(this.o.output);
    const withChoices = this.o.items.filter(i => i.choices !== undefined);
    const answer = withChoices.length > 0 ? spreadOf(withChoices, this.choices) : this.selected(width - EDGE);
    const title = `${this.o.title}${GUTTER}${dim(this.o.counter)}`;

    if (this.state === "submit" || (this.state === "cancel" && this.back)) {
      return `${styleText("green", S_STEP_SUBMIT)}  ${title}\n${dim(S_BAR)}  ${dim(this.back ? "back" : answer)}`;
    }
    if (this.state === "cancel") {
      return `${styleText("red", S_STEP_CANCEL)}  ${title}\n${dim(S_BAR)}  ${dim("cancelled")}`;
    }

    const entries = this.entries();
    this.cursor = settle(entries, this.cursor);
    const at = entries[this.cursor];
    // One row is left for the terminal's cursor line; a list that does not fit gives two more rows to the arrows.
    const room = rowsOf(this.o.output) - 1 - FIXED_LINES;
    const { start, end } = viewport(entries.length, this.cursor, entries.length <= room ? entries.length : room - 2);
    const cols = this.columns(width);
    const bar = dim(S_BAR);

    const lines: string[] = [];
    lines.push(`${styleText("cyan", S_STEP_ACTIVE)}  ${title}${withChoices.length > 0 ? `${GUTTER}${dim(answer)}` : ""}`);
    lines.push(`${bar}  ${dim("search")}  ${this.userInput}${styleText("inverse", " ")}`);
    if (this.o.items.length === 0) lines.push(`${bar}  ${dim("nothing found")}`);
    else if (entries.length === 0) lines.push(`${bar}  ${dim("no match")}`);
    if (start > 0) lines.push(`${bar}  ${dim(`↑ ${start} more`)}`);
    for (let i = start; i < end; i++) lines.push(`${bar} ${this.row(entries[i]!, i === this.cursor, cols)}`);
    if (end < entries.length) lines.push(`${bar}  ${dim(`↓ ${entries.length - end} more`)}`);
    lines.push(bar);
    for (const d of this.detail(at)) lines.push(`${bar}  ${dim(ellipsize(d, width - EDGE))}`.trimEnd());
    lines.push(`${bar}  ${dim(`${SELECTED}${this.selected(width - EDGE - SELECTED.length)}`)}`);
    lines.push(`${dim(S_BAR_END)}  ${dim(withChoices.length > 0 ? "space change   enter next   esc back" : "space tick   ← → fold   enter next   esc back")}`);
    return lines.join("\n");
  }
}

export async function rungSelect(o: RungSelectOptions): Promise<RungSelectResult> {
  const prompt = new RungPrompt(o);
  const result = await prompt.prompt();
  const answer: RungAnswer = { ticks: prompt.value ?? new Set<string>(), choices: prompt.choices };
  if (isCancel(result)) return prompt.back ? { kind: "back", ...answer } : { kind: "cancel" };
  return { kind: "next", ...answer };
}

/** One keypress, by name ("c", "return"); ctrl-c and escape resolve as "cancel". */
export function readKey(input: Readable, output: Writable, accept: readonly string[]): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input, output, terminal: true, prompt: "" });
    emitKeypressEvents(input, rl);
    const tty = input as Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
    if (tty.isTTY && tty.setRawMode) tty.setRawMode(true);
    const done = (value: string): void => {
      input.off("keypress", onKey);
      if (tty.isTTY && tty.setRawMode) tty.setRawMode(false);
      rl.close();
      resolve(value);
    };
    const onKey = (char: string | undefined, key: Key): void => {
      if (key.sequence === "\x03" || key.name === "escape") return done("cancel");
      const name = key.name ?? char;
      if (name !== undefined && accept.includes(name)) done(name);
    };
    input.on("keypress", onKey);
  });
}
