// SPDX-License-Identifier: AGPL-3.0-only
// Whether a port the workspace's own listeners do not name answers on its
// computer all the same. A Docker port is held by docker-proxy, a child of
// dockerd and of no thread, so no port event names it or says it came back
// after a restart; the tab asks the host to fetch the port's route instead.
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../protocol/store.js";

/** How long after a fetch that found the port down it is fetched again: a restart reads as answering within this of the port coming back. */
export const ANSWER_POLL_MS = 2_000;

/** What a preview edge answers in place of a port nothing listens on. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 504]);

export interface PortAnswering {
  /** Whether the port answered its last fetch: null until the first answer, false when nothing can ask. */
  readonly answering: boolean | null;
  /** Fetches the port now, and again every ANSWER_POLL_MS until it answers. */
  readonly check: () => void;
}

/** `port` null asks nothing. The port is fetched at once and again every ANSWER_POLL_MS while it does not answer; once
 * it answers, only check() asks again, so an app that answers sees no fetch of wsp's but on a close, a frame load or a
 * Refresh. A fetch that fails also tells onDown, so the pane asks for its route again and a forward that ended says so. */
export function usePortAnswering(workspaceId: string, port: number | null, onDown: () => void): PortAnswering {
  const api = useStore(s => s.api);
  const [answer, setAnswer] = useState<{ workspaceId: string; port: number; answering: boolean } | null>(null);
  const [asks, setAsks] = useState(0);
  const down = useRef(onDown);
  down.current = onDown;
  const check = useCallback(() => setAsks(n => n + 1), []);

  useEffect(() => {
    const probe = api?.portProbe;
    if (probe === undefined || port === null) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (): void => {
      void probe(workspaceId, port).then(
        p => !GATEWAY_STATUSES.has(p.status),
        () => false,
      ).then(answering => {
        if (gone) return;
        setAnswer({ workspaceId, port, answering });
        if (answering) return;
        down.current();
        timer = setTimeout(ask, ANSWER_POLL_MS);
      });
    };
    ask();
    return () => {
      gone = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, workspaceId, port, asks]);

  // A port that comes off the list again starts unknown, not on the answer it had before.
  useEffect(() => () => setAnswer(null), [workspaceId, port]);

  if (api?.portProbe === undefined || port === null) return { answering: false, check };
  return { answering: answer !== null && answer.workspaceId === workspaceId && answer.port === port ? answer.answering : null, check };
}
