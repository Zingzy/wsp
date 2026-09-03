// SPDX-License-Identifier: AGPL-3.0-only
// One rung of wsp init as a screen: a searchable list with group headings that
// tick as a unit, an all row, locked items that never move, and a detail pane
// for the highlighted item. Built on @clack/core so the frame diffing, raw
// mode, and cancel handling are clack's; the keys and the layout are ours.
import type { Key } from "node:readline";
import { createInterface, emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { Prompt, isCancel } from "@clack/core";
import { S_BAR, S_BAR_END, S_CHECKBOX_INACTIVE, S_CHECKBOX_SELECTED, S_STEP_ACTIVE, S_STEP_CANCEL, S_STEP_SUBMIT } from "@clack/prompts";
import { GUTTER, ellipsize, widthOf } from "./init-layout.js";

export interface SelectItem {
  id: string;
  label: string;
  /** One dim word or size in the second column. */
  hint?: string;
  group?: string;
  /** Lines for the detail pane while this item is highlighted; the reason a row is locked belongs here. */
  detail: string[];
  /** on: always ticked, cannot be unticked. off: never ticked. */
  lock?: "on" | "off";
  /** A row that cycles through answers on space instead of ticking; the first one is the tick. */
  choices?: readonly { value: string; label: string }[];
}

export type Entry =
  | { type: "all" }
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
  maxVisible?: number;
}

export interface RungAnswer {
  ticks: Set<string>;
  /** Answer per row that has choices. */
  choices: Map<string, string>;
}
export type RungSelectResult = ({ kind: "next" } & RungAnswer) | ({ kind: "back" } & RungAnswer) | { kind: "cancel" };

const DETAIL_LINES = 2;
/** The bar and its two spaces before every row. */
const EDGE = 3;
const dim = (s: string): string => styleText("dim", s);
const LOCK_WORD = { on: "always", off: "stays here" } as const;

export function matches(item: SelectItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
}

export function buildEntries(items: readonly SelectItem[], query: string, folded: ReadonlySet<string>): Entry[] {
  const shown = items.filter(i => matches(i, query));
  const out: Entry[] = [];
  if (query.trim() === "" && shown.some(tickable)) out.push({ type: "all" });
  let i = 0;
  while (i < shown.length) {
    const item = shown[i]!;
    if (item.group === undefined) {
      out.push({ type: "item", item });
      i += 1;
      continue;
    }
    const group = item.group;
    const members: SelectItem[] = [];
    while (i < shown.length && shown[i]!.group === group) members.push(shown[i++]!);
    const isFolded = folded.has(group);
    out.push({ type: "group", group, items: members, folded: isFolded });
    if (!isFolded) for (const m of members) out.push({ type: "item", item: m });
  }
  return out;
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
    this.on("cursor", action => this.onCursor(action));
    this.on("key", (_char, key) => {
      if (key.name === "escape") this.back = true;
    });
    this.on("userInput", q => {
      if (q !== this.lastQuery) {
        this.lastQuery = q;
        this.cursor = 0;
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
        this.cursor = Math.max(0, this.cursor - 1);
        return;
      case "down":
        this.cursor = Math.min(Math.max(0, entries.length - 1), this.cursor + 1);
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

  /** Two columns: labels as wide as the widest one that still leaves room for the second column, which is flush right. */
  private columns(width: number): { label: number; second: number } {
    const items = this.o.items;
    const labels = [3, ...items.map(i => i.label.length + (i.group !== undefined ? 2 : 0)), ...items.map(i => i.group?.length ?? 0)];
    const second = Math.max(
      fmtCount(items.length, items.length).length,
      ...items.map(i => this.second(i).length),
      ...[...new Set(items.map(i => i.group))].map(g => (g === undefined ? 0 : groupCount(items.filter(i => i.group === g), this.ticks()).length)),
    );
    const room = width - EDGE - 2 - GUTTER.length - second;
    return { label: Math.max(8, Math.min(Math.max(...labels), room)), second };
  }

  /** The second column of an item row: its answer, its lock, or its hint. */
  private second(i: SelectItem): string {
    if (i.choices !== undefined) return i.choices.find(c => c.value === this.choices.get(i.id))?.label ?? "";
    if (i.lock !== undefined) return LOCK_WORD[i.lock];
    return i.hint ?? "";
  }

  private line(glyph: string, label: string, second: string, indent: number, cols: { label: number; second: number }, current: boolean, primary: boolean): string {
    const field = ellipsize(label, cols.label - indent).padEnd(cols.label - indent);
    const text = current || primary ? field : dim(field);
    return `${" ".repeat(indent)}${current ? styleText("cyan", glyph) : glyph} ${text}${second !== "" ? `${GUTTER}${dim(second.padStart(cols.second))}` : ""}`.trimEnd();
  }

  private row(entry: Entry, current: boolean, cols: { label: number; second: number }): string {
    const ticks = this.ticks();
    const box = (on: boolean): string => (on ? S_CHECKBOX_SELECTED : dim(S_CHECKBOX_INACTIVE));
    switch (entry.type) {
      case "all": {
        const free = this.o.items.filter(tickable);
        const on = free.filter(i => ticks.has(i.id)).length;
        return this.line(box(free.length > 0 && on === free.length), "all", fmtCount(on, free.length), 0, cols, current, false);
      }
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
            : at.item.detail;
    return Array.from({ length: DETAIL_LINES }, (_, i) => lines[i] ?? "");
  }

  private frame(): string {
    const width = widthOf(this.o.output);
    const ticks = this.ticks();
    const withChoices = this.o.items.filter(i => i.choices !== undefined);
    const free = this.o.items.filter(tickable);
    const locked = this.o.items.filter(i => i.lock === "on").length;
    const answer = withChoices.length > 0 ? spreadOf(withChoices, this.choices) : fmtCount(free.filter(i => ticks.has(i.id)).length + locked, free.length + locked);
    const title = `${this.o.title}${GUTTER}${dim(this.o.counter)}`;

    if (this.state === "submit" || (this.state === "cancel" && this.back)) {
      return `${styleText("green", S_STEP_SUBMIT)}  ${title}\n${dim(S_BAR)}  ${dim(this.back ? "back" : answer)}`;
    }
    if (this.state === "cancel") {
      return `${styleText("red", S_STEP_CANCEL)}  ${title}\n${dim(S_BAR)}  ${dim("cancelled")}`;
    }

    const entries = this.entries();
    this.cursor = Math.min(this.cursor, Math.max(0, entries.length - 1));
    const at = entries[this.cursor];
    const maxVisible = this.o.maxVisible ?? 10;
    const start = Math.max(0, Math.min(this.cursor - Math.floor(maxVisible / 2), entries.length - maxVisible));
    const end = Math.min(entries.length, start + maxVisible);
    const cols = this.columns(width);
    const bar = dim(S_BAR);

    const lines: string[] = [];
    lines.push(`${styleText("cyan", S_STEP_ACTIVE)}  ${title}${withChoices.length > 0 ? `${GUTTER}${dim(answer)}` : ""}`);
    lines.push(`${bar}  ${dim("search")}  ${this.userInput}${styleText("inverse", " ")}`);
    if (this.o.items.length === 0) lines.push(`${bar}  ${dim("nothing found")}`);
    else if (entries.length === 0) lines.push(`${bar}  ${dim("no match")}`);
    for (let i = start; i < end; i++) lines.push(`${bar}  ${this.row(entries[i]!, i === this.cursor, cols)}`);
    const above = start;
    const below = entries.length - end;
    if (above > 0 || below > 0) {
      const parts = [above > 0 ? `↑ ${above} more` : "", below > 0 ? `↓ ${below} more` : ""].filter(p => p !== "");
      lines.push(`${bar}  ${dim(parts.join(GUTTER))}`);
    }
    lines.push(bar);
    for (const d of this.detail(at)) lines.push(`${bar}  ${dim(ellipsize(d, width - EDGE))}`.trimEnd());
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
