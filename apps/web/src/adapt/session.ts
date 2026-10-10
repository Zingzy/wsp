// SPDX-License-Identifier: AGPL-3.0-only
// Session events into chat view models. Ported from t3code session-logic.ts
// (deriveWorkLogEntries, deriveTimelineEntries; commit 57a66608) against
// @wsp/protocol's SessionEvent. One wsp session run is one turn, keyed by the
// runtime's turnId; events from before the runtime stamped one fall back to
// the session id plus the ordinal of its session.start, since a resumed Claude
// session id repeats across turns. Wire order is the timeline order. createdAt
// is the wire's `at` (ms epoch) as ISO, else the caller's receipt clock, else
// "" for unstamped history.
import { AFTER_CUT_LINE, LIMIT_WORDS, NOTIFY_ME, compactedLine, spawnsThread, internalToolResult, subagentPrompt, subagentTaskLine, toolActivityLine, toolCallFacts, toolDoneLine, toolResultLine, type PlanStep, type SessionEvent, type SessionHarness, type SessionRunEvent, type SubagentView, type TurnResult } from "@wsp/protocol";
import { spawnedThreadOf } from "./spawned.js";
import type {
  ChatMessage,
  PermissionPrompt,
  SubagentLine,
  SubagentRun,
  TimelineEntry,
  TurnState,
  TaskStep,
  TurnPlan,
  TurnSummary,
  WorkLogEntry,
} from "./view-model.js";

export interface SessionModel {
  readonly turns: ReadonlyArray<TurnSummary>;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
  readonly timeline: ReadonlyArray<TimelineEntry>;
  readonly latestTurn: TurnSummary | null;
  readonly running: boolean;
  readonly model: string | null;
  /** What the CLI announced about itself on the last session.start that carried it. */
  readonly harness: SessionHarness | null;
  /** The thread's own record as its transcript carries it, off the last session.start that named each: the agent
   * the thread runs on, by its catalog id, and the access its last turn started at. Null before a start carried it. */
  readonly agent: string | null;
  readonly permissionMode: string | null;
  /** The folder the last session.start named, and where the agent's tool shell last was; null until one said. */
  readonly cwd: string | null;
  readonly shellCwd: string | null;
  /** Every reply block's latest run, by the block it was run from; the host records no step after a run's ending. */
  readonly runs: ReadonlyMap<string, SessionRunEvent>;
  /** The latest turn's step list, whatever state the turn is in; null where that turn wrote none. */
  readonly plan: TurnPlan | null;
}

export interface DeriveSessionOptions {
  /** Receipt clock for an event without a wire `at`; undefined leaves createdAt empty. */
  readonly at?: (event: SessionEvent, index: number) => string | undefined;
}

type SessionDelta = Extract<SessionEvent, { type: "session.delta" }>;

interface ToolCall {
  readonly entryIndex: number;
  /** The tool's own name as the harness spelled it, absent where the call never named one. */
  readonly name?: string;
  input: string;
  /** What the call itself answered, once it really has, read by the fold that opens later so a subagent's life is
   * keyed off the call whatever order the frames arrive in. The harness's own note to the agent is not an answer:
   * it says a background agent was launched, and a launch is where the work starts. */
  answered?: { readonly at: string; readonly failed: boolean };
}

interface TurnBuild {
  summary: TurnSummary;
  readonly startCount: number;
  ordinal: number;
  /** Index into `timeline` of the assistant message still accepting text, if the tail is one. */
  openMessage: number | null;
  /** The harness message that one is a piece of, where the harness named it; text of another opens its own bubble. */
  openMessageId: string | null;
  sawText: boolean;
  tools: Map<string, ToolCall>;
  /** Each of a subagent's open calls as the harness has reported it so far, by that line's own key: a call whose
   * input arrives in pieces reads as the whole of it, in both tenses, as the parent's own calls do. */
  childCalls: Map<string, { name: string; input: string }>;
  /** Tool calls without an id resolve to the newest open one, as the CLI streams them in order. */
  openAnonymousTool: number | null;
  /** Where each subagent's fold sits in the timeline, by the call that launched it. */
  subagents: Map<string, number>;
  /** The reply's result once session.done landed; the turn stays running until session.end applies its status. */
  reply: TurnResult | null;
  /** Where the turn's proposed plan sits in the timeline once it has come: a later one replaces the row in place. */
  planRow: number | null;
}

/** A turn's step list as the agent last wrote it, and when each step was set working and how long it took to be
 * marked done, by the step's words and which of the steps with those words it is. */
interface PlanState {
  steps: ReadonlyArray<TaskStep>;
  began: Map<string, number>;
  took: Map<string, number>;
}

/** Each step with the key it is timed under: its words, and how many steps with the same words came before it. */
function keyedSteps(steps: ReadonlyArray<PlanStep>): { key: string; step: PlanStep }[] {
  const seen = new Map<string, number>();
  return steps.map(step => {
    const n = seen.get(step.text) ?? 0;
    seen.set(step.text, n + 1);
    return { key: `${step.text}\n${n}`, step };
  });
}

function nextPlan(earlier: PlanState | undefined, steps: ReadonlyArray<PlanStep>, at: string): PlanState {
  const began = new Map(earlier?.began);
  const took = new Map(earlier?.took);
  const now = Date.parse(at);
  const keyed = keyedSteps(steps);
  for (const { key, step } of keyed) {
    if (Number.isNaN(now)) break;
    if (step.state === "working" && !began.has(key)) began.set(key, now);
    const from = began.get(key);
    if (step.state === "done" && !took.has(key) && from !== undefined) took.set(key, now - from);
  }
  return {
    began,
    took,
    steps: keyed.map(({ key, step }) => ({ ...step, key, ...(took.has(key) ? { durationMs: took.get(key)! } : step.state === "working" && began.has(key) ? { startedAt: began.get(key)! } : {}) })),
  };
}

/** The fold under deriveSession, kept open: each event folds onto what the ones before it built, so a thread that
 * grows by one event costs one event, and the model reads what is built so far without changing it. */
export interface SessionFold {
  /** Folds the next event; `at` is its receipt clock where the wire left it unstamped. */
  readonly add: (event: SessionEvent, at?: string) => void;
  readonly model: () => SessionModel;
  /** How many events the fold has taken. */
  readonly size: () => number;
}

export function deriveSession(events: ReadonlyArray<SessionEvent>, options: DeriveSessionOptions = {}): SessionModel {
  const fold = createSessionFold();
  for (const [index, event] of events.entries()) fold.add(event, options.at?.(event, index));
  return fold.model();
}

export function createSessionFold(): SessionFold {
  const timeline: TimelineEntry[] = [];
  const plans = new Map<string, PlanState>();
  const turns: TurnSummary[] = [];
  const runs = new Map<string, SessionRunEvent>();
  const startsBySession = new Map<string, number>();
  /** Where each relayed permission prompt sits in the timeline, so its close lands on the row it opened rather than
   * on a second row after the work the answer let through. */
  const promptRows = new Map<string, number>();
  let turn: TurnBuild | null = null;
  let modelName: string | null = null;
  let harness: SessionHarness | null = null;
  let agent: string | null = null;
  let permissionMode: string | null = null;
  let cwd: string | null = null;
  let shellCwd: string | null = null;
  let taken = 0;
  /** The transcript position of the event being folded, which names the rows it opens: a thread held from the middle
   * of a turn names a row the same before and after its older events arrive, so the list keeps the row in place. */
  let place: number | undefined;
  const opened = new Map<string, number>();
  const rowId = (turnId: string, kind: "m" | "w", ordinal: number, call?: string): string => {
    if (place === undefined) return `${turnId}:${kind}${ordinal}`;
    // A call's row is named by the call, so a result held without its call, at the top of a window, names the row the
    // call takes over once the older events arrive.
    const base = call !== undefined ? `${turnId}:call:${call}` : `${turnId}:${kind}@${place}`;
    const n = opened.get(base) ?? 0;
    opened.set(base, n + 1);
    return n === 0 ? base : `${base}.${n}`;
  };

  const push = (entry: TimelineEntry): number => {
    timeline.push(entry);
    return timeline.length - 1;
  };
  const replace = (index: number, entry: TimelineEntry): void => {
    timeline[index] = entry;
  };
  const message = (index: number): ChatMessage | undefined => {
    const entry = timeline[index];
    return entry?.kind === "message" ? entry.message : undefined;
  };
  const work = (index: number): WorkLogEntry | undefined => {
    const entry = timeline[index];
    return entry?.kind === "work" ? entry.entry : undefined;
  };
  const subagent = (index: number | undefined): SubagentRun | undefined => {
    const entry = index === undefined ? undefined : timeline[index];
    return entry?.kind === "subagent" ? entry.subagent : undefined;
  };
  const subagentEntry = (run: SubagentRun, createdAt: string): TimelineEntry => ({
    id: `subagent:${run.parentToolUseId}`,
    kind: "subagent",
    createdAt,
    subagent: run,
  });
  /** The fold one subagent's lines gather under, opened the first time it writes. It takes the place of the call
   * that launched it where that call already has a row: the fold is that call, read as the run it started, and two
   * rows for one launch would say the same thing twice. */
  const foldFor = (t: TurnBuild, parentToolUseId: string, at: string): number => {
    const held = t.subagents.get(parentToolUseId);
    if (held !== undefined) return held;
    const call = t.tools.get(parentToolUseId);
    const launched = call === undefined ? undefined : work(call.entryIndex);
    const openedAt = call === undefined || launched === undefined ? at : timeline[call.entryIndex]!.createdAt;
    const ended = call?.answered;
    const run: SubagentRun = {
      parentToolUseId,
      turnId: t.summary.turnId,
      title: (call === undefined ? undefined : subagentTaskLine(call.input)) ?? launched?.detail ?? launched?.label ?? "Subagent",
      prompt: (call === undefined ? undefined : subagentPrompt(call.input)) ?? null,
      lines: [],
      prompts: [],
      state: ended === undefined ? "running" : ended.failed ? "failed" : "done",
      startedAt: openedAt,
      endedAt: ended?.at ?? null,
    };
    const index = call !== undefined && launched !== undefined ? call.entryIndex : push(subagentEntry(run, openedAt));
    if (call !== undefined && launched !== undefined) replace(index, subagentEntry(run, openedAt));
    t.subagents.set(parentToolUseId, index);
    return index;
  };
  const changeFold = (t: TurnBuild, parentToolUseId: string, at: string, change: (run: SubagentRun) => SubagentRun): void => {
    const index = foldFor(t, parentToolUseId, at);
    const run = subagent(index);
    if (run === undefined) return;
    replace(index, subagentEntry(change(run), timeline[index]!.createdAt));
  };
  /** One line inside a fold, or a change to the one the same call already wrote: a subagent's tool call streams its
   * input and then its result, and both land on one line. */
  const addFoldLine = (t: TurnBuild, parentToolUseId: string, at: string, line: Omit<SubagentLine, "id" | "label"> & { label?: string }, key?: string): void => {
    changeFold(t, parentToolUseId, at, run => {
      const held = key === undefined ? -1 : run.lines.findIndex(l => l.id === key);
      if (held >= 0) {
        const lines = [...run.lines];
        // A call's result reaches the line its input opened and says only what it changes; the call's own words stand.
        lines[held] = { ...lines[held]!, ...line, label: line.label ?? lines[held]!.label, id: key! };
        return { ...run, lines };
      }
      return { ...run, lines: [...run.lines, { ...line, label: line.label ?? "", id: key ?? `${run.parentToolUseId}:l${run.lines.length}` }] };
    });
  };
  const closeOpenMessage = (t: TurnBuild): void => {
    if (t.openMessage === null) return;
    const m = message(t.openMessage);
    if (m && m.streaming) replace(t.openMessage, messageEntry({ ...m, streaming: false }));
    t.openMessage = null;
    t.openMessageId = null;
  };
  const addWork = (t: TurnBuild, entry: Omit<WorkLogEntry, "id" | "turnId">, at: string): number => {
    t.ordinal += 1;
    const full: WorkLogEntry = { ...entry, id: rowId(t.summary.turnId, "w", t.ordinal, entry.toolCallId), turnId: t.summary.turnId };
    return push({ id: full.id, kind: "work", createdAt: at, entry: full });
  };
  const addMessage = (t: TurnBuild, role: ChatMessage["role"], text: string, at: string, streaming: boolean, steered = false, carried?: Pick<ChatMessage, "attachments" | "requestId" | "sentOn">): number => {
    t.ordinal += 1;
    const m: ChatMessage = { id: rowId(t.summary.turnId, "m", t.ordinal), role, text, turnId: t.summary.turnId, streaming, createdAt: at, updatedAt: at, ...(steered ? { steered } : {}), ...carried };
    return push(messageEntry(m));
  };
  // The reply's content and cost, applied once at session.done; the state is set separately, so a turn whose process
  // lives past its reply keeps running until session.end.
  const applyResult = (t: TurnBuild, result: TurnResult, at: string): void => {
    closeOpenMessage(t);
    for (const call of t.tools.values()) {
      const w = work(call.entryIndex);
      if (w && w.toolLifecycleStatus === "inProgress") {
        replace(call.entryIndex, workEntry({ ...w, toolLifecycleStatus: "stopped" }, timeline[call.entryIndex]!.createdAt));
      }
    }
    // The harness ends the subagents it started when its turn ends, so a fold still running at the reply is one
    // whose launch never answered; a slot left reading nothing would say it is still working.
    for (const parentToolUseId of t.subagents.keys()) {
      changeFold(t, parentToolUseId, at, run => (run.state === "running" ? { ...run, state: "stopped", endedAt: at || null } : run));
    }
    if (result.status === "completed" && !t.sawText && result.text !== undefined && result.text.length > 0) {
      addMessage(t, "assistant", result.text, at, false);
    }
    // The failure's words stand as their own row; a failure with none leaves the turn's one word to say it. A turn the
    // agent's usage limit stopped is news, not a fault: the turn's footer and the strip over the composer say it, so no
    // row repeats the agent's words.
    if (result.status === "failed" && result.error !== undefined && result.limit === undefined) {
      addWork(t, { createdAt: at, label: result.error, tone: "error", sourceActivityKind: "runtime.error" }, at);
    }
    t.summary = {
      ...t.summary,
      durationMs: result.durationMs ?? null,
      waitedMs: result.waitedMs ?? null,
      costUsd: result.costUsd ?? null,
      tokens: result.tokens ?? null,
      model: result.model ?? t.summary.model,
      error: result.error ?? null,
      ...(result.unreached === true ? { unreached: true } : {}),
      limit: result.limit ?? null,
      completedAt: at || null,
    };
    turns[turns.length - 1] = t.summary;
  };
  const setState = (t: TurnBuild, status: TurnResult["status"]): void => {
    t.summary = { ...t.summary, state: turnState(status) };
    turns[turns.length - 1] = t.summary;
  };
  // A turn cut by the runtime (a restart, an exit with no reply): its result is both the reply and the end at once.
  const finishTurn = (t: TurnBuild, result: TurnResult, at: string): void => {
    applyResult(t, result, at);
    setState(t, result.status);
  };
  // session.done: the reply is in, the process may still be working, so record it and keep the turn running.
  const recordReply = (t: TurnBuild, result: TurnResult, at: string): void => {
    applyResult(t, result, at);
    t.reply = result;
    t.summary = { ...t.summary, replied: true };
    turns[turns.length - 1] = t.summary;
  };
  // A running turn a new start supersedes: one that already replied ended between here (its session.end unseen in a cut
  // transcript) and keeps its reply's status; one still working when it was cut is a failure.
  const endRunningTurn = (t: TurnBuild, at: string): void => {
    if (t.reply !== null) setState(t, t.reply.status);
    else finishTurn(t, { status: "failed", error: "session restarted before it finished" }, at);
  };

  const openTurn = (event: SessionEvent, turnId: string, count: number, at: string): TurnBuild => {
    const start = event.type === "session.start" ? event : null;
    const summary: TurnSummary = {
      turnId,
      sessionId: event.sessionId,
      state: "running",
      replied: false,
      prompt: start?.prompt ?? null,
      model: start?.model ?? null,
      durationMs: null,
      waitedMs: null,
      costUsd: null,
      tokens: null,
      changes: null,
      error: null,
      startedAt: at || null,
      completedAt: null,
      checkpoint: null,
      limit: null,
    };
    turns.push(summary);
    return { summary, startCount: count, ordinal: 0, openMessage: null, openMessageId: null, sawText: false, tools: new Map(), childCalls: new Map(), openAnonymousTool: null, subagents: new Map(), reply: null, planRow: null };
  };
  /** A delta, done or end whose turn never started here (history capped mid-turn) still needs a turn to hang on. */
  const turnFor = (event: SessionEvent, at: string): TurnBuild => {
    if (turn !== null && (event.turnId === undefined || event.turnId === turn.summary.turnId)) return turn;
    if (turn !== null && turn.summary.state === "running") endRunningTurn(turn, at);
    turn = openTurn(event, event.turnId ?? `${event.sessionId}#0`, 0, at);
    return turn;
  };

  const add = (event: SessionEvent, received?: string): void => {
    taken += 1;
    place = event.pos;
    const at = event.at !== undefined ? new Date(event.at).toISOString() : received ?? "";
    if (event.type === "session.start" && event.cwd !== undefined) cwd = event.cwd;
    if (event.type === "session.delta" && event.cwd !== undefined) shellCwd = event.cwd;
    switch (event.type) {
      case "session.start": {
        if (turn && turn.summary.state === "running") endRunningTurn(turn, at);
        const count = (startsBySession.get(event.sessionId) ?? 0) + 1;
        startsBySession.set(event.sessionId, count);
        modelName = event.model ?? modelName;
        harness = event.harness ?? harness;
        agent = event.agent ?? agent;
        permissionMode = event.permissionMode ?? permissionMode;
        turn = openTurn(event, event.turnId ?? `${event.sessionId}#${count}`, count, at);
        // Resume at reset's own words to the agent are nobody's message: the notice line below stands for them.
        if (event.prompt !== undefined && event.afterLimit === undefined) {
          addMessage(turn, "user", event.prompt, at, false, false, {
            ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
            ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
            ...(event.threadId !== undefined ? { sentOn: { workspaceId: event.workspaceId, threadId: event.threadId } } : {}),
          });
        }
        if (event.afterCut === true) addWork(turn, { createdAt: at, label: AFTER_CUT_LINE, tone: "notice", sourceActivityKind: "runtime.resume" }, at);
        if (event.afterLimit !== undefined) addWork(turn, { createdAt: at, label: LIMIT_WORDS.resumed, tone: "notice", sourceActivityKind: "runtime.resume" }, at);
        return;
      }
      case "session.delta": {
        applyDelta(turnFor(event, at), event, at);
        return;
      }
      case "session.steer": {
        const t = turnFor(event, at);
        closeOpenMessage(t);
        addMessage(t, "user", event.prompt, at, false, true, {
          ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
          ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
          ...(event.threadId !== undefined ? { sentOn: { workspaceId: event.workspaceId, threadId: event.threadId } } : {}),
        });
        return;
      }
      case "session.notify": {
        const t = turnFor(event, at);
        closeOpenMessage(t);
        const label = event.notify === NOTIFY_ME ? "told you" : `told thread ${event.notify.slice(0, 8)}`;
        addWork(t, { createdAt: at, label, detail: event.text, tone: "notice", sourceActivityKind: "runtime.notify" }, at);
        return;
      }
      case "session.permission": {
        const t = turnFor(event, at);
        closeOpenMessage(t);
        const permission: PermissionPrompt = {
          askId: event.askId,
          turnId: t.summary.turnId,
          sessionId: t.summary.sessionId,
          toolName: event.toolName,
          ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
          input: event.input,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          ...(event.parentToolUseId !== undefined ? { parentToolUseId: event.parentToolUseId } : {}),
          options: event.options,
          createdAt: at,
          outcome: null,
          optionId: null,
        };
        // A subagent's own prompt sits inside that subagent's fold, where the fold's title says who is asking; a
        // prompt in the flat stream says nothing about which of several running agents raised it.
        if (event.parentToolUseId !== undefined) {
          changeFold(t, event.parentToolUseId, at, run => ({ ...run, prompts: [...run.prompts, permission] }));
          promptRows.set(event.askId, t.subagents.get(event.parentToolUseId)!);
          return;
        }
        promptRows.set(event.askId, push({ id: `permission:${event.askId}`, kind: "permission", createdAt: at, permission }));
        return;
      }
      case "session.permission.closed": {
        const index = promptRows.get(event.askId);
        const row = index === undefined ? undefined : timeline[index];
        if (index === undefined || row === undefined) return;
        if (row.kind === "subagent") {
          replace(index, {
            ...row,
            subagent: {
              ...row.subagent,
              prompts: row.subagent.prompts.map(p =>
                p.askId === event.askId ? { ...p, outcome: event.outcome, optionId: event.optionId ?? null } : p,
              ),
            },
          });
          return;
        }
        if (row.kind !== "permission") return;
        replace(index, {
          ...row,
          permission: { ...row.permission, outcome: event.outcome, optionId: event.optionId ?? null },
        });
        return;
      }
      case "session.context": {
        const t = turnFor(event, at);
        t.summary = { ...t.summary, held: { context: event.context, ...(event.window !== undefined ? { window: event.window } : {}) } };
        turns[turns.length - 1] = t.summary;
        return;
      }
      case "session.compacted": {
        const t = turnFor(event, at);
        closeOpenMessage(t);
        addWork(t, { createdAt: at, label: compactedLine(event.before, event.after), tone: "compaction", sourceActivityKind: "harness.compaction" }, at);
        return;
      }
      case "session.changes": {
        const index = turns.findIndex(t => t.turnId === event.turnId);
        if (index === -1) return;
        const changes = { from: event.from, to: event.to, files: event.files, ...(event.others !== undefined ? { others: event.others } : {}), ...(event.shared === true ? { shared: true as const } : {}) };
        turns[index] = { ...turns[index]!, changes };
        if (turn !== null && turn.summary.turnId === event.turnId) turn.summary = turns[index]!;
        return;
      }
      case "session.plan": {
        const t = turnFor(event, at);
        const turnId = t.summary.turnId;
        // The list never enters the transcript: the composer's edge carries it while the turn runs.
        if (event.steps !== undefined) plans.set(turnId, nextPlan(plans.get(turnId), event.steps, at));
        if (event.text !== undefined) {
          const earlier = t.planRow === null ? undefined : timeline[t.planRow];
          const createdAt = earlier?.createdAt ?? at;
          const proposedPlan = { id: `plan:${turnId}`, turnId, planMarkdown: event.text, createdAt, updatedAt: at, implementedAt: null };
          const entry: TimelineEntry = { id: `plan:${turnId}`, kind: "proposed-plan", createdAt, proposedPlan };
          if (t.planRow !== null) replace(t.planRow, entry);
          else {
            closeOpenMessage(t);
            t.planRow = push(entry);
          }
        }
        return;
      }
      case "session.done": {
        recordReply(turnFor(event, at), event.result, at);
        return;
      }
      case "session.end": {
        // An end for a turn nothing here opened is the runtime's word that a send never became a turn, sent so a wait
        // on the thread is answered; it opens no turn, since the reply, the read and the wait all fold these rows and
        // would take it for the thread's latest. It still ends the turn it interrupted, a thread running one turn at a
        // time, and where it says why, that sentence is the only account that send will ever have, so it stands as a
        // row of its own rather than nowhere.
        if (turn === null || (event.turnId !== undefined && event.turnId !== turn.summary.turnId)) {
          if (turn !== null && turn.summary.state === "running") endRunningTurn(turn, at);
          if (event.reason !== undefined) {
            push(workEntry({ id: `refusal:${event.turnId ?? event.sessionId}`, turnId: event.turnId ?? null, createdAt: at, label: event.reason, tone: "error", sourceActivityKind: "runtime.error" }, at));
          }
          return;
        }
        const t = turn;
        if (t.summary.state !== "running") return;
        if (t.reply !== null) {
          setState(t, t.reply.status);
        } else {
          const error = event.reason ?? (event.sawResult
            ? "session exited without a result"
            : `session exited without a result (exit code ${event.exitCode ?? "unknown"})`);
          finishTurn(t, { status: "failed", error }, at);
        }
        return;
      }
      case "session.run":
        runs.set(event.block, event);
        return;
      case "session.moved":
      case "session.behind":
      case "session.capped":
      case "session.subagent":
        return;
      case "session.slate": {
        // One line per turn however many writes it made; a person's write and the host's draw none.
        if (event.by !== "agent") return;
        if (turn !== null && turn.summary.turnId === event.turnId) {
          turn.summary = { ...turn.summary, slated: true };
          turns[turns.length - 1] = turn.summary;
          return;
        }
        const at = turns.findIndex(t => t.turnId === event.turnId);
        if (at >= 0) turns[at] = { ...turns[at]!, slated: true };
        return;
      }
      case "session.checkpoint": {
        // Taken once the turn is over, so a later turn may already be open: the row goes on its own turn's summary.
        const at = turns.findIndex(t => t.turnId === event.turnId);
        if (at < 0) return;
        const kept = { ...turns[at]!, checkpoint: { ref: event.ref ?? null, anchor: event.anchor ?? null, ...(event.kept !== undefined ? { kept: event.kept } : {}) } };
        turns[at] = kept;
        if (turn !== null && turn.summary.turnId === event.turnId) turn.summary = kept;
        return;
      }
      default: {
        const _exhaustive: never = event;
        return;
      }
    }
  }

  /** Every line a subagent wrote, inside its own fold. Read before the parent's own rules so a child's prose never
   * reaches the parent's open message: two agents writing at once would otherwise land in one paragraph with no
   * space between their sentences. */
  function applyChildDelta(t: TurnBuild, e: SessionDelta, at: string, parent: string): void {
    switch (e.kind) {
      case "text":
      case "thinking":
        addFoldLine(t, parent, at, { createdAt: at, kind: e.kind, label: e.text });
        return;
      case "tool_use": {
        const key = foldLineKey(parent, e.toolUseId);
        // The call as it stands, kept beside the line it opens: its result carries none of its own input, and both
        // the line and the past it turns into are written off that input alone.
        const open = key === undefined ? undefined : t.childCalls.get(key);
        const call = { name: e.toolName ?? open?.name ?? "tool", input: (open?.input ?? "") + e.text };
        if (key !== undefined) t.childCalls.set(key, call);
        addFoldLine(t, parent, at, { createdAt: at, kind: "tool", label: toolActivityLine(call.name, call.input), status: "inProgress", call }, key);
        return;
      }
      case "note":
        addFoldLine(t, parent, at, { createdAt: at, kind: "text", label: e.text });
        return;
      case "tool_result": {
        const key = foldLineKey(parent, e.toolUseId);
        const call = key === undefined ? undefined : t.childCalls.get(key);
        const did = call === undefined || e.isError === true ? undefined : toolDoneLine(call.name, call.input);
        addFoldLine(
          t,
          parent,
          at,
          {
            createdAt: at,
            kind: "tool",
            status: e.isError === true ? "failed" : "completed",
            ...(did !== undefined ? { label: did } : {}),
            ...(toolResultLine(e.text, e.isError === true) !== undefined ? { detail: toolResultLine(e.text, e.isError === true)! } : {}),
          },
          key,
        );
        if (key !== undefined) t.childCalls.delete(key);
        return;
      }
      default: {
        const _exhaustive: never = e.kind;
        return;
      }
    }
  }

  function applyDelta(t: TurnBuild, e: SessionDelta, at: string): void {
    if (e.parentToolUseId !== undefined) {
      closeOpenMessage(t);
      applyChildDelta(t, e, at, e.parentToolUseId);
      return;
    }
    // The launching call's own result closes the fold. Where the harness marked that result its own note to the
    // agent it neither draws nor ends anything: it is written to a model, carries handles no person needs, and says
    // a background agent was launched rather than that it finished. Where it is the subagent's answer it is the last
    // line inside the fold, which is where that subagent's work is read.
    if (e.kind === "tool_result" && e.toolUseId !== undefined && t.subagents.has(e.toolUseId)) {
      if (internalToolResult(e.text)) return;
      const answer = toolResultLine(e.text, e.isError === true);
      if (answer !== undefined) addFoldLine(t, e.toolUseId, at, { createdAt: at, kind: "text", label: answer, answer: true });
      const failure = e.isError === true ? toolResultLine(e.text) : undefined;
      changeFold(t, e.toolUseId, at, run => ({ ...run, state: e.isError === true ? "failed" : "done", endedAt: at || null, ...(failure === undefined ? {} : { failure }) }));
      t.tools.delete(e.toolUseId);
      return;
    }
    switch (e.kind) {
      case "text": {
        // Text of another of the harness's messages is a bubble of its own, the rule messageId carries.
        if (t.openMessageId !== null && e.messageId !== undefined && e.messageId !== t.openMessageId) closeOpenMessage(t);
        const open = t.openMessage !== null ? message(t.openMessage) : undefined;
        if (t.openMessage !== null && open) {
          replace(t.openMessage, messageEntry({ ...open, text: open.text + e.text, updatedAt: at || open.updatedAt }));
        } else {
          t.openMessage = addMessage(t, "assistant", e.text, at, true);
          t.openMessageId = e.messageId ?? null;
        }
        t.sawText = true;
        return;
      }
      case "note": {
        // The harness's own line about itself, shown the way the resumed-past-a-cut line is: a notice beside the
        // work, never a message under the agent's name and never a failure. It ends no message of the agent's, as
        // it ends none in the read and none on the terminal's stream.
        addWork(t, { createdAt: at, label: e.text, tone: "notice", sourceActivityKind: "harness.note" }, at);
        return;
      }
      case "thinking": {
        closeOpenMessage(t);
        const last = timeline[timeline.length - 1];
        if (last?.kind === "work" && last.entry.tone === "thinking" && last.entry.turnId === t.summary.turnId) {
          replace(timeline.length - 1, workEntry(thinkingEntry(last.entry, (last.entry.detail ?? "") + e.text), last.createdAt));
          return;
        }
        addWork(t, thinkingEntry({ createdAt: at, label: "Thinking", tone: "thinking", sourceActivityKind: "reasoning" }, e.text), at);
        return;
      }
      case "tool_use": {
        closeOpenMessage(t);
        const key = e.toolUseId ?? (t.openAnonymousTool !== null ? `anon:${t.openAnonymousTool}` : undefined);
        const existing = key !== undefined ? t.tools.get(key) : undefined;
        const existingEntry = existing ? work(existing.entryIndex) : undefined;
        if (existing && existingEntry && existingEntry.toolLifecycleStatus === "inProgress") {
          existing.input += e.text;
          const arriving = e.toolName ?? existingEntry.label;
          const grown = toolCallFacts(arriving, existing.input);
          const named = grown.title ?? arriving;
          replace(existing.entryIndex, workEntry({ ...existingEntry, label: named, toolTitle: named, ...grown }, timeline[existing.entryIndex]!.createdAt));
          return;
        }
        const toolName = e.toolName ?? "tool";
        const facts = toolCallFacts(toolName, e.text);
        const named = facts.title ?? toolName;
        const base: WorkLogEntry = {
          id: "", turnId: null, createdAt: at, label: named, toolTitle: named, tone: "tool",
          toolLifecycleStatus: "inProgress", sourceActivityKind: "tool.started",
          ...(e.toolUseId !== undefined ? { toolCallId: e.toolUseId } : {}),
        };
        const index = addWork(t, { ...base, ...facts }, at);
        const registryKey = e.toolUseId ?? `anon:${index}`;
        t.tools.set(registryKey, { entryIndex: index, ...(e.toolName !== undefined ? { name: e.toolName } : {}), input: e.text });
        if (e.toolUseId === undefined) t.openAnonymousTool = index;
        return;
      }
      case "tool_result": {
        closeOpenMessage(t);
        const key = e.toolUseId ?? (t.openAnonymousTool !== null ? `anon:${t.openAnonymousTool}` : undefined);
        const call = key !== undefined ? t.tools.get(key) : undefined;
        const entry = call ? work(call.entryIndex) : undefined;
        const note = internalToolResult(e.text);
        const output = note ? undefined : summarizeOutput(e.text);
        if (!call || !entry) {
          addWork(t, {
            createdAt: at, label: e.toolName ?? "tool", toolTitle: e.toolName ?? "tool", tone: "tool",
            ...(e.toolUseId !== undefined ? { toolCallId: e.toolUseId } : {}),
            toolLifecycleStatus: e.isError ? "failed" : "completed", sourceActivityKind: "tool.completed",
            ...(output !== undefined ? { detail: output } : {}),
          }, at);
          return;
        }
        const failed = e.isError === true || entry.toolLifecycleStatus === "failed";
        if (!note) call.answered = { at, failed };
        // A thread or a machine the lead asked for and was refused, by a cap or any other refusal, is the lead's to read
        // and the person's to see: the refusal stands as an error row, whole, where a folded call would hide it.
        const refused = e.isError === true && call.name !== undefined && spawnsThread(call.name) ? compactLines(e.text)[0] : undefined;
        if (refused !== undefined) {
          const row: WorkLogEntry = { id: entry.id, turnId: entry.turnId, createdAt: entry.createdAt, label: refused, tone: "error", toolLifecycleStatus: "failed", sourceActivityKind: "tool.completed", ...(entry.toolCallId !== undefined ? { toolCallId: entry.toolCallId } : {}) };
          replace(call.entryIndex, workEntry(row, timeline[call.entryIndex]!.createdAt));
          if (e.toolUseId === undefined) t.openAnonymousTool = null;
          return;
        }
        const spawned = failed ? undefined : spawnedThreadOf(call.name, entry.command, e.text);
        replace(call.entryIndex, workEntry({
          ...entry,
          toolLifecycleStatus: failed ? "failed" : "completed",
          sourceActivityKind: "tool.completed",
          ...(output !== undefined ? { detail: output } : {}),
          ...(spawned !== undefined ? { spawned } : {}),
        }, timeline[call.entryIndex]!.createdAt));
        if (e.toolUseId === undefined) t.openAnonymousTool = null;
        return;
      }
      default: {
        const _exhaustive: never = e.kind;
        return;
      }
    }
  }

  /** The runs as a new map only when one moved, so a reader keyed on the map redraws when a run does and not on every
   * event. */
  let runsSeen = new Map(runs);
  const model = (): SessionModel => {
    const open = turn as TurnBuild | null;
    const running = open !== null && open.summary.state === "running";
    const messages: ChatMessage[] = [];
    const workEntries: WorkLogEntry[] = [];
    for (const entry of timeline) {
      if (entry.kind === "message") messages.push(entry.message);
      else if (entry.kind === "work") workEntries.push(entry.entry);
    }
    const latestTurn = turns[turns.length - 1] ?? null;
    const latestPlan = latestTurn === null ? undefined : plans.get(latestTurn.turnId);
    const plan = latestTurn === null || latestPlan === undefined ? null : { turnId: latestTurn.turnId, steps: latestPlan.steps };
    if (runsSeen.size !== runs.size || [...runs].some(([block, run]) => runsSeen.get(block) !== run)) runsSeen = new Map(runs);
    return { turns: [...turns], messages, workEntries, timeline: [...timeline], latestTurn, running, model: modelName, harness, agent, permissionMode, cwd, shellCwd, runs: runsSeen, plan };
  };
  return { add, model, size: () => taken };
}

/** The fold of one subagent in a lead's transcript, by the call that launched it; null where none is in view. */
export function subagentRunOf(entries: ReadonlyArray<TimelineEntry>, call: string): SubagentRun | null {
  const entry = entries.find(e => e.kind === "subagent" && e.subagent.parentToolUseId === call);
  return entry?.kind === "subagent" ? entry.subagent : null;
}

/** Whether the call that launched a subagent is in view: its fold with what it was asked, or the call's own row. */
export function launchIn(entries: ReadonlyArray<TimelineEntry>, call: string): boolean {
  return entries.some(e => (e.kind === "subagent" && e.subagent.parentToolUseId === call && e.subagent.prompt !== null) || (e.kind === "work" && e.entry.toolCallId === call));
}

/** A subagent as a listing would carry it, read off its own fold, for a page whose lead's listing does not carry it. */
export function subagentOfRun(run: SubagentRun): SubagentView {
  const failure = run.state === "failed" ? run.failure : undefined;
  const ended = run.endedAt === null ? undefined : Date.parse(run.endedAt);
  return {
    id: run.parentToolUseId,
    parentToolUseId: run.parentToolUseId,
    title: run.title,
    state: run.state,
    startedAt: Date.parse(run.startedAt),
    ...(ended === undefined || Number.isNaN(ended) ? {} : { endedAt: ended }),
    ...(failure === undefined ? {} : { failure }),
  };
}

/** A subagent's own page, read off its fold in the lead's transcript: what its lead asked it as a person's message,
 * then its lines as a thread's own are drawn, its prose as the agent's, its calls as work rows, and the questions its
 * run raised. No entry belongs to a turn, so the page draws no turn's fold, working row or stop line: its bar says
 * those. A fold not read yet leaves the prompt the listing carries. The launching call's answer is the first line of
 * a done run's own last words, and a failed run's bar says it; it stands only where the run said nothing itself or
 * where it is the mark of the stop that cut the run. */
export function subagentEntries(run: SubagentRun | null, asked: string | null, state: SubagentView["state"] | null): TimelineEntry[] {
  const id = run?.parentToolUseId ?? "subagent";
  const prompt = run?.prompt ?? asked;
  const at = run?.startedAt ?? "";
  const out: TimelineEntry[] = [];
  if (prompt !== null) out.push(messageEntry({ id: `${id}:asked`, role: "user", text: prompt, turnId: null, streaming: false, createdAt: at, updatedAt: at }));
  const spoke = run?.lines.some(line => line.kind === "text" && line.answer !== true) === true;
  const keepsAnswer = state === "stopped" || (state !== "failed" && !spoke);
  for (const line of run?.lines ?? []) {
    if (line.answer === true && !keepsAnswer) continue;
    if (line.kind === "text") out.push(messageEntry({ id: line.id, role: "assistant", text: line.label, turnId: null, streaming: false, createdAt: line.createdAt, updatedAt: line.createdAt }));
    else if (line.kind === "thinking") out.push(workEntry({ id: line.id, turnId: null, ...thinkingEntry({ createdAt: line.createdAt, label: "Thinking", tone: "thinking", sourceActivityKind: "reasoning" }, line.label) }, line.createdAt));
    else out.push(workEntry(subagentCall(line), line.createdAt));
  }
  for (const permission of run?.prompts ?? []) out.push({ id: `permission:${permission.askId}`, kind: "permission", createdAt: permission.createdAt, permission });
  return out;
}

/** One of a subagent's tool lines as the work row the thread's own call would be: named and grouped by its call. */
function subagentCall(line: SubagentLine): WorkLogEntry {
  const facts = line.call === undefined ? {} : toolCallFacts(line.call.name, line.call.input);
  const named = facts.title ?? line.call?.name ?? line.label;
  return {
    id: line.id,
    turnId: null,
    createdAt: line.createdAt,
    label: named,
    toolTitle: named,
    tone: "tool",
    sourceActivityKind: line.status === "inProgress" ? "tool.started" : "tool.completed",
    ...(line.status !== undefined ? { toolLifecycleStatus: line.status } : {}),
    ...facts,
    ...(line.detail !== undefined ? { detail: line.detail } : {}),
  };
}

/** Reasoning renders as one collapsed line (preview) that opens onto the text (detail). */
function thinkingEntry<T extends Omit<WorkLogEntry, "id" | "turnId" | "detail" | "preview">>(base: T, text: string): T & Pick<WorkLogEntry, "detail" | "preview"> {
  const preview = summarizeOutput(text);
  return { ...base, detail: text, ...(preview !== undefined ? { preview } : {}) };
}

/** The line one of a subagent's tool calls owns inside its fold; a call with no id of its own takes a line of its
 * own rather than overwriting the last. */
function foldLineKey(parent: string, toolUseId: string | undefined): string | undefined {
  return toolUseId === undefined ? undefined : `${parent}:t${toolUseId}`;
}

function messageEntry(m: ChatMessage): TimelineEntry {
  return { id: m.id, kind: "message", createdAt: m.createdAt, message: m };
}

function workEntry(w: WorkLogEntry, createdAt: string): TimelineEntry {
  return { id: w.id, kind: "work", createdAt, entry: w };
}

function turnState(status: TurnResult["status"]): TurnState {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "error";
    default: {
      const _exhaustive: never = status;
      return "error";
    }
  }
}

function compactLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(line => line.length > 0);
}

/** Whether a prompt is one nobody has answered. Written once because three surfaces ask it and each of them says
 * something different when it is true: the prompt row offers its options, the thread's row and header say the
 * thread needs the person, and the elapsed count says the thread is waiting rather than working. */
export function isPromptOpen(permission: Pick<PermissionPrompt, "outcome">): boolean {
  return permission.outcome === null;
}

/** The line a row shows for a command: its first non-empty line, whole; the row's width cuts it. */
export function commandFirstLine(command: string): string {
  return compactLines(command)[0] ?? command.trim();
}

/** First non-empty line, cut to 84 characters like t3code's inline preview; fence-only output has nothing to show. */
export function summarizeOutput(text: string): string | undefined {
  const lines = compactLines(text);
  const first = lines.find(line => line !== "```");
  if (first === undefined) return lines.length > 1 ? `${lines.length} lines` : undefined;
  return first.length <= 84 ? first : `${first.slice(0, 83).trimEnd()}…`;
}
