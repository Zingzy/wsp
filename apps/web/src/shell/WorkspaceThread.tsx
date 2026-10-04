// SPDX-License-Identifier: AGPL-3.0-only
// The center thread for one workspace: the chat view with the composer in
// its slot. The composer is keyed by workspace so the editor and its undo
// history remount on a switch; the draft store keeps each workspace's text.
// With dock on, a prompt the latest turn is stopped on takes the composer's
// slot as the menu it is answered from, and the composer comes back once the
// prompt closes; Write a message instead folds the prompt to one line over
// the composer until the person opens it again.
import { useState } from "react";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { ChatView } from "../components/chat/ChatView.js";
import { PromptDock, PromptStrip } from "../components/chat/PromptDock.js";
import type { ChatThreadHandle } from "../components/chat/useChatThread.js";
import { isPromptOpen, type PermissionPrompt } from "../adapt/index.js";
import { useStore } from "../protocol/store.js";
import { useAppDark } from "../settings/theme.js";

/** The prompt the latest turn waits on, where one is open and the thread's own agent raised it. */
function openPrompt(thread: ChatThreadHandle): PermissionPrompt | null {
  const turnId = thread.view.latestTurn?.turnId ?? null;
  for (const entry of thread.view.entries) if (entry.kind === "permission" && entry.permission.turnId === turnId && isPromptOpen(entry.permission)) return entry.permission;
  return null;
}

export function WorkspaceThread({ workspaceId, threadId = null, dock = false }: { workspaceId: string; threadId?: string | null; dock?: boolean }) {
  const api = useStore(s => s.api);
  const [writing, setWriting] = useState<string | null>(null);
  const dark = useAppDark();
  return (
    <ChatView workspaceId={workspaceId} threadId={threadId} promptsDocked={dock}>
      {thread => {
        const prompt = dock ? openPrompt(thread) : null;
        if (prompt !== null && writing !== prompt.askId)
          return (
            <PromptDock
              key={prompt.askId}
              permission={prompt}
              agent={thread.view.agent}
              theme={dark ? "dark" : "light"}
              {...(thread.view.cwd === null ? {} : { cwd: thread.view.cwd })}
              onAnswer={(sessionId, askId, optionId) => void api?.answerPermission?.(sessionId, askId, optionId)}
              onWriteInstead={() => setWriting(prompt.askId)}
            />
          );
        return (
          <>
            {prompt === null ? null : <PromptStrip permission={prompt} onOpen={() => setWriting(null)} />}
            <ChatComposer key={workspaceId} workspaceId={workspaceId} thread={thread} />
          </>
        );
      }}
    </ChatView>
  );
}
