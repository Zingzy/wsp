// SPDX-License-Identifier: AGPL-3.0-only
// The one question before a thread opens on a conversation another app holds open: continuing it in both would split
// it (Claude Code takes a second writer without a word and its next resume drops one branch), so the answer offered
// first is a copy the agent makes. An agent that refuses a second writer and lets go of a closed one is offered Try
// again too. A refusal of the send lands in the note's place and moves nothing.
import { useState } from "react";
import { CONVERSATION_OPEN_KIND, CONVERSATION_WORDS } from "@wsp/protocol";
import { AlertDialog, AlertDialogClose, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, NEUTRAL_RING } from "../components/ui/button.js";
import { RefusalSlot, type Refusal } from "../settings/sheetParts.js";
import { useStore } from "../protocol/store.js";
import { placeNames } from "../sidebar/workspaceRows.js";
import { sendOn, useConversationsStore, type OpenConfirm } from "./conversations.js";

export function ConversationConfirm() {
  const confirm = useConversationsStore(s => s.confirm);
  return confirm === null ? null : <Confirm key={`${confirm.row.agent}:${confirm.row.id}`} confirm={confirm} />;
}

function Confirm({ confirm }: { confirm: OpenConfirm }) {
  const { project, row, send } = confirm;
  const computer = useStore(s => {
    const at = s.projects.find(p => p.id === project)?.computer;
    return at === undefined ? "" : (placeNames(s.places).get(at) ?? at);
  });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const close = (): void => useConversationsStore.getState().ask(null);
  /** A send waiting on this answer goes now; a pick off the page is held on its project's New thread page. */
  const go = async (copy: boolean): Promise<void> => {
    if (send === undefined) {
      useConversationsStore.getState().hold(project, { row, copy });
      useStore.getState().openProjectHome(project);
      close();
      return;
    }
    setBusy(true);
    setRefusal(null);
    const refused = await sendOn(project, { row, copy }, send);
    setBusy(false);
    if (refused === null) return close();
    // Still held elsewhere on a try again: the question stands, its note the agent's own words.
    setRefusal(refused.kind === CONVERSATION_OPEN_KIND && !copy ? { said: refused.said } : { said: refused.said, ...(refused.fix !== undefined ? { fix: refused.fix } : {}) });
  };
  return (
    <AlertDialog open onOpenChange={open => (open ? undefined : close())}>
      <AlertDialogPopup data-k="conversation-open">
        <AlertDialogHeader>
          <AlertDialogTitle>{CONVERSATION_WORDS.openTitle(row.title, computer)}</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="px-5 pt-1">
          <RefusalSlot k="conversation-open-note" {...(refusal !== null ? refusal : { note: CONVERSATION_WORDS.openNote(row.letsGo) })} />
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>{CONVERSATION_WORDS.cancel}</AlertDialogClose>
          {row.letsGo !== undefined ? (
            <Button variant="outline" className={NEUTRAL_RING} disabled={busy} data-k="conversation-try-again" onClick={() => void go(false)}>
              {CONVERSATION_WORDS.tryAgain}
            </Button>
          ) : null}
          <Button disabled={busy} data-k="conversation-copy" onClick={() => void go(true)}>
            {CONVERSATION_WORDS.copy}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
