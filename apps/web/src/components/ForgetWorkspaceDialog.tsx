// SPDX-License-Identifier: AGPL-3.0-only
// The one confirmation before a workspace goes, on either road out: a delete,
// which takes its machine in that kind's own words and its record with it, and
// a forget, which is the same road for a workspace whose machine is already
// gone. It names the workspace and what leaves, asks the host once, and shows
// the host's refusal in place. Keep this one ends several copies at once
// through the same dialog, naming how many go, as Delete copies does a settled
// tree's. A delete first reads each copy's checkout and names any copy that
// holds commits not pushed or uncommitted files. With Ask before deleting
// off on General, a delete whose copies all read clean goes without the
// dialog, as does a forget, whose machine is already gone; a copy holding
// work, or one whose checkout could not be read, still asks, and a refusal
// still opens the dialog to say it. The row leaves on workspace.deleted,
// which the store already applies.
import { useEffect, useRef, useState } from "react";
import { deleteCopiesNotice, deleteNotice, forgetNotice, isProviderPlace, placeName, placeOf, unpushedLine, workspaceKind, type Checkout, type StandsOn, type WorkspaceView } from "@wsp/protocol";
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
  copies = false,
  open,
  onOpenChange,
}: {
  /** One workspace, or the copies Keep this one or Delete copies ends together. */
  workspaces: ReadonlyArray<WorkspaceView>;
  threads: number;
  /** Which road out this dialog is for; a workspace whose machine is gone takes the forget. */
  act?: "forget" | "delete";
  /** Delete copies, which names every copy it takes, where Keep this one names the others. */
  copies?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const asks = useStore(s => s.preferences.askDelete);
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
  const [read, setRead] = useState<ReadonlyMap<string, Checkout | undefined> | null>(null);

  // Read fresh as the dialog opens: what a copy holds is what the delete would lose, and a fact held from before can
  // be old, so a read that fails or answers no checkout is said as such, never filled in from it.
  useEffect(() => {
    if (!open || act !== "delete") return;
    let gone = false;
    setRead(null);
    const ask = api?.workspaceCheckout;
    void Promise.all(
      workspaces.map(async w => {
        try {
          return [w.id, ask === undefined ? undefined : (await ask(w.id)).checkout] as const;
        } catch {
          return [w.id, undefined] as const;
        }
      }),
    ).then(pairs => {
      if (!gone) setRead(new Map(pairs));
    });
    return () => {
      gone = true;
    };
  }, [open, act, api, workspaces.map(w => w.id).join("\0")]);
  const reading = act === "delete" && read === null;
  const holding = read === null ? [] : workspaces.flatMap(w => unpushedLine(w.name, read.get(w.id)) ?? []);

  // Off on General, nothing that would be lost asks: a forget, whose machine is gone, or a delete whose copies all
  // read clean. A copy holding work or read as unknown asks whatever the switch says.
  const quiet = !asks && (act === "forget" || (read !== null && holding.length === 0));
  // While the copies are read the dialog waits unseen, so a clean delete never flashes one.
  const shown = asks || refusal !== null || (act === "delete" && read !== null && holding.length > 0);
  const went = useRef(false);

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

  useEffect(() => {
    if (!open || !quiet || went.current) return;
    went.current = true;
    void forget();
  });

  if (workspace === undefined) return null;
  return (
    <AlertDialog open={open && shown} onOpenChange={change}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{many ? (copies ? `${road.word} ${workspaces.length} copies?` : `${road.word} the other ${workspaces.length} copies?`) : `${road.word} ${workspace.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {many
              ? deleteCopiesNotice(
                  workspaces.map(w => {
                    const on = standsOn(w);
                    return { name: w.name, kind: workspaceKind(w), ...(w.worktree?.made === true ? { copy: { path: w.worktree.path } } : {}), ...(on !== undefined ? { on } : {}) };
                  }),
                  threads,
                )
              : act === "delete" ? deleteNotice(threads, workspaceKind(workspace), workspace.worktree?.made === true ? { path: workspace.worktree.path } : undefined, undefined, on) : forgetNotice(threads)}
          </AlertDialogDescription>
          {holding.length === 0 ? null : (
            <ul data-k="unpushed" className="mt-2 flex flex-col gap-1 text-[13px] leading-5 text-foreground">
              {holding.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </AlertDialogHeader>
        <div className="px-5 pt-2">
          <RefusalSlot k="forget-refusal" {...(refusal ? { said: refusal } : {})} />
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>Cancel</AlertDialogClose>
          <Button variant="destructive" disabled={busy || reading} onClick={() => void forget()} data-k="end-workspace">
            {busy ? road.busy : road.word}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
