// SPDX-License-Identifier: AGPL-3.0-only
// One workspace's chat thread: the persisted transcript replayed from
// sessions.history on mount, then live session.* events folded on top. Live
// events are ignored until the history reply lands, because the socket is
// FIFO: anything pushed before the reply is already in it, anything after is
// not.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProtocolEvents, useStore } from "../../protocol/store";
import type { ProtocolEvent } from "../../protocol/client";
import {
  appendLocalError,
  appendUserTurn,
  applySessionEvent,
  deriveChatThread,
  emptyChatThread,
  isSessionEvent,
  replaySessionEvents,
  type ChatThreadState,
  type ChatThreadView,
} from "./adapt";

export interface ChatThreadHandle {
  readonly view: ChatThreadView;
  /** False until the history reply for this workspace has landed. */
  readonly hydrated: boolean;
  /** True while a turn is running or a send is in flight. */
  readonly busy: boolean;
  /** Optimistic user message for a send; session.start adopts it. */
  readonly appendUserTurn: (prompt: string) => void;
  /** A send that failed before the runtime emitted anything. */
  readonly appendLocalError: (message: string) => void;
  readonly setSending: (sending: boolean) => void;
}

const now = () => new Date().toISOString();

export function useChatThread(workspaceId: string): ChatThreadHandle {
  const api = useStore(s => s.api);
  const [state, setState] = useState<ChatThreadState>(emptyChatThread);
  const [sending, setSending] = useState(false);
  const [viewedWs, setViewedWs] = useState(workspaceId);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const hydratedRef = useRef<string | null>(null);

  if (viewedWs !== workspaceId) {
    setViewedWs(workspaceId);
    setState(emptyChatThread);
    setSending(false);
  }

  useEffect(() => {
    if (!api) return;
    let current = true;
    api.sessionHistory(workspaceId).then(
      events => {
        if (!current) return;
        setState(replaySessionEvents(events, now()));
        hydratedRef.current = workspaceId;
        setHydratedFor(workspaceId);
      },
      (err: unknown) => {
        if (!current) return;
        setState(s => appendLocalError(s, `history unavailable: ${err instanceof Error ? err.message : String(err)}`, now()));
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
      setState(s => applySessionEvent(s, e, now()));
      setSending(false);
    },
    [workspaceId],
  );
  useProtocolEvents(onEvent);

  const view = useMemo(() => deriveChatThread(state), [state]);
  const appendUser = useCallback((prompt: string) => setState(s => appendUserTurn(s, prompt, now())), []);
  const appendError = useCallback((message: string) => setState(s => appendLocalError(s, message, now())), []);

  return {
    view,
    hydrated: hydratedFor === workspaceId,
    busy: sending || view.runningTurnId !== null,
    appendUserTurn: appendUser,
    appendLocalError: appendError,
    setSending,
  };
}
