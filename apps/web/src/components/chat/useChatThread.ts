// SPDX-License-Identifier: AGPL-3.0-only
// One workspace's chat thread: the thread pinned from the sidebar, or the
// last one of the persisted transcript, replayed from sessions.history on
// mount, then that thread's live session.* events appended. Live events are
// ignored until the history reply lands, because the socket is FIFO:
// anything pushed before the reply is already in it, anything after is not.
// The adapter derives the view; this hook only keeps the event list, the
// arrival clock for unstamped events, and the things the wire cannot know
// yet: a prompt the user just sent, a send that failed locally, a new
// thread requested while a turn was still running, and a send still in
// flight when the person moved to another thread, with the key its rows
// wait under. The composer's stop reaches only the turn it shows and the
// runtime has no per-workspace guard, so that turn keeps running unseen and
// the composer stays closed until its end arrives.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionEvent, SessionHarness, SessionView } from "@wsp/protocol";
import { useProtocolEvents, useStore } from "../../protocol/store";
import type { ProtocolEvent } from "../../protocol/client";
import { deriveSession, type TimelineEntry, type TurnSummary } from "./adapt";

export interface ChatThreadView {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly turns: ReadonlyArray<TurnSummary>;
  readonly latestTurn: TurnSummary | null;
  readonly running: boolean;
  readonly activeTurnStartedAt: string | null;
  /** The latest turn once it has settled; null while it runs or before any turn. */
  readonly settled: TurnSummary | null;
  /** The folder the thread's harness runs in, as its last session.start named it, or, with no start in view, as the
   * row the next send resumes carries: the strip shows it and the send runs there. */
  readonly cwd: string | null;
  /** Where the agent's tool shell last was, as its tool calls moved it; null until one did. */
  readonly shellCwd: string | null;
  /** What the last session.start announced about the CLI; the composer's catalog reads it. */
  readonly harness: SessionHarness | null;
  readonly model: string | null;
}

export interface ChatThreadHandle {
  readonly view: ChatThreadView;
  /** False until the history reply for this workspace has landed. */
  readonly hydrated: boolean;
  /** True while a turn is running, a send is in flight, or a left turn is still finishing. */
  readonly busy: boolean;
  /** True from a send until its session.start lands (or its turn ends without one). */
  readonly sending: boolean;
  /** True from a new-thread request until its first session.start: the next send must not resume the old session. */
  readonly fresh: boolean;
  /** The harness session the next send resumes: the shown thread's last started turn, else, on an empty latest view, the workspace's remembered one, else, pinned, the one its session row carries; none while fresh. */
  readonly resume: string | undefined;
  /** True while the turn a new thread left behind is still running on the machine. */
  readonly finishing: boolean;
  /** The held thread's runtime id, else the pinned one, else the workspace id before the thread has one; keys what belongs to this thread outside the transcript. */
  readonly threadKey: string;
  /** The last send's start, once it landed: the key its rows waited under (the thread id the view held or was pinned to, or the workspace id before the thread had one) and the thread that start carried. Null while a send is in flight, after one that settled without a start, and before any. */
  readonly named: NamedStart | null;
  /** Optimistic user message for a send, with the request id the send carries; the session.start stamped with it replaces it. */
  readonly appendUserTurn: (prompt: string, requestId: string) => void;
  /** A send that failed before the runtime emitted anything. */
  readonly appendLocalError: (message: string) => void;
  readonly setSending: (sending: boolean) => void;
  /** Clears the visible thread and marks the next send as a fresh session. */
  readonly startNewThread: () => void;
}

/** The turn a new thread left behind: known by id, or still the send whose session.start has not landed, with the turn that had settled when it began. */
export type StaleTurn =
  | { readonly kind: "turn"; readonly turnId: string | undefined; readonly sessionId: string }
  | { readonly kind: "pending-send"; readonly after: string | undefined };

/** Where a send's rows waited and where its start took them. */
export interface NamedStart {
  readonly key: string;
  readonly thread: string;
}

/** A send as this client made it: its text, and the request id it carried, which the runtime stamps on the start it opens. */
export interface Sent {
  readonly text: string;
  readonly requestId: string;
}

export interface ThreadState {
  readonly events: ReadonlyArray<SessionEvent>;
  readonly arrivals: ReadonlyArray<string>;
  readonly pendingPrompt: (Sent & { readonly at: string }) | null;
  readonly localErrors: ReadonlyArray<{ message: string; at: string }>;
  readonly fresh: boolean;
  readonly stale: StaleTurn | null;
  /** A send in flight, with the turn that had settled when it began, until its session.start lands or a reload rebuilds this. */
  readonly sending: { readonly after: string | undefined } | null;
  /** Thread id of the transcript a new-thread request left: the one thread that can hold the turn a fresh view waits on. */
  readonly left: string | undefined;
  /** Every thread id the history reply carried, this view or the one before it in this workspace held, or the wire showed and this view dropped; while fresh, an event from none of them is the person's own send. */
  readonly known: ReadonlyArray<string>;
  /** The last send's start once it landed: the key its rows waited under (the thread id the view held or was pinned to, or the workspace id without one) and the thread the start carried. Null from the send until then, and after a send that settled without a start. */
  readonly named: NamedStart | null;
  /** A send from a view without a start, left in flight by a view change: the key its rows wait under (the pin, or the workspace id from the latest view) and the send itself, whose start still names those rows from whichever view sees it. */
  readonly stray: (Sent & { readonly key: string }) | null;
}

const EMPTY: ThreadState = { events: [], arrivals: [], pendingPrompt: null, localErrors: [], fresh: false, stale: null, sending: null, left: undefined, known: [], named: null, stray: null };
const SESSION_TYPES: ReadonlySet<string> = new Set(["session.start", "session.delta", "session.done", "session.end", "session.steer"]);
const now = () => new Date().toISOString();

function isSessionEvent(e: ProtocolEvent): e is SessionEvent {
  return SESSION_TYPES.has(e.type);
}

function append(state: ThreadState, e: SessionEvent, at: string): ThreadState {
  const starts = e.type === "session.start";
  return {
    ...state,
    events: [...state.events, e],
    arrivals: [...state.arrivals, at],
    pendingPrompt: starts ? null : state.pendingPrompt,
    fresh: starts ? false : state.fresh,
  };
}

/** The running turn of an event list, as the stale turn a new thread would leave behind. */
function runningTurn(events: ReadonlyArray<SessionEvent>): StaleTurn | null {
  const live = deriveSession(events).latestTurn;
  if (live === null || live.state !== "running") return null;
  const start = events.findLast(e => e.type === "session.start");
  return { kind: "turn", turnId: start?.turnId, sessionId: live.sessionId };
}

/** The thread ids a list of events carries, each once, in first appearance order. */
function threadIds(events: ReadonlyArray<SessionEvent>): string[] {
  return [...new Set(events.flatMap(e => (e.threadId === undefined ? [] : [e.threadId])))];
}

function knowing(known: ReadonlyArray<string>, events: ReadonlyArray<SessionEvent>): ReadonlyArray<string> {
  const more = threadIds(events).filter(id => !known.includes(id));
  return more.length === 0 ? known : [...known, ...more];
}

/** The last thread of a transcript: every event sharing the last event's thread id, a missing id being its own value. */
function lastThread(events: ReadonlyArray<SessionEvent>): SessionEvent[] {
  const id = events.at(-1)?.threadId;
  return events.filter(e => e.threadId === id);
}

/**
 * The history reply, folded to the selected thread, or to its last thread when none is. A send in flight
 * decides otherwise: a view with a start keeps its own thread, since that send resumes it and another
 * thread's start in the reply is another client's, while a view that never started takes the thread whose
 * start carries the prompt it sent, since nothing resumes a dead thread and that send opened a new one, and
 * stays where it was until the reply shows it, since any other new thread may be another client's. A
 * new-thread request that landed while history was in flight wins over the transcript it asked to leave,
 * unless the transcript already holds the thread that request opened, told the same way. Only the left
 * thread, or one the view never knew, can hold a stale turn, whether or not the person's thread is present;
 * a send whose session.start the transcript cannot hold yet stays pending, its prompt still shown.
 */
export function reloadTranscript(s: ThreadState, events: ReadonlyArray<SessionEvent>, at: string, threadId: string | null = null): ThreadState {
  const own = foldTo(s, events, threadId);
  const thread = own === undefined ? lastThread(events) : own === null ? [] : events.filter(e => e.threadId === own);
  const arrivals = thread.map(() => at);
  const known = knowing(s.known, events);
  const strayed = replayStray(s, events);
  const rebuilt = (stale: StaleTurn | null): ThreadState => {
    const send = replaySend(s, thread, threadId);
    return { ...EMPTY, events: thread, arrivals, stale, known, stray: s.stray, pendingPrompt: send.sending === null ? null : s.pendingPrompt, ...send, ...strayed };
  };
  if (!s.fresh) return rebuilt(null);
  if (s.stale?.kind === "pending-send") return { ...s, stale: runningTurn(events.filter(e => leftOrOwn(s, e))) ?? s.stale, known, ...strayed };
  const stale = runningTurn(events.filter(e => e.threadId === s.left));
  if (thread.length > 0) return rebuilt(stale);
  return { ...s, stale, known, ...strayed };
}

/**
 * The thread a reply folds to: undefined for its last one, null for none. Idle, the pin, else the last thread,
 * or, fresh, only the dead thread of a send that already settled here. During a send, a view with a start keeps
 * it; one without takes the thread its send opened, else keeps the pin or the start-less thread it showed.
 */
function foldTo(s: ThreadState, events: ReadonlyArray<SessionEvent>, threadId: string | null): string | null | undefined {
  const shown = s.events.length === 0 ? null : s.events.at(-1)?.threadId;
  if (s.sending === null) return s.fresh ? shown : threadId ?? undefined;
  return heldThreadId(s) ?? sentThread(s, events) ?? threadId ?? shown;
}

/** The thread the send in flight opened, as a reply shows it: the one whose start carries the sent prompt, else one the view never knew with no start at all, its harness dead before init. */
function sentThread(s: ThreadState, events: ReadonlyArray<SessionEvent>): string | undefined {
  const start = events.find(e => startsSend(s, e));
  if (start !== undefined) return start.threadId;
  return threadIds(events).findLast(id => !s.known.includes(id) && !events.some(e => e.type === "session.start" && e.threadId === id));
}

/** What a replayed thread did with the send in flight, read the way live events would settle it: the events past the turn that had settled when it began. */
function replaySend(s: ThreadState, thread: ReadonlyArray<SessionEvent>, pinned: string | null): Pick<ThreadState, "sending" | "named"> {
  if (s.sending === null) return { sending: null, named: null };
  const { after } = s.sending;
  const held = heldThreadId(s);
  const since = thread.slice(thread.findLastIndex(e => e.turnId === after) + 1);
  const start = since.find(e => e.type === "session.start" && (held !== undefined || startsSend(s, e)));
  if (start !== undefined) return { sending: null, named: nameOf(held ?? pinned ?? start.workspaceId, start) };
  return since.some(e => e.type === "session.end") ? { sending: null, named: null } : { sending: s.sending, named: null };
}

/** What a reply did with a send a view change left in flight, read the way the dropped live events would have settled it. */
function replayStray(s: ThreadState, events: ReadonlyArray<SessionEvent>): Partial<Pick<ThreadState, "stray" | "named">> {
  if (s.stray === null) return {};
  const folded = events.reduce<ThreadState>((st, e) => (st.stray === null ? st : dropEvent(st, e)), { ...s, named: null });
  if (folded.stray !== null) return {};
  return folded.named === null ? { stray: null } : { stray: null, named: folded.named };
}

function nameOf(key: string, start: SessionEvent): NamedStart {
  return { key, thread: start.threadId ?? start.workspaceId };
}

function belongsToStale(stale: Extract<StaleTurn, { kind: "turn" }>, e: SessionEvent): boolean {
  return e.turnId !== undefined && stale.turnId !== undefined ? e.turnId === stale.turnId : e.sessionId === stale.sessionId;
}

/** The view's last session.start: what its thread is held and resumed by. A harness that dies before its start leaves events under ids no start announced, and those name nothing. */
function lastStart(events: ReadonlyArray<SessionEvent>): SessionEvent | undefined {
  return events.findLast(e => e.type === "session.start");
}

function heldThreadId(state: ThreadState): string | undefined {
  return lastStart(state.events)?.threadId;
}

/** An event from no thread the view knows is the person's own send: the runtime mints its id at the start, and a harness that dies before init carries it too. */
function unknownThread(state: ThreadState, e: SessionEvent): boolean {
  return e.threadId === undefined || !state.known.includes(e.threadId);
}

/** An event of the thread a pending send left, or of a thread the view never knew: the send's own harness, whose start the view has not seen. */
function leftOrOwn(state: ThreadState, e: SessionEvent): boolean {
  return unknownThread(state, e) || e.threadId === state.left;
}

/** The start a send opened: the one the runtime stamped with the send's request id, or, when the start carries none (a client that sent none), the one carrying the send's text. By thread id alone two clients' starts look the same, and by text so do two clients sending the same words at once. */
function startOf(sent: Sent, e: SessionEvent): boolean {
  if (e.type !== "session.start") return false;
  return e.requestId !== undefined ? e.requestId === sent.requestId : e.prompt === sent.text;
}

/** The start of the send a view change left in flight: under a thread the view never knew, or, resumed from its row, under the thread its rows wait under. */
function startsStray(state: ThreadState, e: SessionEvent): boolean {
  const { stray } = state;
  return stray !== null && startOf(stray, e) && (unknownThread(state, e) || e.threadId === stray.key);
}

/** The start of the send in flight on this view, under a thread the view never knew. */
function startsSend(state: ThreadState, e: SessionEvent): boolean {
  return state.sending !== null && state.pendingPrompt !== null && unknownThread(state, e) && startOf(state.pendingPrompt, e);
}

/** An event of the send in flight on a view without a start: its own start, or the done and end of a thread the view never knew, its harness dying before it could start. A start with another prompt, a delta or a steer is another client's thread. */
function sentEvent(state: ThreadState, e: SessionEvent): boolean {
  if (state.sending === null) return false;
  if (e.type === "session.start") return startsSend(state, e);
  return (e.type === "session.done" || e.type === "session.end") && unknownThread(state, e);
}

/**
 * An event the view does not hold. While a send a view change left in flight waits for its start, that
 * start names the rows under the stray's key; a thread the view never knew ending without one is that
 * send's harness dying before init, and its done alone keeps waiting for the end. Every other event
 * only makes its thread known, so a thread another client opened after this view's history cannot pass
 * for the person's own send later.
 */
export function dropEvent(state: ThreadState, e: SessionEvent): ThreadState {
  if (state.stray !== null && startsStray(state, e)) return { ...state, stray: null, named: nameOf(state.stray.key, e) };
  if (state.stray !== null && unknownThread(state, e)) {
    if (e.type === "session.end") return { ...state, stray: null };
    if (e.type === "session.done") return state;
  }
  const known = knowing(state.known, [e]);
  return known === state.known ? state : { ...state, known };
}

/**
 * A view holds one thread: once its events carry a thread id, another thread's events are not its own. Fresh, it
 * holds only its send's own events, or the start of a new thread a send left in flight before it opened; a known
 * thread waking is not its own, whether it was left, older, or resumed by that send. A view whose thread never started (a harness that died before init, read
 * back from history) holds that thread, told by its events or by the pin, and, while a send is in flight, the
 * thread the runtime mints for the send, since nothing resumes a dead thread. An empty view idle takes anything.
 */
function inHeldThread(state: ThreadState, e: SessionEvent, pinned: string | null): boolean {
  if (state.fresh) return sentEvent(state, e) || (startsStray(state, e) && unknownThread(state, e));
  const held = heldThreadId(state);
  if (held !== undefined) return e.threadId === held;
  const last = state.events.at(-1)?.threadId ?? pinned ?? undefined;
  if (state.sending !== null) return e.threadId === last || sentEvent(state, e);
  return last === undefined || e.threadId === last;
}

/**
 * Applies one live event; returns the same state object when the event belongs to the turn a new thread left
 * or to a thread already known. A send ends at its session.start, or at a session.end of some other turn than
 * the one that had settled when it began: that turn's own end still trails its done, which already opened the
 * composer, while a harness that dies before init produces only a done and an end under a new turn id. A
 * pending send left behind ends the same way, from a thread the view never knew or from the left one it
 * resumed; a start or a delta seen while it waits is some other thread's, since its own harness has not
 * started, and is remembered so that thread's end cannot pass for its own.
 */
export function reduceEvent(state: ThreadState, e: SessionEvent, at: string, pinned: string | null = null): ThreadState {
  const { stale } = state;
  if (stale !== null) {
    if (stale.kind === "pending-send") {
      const known = e.type === "session.start" || e.type === "session.delta" || e.type === "session.steer" ? knowing(state.known, [e]) : state.known;
      if (e.type === "session.start") return { ...state, known, stale: { kind: "turn", turnId: e.turnId, sessionId: e.sessionId } };
      if (e.type === "session.end" && leftOrOwn(state, e) && e.turnId !== stale.after) return { ...state, stale: null };
      return known === state.known ? state : { ...state, known };
    }
    if (belongsToStale(stale, e)) return e.type === "session.end" ? { ...state, stale: null } : state;
  }
  if (!inHeldThread(state, e, pinned)) return dropEvent(state, e);
  const next = append(state, e, at);
  if (state.sending === null) return state.stray !== null && startsStray(state, e) ? { ...next, stray: null, named: nameOf(state.stray.key, e) } : next;
  const starts = e.type === "session.start";
  const settles = starts || (e.type === "session.end" && e.turnId !== state.sending.after);
  const named = starts ? nameOf(heldThreadId(state) ?? pinned ?? e.workspaceId, e) : state.named;
  return settles ? { ...next, sending: null, named } : next;
}

function shallowEqual(a: object, b: object): boolean {
  const entries = Object.entries(a);
  if (entries.length !== Object.keys(b).length) return false;
  return entries.every(([key, value]) => {
    const other: unknown = Reflect.get(b, key);
    if (value === other) return true;
    return Array.isArray(value) && Array.isArray(other) && value.length === other.length && value.every((item, i) => item === other[i]);
  });
}

function sameEntry(a: TimelineEntry, b: TimelineEntry): boolean {
  if (a.createdAt !== b.createdAt) return false;
  if (a.kind === "message" && b.kind === "message") return shallowEqual(a.message, b.message);
  if (a.kind === "work" && b.kind === "work") return shallowEqual(a.entry, b.entry);
  if (a.kind === "proposed-plan" && b.kind === "proposed-plan") return shallowEqual(a.proposedPlan, b.proposedPlan);
  return false;
}

/**
 * The adapter rebuilds every entry from the whole event list, so without this
 * one text chunk would hand the memoized rows a new object per message and
 * re-render the whole thread. Entries whose content did not change keep the
 * object from the previous derivation.
 */
export function stabilizeEntries(next: ReadonlyArray<TimelineEntry>, previous: ReadonlyArray<TimelineEntry>): TimelineEntry[] {
  const byId = new Map(previous.map(entry => [entry.id, entry]));
  return next.map(entry => {
    const prev = byId.get(entry.id);
    return prev !== undefined && sameEntry(prev, entry) ? prev : entry;
  });
}

export function deriveChatThread(state: ThreadState, previous: ReadonlyArray<TimelineEntry> = []): ChatThreadView {
  const model = deriveSession(state.events, { at: (_e, index) => state.arrivals[index] });
  const entries: TimelineEntry[] = [...model.timeline];
  if (state.pendingPrompt !== null) {
    const { text, at } = state.pendingPrompt;
    entries.push({
      id: "pending-user",
      kind: "message",
      createdAt: at,
      message: { id: "pending-user", role: "user", text, turnId: null, streaming: false, createdAt: at, updatedAt: at },
    });
  }
  state.localErrors.forEach(({ message, at }, index) => {
    const id = `local-error:${index}`;
    entries.push({
      id,
      kind: "work",
      createdAt: at,
      entry: { id, createdAt: at, turnId: null, label: message, tone: "error", sourceActivityKind: "runtime.error" },
    });
  });
  const latestTurn = model.latestTurn;
  let cwd: string | null = null;
  let shellCwd: string | null = null;
  for (const e of state.events) {
    if (e.type === "session.start" && e.cwd !== undefined) cwd = e.cwd;
    if (e.type === "session.delta" && e.cwd !== undefined) shellCwd = e.cwd;
  }
  return {
    entries: stabilizeEntries(entries, previous),
    turns: model.turns,
    latestTurn,
    running: model.running,
    activeTurnStartedAt: model.running ? (latestTurn?.startedAt ?? null) : null,
    settled: latestTurn !== null && !model.running ? latestTurn : null,
    cwd,
    shellCwd,
    harness: model.harness,
    model: model.model,
  };
}

interface ViewKey {
  readonly workspaceId: string;
  readonly threadId: string | null;
}

/**
 * The state one view leaves for the next: nothing across workspaces; within one, what it knew, and a send
 * still in flight from a view without a start, whose rows wait under the pin or, from the latest view, the
 * workspace id: nothing resumes a dead thread, so that start opens a thread no view holds yet.
 */
export function leaveView(s: ThreadState, from: ViewKey, to: ViewKey): ThreadState {
  if (from.workspaceId !== to.workspaceId) return EMPTY;
  const sent = s.sending !== null && heldThreadId(s) === undefined ? s.pendingPrompt : null;
  return { ...EMPTY, known: knowing(s.known, s.events), stray: sent === null ? s.stray : { text: sent.text, requestId: sent.requestId, key: from.threadId ?? from.workspaceId } };
}

/** The row a view without a session.start resumes from: pinned, the thread's latest turn the harness answered; on the latest view, the turn the workspace remembers. */
function resumedRow(rows: ReadonlyArray<SessionView> | undefined, threadId: string | null, remembered: string | undefined): SessionView | undefined {
  if (threadId !== null) return rows?.findLast(r => r.threadId === threadId && r.claudeSessionId !== undefined);
  return remembered === undefined ? undefined : rows?.findLast(r => r.claudeSessionId === remembered);
}

/** The session the thread's last session.start opened; a turn that ended without one, its harness dead before init, names an id no harness ever held. */
export function startedSession(events: ReadonlyArray<SessionEvent>): string | undefined {
  return lastStart(events)?.sessionId;
}

/** A thread pinned from the sidebar, or the workspace's latest when none is. */
export function useChatThread(workspaceId: string, threadId: string | null = null): ChatThreadHandle {
  const api = useStore(s => s.api);
  // Moves when a reconnect could not replay what the socket missed: the thread below is rebuilt from history.
  const gaps = useStore(s => s.gaps);
  const remembered = useStore(s => s.workspaces.find(w => w.id === workspaceId)?.claudeSessionId);
  // The runtime stamps a row only once the harness announced its session, so a capped pinned thread resumes by its row and a dead one resumes nothing.
  const rowSession = useStore(s => resumedRow(s.sessions[workspaceId], threadId, remembered)?.claudeSessionId);
  const rowCwd = useStore(s => resumedRow(s.sessions[workspaceId], threadId, remembered)?.cwd);
  const viewKey = threadId === null ? workspaceId : `${workspaceId}/${threadId}`;
  const [state, setState] = useState<ThreadState>(EMPTY);
  const [viewed, setViewed] = useState({ workspaceId, threadId });
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const hydratedRef = useRef<string | null>(null);
  const previousEntries = useRef<ReadonlyArray<TimelineEntry>>([]);

  if (viewed.workspaceId !== workspaceId || viewed.threadId !== threadId) {
    const from = viewed;
    setViewed({ workspaceId, threadId });
    setState(s => leaveView(s, from, { workspaceId, threadId }));
  }

  useEffect(() => {
    if (!api) return;
    let current = true;
    api.sessionHistory(workspaceId).then(
      events => {
        if (!current) return;
        const at = now();
        setState(s => reloadTranscript(s, events, at, threadId));
        hydratedRef.current = viewKey;
        setHydratedFor(viewKey);
      },
      (err: unknown) => {
        if (!current) return;
        const message = `history unavailable: ${err instanceof Error ? err.message : String(err)}`;
        setState(s => ({ ...s, localErrors: [...s.localErrors, { message, at: now() }] }));
        hydratedRef.current = viewKey;
        setHydratedFor(viewKey);
      },
    );
    return () => {
      current = false;
      hydratedRef.current = null;
    };
  }, [api, workspaceId, threadId, viewKey, gaps]);

  const onEvent = useCallback(
    (e: ProtocolEvent) => {
      if (hydratedRef.current !== viewKey) return;
      if (!isSessionEvent(e) || e.workspaceId !== workspaceId) return;
      setState(s => reduceEvent(s, e, now(), threadId));
    },
    [workspaceId, threadId, viewKey],
  );
  useProtocolEvents(onEvent);

  // A view without a start resumes its row: pinned, always; on the latest view, only while it is empty.
  const fromRow = !state.fresh && startedSession(state.events) === undefined && (threadId !== null || state.events.length === 0);
  const view = useMemo(() => {
    const next = deriveChatThread(state, previousEntries.current);
    previousEntries.current = next.entries;
    return fromRow && rowCwd !== undefined ? { ...next, cwd: rowCwd } : next;
  }, [state, fromRow, rowCwd]);
  const setSending = useCallback(
    (sending: boolean) =>
      setState(s => {
        if (sending) return s.sending === null ? { ...s, sending: { after: s.events.at(-1)?.turnId }, named: null } : s;
        return s.sending === null && s.stray === null ? s : { ...s, sending: null, named: null, stray: null };
      }),
    [],
  );
  const appendUserTurn = useCallback((text: string, requestId: string) => setState(s => ({ ...s, pendingPrompt: { text, requestId, at: now() } })), []);
  const appendLocalError = useCallback(
    (message: string) =>
      setState(s => ({
        ...s,
        pendingPrompt: null,
        localErrors: [...s.localErrors, { message, at: now() }],
        stale: s.stale?.kind === "pending-send" ? null : s.stale,
      })),
    [],
  );
  const startNewThread = useCallback(() => {
    // A second request while the left turn is still finishing keeps that record; nothing new was left behind.
    setState(s => ({
      ...EMPTY,
      fresh: true,
      left: s.fresh ? s.left : s.events.at(-1)?.threadId,
      known: knowing(s.known, s.events),
      stray: s.stray,
      stale: s.stale ?? (s.sending !== null ? { kind: "pending-send", after: s.sending.after } : runningTurn(s.events)),
    }));
  }, []);

  const finishing = state.stale !== null;
  return {
    view,
    hydrated: hydratedFor === viewKey,
    busy: state.sending !== null || view.running || finishing,
    sending: state.sending !== null,
    fresh: state.fresh,
    resume: state.fresh ? undefined : (startedSession(state.events) ?? (fromRow ? (threadId === null ? remembered : rowSession) : undefined)),
    finishing,
    threadKey: heldThreadId(state) ?? threadId ?? workspaceId,
    named: state.named,
    appendUserTurn,
    appendLocalError,
    setSending,
    startNewThread,
  };
}
