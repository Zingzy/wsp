// The typed contract every client speaks: workspace/session views, the event
// union fanned out by the runtime, and the wire types for both servers (the
// runtime's serveRuntime and the in-VM daemon). The daemon package has no
// exported wire types, so these schemas are their one home; @wsp/daemon's
// handlers are the reference implementation they mirror.

import { z } from "zod";

// --- backend capabilities ----------------------------------------------------

/** Honest per-backend feature flags; the UI degrades based on these, never on probing. */
export const Capabilities = z.object({
  liveCloneForks: z.boolean(),
  ramPreservingPause: z.boolean(),
  resize: z.boolean(),
  previewUrls: z.boolean(),
  signedUrls: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

// --- views -----------------------------------------------------------------

export const WorkspacePhase = z.enum(["running", "napping"]);
export type WorkspacePhase = z.infer<typeof WorkspacePhase>;

export const WorkspaceView = z.object({
  id: z.string(),
  name: z.string(),
  machineId: z.string(),
  phase: WorkspacePhase,
  /** Snapshot id of the golden image this workspace forks from. */
  golden: z.string(),
  createdAt: z.string(),
  /** Claude session id of the last session, so the next send can --resume it. */
  claudeSessionId: z.string().optional(),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

export const SessionStatus = z.enum(["running", "completed", "interrupted", "failed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionView = z.object({
  id: z.string(),
  workspaceId: z.string(),
  harness: z.string(),
  status: SessionStatus,
  claudeSessionId: z.string().optional(),
});
export type SessionView = z.infer<typeof SessionView>;

// --- session events (mirroring @wsp/adapter-claude's AdapterEvent) ----------

export const DeltaKind = z.enum(["text", "thinking", "tool_use", "tool_result"]);
export type DeltaKind = z.infer<typeof DeltaKind>;

export const TurnStatus = z.enum(["completed", "interrupted", "failed"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const TurnResult = z.object({
  status: TurnStatus,
  durationMs: z.number().optional(),
  costUsd: z.number().optional(),
  usage: z.record(z.unknown()).optional(),
  text: z.string().optional(),
  error: z.string().optional(),
});
export type TurnResult = z.infer<typeof TurnResult>;

const sessionScope = { workspaceId: z.string(), sessionId: z.string() };

export const SessionStartEvent = z.object({
  type: z.literal("session.start"),
  ...sessionScope,
  model: z.string().optional(),
  cwd: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

export const SessionDeltaEvent = z.object({
  type: z.literal("session.delta"),
  ...sessionScope,
  kind: DeltaKind,
  text: z.string(),
  toolName: z.string().optional(),
  toolUseId: z.string().optional(),
  isError: z.boolean().optional(),
});

export const SessionDoneEvent = z.object({
  type: z.literal("session.done"),
  ...sessionScope,
  result: TurnResult,
});

export const SessionEndEvent = z.object({
  type: z.literal("session.end"),
  ...sessionScope,
  exitCode: z.number().nullable(),
  sawResult: z.boolean(),
});

// --- workspace / port / inbox events ----------------------------------------

export const WorkspaceCreatedEvent = z.object({ type: z.literal("workspace.created"), workspace: WorkspaceView });
export const WorkspaceNappedEvent = z.object({ type: z.literal("workspace.napped"), workspaceId: z.string() });
export const WorkspaceWokenEvent = z.object({
  type: z.literal("workspace.woken"),
  workspaceId: z.string(),
  machineId: z.string(),
  /** True when the paused machine had vanished and a fresh golden fork replaced it. */
  resurrected: z.boolean(),
});
export const WorkspaceUpgradedEvent = z.object({
  type: z.literal("workspace.upgraded"),
  workspaceId: z.string(),
  machineId: z.string(),
});
export const WorkspaceDeletedEvent = z.object({ type: z.literal("workspace.deleted"), workspaceId: z.string() });

export const PortOpenEvent = z.object({
  type: z.literal("port.open"),
  workspaceId: z.string(),
  port: z.number(),
  pid: z.number().optional(),
});
export const PortCloseEvent = z.object({ type: z.literal("port.close"), workspaceId: z.string(), port: z.number() });
export const InboxFileEvent = z.object({
  type: z.literal("inbox.file"),
  workspaceId: z.string(),
  path: z.string(),
  bytes: z.number(),
});

export const EventUnion = z.discriminatedUnion("type", [
  WorkspaceCreatedEvent,
  WorkspaceNappedEvent,
  WorkspaceWokenEvent,
  WorkspaceUpgradedEvent,
  WorkspaceDeletedEvent,
  SessionStartEvent,
  SessionDeltaEvent,
  SessionDoneEvent,
  SessionEndEvent,
  PortOpenEvent,
  PortCloseEvent,
  InboxFileEvent,
]);
export type EventUnion = z.infer<typeof EventUnion>;

// --- daemon wire protocol (ws://0.0.0.0:7070/?token=..., 4401 on bad token) ---

const reqId = z.union([z.string(), z.number()]);

export const DaemonRequest = z.discriminatedUnion("op", [
  z.object({
    id: reqId,
    op: z.literal("pty.create"),
    cols: z.number().optional(),
    rows: z.number().optional(),
    shell: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({ id: reqId, op: z.literal("pty.attach"), ptyId: z.string() }),
  z.object({ id: reqId, op: z.literal("pty.write"), ptyId: z.string(), data: z.string() }),
  z.object({ id: reqId, op: z.literal("pty.resize"), ptyId: z.string(), cols: z.number(), rows: z.number() }),
  z.object({ id: reqId, op: z.literal("pty.kill"), ptyId: z.string() }),
  z.object({ id: reqId, op: z.literal("pty.list") }),
  z.object({ id: reqId, op: z.literal("ports.watch") }),
  z.object({ id: reqId, op: z.literal("manifest.get") }),
  z.object({
    id: reqId,
    op: z.literal("manifest.record"),
    cmd: z.string(),
    cwd: z.string(),
    port: z.number().optional(),
  }),
  z.object({ id: reqId, op: z.literal("manifest.restartScript") }),
  z.object({ id: reqId, op: z.literal("inbox.watch") }),
  z.object({ id: reqId, op: z.literal("inbox.rescan") }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

export const DaemonOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
export const DaemonErrorResponse = z.object({ id: reqId.nullable(), ok: z.literal(false), error: z.string() });
export const DaemonResponse = z.union([DaemonOkResponse, DaemonErrorResponse]);
export type DaemonResponse = z.infer<typeof DaemonResponse>;

export const DaemonEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pty.data"), ptyId: z.string(), data: z.string() }),
  z.object({
    type: z.literal("pty.exit"),
    ptyId: z.string(),
    exitCode: z.number(),
    signal: z.number().optional(),
  }),
  z.object({ type: z.literal("port.open"), port: z.number(), pid: z.number().optional() }),
  z.object({ type: z.literal("port.close"), port: z.number() }),
  z.object({ type: z.literal("inbox.file"), path: z.string(), bytes: z.number() }),
]);
export type DaemonEvent = z.infer<typeof DaemonEvent>;

// --- runtime wire protocol (serveRuntime) ------------------------------------

export const TicketPurpose = z.enum(["connect"]);
export type TicketPurpose = z.infer<typeof TicketPurpose>;

export const RuntimeRequest = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("auth"), token: z.string() }),
  z.object({ id: reqId, op: z.literal("ticket.issue"), purpose: TicketPurpose }),
  z.object({ id: reqId, op: z.literal("events.subscribe") }),
  z.object({
    id: reqId,
    op: z.literal("workspaces.create"),
    golden: z.string(),
    name: z.string(),
    cpu: z.number().optional(),
    memMb: z.number().optional(),
    envs: z.record(z.string()).optional(),
    labels: z.record(z.string()).optional(),
  }),
  z.object({ id: reqId, op: z.literal("workspaces.list") }),
  z.object({ id: reqId, op: z.literal("workspaces.get"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.nap"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.wake"), workspaceId: z.string() }),
  z.object({
    id: reqId,
    op: z.literal("workspaces.upgrade"),
    workspaceId: z.string(),
    cpu: z.number().optional(),
    memMb: z.number().optional(),
  }),
  z.object({ id: reqId, op: z.literal("workspaces.delete"), workspaceId: z.string() }),
  z.object({
    id: reqId,
    op: z.literal("sessions.start"),
    workspaceId: z.string(),
    prompt: z.string(),
    harness: z.string().optional(),
    resume: z.string().optional(),
    cwd: z.string().optional(),
  }),
  z.object({ id: reqId, op: z.literal("sessions.list"), workspaceId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("golden.get"), name: z.string() }),
]);
export type RuntimeRequest = z.infer<typeof RuntimeRequest>;

export const RuntimeOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
export const RuntimeErrorResponse = z.object({ id: reqId.nullable(), ok: z.literal(false), error: z.string() });
export const RuntimeResponse = z.union([RuntimeOkResponse, RuntimeErrorResponse]);
export type RuntimeResponse = z.infer<typeof RuntimeResponse>;
