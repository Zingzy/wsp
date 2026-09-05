// SPDX-License-Identifier: AGPL-3.0-only
// One workspace's chat thread: the thread pinned from the sidebar, or the
// last one of the persisted transcript, replayed from sessions.history on
// mount, then that thread's live session.* events appended. Live events are
// ignored until the history reply lands, because the socket is FIFO:
// anything pushed before the reply is already in it, anything after is not.
// The adapter derives the view; this hook only keeps the event list, the
// arrival clock for unstamped events, and the things the wire cannot know
// yet: a prompt the user just sent, a send that failed locally, and a new
// thread requested while a turn was still running. The composer's stop
// reaches only the turn it shows and the runtime has no per-workspace guard,
// so that turn keeps running unseen and the composer stays closed until its
// end arrives.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionEvent, SessionHarness } from "@wsp/protocol";
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
  /** The folder the thread's harness runs in, as its last session.start named it. */
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
  /** The harness session the next send resumes: the shown thread's latest turn, else the workspace's remembered one; none while fresh. */
  readonly resume: string | undefined;
  /** True while the turn a new thread left behind is still running on the machine. */
  readonly finishing: boolean;
  /** The held thread's runtime id, or the workspace id before it has one; keys what belongs to this thread outside the transcript. */
  readonly threadKey: string;
  /** The key the last send's rows waited under when its session.start landed: the thread id, or the workspace id before the thread had one. Null while a send is in flight, after one that settled without a start, and before any. */
  readonly named: string | null;
  /** Optimistic user message for a send; the next session.start replaces it. */
  readonly appendUserTurn: (prompt: string) => void;
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

export interface ThreadState {
  readonly events: ReadonlyArray<SessionEvent>;
  readonly arrivals: ReadonlyArray<string>;
  readonly pendingPrompt: { text: string; at: string } | null;
  readonly localErrors: ReadonlyArray<{ message: string; at: string }>;
  readonly fresh: boolean;
  readonly stale: StaleTurn | null;
  /** A send in flight, with the turn that had settled when it began, until its session.start lands or a reload rebuilds this. */
  readonly sending: { readonly after: string | undefined } | null;
  /** Thread id of the transcript a new-thread request left: the one thread that can hold the turn a fresh view waits on. */
  readonly left: string | undefined;
  /** Every thread id the history reply carried or this view has held; while fresh, an event from none of them is the person's own send. */
  readonly known: ReadonlyArray<string>;
  /** The key the last send's rows waited under when its session.start landed: the thread id the events carried, or the workspace id without one. Null from the send until then, and after a send that settled without a start. */
  readonly named: string | null;
}

const EMPTY: ThreadState = { events: [], arrivals: [], pendingPrompt: null, localErrors: [], fresh: false, stale: null, sending: null, left: undefined, known: [], named: null };
const SESSION_TYPES: ReadonlySet<string> = new Set(["session.start", "session.delta", "session.done", "session.end"]);
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
 * The history reply, folded to the selected thread, or to its last thread when none is. A new-thread
 * request that landed while history was in flight wins over the transcript it asked to leave, unless
 * the transcript already holds the thread that request opened: the runtime minted it an id no earlier
 * reply carried, so it is the person's own and loads as such, and only the left thread can hold a
 * stale turn. Otherwise the transcript decides whether the left turn is still running, except for a
 * send whose session.start it cannot hold yet.
 */
export function reloadTranscript(s: ThreadState, events: ReadonlyArray<SessionEvent>, at: string, threadId: string | null = null): ThreadState {
  const thread = threadId === null ? lastThread(events) : events.filter(e => e.threadId === threadId);
  const arrivals = thread.map(() => at);
  const known = knowing(s.known, events);
  if (!s.fresh) return { ...EMPTY, events: thread, arrivals, known, ...replaySend(s, thread) };
  if (s.stale?.kind === "pending-send") return { ...s, stale: runningTurn(events) ?? s.stale, known };
  const id = thread[0]?.threadId;
  if (id !== undefined && !s.known.includes(id)) {
    return { ...EMPTY, events: thread, arrivals, stale: runningTurn(events.filter(e => e.threadId === s.left)), known, ...replaySend(s, thread) };
  }
  return { ...s, stale: runningTurn(events), known };
}

/** What a replayed thread did with the send in flight, read the way live events would settle it: the events past the turn that had settled when it began. */
function replaySend(s: ThreadState, thread: ReadonlyArray<SessionEvent>): Pick<ThreadState, "sending" | "named"> {
  if (s.sending === null) return { sending: null, named: null };
  const { after } = s.sending;
  const since = thread.slice(thread.findLastIndex(e => e.turnId === after) + 1);
  const start = since.find(e => e.type === "session.start");
  if (start !== undefined) return { sending: null, named: heldThreadId(s) ?? start.workspaceId };
  return since.some(e => e.type === "session.end") ? { sending: null, named: null } : { sending: s.sending, named: null };
}

function belongsToStale(stale: Extract<StaleTurn, { kind: "turn" }>, e: SessionEvent): boolean {
  return e.turnId !== undefined && stale.turnId !== undefined ? e.turnId === stale.turnId : e.sessionId === stale.sessionId;
}

/** The thread id the view's last session.start carried: a harness that dies before its start leaves events under an id the person never saw start, and those name nothing. */
function heldThreadId(state: ThreadState): string | undefined {
  return state.events.findLast(e => e.type === "session.start")?.threadId;
}

/** An event from no thread the view knows is the person's own send: the runtime mints its id at the start, and a harness that dies before init carries it too. */
function unknownThread(state: ThreadState, e: SessionEvent): boolean {
  return e.threadId === undefined || !state.known.includes(e.threadId);
}

/**
 * A view holds one thread: once its events carry a thread id, another thread's events are not its own. Fresh, a
 * session.start is its own, and so is any event from a thread it does not know while a send is in flight: that is
 * the send's own harness dying before its start, while a known thread waking is not, whether it was left or older.
 * A view whose thread never started (a harness that died before init, read back from history) holds that thread
 * and, while a send is in flight, the unknown one the runtime mints for the send, since nothing resumes a dead one.
 */
function inHeldThread(state: ThreadState, e: SessionEvent): boolean {
  if (state.fresh) return e.type === "session.start" || (state.sending !== null && unknownThread(state, e));
  const held = heldThreadId(state);
  if (held !== undefined) return e.threadId === held;
  const last = state.events.at(-1)?.threadId;
  return last === undefined || e.threadId === last || (state.sending !== null && unknownThread(state, e));
}

/**
 * Applies one live event; returns the same state object when the event belongs to the turn a new thread left
 * or to a thread already known, and only remembers the thread of one it drops otherwise: a thread another
 * client opened after this view's history is then known before any send of this view could take it for its
 * own. A send ends at its session.start, or at a session.end of some other turn than the one that had settled
 * when it began: that turn's own end still trails its done, which already opened the composer, while a harness
 * that dies before init produces only a done and an end under a new turn id. A pending send left behind ends
 * the same way, from a thread the view never knew or from the left one it resumed.
 */
export function reduceEvent(state: ThreadState, e: SessionEvent, at: string): ThreadState {
  const { stale } = state;
  if (stale !== null) {
    if (stale.kind === "pending-send") {
      if (e.type === "session.start") return { ...state, stale: { kind: "turn", turnId: e.turnId, sessionId: e.sessionId } };
      const own = unknownThread(state, e) || e.threadId === state.left;
      return e.type === "session.end" && own && e.turnId !== stale.after ? { ...state, stale: null } : state;
    }
    if (belongsToStale(stale, e)) return e.type === "session.end" ? { ...state, stale: null } : state;
  }
  if (!inHeldThread(state, e)) {
    const known = knowing(state.known, [e]);
    return known === state.known ? state : { ...state, known };
  }
  const next = append(state, e, at);
  if (state.sending === null) return next;
  const starts = e.type === "session.start";
  const settles = starts || (e.type === "session.end" && e.turnId !== state.sending.after);
  const named = starts ? (heldThreadId(state) ?? e.workspaceId) : state.named;
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

/** A thread pinned from the sidebar, or the workspace's latest when none is. */
export function useChatThread(workspaceId: string, threadId: string | null = null): ChatThreadHandle {
  const api = useStore(s => s.api);
  // Moves when a reconnect could not replay what the socket missed: the thread below is rebuilt from history.
  const gaps = useStore(s => s.gaps);
  const remembered = useStore(s => s.workspaces.find(w => w.id === workspaceId)?.claudeSessionId);
  const viewKey = threadId === null ? workspaceId : `${workspaceId}/${threadId}`;
  const [state, setState] = useState<ThreadState>(EMPTY);
  const [viewed, setViewed] = useState(viewKey);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const hydratedRef = useRef<string | null>(null);
  const previousEntries = useRef<ReadonlyArray<TimelineEntry>>([]);

  if (viewed !== viewKey) {
    setViewed(viewKey);
    setState(EMPTY);
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
      if (threadId !== null && e.threadId !== threadId) return;
      setState(s => reduceEvent(s, e, now()));
    },
    [workspaceId, threadId, viewKey],
  );
  useProtocolEvents(onEvent);

  const view = useMemo(() => {
    const next = deriveChatThread(state, previousEntries.current);
    previousEntries.current = next.entries;
    return next;
  }, [state]);
  const setSending = useCallback(
    (sending: boolean) =>
      setState(s => {
        if ((s.sending !== null) === sending) return s;
        return { ...s, sending: sending ? { after: s.events.at(-1)?.turnId } : null, named: null };
      }),
    [],
  );
  const appendUserTurn = useCallback((text: string) => setState(s => ({ ...s, pendingPrompt: { text, at: now() } })), []);
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
    resume: state.fresh ? undefined : (view.latestTurn?.sessionId ?? (threadId === null ? remembered : undefined)),
    finishing,
    threadKey: threadId ?? heldThreadId(state) ?? workspaceId,
    named: state.named,
    appendUserTurn,
    appendLocalError,
    setSending,
    startNewThread,
  };
}
