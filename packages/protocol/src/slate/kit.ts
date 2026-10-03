// SPDX-License-Identifier: AGPL-3.0-only
// The wsp/1 kit as this build carries it: the twelve core pieces, the core sources and the six core actions. Each
// entry is one self-contained record (props, flags, items, events, sketch line, catalog text); the compiler, the
// validator, the sketch and the catalog read these and switch on no type name of their own.
import { CHECK_STATE_WORDS } from "../pull-request.js";
import { fmtBytes, fmtTokens } from "../format.js";
import { LIMIT_KINDS } from "../usage.js";
import type { SlateEventName, SlateJson, SlatePropValue } from "./types.js";

// ---- pieces ----

export const SLATE_TONES = ["default", "muted", "good", "warning", "bad", "info", "accent"] as const;
const EMPHASIS = ["normal", "strong", "quiet"] as const;
const SIZE = ["small", "normal", "large"] as const;
const DENSITY = ["tight", "normal", "loose"] as const;

/** A prop's literal type. text is a string or a number; expr is a key expression read per row; an array is an enum. */
export type SlatePropType = "string" | "number" | "integer" | "boolean" | "text" | "list" | "expr" | "id" | "any" | readonly string[];

export interface SlatePropSpec {
  type: SlatePropType;
  required?: true;
  default?: SlateJson;
  /** no: literal only. yes: a binding or format string. state: a binding to a bare state path, written back. item:
   * read in the row scope of the piece's own items. */
  binds: "no" | "yes" | "state" | "item";
  /** For integer: the bounds; for list: the length bounds. */
  min?: number;
  max?: number;
  note?: string;
}

export interface SlateItemSpec {
  /** The list prop an item line of this kind appends to. */
  prop: string;
  fields: Record<string, SlatePropSpec>;
  /** Whether an @event line under the item goes to the item's own on (a row action). */
  events?: readonly SlateEventName[];
  /** Whether the item takes a when expression, read in row scope. */
  when?: true;
}

/** What a piece's sketch line reads its props through. */
export interface SlateSketchView {
  id: string;
  /** A prop's value as the person would see it now; undefined where its data has not arrived. */
  prop(name: string): SlateJson | undefined;
  /** Whether the document binds the prop rather than giving a literal. */
  bound(name: string): boolean;
  /** The prop as the document holds it, bindings unresolved. */
  raw(name: string): SlatePropValue | undefined;
  /** A record's fields resolved in a row scope: a column against one item. */
  row(spec: SlatePropValue, item: SlateJson, index: number): Record<string, SlateJson | undefined>;
  /** An expression read for truth in a row scope: a row action's when. */
  test(expr: string, item: SlateJson, index: number): boolean;
  /** In a check with no thread, a bound value's text: its expression in braces. */
  unbound: boolean;
}

export interface SlatePieceModule {
  type: string;
  level: "core";
  purpose: string;
  holdsChildren: boolean;
  /** At most this many children, of these types. */
  childLimit?: { max: number; types: readonly string[] };
  props: Record<string, SlatePropSpec>;
  items: Record<string, SlateItemSpec>;
  blockProp?: string;
  events: readonly SlateEventName[];
  /** An interactive piece; a missing label on it is T307. */
  interactive?: true;
  /** One line of text, or lines for a piece that draws rows; children are the sketch's to place. */
  sketch(view: SlateSketchView): string | string[];
  fallback: string;
  example: string;
}

const tone = (values: readonly string[] = SLATE_TONES): SlatePropSpec => ({ type: values, default: "default", binds: "yes" });
const str = (more: Partial<SlatePropSpec> = {}): SlatePropSpec => ({ type: "string", binds: "yes", ...more });
const flag = (dflt = false): SlatePropSpec => ({ type: "boolean", default: dflt, binds: "no" });

/** A value as a sketch shows it: nothing for missing, the braces form in a check. */
const shown = (v: SlateJson | undefined): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));
const isNum = (v: SlateJson | undefined): v is number => typeof v === "number" && Number.isFinite(v);

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

const join2 = (...parts: string[]): string => parts.filter(p => p !== "").join("  ");

export const SLATE_PIECES: Readonly<Record<string, SlatePieceModule>> = {
  column: {
    type: "column", level: "core", purpose: "Stacks children top to bottom.", holdsChildren: true,
    props: { gap: { type: DENSITY, default: "normal", binds: "no" }, align: { type: ["start", "center", "end", "stretch"], default: "stretch", binds: "no" } },
    items: {}, events: [], sketch: () => "", fallback: "children drawn in order",
    example: "limits: column tight\n  week: meter label=\"Weekly\" value={usage.week.percent}",
  },
  row: {
    type: "row", level: "core", purpose: "Places children side by side.", holdsChildren: true,
    props: { gap: { type: DENSITY, default: "normal", binds: "no" }, align: { type: ["start", "center", "end", "between"], default: "start", binds: "no" }, wrap: flag(true) },
    items: {}, events: [], sketch: () => "", fallback: "as column",
    example: "head: row between\n  branch: text value={git.branch} mono\n  ahead: text value=`${git.ahead} ahead` muted",
  },
  section: {
    type: "section", level: "core", purpose: "A titled group, optionally collapsible.", holdsChildren: true,
    props: { title: str({ required: true }), note: str(), collapsible: flag(), open: { type: "boolean", default: true, binds: "yes" } },
    items: {}, events: ["change"],
    sketch: v => (v.prop("open") === false ? `${shown(v.prop("title"))} (collapsed)` : shown(v.prop("title"))),
    fallback: "children under a text with the title",
    example: "changes: section title=\"Files changed\" collapsible\n  files: table items={thread.changes.files} key={item.path}\n    - col title=\"File\" value={item.path} mono",
  },
  text: {
    type: "text", level: "core", purpose: "A line or a paragraph.", holdsChildren: false,
    props: {
      value: { type: "text", required: true, binds: "yes" }, tone: tone(), emphasis: { type: EMPHASIS, default: "normal", binds: "yes" },
      mono: flag(), size: { type: SIZE, default: "normal", binds: "no" }, lines: { type: "integer", min: 1, max: 20, binds: "no" }, placeholder: { type: "string", binds: "no" },
    },
    items: {}, events: [],
    sketch: v => { const s = shown(v.prop("value")); return s === "" ? shown(v.prop("placeholder")) : s; },
    fallback: "none needed",
    example: "free: text value=`${tokens(thread.context.free)} free` muted mono",
  },
  markdown: {
    type: "markdown", level: "core", purpose: "Rich text, sanitised; links and images are not fetched.", holdsChildren: false,
    props: { value: { type: "string", required: true, binds: "yes" } }, blockProp: "value",
    items: {}, events: [],
    sketch: v => { const lines = shown(v.prop("value")).split("\n"); return lines.length > 1 ? `${lines[0]} (+${lines.length - 1} lines)` : lines[0]!; },
    fallback: "text",
    example: "why: markdown\n  | **The ring.** The host keeps the last 5,000 events.",
  },
  number: {
    type: "number", level: "core", purpose: "A figure with a label.", holdsChildren: false,
    props: {
      label: str({ required: true }), value: { type: "text", required: true, binds: "yes" },
      format: { type: ["plain", "tokens", "bytes", "percent", "usd", "duration", "integer"], default: "plain", binds: "no" },
      unit: { type: "string", binds: "no" }, tone: tone(), note: str(), size: { type: ["normal", "large"], default: "normal", binds: "no" },
    },
    items: {}, events: [],
    sketch: v => join2(shown(v.prop("label")), [figure(String(v.prop("format") ?? "plain"), v.prop("value"), 100) || (v.prop("value") === undefined || v.prop("value") === null ? "not read yet" : ""), shown(v.prop("unit"))].filter(Boolean).join(" "), shown(v.prop("note"))),
    fallback: "text",
    example: "spent: number label=\"Spent this thread\" value={thread.cost.usd} usd",
  },
  meter: {
    type: "meter", level: "core", purpose: "One value against a maximum.", holdsChildren: false,
    props: {
      label: str({ required: true }), value: { type: "number", required: true, binds: "yes" }, max: { type: "number", default: 100, binds: "yes" },
      note: str(), tone: tone(["default", "good", "warning", "bad"]),
      format: { type: ["percent", "value", "fraction", "tokens", "bytes", "none"], default: "percent", binds: "no" },
    },
    items: {}, events: [],
    sketch: v => {
      const value = v.prop("value");
      const max = v.prop("max") ?? 100;
      if (v.unbound) return join2(shown(v.prop("label")), `[${shown(value)} of ${shown(max)}]`, shown(v.prop("note")));
      if (!isNum(value)) return join2(shown(v.prop("label")), "[..........] not read yet");
      return join2(shown(v.prop("label")), `${bar(value, max)} ${figure(String(v.prop("format") ?? "percent"), value, max)}`.trimEnd(), shown(v.prop("note")));
    },
    fallback: "number",
    example: "week: meter label=\"Weekly\" value={usage.week.percent} note=`resets ${until(usage.week.resetsAt)}`",
  },
  facts: {
    type: "facts", level: "core", purpose: "Label and value pairs.", holdsChildren: false,
    props: { facts: { type: "list", required: true, binds: "no", min: 1, max: 12 }, layout: { type: ["line", "grid"], default: "line", binds: "no" } },
    items: { fact: { prop: "facts", fields: { label: { type: "string", required: true, binds: "no" }, value: { type: "text", required: true, binds: "yes" }, tone: tone(), mono: flag() } } },
    events: [],
    sketch: v => {
      const raw = v.prop("facts");
      return Array.isArray(raw) ? raw.map(f => (f !== null && typeof f === "object" && !Array.isArray(f) ? f : {}))
        .filter(f => f.value !== null && f.value !== undefined && f.value !== "")
        .map(f => `${shown(f.label)}: ${shown(f.value)}`).join("  ") : "";
    },
    fallback: "text lines",
    example: "head: facts\n  - fact label=\"State\" value={pr.word}\n  - fact label=\"Review\" value={pr.review}",
  },
  table: {
    type: "table", level: "core", purpose: "Rows with columns, from a bound list; one template, any number of rows.", holdsChildren: false,
    props: {
      items: { type: "list", required: true, binds: "yes" }, key: { type: "expr", binds: "item" },
      columns: { type: "list", required: true, binds: "no", min: 1, max: 8 }, rowActions: { type: "list", binds: "no", min: 0, max: 3 },
      empty: str({ default: "Nothing here" }), rows: { type: "integer", min: 1, max: 5000, binds: "no" },
    },
    items: {
      col: { prop: "columns", fields: { title: { type: "string", required: true, binds: "no" }, value: { type: "text", required: true, binds: "item" }, tone: { ...tone(), binds: "item" }, mono: flag(), align: { type: ["start", "end"], default: "start", binds: "no" }, width: { type: ["fit", "fill"], binds: "no" } } },
      action: { prop: "rowActions", fields: { label: { type: "string", required: true, binds: "item" } }, events: ["press"], when: true },
    },
    events: [],
    sketch: v => {
      const cols = Array.isArray(v.raw("columns")) ? (v.raw("columns") as SlatePropValue[]) : [];
      const actions = Array.isArray(v.raw("rowActions")) ? (v.raw("rowActions") as SlatePropValue[]) : [];
      const head = `| ${cols.map(c => shown(v.row(c, null, 0).title)).join(" | ")} |`;
      const items = v.prop("items");
      if (v.unbound) return [head, `| rows of ${shown(items)} |`];
      if (!Array.isArray(items) || items.length === 0) return [head, shown(v.prop("empty")) || "Nothing here"];
      const shownRows = Math.min(items.length, 8, isNum(v.prop("rows")) ? (v.prop("rows") as number) : 8);
      return [head, ...items.slice(0, shownRows).map((item, index) => {
        const cells = cols.map(c => shown(v.row(c, item, index).value));
        const acts = actions.filter(a => {
          const when = typeof a === "object" && a !== null && !Array.isArray(a) ? (a as Record<string, SlatePropValue>).when : undefined;
          return typeof when !== "string" || v.test(when, item, index);
        }).map(a => ` [${shown(v.row(a, item, index).label)}]`).join("");
        return `| ${cells.join(" | ")} |${acts}`;
      }), ...(items.length > shownRows ? [`and ${items.length - shownRows} more rows`] : [])];
    },
    fallback: "a list of text rows",
    example: "checks: table items={pr.checks} key={item.name} empty=\"No checks yet\"\n  - col title=\"Check\" value={item.name}\n  - col title=\"State\" value={item.state}",
  },
  button: {
    type: "button", level: "core", purpose: "An action the person presses.", holdsChildren: false, interactive: true,
    props: { label: str({ required: true }), variant: { type: ["default", "primary", "quiet", "danger"], default: "default", binds: "no" }, held: str(), note: str(), size: { type: ["normal", "small"], default: "normal", binds: "no" } },
    items: {}, events: ["press"],
    sketch: v => { const held = shown(v.prop("held")); return `[ ${shown(v.prop("label"))} ]${held !== "" ? ` (held: ${held})` : ""}`; },
    fallback: "none needed",
    example: "next: button label=\"Go on\" primary\n  @press send text=\"Go on to the next step.\"",
  },
  input: {
    type: "input", level: "core", purpose: "Text in, one line or many, written to state as the person types.", holdsChildren: false, interactive: true,
    props: {
      label: str({ required: true }), value: { type: "text", required: true, binds: "state" }, lines: { type: "integer", min: 1, max: 20, default: 1, binds: "no" },
      kind: { type: ["text", "number"], default: "text", binds: "no" }, placeholder: str(), held: str(), mono: flag(), submit: { type: "string", binds: "no" },
    },
    items: {}, events: ["change", "submit"],
    sketch: v => {
      const value = shown(v.prop("value"));
      return value === "" ? `${shown(v.prop("label"))}: (empty${v.prop("placeholder") ? `, "${shown(v.prop("placeholder"))}"` : ""})` : `${shown(v.prop("label"))}: "${value.length > 60 ? `${value.slice(0, 59)}…` : value}"`;
    },
    fallback: "none needed",
    example: "note: input label=\"Note for the agent\" value={state.note} lines=3\n  @submit send text=\"A note from the slate.\" with=[state.note]",
  },
  empty: {
    type: "empty", level: "core", purpose: "An empty state, with at most one button under it.", holdsChildren: true, childLimit: { max: 1, types: ["button"] },
    props: { title: str({ required: true }), body: str() },
    items: {}, events: [],
    sketch: v => [shown(v.prop("title")), shown(v.prop("body"))].filter(Boolean).join(". ").replace(/\.\./g, "."),
    fallback: "text",
    example: "none: empty title=\"No pull request yet\" when={pr.number == null}",
  },
};

/** The words a piece type takes bare: each enum value and boolean prop name, with the prop it sets. A word two props
 * share, or default and normal, is refused bare. Built once from the props, never written by hand. */
export function slateFlags(props: Record<string, SlatePropSpec>): Map<string, { prop: string; value: SlateJson } | "ambiguous"> {
  const out = new Map<string, { prop: string; value: SlateJson } | "ambiguous">();
  const put = (word: string, prop: string, value: SlateJson): void => {
    out.set(word, out.has(word) ? "ambiguous" : { prop, value });
  };
  for (const [prop, spec] of Object.entries(props)) {
    if (Array.isArray(spec.type)) for (const word of spec.type as readonly string[]) put(word, prop, word);
    if (spec.type === "boolean") { put(prop, prop, true); put(`no-${prop}`, prop, false); }
  }
  for (const word of ["default", "normal"]) if (out.has(word)) out.set(word, "ambiguous");
  return out;
}

// ---- sources ----

/** A declared path's shape: a scalar, an enum, a list of a shape, or a record of fields. */
export type SlateShape =
  | "number" | "string" | "boolean" | "time" | "any"
  | { enum: readonly string[]; nullable?: true }
  | { list: SlateShape }
  | { fields: Record<string, SlateShape> };

export interface SlateSourceModule {
  name: string;
  level: "core";
  purpose: string;
  update: "push" | "subscription" | "poll" | "tick";
  cost: string;
  scope: string;
  shape: { fields: Record<string, SlateShape> };
  /** Notes per path for the catalog, where the path needs one: which agents report it, when it is null. */
  notes?: Record<string, string>;
  example: string;
}

const rec = (fields: Record<string, SlateShape>): { fields: Record<string, SlateShape> } => ({ fields });
const list = (of: SlateShape): SlateShape => ({ list: of });
const oneOf = (values: readonly string[]): SlateShape => ({ enum: values });

export const SLATE_SOURCES: Readonly<Record<string, SlateSourceModule>> = {
  thread: {
    name: "thread", level: "core", purpose: "This thread: its status, its last turn, its context, cost, tokens, changes and plan.",
    update: "push", cost: "none beyond what the app already holds", scope: "the slate's own thread",
    shape: rec({
      id: "string", title: "string", agent: "string", model: "string", effort: "string",
      status: oneOf(["starting", "working", "needs-you", "failed", "done", "resting"]),
      access: "string", computer: "string", project: "string", folder: "string", turns: "number",
      lastTurn: rec({ status: "string", durationMs: "number", waitedMs: "number", startedAt: "time", endedAt: "time", model: "string" }),
      cost: rec({ usd: "number" }),
      tokens: rec({ input: "number", output: "number", cached: "number", cacheWrite: "number", reasoning: "number" }),
      context: rec({ used: "number", window: "number", free: "number", percent: "number" }),
      changes: rec({ files: list(rec({ path: "string", kind: "string", additions: "number", deletions: "number" })), from: "string", to: "string", moved: list("string"), shared: "boolean" }),
      plan: rec({ steps: list(rec({ text: "string", state: oneOf(["pending", "working", "done"]) })), text: "string" }),
      waitingOn: "string",
      subagents: list(rec({ id: "string", title: "string", state: "string", startedAt: "time", endedAt: "time" })),
    }),
    notes: { "thread.context": "the latest turn that reports it; null on an agent that does not", "thread.status": "the status mark's own kinds" },
    example: "thread.context.used / thread.context.window",
  },
  usage: {
    name: "usage", level: "core", purpose: "The plan windows of the account this thread runs on, as its agent last reported them.",
    update: "push", cost: "one event per turn end", scope: "the account the thread runs on",
    shape: rec({
      account: rec({ key: "string", label: "string", agent: "string", plan: "string", address: "string", computers: list("string") }),
      windows: list(rec({ kind: oneOf(LIMIT_KINDS), usedPercent: "number", resetsAt: "time" })),
      session: rec({ percent: "number", resetsAt: "time" }),
      week: rec({ percent: "number", resetsAt: "time" }),
      status: oneOf(["ok", "warning", "reached"]),
      note: "string",
      burn: rec({ tokensPerMinute: "number", threads: "number" }),
      credits: rec({ count: "number", nextExpiresAt: "time" }),
      readAt: "time",
    }),
    notes: { "usage.session": "the five hour window; none on a keyed sign-in, where usage.note says why", "usage.note": "why there are no windows, else null" },
    example: "pct(usage.week.percent)",
  },
  cost: {
    name: "cost", level: "core", purpose: "What this thread's workspace costs to run: the rate now and what it has run up.",
    update: "push", cost: "none beyond what the app already holds", scope: "the thread's workspace",
    shape: rec({ rateUsdPerHour: "number", accruedUsd: "number" }),
    notes: { "cost.rateUsdPerHour": "0 on this Mac" },
    example: "usd(cost.accruedUsd)",
  },
  time: {
    name: "time", level: "core", purpose: "The clock, so a countdown or an age moves on its own.",
    update: "tick", cost: "one re-evaluation a tick", scope: "none",
    shape: rec({ now: "number", today: "string", zone: "string" }),
    notes: { "time.now": "ms epoch; ticks each second while a visible piece reads it" },
    example: "until(usage.week.resetsAt)",
  },
  git: {
    name: "git", level: "core", purpose: "The thread's checkout: branch, head, counts against upstream.",
    update: "push", cost: "none for the checkout fields", scope: "the thread's folder",
    shape: rec({
      branch: "string", head: "string", ahead: "number", behind: "number", changed: "number", stashes: "number",
      editsUnread: "boolean", countsUnknown: "boolean", readAt: "time",
    }),
    notes: { "git.branch": "null on a folder that is not a checkout" },
    example: "git.branch",
  },
  pr: {
    name: "pr", level: "core", purpose: "The pull request of the thread's branch and its checks.",
    update: "push", cost: "one gh read per interval; every 30 s while a bound check is pending", scope: "the thread's folder",
    shape: rec({
      number: "number", url: "string", state: oneOf(["open", "merged", "closed"]), draft: "boolean", base: "string", branch: "string",
      headOid: "string", headSubject: "string",
      mergeable: oneOf(["mergeable", "conflicting", "unknown"]),
      review: oneOf(["none", "approved", "changes_asked", "required"]),
      checks: list(rec({
        name: "string", workflow: "string", state: oneOf(Object.keys(CHECK_STATE_WORDS)), link: "string", description: "string",
        startedAt: "time", completedAt: "time",
      })),
      additions: "number", deletions: "number", changedFiles: "number", commits: "number", behindBase: "number",
      author: "string", readAt: "time", word: "string", unread: "string",
    }),
    notes: { "pr.number": "null while the branch has no pull request", "pr.headSubject": "the head commit's subject; there is no pr.title", "pr.word": "the one word every tile says" },
    example: "pr.checks",
  },
};

/** Every declared full path of a source, with its shape, lists marked "[]". */
export function slateSourcePaths(source: SlateSourceModule): Map<string, SlateShape> {
  const out = new Map<string, SlateShape>();
  const visit = (prefix: string, shape: SlateShape): void => {
    out.set(prefix, shape);
    if (typeof shape === "object" && "fields" in shape) for (const [k, v] of Object.entries(shape.fields)) visit(`${prefix}.${k}`, v);
    if (typeof shape === "object" && "list" in shape) visit(`${prefix}[]`, shape.list);
  };
  for (const [k, v] of Object.entries(source.shape.fields)) visit(`${source.name}.${k}`, v);
  return out;
}

/** A shape as one short phrase, for the catalog and the checker's messages. */
export function slateShapeText(shape: SlateShape): string {
  if (typeof shape === "string") return shape;
  if ("enum" in shape) return shape.enum.join("|");
  if ("list" in shape) return `list of ${slateShapeText(shape.list)}`;
  return `{ ${Object.keys(shape.fields).join(", ")} }`;
}

// ---- actions ----

export interface SlateActionModule {
  kind: string;
  level: "core";
  purpose: string;
  args: Record<string, SlatePropSpec & { path?: "state" | "any" }>;
  consent: string;
  refusal: string;
  /** What reaches the agent. */
  reaches: string;
  example: string;
}

const textArg: SlatePropSpec = { type: "string", required: true, binds: "no" };
const withArg: SlatePropSpec & { path: "any" } = { type: "list", binds: "no", path: "any" };

export const SLATE_ACTIONS: Readonly<Record<string, SlateActionModule>> = {
  set: {
    kind: "set", level: "core", purpose: "Writes a state path; nothing reaches the agent.",
    args: { path: { type: "string", required: true, binds: "no", path: "state" }, value: { type: "any", required: true, binds: "yes" } },
    consent: "none", refusal: "set writes state paths only. Name a path under state.", reaches: "nothing",
    example: "@press set path=state.view value=\"files\"",
  },
  toggle: {
    kind: "toggle", level: "core", purpose: "Flips a boolean state path; nothing reaches the agent.",
    args: { path: { type: "string", required: true, binds: "no", path: "state" } },
    consent: "none", refusal: "toggle flips state paths only. Name a path under state.", reaches: "nothing",
    example: "@press toggle path=state.showAll",
  },
  send: {
    kind: "send", level: "core", purpose: "Sends the text to the thread: starts a turn, or joins a running one where the agent steers.",
    args: { text: textArg, with: withArg },
    consent: "the press", refusal: "The thread is gone. Open another thread.", reaches: "the text, a blank line, then slate: {...} with the with values",
    example: "@press send text=\"A check failed. Read its log and fix it.\" with=[item.name, item.link]",
  },
  steer: {
    kind: "steer", level: "core", purpose: "Sends into the running turn; with nothing running it goes as the next message.",
    args: { text: textArg, with: withArg },
    consent: "the press", refusal: "Nothing was running, so it was sent as the next message.", reaches: "as send",
    example: "@press steer text=\"Stop and look at the failing check first.\"",
  },
  queue: {
    kind: "queue", level: "core", purpose: "Sends after the current turn ends; starts a turn when none runs.",
    args: { text: textArg, with: withArg },
    consent: "the press", refusal: "The thread is gone. Open another thread.", reaches: "as send, once the turn ends",
    example: "@press queue text=\"When you are done, open the pull request.\"",
  },
  fill: {
    kind: "fill", level: "core", purpose: "Puts the text in the thread's composer without sending; with values follow as a quoted block.",
    args: { text: textArg, with: withArg },
    consent: "none", refusal: "Open the thread to fill its composer.", reaches: "nothing until the person sends",
    example: "@press fill text=\"About this check:\" with=[item.name]",
  },
};

/** The kinds of 09 that are typed but not in this build. */
export const SLATE_LATER_ACTIONS = ["command", "verb", "pane", "open", "copy", "thread", "terminal", "mcp"] as const;
/** The pieces of 04 that are typed but not in this build. */
export const SLATE_LATER_PIECES = ["tabs", "code", "bars", "chart", "sparkline", "list", "checklist", "data", "status", "diagram", "image", "select", "toggle", "link", "form", "terminal", "diff", "file", "tree", "mcp-app"] as const;

/** Style props a slate can never set, each with the meaning prop to use instead. */
export const SLATE_RESERVED_PROPS: Readonly<Record<string, string>> = {
  color: "tone", colour: "tone", background: "tone", fill: "tone", ink: "tone",
  font: "emphasis, size or mono", fontSize: "size", fontWeight: "emphasis", bold: "emphasis=strong", italic: "emphasis",
  padding: "gap as a word", margin: "gap as a word", spacing: "gap as a word",
  border: "nothing; wsp draws edges", radius: "nothing; wsp draws edges", shadow: "nothing; wsp draws edges", outline: "nothing; wsp draws edges",
  width: "nothing; the panel decides", height: "nothing; the panel decides",
  style: "nothing", className: "nothing", css: "nothing", html: "nothing",
  icon: "nothing in schema 1", glyph: "nothing in schema 1", emoji: "nothing in schema 1",
  animation: "nothing", transition: "nothing", pulse: "nothing", blink: "nothing",
};

/** Words that are scopes, never ids or names. */
export const SLATE_RESERVED_WORDS: ReadonlySet<string> = new Set(["item", "index", "state", "feed", "pipe", "drop", ...Object.keys(SLATE_SOURCES)]);
