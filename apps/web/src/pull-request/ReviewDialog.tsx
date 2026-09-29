// SPDX-License-Identifier: AGPL-3.0-only
// Review with an agent: the reviewer picked, Codex first by the owner's rule, and Start, which opens the reviewer's
// workspace and thread.
import { useState } from "react";
import { agentName } from "@wsp/catalog";
import { START_WORDS } from "@wsp/protocol";
import { Button, NEUTRAL_RING } from "../components/ui/button.js";
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { RefusalSlot } from "../settings/sheetParts.js";
import { useStore } from "../protocol/store.js";

const REVIEWERS = ["codex", "claude"] as const;

export function ReviewDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [agent, setAgent] = useState<(typeof REVIEWERS)[number]>("codex");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const start = async (): Promise<void> => {
    const review = useStore.getState().api?.review;
    if (review === undefined) return;
    setBusy(true);
    setRefusal(null);
    try {
      const made = await review({ workspaceId, agent });
      useStore.getState().select(made.workspace.id, made.threadId);
      onClose();
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{START_WORDS.reviewWithAgent}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 px-5 pt-1">
          <SegmentedControl aria-label="Reviewer" value={agent} segments={REVIEWERS.map(a => ({ value: a, label: agentName(a) }))} onChange={setAgent} className="self-start" />
          <RefusalSlot k="review-refusal" {...(refusal !== null ? { said: refusal } : { note: "Reads the pull request in a fresh copy and changes nothing. Its review waits here until you post it." })} />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>Cancel</DialogClose>
          <Button disabled={busy} onClick={() => void start()} data-k="review-start">
            Start
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
