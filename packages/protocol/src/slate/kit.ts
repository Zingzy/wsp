// SPDX-License-Identifier: AGPL-3.0-only
// The pieces of kit wsp/2 (05-pieces), one self-contained entry each: props, items, events, its sketch line and its
// catalog text. The compiler, the validator, the sketch and the catalog read these and switch on no type name of
// their own, so adding a piece is one entry here and one view in the web app.
import { fmtBytes, fmtTokens } from "../format.js";
import { isSlateSecretHandle, type SlateEventName, type SlateJson, type SlatePropValue, type SlateRunRecord } from "./types.js";

export const SLATE_TONES = ["default", "muted", "good", "warning", "bad", "info", "accent"] as const;
const EMPHASIS = ["normal", "strong", "quiet"] as const;
const SIZE = ["small", "normal", "large"] as const;
const DENSITY = ["tight", "normal", "loose"] as const;
const VARIANT = ["default", "primary", "quiet", "danger"] as const;

/** A prop's type. text is a string or a number; path names a run or value as $name; an array is an enum. */
export type SlatePropType = "string" | "number" | "integer" | "boolean" | "text" | "list" | "any" | "id" | "path" | readonly string[];

export interface SlatePropSpec {
  type: SlatePropType;
  /** no: literal only. yes: a formula or a template. state: a bare $value, written back. item: read per row. */
  binds: "no" | "yes" | "state" | "item";
  required?: true;
  default?: SlateJson;
  min?: number;
  max?: number;
}

export interface SlateItemSpec {
  /** The list prop an item of this kind appends to. */
  prop: string;
  fields: Record<string, SlatePropSpec>;
  /** Read in the row scope of the piece's items: a column, a row action. */
  row?: true;
  events?: readonly SlateEventName[];
  min?: number;
  max?: number;
}

/** What a piece's sketch line reads its props through. */
export interface SlateSketchView {
  id: string;
  /** A prop as the person would see it now; undefined where its data has not arrived. */
  prop(name: string): SlateJson | undefined;
  /** The prop as the document holds it. */
  raw(name: string): SlatePropValue | undefined;
  bound(name: string): boolean;
  /** A record's fields resolved against one row. */
  row(spec: SlatePropValue, item: SlateJson, index: number): Record<string, SlateJson | undefined>;
  /** An expression read for truth in a row scope: a row action's when. */
  test(expr: string, item: SlateJson, index: number): boolean;
  /** An own path's live value: a run's record for output. */
  read(path: string): SlateJson | undefined;
  /** A check with no thread: bound props read as their formula in braces. */
  unbound: boolean;
}

export interface SlatePieceModule {
  type: string;
  level: "core" | "working" | "extended";
  purpose: string;
  holdsChildren: boolean;
  /** At most this many children, of these types. */
  childLimit?: { max: number; types: readonly string[] };
  /** The prop a text child fills. */
  textProp?: string;
  /** The text child is literal: no holes, braces are characters. */
  rawText?: true;
  /** Has items with a row scope. */
  repeating?: true;
  /** Its one child is drawn per row, in the row scope. */
  rowTemplate?: true;
  interactive?: true;
  /** The event a piece must handle (A602). */
  needsHandler?: SlateEventName;
  props: Record<string, SlatePropSpec>;
  items: Record<string, SlateItemSpec>;
  events: readonly SlateEventName[];
  sketch(view: SlateSketchView): string | string[];
  fallback: string;
  example: string;
}

const str = (more: Partial<SlatePropSpec> = {}): SlatePropSpec => ({ type: "string", binds: "yes", ...more });
const num = (more: Partial<SlatePropSpec> = {}): SlatePropSpec => ({ type: "number", binds: "yes", ...more });
const flag = (): SlatePropSpec => ({ type: "boolean", binds: "no" });
const enm = (values: readonly string[]): SlatePropSpec => ({ type: values, binds: "no" });
const tone = (values: readonly string[] = SLATE_TONES): SlatePropSpec => ({ type: values, binds: "yes" });
const req = { required: true as const };

/** A value as a sketch shows it: nothing for missing. */
const shown = (v: SlateJson | undefined): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
const isNum = (v: SlateJson | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const join2 = (...parts: string[]): string => parts.filter(p => p !== "").join("  ");
const asList = (v: SlatePropValue | undefined): SlatePropValue[] => (Array.isArray(v) ? v : []);
const rec = (v: SlateJson | undefined): Record<string, SlateJson> => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {});

function bar(value: SlateJson | undefined, max: SlateJson | undefined): string {
  if (!isNum(value)) return "[..........]";
  const share = isNum(max) && max > 0 ? value / max : value / 100;
  const cells = Math.max(0, Math.min(10, Math.round(share * 10)));
  return `[${"#".repeat(cells)}${".".repeat(10 - cells)}]`;
}

function figure(format: string, value: SlateJson | undefined, max: SlateJson | undefined): string {
  if (!isNum(value)) return shown(value);
  switch (format) {
    case "percent": return `${Math.round(isNum(max) && max > 0 ? (value / max) * 100 : value)}%`;
    case "fraction": return `${value}/${shown(max)}`;
    case "tokens": return fmtTokens(value);
    case "bytes": return fmtBytes(value);
    case "usd": return `$${value.toFixed(2)}`;
    case "integer": return String(Math.round(value));
    case "none": return "";
    default: return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
}

/** Rows of a repeating piece, cut to 8, with the rest counted. */
function rows(v: SlateSketchView, line: (item: SlateJson, index: number) => string, empty = "Nothing here"): string[] {
  const items = v.prop("items");
  if (v.unbound) return [`rows of ${shown(items)}`];
  if (!Array.isArray(items) || items.length === 0) return [shown(v.prop("empty")) || empty];
  const cut = Math.min(items.length, 8);
  return [...items.slice(0, cut).map((item, i) => line(item, i)), ...(items.length > cut ? [`and ${items.length - cut} more rows`] : [])];
}

function actions(v: SlateSketchView, item: SlateJson, index: number): string {
  return asList(v.raw("rowActions")).filter(a => {
    const when = rec(a as SlateJson).when;
    return typeof when !== "string" || v.test(when, item, index);
  }).map(a => ` [${shown(v.row(a, item, index).label)}]`).join("");
}

const rowActionItem: SlateItemSpec = { prop: "rowActions", row: true, events: ["press"], max: 3, fields: { label: { type: "string", binds: "item", required: true } } };

export const SLATE_PIECES: Readonly<Record<string, SlatePieceModule>> = {
  column: {
    type: "column", level: "core", purpose: "Stacks children top to bottom.", holdsChildren: true,
    props: { gap: enm(DENSITY), align: enm(["start", "center", "end", "stretch"]) }, items: {}, events: [],
    sketch: () => "", fallback: "children in order", example: `<column gap="tight"><text>One</text><text>Two</text></column>`,
  },
  row: {
    type: "row", level: "core", purpose: "Places children side by side.", holdsChildren: true,
    props: { gap: enm(DENSITY), align: enm(["start", "center", "end", "between"]), wrap: flag() }, items: {}, events: [],
    sketch: () => "", fallback: "as column", example: `<row align="between"><text>Left</text><text>Right</text></row>`,
  },
  section: {
    type: "section", level: "core", purpose: "A titled group, optionally collapsible.", holdsChildren: true,
    props: { title: str(req), note: str(), collapsible: flag(), open: { type: "boolean", binds: "state" } }, items: {}, events: ["change"],
    sketch: v => (v.prop("open") === false ? `${shown(v.prop("title"))} (collapsed)` : shown(v.prop("title"))),
    fallback: "children under a text with the title", example: `<section title="Files changed" collapsible><text>None yet</text></section>`,
  },
  tabs: {
    type: "tabs", level: "working", purpose: "One child at a time, picked by a segmented control.", holdsChildren: true,
    props: { selected: { type: "string", binds: "state" } },
    items: { tab: { prop: "tabs", min: 2, max: 6, fields: { title: str({ ...req, binds: "no" }), piece: { type: "id", binds: "no", required: true } } } },
    events: ["change"],
    sketch: v => {
      const tabs = asList(v.raw("tabs")).map(t => shown(rec(t as SlateJson).title));
      return `tabs: ${tabs.join(" | ")}${v.prop("selected") !== undefined ? ` (showing ${shown(v.prop("selected"))})` : ""}`;
    },
    fallback: "the first child", example: `<tabs><tab title="A" piece="a" /><tab title="B" piece="b" /><text id="a">One</text><text id="b">Two</text></tabs>`,
  },
  text: {
    type: "text", level: "core", purpose: "A line or a paragraph; a text child with {holes} fills a sentence.", holdsChildren: false, textProp: "value",
    props: { value: { type: "text", binds: "yes", required: true }, tone: tone(), emphasis: { type: EMPHASIS, binds: "yes" }, mono: flag(), size: enm(SIZE), lines: { type: "integer", binds: "no", min: 1, max: 20 }, placeholder: str({ binds: "no" }) },
    items: {}, events: [],
    sketch: v => { const s = shown(v.prop("value")); return s === "" ? shown(v.prop("placeholder")) : s; },
    fallback: "none needed", example: `<text tone="muted">{tokens(thread.context.free)} free</text>`,
  },
  markdown: {
    type: "markdown", level: "core", purpose: "Rich text, sanitised; images are not fetched.", holdsChildren: false, textProp: "value",
    props: { value: { type: "string", binds: "yes", required: true } }, items: {}, events: [],
    sketch: v => { const lines = shown(v.prop("value")).split("\n"); return lines.length > 1 ? `${lines[0]} (+${lines.length - 1} lines)` : lines[0]!; },
    fallback: "text", example: `<markdown>**Why.** The host keeps the last 5,000 events.</markdown>`,
  },
  code: {
    type: "code", level: "working", purpose: "A literal code block with a copy control.", holdsChildren: false, textProp: "value", rawText: true,
    props: { value: { type: "string", binds: "yes", required: true }, language: str({ binds: "no" }), wrap: flag() }, items: {}, events: [],
    sketch: v => { const lines = shown(v.prop("value")).split("\n"); return lines.length > 1 ? `${lines[0]} (+${lines.length - 1} lines${v.prop("language") ? `, ${shown(v.prop("language"))}` : ""})` : lines[0]!; },
    fallback: "text", example: `<code language="sh">pnpm test</code>`,
  },
  number: {
    type: "number", level: "core", purpose: "A figure with a label.", holdsChildren: false,
    props: { label: str(req), value: { type: "text", binds: "yes", required: true }, format: enm(["plain", "tokens", "bytes", "percent", "usd", "duration", "integer"]), unit: str({ binds: "no" }), tone: tone(), note: str(), size: enm(["normal", "large"]) },
    items: {}, events: [],
    sketch: v => {
      const value = v.prop("value");
      const fig = value === undefined || value === null ? "not read yet" : figure(String(v.prop("format") ?? "plain"), value, 100);
      return join2(shown(v.prop("label")), [fig, shown(v.prop("unit"))].filter(Boolean).join(" "), shown(v.prop("note")));
    },
    fallback: "text", example: `<number label="Spent" value={thread.cost.usd} format="usd" />`,
  },
  meter: {
    type: "meter", level: "core", purpose: "One value against a maximum.", holdsChildren: false,
    props: { label: str(req), value: num(req), max: num(), note: str(), tone: tone(["default", "good", "warning", "bad"]), format: enm(["percent", "value", "fraction", "tokens", "bytes", "none"]) },
    items: {}, events: [],
    sketch: v => {
      const value = v.prop("value");
      const max = v.prop("max") ?? 100;
      if (v.unbound) return join2(shown(v.prop("label")), `[${shown(value)} of ${shown(max)}]`, shown(v.prop("note")));
      if (!isNum(value)) return join2(shown(v.prop("label")), "[..........] not read yet");
      return join2(shown(v.prop("label")), `${bar(value, max)} ${figure(String(v.prop("format") ?? "percent"), value, max)}`.trimEnd(), shown(v.prop("note")));
    },
    fallback: "number", example: `<meter id="week" label="Weekly" value={usage.week.percent} note={\`resets \${until(usage.week.resetsAt)}\`} />`,
  },
  bars: {
    type: "bars", level: "working", purpose: "Rows of name, track and figure from a list.", holdsChildren: false, repeating: true,
    props: { label: str(req), items: { type: "list", binds: "yes", required: true }, key: { type: "any", binds: "item" }, name: { type: "string", binds: "item", required: true }, value: { type: "number", binds: "item", required: true }, tone: { type: SLATE_TONES, binds: "item" }, max: num(), format: enm(["percent", "value", "none"]) },
    items: {}, events: [],
    sketch: v => [shown(v.prop("label")), ...rows(v, (item, i) => { const r = v.row({ name: v.raw("name") ?? null, value: v.raw("value") ?? null }, item, i); return `  ${shown(r.name)}  ${bar(r.value ?? null, v.prop("max") ?? 100)} ${shown(r.value)}`; }).slice(0, 5)],
    fallback: "table", example: `<bars label="Busiest" items={processes.list | take(5)} name={item.name} value={item.cpu} />`,
  },
  chart: {
    type: "chart", level: "working", purpose: "Lines over time or a number axis.", holdsChildren: false,
    props: { label: str(req), x: enm(["time", "number"]), range: str({ binds: "no" }), min: num(), max: num(), unit: str({ binds: "no" }), height: enm(SIZE) },
    items: { series: { prop: "series", min: 1, max: 4, fields: { name: str({ ...req, binds: "no" }), points: { type: "list", binds: "yes", required: true }, tone: tone() } } },
    events: [],
    sketch: v => {
      const series = asList(v.raw("series"));
      const first = series[0] !== undefined ? v.row(series[0], null, 0) : {};
      const pts = Array.isArray(first.points) ? first.points.map(p => rec(p).y).filter(isNum) : [];
      return pts.length === 0 ? `${shown(v.prop("label"))}  no points yet` : `${shown(v.prop("label"))}  ${shown(first.name)} last ${pts.at(-1)}, min ${Math.min(...pts)}, max ${Math.max(...pts)} over ${pts.length} points`;
    },
    fallback: "text", example: `<chart label="CPU" x="time"><series name="cpu" points={machine.history.cpu} /></chart>`,
  },
  sparkline: {
    type: "sparkline", level: "working", purpose: "A small line beside text.", holdsChildren: false,
    props: { label: str(req), values: { type: "list", binds: "yes", required: true }, tone: tone() }, items: {}, events: [],
    sketch: v => { const vals = Array.isArray(v.prop("values")) ? (v.prop("values") as SlateJson[]).filter(isNum) : []; return vals.length === 0 ? `${shown(v.prop("label"))}  no points yet` : `${shown(v.prop("label"))}  last ${vals.at(-1)}, min ${Math.min(...vals)}, max ${Math.max(...vals)} over ${vals.length} points`; },
    fallback: "text", example: `<sparkline label="Load" values={pluck(machine.history.load1, 'y')} />`,
  },
  table: {
    type: "table", level: "core", purpose: "Rows with columns from a bound list: <col> per column, <action> per row button.", holdsChildren: false, repeating: true,
    props: { items: { type: "list", binds: "yes", required: true }, key: { type: "any", binds: "item" }, empty: str(), rows: { type: "integer", binds: "no", min: 1, max: 5000 } },
    items: {
      col: { prop: "columns", row: true, min: 1, max: 8, fields: { title: str({ ...req, binds: "no" }), value: { type: "text", binds: "item", required: true }, tone: { type: SLATE_TONES, binds: "item" }, emphasis: { type: EMPHASIS, binds: "item" }, mono: flag(), align: enm(["start", "end"]), width: enm(["fit", "fill"]) } },
      action: rowActionItem,
    },
    events: [],
    sketch: v => {
      const cols = asList(v.raw("columns"));
      const head = `| ${cols.map(c => shown(rec(c as SlateJson).title)).join(" | ")} |`;
      return [head, ...rows(v, (item, i) => `| ${cols.map(c => shown(v.row(c, item, i).value)).join(" | ")} |${actions(v, item, i)}`)];
    },
    fallback: "a list of text rows",
    example: `<table id="checks" items={pr.checks} key={item.name}><col title="Check" value={item.name} /><action label="Fix" when={item.state == 'fail'} onPress={send("Fix this check.", item.name)} /></table>`,
  },
  list: {
    type: "list", level: "working", purpose: "Its one child drawn per row of a bound list.", holdsChildren: true, repeating: true, rowTemplate: true, childLimit: { max: 1, types: [] },
    props: { items: { type: "list", binds: "yes", required: true }, key: { type: "any", binds: "item" }, empty: str(), gap: enm(DENSITY) },
    items: { action: rowActionItem }, events: [],
    sketch: v => rows(v, (item, i) => `- ${shown(item)}${actions(v, item, i)}`),
    fallback: "text rows", example: `<list items={thread.plan.steps}><text>{item.text}</text></list>`,
  },
  checklist: {
    type: "checklist", level: "core", purpose: "Rows with a tick; editable writes the tick back to the value.", holdsChildren: false, repeating: true,
    props: { items: { type: "list", binds: "yes", required: true }, key: { type: "any", binds: "item" }, title: { type: "string", binds: "item", required: true }, done: { type: "boolean", binds: "item", required: true }, state: { type: ["pending", "working", "done"], binds: "item" }, note: { type: "string", binds: "item" }, editable: flag(), empty: str() },
    items: {}, events: ["change"],
    sketch: v => rows(v, (item, i) => { const r = v.row({ title: v.raw("title") ?? null, done: v.raw("done") ?? null }, item, i); return `[${r.done === true ? "x" : " "}] ${shown(r.title)}`; }),
    fallback: "text rows", example: `<checklist items={$steps} title={item.title} done={item.done} editable />`,
  },
  facts: {
    type: "facts", level: "core", purpose: "Label and value pairs: <fact> per pair.", holdsChildren: false,
    props: { layout: enm(["line", "grid"]) },
    items: { fact: { prop: "facts", min: 1, max: 12, fields: { label: str({ ...req, binds: "no" }), value: { type: "text", binds: "yes", required: true }, tone: tone(), emphasis: { type: EMPHASIS, binds: "yes" }, mono: flag() } } },
    events: [],
    sketch: v => asList(v.raw("facts")).map((f, i) => v.row(f, null, i)).filter(f => f.value !== null && f.value !== undefined && f.value !== "").map(f => `${shown(f.label)}: ${shown(f.value)}`).join("  "),
    fallback: "text lines", example: `<facts><fact label="State" value={pr.word} /><fact label="Review" value={word(pr.review)} /></facts>`,
  },
  data: {
    type: "data", level: "working", purpose: "Any value drawn by its shape.", holdsChildren: false,
    props: { value: { type: "any", binds: "yes", required: true }, label: str(), rows: { type: "integer", binds: "no" } }, items: {}, events: [],
    sketch: v => join2(shown(v.prop("label")), shown(v.prop("value")).slice(0, 80)), fallback: "text", example: `<data label="Created" value={$created} />`,
  },
  status: {
    type: "status", level: "working", purpose: "The one status mark for a thread or a check state.", holdsChildren: false,
    props: { thread: str(), state: str(), label: str() }, items: {}, events: [],
    sketch: v => join2(shown(v.prop("label")), shown(v.prop("state"))), fallback: "text", example: `<status state={thread.status} />`,
  },
  diagram: {
    type: "diagram", level: "working", purpose: "A Mermaid diagram from a literal text child.", holdsChildren: false, textProp: "source", rawText: true,
    props: { label: str(req), source: { type: "string", binds: "yes", required: true } }, items: {}, events: [],
    sketch: v => `diagram: ${shown(v.prop("label"))}`, fallback: "code", example: `<diagram label="Flow">graph TD; a-->b</diagram>`,
  },
  image: {
    type: "image", level: "extended", purpose: "An image from a data: URI or a file in the thread's folder.", holdsChildren: false,
    props: { src: str(req), alt: str(req), fit: enm(["contain", "cover"]) }, items: {}, events: [],
    sketch: v => `image: ${shown(v.prop("alt"))}`, fallback: "the alt text", example: `<image src="docs/shot.png" alt="The panel" />`,
  },
  output: {
    type: "output", level: "core", purpose: "A run's output as it streams, with its state and a Cancel.", holdsChildren: false,
    props: { run: { type: "path", binds: "no", required: true }, label: str(), lines: { type: "integer", binds: "no", min: 3, max: 40 }, wrap: flag() },
    items: {}, events: [],
    sketch: v => {
      const name = shown(v.raw("run") as SlateJson);
      const r = rec(v.read(name)) as Partial<SlateRunRecord>;
      if (v.unbound || r.state === undefined || r.state === "idle") return `output ${name}: not run yet`;
      const lines = Array.isArray(r.lines) && r.lines.length > 0 ? r.lines : [r.out, r.err].filter((s): s is string => typeof s === "string" && s !== "").join("\n").split("\n").filter(l => l !== "");
      return [`output ${name}: ${r.state}, ${lines.length} line${lines.length === 1 ? "" : "s"}${r.why !== undefined ? ` (${r.why})` : ""}`, ...lines.slice(-3).map(l => `  ${l}`)];
    },
    fallback: "text with the run's state", example: `<output run={$tests} lines={12} />`,
  },
  button: {
    type: "button", level: "core", purpose: "An action the person presses. held is a sentence that disables it: bind it to a condition.", holdsChildren: false, interactive: true, textProp: "label", needsHandler: "press",
    props: { label: str(req), variant: enm(VARIANT), held: str(), note: str(), size: enm(["normal", "small"]) },
    items: {}, events: ["press"],
    sketch: v => { const held = shown(v.prop("held")); return `[ ${shown(v.prop("label"))} ]${held !== "" ? ` (held: ${held})` : ""}`; },
    fallback: "none needed", example: `<button label="Next" variant="primary" held={$ok ? null : 'Check the id first'} onPress={set($step, 2)} />`,
  },
  input: {
    type: "input", level: "core", purpose: "Text in, written to its $value as the person types; a secret's input is a password field.", holdsChildren: false, interactive: true,
    props: { label: str(req), value: { type: "text", binds: "state", required: true }, lines: { type: "integer", binds: "no", min: 1, max: 20 }, kind: enm(["text", "number", "password"]), placeholder: str(), held: str(), mono: flag(), submit: str({ binds: "no" }) },
    items: {}, events: ["change", "submit"],
    sketch: v => {
      const raw = v.prop("value");
      const label = shown(v.prop("label"));
      if (isSlateSecretHandle(raw)) return raw.set ? `${label}: ••••` : `${label}: (empty)`;
      const value = shown(raw);
      return value === "" ? `${label}: (empty${v.prop("placeholder") ? `, "${shown(v.prop("placeholder"))}"` : ""})` : `${label}: "${value.length > 60 ? `${value.slice(0, 59)}…` : value}"`;
    },
    fallback: "none needed", example: `<input label="Issue number" value={$id} mono />`,
  },
  select: {
    type: "select", level: "core", purpose: "One choice from options, written to its $value.", holdsChildren: false, interactive: true,
    props: { label: str(req), value: { type: "string", binds: "state", required: true }, options: { type: "list", binds: "yes" }, placeholder: str({ binds: "no" }), held: str() },
    items: { option: { prop: "options", fields: { value: str({ ...req, binds: "no" }), label: str({ binds: "no" }) } } },
    events: ["change"],
    sketch: v => {
      const opts = v.prop("options");
      const n = Array.isArray(opts) ? opts.length : 0;
      return `${shown(v.prop("label"))}: ${shown(v.prop("value")) || "(none)"} (of ${n})`;
    },
    fallback: "none needed", example: `<select label="Hide" value={$hide}><option value="Done" /><option value="Canceled" /></select>`,
  },
  toggle: {
    type: "toggle", level: "core", purpose: "An on/off switch written to its boolean $value.", holdsChildren: false, interactive: true,
    props: { label: str(req), value: { type: "boolean", binds: "state", required: true }, note: str(), held: str() },
    items: {}, events: ["change"],
    sketch: v => `${shown(v.prop("label"))}: ${v.prop("value") === true ? "on" : "off"}`,
    fallback: "none needed", example: `<toggle label="Show done" value={$showDone} />`,
  },
  link: {
    type: "link", level: "working", purpose: "A link that opens a URL or a file in the thread's folder.", holdsChildren: false, interactive: true, textProp: "label",
    props: { label: str(req), href: str(), path: str() }, items: {}, events: [],
    sketch: v => `${shown(v.prop("label"))} (${shown(v.prop("href") ?? v.prop("path"))})`, fallback: "text", example: `<link href={pr.url}>The pull request</link>`,
  },
  form: {
    type: "form", level: "working", purpose: "A form drawn from an MCP tool's schema; the result lands in into.", holdsChildren: false, interactive: true,
    props: { tool: str({ ...req, binds: "no" }), label: str(), into: { type: "path", binds: "no", required: true }, submit: str({ binds: "no" }), confirm: str({ binds: "no" }) },
    items: { field: { prop: "fields", fields: { name: str({ ...req, binds: "no" }), label: str({ binds: "no" }), hidden: flag(), value: { type: "any", binds: "yes" } } } },
    events: ["submit"],
    sketch: v => `form ${shown(v.prop("tool"))}: ${asList(v.raw("fields")).map((f, i) => { const r = v.row(f, null, i); return `${shown(r.name)}=${shown(r.value)}`; }).join(", ")} [ ${shown(v.prop("submit")) || "Submit"} ]`,
    fallback: "text", example: `<form tool="linear.create_issue" into={$created} submit="Create"><field name="title" label="What needs doing" /></form>`,
  },
  empty: {
    type: "empty", level: "core", purpose: "An empty state, with at most one button under it.", holdsChildren: true, childLimit: { max: 1, types: ["button"] }, textProp: "body",
    props: { title: str(req), body: str() }, items: {}, events: [],
    sketch: v => [shown(v.prop("title")), shown(v.prop("body"))].filter(Boolean).join(". ").replace(/\.\./g, "."),
    fallback: "text", example: `<empty when={pr.number == null} title="No pull request yet">This branch has none.</empty>`,
  },
  terminal: {
    type: "terminal", level: "extended", purpose: "A live terminal with a command typed and not run.", holdsChildren: false,
    props: { label: str(req), command: str(), cwd: str({ binds: "no" }), height: enm(["small", "normal", "tall"]) }, items: {}, events: [],
    sketch: v => `terminal: ${shown(v.prop("command"))}`, fallback: "code", example: `<terminal label="Tests" command="pnpm test" />`,
  },
  diff: {
    type: "diff", level: "extended", purpose: "The thread's changes as a diff.", holdsChildren: false,
    props: { label: str(req), from: str(), to: str(), paths: { type: "list", binds: "yes" } }, items: {}, events: [],
    sketch: v => `diff: ${shown(v.prop("label"))}`, fallback: "text", example: `<diff label="Changes" />`,
  },
  file: {
    type: "file", level: "extended", purpose: "A file in the thread's folder.", holdsChildren: false,
    props: { path: str(req), lines: str({ binds: "no" }), language: str({ binds: "no" }) }, items: {}, events: [],
    sketch: v => `file: ${shown(v.prop("path"))}`, fallback: "link", example: `<file path="README.md" />`,
  },
  tree: {
    type: "tree", level: "extended", purpose: "The thread's tree.", holdsChildren: false,
    props: { root: str() }, items: {}, events: [],
    sketch: () => "tree", fallback: "text", example: `<tree />`,
  },
  "mcp-app": {
    type: "mcp-app", level: "extended", purpose: "An MCP server's own view in a sandboxed frame.", holdsChildren: false,
    props: { label: str(req), server: str({ ...req, binds: "no" }), resource: str({ ...req, binds: "no" }), tool: str({ binds: "no" }), args: { type: "any", binds: "yes" }, height: enm(["small", "normal", "tall"]) },
    items: {}, events: [],
    sketch: v => `mcp app: ${shown(v.prop("label"))} (${shown(v.prop("server"))}, ${shown(v.prop("resource"))})`, fallback: "text", example: `<mcp-app label="Board" server="linear" resource="ui://board" />`,
  },
};

/** Item kinds by tag, wherever they may sit. */
export const SLATE_ITEM_KINDS = ["col", "action", "fact", "option", "tab", "series", "field"] as const;

/** Style props a slate can never set, each with the meaning prop to use instead (05, "What the agent can never set"). */
export const SLATE_RESERVED_PROPS: Readonly<Record<string, string>> = {
  color: "tone", colour: "tone", background: "tone", fill: "tone", ink: "tone",
  font: "emphasis, size or mono", fontSize: "size", fontWeight: "emphasis", bold: "emphasis=\"strong\"", italic: "emphasis",
  padding: "gap", margin: "gap", spacing: "gap", border: "nothing; wsp draws edges", radius: "nothing; wsp draws edges", shadow: "nothing; wsp draws edges", outline: "nothing; wsp draws edges",
  width: "nothing; the panel decides", height: "nothing; the panel decides", style: "nothing", className: "nothing", class: "nothing", css: "nothing", html: "nothing",
  icon: "nothing in schema 2", glyph: "nothing in schema 2", emoji: "nothing in schema 2", animation: "nothing", transition: "nothing", pulse: "nothing", blink: "nothing",
};
