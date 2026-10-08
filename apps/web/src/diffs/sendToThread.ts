// SPDX-License-Identifier: AGPL-3.0-only
// Words from a review into the thread in front of the person: one block under whatever is already typed in its
// composer, for the person to edit and send. Nothing here sends to the agent.
import { useComposerDraftStore } from "../components/chat/composerDraftStore.js";
import { requestComposerFocus } from "../shell/shellRequests.js";

export function sendToThread(workspaceId: string, quote: string): void {
  const store = useComposerDraftStore.getState();
  const draft = store.drafts[workspaceId]?.prompt ?? "";
  const prompt = draft === "" ? `${quote}\n\n` : `${draft}\n\n${quote}\n\n`;
  store.setDraft(workspaceId, { prompt, cursor: prompt.length });
  requestComposerFocus(workspaceId);
}
