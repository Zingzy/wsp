// SPDX-License-Identifier: AGPL-3.0-only
// Fork from here, from a reply or a person's message. Where the fork can only
// run in its thread's folder it opens the draft at once; where a new branch can
// be offered it asks first, as two picks in a card, the branch the worktree
// would take as that pick's fact. Mounted once for the whole window; a row asks
// for it through a shell request. Nothing reaches the host until the draft's
// send.
import { useEffect, useState } from "react";
import { FolderIcon, GitBranchIcon } from "lucide-react";
import { FORK_BRANCH_HEAD_NOTE, FORK_BRANCH_NOTE, FORK_PICK_WORDS, forkBranchName, forkDialogLine, forkFolderNote, isImage } from "@wsp/protocol";
import { useDaemonWire } from "../../files/wire.js";
import { Card } from "../../settings/rows.js";
import { Choice } from "../../settings/add/PickLists.js";
import { STEP_BODY, STEP_HEAD, StepFoot } from "../../settings/add/StepDialog.js";
import { GLYPH, SETTING_TITLE } from "../../settings/layout.js";
import { onForkRequest, requestComposerFocus, requestNewThread, type ForkRequest } from "../../shell/shellRequests.js";
import { gitBranches } from "../../terminal/daemon-fs.js";
import { Button, NEUTRAL_RING } from "../ui/button.js";
import { Dialog, DialogClose, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog.js";
import { RadioGroup } from "../ui/radio-group.js";
import { EMPTY_DRAFT, useComposerDraftStore } from "./composerDraftStore.js";
import { fileFromStash, useComposerFilesStore } from "./composerFiles.js";
import { useComposerOptionsStore } from "./composerOptionsStore.js";
import { forkSourceOf, useForkDrafts } from "./forks.js";

/** Opens the fork's draft: a fresh composer in the thread's workspace under the fork's banner, its pickers on the
 * source's agent, model and effort, holding the person's message and its images where the fork came off one. */
export function openForkDraft(request: ForkRequest, branch?: string): void {
  const { workspaceId, threadId, title, pick } = request;
  const message = pick.message;
  const before = message === undefined ? undefined : { draft: useComposerDraftStore.getState().drafts[workspaceId] ?? EMPTY_DRAFT, files: useComposerFilesStore.getState().take(workspaceId) };
  const draft = { source: { workspaceId, threadId, title }, fork: forkSourceOf(threadId, pick), ...(branch !== undefined ? { branch } : {}), ...(before !== undefined ? { before } : {}) };
  useForkDrafts.getState().open(workspaceId, draft);
  requestNewThread({ workspaceId });
  // A fresh view's key is its workspace's, which is what these picks are stamped with.
  const options = useComposerOptionsStore.getState();
  options.pick(workspaceId, "harness", request.harness, workspaceId);
  if (request.model !== undefined) options.pick(workspaceId, "model", request.model, workspaceId);
  if (request.effort !== undefined) options.pick(workspaceId, "effort", request.effort, workspaceId);
  if (message !== undefined) {
    useComposerDraftStore.getState().setDraft(workspaceId, { prompt: message.text, cursor: message.text.length });
    const { requestId } = message;
    const read = useComposerFilesStore.getState().kept;
    if (requestId !== undefined && read !== undefined) {
      // The images alone come back, read off the host that keeps them: a file that was no image reached the thread's
      // folder and is not kept.
      void Promise.allSettled(
        message.attachments.flatMap((record, index) =>
          isImage(record.mediaType) ? [read(workspaceId, threadId, requestId, index).then(image => fileFromStash({ mediaType: image.mediaType, name: record.name ?? `image ${index + 1}`, bytes: image.bytes, size: record.bytes }))] : [],
        ),
      ).then(settled => {
        const images = settled.flatMap(r => (r.status === "fulfilled" ? [r.value] : []));
        if (images.length > 0 && useForkDrafts.getState().drafts[workspaceId] === draft) useComposerFilesStore.getState().put(workspaceId, images);
      });
    }
  }
  requestComposerFocus(workspaceId);
}

export function ForkDialogHost() {
  const [request, setRequest] = useState<ForkRequest | null>(null);
  useEffect(
    () =>
      onForkRequest(next => {
        if (next.branchFrom === null) openForkDraft(next);
        else setRequest(next);
      }),
    [],
  );
  if (request === null) return null;
  return <ForkDialog request={request} onClose={() => setRequest(null)} />;
}

type Pick = "folder" | "branch";

function ForkDialog({ request, onClose }: { request: ForkRequest; onClose: () => void }) {
  const { workspaceId, threadId, title, pick, branchFrom } = request;
  const wire = useDaemonWire(workspaceId);
  // New branch is the pick where a later turn changed files, since the folder no longer holds this turn's.
  const [choice, setChoice] = useState<Pick>(pick.laterChanged ? "branch" : "folder");
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (wire === null || branchFrom === null) return;
    let live = true;
    void gitBranches(wire, branchFrom).then(
      read => live && setBranch(forkBranchName(read.current, new Set(read.branches.map(b => b.name)), threadId)),
      () => live && setBranch(forkBranchName(undefined, new Set(), threadId)),
    );
    return () => {
      live = false;
    };
  }, [wire, branchFrom, threadId]);
  const go = (): void => {
    onClose();
    if (choice === "branch" && branch !== null) openForkDraft(request, branch);
    else openForkDraft(request);
  };
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogPopup data-fork-dialog>
        <DialogHeader className={STEP_HEAD}>
          <div className="flex min-w-0 flex-col gap-1">
            <DialogTitle>{FORK_PICK_WORDS.title}</DialogTitle>
            <DialogDescription>{forkDialogLine(title)}</DialogDescription>
          </div>
        </DialogHeader>
        <DialogPanel className={STEP_BODY}>
          <RadioGroup value={choice} onValueChange={next => setChoice(next as Pick)} aria-label="Where the fork runs" className="gap-0">
            <Card id="fork-picks">
              <Choice id="folder" title={SETTING_TITLE} picked={choice === "folder"} glyph={<FolderIcon aria-hidden className={GLYPH} />} name={FORK_PICK_WORDS.folder} note={forkFolderNote(title)} />
              <Choice id="branch" title={SETTING_TITLE} picked={choice === "branch"} glyph={<GitBranchIcon aria-hidden className={GLYPH} />} name={FORK_PICK_WORDS.branch} note={pick.based ? FORK_BRANCH_NOTE : FORK_BRANCH_HEAD_NOTE} {...(branch !== null ? { fact: branch } : {})} />
            </Card>
          </RadioGroup>
        </DialogPanel>
        <StepFoot left={null}>
          <DialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>Cancel</DialogClose>
          <Button data-k="fork-confirm" disabled={choice === "branch" && branch === null} onClick={go}>
            {FORK_PICK_WORDS.fork}
          </Button>
        </StepFoot>
      </DialogPopup>
    </Dialog>
  );
}
