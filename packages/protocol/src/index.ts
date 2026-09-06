// The typed contract every client speaks: workspace/session views, the event
// union fanned out by the runtime, and the wire types for both servers (the
// runtime's serveRuntime and the in-VM daemon). The daemon package has no
// exported wire types, so these schemas are their one home; @wsp/daemon's
// handlers are the reference implementation they mirror.

import { z } from "zod";
import { titleLine } from "./format.js";

/** The one rule for a URL a guest may hand to the laptop: http or https in any
 * case, no whitespace or control characters, at most HTTP_URL_MAX bytes, and
 * it parses (so a hostname can always be read from it without throwing). The
 * machine is the untrusted side, so the host and the app apply it too. The
 * daemon carries a copy (it must not bundle this package); a test pins the two
 * equal. */
export const HTTP_URL_RE = /^https?:\/\/[^\s\x00-\x1f\x7f]+$/i;
export const HTTP_URL_MAX = 8192;
/** The most bytes one exec request body may carry, the backend's wrapper included: the provider answers 413 Payload
 * Too Large above 16 KiB (a 17,176 byte launch body was refused on 2026-09-06). Anything larger goes to the guest in
 * more than one exec or through an upload. */
export const EXEC_BODY_MAX = 16 * 1024;
/** How much of a detached command's output one poll exec reads; a full read is followed by another at once. */
export const EXEC_CHUNK_BYTES = 262_144;
/** How long a turn's stream may go without a byte before the runtime cuts it. A turn that is working writes a delta,
 * a tool event or a log line well inside this, so it is the one rule that ends a turn the harness left hanging: a
 * fixed wall clock cut a build that was still working at 15 minutes on 2026-09-06. */
export const TURN_IDLE_MS = 10 * 60_000;
/** The longest one turn may run however much it prints, a safety cap only; a per-workspace setting is a follow-up. */
export const TURN_WALL_MS = 6 * 60 * 60_000;
export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > HTTP_URL_MAX || !HTTP_URL_RE.test(url)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** The host of a URL that passed isHttpUrl (with its port, without userinfo), or undefined when it does not parse: never throws. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** A callback port the laptop can bind without root; the host refuses anything else before it listens. */
export const RelayPort = z.number().int().min(1024).max(65535);

/** A guest port the host forwards to this computer's loopback (localhost:<port>
 * here reaches the workspace's listener). The host holds them; the app lists
 * them and stops them. name is what the app shows: the workspace's, or the
 * builder's, since a builder's forwards carry the builder id. kind says why the
 * port is open: url, a link the workspace printed, which the app offers to
 * open; callback, a sign-in flow's redirect, which the app names and never
 * dials (a bare request would end the flow). */
export const PortForward = z.object({ workspaceId: z.string(), port: RelayPort, startedAt: z.string(), name: z.string(), kind: z.enum(["url", "callback"]) });
export type PortForward = z.infer<typeof PortForward>;

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
  /** A daemon link exists, so sign-in URLs a guest tool opens land in the laptop's browser and the
   * callback port is forwarded back; false means the person finishes sign-ins by copy and paste. */
  callbackRelay: z.boolean(),
  /** The provider lists every snapshot on the account with its size, so storage can be counted and priced. */
  snapshotListing: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

// --- views -----------------------------------------------------------------

/** pausing: the runtime is stashing the vault and asking the provider to pause; a send is refused from here on.
 * gone: the provider no longer knows the machine (deleted behind wsp, or expired); nothing bills and nothing
 * runs until a rebuild puts a fresh fork under the record or the workspace is deleted. */
export const WorkspacePhase = z.enum(["running", "pausing", "napping", "waking", "gone"]);
export type WorkspacePhase = z.infer<typeof WorkspacePhase>;

/** Backend vocabulary: a napping workspace's machine reads "paused" here.
 * Phase is the product word, machine state the provider word; clients render
 * phase and use machineState only for divergence (starting, gone). */
export const MachineState = z.enum(["starting", "running", "paused", "gone"]);
export type MachineState = z.infer<typeof MachineState>;

/** slow: the edge answered late or 502'd while the machine runs (a provider slow
 * spell, measured: 502 after 5 to 11 s with an open socket to the same guest
 * still working); it is not no-daemon (a prompt 502) and not unreachable (silence).
 * zombie: the provider reports the machine running, reach has been slow or
 * unreachable for minutes, and a bounded exec probe failed too; the guest is
 * dead behind a live control plane (measured twice at rest). Phase stays
 * running; status.reason carries the timings; workspaces.rebuild is the way out. */
export const ReachState = z.enum(["reachable", "no-daemon", "unreachable", "napping", "unsupported", "gone", "slow", "zombie"]);
export type ReachState = z.infer<typeof ReachState>;

export const ReachStatus = z.object({
  state: ReachState,
  url: z.string().optional(),
  expiresAt: z.number().optional(),
});
export type ReachStatus = z.infer<typeof ReachStatus>;

/** What a browser needs to dial a workspace's daemon: the minted preview route
 * (edge token embedded, hourly expiry) and the daemon token the host minted at
 * start and wrote to the guest, sent as the socket's first frame, never in the
 * URL. No daemonToken means no daemon on that machine. */
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

/** What the host saw fetching a guest port's route once, as a browser's frame
 * does: the status and the start of the body. A frame on another origin can
 * read neither, so the pane asks for this to explain a refusal (a dev server's
 * host check, the edge) instead of showing a white page. */
export const PortProbeView = z.object({ status: z.number().int(), body: z.string() });
export type PortProbeView = z.infer<typeof PortProbeView>;

export const WorkspaceSize = z.object({ cpu: z.number(), memMb: z.number() });
export type WorkspaceSize = z.infer<typeof WorkspaceSize>;

/** The project a workspace holds: the folder the bundle landed at, named by its last segment, and when the bundle
 * landed. Set by an import, inherited by every fork of a project golden. */
export const WorkspaceProject = z.object({ name: z.string(), dest: z.string(), importedAt: z.string() });
export type WorkspaceProject = z.infer<typeof WorkspaceProject>;

export const WorkspaceView = z.object({
  id: z.string(),
  name: z.string(),
  machineId: z.string(),
  phase: WorkspacePhase,
  /** Snapshot id of the image this workspace forks from: a golden version's, or a project golden's. */
  golden: z.string(),
  createdAt: z.string(),
  project: WorkspaceProject.optional(),
  /** Claude session id of the last session, so the next send can --resume it. */
  claudeSessionId: z.string().optional(),
  /** Present when the machine streams a display (desktop kind); sandbox machines are headless. */
  screen: z.object({ streamUrl: z.string() }).optional(),
  /** With phase gone: the provider's words when it stopped knowing the machine; every refusal quotes them. */
  gone: z.string().optional(),
  /** One line for the machine's row while the runtime is doing something to the machine's daemon, or why the last
   * attempt failed; absent whenever there is nothing to say. Not persisted: it says what this process is doing. */
  daemonNote: z.string().optional(),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

/** WorkspaceView enriched with what the rail and meta panel render live. */
export const WorkspaceStatus = WorkspaceView.extend({
  machineState: MachineState,
  reach: ReachStatus,
  size: WorkspaceSize,
  /** Awake burn rate for this size; 0 never appears here (napping costs ride the cost event). */
  rateUsdPerHour: z.number(),
  /** Why the runtime pushed this status outside the poll: a wake that had to retry or replace the machine, or "idle 20 min". */
  reason: z.string().optional(),
  /** Epoch ms when the runtime's idle policy naps this workspace; absent while napping, held by a running session, or with auto-nap off. */
  idleAt: z.number().optional(),
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

export const SessionStatus = z.enum(["running", "completed", "interrupted", "failed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Who asked the runtime for the turn: a person in the app, the command line on this computer, or a local agent
 * through the MCP server. All are clients of one host; the sidebar shows which one opened a thread. */
export const SessionOrigin = z.enum(["person", "cli", "agent"]);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

export const SessionView = z.object({
  id: z.string(),
  workspaceId: z.string(),
  harness: z.string(),
  status: SessionStatus,
  /** Who opened the thread this row belongs to: a resumed turn takes over the row of the turn it resumes and keeps
   * its answer. Absent on rows written before provenance was recorded; foldThreads reads those as a person's. */
  startedBy: SessionOrigin.optional(),
  claudeSessionId: z.string().optional(),
  /** The thread this turn belongs to, as the runtime stamps its events; rows sharing one are one sidebar thread. */
  threadId: z.string().optional(),
  /** The turn that opened this row's thread; a resumed turn keeps it, and its own prompt rides its session.start
   * event, so the title every client derives from a row never follows the latest send. */
  prompt: z.string().optional(),
  /** Ms epoch, runtime clock; endedAt is unset while the session runs. */
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** The folder the harness runs in: the start request's until the harness announces its own. A resume of this
   * session runs here whatever folder it asks for, since the CLI keys the session to it; the shell folder the
   * agent's tool calls move rides the delta events instead. */
  cwd: z.string().optional(),
  /** What the session runs with, as the harness's own slugs: the start request's model until the harness announces
   * its own; effort and permission mode as requested, since the CLI never echoes them. */
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  contextWindow: z.string().optional(),
});
export type SessionView = z.infer<typeof SessionView>;

/** One sidebar thread as every client lists it: the turns sharing a threadId (a row stamped none is its own),
 * titled by the opening turn, in the state and times of the latest, with the opening turn's provenance, always
 * filled in. id is the fold key, the runtime's thread id or the lone row's id; sessionId is the latest turn's row
 * id, what a stop interrupts; claudeSessionId is the latest turn's harness id, what a send resumes. */
export const ThreadView = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  workspaceId: z.string(),
  harness: z.string(),
  startedBy: SessionOrigin,
  status: SessionStatus,
  title: z.string(),
  sessionId: z.string(),
  claudeSessionId: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** The folder the latest turn's harness runs in, as SessionView.cwd; absent when no turn recorded one. */
  cwd: z.string().optional(),
  turns: z.number().int().positive(),
});
export type ThreadView = z.infer<typeof ThreadView>;

/** Folds the session index into threads, in the order each thread's first turn appears. The one place a row from
 * before provenance was recorded is read as a person's; clients print the answer and never decide it. */
export function foldThreads(sessions: ReadonlyArray<SessionView>): ThreadView[] {
  const byThread = new Map<string, SessionView[]>();
  for (const session of sessions) {
    const key = session.threadId ?? session.id;
    const turns = byThread.get(key);
    if (turns === undefined) byThread.set(key, [session]);
    else turns.push(session);
  }
  return [...byThread].map(([id, turns]) => {
    const first = turns[0]!;
    const latest = turns[turns.length - 1]!;
    return {
      id,
      ...(first.threadId !== undefined ? { threadId: first.threadId } : {}),
      workspaceId: first.workspaceId,
      harness: first.harness,
      startedBy: first.startedBy ?? "person",
      status: latest.status,
      title: first.prompt !== undefined ? titleLine(first.prompt) : first.claudeSessionId ?? first.id,
      sessionId: latest.id,
      ...(latest.claudeSessionId !== undefined ? { claudeSessionId: latest.claudeSessionId } : {}),
      ...(latest.startedAt !== undefined ? { startedAt: latest.startedAt } : {}),
      ...(latest.endedAt !== undefined ? { endedAt: latest.endedAt } : {}),
      ...(latest.cwd !== undefined ? { cwd: latest.cwd } : {}),
      turns: turns.length,
    };
  });
}

// --- harness catalog (what the composer's pickers may offer) -------------------

/** One value a harness's CLI accepts for a picker, as the CLI spells it; the label is what the picker shows. */
export const HarnessOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
});
export type HarnessOption = z.infer<typeof HarnessOption>;

/** A model, with the subset of the catalog's efforts and context windows it takes; a list absent means all of them,
 * empty means the model takes none and the composer hides that section for it. */
export const HarnessModel = HarnessOption.extend({
  efforts: z.array(z.string()).optional(),
  contextWindows: z.array(z.string()).optional(),
});
export type HarnessModel = z.infer<typeof HarnessModel>;

export const HarnessCatalogSource = z.enum(["harness", "table"]);
export type HarnessCatalogSource = z.infer<typeof HarnessCatalogSource>;

/** What one harness's CLI takes at launch. A list is empty when the CLI has no such flag or its values are open,
 * and the composer hides that picker; sessions.start refuses a value a non-empty list does not carry and passes any
 * value through where the list is empty. source says whether the binary on the workspace's machine answered or the
 * runtime's table stood in, and version is the binary's, else the table's pin. */
export const HarnessCatalog = z.object({
  harness: z.string(),
  label: z.string(),
  source: HarnessCatalogSource,
  version: z.string().nullable(),
  models: z.array(HarnessModel),
  efforts: z.array(HarnessOption),
  contextWindows: z.array(HarnessOption),
  permissionModes: z.array(HarnessOption),
  /** Whether a running turn of this harness takes a message (sessions.steer); false where the runtime's table alone
   * answers, since only the adapter on a machine knows. The composer picks send-now's road from this before the click. */
  steers: z.boolean(),
  /** Set on the harness a start without one runs, so a client can pick its list without the catalog package. */
  isDefault: z.boolean().optional(),
});
export type HarnessCatalog = z.infer<typeof HarnessCatalog>;

/** The option a list marks as its default, if one is: what an unpicked picker shows and an unnamed start runs. */
export function markedDefault<T extends HarnessOption>(options: ReadonlyArray<T>): T | undefined {
  return options.find(o => o.isDefault === true);
}

function narrowed(all: ReadonlyArray<HarnessOption>, subset: ReadonlyArray<string> | undefined): HarnessOption[] {
  return subset === undefined ? [...all] : all.filter(o => subset.includes(o.value));
}

/** The efforts a model takes: its own subset of the catalog's, in the catalog's order, else all of them. */
export function effortsFor(catalog: HarnessCatalog, model: HarnessModel | null): HarnessOption[] {
  return narrowed(catalog.efforts, model?.efforts);
}

/** None without a model: the window rides the model as a suffix, so there is nothing to offer it on. */
export function contextWindowsFor(catalog: HarnessCatalog, model: HarnessModel | null): HarnessOption[] {
  return model === null ? [] : narrowed(catalog.contextWindows, model.contextWindows);
}

/** The picks a start names, as sessions.start carries them. */
export interface StartPicks {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

const optionWords = (options: ReadonlyArray<HarnessOption>): string => options.map(o => `${o.label} (${o.value})`).join(", ");

function listed(subject: string, word: string, options: ReadonlyArray<HarnessOption>, value: string | undefined): void {
  if (value === undefined || options.some(o => o.value === value)) return;
  throw new Error(options.length === 0 ? `${subject} takes no ${word}` : `${word} "${value}" is not one ${subject} takes; one of: ${optionWords(options)}`);
}

function checkedAgainst(catalog: HarnessCatalog, picks: StartPicks, model: string | undefined): void {
  if (catalog.models.length > 0) listed(catalog.harness, "model", catalog.models, picks.model);
  const chosen = model === undefined ? null : catalog.models.find(m => m.value === model) ?? { value: model, label: model };
  if (catalog.efforts.length > 0) listed(chosen?.efforts !== undefined ? chosen.label : catalog.harness, "effort", effortsFor(catalog, chosen), picks.effort);
  if (catalog.permissionModes.length > 0) listed(catalog.harness, "access mode", catalog.permissionModes, picks.permissionMode);
}

/** The picks a start runs with, checked against the catalog: a value a list does not carry is refused naming the
 * list in the composer's words, and a list the CLI leaves empty (no such flag, or open values) takes any value. A
 * start that opens a thread without a model runs the one the catalog marks default, so every door runs what the
 * composer shows; a resume keeps the thread's own model. Without a catalog (a harness the runtime has no table row
 * for) every value passes and no default is filled. Only the three picks come out, whatever else rides in. */
export function startPicks(catalog: HarnessCatalog | undefined, picks: StartPicks, opensThread: boolean): StartPicks {
  const model = picks.model ?? (opensThread && catalog !== undefined ? markedDefault(catalog.models)?.value : undefined);
  if (catalog !== undefined) checkedAgainst(catalog, picks, model);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(picks.effort !== undefined ? { effort: picks.effort } : {}),
    ...(picks.permissionMode !== undefined ? { permissionMode: picks.permissionMode } : {}),
  };
}

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
  /** Minted by the runtime at a start without resume and kept by every start that resumes into it, so a
   * transcript folds into threads where it changes. Absent on transcripts from before it: those are one thread. */
  threadId: z.string().optional(),
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
  /** The id the client minted for the sessions.start that opened this turn, stamped by the runtime; absent when the
   * client sent none. Two clients sending the same text at the same moment are told apart by this, not the prompt. */
  requestId: z.string().optional(),
  /** Set when the thread's previous turn ended with no exit code and no result (a deadline, a host restart, a nap
   * that ended it), so clients say the harness resumes a transcript that may be missing context; absent otherwise. */
  afterCut: z.literal(true).optional(),
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
  /** The agent's tool shell folder after this tool_use, present only when the call moved it (a cd, or a file written
   * in a folder beside the one followed so far); the panes follow it while the harness folder stays put. */
  cwd: z.string().optional(),
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
  /** Set when the runtime ended the session itself (a nap, a delete, a machine that stopped answering) rather than the harness exiting. */
  reason: z.string().optional(),
});

/** A message the person sent into the turn while it ran; stamped by the runtime once the harness took it, so a
 * replayed transcript shows it where the turn saw it. No session.start comes with it: the turn is the same one. */
export const SessionSteerEvent = z.object({
  type: z.literal("session.steer"),
  ...sessionScope,
  prompt: z.string(),
  /** The id the client minted for the sessions.steer, as on session.start. */
  requestId: z.string().optional(),
});

/** Pushed once when a start finds the thread's turn running and a harness that takes no message mid-turn, so the
 * caller can say it is waiting before the start's reply comes; not a session event, never in history. */
export const SessionQueuedEvent = z.object({
  type: z.literal("session.queued"),
  workspaceId: z.string(),
  threadId: z.string(),
  prompt: z.string(),
  /** The id the client minted for the sessions.start that waits. */
  requestId: z.string().optional(),
});
export type SessionQueuedEvent = z.infer<typeof SessionQueuedEvent>;

/** The word a start's notify carries to mean the person who ran it, not a thread. */
export const NOTIFY_ME = "me";

/** The turn ended and its one line (notifyLine) went where the thread's start said: into the named thread as a send
 * would go, steered or queued, or, for me, to the person, whom the CLI and the app tell from this event. Recorded in
 * the ending thread's transcript, before its session.done, so the line's source is visible and a follower that ends
 * on the done still sees it. */
export const SessionNotifyEvent = z.object({
  type: z.literal("session.notify"),
  ...sessionScope,
  /** The thread the line went to, or NOTIFY_ME. */
  notify: z.string(),
  text: z.string(),
});
export type SessionNotifyEvent = z.infer<typeof SessionNotifyEvent>;

/** The events sessions.history replays: what a chat transcript folds. */
export const SessionEvent = z.discriminatedUnion("type", [SessionStartEvent, SessionDeltaEvent, SessionDoneEvent, SessionEndEvent, SessionSteerEvent, SessionNotifyEvent]);
export type SessionEvent = z.infer<typeof SessionEvent>;

// --- workspace / port / inbox events ----------------------------------------

export const WorkspaceCreatedEvent = z.object({ type: z.literal("workspace.created"), workspace: WorkspaceView });
/** The awaited steps of a create in the order the runtime reaches them; `failed` ends a create that threw. */
export const WorkspaceCreateStage = z.enum(["fork-requested", "machine-booting", "hostname-set", "preview-route", "daemon-answering", "ready", "failed"]);
export type WorkspaceCreateStage = z.infer<typeof WorkspaceCreateStage>;
/** Progress of one create, from the first request to ready or failed: the id the workspace will carry, its name, one
 * plain sentence per stage, the time since the create began, and a notice when a step did something worth reading
 * (a kept builder was stopped to make room at the machine cap). */
export const WorkspaceCreatingEvent = z.object({
  type: z.literal("workspace.creating"),
  workspaceId: z.string(),
  name: z.string(),
  stage: WorkspaceCreateStage,
  message: z.string(),
  elapsedMs: z.number(),
  notice: z.string().optional(),
});
export type WorkspaceCreatingEvent = z.infer<typeof WorkspaceCreatingEvent>;
/** found is set when the provider had already paused the machine and this host only followed it: the awake
 * stretch ended at the last instant the meter saw the machine awake, not at this event. */
export const WorkspaceNappedEvent = z.object({ type: z.literal("workspace.napped"), workspaceId: z.string(), found: z.boolean().optional() });
export const WorkspaceWokenEvent = z.object({
  type: z.literal("workspace.woken"),
  workspaceId: z.string(),
  machineId: z.string(),
  /** True when the paused machine had vanished and a fresh golden fork replaced it. */
  resurrected: z.boolean(),
});
/** The machine was replaced by a fresh golden fork carrying the vault: an
 * upgrade under a new size, or a rebuild of a zombie. Clients re-dial reach. */
export const WorkspaceUpgradedEvent = z.object({
  type: z.literal("workspace.upgraded"),
  workspaceId: z.string(),
  machineId: z.string(),
});
export const WorkspaceDeletedEvent = z.object({ type: z.literal("workspace.deleted"), workspaceId: z.string() });
/** The provider stopped knowing the machine: the workspace's phase is gone from here until a rebuild or a delete.
 * Sessions on it ended, the rate is 0, the idle window is dropped; reason carries the provider's words. */
export const WorkspaceGoneEvent = z.object({
  type: z.literal("workspace.gone"),
  workspaceId: z.string(),
  machineId: z.string(),
  reason: z.string(),
});

export const WorkspaceStatusEvent = z.object({ type: z.literal("workspace.status"), status: WorkspaceStatus });

/** Awake-time cost tick. Computed locally from size and elapsed running time
 * (provider billing API integration is a later plan); zero rate while napping. */
export const WorkspaceCostEvent = z.object({
  type: z.literal("workspace.cost"),
  workspaceId: z.string(),
  phase: WorkspacePhase,
  /** Current burn: the size's awake rate while running, 0 while napping. */
  rateUsdPerHour: z.number(),
  /** Total awake milliseconds behind accruedUsd since metering began; carried across host restarts. */
  awakeMs: z.number(),
  accruedUsd: z.number(),
  at: z.string(),
});
export type WorkspaceCostEvent = z.infer<typeof WorkspaceCostEvent>;

export const PortOpenEvent = z.object({
  type: z.literal("port.open"),
  workspaceId: z.string(),
  port: z.number(),
  pid: z.number().optional(),
  /** The listener's /proc/<pid>/comm; absent when the pid or its comm is unreadable. */
  process: z.string().optional(),
});
/** Who held the port when it closed, from the watcher's last row for it; at is the daemon's clock. */
const portCloseDetail = {
  pid: z.number().optional(),
  process: z.string().optional(),
  /** The holder's argv joined by spaces, from /proc/<pid>/cmdline; the daemon reads at most 512 bytes of it and a cut argv ends with an ellipsis. */
  command: z.string().optional(),
  /** Whether the holder's pid was gone when the close was seen; absent without a pid. */
  exited: z.boolean().optional(),
  at: z.string().optional(),
};
export const PortCloseEvent = z.object({ type: z.literal("port.close"), workspaceId: z.string(), port: z.number(), ...portCloseDetail });
export const InboxFileEvent = z.object({
  type: z.literal("inbox.file"),
  workspaceId: z.string(),
  path: z.string(),
  bytes: z.number(),
});

// --- project bundle: a folder on this computer landed on a workspace -----------

/** How the collector's credential pass decided a file is secret-shaped: by name, by owner-only mode, by the key
 * names in it, by a PEM header, by a URL with a password in it, by a gitleaks hit, by the catalog, by secret-shaped
 * exports, or by git history. */
export const CredentialSignal = z.enum(["name", "mode", "keys", "pem", "url", "gitleaks", "catalog", "exports", "history"]);
export type CredentialSignal = z.infer<typeof CredentialSignal>;
/** How a repository config lands when its rewrite is accepted: `urls` as they then read, their userinfo removed,
 * and `drop` the config keys (http.extraheader carrying an Authorization header) whose lines are left out. */
export const ProjectRewrite = z.object({ urls: z.array(z.string()), drop: z.array(z.string()) });
export type ProjectRewrite = z.infer<typeof ProjectRewrite>;
/** A secret-shaped file in the folder, by path relative to it; it travels only when the import names it in carry,
 * or in rewrite when `rewrite` is offered: then it lands rewritten as described, and the machine's own login (gh's)
 * is the credential there. Offered only when the rewrite removes every secret shape the file has. */
export const ProjectSecret = z.object({ path: z.string(), bytes: z.number(), signals: z.array(CredentialSignal), rewrite: ProjectRewrite.optional() });
export type ProjectSecret = z.infer<typeof ProjectSecret>;
/** How an agent's state for the folder travels by file: `moves` when the files carry every key and the resolver
 * re-keys them to the new path so the agent resumes there, `transcript-only` when the rows in a shared store that
 * hold or find the sessions stay behind and only the files travel, if there are any. */
export const ProjectCarry = z.enum(["moves", "transcript-only"]);
export type ProjectCarry = z.infer<typeof ProjectCarry>;
/** One agent whose home on this computer holds sessions for the folder, by catalog id: the count, the bytes of the
 * state files that would travel and the carry answer. An agent whose store could not be read keeps its row with
 * `error` saying why and zero sessions; it never travels. */
export const ProjectAgent = z.object({ agent: z.string(), name: z.string(), sessions: z.number(), bytes: z.number(), carry: ProjectCarry, error: z.string().optional() });
export type ProjectAgent = z.infer<typeof ProjectAgent>;
/** What a project import would carry, for the person to read before anything is packed: the files and their bytes,
 * the secret-shaped ones, the caches left behind (relative paths), the paths named but not carried, with why, and the
 * agents with sessions for the folder. */
export const ProjectPlan = z.object({
  /** The folder on this computer, absolute. */
  source: z.string(),
  /** Whether the folder has a .git; the repository travels whole when it does. */
  repo: z.boolean(),
  /** Regular files that would travel, the secret-shaped ones counted. */
  files: z.number(),
  bytes: z.number(),
  secrets: z.array(ProjectSecret),
  excluded: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), note: z.string() })),
  agents: z.array(ProjectAgent),
});
export type ProjectPlan = z.infer<typeof ProjectPlan>;
/** The steps of one import in order; `failed` ends one that threw. */
export const ProjectImportStage = z.enum(["planned", "consented", "packing", "uploading", "landing", "done", "failed"]);
export type ProjectImportStage = z.infer<typeof ProjectImportStage>;
/** Progress of one import: one plain sentence per stage, the time since it began, and on uploading the bytes sent so
 * far of the archive's total. */
export const ProjectImportEvent = z.object({
  type: z.literal("project.import"),
  workspaceId: z.string(),
  source: z.string(),
  dest: z.string(),
  stage: ProjectImportStage,
  message: z.string(),
  elapsedMs: z.number(),
  bytes: z.number().optional(),
  total: z.number().optional(),
});
export type ProjectImportEvent = z.infer<typeof ProjectImportEvent>;
/** What became of one agent the import named: `moved` when the agent is on the machine and its module re-keyed every
 * file to dest, or merged its rows into its store there; `transcript-only` when it is on the machine but only its
 * files landed and the rows in its shared store that list them are still to come; `carried` when it is not there so
 * the files landed as they were, `nothing` when no file of its travelled, `failed` when the move raised and nothing of
 * that agent landed, or the merge on the machine failed after its files did; files and bytes are what landed. */
export const ProjectAgentOutcome = z.enum(["moved", "transcript-only", "carried", "nothing", "failed"]);
export type ProjectAgentOutcome = z.infer<typeof ProjectAgentOutcome>;
/** `sessions` is how many the files hold when the trip counted them; `skipped` is how many sessions the agent's own
 * index named whose transcript was not under its home (Codex keeps archived ones elsewhere), so their rows moved
 * and nothing else did. `rows` is what the merge on the machine inserted or updated in the agent's store, once it
 * ran; `note` says why the rows still wait when they could not be merged yet (the agent has not made its store
 * there), or what the merge kept as the machine had it rather than as carried. */
export const ProjectAgentResult = z.object({
  agent: z.string(),
  files: z.number(),
  bytes: z.number(),
  outcome: ProjectAgentOutcome,
  sessions: z.number().optional(),
  skipped: z.number().optional(),
  error: z.string().optional(),
  rows: z.number().optional(),
  note: z.string().optional(),
});
export type ProjectAgentResult = z.infer<typeof ProjectAgentResult>;
/** What landed: the path on the machine, the files and bytes extracted there, the upload parts, the secret-shaped
 * paths that were cut because the import did not name them, the ones that landed rewritten as the plan offered, and
 * each named agent's outcome. */
export const ProjectImportResult = z.object({ dest: z.string(), files: z.number(), bytes: z.number(), parts: z.number(), cut: z.array(z.string()), rewritten: z.array(z.string()), agents: z.array(ProjectAgentResult) });
export type ProjectImportResult = z.infer<typeof ProjectImportResult>;
/** The steps of one export in order; `failed` ends one that threw. */
export const ProjectExportStage = z.enum(["packing", "downloading", "landing", "done", "failed"]);
export type ProjectExportStage = z.infer<typeof ProjectExportStage>;
/** Progress of one export, the bundle's trip home: one plain sentence per stage, the time since it began, and on
 * downloading the bytes received so far of the archive's total. `source` is the folder on the machine, `dest` where
 * it lands on this computer. */
export const ProjectExportEvent = z.object({
  type: z.literal("project.export"),
  workspaceId: z.string(),
  source: z.string(),
  dest: z.string(),
  stage: ProjectExportStage,
  message: z.string(),
  elapsedMs: z.number(),
  bytes: z.number().optional(),
  total: z.number().optional(),
});
export type ProjectExportEvent = z.infer<typeof ProjectExportEvent>;
/** What came home: the folder on this computer, the files and bytes landed there, the cache roots left behind on
 * the machine (relative paths), and each agent whose state for the folder was found on the machine with what became
 * of it here: `moved` when its module keyed every file to dest, `transcript-only` when the files landed but the rows
 * in its shared store here do not list them yet, `nothing` when it had no file to bring, `failed` with the reason. */
export const ProjectExportResult = z.object({ dest: z.string(), files: z.number(), bytes: z.number(), excluded: z.array(z.string()), agents: z.array(ProjectAgentResult) });
export type ProjectExportResult = z.infer<typeof ProjectExportResult>;

// --- desktop shell bridge (preload to page) -----------------------------------

/** One installed font file the desktop shell hands the page for its terminal, registered under the family the file names. */
export interface LocalFontFace {
  family: string;
  weight: 400 | 700;
  style: "normal" | "italic";
  data: ArrayBuffer;
}

/** What the host writes into the page's one inline script as window.__WSP__ before serving it. */
export interface BootPayload {
  wsPort: number;
  token: string;
  /** The family the person's terminal draws with, when the saved recipe ticks its row; the terminal pane defaults to it. */
  terminalFont?: string;
}

/** What the desktop shell's preload puts on window.wsp; a browser tab has none of it. */
export interface DesktopBridge {
  /** The installed faces for a family and its Nerd Font variants, from this computer's font directories. */
  localFonts(family: string): Promise<LocalFontFace[]>;
  /** The system folder picker; the absolute path chosen, or nothing when it was dismissed. */
  pickFolder(): Promise<string | undefined>;
}

// --- golden image (manifest, interactive builder, build stages) ---------------

export const MachineKind = z.enum(["sandbox", "desktop"]);
export type MachineKind = z.infer<typeof MachineKind>;

/** What each login came to by the time the golden sealed: a sign-in on the machine, or a copy from this computer
 * checked there with the tool's status command. `copied` is a copy nothing checked: an update re-imported it, or the
 * tool has no status command or is not on the machine. */
export const LoginState = z.enum(["signed-in", "not-signed-in", "not-verified", "skipped", "copied"]);
export type LoginState = z.infer<typeof LoginState>;
export const GoldenLogin = z.object({ name: z.string(), state: LoginState });
export type GoldenLogin = z.infer<typeof GoldenLogin>;
/** A tool the builder's import did not put on the image: set aside at plan or install time, or failed to install,
 * with the reason it gave. Forks of the version are missing it. `id` is the recipe row's, the key the machine's own
 * record of what did not install is kept by. */
export const GoldenMissingTool = z.object({ id: z.string(), name: z.string(), outcome: z.enum(["skipped", "failed"]), note: z.string() });
export type GoldenMissingTool = z.infer<typeof GoldenMissingTool>;
/** One base tool's command with the version read on the builder after the base stage. */
export const GoldenBaseTool = z.object({ name: z.string(), version: z.string() });
export type GoldenBaseTool = z.infer<typeof GoldenBaseTool>;

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
  /** The browser shim was on the machine when it was sealed, so its forks can be told BROWSER; versions sealed before it existed have no flag and get none. */
  browserShim: z.boolean().optional(),
  /** The sign-ins the builder was asked for and how each ended, so the app can say what a fork carries. */
  logins: z.array(GoldenLogin).optional(),
  /** Every tool the import skipped or failed to install, by name with the cause and reason, so a workspace can say why
   * one is missing; absent when every tool installed or the version was sealed before this was recorded. */
  missingTools: z.array(GoldenMissingTool).optional(),
  /** The snapshot the builder that sealed this version descends from: an update's head. Absent on a version built
   * from a fresh machine, and on versions sealed before this was recorded. */
  parentSnapshotId: z.string().optional(),
  /** Every base tool's command with the version read after the base stage on the builder this version descends from.
   * Absent on a version sealed before the base tools existed; its forks never ran them, so an update is refused. */
  base: z.array(GoldenBaseTool).optional(),
});
export type GoldenVersion = z.infer<typeof GoldenVersion>;

export const GoldenManifest = z.object({ head: z.number(), versions: z.array(GoldenVersion) });
export type GoldenManifest = z.infer<typeof GoldenManifest>;

/** The sealed version a manifest's head names, or nothing: a manifest without one has no golden to serve or fork. */
export function goldenHead(manifest: GoldenManifest | undefined): GoldenVersion | undefined {
  return manifest?.versions.find(v => v.version === manifest.head);
}

/** What a golden is built from, as its builder records it: every ticked row
 * with its login answer and tool pin, and every planned path with a digest of
 * the bytes that travel. Two recipes with equal digests build the same golden;
 * the hash a builder carries is this object's, so a later run can say what
 * changed instead of only that something did. */
export const RecipeDigest = z.object({
  ticks: z.array(z.object({ id: z.string(), choice: z.string().optional(), version: z.string().optional() })),
  /** The computer's login shell by name, when a shell row is ticked: it decides which shell the machine logs into. */
  login: z.string().optional(),
  /** A volatile entry (its tool rewrites it, or it is a Keychain value the machine gets rendered) is recorded but never hashed. */
  files: z.array(z.object({ id: z.string(), path: z.string(), dest: z.string(), digest: z.string(), volatile: z.boolean().optional() })),
});
export type RecipeDigest = z.infer<typeof RecipeDigest>;

/** Where a recipe row's tick comes from: the entry is on this computer (what was found: its config paths and
 * whether its command is on PATH), the agents' session histories on this computer used it (in how many sessions,
 * how many calls), or nothing local says anything and the catalog's own evidence decides. */
export const RecipeSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("installed"), paths: z.array(z.string()), bin: z.boolean() }),
  z.object({ kind: z.literal("used"), sessions: z.number().int().nonnegative(), calls: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("popular"), sessions: z.number().int().nonnegative(), images: z.number().int().nonnegative() }),
]);
export type RecipeSource = z.infer<typeof RecipeSource>;

/** One catalog entry in a recipe: ticked or not, why, its size on the machine when the catalog measured one, and
 * the sign-in answer the person or the agent that wrote the recipe gave; absent, the wizard's default stands. */
export const RecipeRow = z.object({
  id: z.string().min(1),
  kind: z.enum(["agent", "tool"]),
  on: z.boolean(),
  source: RecipeSource,
  size: z.number().int().nonnegative().optional(),
  signIn: z.enum(["copy", "machine", "skip"]).optional(),
});
export type RecipeRow = z.infer<typeof RecipeRow>;

/** What one agent's session history on this computer gave: read with these counts, empty, there but unreadable, or
 * no reader for its format yet. Names and counts only; nothing a session held travels. */
export const RecipeHistory = z.object({
  agent: z.string().min(1),
  state: z.enum(["read", "empty", "unreadable", "no-reader"]),
  sessions: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
});
export type RecipeHistory = z.infer<typeof RecipeHistory>;

/** The small recipe: catalog ids with a tick each and the source of that tick, written by wsp recipe from this
 * computer (or by hand, or by a local agent), read by wsp init --recipe, the app's pick screen and the import
 * of a project. It names catalog entries only and never carries a path's content or a key. */
export const Recipe = z.object({
  version: z.literal(1),
  /** When it was written, ISO 8601. */
  at: z.string().min(1),
  histories: z.array(RecipeHistory),
  rows: z.array(RecipeRow),
});
export type Recipe = z.infer<typeof Recipe>;

/** The live machine a person sets up before sealing it as a golden. It is not
 * a workspace and never appears in the rail; `screen` is present when the
 * machine streams a display (desktop kind). */
export const GoldenBuilderView = z.object({
  id: z.string(),
  name: z.string(),
  kind: MachineKind,
  createdAt: z.string(),
  /** What the provider built, so a builder left running can be priced. */
  size: z.object({ cpu: z.number(), memMb: z.number() }),
  screen: z.object({ streamUrl: z.string() }).optional(),
  /** True while the machine has never been paused, resumed or restored, so it can still be sealed. */
  firstLife: z.boolean().optional(),
  /** The recipe this builder carries; a prepare with the same hash attaches to it instead of booting. */
  recipeHash: z.string().optional(),
  /** The parts behind recipeHash; absent on a builder recorded without them. */
  recipe: RecipeDigest.optional(),
  /** The owner label on the machine when it names another state file; absent when it is this one's or the provider reports none. */
  foreignOwner: z.string().optional(),
  /** The other live wsp process using this builder, when there is one; such a builder is listed and left alone. */
  heldBy: z.object({ host: z.string(), pid: z.number(), heartbeat: z.string() }).optional(),
  /** True while its stages still run in the process that holds it; left this way by a dead process, it can never seal. */
  building: z.boolean().optional(),
  /** Set once the builder was saved as this golden version and kept running for a short window, so one more
   * change re-snapshots it instead of forking; the sweep stops it when the window ends. */
  sealed: z.object({ at: z.string(), version: z.number() }).optional(),
});
export type GoldenBuilderView = z.infer<typeof GoldenBuilderView>;

export const GoldenStage = z.enum([
  "creating",
  "deploying-daemon",
  "applying-setup",
  "uploading-files",
  "installing-harness",
  "installing-tools",
  "installing-mcp",
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
/** The detail a golden.stage frame carries for a step the builder already holds; a reader closes the step at once and charges it no time. */
export const ALREADY_APPLIED = "already applied";
/** Recipe rows under the agents rung that are MCP servers, not agents: `agents/mcp/<agent>/<name>`. The collector writes them, the engine's import reads them. */
export const MCP_ID_PREFIX = "agents/mcp/";

/** Where the event sits in its runtime's stream: one counter per runtime process, monotonic from 1, so a client that
 * lost its socket can ask events.subscribe for everything after the last one it saw. Absent on events from an older
 * runtime and on sessions.history replies, which a client reads whole. */
const sequenced = { seq: z.number().int().positive().optional() };

/** The host opened or closed a forward; the runtime relays these to the app's socket and emits none itself. */
export const ForwardOpenEvent = z.object({ type: z.literal("forward.open"), forward: PortForward });
export const ForwardCloseEvent = z.object({ type: z.literal("forward.close"), workspaceId: z.string(), port: RelayPort });
export type ForwardEvent = z.infer<typeof ForwardOpenEvent> | z.infer<typeof ForwardCloseEvent>;

export const EventUnion = z.discriminatedUnion("type", [
  WorkspaceCreatingEvent.extend(sequenced),
  WorkspaceCreatedEvent.extend(sequenced),
  WorkspaceNappedEvent.extend(sequenced),
  WorkspaceWokenEvent.extend(sequenced),
  WorkspaceUpgradedEvent.extend(sequenced),
  WorkspaceDeletedEvent.extend(sequenced),
  WorkspaceGoneEvent.extend(sequenced),
  WorkspaceStatusEvent.extend(sequenced),
  WorkspaceCostEvent.extend(sequenced),
  SessionStartEvent.extend(sequenced),
  SessionDeltaEvent.extend(sequenced),
  SessionDoneEvent.extend(sequenced),
  SessionEndEvent.extend(sequenced),
  SessionSteerEvent.extend(sequenced),
  SessionNotifyEvent.extend(sequenced),
  SessionQueuedEvent.extend(sequenced),
  PortOpenEvent.extend(sequenced),
  PortCloseEvent.extend(sequenced),
  InboxFileEvent.extend(sequenced),
  GoldenStageEvent.extend(sequenced),
  ForwardOpenEvent.extend(sequenced),
  ForwardCloseEvent.extend(sequenced),
  ProjectImportEvent.extend(sequenced),
  ProjectExportEvent.extend(sequenced),
]);
export type EventUnion = z.infer<typeof EventUnion>;

/** What events.subscribe answers before it pushes anything. seq is the newest sequence the runtime has issued (0
 * before its first event): the cursor a client that has seen no event yet resubscribes from. stream names the
 * runtime process that issued it; sequences from two streams never compare, so a client that stored one and sees
 * another treats the reply as a gap whatever else it says. gap: the `after` sent is not a cursor into this stream
 * (the runtime no longer retains it, or it came with another stream id), nothing was replayed, and a client that
 * folds events must refetch sessions.history. */
export const EventsSubscribeReply = z.object({
  seq: z.number().int().nonnegative(),
  stream: z.string().optional(),
  gap: z.literal(true).optional(),
});
export type EventsSubscribeReply = z.infer<typeof EventsSubscribeReply>;

// --- daemon wire protocol (ws://0.0.0.0:7070, auth frame first, 4401 on anything else) ---

/** Client-side health of a daemon link. reauth-needed: the daemon refused the token, and a browser link asks the
 * host for its current one before redialling; the host's own link stops there. dead is terminal. */
export const DaemonLinkStatus = z.enum(["connecting", "live", "reauth-needed", "dead"]);
export type DaemonLinkStatus = z.infer<typeof DaemonLinkStatus>;

const reqId = z.union([z.string(), z.number()]);

/** The first frame on every daemon socket, the URL carries no token: answered {id, ok} then daemon.hello, or
 * the socket closes 4401 with one sentence of reason. Anything else first, or nothing, closes the same way.
 * A peer that sends more than a few KiB before this frame passes is closed 4401 too, so a client sends nothing
 * more until it is answered. port scopes the socket to one guest port: only tunnel ops on that port and ping are
 * answered, everything else is refused with code forbidden. */
export const DaemonAuthRequest = z.object({
  id: reqId,
  op: z.literal("auth"),
  token: z.string(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type DaemonAuthRequest = z.infer<typeof DaemonAuthRequest>;

// Replies carry no op, so each files/diff op has its own reply schema here
// instead of a discriminated union; DaemonOkResponse stays the loose envelope.

export const FsEntryType = z.enum(["file", "dir", "symlink"]);
export type FsEntryType = z.infer<typeof FsEntryType>;
/** name is the entry's own name in the listed directory; size is 0 for
 * anything but a file; mtime is epoch milliseconds. */
export const FsEntry = z.object({ name: z.string(), type: FsEntryType, size: z.number(), mtime: z.number() });
export type FsEntry = z.infer<typeof FsEntry>;
/** total counts the directory's entries after filtering; truncated means
 * entries holds only the first cap of them. */
export const FsListReply = z.object({ entries: z.array(FsEntry), truncated: z.boolean(), total: z.number() });
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
/** root is the working tree's top-level directory, absolute on the guest. */
export const GitStatusReply = z.object({ branch: GitBranch, entries: z.array(GitStatusEntry), root: z.string() });
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

/** One live or exited pty the daemon still holds; exited ones stay until pty.kill. */
export const PtyListEntry = z.object({ id: z.string(), pid: z.number(), cols: z.number(), rows: z.number(), exited: z.boolean() });
export type PtyListEntry = z.infer<typeof PtyListEntry>;
export const PtyListReply = z.object({ ptys: z.array(PtyListEntry) });
export type PtyListReply = z.infer<typeof PtyListReply>;

export const ProcSignal = z.enum(["TERM", "KILL"]);
export type ProcSignal = z.infer<typeof ProcSignal>;

/** One process as /proc/[pid] shows it. cpu is its busy share of one core
 * over the interval (a threaded process can pass 100); rss in bytes;
 * startedAt epoch milliseconds; cmdline the first 200 bytes with the NULs as
 * spaces, empty for a kernel thread; pty names the daemon pty whose shell
 * this is. The environment never travels: it holds tokens. */
export const ProcEntry = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  user: z.string(),
  state: z.string(),
  comm: z.string(),
  cmdline: z.string(),
  cpu: z.number(),
  rss: z.number(),
  startedAt: z.number(),
  pty: z.string().optional(),
});
export type ProcEntry = z.infer<typeof ProcEntry>;

/** cwd is null when unreadable; ports are the TCP ports this pid listens on;
 * children are the pids whose parent it is, as of the last snapshot. */
export const ProcInspectReply = z.object({
  pid: z.number().int(),
  cwd: z.string().nullable(),
  ports: z.array(z.number().int()),
  threads: z.number().int(),
  children: z.array(z.number().int()),
});
export type ProcInspectReply = z.infer<typeof ProcInspectReply>;

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
  /** Streams sys.sample events to this socket every two seconds until it
   * closes. One sampler serves every subscriber and stops with the last one;
   * the first sample lands one interval after the reply, since cpu is a delta. */
  z.object({ id: reqId, op: z.literal("sys.watch") }),
  /** Streams proc.snapshot events to this socket every two seconds until
   * proc.unwatch or the socket closes. The daemon reads /proc only while some
   * socket watches; the first snapshot lands one interval after the reply,
   * since cpu is a delta. */
  z.object({ id: reqId, op: z.literal("proc.watch") }),
  z.object({ id: reqId, op: z.literal("proc.unwatch") }),
  /** One process in depth, replied as a ProcInspectReply; this is the only op
   * that scans /proc/net, and only for that pid's sockets. */
  z.object({ id: reqId, op: z.literal("proc.inspect"), pid: z.number().int().positive() }),
  /** Sends the signal. pid 1, the daemon and the daemon's parent are refused
   * with code forbidden; a pid that is gone answers not-found. */
  z.object({ id: reqId, op: z.literal("proc.kill"), pid: z.number().int().positive(), signal: ProcSignal }),
  z.object({ id: reqId, op: z.literal("ping") }),
  /** Lists one directory's direct children, each request under its own entry
   * cap. Paths are relative to the daemon's home root (HOME unless started
   * with --root) or absolute inside it or an imported project folder named in
   * DAEMON_ROOTS_PATH; anything resolving outside every root, through .. or a
   * symlink, is refused with code outside-root. gitignore hides .git and the
   * entries git would ignore. */
  z.object({
    id: reqId,
    op: z.literal("fs.list"),
    path: z.string(),
    gitignore: z.boolean().optional(),
  }),
  z.object({ id: reqId, op: z.literal("fs.read"), path: z.string(), encoding: FsReadEncoding.optional() }),
  z.object({ id: reqId, op: z.literal("git.status"), cwd: z.string() }),
  z.object({ id: reqId, op: z.literal("git.diff"), cwd: z.string(), scope: GitDiffScope, path: z.string().optional() }),
  /** One laptop-side connection to a guest loopback port, for the sign-in
   * callback forward. The daemon dials 127.0.0.1 then ::1 (a Node 22 tool
   * binds [::1] only). data is base64; the reply to tunnel.open comes after
   * the guest accepted. */
  z.object({ id: reqId, op: z.literal("tunnel.open"), tunnelId: z.string(), port: z.number().int().min(1).max(65535) }),
  z.object({ id: reqId, op: z.literal("tunnel.write"), tunnelId: z.string(), data: z.string() }),
  z.object({ id: reqId, op: z.literal("tunnel.close"), tunnelId: z.string() }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

export const DaemonErrorCode = z.enum([
  "outside-root",
  "not-found",
  "not-a-directory",
  "not-a-file",
  "not-a-git-repo",
  "bad-request",
  "forbidden",
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

/** One reading of the guest: cpu is busy time over the interval across all
 * cores (0 to 100), load1 the one-minute load average, mem and disk in bytes
 * (mem used is total minus available; disk is the filesystem under the
 * daemon's root), at epoch milliseconds. */
export const SysSample = z.object({
  type: z.literal("sys.sample"),
  cpu: z.number(),
  load1: z.number(),
  mem: z.object({ used: z.number(), total: z.number() }),
  disk: z.object({ used: z.number(), total: z.number() }),
  at: z.number(),
});
export type SysSample = z.infer<typeof SysSample>;

/** Every process the daemon read this tick. daemon is its own pid, so a
 * client can name it; total counts /proc entries, procs holds at most the
 * first thousand of them by pid. */
export const ProcSnapshot = z.object({
  type: z.literal("proc.snapshot"),
  at: z.number(),
  daemon: z.number().int(),
  total: z.number().int(),
  procs: z.array(ProcEntry),
});
export type ProcSnapshot = z.infer<typeof ProcSnapshot>;

/** The daemon's protocol version, carried in its hello and bumped whenever an op is added or widened, so a client
 * can tell what a machine's daemon answers before asking. A hello without one is version 1: every daemon deployed
 * before the field existed, which has the pty, ports, manifest, inbox, fs, git and tunnel ops and no sys or
 * proc ops. Version 3 browses the imported project folders named in DAEMON_ROOTS_PATH beside its home. */
export const DAEMON_VERSION = 3;

/** The file on the guest naming the imported project folders, one absolute path per line: the runtime writes it
 * when a project lands, the daemon reads it on every files and diff op and browses those folders beside its home. */
export const DAEMON_ROOTS_PATH = "/root/.wsp/roots";

/** The version a hello announces, 1 when it carries none. */
export function daemonVersionOf(hello: { version?: number }): number {
  return hello.version ?? 1;
}

export const DaemonEvent = z.discriminatedUnion("type", [
  /** The first frame after the auth reply: root is the
   * absolute directory every fs.* and git.* path must resolve inside, so a
   * client can build absolute paths for pickers, pins and session starts.
   * version is DAEMON_VERSION as the daemon was built; absent on version 1. */
  z.object({ type: z.literal("daemon.hello"), root: z.string(), version: z.number().int().optional() }),
  z.object({ type: z.literal("pty.data"), ptyId: z.string(), data: z.string() }),
  z.object({
    type: z.literal("pty.exit"),
    ptyId: z.string(),
    exitCode: z.number(),
    signal: z.number().optional(),
  }),
  /** loopback: bound to 127.0.0.1 or ::1 only, so the preview edge (which dials eth0) cannot reach it. */
  z.object({
    type: z.literal("port.open"),
    port: z.number(),
    pid: z.number().optional(),
    process: z.string().optional(),
    loopback: z.boolean().optional(),
  }),
  z.object({ type: z.literal("port.close"), port: z.number(), ...portCloseDetail }),
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
  /** A guest tool asked for a browser (through the BROWSER or xdg-open shim).
   * Pushed to every authed socket; clients show it and open it on a click.
   * http(s) only: the machine is the untrusted side. port is the localhost
   * port in the URL's redirect_uri when it carries one. */
  z.object({ type: z.literal("browser.open"), url: z.string().refine(isHttpUrl, "http or https URL"), port: RelayPort.optional() }),
  /** A loopback listener appeared around a browser.open whose URL named no
   * port: the flow's callback, for the host to forward. */
  z.object({ type: z.literal("callback.port"), port: RelayPort }),
  z.object({ type: z.literal("tunnel.data"), tunnelId: z.string(), data: z.string() }),
  /** The guest side closed; the laptop connection ends after any data before it. */
  z.object({ type: z.literal("tunnel.end"), tunnelId: z.string() }),
  /** A pty printed, or a tool asked to open, a plain http URL on a local host
   * with an explicit port (http://localhost:8123/, 127.0.0.1:8123): the port a
   * person would click. Only the port travels; the host forwards it here. */
  z.object({ type: z.literal("localhost.url"), port: RelayPort }),
  SysSample,
  ProcSnapshot,
]);
export type DaemonEvent = z.infer<typeof DaemonEvent>;

// --- runtime wire protocol (serveRuntime) ------------------------------------

export const TicketPurpose = z.enum(["connect"]);
export type TicketPurpose = z.infer<typeof TicketPurpose>;

export const RuntimeRequest = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("auth"), token: z.string() }),
  z.object({ id: reqId, op: z.literal("ticket.issue"), purpose: TicketPurpose }),
  /** Replies with an EventsSubscribeReply, then pushes events on this socket. With `after`, the seq of the last event
   * this client saw, every retained event past it is pushed first, oldest first, before anything live; `stream` is
   * the id that came with that seq, so a runtime that is not the one that issued it answers gap instead. */
  z.object({
    id: reqId,
    op: z.literal("events.subscribe"),
    after: z.number().int().nonnegative().optional(),
    stream: z.string().optional(),
  }),
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
    /** Auto-nap window for this workspace; absent takes the runtime default (20 min), null turns it off. */
    idleWindowMs: z.number().nullable().optional(),
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
  /** Drops a workspace whose machine the provider no longer has: the record, its transcripts and its sessions leave the
   * store, workspace.deleted follows, and nothing is asked of the provider. Refused with the reason (kind "conflict")
   * while the machine still exists: pause it or delete it at the provider first. */
  z.object({ id: reqId, op: z.literal("workspaces.forget"), workspaceId: z.string() }),
  /** Snapshots the workspace's disk as a project golden and replies with { projectGolden }. Refused when the workspace
   * is not running, holds no project, or its machine is not first-life (kind "notFirstLife"). The guest freezes for
   * about three seconds and keeps its first life. */
  z.object({ id: reqId, op: z.literal("workspaces.snapshot"), workspaceId: z.string() }),
  /** Replies with { projectGoldens: ProjectGolden[] }, every project golden this runtime took, newest last. */
  z.object({ id: reqId, op: z.literal("projectGoldens.list") }),
  /** A person acted in the workspace through a road the runtime cannot see (typed into
   * a terminal over the browser's daemon link); the idle countdown starts over. */
  z.object({ id: reqId, op: z.literal("workspaces.touch"), workspaceId: z.string() }),
  /** Replies with a DaemonReachView; the runtime remints the edge token when it nears expiry. */
  z.object({ id: reqId, op: z.literal("workspaces.daemonReach"), workspaceId: z.string() }),
  /** Starts a turn and replies with a SessionStartResult. On a thread whose turn is still running the runtime never
   * starts a second one on the session: the message joins the running turn when the harness steers (the reply names
   * that turn), and otherwise waits for it to end before starting. */
  z.object({
    id: reqId,
    op: z.literal("sessions.start"),
    workspaceId: z.string(),
    prompt: z.string(),
    harness: z.string().optional(),
    resume: z.string().optional(),
    cwd: z.string().optional(),
    /** Values from the harness's catalog for the workspace (harnesses.list), refused with that list on a miss. A
     * start that opens a thread without a model runs the one the catalog marks default, so the app, the command line
     * and the MCP server run the same model; an absent effort or mode leaves the CLI's own. */
    model: z.string().optional(),
    effort: z.string().optional(),
    permissionMode: z.string().optional(),
    contextWindow: z.string().optional(),
    /** Absent reads as person: the app never sends it, the command line sends cli, the MCP server sends agent. */
    startedBy: SessionOrigin.optional(),
    /** Minted by the client per send and echoed on the turn's session.start, so the client knows which start is its own. */
    requestId: z.string().optional(),
    /** A thread id, or NOTIFY_ME: registered on the thread this start opens, so every turn's end on it sends one line
     * there (a session.notify event in this thread's transcript). Refused when no thread has that id. */
    notify: z.string().optional(),
  }),
  /** Replies with { harnesses: HarnessCatalog[] }, one per harness the runtime knows. With a workspace, the lists come
   * from the binaries on its machine where they answer; without one, from the runtime's table. */
  z.object({ id: reqId, op: z.literal("harnesses.list"), workspaceId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("sessions.list"), workspaceId: z.string().optional() }),
  /** Replies with the workspace's persisted SessionEvent[] (oldest first, capped by the runtime). */
  z.object({ id: reqId, op: z.literal("sessions.history"), workspaceId: z.string() }),
  /** Asks the harness to stop the session's running turn; replies with a SessionInterruptResult. */
  z.object({ id: reqId, op: z.literal("sessions.interrupt"), sessionId: z.string() }),
  /** Sends a message into the session's running turn; replies with a SessionSteerResult. Takes the runtime's session
   * id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.steer"), sessionId: z.string(), prompt: z.string(), requestId: z.string().optional() }),
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
  /** Replies with { storage: SnapshotStorage | null }: every snapshot on the account by count, size and monthly
   * cost; null on a backend whose capabilities lack snapshotListing. */
  z.object({ id: reqId, op: z.literal("snapshots.storage") }),
  /** Replies with { points: WorkspaceCostEvent[] }: the workspace's cost ticks since metering began, across host
   * restarts, folded to the ticks where the rate changed plus the newest (appendCostPoint); empty before the first tick. */
  z.object({ id: reqId, op: z.literal("cost.history"), workspaceId: z.string() }),
  /** Moves the golden's head to a version already in its manifest; replies with a
   * SnapshotRollbackResult. A version outside the manifest fails with kind "missing". */
  z.object({ id: reqId, op: z.literal("snapshots.rollback"), version: z.number(), name: z.string().optional() }),
  /** Replies with a DaemonReachView for a live builder (wsp init's sign-in
   * terminal dials it). Asked per dial like workspaces.daemonReach: the edge token
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
  /** Replies with { probe: PortProbeView }: one fetch of the port's minted route
   * from the host, redirects unfollowed, the body read up to a cap. A 401 remints
   * the port's route before the reply, so the next portReach carries a fresh
   * token. Refused when the route cannot be fetched at all; the frame is the
   * only truth then. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.portProbe"),
    workspaceId: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  /** Replaces the workspace's machine with a fresh golden fork, imports the
   * nap-time vault if one exists, and kills the old machine whatever it
   * reports. Replies with the WorkspaceView on its new machine; id and name
   * are kept. The way out of a zombie reach state. */
  z.object({ id: reqId, op: z.literal("workspaces.rebuild"), workspaceId: z.string() }),
  /** Replies with { forwards: PortForward[] }, the host's open forwards; empty when no host holds any. */
  z.object({ id: reqId, op: z.literal("forwards.list") }),
  /** Closes one forward; refused when none is open on that workspace and port. */
  z.object({ id: reqId, op: z.literal("forwards.stop"), workspaceId: z.string(), port: RelayPort }),
  /** Runs one command on the workspace's machine the way a harness turn is launched: detached, as the same user,
   * with the environment the harness adapter exports for a turn. argv is the command word by word; the runtime
   * quotes each for the machine's shell, so a word stays one word. Replies { execId } once launched, then pushes
   * ExecEvent frames to this socket only: exec.output per line, exec.exit last. The socket closing ends the
   * command, and so does the machine going away under it (deleted, paused, or unanswering: exec.exit then carries
   * the reason as its error); nothing else does, there is no deadline. */
  z.object({ id: reqId, op: z.literal("workspaces.exec"), workspaceId: z.string(), argv: z.array(z.string()).min(1) }),
  /** Replies with { plan: ProjectPlan } for a folder on this computer; nothing is read into memory or uploaded. */
  z.object({ id: reqId, op: z.literal("project.plan"), source: z.string() }),
  /** Packs the folder and lands it at `dest` on the workspace's machine; progress rides project.import events and the
   * reply is { imported: ProjectImportResult }. `carry` names the secret-shaped paths from the plan that may travel as
   * they are; `rewrite` names the ones the plan offered a rewrite for, which land rewritten as offered and win over
   * carry; every other secret-shaped file is cut and named. `agents` names the plan's agents whose state for the
   * folder travels; nothing of an agent not named is read. An existing `dest` is refused (kind "exists") unless `replace`. */
  z.object({
    id: reqId,
    op: z.literal("project.import"),
    workspaceId: z.string(),
    source: z.string(),
    dest: z.string(),
    replace: z.boolean().optional(),
    carry: z.array(z.string()).optional(),
    rewrite: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
  }),
  /** The bundle's trip home: tars `source` on the workspace's machine with the bundle's cache exclusions and the
   * agent state keyed to it, lands the folder at `dest` on this computer and the state in the agents' homes here,
   * keyed to `dest`; progress rides project.export events and the reply is { exported: ProjectExportResult }.
   * `agents` narrows whose state comes home, by catalog id; absent, every agent with sessions for the folder does.
   * An existing `dest` is refused (kind "exists", the message naming it and how many files it holds) unless
   * `replace`; nothing is read from the machine before that check. */
  z.object({
    id: reqId,
    op: z.literal("project.export"),
    workspaceId: z.string(),
    source: z.string(),
    dest: z.string(),
    replace: z.boolean().optional(),
    agents: z.array(z.string()).optional(),
  }),
]);
export type RuntimeRequest = z.infer<typeof RuntimeRequest>;

/** What a workspaces.exec pushes to the socket that asked. exitCode is null when the command was ended without
 * one (the socket closed or the launch failed); error says which. */
export const ExecEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exec.output"), execId: z.string(), text: z.string() }),
  z.object({ type: z.literal("exec.exit"), execId: z.string(), exitCode: z.number().int().nullable(), error: z.string().optional() }),
]);
export type ExecEvent = z.infer<typeof ExecEvent>;

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

// --- session interrupt (what a stop button gets back) -------------------------

/** accepted: the harness was told to stop and the turn ends with status interrupted.
 * not-running: the turn had already ended, so there was nothing to stop.
 * not-found: this runtime holds no such session (sessions live in memory; a restart forgets them).
 * None of these is an error reply: a stop button has nothing to recover from. */
export const SessionInterruptOutcome = z.enum(["accepted", "not-running", "not-found"]);
export type SessionInterruptOutcome = z.infer<typeof SessionInterruptOutcome>;
export const SessionInterruptResult = z.object({ outcome: SessionInterruptOutcome });
export type SessionInterruptResult = z.infer<typeof SessionInterruptResult>;

// --- session steer (what send-now on a queued row gets back) -------------------

/** accepted: the harness took the message into the running turn and a session.steer event carries it.
 * not-running: the turn had ended, or had not started, when the message was offered; the caller starts a turn instead.
 * unsupported: the session's harness takes no message mid-turn (its catalog says steers: false).
 * not-found: this runtime holds no such session. None is an error reply. */
export const SessionSteerOutcome = z.enum(["accepted", "not-running", "unsupported", "not-found"]);
export type SessionSteerOutcome = z.infer<typeof SessionSteerOutcome>;
export const SessionSteerResult = z.object({ outcome: SessionSteerOutcome });
export type SessionSteerResult = z.infer<typeof SessionSteerResult>;

// --- session start (how the turn the caller asked for came to be) --------------

/** started: a turn of its own began. steered: the thread's turn was running and took the message mid-way, so
 * session is that turn and a session.steer event carries the message. queued: the thread's turn was running and could
 * not take a message, so this start waited for it to end and then began. The reply comes back once the turn began.
 * turnId is the turn's, as its events carry it: a follower keys on it, since the thread's earlier turns share the
 * session row. */
export const SessionStartOutcome = z.enum(["started", "steered", "queued"]);
export type SessionStartOutcome = z.infer<typeof SessionStartOutcome>;
export const SessionStartResult = z.object({ session: SessionView, outcome: SessionStartOutcome, turnId: z.string() });
export type SessionStartResult = z.infer<typeof SessionStartResult>;

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

/** A workspace's disk with its project loaded, snapshotted so forks start a task with the project in place and no
 * upload. `golden` is the snapshot of the golden version at the root of its lineage, whatever it was forked from, so the
 * Lineage section lists it under that version; `version` is that version's number when a manifest knows the snapshot. */
export const ProjectGolden = z.object({
  snapshotId: z.string(),
  project: WorkspaceProject,
  golden: z.string(),
  version: z.number().int().optional(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  createdAt: z.string(),
});
export type ProjectGolden = z.infer<typeof ProjectGolden>;

/** Every snapshot on the account as the provider bills it: a snapshot is a full disk image, the free GB are shared
 * by all of them, and the rest costs usdPerGbMonth from billedFrom. Sizes come from the provider's snapshot
 * listing, never from a machine's requested disk. */
export const SnapshotStorage = z.object({
  count: z.number(),
  totalBytes: z.number(),
  freeGb: z.number(),
  usdPerGbMonth: z.number(),
  billedFrom: z.string(),
  monthlyUsd: z.number(),
});
export type SnapshotStorage = z.infer<typeof SnapshotStorage>;

/** Rollback only moves head. Workspaces already forked keep their machines and
 * image; the field says so on the wire so no client reads it as a fleet change. */
export const SnapshotRollbackResult = z.object({
  lineage: SnapshotLineage,
  existingWorkspaces: z.literal("untouched"),
});
export type SnapshotRollbackResult = z.infer<typeof SnapshotRollbackResult>;

/** The create's own answer: the workspace, and what the runtime had to do to make room for it (a builder kept
 * after a save, stopped at the machine cap), so the person who asked reads why. Absent when nothing was stopped. */
export const WorkspaceCreateResult = z.object({ workspace: WorkspaceView, notice: z.string().optional() });
export type WorkspaceCreateResult = z.infer<typeof WorkspaceCreateResult>;

export { actionRefusal, goneRefusal, needsRebuild, sendRefusal, workspaceState, workspaceWord, type WorkspaceState, type WorkspaceStateInput } from "./workspace-state.js";
export { AFTER_CUT_LINE, DAEMON_UPDATE_FAILED, DAEMON_UPDATING, deleteNotice, fmtBytes, fmtCost, fmtCount, fmtDuration, fmtMemGb, fmtThreads, forgetNotice, notifyLine, titleLine, turnCutLine, type DurationStyle, type TurnCutRule } from "./format.js";
export { appendCostPoint, COST_HISTORY_CAP } from "./cost-history.js";
export { shellQuote } from "./shell-quote.js";
export { agentsRequest, canTravel, consentRequest, defaultAgents, defaultConsent, importConsented, importRequest, secretOffer, type ImportAnswers, type ProjectImportRequest } from "./project-import.js";
