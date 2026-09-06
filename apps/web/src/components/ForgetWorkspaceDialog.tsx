// SPDX-License-Identifier: AGPL-3.0-only
// The one confirmation before a gone workspace is forgotten, from a sidebar row
// or the machine tab: it names the workspace and what leaves this computer,
// asks the host once, and shows the host's refusal in place. The row leaves on
// workspace.deleted, which the store already applies.
import { useState } from "react";
import { forgetNotice, type WorkspaceView } from "@wsp/protocol";
import { errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "./ui/alert-dialog.js";
import { Button, WARN_BUTTON } from "./ui/button.js";

export function ForgetWorkspaceDialog({ workspace, threads, open, onOpenChange }: { workspace: WorkspaceView; threads: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useStore(s => s.api);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const change = (next: boolean): void => {
    if (!next) setRefusal(null);
    onOpenChange(next);
  };

  const forget = async (): Promise<void> => {
    if (!api?.forget) {
      setRefusal("This client cannot forget workspaces.");
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      await api.forget(workspace.id);
      change(false);
    } catch (e) {
      setRefusal(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Forget {workspace.name}?</AlertDialogTitle>
          <AlertDialogDescription>{forgetNotice(threads)}</AlertDialogDescription>
        </AlertDialogHeader>
        {refusal && (
          <p className="text-[11px] text-muted-foreground" data-k="forget-refusal">
            {refusal}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="outline" className={WARN_BUTTON} disabled={busy} onClick={() => void forget()}>
            {busy ? "Forgetting…" : "Forget"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
