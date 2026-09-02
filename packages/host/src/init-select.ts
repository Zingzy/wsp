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

export interface SelectItem {
  id: string;
  label: string;
  /** Short text after the label (a size, a default). */
  hint?: string;
  group?: string;
  /** Lines for the detail pane while this item is highlighted. */
  detail: string[];
  /** on: always ticked, cannot be unticked. off: never ticked, with the reason shown. */
  lock?: "on" | "off";
  lockReason?: string;
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
  input?: Readable;
  output?: Writable;
  maxVisible?: number;
}

export type RungSelectResult = { kind: "next"; ticks: Set<string> } | { kind: "back"; ticks: Set<string> } | { kind: "cancel" };

const DETAIL_LINES = 2;
const dim = (s: string): string => styleText("dim", s);

export function matches(item: SelectItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
}

export function buildEntries(items: readonly SelectItem[], query: string, folded: ReadonlySet<string>): Entry[] {
  const shown = items.filter(i => matches(i, query));
  const out: Entry[] = [];
  if (query.trim() === "" && shown.length > 0) out.push({ type: "all" });
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

const tickable = (i: SelectItem): boolean => i.lock === undefined;

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

class RungPrompt extends Prompt<Set<string>> {
  cursor = 0;
  back = false;
  readonly folded = new Set<string>();
  private lastQuery = "";

  constructor(private readonly o: RungSelectOptions) {
    super({ render: () => this.frame(), ...(o.input ? { input: o.input } : {}), ...(o.output ? { output: o.output } : {}) }, true);
    const ticks = new Set(o.initial);
    for (const i of o.items) {
      if (i.lock === "on") ticks.add(i.id);
      if (i.lock === "off") ticks.delete(i.id);
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
        if (at) toggleEntry(this.ticks(), at, this.o.items);
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

  private row(entry: Entry, current: boolean): string {
    const ticks = this.ticks();
    const mark = current ? "❯" : " ";
    const box = (on: boolean): string => (on ? S_CHECKBOX_SELECTED : S_CHECKBOX_INACTIVE);
    switch (entry.type) {
      case "all": {
        const free = this.o.items.filter(tickable);
        const on = free.filter(i => ticks.has(i.id)).length;
        return `${mark} ${box(free.length > 0 && on === free.length)} all  ${dim(fmtCount(on, free.length))}`;
      }
      case "group": {
        const free = entry.items.filter(tickable);
        const on = free.filter(i => ticks.has(i.id)).length;
        const fold = entry.folded ? "▸" : "▾";
        return `${mark} ${fold} ${styleText("bold", entry.group)}  ${dim(fmtCount(on, free.length))}`;
      }
      case "item": {
        const i = entry.item;
        const indent = i.group !== undefined ? "  " : "";
        if (i.lock === "on") return `${mark} ${indent}${dim(`${S_CHECKBOX_SELECTED} ${i.label}  always`)}`;
        if (i.lock === "off") return `${mark} ${indent}${dim(`${S_CHECKBOX_INACTIVE} ${i.label}  ${i.lockReason ?? "not brought"}`)}`;
        const label = current ? i.label : dim(i.label);
        const hint = i.hint !== undefined ? `  ${dim(i.hint)}` : "";
        return `${mark} ${indent}${box(ticks.has(i.id))} ${label}${hint}`;
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
          ? ["everything on this screen that can be ticked"]
          : at.type === "group"
            ? [`${at.items.length} in ${at.group}`, "space ticks or clears the whole group"]
            : at.item.detail;
    return Array.from({ length: DETAIL_LINES }, (_, i) => lines[i] ?? "");
  }

  private frame(): string {
    const title = `${styleText("bold", this.o.title)}  ${dim(this.o.counter)}`;
    const ticks = this.ticks();
    const free = this.o.items.filter(tickable);
    const on = free.filter(i => ticks.has(i.id)).length + this.o.items.filter(i => i.lock === "on").length;
    const of = free.length + this.o.items.filter(i => i.lock === "on").length;

    if (this.state === "submit" || (this.state === "cancel" && this.back)) {
      const picked = this.o.items.filter(i => ticks.has(i.id)).map(i => i.label);
      const line = this.back ? "back" : picked.length === 0 ? "nothing ticked" : `${fmtCount(on, of)}: ${picked.join(", ")}`;
      return `${styleText("green", S_STEP_SUBMIT)}  ${title}\n${dim(S_BAR)}  ${dim(line)}`;
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

    const lines: string[] = [];
    lines.push(`${styleText("cyan", S_STEP_ACTIVE)}  ${title}`);
    lines.push(`${dim(S_BAR)}  ${dim("search")}  ${this.userInput}${styleText("inverse", " ")}`);
    lines.push(dim(S_BAR));
    if (this.o.items.length === 0) lines.push(`${dim(S_BAR)}  ${dim("nothing found for this screen")}`);
    else if (entries.length === 0) lines.push(`${dim(S_BAR)}  ${dim("no match")}`);
    for (let i = start; i < end; i++) lines.push(`${dim(S_BAR)}  ${this.row(entries[i]!, i === this.cursor)}`);
    const above = start;
    const below = entries.length - end;
    if (above > 0 || below > 0) {
      const parts = [above > 0 ? `↑ ${above} more` : "", below > 0 ? `↓ ${below} more` : ""].filter(p => p !== "");
      lines.push(`${dim(S_BAR)}  ${dim(parts.join("  "))}`);
    }
    lines.push(dim(S_BAR));
    for (const d of this.detail(at)) lines.push(`${dim(S_BAR)}  ${dim(d)}`);
    lines.push(dim(S_BAR));
    lines.push(`${dim(S_BAR)}  ${dim(`${fmtCount(on, of)} ticked`)}`);
    lines.push(`${dim(S_BAR_END)}  ${dim("space tick   ← → fold   esc back   enter next")}`);
    return lines.join("\n");
  }
}

export async function rungSelect(o: RungSelectOptions): Promise<RungSelectResult> {
  const prompt = new RungPrompt(o);
  const result = await prompt.prompt();
  const ticks = prompt.value ?? new Set<string>();
  if (isCancel(result)) return prompt.back ? { kind: "back", ticks } : { kind: "cancel" };
  return { kind: "next", ticks };
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
