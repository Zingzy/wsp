// SPDX-License-Identifier: AGPL-3.0-only
// The center thread for one workspace: the chat view with the composer in
// its slot. The composer is keyed by workspace so the editor and its undo
// history remount on a switch; the draft store keeps each workspace's text.
// The prompt this thread's own agent is stopped on takes the composer's slot
// as the menu it is answered from, and the composer comes back once the
// prompt closes; a prompt another thread is stopped on, or one of a
// subagent's, keeps its buttons in the timeline. Write a message instead, Esc,
// or a letter typed outside the dock's own keys folds the prompt to the first
// row of the composer's drawer until the person opens it again. A turn the
// agent's usage limit stopped is a row of that drawer too, until the turn goes
// on or the thread moves on without it. On a subagent's page the slot holds
// that subagent's bar: nobody writes to a subagent but through its lead.
import { useEffect, useMemo } from "react";
import { agentName } from "@wsp/catalog";
import { modelOf, modelPicks, permissionPromptWords } from "@wsp/protocol";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { ChatView } from "../components/chat/ChatView.js";
import { answerPrompt, type AnswerPrompt } from "../components/chat/answerPrompt.js";
import { useComposerBarStore } from "../components/chat/composerBar.js";
import { PromptDock } from "../components/chat/PromptDock.js";
import { SubagentBar } from "../components/chat/SubagentBar.js";
import { useTypeToWrite } from "../components/chat/composerTypeToFocus.js";
import type { ChatThreadHandle } from "../components/chat/useChatThread.js";
import { isPromptOpen, subagentOfRun, subagentRunOf, type PermissionPrompt } from "../adapt/index.js";
import { useHarnessCatalog, useStore, useThreadSessions } from "../protocol/store.js";
import { requestComposerFocus } from "./shellRequests.js";

/** The prompt the latest turn waits on, where this thread's own agent raised one and nobody has answered. */
function openPrompt(thread: ChatThreadHandle): PermissionPrompt | null {
  const turnId = thread.view.latestTurn?.turnId ?? null;
  for (const entry of thread.view.entries) if (entry.kind === "permission" && entry.permission.turnId === turnId && isPromptOpen(entry.permission)) return entry.permission;
  return null;
}

/** What the drawer's first row says of a folded prompt: its question, or what the call is. */
const askedLine = (prompt: PermissionPrompt): string => {
  const words = permissionPromptWords(prompt.toolName, prompt.input, prompt.detail);
  return words.questions !== undefined ? words.questions[0]!.question : words.lead;
};

export function WorkspaceThread({ workspaceId, threadId = null, subagent = null }: { workspaceId: string; threadId?: string | null; subagent?: string | null }) {
  const api = useStore(s => s.api);
  const answer = useMemo(() => answerPrompt(api), [api]);
  const page = threadId === null ? null : subagent;
  // The thread's own prompt is the dock's whether the dock is up or folded to the drawer: its row keeps the record
  // alone either way.
  return (
    <ChatView workspaceId={workspaceId} threadId={threadId} subagent={page} docked={thread => openPrompt(thread)?.askId ?? null}>
      {thread => (page === null ? <Slot workspaceId={workspaceId} thread={thread} answer={answer} /> : <SubagentSlot workspaceId={workspaceId} threadId={threadId!} subagent={page} thread={thread} />)}
    </ChatView>
  );
}

/** The bar of the subagent whose page this is, off the lead's listing, which says its state, times and model; where
 * the listing does not carry it, off its own fold in the lead's transcript. */
function SubagentSlot({ workspaceId, threadId, subagent, thread }: { workspaceId: string; threadId: string; subagent: string; thread: ChatThreadHandle }) {
  const rows = useThreadSessions(workspaceId, threadId);
  const row = rows.findLast(r => r.subagents?.some(sub => sub.parentToolUseId === subagent) === true);
  const run = subagentRunOf(thread.view.entries, subagent);
  const shown = row?.subagents?.find(sub => sub.parentToolUseId === subagent) ?? (run === null ? undefined : subagentOfRun(run));
  const harness = row?.harness ?? rows.at(-1)?.harness ?? null;
  const catalog = useHarnessCatalog(harness, workspaceId);
  if (shown === undefined || harness === null) return null;
  const model = shown.model === undefined ? agentName(harness) : catalog === null ? shown.model : (modelOf(catalog, modelPicks(shown.model).model)?.label ?? shown.model);
  const back = (): void => {
    useStore.getState().select(workspaceId, threadId);
    requestComposerFocus(workspaceId);
  };
  return <SubagentBar subagent={shown} harness={harness} model={model} onBack={back} />;
}

/** What stands in the composer's slot: the dock while this thread's own prompt is open and not folded, else the
 * composer with the folded prompt and the usage limit among its drawer's rows. */
function Slot({ workspaceId, thread, answer }: { workspaceId: string; thread: ChatThreadHandle; answer: AnswerPrompt }) {
  const prompt = openPrompt(thread);
  const key = thread.threadKey;
  const folded = useComposerBarStore(s => s.folded[key] ?? null);
  const catalog = useHarnessCatalog(thread.view.agent, workspaceId);
  const docked = prompt !== null && folded !== prompt.askId;
  // The panel takes the place of any bar, and once it is answered the composer comes back, not that bar.
  useEffect(() => {
    if (docked) useComposerBarStore.getState().closeBar(key);
  }, [docked, key]);
  useTypeToWrite(workspaceId, docked, () => {
    if (prompt !== null) useComposerBarStore.getState().fold(key, prompt.askId);
  });
  const latest = useThreadSessions(workspaceId, key).at(-1);
  const limit = latest !== undefined && latest.status === "failed" && latest.limit !== undefined ? latest.limit : null;
  const question = useMemo(() => (prompt === null ? null : askedLine(prompt)), [prompt]);
  const threadLimit = useMemo(() => (latest === undefined || limit === null ? null : { agent: latest.harness, limit, resumeAt: latest.resumeAt ?? null }), [latest, limit]);
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
          useComposerBarStore.getState().fold(key, prompt.askId);
          requestComposerFocus(workspaceId);
        }}
      />
    );
  return <ChatComposer key={workspaceId} workspaceId={workspaceId} thread={thread} question={question} limit={threadLimit} />;
}
