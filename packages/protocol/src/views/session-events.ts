// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, TURN_TOKEN_ENV } from "../env.js";
import { AttachmentRecord } from "../attachments.js";
import { UsageTokens } from "../usage.js";
import { SessionSlateEvent } from "../slate/wire.js";
import { permissionPrompt } from "../wire/helpers.js";
import { PermissionOutcome, SessionOrigin, SubagentState, TurnRefusal } from "./session.js";

// --- session events (the wire form of adapter-port.ts's AdapterEvent) ------

/** What one piece of a turn's stream is. `note` is the harness's own line about itself, a warning about the
 * person's configuration among them: not the agent's words, not a call, and never the turn's verdict, so a reader
 * prints it as an aside and the word failed stays for a call that failed and for a turn that did. */
export const DeltaKind = z.enum(["text", "thinking", "note", "tool_use", "tool_result"]);
export type DeltaKind = z.infer<typeof DeltaKind>;

export const TurnStatus = z.enum(["completed", "interrupted", "failed"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

/** What a turn cost in tokens, as its agent counted them. input is every token the model read over the turn, cached
 * the part of it read back from the agent's cache and cacheWrite the part written to it; context is what the model
 * held at the turn's last call and window the most it can hold, which only an agent that reports it carries. */
export const TurnTokens = z.object({
  input: z.number(),
  output: z.number(),
  cached: z.number().optional(),
  cacheWrite: z.number().optional(),
  reasoning: z.number().optional(),
  context: z.number().optional(),
  window: z.number().optional(),
});
export type TurnTokens = z.infer<typeof TurnTokens>;

export const TurnResult = z.object({
  status: TurnStatus,
  durationMs: z.number().optional(),
  /** How much of durationMs the turn spent stopped on a permission prompt nobody had answered. The harness's own
   * figure is wall time from launch to result, so a turn that asked and waited counts the person's minutes as its
   * own; this is what every reader takes off it. Absent on a turn nothing of it waited on. */
  waitedMs: z.number().optional(),
  costUsd: z.number().optional(),
  tokens: TurnTokens.optional(),
  /** The model the turn ran on, by the agent's own id. */
  model: z.string().optional(),
  /** The turn's use per model, where its agent names every model a turn used: a turn hands small jobs to a cheaper
   * model, and each is filed under its own. */
  models: z.array(z.object({ model: z.string(), tokens: UsageTokens, costUsd: z.number().optional() })).optional(),
  text: z.string().optional(),
  error: z.string().optional(),
  /** Set only on a turn the agent refused outright for a cause wsp knows; the status is failed with it. */
  refusal: TurnRefusal.optional(),
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
  /** Where the event sits in its workspace's transcript, from one, stamped by the runtime as it records the event and
   * never issued twice in one transcript, a restart and a trim included: a client holding part of a thread places an
   * event off the bus or out of a page against what it holds with one compare. Not the bus's `seq`, which counts
   * every event of one host process and starts again with the next. Absent on an event the bus carried that the
   * transcript never recorded. */
  pos: z.number().int().positive().optional(),
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
  /** The files the person's message carried, as records: their type, their weight and their name, never their
   * bytes, which reach the machine and nothing else. Absent on a turn that carried none. */
  attachments: z.array(AttachmentRecord).optional(),
  /** The id the client minted for the sessions.start that opened this turn, stamped by the runtime; absent when the
   * client sent none. Two clients sending the same text at the same moment are told apart by this, not the prompt. */
  requestId: z.string().optional(),
  /** Set where the message came from a press in the thread's slate, so the timeline says so. */
  via: z.literal("slate").optional(),
  /** Set when the thread's previous turn ended with no exit code and no result (a deadline, a host restart, a nap
   * that ended it), so clients say the harness resumes a transcript that may be missing context; absent otherwise. */
  afterCut: z.literal(true).optional(),
  /** Set on the turn that opened its thread; absent on every later one and on a turn from before it was recorded. */
  opensThread: z.literal(true).optional(),
  /** Who opened this turn's thread, as its row says it. Absent on a turn from before it was recorded. */
  startedBy: SessionOrigin.optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  /** The access this turn ran at, as the harness's own slug; the runtime's pick, not the CLI's echo. It rides the
   * row so a resume past the session index cap still reads what the thread was opened at rather than falling back
   * to the adapter's unnamed default. Absent on a turn from before it was recorded. */
  permissionMode: z.string().optional(),
  /** The effort this turn ran at, as the runtime asked for it, since the CLI never echoes it: kept for the same cap, so
   * a send naming none into a thread whose rows fell off the index runs at the thread's own. Absent on a turn that ran
   * at none and on one from before it was recorded. */
  effort: z.string().optional(),
  /** The agent this turn ran on, by the id SessionView.harness carries: the thread's own record stamped on its
   * transcript, beside the access and for the same cap, so a thread whose rows fell off the index still says which
   * agent it runs on. Absent on a turn from before it was recorded. */
  agent: z.string().optional(),
  tools: z.array(z.string()).optional(),
  harness: SessionHarness.optional(),
});

export const SessionDeltaEvent = z.object({
  type: z.literal("session.delta"),
  ...sessionScope,
  kind: DeltaKind,
  text: z.string(),
  /** The harness's own id for the message this piece of text belongs to, and the one home of the rule every reader
   * of text follows: append to the message you have open, open another where this changes. That is what tells the
   * reply an agent gave while a background command ran from the reply it gave when that command woke it, which the
   * harness sends as two messages and every reader used to glue into one. Absent on a row written before the stamp
   * existed and on every kind a harness names no message for, which append as they always did. */
  messageId: z.string().optional(),
  toolName: z.string().optional(),
  toolUseId: z.string().optional(),
  isError: z.boolean().optional(),
  /** The tool call of this turn that launched the agent this line came from; absent on every line the thread's own
   * agent wrote. A harness runs its subagents on the session that spawned them, so their lines arrive among the
   * parent's and this is the only thing that tells them apart. */
  parentToolUseId: z.string().optional(),
  /** The agent's tool shell folder after this tool_use, present only when the call moved it (a cd, or a file written
   * in a folder beside the one followed so far); the panes follow it while the harness folder stays put. */
  cwd: z.string().optional(),
  /** Where this line sits in its turn, counting from one; not to be confused with `seq`, which the bus stamps on the
   * wire and the transcript never carries. A host that re-opens a running turn reads the run's output from its first
   * byte, and this is how it knows how much of it is already written: the transcript is capped per workspace and
   * drops its oldest rows, so how many of a turn's rows survive says nothing about how many there were. Absent on a
   * row written before the stamp existed. */
  line: z.number().int().positive().optional(),
  /** The length of the whole text, on a tool result a thread's head cut short; the rest is in a sessions.history
   * page. Absent on every row a transcript holds and on a result the head kept whole. */
  cut: z.number().int().positive().optional(),
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
  /** Set when the runtime ended the session itself (a nap, a delete, a machine gone at the provider) rather than the harness exiting. */
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
  /** Set where the message came from a press in the thread's slate, as on session.start. */
  via: z.literal("slate").optional(),
  /** Set where the turn this message joined was stopped on a permission prompt nobody had answered when it landed:
   * the message is in and the turn takes it up once the person answers, which is what the caller says rather than
   * waiting in silence. */
  waiting: z.boolean().optional(),
});
export type SessionSteerEvent = z.infer<typeof SessionSteerEvent>;

/** Pushed once when a start finds the thread's turn running and a harness that takes no message mid-turn, so the
 * caller can say it is waiting before the start's reply comes; not a session event, never in history. */
export const SessionQueuedEvent = z.object({
  type: z.literal("session.queued"),
  workspaceId: z.string(),
  threadId: z.string(),
  /** The agent the waiting message runs on: the thread's own. */
  harness: z.string(),
  prompt: z.string(),
  /** The id the client minted for the sessions.start that waits. */
  requestId: z.string().optional(),
});
export type SessionQueuedEvent = z.infer<typeof SessionQueuedEvent>;

/** Pushed once when a start holds its thread's row, before the harness has announced its session: the thread is in
 * the listing from here, whoever started it, so a window draws it now rather than after the launch; never in history. */
export const SessionHeldEvent = z.object({
  type: z.literal("session.held"),
  workspaceId: z.string(),
  threadId: z.string(),
  /** The id the client minted for the sessions.start that holds it, so that client's own tile for the send goes. */
  requestId: z.string().optional(),
});
export type SessionHeldEvent = z.infer<typeof SessionHeldEvent>;

/** Pushed once when a start has waited AGENT_STARTING_MS on its agent with no session from it yet, so a client says
 * the agent is starting rather than showing a bare wait; not a session event, never in history. */
export const SessionStartingEvent = z.object({
  type: z.literal("session.starting"),
  workspaceId: z.string(),
  threadId: z.string(),
  harness: z.string(),
  /** The agent's command there is a script that installs it on its first run, and that run is this one. */
  installs: z.literal(true).optional(),
  /** The id the client minted for the sessions.start that waits. */
  requestId: z.string().optional(),
});
export type SessionStartingEvent = z.infer<typeof SessionStartingEvent>;

/** How long a start waits on its agent before it says the agent is starting: a normal start measured 1.5 to 7 s, the
 * first run of a wrapper that installs the agent 97 s (Omarchy, 2026-10-05). */
export const AGENT_STARTING_MS = 4_000;

/** The word an agent's row takes in place of its version where its command installs it on its first run. */
export const FIRST_RUN_WORD = "installs on first run";

/** What a thread says while that start waits: short enough to stand whole on a phone's one line. */
export const agentStartingLine = (agent: string, installs: boolean): string => (installs ? `${agent} ${FIRST_RUN_WORD}` : `Starting ${agent}`);

/** The word a start's notify carries to mean the caller: the thread the request came out of when it came out of one,
 * and otherwise the person who ran it. */
export const NOTIFY_ME = "me";

/** The host a turn on a machine drives, off its own environment: the address the launch put there, the token
 * beside it and the fingerprint of the key that host proves. Nothing unless the address and the token are there,
 * since an address with no token opens nothing and a token with no address names no host. The pair goes ahead of
 * every host a computer holds on its own, under only what a line names: it is the identity the launch handed the
 * turn, and the machine's own state file is a path nothing serves. The key is read here and refused where the aim
 * is made, so a launch that named an address and a token and no key is told so rather than silently aiming at the
 * computer the turn happens to run on. */
export function hostFromEnv(env: Readonly<Record<string, string | undefined>>): { url: string; token: string; hostKey?: string } | undefined {
  const url = env[HOST_URL_ENV]?.trim();
  const token = env[HOST_TOKEN_ENV]?.trim();
  const hostKey = env[HOST_KEY_ENV]?.trim();
  if (url === undefined || url === "" || token === undefined || token === "") return undefined;
  return { url, token, ...(hostKey === undefined || hostKey === "" ? {} : { hostKey }) };
}

/** Where a machine's daemon bundle is unpacked, and the wsp command that rides in it: one file, the whole bundled
 * command, so a turn on any machine with a daemon can drive this host with no install of its own. Named here
 * because the host stages the file and the runtime builds the launch that runs it, and neither may import the
 * other's rule. */
export const GUEST_DAEMON_DIR = "/root/wsp-daemon";
/** The service manager's name for the daemon: the unit file, the deploy's start and stop, its log, and a wake that
 * starts a daemon its provider left down all read it. */
export const DAEMON_UNIT = "wsp-daemon.service";
/** The command sits in the bundle as npm lays the published package out, its package.json beside a dist folder and
 * its own assets beside those, because the bin reads its own version through that file (`../package.json` from the
 * bin) and announces it in every MCP handshake; a client refuses a server that names none. Named as a folder
 * rather than as the bin alone, since the daemon binary the bundle carries rides in that package's assets and the
 * command reads it there the way an installed copy reads its own. */
export const wspPackageIn = (dir: string): string => `${dir}/wsp`;
export const wspBinIn = (dir: string): string => `${wspPackageIn(dir)}/dist/bin.js`;
export const GUEST_WSP_BIN = wspBinIn(GUEST_DAEMON_DIR);
/** The wsp a process inside a fork runs, and the one word a launch names it by: two lines the deploy writes onto
 * the machine's PATH, handing the whole line to the daemon binary beside them, which carries it to the host over
 * the socket the host already holds to this machine's daemon. The binary's own path is not named here: it sits in
 * the bundle under one folder per chip, and only the machine says which chip it is. */
export const GUEST_WSP_PATH = "/usr/local/bin/wsp";

/** The token a client puts on its requests, off its own environment; nothing when it is not running inside a turn. */
export function turnTokenOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const token = env[TURN_TOKEN_ENV];
  return token === undefined || token === "" ? undefined : token;
}

/** The turn ended and its one line (notifyLine) went where the thread's start said: into the named thread as a send
 * would go, steered or queued, or, for me, to the person, whom the CLI and the app tell from this event. One row per
 * target, so a start that named two threads is two rows. Recorded in the ending thread's transcript, before its
 * session.done, so the line's source is visible and a follower that ends on the done still sees it. */
export const SessionNotifyEvent = z.object({
  type: z.literal("session.notify"),
  ...sessionScope,
  /** The thread the line went to, or NOTIFY_ME. */
  notify: z.string(),
  text: z.string(),
});
export type SessionNotifyEvent = z.infer<typeof SessionNotifyEvent>;

/** One file a turn changed, as the tree under its reply lists it. */
export const TurnChangedFile = z.object({ path: z.string(), kind: z.string(), additions: z.number(), deletions: z.number() });
export type TurnChangedFile = z.infer<typeof TurnChangedFile>;

/** What one turn changed in the folder it ran in: the files the agent itself changed, its own commits and its end
 * worktree edits, with the two snapshot shas off which the Changes pane reads the patches. moved names each HEAD move
 * the turn did not write (a checkout, pull, merge, rebase or reset) as one line, with no files of its own. shared:
 * another thread's turn ran in the same folder between the two, so some of these changes may be that thread's. A turn
 * that changed nothing and moved HEAD no way records none. */
export const SessionChangesEvent = z.object({
  type: z.literal("session.changes"),
  ...sessionScope,
  from: z.string(),
  to: z.string(),
  files: z.array(TurnChangedFile),
  moved: z.array(z.string()),
  shared: z.literal(true).optional(),
});
export type SessionChangesEvent = z.infer<typeof SessionChangesEvent>;

/** One step of the list an agent keeps of its own work, in the three states every agent's list comes down to. */
export const PlanStep = z.object({ text: z.string(), state: z.enum(["pending", "working", "done"]) });
export type PlanStep = z.infer<typeof PlanStep>;

/** One of the agent's own subagents started or ended: a row per change, so a child is its start row and, once it is
 * over, its end row. task is the agent's own id for it, what a stop names; parentToolUseId is the call that launched
 * it, which its lines carry and whose tool_use delta holds what it was asked. A start carries the title, an end the
 * agent's summary where it gave one. */
export const SessionSubagentEvent = z.object({
  type: z.literal("session.subagent"),
  ...sessionScope,
  task: z.string(),
  state: SubagentState,
  parentToolUseId: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  depth: z.number().int().positive().optional(),
  /** Where this row sits among its turn's subagent rows, counting from one, as a delta's line does among the deltas:
   * what a host re-opening the run reads past. */
  line: z.number().int().positive().optional(),
});
export type SessionSubagentEvent = z.infer<typeof SessionSubagentEvent>;

/** The agent's plan for the turn as it stands: its step list whole, each time it changes, or the plan it proposed as
 * Markdown. A later one of either replaces the earlier in the turn it names. */
export const SessionPlanEvent = z.object({
  type: z.literal("session.plan"),
  ...sessionScope,
  steps: z.array(PlanStep).optional(),
  text: z.string().optional(),
});
export type SessionPlanEvent = z.infer<typeof SessionPlanEvent>;

/** One permission prompt the harness raised, relayed into the chat as its own row. The prompt blocks the turn until
 * sessions.answer names an option or the turn itself ends, so the row is what the thread is waiting on for as long
 * as the turn lives. */
export const SessionPermissionEvent = z.object({
  type: z.literal("session.permission"),
  ...sessionScope,
  ...permissionPrompt,
});
export type SessionPermissionEvent = z.infer<typeof SessionPermissionEvent>;

/** The prompt above is closed and the turn moved on. One of these lands for every session.permission, so a
 * transcript never leaves a row waiting on an answer that was given while nobody was reading. */
export const SessionPermissionClosedEvent = z.object({
  type: z.literal("session.permission.closed"),
  ...sessionScope,
  askId: z.string(),
  outcome: PermissionOutcome,
  /** The option that closed it, on a person's pick; absent on the runtime's own deny and on a cancel. */
  optionId: z.string().optional(),
});
export type SessionPermissionClosedEvent = z.infer<typeof SessionPermissionClosedEvent>;

/** What a turn left to rewind to, written once the turn is over: the checkpoint of the copy's files at its end
 * (absent where none could be taken, a folder that is not a checkout or a daemon that did not answer) and the
 * harness's own name for the point its conversation ended at (absent where the harness names none). A rewind cuts
 * the turns after it and puts these back. */
export const SessionCheckpointEvent = z.object({
  type: z.literal("session.checkpoint"),
  ...sessionScope,
  ref: z.string().optional(),
  anchor: z.string().optional(),
  /** Why the harness cannot cut this thread's conversation, in its own clause, where it said so for this turn. */
  kept: z.string().optional(),
});
export type SessionCheckpointEvent = z.infer<typeof SessionCheckpointEvent>;

/** A thread's folder moved between two of its turns: the worktree it ran in was removed, and the turn runs in the
 * project folder. fresh: the agent could not carry its session across, so the turn opened a new one. Written by the
 * host into the thread's transcript, so the person and the agent both read where the thread now runs. */
export const SessionMovedEvent = z.object({
  type: z.literal("session.moved"),
  ...sessionScope,
  from: z.string(),
  to: z.string(),
  branch: z.string().optional(),
  fresh: z.literal(true).optional(),
});
export type SessionMovedEvent = z.infer<typeof SessionMovedEvent>;

/** A thread opened on a pull request in the worktree that holds its branch, which was left as it stood: the one line
 * saying it is behind the pull request, and how to bring it up. */
export const SessionBehindEvent = z.object({
  type: z.literal("session.behind"),
  ...sessionScope,
  text: z.string(),
});
export type SessionBehindEvent = z.infer<typeof SessionBehindEvent>;

/** Where a reply's block run stands: running in its own pty, exited with its code and output, moved to a terminal
 * tab still running, or lost, its pty gone before anybody saw it end. */
export const RunState = z.enum(["running", "exited", "moved", "lost"]);
export type RunState = z.infer<typeof RunState>;

/** One step of a reply's shell block run where it stands, written by the host at each step a window reports, so a
 * reload and another window draw the same block. block names the reply's message and the block's place in its text;
 * a run that ended, moved or was lost keeps that ending whoever reports it again. output is the run's text as the
 * terminal showed it, cut to its tail. */
export const SessionRunEvent = z.object({
  type: z.literal("session.run"),
  ...sessionScope,
  runId: z.string(),
  block: z.string(),
  command: z.string(),
  state: RunState,
  ptyId: z.string().optional(),
  exitCode: z.number().int().optional(),
  signal: z.number().int().optional(),
  output: z.string().optional(),
});
export type SessionRunEvent = z.infer<typeof SessionRunEvent>;

/** What a window reports of a run: the thread and the reply's turn it belongs to, and the step, as SessionRunEvent
 * above carries it. */
export const RunStep = SessionRunEvent.pick({ runId: true, block: true, command: true, state: true, ptyId: true, exitCode: true, signal: true, output: true }).extend({
  threadId: z.string(),
  turnId: z.string(),
});
export type RunStep = z.infer<typeof RunStep>;

/** Why a thread's own token may not record a run: running a reply's block is the person's click. */
export const RUN_PERSONS_LINE = "a reply's block runs on the person's click, never on a thread's token";

/** The events sessions.history replays: what a chat transcript folds. */
export const SessionEvent = z.discriminatedUnion("type", [
  SessionStartEvent,
  SessionDeltaEvent,
  SessionDoneEvent,
  SessionEndEvent,
  SessionSteerEvent,
  SessionNotifyEvent,
  SessionPermissionEvent,
  SessionPermissionClosedEvent,
  SessionCheckpointEvent,
  SessionChangesEvent,
  SessionPlanEvent,
  SessionRunEvent,
  SessionMovedEvent,
  SessionBehindEvent,
  SessionSubagentEvent,
  SessionSlateEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** Every type a session event carries, read off the union itself: a client telling a session event from the rest of
 * the bus asks this rather than keeping a list of its own, which one added event leaves quietly short. */
export const SESSION_EVENT_TYPES: ReadonlySet<SessionEvent["type"]> = new Set(SessionEvent.options.map(o => o.shape.type.value));

/** Whether one event off the bus is a session's, narrowed: the one test every reader that folds a thread's events
 * out of the whole channel makes, so none of them keeps a list or a cast of its own. */
export const isSessionEvent = (e: { type: string }): e is SessionEvent => SESSION_EVENT_TYPES.has(e.type as SessionEvent["type"]);
