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
  /** True from a new-thread request until its first session.start: the next send must not resume the old session. */
  readonly fresh: boolean;
  /** The harness session the next send resumes: the shown thread's latest turn, else the workspace's remembered one; none while fresh. */
  readonly resume: string | undefined;
  /** True while the turn a new thread left behind is still running on the machine. */
  readonly finishing: boolean;
  /** The held thread's runtime id, or the workspace id before it has one; keys what belongs to this thread outside the transcript. */
  readonly threadKey: string;
  /** Optimistic user message for a send; the next session.start replaces it. */
  readonly appendUserTurn: (prompt: string) => void;
  /** A send that failed before the runtime emitted anything. */
  readonly appendLocalError: (message: string) => void;
  readonly setSending: (sending: boolean) => void;
  /** Clears the visible thread and marks the next send as a fresh session. */
  readonly startNewThread: () => void;
}

/** The turn a new thread left behind: known by id, or still the send whose session.start has not landed. */
export type StaleTurn =
  | { readonly kind: "turn"; readonly turnId: string | undefined; readonly sessionId: string }
  | { readonly kind: "pending-send" };

export interface ThreadState {
  readonly events: ReadonlyArray<SessionEvent>;
  readonly arrivals: ReadonlyArray<string>;
  readonly pendingPrompt: { text: string; at: string } | null;
  readonly localErrors: ReadonlyArray<{ message: string; at: string }>;
  readonly fresh: boolean;
  readonly stale: StaleTurn | null;
  /** A send in flight, until the session.start it produces lands here or a reload rebuilds this. */
  readonly sending: boolean;
  /** Thread id of the transcript a new-thread request left; read while fresh to tell the person's own thread from it. */
  readonly left: string | undefined;
}

const EMPTY: ThreadState = { events: [], arrivals: [], pendingPrompt: null, localErrors: [], fresh: false, stale: null, sending: false, left: undefined };
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

/** The last thread of a transcript: every event sharing the last event's thread id, a missing id being its own value. */
function lastThread(events: ReadonlyArray<SessionEvent>): SessionEvent[] {
  const id = events.at(-1)?.threadId;
  return events.filter(e => e.threadId === id);
}

/**
 * The history reply, folded to the selected thread, or to its last thread when none is. A new-thread
 * request that landed while history was in flight wins over the transcript it asked to leave, unless
 * the transcript already holds the thread that request opened: the runtime minted it an id the left
 * thread did not have, so it is the person's own and loads as such, and only the left thread can
 * hold a stale turn. Otherwise the transcript decides whether the left turn is still running, except
 * for a send whose session.start it cannot hold yet.
 */
export function reloadTranscript(s: ThreadState, events: ReadonlyArray<SessionEvent>, at: string, threadId: string | null = null): ThreadState {
  const thread = threadId === null ? lastThread(events) : events.filter(e => e.threadId === threadId);
  const arrivals = thread.map(() => at);
  if (!s.fresh) return { ...EMPTY, events: thread, arrivals };
  if (s.stale?.kind === "pending-send") return { ...s, stale: runningTurn(events) ?? s.stale };
  const id = thread[0]?.threadId;
  if (id !== undefined && id !== s.left) {
    return { ...EMPTY, events: thread, arrivals, stale: runningTurn(events.filter(e => e.threadId === s.left)) };
  }
  return { ...s, stale: runningTurn(events) };
}

function belongsToStale(stale: Extract<StaleTurn, { kind: "turn" }>, e: SessionEvent): boolean {
  return e.turnId !== undefined && stale.turnId !== undefined ? e.turnId === stale.turnId : e.sessionId === stale.sessionId;
}

/** A view holds one thread: once its events carry a thread id, another thread's events are not its own. Fresh, only a session.start can be its own. */
function inHeldThread(state: ThreadState, e: SessionEvent): boolean {
  if (state.fresh) return e.type === "session.start";
  const held = state.events.at(-1)?.threadId;
  return held === undefined || e.threadId === held;
}

/** Applies one live event; returns the same state object when the event belongs to the turn a new thread left or to another thread. */
export function reduceEvent(state: ThreadState, e: SessionEvent, at: string): ThreadState {
  const { stale } = state;
  if (stale !== null) {
    if (stale.kind === "pending-send") {
      return e.type === "session.start" ? { ...state, stale: { kind: "turn", turnId: e.turnId, sessionId: e.sessionId } } : state;
    }
    if (belongsToStale(stale, e)) return e.type === "session.end" ? { ...state, stale: null } : state;
  }
  return inHeldThread(state, e) ? append(state, e, at) : state;
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
      // Only a start ends a send: the previous turn's end still arrives after its done, which already opened the composer.
      setState(s => {
        const next = reduceEvent(s, e, now());
        return next !== s && next.sending && e.type === "session.start" ? { ...next, sending: false } : next;
      });
    },
    [workspaceId, threadId, viewKey],
  );
  useProtocolEvents(onEvent);

  const view = useMemo(() => {
    const next = deriveChatThread(state, previousEntries.current);
    previousEntries.current = next.entries;
    return next;
  }, [state]);
  const setSending = useCallback((sending: boolean) => setState(s => (s.sending === sending ? s : { ...s, sending })), []);
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
      stale: s.stale ?? (s.pendingPrompt !== null ? { kind: "pending-send" } : runningTurn(s.events)),
    }));
  }, []);

  const finishing = state.stale !== null;
  return {
    view,
    hydrated: hydratedFor === viewKey,
    busy: state.sending || view.running || finishing,
    fresh: state.fresh,
    resume: state.fresh ? undefined : (view.latestTurn?.sessionId ?? (threadId === null ? remembered : undefined)),
    finishing,
    threadKey: threadId ?? state.events.at(-1)?.threadId ?? workspaceId,
    appendUserTurn,
    appendLocalError,
    setSending,
    startNewThread,
  };
}
