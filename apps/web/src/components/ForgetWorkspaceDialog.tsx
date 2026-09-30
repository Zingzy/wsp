// SPDX-License-Identifier: AGPL-3.0-only
// The one confirmation before a workspace goes, on either road out: a delete,
// which takes its machine in that kind's own words and its record with it, and
// a forget, which is the same road for a workspace whose machine is already
// gone. It names the workspace and what leaves, asks the host once, and shows
// the host's refusal in place. Keep this one ends several copies at once
// through the same dialog, naming how many go. The row leaves on
// workspace.deleted, which the store already applies.
import { useState } from "react";
import { deleteCopiesNotice, deleteNotice, forgetNotice, isProviderPlace, placeName, placeOf, workspaceKind, type StandsOn, type WorkspaceView } from "@wsp/protocol";
import { CLIENT_CANNOT_DELETE, CLIENT_CANNOT_FORGET } from "../actions/format.js";
import { errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { RefusalSlot } from "../settings/sheetParts.js";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "./ui/alert-dialog.js";
import { Button, NEUTRAL_RING } from "./ui/button.js";

/** The two roads out, each with the word on its button, the sentence under the title and the verb it asks for. */
const ROADS = {
  delete: { word: "Delete", busy: "Deleting\u2026", cannot: CLIENT_CANNOT_DELETE },
  forget: { word: "Forget", busy: "Forgetting\u2026", cannot: CLIENT_CANNOT_FORGET },
} as const;

export function ForgetWorkspaceDialog({
  workspaces,
  threads,
  act = "forget",
  open,
  onOpenChange,
}: {
  /** One workspace, or the copies Keep this one ends together. */
  workspaces: ReadonlyArray<WorkspaceView>;
  threads: number;
  /** Which road out this dialog is for; a workspace whose machine is gone takes the forget. */
  act?: "forget" | "delete";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const road = ROADS[act];
  const [workspace] = workspaces;
  // A workspace on a computer somebody joined is deleted from that computer, named as the app names it.
  const standsOn = (w: WorkspaceView): StandsOn | undefined => {
    const joined = w.place === undefined ? undefined : placeOf(places, w);
    // A fork at another provider's account is a cloud machine, whose delete takes its kind's words.
    return joined === undefined || isProviderPlace(joined) ? undefined : { name: w.name, computer: placeName(joined) };
  };
  const on = workspace === undefined ? undefined : standsOn(workspace);
  const many = workspaces.length > 1;
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const change = (next: boolean): void => {
    if (!next) setRefusal(null);
    onOpenChange(next);
  };

  const forget = async (): Promise<void> => {
    const ask = act === "delete" ? api?.deleteWorkspace : api?.forget;
    if (!ask) {
      setRefusal(road.cannot);
      return;
    }
    setBusy(true);
    setRefusal(null);
    // Each goes on its own, so one the host refuses leaves the rest going and its refusal stands in the slot.
    const refused = (await Promise.allSettled(workspaces.map(w => ask(w.id)))).find(r => r.status === "rejected");
    setBusy(false);
    if (refused === undefined) change(false);
    else setRefusal(errorText(refused.reason));
  };

  if (workspace === undefined) return null;
  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{many ? `${road.word} the other ${workspaces.length} copies?` : `${road.word} ${workspace.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {many
              ? deleteCopiesNotice(
                  workspaces.map(w => {
                    const on = standsOn(w);
                    return { name: w.name, kind: workspaceKind(w), ...(w.copy !== undefined ? { copy: w.copy } : {}), ...(on !== undefined ? { on } : {}) };
                  }),
                  threads,
                )
              : act === "delete" ? deleteNotice(threads, workspaceKind(workspace), workspace.copy, undefined, on) : forgetNotice(threads)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="px-5 pt-2">
          <RefusalSlot k="forget-refusal" {...(refusal ? { said: refusal } : {})} />
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>Cancel</AlertDialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void forget()} data-k="end-workspace">
            {busy ? road.busy : road.word}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
