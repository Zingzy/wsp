// SPDX-License-Identifier: AGPL-3.0-only
// The one confirmation before a file is put back as its last commit has it: nothing keeps what goes, so the dialog
// says so, the confirming button is the red one, and a refusal lands in the note's place without moving anything.
import { useState } from "react";
import { errorText } from "../lib/utils.js";
import { RefusalSlot } from "../settings/sheetParts.js";
import { AlertDialog, AlertDialogClose, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, NEUTRAL_RING } from "../components/ui/button.js";
import { DISCARD_WORDS } from "./words.js";

export function DiscardDialog({ name, onDiscard, onClose }: { name: string; onDiscard: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const go = async (): Promise<void> => {
    setBusy(true);
    setRefusal(null);
    try {
      await onDiscard();
      onClose();
    } catch (e) {
      setRefusal(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog open onOpenChange={open => (open ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{DISCARD_WORDS.title(name)}</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="px-5 pt-1">
          <RefusalSlot k="discard-refusal" {...(refusal !== null ? { said: refusal } : { note: DISCARD_WORDS.note })} />
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>{DISCARD_WORDS.cancel}</AlertDialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void go()} data-k="discard-confirm">
            {DISCARD_WORDS.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
