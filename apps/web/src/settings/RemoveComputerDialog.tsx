// SPDX-License-Identifier: AGPL-3.0-only
// The one confirmation before a computer or a provider is taken back out. The
// sentence is computed from what that computer holds right now, so a person
// reads what leaves rather than a warning; the host's own refusal lands under
// it in the refusal slot, with the host's fix.
//
// A computer that is not answering cannot be swept from here, so the dialog
// hands over the line that sweeps it on the computer itself. Where the login
// it was added over runs sudo only with a password, the refusal asks for it
// in a field under the slot, held in this dialog alone and sent with the next
// Remove.
import { useState } from "react";
import { PLACE_SUDO_KIND, PLACES_WORDS, type PlaceView } from "@wsp/protocol";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, NEUTRAL_RING } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { cn } from "../lib/utils.js";
import { failureOf } from "../protocol/failure.js";
import { useStore } from "../protocol/store.js";
import { ADD_COMPUTER_WORDS, WHERE_WORDS } from "./format.js";
import { ROW_FIELD } from "./layout.js";
import { hereName, placeIsOffline, removeSentence, removeTitle, type PlaceHolding } from "./places.js";
import { CopyRow, RefusalSlot } from "./sheetParts.js";

/** What the app says when its own client carries no remove road: the same shape the forget dialog's refusal has. */
export const CANNOT_REMOVE = "this wsp cannot take a computer back out from here";

export function RemoveComputerDialog({ place, holding, imageBytes, open, onOpenChange, onRemoved }: { place: PlaceView; holding: PlaceHolding; imageBytes?: number; open: boolean; onOpenChange: (open: boolean) => void; onRemoved?: () => void }) {
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ said: string; fix?: string } | null>(null);
  const [asksSudo, setAsksSudo] = useState(false);
  const [password, setPassword] = useState("");

  const change = (next: boolean): void => {
    if (!next) {
      setRefusal(null);
      setAsksSudo(false);
      setPassword("");
    }
    onOpenChange(next);
  };

  const remove = async (): Promise<void> => {
    if (api?.removePlace === undefined) {
      setRefusal({ said: CANNOT_REMOVE });
      return;
    }
    const typed = asksSudo && password !== "" ? password : undefined;
    setPassword("");
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await api.removePlace(place.id, typed);
      // A remove the host did not make is not a failure to report twice: the row is already gone from the list.
      if (answer.note !== undefined && !answer.removed) setRefusal({ said: answer.note });
      else {
        onRemoved?.();
        change(false);
      }
    } catch (e) {
      const failure = failureOf(e);
      // The host's fix names the terminal and this confirm for a client with no field; here the field is the fix.
      const sudo = failure.kind === PLACE_SUDO_KIND;
      setAsksSudo(sudo);
      setRefusal({ said: failure.said, ...(sudo ? { fix: ADD_COMPUTER_WORDS.sudoFix } : failure.fix === undefined ? {} : { fix: failure.fix }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogPopup data-remove-place-dialog>
        <AlertDialogHeader>
          <AlertDialogTitle data-k="remove-title">{removeTitle(place)}</AlertDialogTitle>
          <AlertDialogDescription data-k="remove-sentence">{removeSentence(place, holding, hereName(places), imageBytes)}</AlertDialogDescription>
        </AlertDialogHeader>
        {placeIsOffline(place) ? (
          <div className="flex flex-col gap-3 px-5 pt-2">
            <CopyRow k="leave-line" value={PLACES_WORDS.remove.leaveLine} />
            <p className="text-[13px] text-muted-foreground">{PLACES_WORDS.remove.leaveTakes}</p>
          </div>
        ) : null}
        <div className="flex flex-col gap-2 px-5 pt-2">
          <RefusalSlot k="remove-refusal" {...(refusal ?? {})} />
          {asksSudo ? <Input data-k="sudo-password" aria-label="Password for sudo" type="password" autoFocus autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && password !== "" && void remove()} className={cn(ROW_FIELD, "w-44")} /> : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>{WHERE_WORDS.cancel}</AlertDialogClose>
          <Button data-k="remove-confirm" variant="destructive" disabled={busy || (asksSudo && password === "")} onClick={() => void remove()}>
            {busy ? WHERE_WORDS.removing : WHERE_WORDS.remove}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
