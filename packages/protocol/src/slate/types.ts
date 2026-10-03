// SPDX-License-Identifier: AGPL-3.0-only
// The slate document, its pieces, bindings, actions and patch ops as the host stores them and the renderer draws
// them, the Problem every error, warning and draw-time fault is reported in, and the message line a press sends.
import { z } from "zod";

export type SlateJson = null | boolean | number | string | SlateJson[] | { [key: string]: SlateJson };
export const SlateJson: z.ZodType<SlateJson> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(SlateJson), z.record(SlateJson)]),
);

/** A piece id: a lowercase letter, then lowercase letters, digits or "-", 1 to 48 characters. */
export type SlateId = string;
export const SLATE_ID = /^[a-z][a-z0-9-]{0,47}$/;
/** A feed or pipe name: read inside expressions, where "-" is subtraction, so it takes "_" instead. */
export type SlateName = string;
export const SLATE_NAME = /^[a-z][a-z0-9_]{0,47}$/;
/** A state key: a name an expression can read as state.<key>. */
export const SLATE_STATE_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** An expression in the slate's formula language, as source text. */
export type SlateExpression = string;
/** "state.<key>[.<key>|[index]]*", one form in bindings, actions, patches and the tools. */
export type SlateStatePath = string;
/** Any path an expression reads: a source path, a state path, or item.* inside a row scope. */
export type SlatePath = string;

export interface SlateBinding { bind: SlateExpression }
/** Text with ${expression} holes; "$${" is a literal "${". */
export interface SlateFormat { format: string }

/** A literal, a binding or a format string. A plain string is always literal. */
export type SlatePropValue =
  | null | boolean | number | string
  | SlateBinding
  | SlateFormat
  | SlatePropValue[]
  | { [key: string]: SlatePropValue };

export const SlateBinding = z.object({ bind: z.string().min(1) }).strict();
export const SlateFormat = z.object({ format: z.string() }).strict();
export const SlatePropValue: z.ZodType<SlatePropValue> = z.lazy(() =>
  z.union([
    z.null(), z.boolean(), z.number(), z.string(),
    SlateBinding, SlateFormat,
    z.array(SlatePropValue),
    z.record(SlatePropValue).refine(o => !("bind" in o) && !("format" in o), "an object with bind or format holds nothing else"),
  ]),
);

export const isSlateBinding = (v: unknown): v is SlateBinding =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as SlateBinding).bind === "string";
export const isSlateFormat = (v: unknown): v is SlateFormat =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as SlateFormat).format === "string";

export type SlateEventName = "press" | "submit" | "change";
export const SLATE_EVENTS = ["press", "submit", "change"] as const;
export const SlateEventName = z.enum(SLATE_EVENTS);

/** RightPanelKind plus "slate". */
export type SlatePaneKind = "preview" | "terminal" | "diff" | "pr" | "files" | "machine" | "processes" | "agents" | "slate";

export type SlateAction =
  | { do: "set"; path: SlateStatePath; value: SlatePropValue }
  | { do: "toggle"; path: SlateStatePath }
  | { do: "send"; text: string; with?: SlatePath[] }
  | { do: "steer"; text: string; with?: SlatePath[] }
  | { do: "queue"; text: string; with?: SlatePath[] }
  | { do: "fill"; text: string; with?: SlatePath[] }
  | { do: "command"; name: string; args?: string }
  | { do: "verb"; name: string; args?: Record<string, SlatePropValue> }
  | { do: "pane"; kind: SlatePaneKind; args?: Record<string, SlatePropValue> }
  | { do: "open"; href?: SlatePropValue; path?: SlatePropValue }
  | { do: "copy"; text: SlatePropValue }
  | { do: "thread"; op: "start" | "rewind"; text?: string; agent?: string; computer?: string; turn?: SlatePropValue }
  | { do: "terminal"; command: SlatePropValue; cwd?: string }
  | { do: "mcp"; server: string; tool: string; args?: Record<string, SlatePropValue>; into?: SlateStatePath; confirm?: string };

/** The kinds this build carries; the rest of 09's list is typed but refused by the validator until it lands. */
const sends = (kind: "send" | "steer" | "queue" | "fill") =>
  z.object({ do: z.literal(kind), text: z.string(), with: z.array(z.string()).optional() }).strict();
export const SlateActionSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("set"), path: z.string(), value: SlatePropValue }).strict(),
  z.object({ do: z.literal("toggle"), path: z.string() }).strict(),
  sends("send"), sends("steer"), sends("queue"), sends("fill"),
]) as unknown as z.ZodType<SlateAction>;

export type SlateFeed =
  | { kind: "mcp"; server: string; tool?: string; args?: Record<string, SlateJson>; resource?: string; every?: number }
  | { kind: "file"; path: string; every?: number }
  | { kind: "dir"; path: string; every?: number };
export const SlateFeed: z.ZodType<SlateFeed> = z.union([
  z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string().optional(), args: z.record(SlateJson).optional(), resource: z.string().optional(), every: z.number().int().optional() }).strict(),
  z.object({ kind: z.enum(["file", "dir"]), path: z.string(), every: z.number().int().optional() }).strict(),
]);

export interface SlatePiece {
  type: string;
  props?: Record<string, SlatePropValue>;
  children?: SlateId[];
  when?: SlateExpression;
  on?: Partial<Record<SlateEventName, SlateAction | SlateAction[]>>;
  fallback?: SlateId | "drop" | { text: string };
  announce?: boolean;
}
export const SlatePiece: z.ZodType<SlatePiece> = z.object({
  type: z.string(),
  props: z.record(SlatePropValue).optional(),
  children: z.array(z.string()).optional(),
  when: z.string().optional(),
  on: z.object({
    press: z.union([SlateActionSchema, z.array(SlateActionSchema)]).optional(),
    submit: z.union([SlateActionSchema, z.array(SlateActionSchema)]).optional(),
    change: z.union([SlateActionSchema, z.array(SlateActionSchema)]).optional(),
  }).strict().optional(),
  fallback: z.union([z.string(), z.object({ text: z.string() }).strict()]).optional(),
  announce: z.boolean().optional(),
}).strict();

export interface Slate {
  schema: 1;
  kit?: string;
  root: SlateId;
  title?: string;
  state?: Record<string, SlateJson>;
  feeds?: Record<SlateName, SlateFeed>;
  pipes?: Record<SlateName, string>;
  pieces: Record<SlateId, SlatePiece>;
}
/** The document's frame. The validator is the contract; this only says the shape is a slate at all. */
export const SlateSchema: z.ZodType<Slate> = z.object({
  schema: z.literal(1),
  kit: z.string().optional(),
  root: z.string(),
  title: z.string().optional(),
  state: z.record(SlateJson).optional(),
  feeds: z.record(SlateFeed).optional(),
  pipes: z.record(z.string()).optional(),
  pieces: z.record(SlatePiece),
}).strict();

export type SlatePatchOp =
  | { op: "add"; id: SlateId; piece: SlatePiece; under?: SlateId; at?: number; children?: Record<SlateId, SlatePiece> }
  | { op: "replace"; id: SlateId; piece: SlatePiece; children?: Record<SlateId, SlatePiece> }
  | { op: "props"; id: SlateId; props?: Record<string, SlatePropValue | null>; when?: SlateExpression | null; on?: SlatePiece["on"]; fallback?: SlatePiece["fallback"] | null }
  | { op: "move"; id: SlateId; under: SlateId; at?: number }
  | { op: "remove"; id: SlateId }
  | { op: "state"; path: SlateStatePath; value: SlateJson }
  | { op: "feed"; id: SlateId; feed: SlateFeed | null }
  | { op: "pipe"; id: SlateId; pipeline: string | null };
export const SlatePatchOpSchema: z.ZodType<SlatePatchOp> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), id: z.string(), piece: SlatePiece, under: z.string().optional(), at: z.number().int().optional(), children: z.record(SlatePiece).optional() }).strict(),
  z.object({ op: z.literal("replace"), id: z.string(), piece: SlatePiece, children: z.record(SlatePiece).optional() }).strict(),
  z.object({
    op: z.literal("props"), id: z.string(),
    props: z.record(SlatePropValue).optional(),
    when: z.string().nullable().optional(),
    on: z.record(z.union([SlateActionSchema, z.array(SlateActionSchema)])).optional(),
    fallback: z.union([z.string(), z.object({ text: z.string() }).strict()]).nullable().optional(),
  }).strict(),
  z.object({ op: z.literal("move"), id: z.string(), under: z.string(), at: z.number().int().optional() }).strict(),
  z.object({ op: z.literal("remove"), id: z.string() }).strict(),
  z.object({ op: z.literal("state"), path: z.string(), value: SlateJson }).strict(),
  z.object({ op: z.literal("feed"), id: z.string(), feed: SlateFeed.nullable() }).strict(),
  z.object({ op: z.literal("pipe"), id: z.string(), pipeline: z.string().nullable() }).strict(),
]) as unknown as z.ZodType<SlatePatchOp>;

/** The one shape for errors, warnings and draw-time problems. */
export const SlateProblem = z.object({
  code: z.string(),
  name: z.string(),
  message: z.string(),
  piece: z.string().optional(),
  prop: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  at: z.number().int().optional(),
  fix: z.string().optional(),
  op: z.number().int().optional(),
  since: z.string().optional(),
});
export type SlateProblem = z.infer<typeof SlateProblem>;

/** The structured line a press puts under the action's text: everything after "slate: " is this, on one line. */
export const SlateEvent = z.object({
  v: z.literal(1),
  kind: z.enum(["action", "annotation"]),
  thread: z.string(),
  version: z.number().int(),
  piece: z.string(),
  label: z.string().optional(),
  event: SlateEventName.optional(),
  action: z.enum(["send", "steer", "queue", "command"]).optional(),
  index: z.number().int().optional(),
  key: SlateJson.optional(),
  with: z.record(SlateJson).optional(),
  text: z.string().optional(),
  id: z.string().optional(),
  shown: z.record(SlateJson).optional(),
  by: z.literal("person"),
  at: z.string(),
});
export type SlateEvent = z.infer<typeof SlateEvent>;

/** What an expression reads its paths through. resolve answers undefined for data that has not arrived. */
export interface SlateEvalContext {
  resolve(path: string): SlateJson | undefined;
  row?: { item: SlateJson; index: number };
  now?: number;
}

/** A parsed expression. at is the 0-based offset of the node in its source. */
export type SlateExpr =
  | { k: "lit"; v: SlateJson; at: number }
  | { k: "path"; head: string; segs: (string | number)[]; at: number }
  | { k: "call"; name: string; args: SlateExpr[]; at: number }
  | { k: "neg"; arg: SlateExpr; at: number }
  | { k: "not"; arg: SlateExpr; at: number }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or"; left: SlateExpr; right: SlateExpr; at: number }
  | { k: "cond"; test: SlateExpr; then: SlateExpr; else: SlateExpr; at: number };
