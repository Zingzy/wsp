// SPDX-License-Identifier: AGPL-3.0-only
// One workspace's chat thread: the persisted transcript replayed from
// sessions.history on mount, then live session.* events appended. Live events
// are ignored until the history reply lands, because the socket is FIFO:
// anything pushed before the reply is already in it, anything after is not.
// The adapter derives the view; this hook only keeps the event list, the
// arrival clock for unstamped events, and the two things the wire cannot know
// yet: a prompt the user just sent and a send that failed locally.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionEvent } from "@wsp/protocol";
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
  readonly cwd: string | null;
}

export interface ChatThreadHandle {
  readonly view: ChatThreadView;
  /** False until the history reply for this workspace has landed. */
  readonly hydrated: boolean;
  /** True while a turn is running or a send is in flight. */
  readonly busy: boolean;
  /** Optimistic user message for a send; the next session.start replaces it. */
  readonly appendUserTurn: (prompt: string) => void;
  /** A send that failed before the runtime emitted anything. */
  readonly appendLocalError: (message: string) => void;
  readonly setSending: (sending: boolean) => void;
}

interface ThreadState {
  readonly events: ReadonlyArray<SessionEvent>;
  readonly arrivals: ReadonlyArray<string>;
  readonly pendingPrompt: { text: string; at: string } | null;
  readonly localErrors: ReadonlyArray<{ message: string; at: string }>;
}

const EMPTY: ThreadState = { events: [], arrivals: [], pendingPrompt: null, localErrors: [] };
const SESSION_TYPES: ReadonlySet<string> = new Set(["session.start", "session.delta", "session.done", "session.end"]);
const now = () => new Date().toISOString();

function isSessionEvent(e: ProtocolEvent): e is SessionEvent {
  return SESSION_TYPES.has(e.type);
}

function append(state: ThreadState, e: SessionEvent, at: string): ThreadState {
  return {
    ...state,
    events: [...state.events, e],
    arrivals: [...state.arrivals, at],
    pendingPrompt: e.type === "session.start" ? null : state.pendingPrompt,
  };
}

export function deriveChatThread(state: ThreadState): ChatThreadView {
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
  for (const e of state.events) if (e.type === "session.start" && e.cwd !== undefined) cwd = e.cwd;
  return {
    entries,
    turns: model.turns,
    latestTurn,
    running: model.running,
    activeTurnStartedAt: model.running ? (latestTurn?.startedAt ?? null) : null,
    settled: latestTurn !== null && !model.running ? latestTurn : null,
    cwd,
  };
}

export function useChatThread(workspaceId: string): ChatThreadHandle {
  const api = useStore(s => s.api);
  const [state, setState] = useState<ThreadState>(EMPTY);
  const [sending, setSending] = useState(false);
  const [viewedWs, setViewedWs] = useState(workspaceId);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const hydratedRef = useRef<string | null>(null);

  if (viewedWs !== workspaceId) {
    setViewedWs(workspaceId);
    setState(EMPTY);
    setSending(false);
  }

  useEffect(() => {
    if (!api) return;
    let current = true;
    api.sessionHistory(workspaceId).then(
      events => {
        if (!current) return;
        const at = now();
        setState({ events, arrivals: events.map(() => at), pendingPrompt: null, localErrors: [] });
        hydratedRef.current = workspaceId;
        setHydratedFor(workspaceId);
      },
      (err: unknown) => {
        if (!current) return;
        const message = `history unavailable: ${err instanceof Error ? err.message : String(err)}`;
        setState(s => ({ ...s, localErrors: [...s.localErrors, { message, at: now() }] }));
        hydratedRef.current = workspaceId;
        setHydratedFor(workspaceId);
      },
    );
    return () => {
      current = false;
      hydratedRef.current = null;
    };
  }, [api, workspaceId]);

  const onEvent = useCallback(
    (e: ProtocolEvent) => {
      if (hydratedRef.current !== workspaceId) return;
      if (!isSessionEvent(e) || e.workspaceId !== workspaceId) return;
      setState(s => append(s, e, now()));
      setSending(false);
    },
    [workspaceId],
  );
  useProtocolEvents(onEvent);

  const view = useMemo(() => deriveChatThread(state), [state]);
  const appendUserTurn = useCallback((text: string) => setState(s => ({ ...s, pendingPrompt: { text, at: now() } })), []);
  const appendLocalError = useCallback(
    (message: string) => setState(s => ({ ...s, pendingPrompt: null, localErrors: [...s.localErrors, { message, at: now() }] })),
    [],
  );

  return {
    view,
    hydrated: hydratedFor === workspaceId,
    busy: sending || view.running,
    appendUserTurn,
    appendLocalError,
    setSending,
  };
}
