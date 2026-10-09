// SPDX-License-Identifier: AGPL-3.0-only
// The pieces of kit wsp/2 (05-pieces), one self-contained entry each: props, items, events, its sketch line and its
// catalog text. The compiler, the validator, the sketch and the catalog read these and switch on no type name of
// their own, so adding a piece is one entry here and one view in the web app.
import { fmtBytes, fmtClock, fmtCost, fmtDuration, fmtElapsed, fmtInr, fmtTokens } from "../format.js";
import { slateAxisWord, slateChartAxis, slateShares, slateSpanState, slateTime, SLATE_SPAN_STATES } from "./chart.js";
import { slateResultShape, sketchSlateResult } from "./shape.js";
import { isSlateBinding, isSlateSecretHandle, type SlateEventName, type SlateJson, type SlatePropValue, type SlateRunDecl, type SlateRunRecord } from "./types.js";
import { slateDependencies } from "./expr.js";
import { slateOwnName, slateTable } from "./paths.js";
import type { SlateCode } from "./problems.js";
import { slateIsSeries } from "./sources.js";
import { SLATE_LIMITS } from "./limits.js";
import { slateImageSource, slateListTooLong, SLATE_IMAGE_LAYOUTS } from "./image.js";
import { IMAGE_MAX_WORDS, IMAGE_TYPE_WORDS } from "../attachments.js";

export const SLATE_TONES = ["default", "muted", "good", "warning", "bad", "info", "accent"] as const;
const EMPHASIS = ["normal", "strong", "quiet"] as const;
const SIZE = ["small", "normal", "large"] as const;
const DENSITY = ["tight", "normal", "loose"] as const;
const VARIANT = ["default", "primary", "quiet", "danger"] as const;
const PAD = ["none", "tight", "normal", "loose"] as const;
const SURFACE = ["plain", "inset"] as const;
const PLACE = ["start", "center", "end"] as const;
export const SLATE_FIGURES = ["plain", "tokens", "bytes", "percent", "usd", "inr", "duration", "integer"] as const;

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
  /** Why the person never sees this prop on the panel; a prop without it reaches the sketch. */
  unseen?: string;
  /** What the catalog's entry for the piece says beside the prop. */
  about?: string;
  /** A two-way prop that also takes a literal: the state it starts in, which the person then changes. */
  literal?: true;
  /** A list the piece plots, whose every entry is a number. */
  of?: "number";
  /** A list longer than count draws none of it, refused in the noun's words. */
  most?: { count: number; noun: string };
  /** A value the piece places on a clock, a time in ms or ISO. */
  time?: true;
  /** A path prop that names a run, never a value. */
  names?: "run";
  /** Free text, whose words may sit beside a mark such as a middle dot, as markdown's do. */
  marks?: true;
  /** A head, in sentence case, never Title Case. */
  head?: true;
}

/** What a piece's own check reads and says through: its props, the kind of a name the slate declares, and a problem. */
export interface SlatePieceCheck {
  props: Readonly<Record<string, SlatePropValue>>;
  kind(name: string): string | undefined;
  add(code: SlateCode, message: string, prop?: string, fix?: string): void;
}

export interface SlateItemSpec {
  /** The list prop an item of this kind appends to. */
  prop: string;
  fields: Record<string, SlatePropSpec>;
  /** Read in the row scope of the piece's items: a column, a row action. */
  row?: true;
  /** Its when reads the row, hiding the item on that row alone; every other item's when hides it whole. */
  rowWhen?: true;
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
  /** What a declared run calls: a command, a tool or a resource. */
  runKind(path: string): SlateRunDecl["kind"] | undefined;
  /** A check with no thread: bound props read as their formula in braces. */
  unbound: boolean;
  /** The clock the sketch reads time.now by. */
  now(): number;
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
  interactive?: true;
  /** The event a piece must handle (A602). */
  needsHandler?: SlateEventName;
  props: Record<string, SlatePropSpec>;
  items: Record<string, SlateItemSpec>;
  events: readonly SlateEventName[];
  sketch(view: SlateSketchView): string | string[];
  /** Whether the person sees its children now; a collapsed piece's children are not sketched. */
  collapsed?(view: SlateSketchView): boolean;
  /** The rules only this piece is held to, beyond its props' types. */
  check?(piece: SlatePieceCheck): void;
  fallback: string;
  example: string;
}

const str = (more: Partial<SlatePropSpec> = {}): SlatePropSpec => ({ type: "string", binds: "yes", ...more });
const num = (more: Partial<SlatePropSpec> = {}): SlatePropSpec => ({ type: "number", binds: "yes", ...more });
const flag = (): SlatePropSpec => ({ type: "boolean", binds: "no" });
const enm = (values: readonly string[], fallback?: string): SlatePropSpec => ({ type: values, binds: "no", ...(fallback !== undefined ? { default: fallback } : {}) });
const tone = (values: readonly string[] = SLATE_TONES): SlatePropSpec => ({ type: values, binds: "yes" });
const req = { required: true as const };
const rowKey = (): SlatePropSpec => ({ type: "any", binds: "item", unseen: "names a row so it keeps its place as rows move" });
/** How a group sits: inner space, the app's inset ground, and where its children line up across. */
const box = { pad: enm(PAD, "none"), surface: enm(SURFACE, "plain") };

/** Whether a row name reads a time, which makes the rows a series over time. */
function readsTime(expr: string): boolean {
  if (TIME_FNS.test(expr) || slateDependencies(expr).includes("time.now")) return true;
  const field = /\bitem\.([A-Za-z_]+)\b/.exec(expr)?.[1];
  return field !== undefined && TIME_FIELDS.has(field);
}

const TIME_FIELDS = new Set(["at", "time", "date", "ts", "timestamp", "when", "day", "hour", "minute"]);
const TIME_FNS = /\b(?:date|time|ago|weekday)\s*\(/;

/** A value as a sketch shows it: nothing for missing. */
const shown = (v: SlateJson | undefined): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
/** A held prop as the window reads it: a sentence holds the piece, and anything else (null, false, blank) holds nothing. */
export const slateHeldText = (v: SlateJson | undefined): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const isNum = (v: SlateJson | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const numbers = (v: SlateJson | undefined): number[] => (Array.isArray(v) ? v.filter(isNum) : []);
const trend = (label: string, vals: number[]): string => (vals.length === 0 ? `${label}  no points yet` : `${label}  last ${vals.at(-1)}, min ${Math.min(...vals)}, max ${Math.max(...vals)} over ${vals.length} points`.trimStart());
const join2 = (...parts: string[]): string => parts.filter(p => p !== "").join("  ");
const asList = (v: SlatePropValue | undefined): SlatePropValue[] => (Array.isArray(v) ? v : []);
const rec = (v: SlateJson | undefined): Record<string, SlateJson> => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {});

/** A row's or an item's look as a mark after it: [bad strong mono], nothing when it has none. */
function marks(r: Record<string, SlateJson | undefined>): string {
  const words = [
    typeof r.tone === "string" && r.tone !== "default" ? r.tone : "",
    typeof r.emphasis === "string" && r.emphasis !== "normal" ? r.emphasis : "",
    r.mono === true ? "mono" : "",
    typeof r.align === "string" && r.align !== "start" ? r.align : "",
    typeof r.width === "string" ? r.width : "",
  ].filter(Boolean);
  return words.length === 0 ? "" : ` [${words.join(" ")}]`;
}

function bar(value: SlateJson | undefined, max: SlateJson | undefined): string {
  if (!isNum(value)) return "[..........]";
  const share = isNum(max) && max > 0 ? value / max : value / 100;
  const cells = Math.max(0, Math.min(10, Math.round(share * 10)));
  return `[${"#".repeat(cells)}${".".repeat(10 - cells)}]`;
}

/** A number in the words a piece's format names, the one rule the panel and the sketch both draw it by: a percent of
 * max where there is one, a fraction over max (the number alone with none), a duration from milliseconds, an integer
 * with its thousands grouped, none as nothing, and any other format the number itself to two places. */
export function slateFigure(value: number, format: string, max?: number): string {
  const plain = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  switch (format) {
    case "percent": return `${Math.round(max !== undefined && max > 0 ? (value / max) * 100 : value)}%`;
    case "fraction": return max === undefined ? plain(value) : `${plain(value)}/${plain(max)}`;
    case "tokens": return fmtTokens(value);
    case "bytes": return fmtBytes(value);
    case "usd": return fmtCost(value);
    case "inr": return fmtInr(value);
    case "duration": return fmtDuration(value);
    case "integer": return Math.round(value).toLocaleString("en-US");
    case "none": return "";
    default: return plain(value);
  }
}

function figure(format: string, value: SlateJson | undefined, max: SlateJson | undefined): string {
  return isNum(value) && Number.isFinite(value) ? slateFigure(value, format, isNum(max) ? max : undefined) : shown(value);
}

/** The items of a list prop whose when holds; a check with no thread keeps them all. */
function present(v: SlateSketchView, list: SlatePropValue[]): SlatePropValue[] {
  return list.filter((x, i) => { const when = rec(x as SlateJson).when; return typeof when !== "string" || v.test(when, null, i); });
}

/** Rows of a repeating piece, cut to 8, with the rest counted. */
function rows(v: SlateSketchView, line: (item: SlateJson, index: number) => string, empty = "Nothing here"): string[] {
  const items = v.prop("items");
  if (v.unbound) return [`rows of ${shown(items)}`];
  if (!Array.isArray(items) || items.length === 0) return [shown(v.prop("empty")) || empty];
  const cut = Math.min(items.length, SLATE_LIMITS.sketchRows);
  return [...items.slice(0, cut).map((item, i) => line(item, i)), ...(items.length > cut ? [`and ${items.length - cut} more rows; slate_read values with the list's path reads them all`] : [])];
}

function actions(v: SlateSketchView, item: SlateJson, index: number): string {
  return asList(v.raw("rowActions")).filter(a => {
    const when = rec(a as SlateJson).when;
    return typeof when !== "string" || v.test(when, item, index);
  }).map(a => ` [${shown(v.row(a, item, index).label)}]`).join("");
}

const rowActionItem: SlateItemSpec = { prop: "rowActions", row: true, rowWhen: true, events: ["press"], max: SLATE_LIMITS.rowActions, fields: { label: { type: "string", binds: "item", required: true } } };

const PIECES: Record<string, SlatePieceModule> = {
  column: {
    type: "column", level: "core", purpose: "Stacks children top to bottom.", holdsChildren: true,
    props: { gap: enm(DENSITY, "normal"), align: enm(["start", "center", "end", "stretch"], "stretch"), ...box }, items: {}, events: [],
    sketch: () => "", fallback: "children in order", example: `<column gap="tight"><text>One</text><text>Two</text></column>`,
  },
  grid: {
    type: "grid", level: "core", purpose: "Children in 2 to 4 equal columns, one column under 360 px.", holdsChildren: true,
    props: { columns: { type: "integer", binds: "no", required: true, min: 2, max: 4 }, gap: enm(DENSITY, "normal"), align: enm(PLACE), ...box }, items: {}, events: [],
    sketch: v => `grid of ${shown(v.prop("columns"))}`, fallback: "column", example: `<grid columns={3}><number label="Open" value={3} /><number label="Done" value={9} /><number label="Failed" value={0} /></grid>`,
  },
  row: {
    type: "row", level: "core", purpose: "Places children side by side.", holdsChildren: true,
    props: { gap: enm(DENSITY, "normal"), align: enm(["start", "center", "end", "between"], "start"), wrap: flag() }, items: {}, events: [],
    sketch: () => "", fallback: "as column", example: `<row align="between"><text>Left</text><text>Right</text></row>`,
  },
  section: {
    type: "section", level: "core", purpose: "A titled group, optionally collapsible.", holdsChildren: true,
    props: { title: str(req), note: str(), collapsible: flag(), open: { type: "boolean", binds: "state", literal: true, about: "open={false} starts it shut; open={$open} also keeps it" }, align: enm(PLACE), ...box }, items: {}, events: ["change"],
    sketch: v => (v.prop("open") === false ? `${shown(v.prop("title"))} (collapsed)` : shown(v.prop("title"))),
    collapsed: v => v.prop("open") === false,
    fallback: "children under a text with the title", example: `<section title="Files changed" collapsible><text>None yet</text></section>`,
  },
  text: {
    type: "text", level: "core", purpose: "A line or a paragraph; a text child with {holes} fills a sentence.", holdsChildren: false, textProp: "value",
    props: { value: { type: "text", binds: "yes", required: true }, tone: tone(), emphasis: { type: EMPHASIS, binds: "yes" }, mono: flag(), size: enm(SIZE), lines: { type: "integer", binds: "no", min: 1, max: 20 }, placeholder: str() },
    items: {}, events: [],
    sketch: v => { const s = shown(v.prop("value")); return s === "" ? shown(v.prop("placeholder")) : s; },
    fallback: "none needed", example: `<text tone="muted">{tokens(thread.context.free)} free</text>`,
  },
  heading: {
    type: "heading", level: "core", purpose: "A heading on the app's type ladder: title, section, or label in small caps.", holdsChildren: false, textProp: "value",
    props: { value: { type: "text", binds: "yes", required: true, head: true }, level: enm(["title", "section", "label"]) }, items: {}, events: [],
    sketch: v => { const s = shown(v.prop("value")); return v.prop("level") === "title" ? `# ${s}` : v.prop("level") === "label" ? s.toUpperCase() : `## ${s}`; },
    fallback: "text", example: `<heading level="title">Gold price</heading>`,
  },
  markdown: {
    type: "markdown", level: "core", purpose: "Rich text, sanitised; images are not fetched.", holdsChildren: false, textProp: "value",
    props: { value: { type: "string", binds: "yes", required: true, marks: true } }, items: {}, events: [],
    sketch: v => { const lines = shown(v.prop("value")).split("\n"); return lines.length > 1 ? `${lines[0]} (+${lines.length - 1} lines)` : lines[0]!; },
    fallback: "text", example: `<markdown>**Why.** The host keeps the last 5,000 events.</markdown>`,
  },
  number: {
    type: "number", level: "core", purpose: "A figure with a label.", holdsChildren: false,
    props: { label: str(req), value: { type: "text", binds: "yes", required: true }, format: enm(SLATE_FIGURES, "plain"), unit: str(), tone: tone(), note: str(), size: enm(["normal", "large"]), trend: { type: "list", binds: "yes", of: "number", about: "read in the sketch alone; the panel's stat cell draws its figure alone, so a trend the person sees is a sparkline beside it" } },
    items: {}, events: [],
    sketch: v => {
      const value = v.prop("value");
      const fig = value === undefined || value === null ? "not read yet" : figure(String(v.prop("format") ?? "plain"), value, 100);
      const line = numbers(v.prop("trend"));
      return join2(shown(v.prop("label")), [fig, shown(v.prop("unit"))].filter(Boolean).join(" "), shown(v.prop("note")), line.length > 1 ? `trend ${line.at(0)} to ${line.at(-1)}` : "");
    },
    fallback: "text", example: `<number label="Spent" value={thread.cost.usd} format="usd" />`,
  },
  meter: {
    type: "meter", level: "core", purpose: "One value against a maximum.", holdsChildren: false,
    props: { label: str(req), value: num(req), max: num(), note: str(), tone: tone(["default", "good", "warning", "bad"]), format: enm(["percent", "value", "fraction", "tokens", "bytes", "none"], "percent") },
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
    type: "bars", level: "core", purpose: "Categories compared as rows of name, track and figure; never a series over time.", holdsChildren: false, repeating: true,
    props: { label: str(req), items: { type: "list", binds: "yes", required: true }, key: rowKey(), name: { type: "string", binds: "item", required: true }, value: { type: "number", binds: "item", required: true }, tone: { type: SLATE_TONES, binds: "item" }, max: num(), format: enm(["percent", "value", "none"], "value") },
    items: {}, events: [],
    sketch: v => {
      const items = v.prop("items");
      // As the panel draws it: with no max, the longest row fills its track.
      const values = Array.isArray(items) ? items.map((item, i) => v.row({ value: v.raw("value") ?? null }, item, i).value).filter(isNum) : [];
      const max = v.prop("max") ?? Math.max(0, ...values);
      return [shown(v.prop("label")), ...rows(v, (item, i) => { const r = v.row({ name: v.raw("name") ?? null, value: v.raw("value") ?? null }, item, i); const t = v.row({ tone: v.raw("tone") ?? null }, item, i); return `  ${shown(r.name)}  ${bar(r.value ?? null, max)} ${figure(String(v.prop("format") ?? "value"), r.value, max)}${marks(t)}`; })];
    },
    check: c => {
      const { items, name } = c.props;
      if (isSlateBinding(items) && slateIsSeries(items.bind.trim())) c.add("W003", `${items.bind} is a series over time; draw it as a line`, "items", "<chart>");
      else if (isSlateBinding(name) && readsTime(name.bind)) c.add("W003", `bars name each row by ${name.bind}, a time: a series over time is a line`, "name", "<chart>");
    },
    fallback: "table", example: `<bars label="Busiest" items={processes.list | take(5)} name={item.name} value={item.cpu} />`,
  },
  chart: {
    type: "chart", level: "core", purpose: "Lines over a list, oldest first; stack piles the <series>.", holdsChildren: false, repeating: true,
    props: { label: str(req), items: { type: "list", binds: "yes", required: true }, x: { type: "any", binds: "item", about: "a time on x (ISO or ms) labels the axis by clock, in this computer's time zone; a number by its value" }, value: { type: "number", binds: "item" }, format: enm(SLATE_FIGURES, "plain"), unit: str(), tone: tone(), height: enm(SIZE, "normal"), stack: flag() },
    items: { series: { prop: "series", row: true, max: 4, fields: { label: str({ ...req, binds: "no" }), value: { type: "number", binds: "item", required: true }, tone: { type: SLATE_TONES, binds: "no" } } } }, events: [],
    sketch: v => {
      const label = shown(v.prop("label"));
      const items = v.prop("items");
      const series = present(v, asList(v.raw("series")));
      // Read only with lines to pile, so a stack with none is tagged on the line rather than said to draw.
      const stack = series.length > 0 && v.prop("stack") === true;
      const lines = series.length === 0 ? "line" : `${series.length}${stack ? " stacked" : ""} lines`;
      if (v.unbound) return `${label}  ${lines} of ${shown(items)}, x ${v.raw("x") === undefined ? "{index}" : shown(v.prop("x"))}`;
      const x = v.raw("x");
      const list = Array.isArray(items) ? items : [];
      const format = String(v.prop("format") ?? "plain");
      const unit = shown(v.prop("unit"));
      const fig = (n: number): string => [figure(format, n, undefined), unit].filter(Boolean).join(" ");
      const xs = list.map((item, i) => (x === undefined ? i : v.row({ x }, item, i).x));
      const axisLine = (all: number[], at: number[]): string => {
        const axis = slateChartAxis(all.length === 1 ? [all[0]!, all[0]!] : all);
        return `  x ${slateAxisWord(xs[at[0]!])} to ${slateAxisWord(xs[at.at(-1)!])}, y ${fig(axis.from)} to ${fig(axis.to)}`;
      };
      if (series.length === 0) {
        if (v.raw("value") === undefined) return `${label}  nothing plotted from ${list.length} rows${list.length === 0 ? "" : `, x ${slateAxisWord(xs[0])} to ${slateAxisWord(xs.at(-1))}`}; give value or a <series> per line`.trimStart();
        const at = list.map((item, i) => (isNum(v.row({ value: v.raw("value") ?? null }, item, i).value) ? i : -1)).filter(i => i >= 0);
        if (at.length === 0) return `${label}  no points yet`;
        const vals = at.map(i => v.row({ value: v.raw("value") ?? null }, list[i]!, i).value as number);
        return [`${label}  last ${fig(vals.at(-1)!)}, min ${fig(Math.min(...vals))}, max ${fig(Math.max(...vals))} over ${vals.length} point${vals.length === 1 ? "" : "s"}`.trimStart(), axisLine(vals, at)];
      }
      const read = series.map(s => list.map((item, i) => v.row(s, item, i)));
      const own = read.map(rows => rows.map(r => (isNum(r.value) ? r.value : 0)));
      const at = list.map((_, i) => i).filter(i => read.some(rows => isNum(rows[i]!.value)));
      if (at.length === 0) return `${label}  ${lines}, no points yet`;
      const drawn = stack ? own.map((_, k) => own[0]!.map((__, i) => own.slice(0, k + 1).reduce((sum, line) => sum + line[i]!, 0))) : own;
      const all = at.flatMap(i => drawn.map(line => line[i]!));
      return [
        `${label}  ${lines} over ${at.length} point${at.length === 1 ? "" : "s"}`.trimStart(),
        ...read.map((rows, k) => {
          const vals = at.map(i => rows[i]!.value).filter(isNum);
          return `  ${shown(rows[0]?.label ?? rec(series[k] as SlateJson).label)}  ${vals.length === 0 ? "no points yet" : `last ${fig(vals.at(-1)!)}, min ${fig(Math.min(...vals))}, max ${fig(Math.max(...vals))}`}${marks({ tone: rec(series[k] as SlateJson).tone })}`;
        }),
        axisLine(stack ? [0, ...all] : all, at),
      ];
    },
    check: c => {
      const x = c.props.x;
      if (x === undefined || (isSlateBinding(x) && x.bind.trim() === "index")) c.add("W013", "the chart's x is each row's index, so its axis reads 0 to the count; give each row its time, for example x={item.at}", "x", "x={item.at}");
      if (c.props.value === undefined && asList(c.props.series).length === 0) c.add("T304", "a chart draws value={...} or a <series> per line, and it has neither", "value", "value={item.v}");
      else if (c.props.value !== undefined && asList(c.props.series).length > 0) c.add("W020", "the chart draws its <series> and leaves value out; drop value, or give it a <series> of its own", "value");
    },
    fallback: "text", example: `<chart label="Gold" items={$hist} x={item.at} value={item.v} />`,
  },
  diagram: {
    type: "diagram", level: "core", purpose: "A Mermaid diagram: a flow, a sequence or a state machine; value={`...${$step}`} shows the live step.", holdsChildren: false, textProp: "value", rawText: true,
    props: { value: { type: "string", binds: "yes", required: true, about: "Mermaid source; a text child is taken as written, braces and all. Labels a few words, decisions short questions; detail goes in a text beside it. Under about 15 nodes; past that, split it or summarize" }, label: str() }, items: {}, events: [],
    sketch: v => { const lines = shown(v.prop("value")).split("\n"); const label = shown(v.prop("label")); return `${label === "" ? "" : `${label}  `}${lines[0]}${lines.length > 1 ? ` (+${lines.length - 1} line${lines.length === 2 ? "" : "s"})` : ""}`; },
    fallback: "its source as code", example: "<diagram label=\"Deploy\" value={`flowchart LR\n  build --> test --> ship\n  classDef now stroke-width:3px\n  class ${$step} now`} />",
  },
  timeline: {
    type: "timeline", level: "core", purpose: "Spans on a clock, Gantt style, such as a run's steps or a deploy's phases.", holdsChildren: false, repeating: true,
    props: { label: str(req), items: { type: "list", binds: "yes", required: true }, name: { type: "string", binds: "item", required: true }, start: { type: "any", binds: "item", time: true, about: "a time, ISO or ms; none waits" }, end: { type: "any", binds: "item", time: true, about: "none while it runs" }, state: { type: SLATE_SPAN_STATES, binds: "item" }, group: { type: "string", binds: "item", about: "rows of one group sit under its name" }, now: { type: "any", binds: "yes", time: true, about: "where a running span ends; the clock if unset" } },
    items: {}, events: [],
    sketch: v => {
      const given = v.prop("now");
      const now = slateTime(given) ?? v.now();
      const notTime = (word: string, value: SlateJson | undefined): string => (value === undefined || value === null || slateTime(value) !== undefined ? "" : `${word} ${JSON.stringify(value)} is not a time`);
      if (v.unbound) return `${shown(v.prop("label"))}  spans of ${shown(v.prop("items"))}`;
      let group: string | undefined;
      return [join2(shown(v.prop("label")), notTime("now", given)), ...rows(v, (item, i) => {
        const r = v.row({ name: v.raw("name") ?? null, start: v.raw("start") ?? null, end: v.raw("end") ?? null, state: v.raw("state") ?? null, group: v.raw("group") ?? null }, item, i);
        const start = slateTime(r.start);
        const end = slateTime(r.end);
        const state = slateSpanState(r.state, start, end);
        const head = typeof r.group === "string" && r.group !== group ? `  ${(group = r.group)}\n` : "";
        const clock = start === undefined ? "" : `${fmtClock(start)} to ${state === "running" ? "now" : end === undefined ? "?" : fmtClock(end)}`;
        const said = state === "done" ? (start === undefined || end === undefined ? "done" : fmtElapsed(end - start)) : state === "running" && start !== undefined ? `running ${fmtElapsed(now - start)}` : state;
        return `${head}  ${shown(r.name)}  ${join2(clock, said, notTime("start", r.start), notTime("end", r.end))}`;
      }).flatMap(line => line.split("\n"))];
    },
    fallback: "table", example: `<timeline label="CI run" items={$steps} name={item.name} start={item.started} end={item.ended} group={item.job} />`,
  },
  treemap: {
    type: "treemap", level: "core", purpose: "Sizes of one whole's parts as nested boxes, such as a bundle by module within package.", holdsChildren: false, repeating: true,
    props: { label: str(req), items: { type: "list", binds: "yes", required: true }, name: { type: "string", binds: "item", required: true }, value: { type: "number", binds: "item", required: true }, group: { type: "string", binds: "item" }, format: enm(SLATE_FIGURES, "plain") },
    items: {}, events: [],
    sketch: v => {
      const items = v.prop("items");
      if (v.unbound) return `${shown(v.prop("label"))}  boxes of ${shown(items)}`;
      const format = String(v.prop("format") ?? "plain");
      const parts = (Array.isArray(items) ? items : []).map((item, i) => v.row({ name: v.raw("name") ?? null, value: v.raw("value") ?? null, group: v.raw("group") ?? null }, item, i));
      const whole = parts.reduce((sum, p) => sum + (isNum(p.value) ? Math.max(0, p.value) : 0), 0);
      const groups = new Set(parts.map(p => shown(p.group))).size;
      const head = join2(shown(v.prop("label")), parts.length === 0 ? "" : `${figure(format, whole, undefined)} in ${parts.length} parts${groups > 1 ? `, ${groups} groups` : ""}`);
      return [head, ...rows(v, (_, i) => { const p = parts[i]!; return `  ${join2(shown(p.group), shown(p.name))}  ${figure(format, p.value, undefined)}${isNum(p.value) && whole > 0 ? ` ${Math.round((Math.max(0, p.value) / whole) * 100)}%` : ""}`; })];
    },
    fallback: "bars", example: `<treemap label="Bundle" items={$stats.json.modules} name={item.name} value={item.bytes} group={item.package} format="bytes" />`,
  },
  donut: {
    type: "donut", level: "core", purpose: "Shares of one whole, five parts at most with the rest as Other; never a series over time.", holdsChildren: false, repeating: true,
    props: { label: str(req), items: { type: "list", binds: "yes", required: true }, name: { type: "string", binds: "item", required: true }, value: { type: "number", binds: "item", required: true }, format: enm(SLATE_FIGURES, "plain"), unit: str() },
    items: {}, events: [],
    sketch: v => {
      const items = v.prop("items");
      if (v.unbound) return `${shown(v.prop("label"))}  shares of ${shown(items)}`;
      const format = String(v.prop("format") ?? "plain");
      const unit = shown(v.prop("unit"));
      const parts = slateShares((Array.isArray(items) ? items : []).map((item, i) => { const r = v.row({ name: v.raw("name") ?? null, value: v.raw("value") ?? null }, item, i); return { name: shown(r.name), value: isNum(r.value) ? r.value : 0 }; }));
      const whole = parts.reduce((sum, p) => sum + p.value, 0);
      if (whole === 0) return `${shown(v.prop("label"))}  no shares yet`;
      return [join2(shown(v.prop("label")), [figure(format, whole, undefined), unit].filter(Boolean).join(" ")), ...parts.map(p => `  ${p.name}  ${figure(format, p.value, undefined)} ${Math.round((p.value / whole) * 100)}%`)];
    },
    fallback: "bars", example: `<donut label="By country" items={$countries} name={item.name} value={item.n} format="integer" />`,
  },
  image: {
    type: "image", level: "core", purpose: "A picture from a file on the thread's computer, such as a screenshot or a saved plot, or from an https address once the person allows its domain; opens large to zoom.", holdsChildren: false,
    props: { src: str({ ...req, about: `a path on the thread's computer, relative to its folder or whole, or an http(s) address; ${IMAGE_TYPE_WORDS} up to ${IMAGE_MAX_WORDS}` }), caption: str() }, items: {}, events: [],
    sketch: v => join2(`[image ${shown(v.prop("src"))}]`, shown(v.prop("caption"))),
    check: c => {
      const src = c.props.src;
      if (typeof src === "string") { const read = slateImageSource(src); if ("problem" in read) c.add(read.problem.code as SlateCode, read.problem.message, "src", 'src="/tmp/home.png"'); }
    },
    fallback: "its path as text", example: `<image src="/tmp/login-failed.png" caption="Login, after the redirect" />`,
  },
  images: {
    type: "images", level: "core", purpose: "Several pictures, as image takes them: a row that scrolls, a grid, or a before and after under a slider.", holdsChildren: false, repeating: true,
    props: { items: { type: "list", binds: "yes", required: true, most: { count: SLATE_LIMITS.imagesPerList, noun: "images" } }, src: { type: "string", binds: "item", required: true }, caption: { type: "string", binds: "item" }, layout: enm(SLATE_IMAGE_LAYOUTS, "gallery") },
    items: {}, events: [],
    sketch: v => {
      const layout = String(v.prop("layout") ?? "gallery");
      return [`${layout} of images`, ...rows(v, (item, i) => { const r = v.row({ src: v.raw("src") ?? null, caption: v.raw("caption") ?? null }, item, i); return `  ${join2(`[image ${shown(r.src)}]`, shown(r.caption))}`; }, "No images")];
    },
    check: c => {
      const items = c.props.items;
      if (c.props.layout === "compare" && Array.isArray(items) && items.length !== 2) c.add("T303", `a compare shows exactly two images, before and after, and this list has ${items.length}`, "items");
      if (Array.isArray(items) && items.length > SLATE_LIMITS.imagesPerList) c.add("R905", slateListTooLong(items.length, SLATE_LIMITS.imagesPerList, "images").message, "items");
    },
    fallback: "a list of paths", example: `<images layout="compare" items={[{ p: "shots/before.png", c: "Before" }, { p: "shots/after.png", c: "After" }]} src={item.p} caption={item.c} />`,
  },
  sparkline: {
    type: "sparkline", level: "core", purpose: "A small line beside text, the way to show a figure's trend.", holdsChildren: false,
    props: { label: str(req), values: { type: "list", binds: "yes", required: true, of: "number" }, tone: tone() }, items: {}, events: [],
    sketch: v => trend(shown(v.prop("label")), numbers(v.prop("values"))),
    fallback: "text", example: `<sparkline label="Load" values={pluck($hist, 'v')} />`,
  },
  table: {
    type: "table", level: "core", purpose: "Rows with columns from a bound list: <col> per column, <action> per row button.", holdsChildren: false, repeating: true,
    props: { items: { type: "list", binds: "yes", required: true }, key: rowKey(), empty: str(), rows: { type: "integer", binds: "no", min: 1, max: 5000 } },
    items: {
      col: { prop: "columns", row: true, min: 1, max: SLATE_LIMITS.columns, fields: { title: str({ ...req, binds: "no" }), value: { type: "text", binds: "item", required: true }, tone: { type: SLATE_TONES, binds: "item" }, emphasis: { type: EMPHASIS, binds: "item" }, mono: flag(), align: enm(["start", "end"], "start"), width: enm(["fit", "fill"]) } },
      action: rowActionItem,
    },
    events: [],
    sketch: v => {
      const cols = present(v, asList(v.raw("columns")));
      const head = `| ${cols.map(c => { const r = rec(c as SlateJson); return `${shown(r.title)}${marks({ mono: r.mono, align: r.align, width: r.width })}`; }).join(" | ")} |`;
      return [head, ...rows(v, (item, i) => `| ${cols.map(c => { const r = v.row(c, item, i); return `${shown(r.value)}${marks({ tone: r.tone, emphasis: r.emphasis })}`; }).join(" | ")} |${actions(v, item, i)}`)];
    },
    fallback: "a list of text rows",
    example: `<table id="checks" items={pr.checks} key={item.name}><col title="Check" value={item.name} /><action label="Fix" when={item.state == 'fail'} onPress={send("Fix this check.", item.name)} /></table>`,
  },
  checklist: {
    type: "checklist", level: "core", purpose: "Rows with a tick; editable writes the tick back to the value.", holdsChildren: false, repeating: true,
    props: { items: { type: "list", binds: "yes", required: true }, key: rowKey(), title: { type: "string", binds: "item", required: true }, done: { type: "boolean", binds: "item", required: true }, state: { type: ["pending", "working", "done"], binds: "item", unseen: "this build's checklist draws done alone" }, note: { type: "string", binds: "item" }, editable: flag(), empty: str() },
    items: {}, events: ["change"],
    sketch: v => rows(v, (item, i) => { const r = v.row({ title: v.raw("title") ?? null, done: v.raw("done") ?? null }, item, i); const note = shown(v.row({ note: v.raw("note") ?? null }, item, i).note); return `[${r.done === true ? "x" : " "}] ${shown(r.title)}${note === "" ? "" : `  ${note}`}`; }),
    check: c => {
      if (c.props.editable === true && !(isSlateBinding(c.props.items) && c.kind(slateOwnName(c.props.items.bind) ?? "") === "value")) c.add("S502", "an editable checklist writes its ticks back, so items binds a value: items={$steps}", "items");
    },
    fallback: "text rows", example: `<checklist items={$steps} title={item.title} done={item.done} editable />`,
  },
  facts: {
    type: "facts", level: "core", purpose: "Label and value pairs: <fact> per pair.", holdsChildren: false,
    props: { layout: enm(["line", "grid"], "line") },
    items: { fact: { prop: "facts", min: 1, max: SLATE_LIMITS.facts, fields: { label: str(req), value: { type: "text", binds: "yes", required: true }, tone: tone(), emphasis: { type: EMPHASIS, binds: "yes" }, mono: flag() } } },
    events: [],
    sketch: v => {
      const all = present(v, asList(v.raw("facts"))).map((f, i) => v.row(f, null, i));
      const empty = (f: Record<string, SlateJson | undefined>): boolean => f.value === null || f.value === undefined || f.value === "";
      // The panel leaves out a fact with no value; the sketch says which, so a missing line reads as empty, not lost.
      const left = all.filter(empty).map(f => shown(f.label));
      return [...all.filter(f => !empty(f)).map(f => `${shown(f.label)}: ${shown(f.value)}${marks(f)}`), ...(left.length > 0 && !v.unbound ? [`(no value yet, not shown: ${left.join(", ")})`] : [])].join("  ");
    },
    fallback: "text lines", example: `<facts><fact label="State" value={pr.word} /><fact label="Review" value={word(pr.review)} /></facts>`,
  },
  status: {
    type: "status", level: "core", purpose: "A dot in a tone with a word: Live, Down, Waiting.", holdsChildren: false, textProp: "value",
    props: { value: { type: "text", binds: "yes", required: true }, tone: tone(["default", "muted", "good", "warning", "bad", "info"]) }, items: {}, events: [],
    sketch: v => `(${shown(v.prop("tone")) || "default"}) ${shown(v.prop("value"))}`, fallback: "text", example: `<status tone={$up ? 'good' : 'bad'}>{$up ? 'Live' : 'Down'}</status>`,
  },
  chip: {
    type: "chip", level: "core", purpose: "A short fact in a small framed chip.", holdsChildren: false, textProp: "value",
    props: { value: { type: "text", binds: "yes", required: true } }, items: {}, events: [],
    sketch: v => `[${shown(v.prop("value"))}]`, fallback: "text", example: `<chip>{git.branch}</chip>`,
  },
  ring: {
    type: "ring", level: "core", purpose: "Progress as a ring with its figure inside.", holdsChildren: false,
    props: { label: str(req), value: num(req), max: num(), format: enm(["percent", "value", "fraction"], "percent"), tone: tone(["default", "good", "warning", "bad"]), note: str() }, items: {}, events: [],
    sketch: v => {
      const value = v.prop("value");
      const max = v.prop("max") ?? 100;
      if (v.unbound || !isNum(value)) return join2(shown(v.prop("label")), `(${v.unbound ? shown(value) : "not read yet"})`);
      return join2(shown(v.prop("label")), `(${figure(String(v.prop("format") ?? "percent"), value, max)}) ${bar(value, max)}`, shown(v.prop("note")));
    },
    fallback: "meter", example: `<ring label="Done" value={$done} max={len($steps)} format="fraction" />`,
  },
  output: {
    type: "output", level: "core", purpose: "A run's output as it streams, with its state and a Cancel.", holdsChildren: false,
    props: { run: { type: "path", binds: "no", required: true, names: "run" }, label: str(), lines: { type: "integer", binds: "no", min: 3, max: 40, about: "how many of the newest lines show, out then err, 8 by default" }, wrap: flag() },
    items: {}, events: [],
    sketch: v => {
      const name = shown(v.raw("run") as SlateJson);
      const r = rec(v.read(name)) as Partial<SlateRunRecord>;
      if (v.unbound || r.state === undefined || r.state === "idle") return `output ${name}: not run yet`;
      const lines = Array.isArray(r.lines) && r.lines.length > 0 ? r.lines : [r.out, r.err].filter((s): s is string => typeof s === "string" && s !== "").join("\n").split("\n").filter(l => l !== "");
      const kind = v.runKind(name);
      if (kind !== undefined && kind !== "cmd" && r.state !== "failed") {
        const shape = sketchSlateResult(slateResultShape(r.json ?? r.out));
        return shape.length === 0 ? `output ${name}: ${r.state}` : [`output ${name}: ${r.state}, ${shape[0]}`, ...shape.slice(1, 4).map(l => `  ${l}`)];
      }
      return [`output ${name}: ${r.state}, ${lines.length} line${lines.length === 1 ? "" : "s"}${r.why !== undefined ? ` (${r.why})` : ""}`, ...lines.slice(-3).map(l => `  ${l}`)];
    },
    fallback: "text with the run's state", example: `<output run={$tests} lines={12} />`,
  },
  button: {
    type: "button", level: "core", purpose: "An action the person presses. held is a sentence that disables it: bind it to a condition.", holdsChildren: false, interactive: true, textProp: "label", needsHandler: "press",
    props: { label: str(req), variant: enm(VARIANT), held: str(), note: str(), size: enm(["normal", "small"]) },
    items: {}, events: ["press"],
    sketch: v => { const held = slateHeldText(v.prop("held")); return `[ ${shown(v.prop("label"))} ]${held !== undefined ? ` (held: ${held})` : ""}`; },
    fallback: "none needed", example: `<button label="Next" variant="primary" held={$ok ? null : 'Check the id first'} onPress={set($step, 2)} />`,
  },
  input: {
    type: "input", level: "core", purpose: "Text in, written to its $value as the person types; a secret's input is a password field.", holdsChildren: false, interactive: true,
    props: { label: str(req), value: { type: "text", binds: "state", required: true }, lines: { type: "integer", binds: "no", min: 1, max: 20 }, kind: enm(["text", "number", "password"], "text"), placeholder: str(), held: str(), mono: flag(), submit: str() },
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
    props: { label: str(req), value: { type: "string", binds: "state", required: true }, options: { type: "list", binds: "yes" }, placeholder: str(), held: str() },
    items: { option: { prop: "options", fields: { value: str({ ...req, binds: "no" }), label: str({ binds: "no" }) } } },
    events: ["change"],
    sketch: v => {
      const opts = v.prop("options");
      const list = (Array.isArray(opts) ? present(v, opts) as SlateJson[] : []).map(o => { const r = rec(o); return shown(o !== null && typeof o === "object" ? (r.label ?? r.value) : o); });
      const empty = shown(v.prop("placeholder")) === "" ? "(none)" : `(none, "${shown(v.prop("placeholder"))}")`;
      return `${shown(v.prop("label"))}: ${shown(v.prop("value")) || empty} (of ${list.length <= 6 ? list.join(", ") || "0" : list.length})`;
    },
    fallback: "none needed", example: `<select label="Hide" value={$hide}><option value="Done" /><option value="Canceled" /></select>`,
  },
  choices: {
    type: "choices", level: "core", purpose: "Large options to pick one, written to its $value; answer marks the right one once picked.", holdsChildren: false, interactive: true,
    props: { label: str(req), value: { type: "any", binds: "state", required: true }, options: { type: "list", binds: "yes" }, answer: { type: "any", binds: "yes" }, held: str() },
    items: { option: { prop: "options", fields: { value: { type: "any", binds: "yes", required: true }, label: str(), note: str() } } },
    events: ["change"],
    sketch: v => {
      const picked = v.prop("value");
      const answer = v.prop("answer");
      const opts = v.prop("options");
      const list = (Array.isArray(opts) ? present(v, opts) as SlateJson[] : []).map(o => (o !== null && typeof o === "object" && !Array.isArray(o) ? o : { value: o }));
      const lines = list.map(o => {
        const chosen = picked !== null && picked !== undefined && JSON.stringify(o.value) === JSON.stringify(picked);
        const right = answer !== null && answer !== undefined && picked !== null && picked !== undefined && JSON.stringify(o.value) === JSON.stringify(answer);
        return `(${chosen ? "x" : " "}) ${shown(o.label ?? o.value)}${right ? " right" : chosen && answer !== null && answer !== undefined ? " wrong" : ""}${o.note !== undefined && o.note !== null ? `  ${shown(o.note)}` : ""}`;
      });
      const lost = picked !== null && picked !== undefined && !list.some(o => JSON.stringify(o.value) === JSON.stringify(picked));
      return [`${shown(v.prop("label"))}:${lost ? ` ${shown(picked)}` : ""}`, ...lines.map(m => `  ${m}`)];
    },
    fallback: "select", example: `<choices label="Which layer routes packets?" value={$pick} options={$q.options} answer={$q.answer} />`,
  },
  toggle: {
    type: "toggle", level: "core", purpose: "An on/off switch written to its boolean $value.", holdsChildren: false, interactive: true,
    props: { label: str(req), value: { type: "boolean", binds: "state", required: true }, note: str(), held: str() },
    items: {}, events: ["change"],
    sketch: v => `${shown(v.prop("label"))}: ${v.prop("value") === true ? "on" : "off"}`,
    fallback: "none needed", example: `<toggle label="Show done" value={$showDone} />`,
  },
  empty: {
    type: "empty", level: "core", purpose: "An empty state, with at most one button under it.", holdsChildren: true, childLimit: { max: 1, types: ["button"] }, textProp: "body",
    props: { title: str(req), body: str() }, items: {}, events: [],
    sketch: v => [shown(v.prop("title")), shown(v.prop("body"))].filter(Boolean).join(". ").replace(/\.\./g, "."),
    fallback: "text", example: `<empty when={pr.number == null} title="No pull request yet">This branch has none.</empty>`,
  },
};

export const SLATE_PIECES: Readonly<Record<string, SlatePieceModule>> = slateTable(Object.fromEntries(Object.entries(PIECES).map(([type, m]) => [type, {
  ...m,
  props: slateTable(m.props),
  items: slateTable(Object.fromEntries(Object.entries(m.items).map(([tag, item]) => [tag, { ...item, fields: slateTable(item.fields) }]))),
}])));

/** Item kinds by tag, wherever they may sit. */
export const SLATE_ITEM_KINDS = ["col", "action", "fact", "option", "series"] as const;

/** Style props a slate can never set, each with the meaning prop to use instead (05, "What the agent can never set"). */
export const SLATE_RESERVED_PROPS: Readonly<Record<string, string>> = slateTable<string>({
  color: "tone", colour: "tone", fill: "tone", ink: "tone",
  font: "emphasis, size or mono", fontSize: "size", fontWeight: "emphasis", bold: "emphasis=\"strong\"", italic: "emphasis",
  padding: "pad", margin: "gap or pad", spacing: "gap", background: "surface=\"inset\" on a section, column or grid", bg: "surface=\"inset\"", border: "nothing; wsp draws edges", radius: "nothing; wsp draws edges", shadow: "nothing; wsp draws edges", outline: "nothing; wsp draws edges",
  width: "nothing; the panel decides", height: "nothing; the panel decides", style: "nothing", className: "nothing", class: "nothing", css: "nothing", html: "nothing",
  glyph: "nothing; say it in words", emoji: "nothing; say it in words", animation: "nothing", transition: "nothing", pulse: "nothing", blink: "nothing",
});
