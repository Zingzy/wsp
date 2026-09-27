// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { foldThreads, threadUnread, type SessionView } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";

/** Stamps the thread this view shows as read on the host each time its latest turn has ended after the last stamp,
 * while the window is visible: the stamp says a person could see the finish, so a hidden window stamps nothing until
 * it shows again. */
export function useReadStamp(rows: ReadonlyArray<SessionView>): void {
  const readThread = useStore(s => s.readThread);
  const thread = rows.length === 0 ? undefined : foldThreads(rows)[0];
  const threadId = thread?.id;
  const unreadEnd = thread !== undefined && threadUnread(thread) ? thread.endedAt : undefined;
  useEffect(() => {
    if (threadId === undefined || unreadEnd === undefined) return;
    const stamp = (): void => {
      if (document.visibilityState === "visible") void readThread(threadId);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [readThread, threadId, unreadEnd]);
}
