// SPDX-License-Identifier: AGPL-3.0-only
// One rung of wsp init as a screen: a searchable list with group headings that
// tick as a unit, an all row, rows that always come along shown as bullets the
// cursor skips, a window sized to the terminal, and a detail pane for the
// highlighted item. Built on @clack/core so the frame diffing, raw mode, and
// cancel handling are clack's; the keys and the layout are ours.
import type { Key } from "node:readline";
import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { Prompt, isCancel } from "@clack/core";
import { S_BAR, S_STEP_ACTIVE, S_STEP_CANCEL, S_STEP_SUBMIT } from "@clack/prompts";
import { GUTTER, S_BAR_FOCUS, S_BAR_FOCUS_END, colourDepth, ellipsize, helpLine, isTTY, rowsOf, summarize, viewport, widthOf, wrap, type HelpKey } from "./init-layout.js";

export interface SelectItem {
  id: string;
  label: string;
  /** The dim second column: a size, a state word, or a screen's own aligned columns (every row then padded to one width). */
  hint?: string;
  /** The second column as a function of the terminal width, read every frame; wins over hint. */
  hintFor?: (width: number) => string;
  group?: string;
  /** Lines for the detail pane while this item is highlighted; the reason a row is locked belongs here. */
  detail: string[];
  /** on: always ticked, shown as a bullet the cursor skips. off: never ticked. */
  lock?: "on" | "off";
  /** A row that cycles through answers on space instead of ticking; the first one is the tick. */
  choices?: readonly { value: string; label: string }[];
  /** Takes its own tick: the all row leaves it alone; its group header still flips it. */
  own?: boolean;
  /** Comes along with other rows rather than by a tick of its own: the box follows this over the ticks, space leaves it, no count includes it. */
  follows?: (ticks: ReadonlySet<string>) => boolean;
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
  /** Plain lines under the title, before the search: what the screen is for, when the rows alone do not say. */
  intro?: string[];
  /** Lines under the Selected line, rebuilt from the current ticks. */
  footer?: (ticks: ReadonlySet<string>) => string[];
  /** Rows the detail pane keeps for the highlighted item; two unless a screen has more to say. */
  detailLines?: number;
  /** Groups that start folded. */
  folded?: readonly string[];
  /** A second cell after a group header's count: its size, on a screen whose rows carry one. */
  groupHint?: (group: string, items: readonly SelectItem[]) => string | undefined;
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
/** Title, search, blank, the selected line, the hint; the detail pane, the footer and the two more-lines of a windowed list come on top. */
const FIXED_LINES = 5;
/** A locked group longer than this shows its first rows and "…and N more". */
export const LOCKED_CAP = 12;
/** The label column stops here; one long label is cut rather than pushing every second cell to the far edge. */
export const LABEL_CAP = 40;
const dim = (s: string): string => styleText("dim", s);
const LOCKED_WORD = "always included";
const SELECTED = "Selected: ";
const KEY_NEXT: HelpKey = { key: "enter", does: "next" };
const KEY_BACK: HelpKey = { key: "esc", does: "back" };
const KEY_FOLD: HelpKey = { key: "← →", does: "fold" };

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

const tickable = (i: SelectItem): boolean => i.lock === undefined && i.choices === undefined && i.follows === undefined;
/** What the all row flips: the tickable rows that do not take their own tick. */
const byAll = (i: SelectItem): boolean => tickable(i) && i.own !== true;
/** A row that comes along or can: always included, a tick, a tick of its own, or an answer. Only a row locked out is out, so
 * a screen's one denominator is what the found table called able to come. */
const unlocked = (i: SelectItem): boolean => i.lock !== "off" && i.follows === undefined;
/** A row that brings something: ticked, or answered with anything but its last choice. */
function chosen(i: SelectItem, ticks: ReadonlySet<string>, choices: ReadonlyMap<string, string>): boolean {
  if (i.choices === undefined) return ticks.has(i.id);
  const answer = choices.get(i.id);
  return answer !== undefined && answer !== i.choices.at(-1)?.value;
}

function flipAll(ticks: Set<string>, items: readonly SelectItem[], pick: (i: SelectItem) => boolean = tickable): void {
  const free = items.filter(pick);
  const allOn = free.length > 0 && free.every(i => ticks.has(i.id));
  for (const i of free) {
    if (allOn) ticks.delete(i.id);
    else ticks.add(i.id);
  }
}

export function toggleEntry(ticks: Set<string>, entry: Entry, items: readonly SelectItem[]): void {
  switch (entry.type) {
    case "all":
      flipAll(ticks, items, byAll);
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

/** What was chosen over a group's rows that can come; the row count for a group of answered rows alone (the header carries their spread) or of locked rows. */
function groupCount(items: readonly SelectItem[], ticks: ReadonlySet<string>, choices: ReadonlyMap<string, string>): string {
  const free = items.filter(unlocked);
  if (!free.some(i => i.choices === undefined)) return String(items.length);
  return fmtCount(free.filter(i => chosen(i, ticks, choices)).length, free.length);
}

/** Cuts a label to width from the middle, keeping its tail: the part of a path that differs. */
function middle(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  const head = Math.floor((width - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (width - 1 - head))}`;
}

function commonPrefix(texts: readonly string[]): number {
  const first = texts[0] ?? "";
  let n = 0;
  while (n < first.length && texts.every(t => t[n] === first[n])) n += 1;
  return n;
}

/** Every label cut to its width, no two alike: labels that would read the same once cut show the part where they first differ instead. */
export function cutDistinct(labels: readonly string[], widthOf: (i: number) => number): string[] {
  const out = labels.map((l, i) => middle(l, widthOf(i)));
  for (let round = 0; round < 8; round += 1) {
    const groups = new Map<string, number[]>();
    out.forEach((t, i) => {
      if (t !== labels[i]) groups.set(t, [...(groups.get(t) ?? []), i]);
    });
    let changed = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const at = commonPrefix(group.map(i => labels[i]!));
      for (const i of group) {
        const w = widthOf(i);
        const l = labels[i]!;
        const start = Math.min(at, Math.max(0, l.length - (w - 1)));
        const next = `…${l.slice(start, start + w - 1)}`;
        if (next !== out[i]) {
          out[i] = next;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return out;
}

/** How the choice rows answered, the answers with none left out: "6 copy, 2 sign in"; with chosenOnly the last choice, the one that brings nothing, is left out too. */
export function spreadOf(items: readonly SelectItem[], choices: ReadonlyMap<string, string>, chosenOnly = false): string {
  const first = items.find(i => i.choices !== undefined)?.choices ?? [];
  return (chosenOnly ? first.slice(0, -1) : first)
    .map(c => ({ n: items.filter(i => choices.get(i.id) === c.value).length, label: c.label }))
    .filter(p => p.n > 0)
    .map(p => `${p.n} ${p.label}`)
    .join(", ");
}

class RungPrompt extends Prompt<Set<string>> {
  cursor = 0;
  back = false;
  readonly folded: Set<string>;
  readonly choices = new Map<string, string>();
  private lastQuery = "";

  constructor(private readonly o: RungSelectOptions) {
    super({ render: () => this.frame(), ...(o.input ? { input: o.input } : {}), ...(o.output ? { output: o.output } : {}) }, true);
    this.folded = new Set(o.folded ?? []);
    const ticks = new Set([...o.initial].filter(id => o.items.some(i => i.id === id)));
    for (const i of o.items) {
      if (i.lock === "on") ticks.add(i.id);
      if (i.lock === "off") ticks.delete(i.id);
      if (i.choices !== undefined) {
        const first = i.choices[0]?.value;
        // Without a saved answer, or with one this row never offered, it starts on its last choice, the one that brings nothing.
        const saved = o.initialChoices?.get(i.id);
        const chosen = i.choices.some(c => c.value === saved) ? saved : i.choices.at(-1)?.value;
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
      ...items.map(i => this.second(i, width).length),
      ...[...new Set(items.map(i => i.group))].map(g => (g === undefined ? 0 : this.groupSecond(g, items.filter(i => i.group === g)).length)),
    );
    const room = width - EDGE - 2 - GUTTER.length - second;
    return { label: Math.max(8, Math.min(Math.max(...labels), room, LABEL_CAP)), second };
  }

  /** A group header's second column: what was chosen over its rows, then the screen's own cell for the group. */
  private groupSecond(group: string, items: readonly SelectItem[]): string {
    const count = groupCount(items, this.ticks(), this.choices);
    const hint = this.o.groupHint?.(group, items);
    return hint === undefined || hint === "" ? count : `${count}${GUTTER}${hint}`;
  }

  /** The indent of an item's row: grouped rows and bullets sit two columns in. */
  private static indent(i: SelectItem): number {
    return i.group !== undefined || i.lock === "on" ? 2 : 0;
  }

  /** Every item's label cut to the label column, no two alike. */
  private cuts(cols: { label: number }): Map<SelectItem, string> {
    const items = this.o.items;
    const cut = cutDistinct(items.map(i => i.label), i => cols.label - RungPrompt.indent(items[i]!));
    return new Map(items.map((i, k) => [i, cut[k]!]));
  }

  private hint(i: SelectItem, width: number): string | undefined {
    return i.hintFor?.(width) ?? i.hint;
  }

  /** Choice rows on a screen whose rows carry hints: the answer becomes a column after the hint. */
  private get mixed(): boolean {
    return this.o.items.some(i => i.choices !== undefined) && this.o.items.some(i => i.hint !== undefined || i.hintFor !== undefined);
  }

  private get answerWidth(): number {
    return Math.max(0, ...this.o.items.flatMap(i => (i.choices ?? []).map(c => c.label.length)));
  }

  /** The second column of an item row: its answer, its lock, or its hint; on a mixed screen the hint and then the answer. */
  private second(i: SelectItem, width: number): string {
    const answer = i.choices?.find(c => c.value === this.choices.get(i.id))?.label;
    const hint = this.hint(i, width);
    const both = this.mixed && hint !== undefined;
    if (answer !== undefined && !both) return answer;
    if (i.lock === "off") return "stays here";
    if (!both) return hint ?? "";
    return `${hint}${GUTTER}${(answer ?? "").padEnd(this.answerWidth)}`;
  }

  private line(glyph: string, label: string, second: string, indent: number, cols: { label: number; second: number }, current: boolean, heading: boolean): string {
    const field = ellipsize(label, cols.label - indent).padEnd(cols.label - indent);
    const text = heading ? styleText("bold", field) : current ? field : dim(field);
    return `${current ? styleText("cyan", "❯") : " "} ${" ".repeat(indent)}${glyph} ${text}${second !== "" ? `${GUTTER}${dim(second.padStart(cols.second))}` : ""}`.trimEnd();
  }

  private row(entry: Entry, current: boolean, cols: { label: number; second: number }, width: number, cuts: Map<SelectItem, string>): string {
    const ticks = this.ticks();
    const box = (on: boolean): string => (on ? styleText("cyan", "●") : dim("○"));
    const label = (i: SelectItem): string => cuts.get(i) ?? i.label;
    switch (entry.type) {
      case "all": {
        // The box says what space does next (the rows it flips are all on); the count runs over every row that can come.
        const flips = this.o.items.filter(byAll);
        const free = this.o.items.filter(unlocked);
        return this.line(box(flips.length > 0 && flips.every(i => ticks.has(i.id))), "all", fmtCount(free.filter(i => chosen(i, ticks, this.choices)).length, free.length), 0, cols, current, false);
      }
      case "locked":
        return this.line(dim("▾"), this.o.title, LOCKED_WORD, 0, cols, false, false);
      case "bullet":
        return this.line(dim("•"), label(entry.item), entry.item.hint ?? "", 2, cols, false, false);
      case "more":
        return `      ${dim(`…and ${entry.count} more`)}`;
      case "group":
        return this.line(entry.folded ? "▸" : "▾", entry.group, this.groupSecond(entry.group, entry.items), 0, cols, current, true);
      case "item": {
        const i = entry.item;
        return this.line(box(i.follows !== undefined ? i.follows(ticks) : ticks.has(i.id)), label(i), this.second(i, width), RungPrompt.indent(i), cols, current, false);
      }
      default: {
        const _exhaustive: never = entry;
        return _exhaustive;
      }
    }
  }

  private detail(at: Entry | undefined): string[] {
    const rows = this.o.detailLines ?? DETAIL_LINES;
    const lines =
      at === undefined
        ? []
        : at.type === "all"
          ? [this.o.items.some(i => i.own === true || i.choices !== undefined) ? "every plain row; rows with their own tick or answer stay as they are" : "every row on this screen that can be ticked"]
          : at.type === "group"
            ? [`${at.items.length} in ${at.group}`, "space ticks or clears the group"]
            : at.type === "item"
              ? at.item.detail
              : [];
    return Array.from({ length: rows }, (_, i) => lines[i] ?? "");
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
    const spread = withChoices.length > 0 && !this.mixed;
    const answer = spread ? spreadOf(withChoices, this.choices) : this.selected(width - EDGE);
    const counter = `${GUTTER}${dim(this.o.counter)}`;

    if (this.state === "submit" || (this.state === "cancel" && this.back)) {
      return `${styleText("green", S_STEP_SUBMIT)}  ${this.o.title}${counter}\n${dim(S_BAR)}  ${dim(this.back ? "back" : answer)}`;
    }
    if (this.state === "cancel") {
      return `${styleText("red", S_STEP_CANCEL)}  ${this.o.title}${counter}\n${dim(S_BAR)}  ${dim("cancelled")}`;
    }

    const entries = this.entries();
    this.cursor = settle(entries, this.cursor);
    const at = entries[this.cursor];
    const detail = this.detail(at);
    const footer = this.o.footer?.(this.ticks()) ?? [];
    const intro = (this.o.intro ?? []).flatMap(line => wrap(line, width - EDGE));
    // One row is left for the terminal's cursor line; a list that does not fit gives two more rows to the arrows.
    const room = rowsOf(this.o.output) - 1 - FIXED_LINES - intro.length - detail.length - footer.length;
    const { start, end } = viewport(entries.length, this.cursor, entries.length <= room ? entries.length : room - 2);
    const cols = this.columns(width);
    const cuts = this.cuts(cols);
    const bar = dim(S_BAR_FOCUS);

    const lines: string[] = [];
    lines.push(`${styleText("cyan", S_STEP_ACTIVE)}  ${styleText("cyan", this.o.title)}${counter}${spread ? `${GUTTER}${dim(answer)}` : ""}`);
    for (const line of intro) lines.push(`${bar}  ${dim(line)}`);
    lines.push(`${bar}  ${dim("search")}  ${this.userInput}${styleText("inverse", " ")}`);
    if (this.o.items.length === 0) lines.push(`${bar}  ${dim("nothing found")}`);
    else if (entries.length === 0) lines.push(`${bar}  ${dim("no match")}`);
    if (start > 0) lines.push(`${bar}  ${dim(`↑ ${start} more`)}`);
    for (let i = start; i < end; i++) lines.push(`${bar} ${this.row(entries[i]!, i === this.cursor, cols, width, cuts)}`);
    if (end < entries.length) lines.push(`${bar}  ${dim(`↓ ${entries.length - end} more`)}`);
    lines.push(bar);
    for (const d of detail) lines.push(`${bar}  ${dim(ellipsize(d, width - EDGE))}`.trimEnd());
    // The line names the ticked rows; where it would say none on a screen of answered rows it counts what was chosen instead,
    // as the header does, since a sign-in is chosen though nothing is ticked.
    const named = this.selected(width - EDGE - SELECTED.length);
    const picked = named !== "none" || !spread ? named : spreadOf(withChoices, this.choices, true) || "none";
    lines.push(`${bar}  ${dim(`${SELECTED}${picked}`)}`);
    for (const f of footer) lines.push(`${bar}  ${dim(ellipsize(f, width - EDGE))}`.trimEnd());
    const keys: HelpKey[] = this.mixed
      ? [{ key: "space", does: "tick or change" }, KEY_FOLD, KEY_NEXT, KEY_BACK]
      : withChoices.length > 0
        ? [{ key: "space", does: "change" }, KEY_NEXT, KEY_BACK]
        : [{ key: "space", does: "tick" }, KEY_FOLD, KEY_NEXT, KEY_BACK];
    lines.push(`${dim(S_BAR_FOCUS_END)}  ${helpLine(keys, colourDepth(isTTY(this.o.output)))}`);
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
    emitKeypressEvents(input);
    const tty = input as Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
    if (tty.isTTY && tty.setRawMode) tty.setRawMode(true);
    const done = (value: string): void => {
      input.off("keypress", onKey);
      if (tty.isTTY && tty.setRawMode) tty.setRawMode(false);
      input.pause();
      resolve(value);
    };
    const onKey = (char: string | undefined, key: Key): void => {
      if (key.sequence === "\x03" || key.name === "escape") return done("cancel");
      const name = key.name ?? char;
      if (name !== undefined && accept.includes(name)) done(name);
    };
    input.on("keypress", onKey);
    input.resume();
  });
}
