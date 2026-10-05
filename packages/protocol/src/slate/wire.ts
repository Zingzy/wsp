import { z } from "zod";
import { AccountRow } from "../usage.js";

// The slate's wire, version 2: the ops a window, the slate verbs and the Rust tool server send the host, what each
// answers, and the events (01-architecture, "Wire operations"). Shapes the slate module owns (the document, a
// problem) ride as open JSON here and are validated by that module on the host, so a window reads an answer
// without the validator and this file never moves when the module's types do.

/** A JSON value as a slate holds it: a live value, a `with` entry, a resolved path. */
export const SlateWireJson: z.ZodType<unknown> = z.unknown();

/** The stored document as an answer carries it, stored only after the slate module validated it. */
export const SlateWireDocument = z.record(z.string(), z.unknown());
export type SlateWireDocument = z.infer<typeof SlateWireDocument>;

/** The one shape for errors, warnings and runtime problems (10, "The failure object"); the module adds fields. */
export const SlateWireProblem = z.object({ code: z.string(), name: z.string(), message: z.string() }).passthrough();
export type SlateWireProblem = z.infer<typeof SlateWireProblem>;

/** Live values by path (`$name`, `$name.field`), secrets as their handles. */
export const SlateWireValues = z.record(z.string(), SlateWireJson);
export type SlateWireValues = z.infer<typeof SlateWireValues>;

export const SLATE_CAUSES = ["write", "state", "clear", "undo", "restore", "comment", "run"] as const;
export const SlateCause = z.enum(SLATE_CAUSES);
export type SlateCause = z.infer<typeof SlateCause>;

export const SLATE_BY = ["agent", "person", "host", "reaction", "timer"] as const;
export const SlateBy = z.enum(SLATE_BY);
export type SlateBy = z.infer<typeof SlateBy>;

/** Why a slate has no document: never written, cleared, or rewound to a turn from before it existed (Z804). */
export const SlateEmpty = z.enum(["none", "cleared", "rewound-before"]);
export type SlateEmpty = z.infer<typeof SlateEmpty>;

/** What the consent sheet shows for a held command (07, "Consent"): everything the person reads before approving. */
export const SlateCmdAsk = z.object({
  /** The approval key: the hash of the declaration without its values. */
  key: z.string(),
  run: z.string(),
  kind: z.literal("cmd"),
  cmd: z.string(),
  /** Each env name and the value it carries now; a secret as dots with its length. */
  env: z.record(z.string(), z.string()),
  args: z.array(z.string()),
  /** The first line of stdin, where there is any. */
  stdin: z.string().optional(),
  computer: z.string(),
  folder: z.string(),
  timeoutS: z.number(),
  confirm: z.string().optional(),
  /** The run's literal reshape, fed its raw result on stdin. */
  then: z.string().optional(),
  /** The text of each of the slate's files the run reads, by name. */
  files: z.record(z.string(), z.string()).optional(),
  /** Why it is held: "needs your approval", "started 12 times in a minute; press to run it again". */
  why: z.string(),
});

/** One tool of a server as the consent sheet lists it, its hints off the server's annotations. */
export const SlateAskTool = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  readOnly: z.boolean().optional(),
  destructive: z.boolean().optional(),
});

/** The first tool or resource run on a server in a thread: one consent covers reading and calling that server. The
 * key is `mcp:<server>`; "once" lets the held run go and asks again next time. */
export const SlateServerAsk = z.object({
  key: z.string(),
  run: z.string(),
  kind: z.literal("server"),
  server: z.string(),
  computer: z.string(),
  why: z.string(),
  tools: z.array(SlateAskTool),
  /** The tool, or a resource run's uri, the held run calls. */
  tool: z.string().optional(),
  /** That call's evaluated arguments, a secret as dots with its length. */
  args: z.record(z.string(), SlateWireJson).optional(),
  /** The run's literal reshape, fed its raw result on stdin; its consent is part of this one. */
  then: z.string().optional(),
  /** The text of each of the slate's files that reshape reads, by name. */
  files: z.record(z.string(), z.string()).optional(),
});

/** A destructive tool, or a run that names confirm, asks on every start; "once" runs it, "refuse" drops the start. */
export const SlateToolAsk = z.object({
  key: z.string(),
  run: z.string(),
  kind: z.literal("tool"),
  server: z.string(),
  tool: z.string(),
  computer: z.string(),
  why: z.string(),
  args: z.record(z.string(), SlateWireJson),
  confirm: z.string().optional(),
  then: z.string().optional(),
});

export const SlateAsk = z.discriminatedUnion("kind", [SlateCmdAsk, SlateServerAsk, SlateToolAsk]);
export type SlateAsk = z.infer<typeof SlateAsk>;

/** An approval as a window or a read sees it: allowed or refused, never whether once or for the thread. */
export const SlateApprovalView = z.object({ run: z.string().optional(), cmd: z.string().optional(), state: z.enum(["allowed", "refused"]), at: z.number() });
export type SlateApprovalView = z.infer<typeof SlateApprovalView>;

/** The record as a window reads it: everything but the turn snapshots and the previous document. */
export const SlateView = z.object({
  threadId: z.string(),
  workspaceId: z.string(),
  /** The document's version: moves only when the document does (a write, a patch, an undo, a clear, a rewind). */
  version: z.number().int().nonnegative(),
  /** The data revision the values were read at: rises with every batch of values or run results, and with every
   * version, so a window drops a push older than what it holds. No write checks it. */
  revision: z.number().int().nonnegative(),
  document: SlateWireDocument.nullable(),
  values: SlateWireValues,
  /** Set while document is null, saying which empty state the tab draws. */
  empty: SlateEmpty.optional(),
  comments: z.array(z.record(z.string(), z.unknown())),
  /** By approval key. */
  approvals: z.record(z.string(), SlateApprovalView),
  /** Every held run's sheet, oldest first: the header row's "This slate wants to run ..." and Review. */
  asks: z.array(SlateAsk),
  problems: z.array(SlateWireProblem),
  shownOnce: z.boolean(),
  canUndo: z.boolean(),
  updatedAt: z.number(),
});
export type SlateView = z.infer<typeof SlateView>;

// --- params of each op, without the envelope's id and op ---

/** The thread a slate op is about. A window always names it; a thread's own token names its thread whatever is
 * sent, and a different one is refused (Z800); a person's shell inside a turn may send that turn's token instead. */
const threadParams = { threadId: z.string().optional(), turnToken: z.string().optional() };

export const SlatesGetParams = z.object({ threadId: z.string() });
export const SlatesWriteParams = z.object({
  ...threadParams,
  /** The JSX-like form: a whole `<slate>`, or a patch (any other elements, `<clear />`, `<undo />`). */
  text: z.string().optional(),
  /** The stored form, instead of text. */
  document: z.record(z.string(), z.unknown()).optional(),
  /** Validate and sketch, store nothing. */
  check: z.boolean().optional(),
  ifVersion: z.number().int().optional(),
  /** With check: values to rehearse against, `$` optional, applied to a copy as the person's write would be. */
  values: SlateWireValues.optional(),
  /** With check: a press to rehearse after the values, by piece id, row index and a table's row action. */
  press: z.object({ piece: z.string(), index: z.number().int().nonnegative().optional(), action: z.number().int().nonnegative().optional() }).optional(),
  /** Text and document may both be left out of a rehearsal, which then runs against the slate as stored. */
});
/** start names runs the person said "Always in this thread" to; any other is answered held and not started. */
export const SlatesStateParams = z.object({ ...threadParams, values: SlateWireValues.optional(), start: z.array(z.string()).optional(), ifVersion: z.number().int().optional() });
export const SlatesReadParams = z.object({
  ...threadParams,
  values: z.array(z.string()).optional(),
  /** The document printed in the JSX-like form after the sketch; on unless false. */
  text: z.boolean().optional(),
  sketch: z.boolean().optional(),
  /** The stored JSON document too. */
  document: z.boolean().optional(),
});
/** With a thread, a name that is one of its agent's MCP servers answers that server's tools. */
export const SlatesCatalogParams = z.object({ name: z.string().optional(), ...threadParams });
export const SlatesEventParams = z.object({
  threadId: z.string(),
  /** The version the window drew; the host reads the piece off its own stored version all the same. */
  version: z.number().int(),
  piece: z.string(),
  event: z.enum(["press", "submit", "change"]),
  requestId: z.string().min(1).max(200),
  /** The row, for an event inside a repeating piece; the host reads `item` off its own list at delivery. */
  scope: z.object({ item: SlateWireJson, index: z.number().int().nonnegative() }).optional(),
  /** A row action of a table, by its index. */
  rowAction: z.number().int().nonnegative().optional(),
});
export const SlatesApproveParams = z.object({ threadId: z.string(), key: z.string(), scope: z.enum(["once", "thread", "refuse"]) });
export const SlatesCancelParams = z.object({ threadId: z.string(), run: z.string() });
export const SlatesShownParams = z.object({ threadId: z.string() });
export const SlatesSubscribeParams = z.object({ threadId: z.string(), sources: z.array(z.string()) });
export const SlatesResolveParams = z.object({ threadId: z.string(), paths: z.array(z.string()).max(200) });

/** Every slate op by name with its params, which the protocol's op union takes in whole. */
export const SLATE_OPS = {
  "slates.get": SlatesGetParams,
  "slates.write": SlatesWriteParams,
  "slates.state": SlatesStateParams,
  "slates.read": SlatesReadParams,
  "slates.catalog": SlatesCatalogParams,
  "slates.event": SlatesEventParams,
  "slates.approve": SlatesApproveParams,
  "slates.cancel": SlatesCancelParams,
  "slates.shown": SlatesShownParams,
  "slates.subscribe": SlatesSubscribeParams,
  "slates.unsubscribe": SlatesSubscribeParams,
  "slates.resolve": SlatesResolveParams,
} as const;
export type SlateOpName = keyof typeof SLATE_OPS;

// --- answers ---

export const SlatesGetAnswer = z.object({ slate: SlateView.nullable() });
export type SlatesGetAnswer = z.infer<typeof SlatesGetAnswer>;

/** What every write answers: the version stored and the sketch as text. */
/** waiting: the runs held for the person's approval, which is no fault of the slate's, so never among its problems. */
export const SlateWriteAnswer = z.object({ version: z.number().int(), text: z.string(), warnings: z.array(SlateWireProblem), problems: z.array(SlateWireProblem), waiting: z.array(z.string()).optional() });
export type SlateWriteAnswer = z.infer<typeof SlateWriteAnswer>;

/** notStarted: each run a start named that did not start, with why; the person's to start, not a fault. */
export const SlateStateAnswer = z.object({ version: z.number().int(), text: z.string(), problems: z.array(SlateWireProblem), waiting: z.array(z.string()).optional(), notStarted: z.array(z.string()).optional() });
export type SlateStateAnswer = z.infer<typeof SlateStateAnswer>;

/** 10, "Read back": the record, each derived value and run, the paths asked for, and the sketch as text. */
export const SlateReadAnswer = z.object({
  version: z.number().int(),
  /** The sketch, and unless `text: false` the document printed in the JSX-like form after a blank line. */
  text: z.string(),
  /** With `document: true` only. */
  document: SlateWireDocument.nullable().optional(),
  /** The paths named in the read's `values`, resolved now (10, worked transcript 3). */
  values: SlateWireValues,
  /** The live values by name, secrets as handles. */
  state: SlateWireValues,
  derived: SlateWireValues,
  runs: SlateWireValues,
  problems: z.array(SlateWireProblem),
  waiting: z.array(z.string()).optional(),
  comments: z.array(z.record(z.string(), z.unknown())),
  approvals: z.record(z.string(), z.enum(["allowed", "refused"])),
});
export type SlateReadAnswer = z.infer<typeof SlateReadAnswer>;

export const SlatesCatalogAnswer = z.object({ text: z.string() });
export type SlatesCatalogAnswer = z.infer<typeof SlatesCatalogAnswer>;

/** How an event landed: a send's start outcome, a run held for approval, or steps applied with nothing sent. */
export const SlateEventOutcome = z.enum(["started", "steered", "queued", "held", "done"]);
export type SlateEventOutcome = z.infer<typeof SlateEventOutcome>;

export const SlateEventAnswer = z.object({
  outcome: SlateEventOutcome,
  /** The quiet sentence the renderer draws under the piece for two seconds. */
  said: z.string(),
  turnId: z.string().optional(),
  /** The consent sheet's content when the press held a run. */
  ask: SlateAsk.optional(),
});
export type SlateEventAnswer = z.infer<typeof SlateEventAnswer>;

export const SlatesResolveAnswer = z.object({ values: SlateWireValues });
export type SlatesResolveAnswer = z.infer<typeof SlatesResolveAnswer>;

// --- events ---

/** Recorded in the transcript for every accepted write by the agent, a run's start and end and the host's restores:
 * small, so the timeline can say the slate changed and a window knows to fetch the record. No values ride it. */
export const SessionSlateEvent = z.object({
  type: z.literal("session.slate"),
  workspaceId: z.string(),
  sessionId: z.string(),
  at: z.number().optional(),
  turnId: z.string().optional(),
  threadId: z.string(),
  cause: SlateCause,
  version: z.number().int(),
  by: SlateBy,
  /** The piece ids the write touched, at most 20. */
  pieces: z.array(z.string()).max(20),
  /** The run, for cause run. */
  run: z.string().optional(),
});
export type SessionSlateEvent = z.infer<typeof SessionSlateEvent>;

/** Values that moved in a batch, pushed to windows and never recorded: the person's typing would walk the
 * transcript's cap. Secrets as handles. */
export const SlateValuesEvent = z.object({ type: z.literal("slate.values"), workspaceId: z.string(), threadId: z.string(), version: z.number().int(), revision: z.number().int(), values: SlateWireValues });
export type SlateValuesEvent = z.infer<typeof SlateValuesEvent>;

/** New lines of a streaming run, scrubbed, pushed and never recorded. */
export const SlateRunEvent = z.object({ type: z.literal("slate.run"), workspaceId: z.string(), threadId: z.string(), run: z.string(), lines: z.array(z.string()) });
export type SlateRunEvent = z.infer<typeof SlateRunEvent>;

/** An account's row after a turn's limit reading folded into it, so a bound meter moves at once. */
export const UsageAccountEvent = z.object({ type: z.literal("usage.account"), key: z.string(), row: AccountRow });
export type UsageAccountEvent = z.infer<typeof UsageAccountEvent>;
