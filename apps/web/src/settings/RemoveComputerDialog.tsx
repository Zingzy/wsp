// SPDX-License-Identifier: AGPL-3.0-only
// The one confirmation before a computer or a provider is taken back out. The
// sentence is computed from what that computer holds right now, so a person
// reads what leaves rather than a warning; the host's own refusal lands under
// it in the muted line, as the forget dialog already does.
import { useState } from "react";
import type { PlaceView } from "@wsp/protocol";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, WARN_BUTTON } from "../components/ui/button.js";
import { errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { WHERE_WORDS } from "./format.js";
import { removeSentence, removeTitle, type PlaceHolding } from "./places.js";

/** What the app says when its own client carries no remove road: the same shape the forget dialog's refusal has. */
export const CANNOT_REMOVE = "this wsp cannot take a computer back out from here";

export function RemoveComputerDialog({ place, holding, imageBytes, open, onOpenChange, onRemoved }: { place: PlaceView; holding: PlaceHolding; imageBytes?: number; open: boolean; onOpenChange: (open: boolean) => void; onRemoved?: () => void }) {
  const api = useStore(s => s.api);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const change = (next: boolean): void => {
    if (!next) setRefusal(null);
    onOpenChange(next);
  };

  const remove = async (): Promise<void> => {
    if (api?.removePlace === undefined) {
      setRefusal(CANNOT_REMOVE);
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await api.removePlace(place.id);
      // A remove the host did not make is not a failure to report twice: the row is already gone from the list.
      if (answer.note !== undefined && !answer.removed) setRefusal(answer.note);
      else {
        onRemoved?.();
        change(false);
      }
    } catch (e) {
      setRefusal(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogPopup data-remove-place-dialog>
        <AlertDialogHeader>
          <AlertDialogTitle data-k="remove-title">{removeTitle(place)}</AlertDialogTitle>
          <AlertDialogDescription data-k="remove-sentence">{removeSentence(place, holding, imageBytes)}</AlertDialogDescription>
        </AlertDialogHeader>
        {refusal === null ? null : (
          <p className="text-[11px] text-muted-foreground" data-k="remove-refusal">
            {refusal}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>{WHERE_WORDS.cancel}</AlertDialogClose>
          <Button data-k="remove-confirm" variant="outline" className={WARN_BUTTON} disabled={busy} onClick={() => void remove()}>
            {busy ? WHERE_WORDS.removing : WHERE_WORDS.remove}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
