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
  /** Guests can run containers; false means services get installed natively. */
  containers: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

// --- views -----------------------------------------------------------------

export const WorkspacePhase = z.enum(["running", "napping", "waking"]);
export type WorkspacePhase = z.infer<typeof WorkspacePhase>;

/** Backend vocabulary: a napping workspace's machine reads "paused" here.
 * Phase is the product word, machine state the provider word; clients render
 * phase and use machineState only for divergence (starting, gone). */
export const MachineState = z.enum(["starting", "running", "paused", "gone"]);
export type MachineState = z.infer<typeof MachineState>;

export const ReachState = z.enum(["reachable", "no-daemon", "unreachable", "napping", "unsupported", "gone"]);
export type ReachState = z.infer<typeof ReachState>;

export const ReachStatus = z.object({
  state: ReachState,
  url: z.string().optional(),
  expiresAt: z.number().optional(),
});
export type ReachStatus = z.infer<typeof ReachStatus>;

/** What a browser needs to dial a workspace's daemon: the minted preview route
 * (edge token embedded, hourly expiry) and the daemon's own query token as read
 * off the guest. No daemonToken means no daemon token file on that machine. */
export const DaemonReachView = z.object({
  url: z.string(),
  expiresAt: z.number(),
  daemonToken: z.string().optional(),
});
export type DaemonReachView = z.infer<typeof DaemonReachView>;

/** The same minted route for any other guest port, as a browser frames it. The
 * daemon token stays off this view: it opens the daemon's socket, not a page. */
export const PortReachView = DaemonReachView.omit({ daemonToken: true });
export type PortReachView = z.infer<typeof PortReachView>;

export const WorkspaceSize = z.object({ cpu: z.number(), memMb: z.number() });
export type WorkspaceSize = z.infer<typeof WorkspaceSize>;

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
  /** Present when the machine streams a display (desktop kind); sandbox machines are headless. */
  screen: z.object({ streamUrl: z.string() }).optional(),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

/** WorkspaceView enriched with what the rail and meta panel render live. */
export const WorkspaceStatus = WorkspaceView.extend({
  machineState: MachineState,
  reach: ReachStatus,
  size: WorkspaceSize,
  /** Awake burn rate for this size; 0 never appears here (napping costs ride the cost event). */
  rateUsdPerHour: z.number(),
  /** Why the runtime pushed this status outside the poll: a wake that had to retry or replace the machine. */
  reason: z.string().optional(),
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

export const SessionStatus = z.enum(["running", "completed", "interrupted", "failed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionView = z.object({
  id: z.string(),
  workspaceId: z.string(),
  harness: z.string(),
  status: SessionStatus,
  claudeSessionId: z.string().optional(),
  /** The user's turn that started this session. */
  prompt: z.string().optional(),
  /** Ms epoch, runtime clock; endedAt is unset while the session runs. */
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
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

const sessionScope = {
  workspaceId: z.string(),
  sessionId: z.string(),
  /** Ms epoch from the runtime clock when it recorded the event; the adapter has no clock of its own. */
  at: z.number().optional(),
  /** Minted by the runtime per sessions.start. The Claude session id repeats across --resume, so it
   * cannot split a transcript into turns; this can. */
  turnId: z.string().optional(),
};

/** What the CLI announces about itself in system/init, beyond model and tools. */
export const SessionHarness = z.object({
  slashCommands: z.array(z.string()).optional(),
  permissionMode: z.string().optional(),
  agents: z.array(z.string()).optional(),
});
export type SessionHarness = z.infer<typeof SessionHarness>;

export const SessionStartEvent = z.object({
  type: z.literal("session.start"),
  ...sessionScope,
  /** The user's turn; set by the runtime (the adapter never sees it) so a replayed transcript shows it. */
  prompt: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  tools: z.array(z.string()).optional(),
  harness: SessionHarness.optional(),
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

/** The events sessions.history replays: what a chat transcript folds. */
export const SessionEvent = z.discriminatedUnion("type", [SessionStartEvent, SessionDeltaEvent, SessionDoneEvent, SessionEndEvent]);
export type SessionEvent = z.infer<typeof SessionEvent>;

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

export const WorkspaceStatusEvent = z.object({ type: z.literal("workspace.status"), status: WorkspaceStatus });

/** Awake-time cost tick. Computed locally from size and elapsed running time
 * (provider billing API integration is a later plan); zero rate while napping. */
export const WorkspaceCostEvent = z.object({
  type: z.literal("workspace.cost"),
  workspaceId: z.string(),
  phase: WorkspacePhase,
  /** Current burn: the size's awake rate while running, 0 while napping. */
  rateUsdPerHour: z.number(),
  /** Total awake milliseconds behind accruedUsd since this runtime began tracking. */
  awakeMs: z.number(),
  accruedUsd: z.number(),
  at: z.string(),
});

export const PortOpenEvent = z.object({
  type: z.literal("port.open"),
  workspaceId: z.string(),
  port: z.number(),
  pid: z.number().optional(),
  /** The listener's /proc/<pid>/comm; absent when the pid or its comm is unreadable. */
  process: z.string().optional(),
});
export const PortCloseEvent = z.object({ type: z.literal("port.close"), workspaceId: z.string(), port: z.number() });
export const InboxFileEvent = z.object({
  type: z.literal("inbox.file"),
  workspaceId: z.string(),
  path: z.string(),
  bytes: z.number(),
});

// --- golden image (manifest, interactive builder, wizard stages) --------------

export const MachineKind = z.enum(["sandbox", "desktop"]);
export type MachineKind = z.infer<typeof MachineKind>;

/** One sealed image. `kind` is the machine kind the snapshot was taken from and
 * therefore restores as; entries sealed before kind was recorded were all
 * sandboxes, so readers treat a missing kind as sandbox. */
export const GoldenVersion = z.object({
  version: z.number(),
  snapshotId: z.string(),
  baseTemplate: z.string(),
  kind: MachineKind.optional(),
  setupSha: z.string(),
  createdAt: z.string(),
  smoke: z.object({ cmd: z.string(), exitCode: z.number() }),
  /** What the provider built the builder at; forks of this version inherit it unless told otherwise. */
  size: WorkspaceSize.optional(),
});
export type GoldenVersion = z.infer<typeof GoldenVersion>;

export const GoldenManifest = z.object({ head: z.number(), versions: z.array(GoldenVersion) });
export type GoldenManifest = z.infer<typeof GoldenManifest>;

/** The live machine a person sets up before sealing it as a golden. It is not
 * a workspace and never appears in the rail; `screen` is present when the
 * machine streams a display (desktop kind). */
export const GoldenBuilderView = z.object({
  id: z.string(),
  name: z.string(),
  kind: MachineKind,
  createdAt: z.string(),
  screen: z.object({ streamUrl: z.string() }).optional(),
});
export type GoldenBuilderView = z.infer<typeof GoldenBuilderView>;

export const GoldenStage = z.enum([
  "creating",
  "deploying-daemon",
  "installing-harness",
  "ready",
  "snapshotting",
  "smoke-forking",
  "sealed",
  "failed",
]);
export type GoldenStage = z.infer<typeof GoldenStage>;

/** Progress of a golden prepare or seal, keyed by golden name; `detail` is
 * free text for a progress line (the failure message on `failed`). */
export const GoldenStageEvent = z.object({
  type: z.literal("golden.stage"),
  name: z.string(),
  stage: GoldenStage,
  detail: z.string().optional(),
});
export type GoldenStageEvent = z.infer<typeof GoldenStageEvent>;

export const EventUnion = z.discriminatedUnion("type", [
  WorkspaceCreatedEvent,
  WorkspaceNappedEvent,
  WorkspaceWokenEvent,
  WorkspaceUpgradedEvent,
  WorkspaceDeletedEvent,
  WorkspaceStatusEvent,
  WorkspaceCostEvent,
  SessionStartEvent,
  SessionDeltaEvent,
  SessionDoneEvent,
  SessionEndEvent,
  PortOpenEvent,
  PortCloseEvent,
  InboxFileEvent,
  GoldenStageEvent,
]);
export type EventUnion = z.infer<typeof EventUnion>;

// --- daemon wire protocol (ws://0.0.0.0:7070/?token=..., 4401 on bad token) ---

/** Client-side health of a daemon link; reauth-needed and dead are terminal. */
export const DaemonLinkStatus = z.enum(["connecting", "live", "reauth-needed", "dead"]);
export type DaemonLinkStatus = z.infer<typeof DaemonLinkStatus>;

const reqId = z.union([z.string(), z.number()]);

// Replies carry no op, so each files/diff op has its own reply schema here
// instead of a discriminated union; DaemonOkResponse stays the loose envelope.

export const FsEntryType = z.enum(["file", "dir", "symlink"]);
export type FsEntryType = z.infer<typeof FsEntryType>;
/** name is the path relative to the listed directory ("src/a.ts" at depth 2);
 * size is 0 for anything but a file; mtime is epoch milliseconds. */
export const FsEntry = z.object({ name: z.string(), type: FsEntryType, size: z.number(), mtime: z.number() });
export type FsEntry = z.infer<typeof FsEntry>;
export const FsListReply = z.object({ entries: z.array(FsEntry), truncated: z.boolean() });
export type FsListReply = z.infer<typeof FsListReply>;

export const FsReadEncoding = z.enum(["utf8", "base64"]);
export type FsReadEncoding = z.infer<typeof FsReadEncoding>;
/** size is the whole file's byte length; content holds at most the first 2 MiB. */
export const FsReadReply = z.object({ content: z.string(), size: z.number(), truncated: z.boolean() });
export type FsReadReply = z.infer<typeof FsReadReply>;

/** Porcelain v2 branch header: head is "(detached)" off a branch, oid
 * "(initial)" before the first commit; ahead/behind are 0 without an upstream. */
export const GitBranch = z.object({
  oid: z.string(),
  head: z.string(),
  upstream: z.string().optional(),
  ahead: z.number(),
  behind: z.number(),
});
export type GitBranch = z.infer<typeof GitBranch>;
/** xy is the two-letter porcelain code ("??" untracked, "!!" ignored, "." for
 * an unchanged side); origPath is set for renames and copies. */
export const GitStatusEntry = z.object({ xy: z.string(), path: z.string(), origPath: z.string().optional() });
export type GitStatusEntry = z.infer<typeof GitStatusEntry>;
export const GitStatusReply = z.object({ branch: GitBranch, entries: z.array(GitStatusEntry) });
export type GitStatusReply = z.infer<typeof GitStatusReply>;

/** branch: working tree against the merge-base with the default branch;
 * unstaged: working tree against the index; staged: index against HEAD. */
export const GitDiffScope = z.enum(["branch", "unstaged", "staged"]);
export type GitDiffScope = z.infer<typeof GitDiffScope>;
export const GitDiffFile = z.object({ path: z.string(), patch: z.string() });
export type GitDiffFile = z.infer<typeof GitDiffFile>;
/** base is the ref the branch scope diffed against (null for other scopes);
 * truncated means the 2 MiB patch budget cut files or a patch short. */
export const GitDiffReply = z.object({ base: z.string().nullable(), files: z.array(GitDiffFile), truncated: z.boolean() });
export type GitDiffReply = z.infer<typeof GitDiffReply>;

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
  z.object({ id: reqId, op: z.literal("ping") }),
  /** Paths are relative to the daemon's workspace root (HOME unless started
   * with --root) or absolute inside it; anything resolving outside, through
   * .. or a symlink, is refused with code outside-root. gitignore hides
   * entries git would ignore and stops descent into ignored directories. */
  z.object({
    id: reqId,
    op: z.literal("fs.list"),
    path: z.string(),
    depth: z.number().int().min(1).optional(),
    gitignore: z.boolean().optional(),
  }),
  z.object({ id: reqId, op: z.literal("fs.read"), path: z.string(), encoding: FsReadEncoding.optional() }),
  z.object({ id: reqId, op: z.literal("git.status"), cwd: z.string() }),
  z.object({ id: reqId, op: z.literal("git.diff"), cwd: z.string(), scope: GitDiffScope, path: z.string().optional() }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

export const DaemonErrorCode = z.enum([
  "outside-root",
  "not-found",
  "not-a-directory",
  "not-a-file",
  "not-a-git-repo",
  "bad-request",
]);
export type DaemonErrorCode = z.infer<typeof DaemonErrorCode>;

export const DaemonOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
/** code is set by the files and diff ops so clients can branch on the refusal
 * without matching message text; older ops send the message alone. */
export const DaemonErrorResponse = z.object({
  id: reqId.nullable(),
  ok: z.literal(false),
  error: z.string(),
  code: DaemonErrorCode.optional(),
});
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
  z.object({ type: z.literal("port.open"), port: z.number(), pid: z.number().optional(), process: z.string().optional() }),
  z.object({ type: z.literal("port.close"), port: z.number() }),
  z.object({ type: z.literal("inbox.file"), path: z.string(), bytes: z.number() }),
  /** Broadcast on pty.attach (current state) and afterwards only on change.
   * mode mirrors the slave termios ICANON bit ("line" when set), echo mirrors
   * ECHO; foreground is the comm of the foreground process group leader, ""
   * when unreadable. There is no request op: clients only listen. */
  z.object({
    type: z.literal("pty.mode"),
    ptyId: z.string(),
    mode: z.enum(["line", "raw"]),
    echo: z.boolean(),
    foreground: z.string(),
  }),
]);
export type DaemonEvent = z.infer<typeof DaemonEvent>;

// --- runtime wire protocol (serveRuntime) ------------------------------------

export const TicketPurpose = z.enum(["connect"]);
export type TicketPurpose = z.infer<typeof TicketPurpose>;

export const RuntimeRequest = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("auth"), token: z.string() }),
  z.object({ id: reqId, op: z.literal("ticket.issue"), purpose: TicketPurpose }),
  z.object({ id: reqId, op: z.literal("events.subscribe") }),
  /** Replies with a WorkspaceStatus[] snapshot and keeps the runtime's status
   * poller + cost ticker running while this socket lives; the events ride the
   * events.subscribe channel. */
  z.object({ id: reqId, op: z.literal("status.subscribe") }),
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
  /** Replies with a DaemonReachView; the runtime remints the edge token when it nears expiry. */
  z.object({ id: reqId, op: z.literal("workspaces.daemonReach"), workspaceId: z.string() }),
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
  /** Replies with the workspace's persisted SessionEvent[] (oldest first, capped by the runtime). */
  z.object({ id: reqId, op: z.literal("sessions.history"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("golden.get"), name: z.string() }),
  /** Replies with the backend's Capabilities; the UI gates features on these. */
  z.object({ id: reqId, op: z.literal("capabilities.get") }),
  /** Boots a fresh builder for golden `name`; replies with a GoldenBuilderView.
   * Progress rides golden.stage events on the events channel. */
  z.object({ id: reqId, op: z.literal("golden.prepare"), name: z.string(), kind: MachineKind.optional() }),
  /** Snapshots the builder, smoke-tests a fork, appends a manifest version;
   * replies with { manifest, version }. The builder is consumed either way. */
  z.object({ id: reqId, op: z.literal("golden.seal"), builderId: z.string() }),
  /** Replies with { lineage: SnapshotLineage } for golden `name` (default "default"). */
  z.object({ id: reqId, op: z.literal("snapshots.list"), name: z.string().optional() }),
  /** Moves the golden's head to a version already in its manifest; replies with a
   * SnapshotRollbackResult. A version outside the manifest fails with kind "missing". */
  z.object({ id: reqId, op: z.literal("snapshots.rollback"), version: z.number(), name: z.string().optional() }),
  /** Replies with a DaemonReachView for a live builder (the wizard's terminal
   * dials it). Asked per dial like workspaces.daemonReach: the edge token
   * expires hourly and a builder may sit for hours before it is sealed. */
  z.object({ id: reqId, op: z.literal("golden.builderReach"), builderId: z.string() }),
  /** Replies with { reach: PortReachView } for one guest port, cached per port
   * while fresh like workspaces.daemonReach. A port outside the daemon's
   * listening set still mints: the user may have typed it. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.portReach"),
    workspaceId: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
]);
export type RuntimeRequest = z.infer<typeof RuntimeRequest>;

export const RuntimeOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
/** `kind` carries a typed failure when the runtime has one (engine WspError
 * kinds such as "concurrency", or "notFirstLife" from a refused seal). */
export const RuntimeErrorResponse = z.object({
  id: reqId.nullable(),
  ok: z.literal(false),
  error: z.string(),
  kind: z.string().optional(),
});
export const RuntimeResponse = z.union([RuntimeOkResponse, RuntimeErrorResponse]);
export type RuntimeResponse = z.infer<typeof RuntimeResponse>;

// --- snapshot lineage (golden manifest as the rollback UI reads it) -----------

/** Every sealed version of one golden and the head new forks use. head is null
 * while the golden has never been sealed. The manifest is the truth here, never
 * a backend snapshot listing (list() is best-effort). */
export const SnapshotLineage = z.object({
  name: z.string(),
  head: z.number().nullable(),
  versions: z.array(GoldenVersion),
});
export type SnapshotLineage = z.infer<typeof SnapshotLineage>;

/** Rollback only moves head. Workspaces already forked keep their machines and
 * image; the field says so on the wire so no client reads it as a fleet change. */
export const SnapshotRollbackResult = z.object({
  lineage: SnapshotLineage,
  existingWorkspaces: z.literal("untouched"),
});
export type SnapshotRollbackResult = z.infer<typeof SnapshotRollbackResult>;
