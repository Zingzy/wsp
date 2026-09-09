// SPDX-License-Identifier: AGPL-3.0-only
// What the sidebar's cloud row opens: for now the one line pointing at wsp
// init in a terminal. The init-as-a-job modal lands in this same file, behind
// this same row; nothing else in the sidebar knows what the row opens.
import { CLOUD_SETUP_WORDS } from "@wsp/protocol";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";

export function CloudSetupDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{CLOUD_SETUP_WORDS.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p className="font-mono text-xs leading-relaxed text-muted-foreground">{CLOUD_SETUP_WORDS.noGolden}</p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
