// SPDX-License-Identifier: AGPL-3.0-only
// The one line under a project's New thread composer about the conversations kept in its folder outside wsp: with one
// held, the conversation the next send continues and Start fresh, which lets it go; with none held, Resume a
// conversation and how many there are, and nothing where the folder has none.
import { useEffect } from "react";
import { agentName } from "@wsp/catalog";
import { CONVERSATION_WORDS } from "@wsp/protocol";
import { openCommandPalette } from "../commandPaletteBus.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { Facts } from "../components/Facts.js";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";
import { FACT } from "../settings/format.js";
import { compactTimeLabel } from "../sidebar/workspaceRows.js";
import { isAnswer, useConversationsStore } from "./conversations.js";

/** The text button a bare word is drawn with: no padding, so its text edge is its box edge. */
const BARE = "px-0 [:hover,[data-pressed]]:bg-transparent";

export function ConversationLine({ projectId }: { projectId: string }) {
  const held = useConversationsStore(s => s.held[projectId]);
  const read = useConversationsStore(s => s.answers[projectId]);
  useEffect(() => {
    void useConversationsStore.getState().read(projectId);
  }, [projectId]);
  if (held !== undefined) {
    const { row, copy } = held;
    return (
      <div data-k="conversation-held" className="flex min-w-0 items-center gap-2">
        <HarnessMark harness={row.agent} label={agentName(row.agent)} className="size-4 shrink-0" />
        <span className="min-w-0 truncate text-note">{CONVERSATION_WORDS.continues(row.title, copy)}</span>
        <Facts parts={[row.branch, compactTimeLabel(new Date(row.lastAt).toISOString())]} className={cn("shrink-0", FACT)} />
        <Button size="xs" variant="ghost" className={cn("shrink-0", BARE)} data-k="start-fresh" onClick={() => useConversationsStore.getState().hold(projectId, null)}>
          {CONVERSATION_WORDS.startFresh}
        </Button>
      </div>
    );
  }
  const count = isAnswer(read) ? read.rows.length : 0;
  if (count === 0) return null;
  return (
    <div data-k="conversations-offer" className="flex items-center gap-3">
      <Button size="xs" variant="ghost" className={BARE} data-k="resume-conversation" onClick={() => openCommandPalette({ page: "conversations", project: projectId })}>
        {CONVERSATION_WORDS.row}
      </Button>
      <span className={FACT}>{CONVERSATION_WORDS.inFolder(count)}</span>
    </div>
  );
}
