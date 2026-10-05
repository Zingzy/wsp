// SPDX-License-Identifier: AGPL-3.0-only
// The slate document of schema 2 as the host stores it and the renderer draws it: values, derived values, runs,
// reactions and pieces (02-model, 03-syntax, 07-runs, 08-secrets), the run record and the secret handle a value
// holds, the Problem every error, warning and runtime fault is reported in, and the patch ops.
import { z } from "zod";

export type SlateJson = null | boolean | number | string | SlateJson[] | { [key: string]: SlateJson };
export const SlateJson: z.ZodType<SlateJson> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(SlateJson), z.record(SlateJson)]),
);

/** A piece id: a letter, then letters, digits, "-" or "_", 1 to 48 characters. Ids and declared names are apart:
 * a piece "spot" and a run $spot never collide. */
export type SlateId = string;
export const SLATE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
/** A file's name: a plain file name, no folders, not hidden. */
export const SLATE_FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** A value, derived value or run name, read as $name. */
export type SlateName = string;
export const SLATE_NAME = /^[a-z_][a-zA-Z0-9_]{0,47}$/;

/** An expression in the language of 04, as source text. */
export type SlateExpression = string;
/** "$name" with fields and indexes: the slate's own. */
export type SlateOwnPath = string;
/** Any path an expression reads: an own path, a source path, or item and index in a row scope. */
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
  z.union([z.null(), z.boolean(), z.number(), z.string(), SlateBinding, SlateFormat, z.array(SlatePropValue), z.record(SlatePropValue)]),
);

export const isSlateBinding = (v: unknown): v is SlateBinding =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as SlateBinding).bind === "string";
export const isSlateFormat = (v: unknown): v is SlateFormat =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as SlateFormat).format === "string";

export const SLATE_EVENTS = ["press", "submit", "change"] as const;
export type SlateEventName = (typeof SLATE_EVENTS)[number];
export const SlateEventName = z.enum(SLATE_EVENTS);

export const SLATE_PANE_KINDS = ["preview", "terminal", "diff", "pr", "files", "machine", "processes", "agents", "slate"] as const;
export type SlatePaneKind = (typeof SLATE_PANE_KINDS)[number];

// ---- steps (02, "Reactions") ----

export type SlateSendKind = "send" | "steer" | "queue";
export interface SlateSendStep { do: SlateSendKind; text: string; with?: SlatePath[] }

export type SlateStep =
  | { do: "set"; path: SlateOwnPath; value: SlatePropValue }
  | { do: "toggle"; path: SlateOwnPath }
  | { do: "start"; run: SlateName }
  | { do: "cancel"; run: SlateName }
  | SlateSendStep
  | { do: "fill"; text: string; with?: SlatePath[] }
  | { do: "open"; target: SlatePropValue }
  | { do: "copy"; text: SlatePropValue }
  | { do: "pane"; kind: SlatePaneKind };
export type SlateStepKind = SlateStep["do"];

const withPaths = z.array(z.string()).optional();
export const SlateStepSchema: z.ZodType<SlateStep> = z.discriminatedUnion("do", [
  z.object({ do: z.literal("set"), path: z.string(), value: SlatePropValue }).strict(),
  z.object({ do: z.literal("toggle"), path: z.string() }).strict(),
  z.object({ do: z.literal("start"), run: z.string() }).strict(),
  z.object({ do: z.literal("cancel"), run: z.string() }).strict(),
  z.object({ do: z.literal("send"), text: z.string(), with: withPaths }).strict(),
  z.object({ do: z.literal("steer"), text: z.string(), with: withPaths }).strict(),
  z.object({ do: z.literal("queue"), text: z.string(), with: withPaths }).strict(),
  z.object({ do: z.literal("fill"), text: z.string(), with: withPaths }).strict(),
  z.object({ do: z.literal("open"), target: SlatePropValue }).strict(),
  z.object({ do: z.literal("copy"), text: SlatePropValue }).strict(),
  z.object({ do: z.literal("pane"), kind: z.enum(SLATE_PANE_KINDS) }).strict(),
]) as unknown as z.ZodType<SlateStep>;

// ---- declarations ----

export interface SlateValueDecl {
  /** The value a fresh slate starts with. A secret starts empty and holds its handle. */
  start: SlateJson;
  /** Typed by the person, held by the host, never read by the agent (08). */
  secret?: true;
  /** A secret kept across host restarts at 0600 in the host's folder (08). */
  keep?: true;
}
export type SlateSecretDecl = SlateValueDecl & { secret: true };
/** One expression in the language of 04, as source text. */
export type SlateDerivedDecl = SlateExpression;

/** confirm is the sentence the sheet asks on every start: literal, or a formula read when the run is held. then is a
 * literal command that reads the raw result on stdin and prints the JSON the run's json becomes. */
interface RunCommon { confirm?: string | SlateBinding | SlateFormat; every?: number; once?: true; always?: true; then?: string }
export type SlateRunDecl =
  | (RunCommon & {
      kind: "cmd"; cmd: string; env?: Record<string, SlatePropValue>; args?: SlatePropValue[]; stdin?: SlatePropValue;
      on?: "thread" | "host"; cwd?: string; timeout?: number; stream?: true;
    })
  | (RunCommon & { kind: "tool"; server: string; tool: string; args?: Record<string, SlatePropValue> })
  | { kind: "resource"; server: string; uri: string; every?: number; always?: true; then?: string };

/** A reaction declared with <when>; a piece's handlers are reactions on the piece's own events. */
export interface SlateReactionDecl {
  /** Required in a patch, so a later patch can name it. */
  id?: string;
  on: { change: SlatePath[] } | { done: SlateName };
  do: SlateStep[];
}

// ---- pieces ----

export interface SlatePiece {
  type: string;
  props?: Record<string, SlatePropValue>;
  children?: SlateId[];
  when?: SlateExpression;
  on?: Partial<Record<SlateEventName, SlateStep[]>>;
  fallback?: SlateId | "drop" | { text: string };
}

/** A table's or a list's row action, held in props.rowActions. */
export interface SlateRowAction { label: SlatePropValue; when?: SlateExpression; on?: { press?: SlateStep[] } }

export interface SlateDoc {
  schema: 2;
  kit?: string;
  title?: string;
  root: SlateId;
  values: Record<SlateName, SlateValueDecl>;
  derived: Record<SlateName, SlateDerivedDecl>;
  runs: Record<SlateName, SlateRunDecl>;
  reactions: SlateReactionDecl[];
  pieces: Record<SlateId, SlatePiece>;
  /** Code written only for the slate, by file name; the host writes each into the slate's folder, which runs read
   * as $SLATE_DIR. */
  files?: Record<string, string>;
}
/** The stored document; the wire calls it Slate. */
export type Slate = SlateDoc;

const RunCommonSchema = { confirm: z.union([z.string(), SlateBinding, SlateFormat]).optional(), every: z.number().optional(), once: z.literal(true).optional(), always: z.literal(true).optional(), then: z.string().optional() };
export const SlateRunDeclSchema: z.ZodType<SlateRunDecl> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cmd"), cmd: z.string(), env: z.record(SlatePropValue).optional(), args: z.array(SlatePropValue).optional(), stdin: SlatePropValue.optional(),
    on: z.enum(["thread", "host"]).optional(), cwd: z.string().optional(), timeout: z.number().optional(), stream: z.literal(true).optional(), ...RunCommonSchema,
  }).strict(),
  z.object({ kind: z.literal("tool"), server: z.string(), tool: z.string(), args: z.record(SlatePropValue).optional(), ...RunCommonSchema }).strict(),
  z.object({ kind: z.literal("resource"), server: z.string(), uri: z.string(), every: z.number().optional(), always: z.literal(true).optional(), then: z.string().optional() }).strict(),
]) as unknown as z.ZodType<SlateRunDecl>;

export const SlatePieceSchema: z.ZodType<SlatePiece> = z.object({
  type: z.string(),
  props: z.record(SlatePropValue).optional(),
  children: z.array(z.string()).optional(),
  when: z.string().optional(),
  on: z.object({ press: z.array(SlateStepSchema).optional(), submit: z.array(SlateStepSchema).optional(), change: z.array(SlateStepSchema).optional() }).strict().optional(),
  fallback: z.union([z.string(), z.object({ text: z.string() }).strict()]).optional(),
}).strict();

export const SlateReactionSchema: z.ZodType<SlateReactionDecl> = z.object({
  id: z.string().optional(),
  on: z.union([z.object({ change: z.array(z.string()) }).strict(), z.object({ done: z.string() }).strict()]),
  do: z.array(SlateStepSchema),
}).strict();

/** The document's frame. The validator is the contract; this only says the shape is a slate at all. */
export const SlateSchema: z.ZodType<SlateDoc> = z.object({
  schema: z.literal(2),
  kit: z.string().optional(),
  title: z.string().optional(),
  root: z.string(),
  values: z.record(z.object({ start: SlateJson, secret: z.literal(true).optional(), keep: z.literal(true).optional() }).strict()),
  derived: z.record(z.string()),
  runs: z.record(SlateRunDeclSchema),
  reactions: z.array(SlateReactionSchema),
  pieces: z.record(SlatePieceSchema),
  files: z.record(z.string()).optional(),
}).strict();

// ---- what values hold ----

export const SLATE_RUN_STATES = ["idle", "held", "running", "done", "failed", "cancelled"] as const;
export type SlateRunState = (typeof SLATE_RUN_STATES)[number];

/** What $run reads while and after the run. Written whole by the host; never by anyone else. */
export interface SlateRunRecord {
  state: SlateRunState;
  /** Why it is held or failed. */
  why?: string;
  exit?: number | null;
  /** stdout as text, the tail under 64 KB; a tool's structured content or first text. */
  out?: SlateJson;
  err?: string;
  /** out parsed as JSON where it parses. */
  json?: SlateJson;
  /** The last 500 lines while streaming. */
  lines?: string[];
  startedAt?: number;
  endedAt?: number;
  ms?: number;
  /** How many times the run has started in this slate's life. */
  runs: number;
  cut?: true;
  /** The command changed since this record was written; the next start drops it. */
  stale?: true;
  /** Running again, the last result's fields kept until the new one replaces them. */
  refreshing?: true;
  /** A tool answered with text alone, no structured result. */
  text?: true;
}
export const SLATE_RUN_FIELDS = ["state", "why", "exit", "out", "err", "json", "lines", "startedAt", "endedAt", "ms", "runs", "cut", "stale", "refreshing", "text"] as const;
export const SLATE_RUN_IDLE: SlateRunRecord = { state: "idle", runs: 0 };

/** What $secret reads: never the plaintext. */
export interface SlateSecretHandle { secret: true; set: boolean; len: number; at: number | null }
export const SLATE_SECRET_FIELDS = ["set", "len", "at"] as const;
export const SLATE_SECRET_EMPTY: SlateSecretHandle = { secret: true, set: false, len: 0, at: null };

export const isSlateSecretHandle = (v: unknown): v is SlateSecretHandle =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (v as SlateSecretHandle).secret === true && typeof (v as SlateSecretHandle).set === "boolean"
  && typeof (v as SlateSecretHandle).len === "number" && Object.keys(v).every(k => k === "secret" || k === "set" || k === "len" || k === "at");

/** A slate's live values, keyed by name without the $: plain values, run records and secret handles. */
export type SlateValues = Record<SlateName, SlateJson>;

// ---- problems ----

/** The one shape for errors, warnings and runtime problems (10). */
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
  since: z.string().optional(),
});
export type SlateProblem = z.infer<typeof SlateProblem>;

// ---- patches (03, "Patches") ----

export type SlatePatchOp =
  | { op: "replace"; id: SlateId; piece: SlatePiece; children?: Record<SlateId, SlatePiece> }
  | { op: "props"; id: SlateId; props?: Record<string, SlatePropValue | null>; when?: SlateExpression | null; on?: SlatePiece["on"]; fallback?: SlatePiece["fallback"] | null }
  | { op: "add"; under: SlateId; at?: number; pieces: Record<SlateId, SlatePiece>; order: SlateId[] }
  | { op: "remove"; id: SlateId }
  | { op: "move"; id: SlateId; under: SlateId; at?: number }
  | { op: "value"; name: SlateName; decl: SlateValueDecl | null }
  | { op: "derived"; name: SlateName; expr: SlateExpression | null }
  | { op: "run"; name: SlateName; decl: SlateRunDecl | null }
  | { op: "reaction"; id: string; reaction: SlateReactionDecl | null }
  | { op: "file"; name: string; text: string | null }
  | { op: "clear" }
  | { op: "undo" };

export interface SlatePatch { ops: SlatePatchOp[] }

// ---- the message a press sends (09) ----

/** The structured line a send puts under its text: everything after "slate: " is this, on one line. */
export const SlateEvent = z.object({
  v: z.literal(2),
  kind: z.enum(["action", "reaction", "comment"]),
  thread: z.string(),
  version: z.number().int(),
  piece: z.string().optional(),
  label: z.string().optional(),
  event: SlateEventName.optional(),
  index: z.number().int().optional(),
  key: SlateJson.optional(),
  with: z.record(SlateJson).optional(),
  text: z.string().optional(),
  shown: z.record(SlateJson).optional(),
  by: z.enum(["person", "reaction"]),
  at: z.string(),
});
export type SlateEvent = z.infer<typeof SlateEvent>;
