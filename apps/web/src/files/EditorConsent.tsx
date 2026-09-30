// SPDX-License-Identifier: AGPL-3.0-only
// The one question an editor's road into a workspace on another computer asks: may wsp put one line at the top of
// the person's ~/.ssh/config. Raised by an Open the host refused for want of that line, whichever road the Open
// came by, and on yes the line goes in and the same Open runs again.
import { create } from "zustand";
import { hereName, type EditorId } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { usePlaces, useStore } from "../protocol/store.js";
import { openFailed } from "./openCopy.js";

export const EDITOR_SSH_WORDS = {
  title: "Open in your editor over SSH",
  says: "wsp adds one line to ~/.ssh/config. It covers only hosts named wsp-*, and nothing else in the file changes.",
  /** What changes once an editor is attached, which the agent there being root already did not: its server runs
   * inside the workspace for as long as the window is open, and what runs there can reach this computer through it. */
  reach: (computer: string) => `While your editor is connected, the workspace can reach ${computer || "your computer"} through it: ports it forwards, files it asks to open, and your editor's git sign-in.`,
  off: "Remove it any time in Settings, General.",
  add: "Add to SSH config",
  setting: "Editors over ssh",
  settingNote: "One line at the top of ~/.ssh/config lets your editor open a workspace on another computer.",
  small: "An editor here takes about what one more thread does, or more.",
  /** The tile's word while an editor is connected, which also keeps the workspace awake. */
  attached: "editor attached",
} as const;

/** The Open waiting on the person's answer: the workspace it was for and the Open to run again on a yes. */
interface Asking {
  workspaceId: string;
  run: () => Promise<void>;
}

export const useSshConsent = create<{ asking: Asking | null }>(() => ({ asking: null }));

export function EditorConsent({ workspaceId }: { workspaceId: string }) {
  const asking = useSshConsent(s => (s.asking?.workspaceId === workspaceId ? s.asking : null));
  const include = useStore(s => s.api?.sshInclude);
  const computer = hereName(usePlaces());
  if (asking === null || include === undefined) return null;
  const close = (): void => useSshConsent.setState({ asking: null });
  const add = async (): Promise<void> => {
    close();
    try {
      await include(true);
      await asking.run();
    } catch (e) {
      openFailed(e);
    }
  };
  return (
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogPopup data-k="editor-ssh">
        <DialogHeader>
          <DialogTitle>{EDITOR_SSH_WORDS.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2 pt-1">
          <DialogDescription className="text-sm text-foreground">{EDITOR_SSH_WORDS.says}</DialogDescription>
          <p className="text-[13px] leading-5 text-muted-foreground">{EDITOR_SSH_WORDS.reach(computer)}</p>
          <p className="text-[13px] leading-5 text-muted-foreground">{EDITOR_SSH_WORDS.off}</p>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="button" data-k="editor-ssh-add" onClick={() => void add()}>
            {EDITOR_SSH_WORDS.add}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
