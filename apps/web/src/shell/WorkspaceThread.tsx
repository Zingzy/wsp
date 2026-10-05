// SPDX-License-Identifier: AGPL-3.0-only
// The center thread for one workspace: the chat view with the composer in
// its slot. The composer is keyed by workspace so the editor and its undo
// history remount on a switch; the draft store keeps each workspace's text.
// A turn the agent's usage limit stopped puts its one row over the composer,
// read off the thread's latest row, until the turn goes on or the thread
// moves on without it.
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { ChatView } from "../components/chat/ChatView.js";
import { LimitStrip } from "../components/chat/LimitStrip.js";
import type { ChatThreadHandle } from "../components/chat/useChatThread.js";
import { useStore, useThreadSessions } from "../protocol/store.js";

export function WorkspaceThread({ workspaceId, threadId = null }: { workspaceId: string; threadId?: string | null }) {
  return (
    <ChatView workspaceId={workspaceId} threadId={threadId}>
      {thread => <Slot workspaceId={workspaceId} thread={thread} />}
    </ChatView>
  );
}

/** The composer, under the limit strip while the thread's latest turn stands stopped at a usage limit. */
function Slot({ workspaceId, thread }: { workspaceId: string; thread: ChatThreadHandle }) {
  const api = useStore(s => s.api);
  const latest = useThreadSessions(workspaceId, thread.threadKey).at(-1);
  const limited = latest !== undefined && latest.status === "failed" && latest.limit !== undefined ? latest : null;
  return (
    <>
      {limited === null ? null : (
        <LimitStrip
          agent={limited.harness}
          limit={limited.limit!}
          resumeAt={limited.resumeAt ?? null}
          onResume={() => void api?.resumeAtReset?.(limited.id, true)}
          onCancel={() => void api?.resumeAtReset?.(limited.id, false)}
        />
      )}
      <ChatComposer key={workspaceId} workspaceId={workspaceId} thread={thread} />
    </>
  );
}
