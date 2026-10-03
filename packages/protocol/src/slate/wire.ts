import { z } from "zod";
import { AccountRow } from "../usage.js";
import { SlateJson, SlateProblem, SlateSchema, type Slate } from "./types.js";

// The slate's wire: the ops a window and the slate verbs send the host, what each answers, and the three events
// (01-architecture, "Wire operations"). Shapes the slate module owns are carried as JSON here and validated by
// that module on the host, so a window never needs the validator to read an answer.

/** A JSON value as the slate stores it: in state, in `with`, in a resolved path. */
export const SlateWireJson = SlateJson;

/** A stored document as an answer carries it: the host stored it only after the slate module validated it. */
export const SlateWireDocument = SlateSchema;
export type SlateWireDocument = Slate;

/** A document as a write sends it, unread until the validator reads it, so a malformed one gets its problems listed
 * rather than a refusal of the frame. */
const SentDocument = z.record(z.string(), z.unknown());

/** The one shape for errors, warnings and runtime problems (11-agent-toolchain). */
export const SlateWireProblem = SlateProblem;
export type SlateWireProblem = SlateProblem;

export const SlateState = z.record(z.string(), SlateWireJson);
export type SlateState = z.infer<typeof SlateState>;

export const SLATE_CAUSES = ["set", "patch", "state", "clear", "undo", "restore", "annotate", "consent"] as const;
export const SlateCause = z.enum(SLATE_CAUSES);
export type SlateCause = z.infer<typeof SlateCause>;

export const SlateBy = z.enum(["agent", "person", "host"]);
export type SlateBy = z.infer<typeof SlateBy>;

/** Why a slate has no document: never written, cleared, or rewound to a turn from before it existed (Z804). */
export const SlateEmpty = z.enum(["none", "cleared", "rewound-before"]);
export type SlateEmpty = z.infer<typeof SlateEmpty>;

/** The record as a window reads it: everything but the turn snapshots and the previous document. */
export const SlateView = z.object({
  threadId: z.string(),
  workspaceId: z.string(),
  version: z.number().int().nonnegative(),
  document: SlateWireDocument.nullable(),
  state: SlateState,
  /** Set while document is null, saying which empty state the tab draws. */
  empty: SlateEmpty.optional(),
  annotations: z.array(z.record(z.string(), z.unknown())),
  consents: z.record(z.string(), z.object({ state: z.enum(["allowed", "refused"]), at: z.number() })),
  problems: z.array(SlateWireProblem),
  shownOnce: z.boolean(),
  /** Whether the one-step undo has a document to go back to (08-state). */
  canUndo: z.boolean(),
  /** Whether a rewind moved this slate and Undo rewind can put it back. */
  rewound: z.boolean(),
  updatedAt: z.number(),
});
export type SlateView = z.infer<typeof SlateView>;

// --- params of each op, without the envelope's id and op ---

/** The thread a slate op is about. A window always names it; a thread's own token names its thread whatever is
 * sent, and a different one is refused (Z800); a person's shell inside a turn may send that turn's token instead. */
const threadParams = { threadId: z.string().optional(), turnToken: z.string().optional() };

export const SlatesGetParams = z.object({ threadId: z.string() });
export const SlatesStateParams = z.object({ ...threadParams, values: SlateState, ifVersion: z.number().int().optional(), sketch: z.boolean().optional() });
export const SlatesSetParams = z.object({ ...threadParams, lines: z.string().optional(), document: SentDocument.optional(), ifVersion: z.number().int().optional() });
export const SlatesPatchParams = z.object({ ...threadParams, lines: z.string().optional(), ops: z.array(z.record(z.string(), z.unknown())).optional(), ifVersion: z.number().int().optional() });
export const SlatesReadParams = z.object({ ...threadParams, values: z.array(z.string()).optional(), lines: z.boolean().optional(), sketch: z.boolean().optional() });
export const SlatesUndoParams = z.object(threadParams);
export const SlatesClearParams = z.object(threadParams);
export const SlatesShownParams = z.object({ threadId: z.string() });
export const SlatesActParams = z.object({
  threadId: z.string(),
  version: z.number().int(),
  piece: z.string(),
  event: z.string(),
  /** The index of the action in the event's list. */
  action: z.number().int().nonnegative(),
  requestId: z.string().min(1).max(200),
  /** The row, for an action on a repeating piece. */
  scope: z.object({ item: SlateWireJson, index: z.number().int().nonnegative() }).optional(),
  /** A row action of a repeating piece, by its index in the piece's rowActions, whose own `on` holds the action. */
  rowAction: z.number().int().nonnegative().optional(),
});
export const SlatesSubscribeParams = z.object({ threadId: z.string(), sources: z.array(z.string()), feeds: z.array(z.string()) });
export const SlatesResolveParams = z.object({ threadId: z.string(), paths: z.array(z.string()).max(200) });

/** Every slate op by name with its params, which the protocol's op union takes in whole. */
export const SLATE_OPS = {
  "slates.get": SlatesGetParams,
  "slates.state": SlatesStateParams,
  "slates.set": SlatesSetParams,
  "slates.patch": SlatesPatchParams,
  "slates.read": SlatesReadParams,
  "slates.undo": SlatesUndoParams,
  "slates.clear": SlatesClearParams,
  "slates.shown": SlatesShownParams,
  "slates.act": SlatesActParams,
  "slates.subscribe": SlatesSubscribeParams,
  "slates.unsubscribe": SlatesSubscribeParams,
  "slates.resolve": SlatesResolveParams,
} as const;
export type SlateOpName = keyof typeof SLATE_OPS;

// --- answers ---

export const SlatesGetAnswer = z.object({ slate: SlateView.nullable() });
export type SlatesGetAnswer = z.infer<typeof SlatesGetAnswer>;

/** What every document write answers: the version stored and how the slate reads now. */
export const SlateWriteAnswer = z.object({ version: z.number().int(), sketch: z.string(), warnings: z.array(SlateWireProblem), problems: z.array(SlateWireProblem) });
export type SlateWriteAnswer = z.infer<typeof SlateWriteAnswer>;

export const SlateStateAnswer = z.object({ version: z.number().int(), sketch: z.string().optional(), problems: z.array(SlateWireProblem).optional() });
export type SlateStateAnswer = z.infer<typeof SlateStateAnswer>;

export const SlateUndoAnswer = z.object({ version: z.number().int(), sketch: z.string() });
export type SlateUndoAnswer = z.infer<typeof SlateUndoAnswer>;

export const SlateClearAnswer = z.object({ version: z.number().int() });
export type SlateClearAnswer = z.infer<typeof SlateClearAnswer>;

export const SlateReadAnswer = z.object({
  schema: z.number().int(),
  version: z.number().int(),
  title: z.string().optional(),
  document: SlateWireDocument.nullable(),
  lines: z.string().optional(),
  state: SlateState,
  pipes: z.record(z.string(), SlateWireJson),
  feeds: z.record(z.string(), z.object({ at: z.number().optional(), error: z.string().optional(), loading: z.boolean().optional() })),
  values: z.record(z.string(), SlateWireJson),
  problems: z.array(SlateWireProblem),
  annotations: z.array(z.record(z.string(), z.unknown())),
  consents: z.record(z.string(), z.object({ state: z.enum(["allowed", "refused"]), at: z.number() })),
  sketch: z.string().optional(),
});
export type SlateReadAnswer = z.infer<typeof SlateReadAnswer>;

/** How a press that sends landed: the runtime's own start outcomes (09-actions). */
export const SlateActOutcome = z.enum(["started", "steered", "queued"]);
export type SlateActOutcome = z.infer<typeof SlateActOutcome>;

export const SlateActAnswer = z.object({
  outcome: SlateActOutcome,
  /** The quiet sentence the renderer draws under the piece for two seconds. */
  said: z.string(),
  turnId: z.string().optional(),
});
export type SlateActAnswer = z.infer<typeof SlateActAnswer>;

export const SlatesResolveAnswer = z.object({ values: z.record(z.string(), SlateWireJson) });
export type SlatesResolveAnswer = z.infer<typeof SlatesResolveAnswer>;

// --- events ---

/** Recorded in the transcript for every accepted write by the agent or the host: small, so the timeline can say
 * the slate changed and a window knows to fetch the record with slates.get. */
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
});
export type SessionSlateEvent = z.infer<typeof SessionSlateEvent>;

/** A state write, pushed to windows and never recorded: the person's typing would walk the transcript's cap. */
export const SlateStateEvent = z.object({ type: z.literal("slate.state"), workspaceId: z.string(), threadId: z.string(), version: z.number().int(), values: SlateState });
export type SlateStateEvent = z.infer<typeof SlateStateEvent>;

/** An account's row after a turn's limit reading folded into it, so a bound meter moves at once. */
export const UsageAccountEvent = z.object({ type: z.literal("usage.account"), key: z.string(), row: AccountRow });
export type UsageAccountEvent = z.infer<typeof UsageAccountEvent>;
