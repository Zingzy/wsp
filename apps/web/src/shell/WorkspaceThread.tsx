// SPDX-License-Identifier: AGPL-3.0-only
// The center thread for one workspace: the chat view with the composer in
// its slot. The composer is keyed by workspace so the editor and its undo
// history remount on a switch; the draft store keeps each workspace's text.
// The prompt this thread's own agent is stopped on takes the composer's slot
// as the menu it is answered from, and the composer comes back once the
// prompt closes; a prompt another thread is stopped on, or one of a
// subagent's, keeps its buttons in the timeline. Write a message instead, Esc,
// or a letter typed outside the dock's own keys folds the prompt to one line
// over the composer until the person opens it again.
import { useState } from "react";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { ChatView } from "../components/chat/ChatView.js";
import { PromptDock, PromptStrip } from "../components/chat/PromptDock.js";
import { useTypeToWrite } from "../components/chat/composerTypeToFocus.js";
import type { ChatThreadHandle } from "../components/chat/useChatThread.js";
import { isPromptOpen, type PermissionPrompt } from "../adapt/index.js";
import { useHarnessCatalog, useStore } from "../protocol/store.js";
import { requestComposerFocus } from "./shellRequests.js";

/** The prompt the latest turn waits on, where this thread's own agent raised one and nobody has answered. */
function openPrompt(thread: ChatThreadHandle): PermissionPrompt | null {
  const turnId = thread.view.latestTurn?.turnId ?? null;
  for (const entry of thread.view.entries) if (entry.kind === "permission" && entry.permission.turnId === turnId && isPromptOpen(entry.permission)) return entry.permission;
  return null;
}

/** The prompt the dock is drawing for this thread, by id: its own open prompt, unless the person folded it away. */
const dockedPrompt = (thread: ChatThreadHandle, writing: string | null): PermissionPrompt | null => {
  const prompt = openPrompt(thread);
  return prompt !== null && writing !== prompt.askId ? prompt : null;
};

export function WorkspaceThread({ workspaceId, threadId = null }: { workspaceId: string; threadId?: string | null }) {
  const api = useStore(s => s.api);
  const [writing, setWriting] = useState<string | null>(null);
  // The thread's own prompt is the dock's whether the dock is up or folded to its strip: its row keeps the record
  // alone either way.
  return (
    <ChatView workspaceId={workspaceId} threadId={threadId} docked={thread => openPrompt(thread)?.askId ?? null}>
      {thread => <Slot workspaceId={workspaceId} thread={thread} writing={writing} setWriting={setWriting} answer={(sessionId, askId, optionId, reason) => void api?.answerPermission?.(sessionId, askId, optionId, reason)} />}
    </ChatView>
  );
}

/** What stands in the composer's slot: the dock while this thread's own prompt is open and not folded, else the
 * composer under the folded prompt's line. */
function Slot({
  workspaceId,
  thread,
  writing,
  setWriting,
  answer,
}: {
  workspaceId: string;
  thread: ChatThreadHandle;
  writing: string | null;
  setWriting: (askId: string | null) => void;
  answer: (sessionId: string, askId: string, optionId: string, reason?: string) => void;
}) {
  const prompt = openPrompt(thread);
  const catalog = useHarnessCatalog(thread.view.agent, workspaceId);
  const docked = prompt !== null && dockedPrompt(thread, writing) !== null;
  useTypeToWrite(workspaceId, docked, () => setWriting(prompt?.askId ?? null));
  if (prompt !== null && docked)
    return (
      <PromptDock
        key={prompt.askId}
        permission={prompt}
        agent={thread.view.agent}
        {...(thread.view.cwd === null ? {} : { cwd: thread.view.cwd })}
        modes={catalog?.permissionModes ?? []}
        onAnswer={answer}
        onWriteInstead={() => {
          setWriting(prompt.askId);
          requestComposerFocus(workspaceId);
        }}
      />
    );
  return (
    <>
      {prompt === null ? null : <PromptStrip permission={prompt} onOpen={() => setWriting(null)} />}
      <ChatComposer key={workspaceId} workspaceId={workspaceId} thread={thread} />
    </>
  );
}
