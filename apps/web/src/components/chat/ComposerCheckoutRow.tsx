// SPDX-License-Identifier: AGPL-3.0-only
// The strip under the composer naming where the thread works: the folder, the
// access picker and the git branch. The folder is a label, never a picker:
// before the first message it is the one the runtime's rule will open, the
// project's, and a folder that is not a project becomes one through Add a
// project. Once a turn exists it is the harness folder, which a cd in the
// agent's shell cannot move (the CLI keys a session to it), so the label
// explains itself on hover; the shell's own folder, as the agent's tool calls
// move it, is what the panes follow. The branch is read, not switched: the
// daemon has no checkout op, and a detached head shows no branch word.
import { FolderGitIcon, FolderIcon, GitBranchIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { checkoutCounts, DETACHED_HEAD } from "@wsp/protocol";
import { useRootStore, useThreadFolder } from "../../files/root";
import { useDaemonWire } from "../../files/wire";
import { PullRequestStrip } from "../../pull-request/PullRequestStrip";
import { useStatus, useStore } from "../../protocol/store";
import { useBranch, useLinkWord } from "../../terminal/paneWords";
import { cn } from "../../lib/utils";
import { BUTTON_GLYPH_INSET } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerSurface } from "./ComposerSurface";
import type { ChatThreadHandle } from "./useChatThread";

/** Whether the composer is about to open a new thread, so the folder is the one the next start opens rather than a
 * turn's: a fresh view, or an empty one whose send resumes no folder. */
export function opensThread(thread: ChatThreadHandle): boolean {
  const { cwd, entries, running } = thread.view;
  return thread.hydrated && (thread.fresh || (entries.length === 0 && !running && cwd === null));
}

/** The size both the folder and the branch wear, the access picker's beside them (size xs). */
const slotClass = "inline-flex h-7 items-center gap-1 px-2 text-sm text-muted-foreground sm:h-6 sm:text-xs";
/** The folder: the one item in the row that gives its width up, and that keeps what it cannot hold inside its own
 * box, so a long path is cut at its edge rather than drawn over the branch. */
const folderItemClass = "min-w-0 shrink overflow-hidden";
/** The path, cut at its head: the end of a path is the part a person recognises, so the ellipsis goes on the left,
 * which is what a right-to-left box gives. The isolate keeps the path's own order inside that box. */
const folderPathClass = "min-w-0 truncate font-mono [direction:rtl]";
/** A button's own glyph inset, so the path starts on the pixel the pickers' glyphs do. */
const labelClass = cn(slotClass, folderItemClass, BUTTON_GLYPH_INSET);

const LOCKED_FOLDER_NOTE = "The folder this thread's harness runs in. A cd inside the agent's shell does not move it; to work in another folder, add it as a project.";
const BRANCH_NOTE = "The folder's branch as the task reports it. Nothing here switches it; check out another branch from the terminal.";
/** The branch slot keeps the label's height while empty, so the row does not move when a branch arrives. */
const branchSlotClass = cn(slotClass, "min-w-0 font-mono");

/** The folder's path, cut at its head. */
function FolderPath({ path }: { path: string }) {
  return (
    <span className={folderPathClass}>
      <bdi dir="ltr">{path}</bdi>
    </span>
  );
}

export function ComposerCheckoutRow({
  workspaceId,
  thread,
  access = null,
  stash = null,
}: {
  workspaceId: string;
  thread: ChatThreadHandle;
  /** The access picker, and the one-line composer's mode toggles beside it. */
  access?: ReactNode;
  /** The word that counts the stashed prompts and opens them; nothing while there are none. */
  stash?: ReactNode;
}) {
  const wire = useDaemonWire(workspaceId);
  const follow = useRootStore(s => s.follow);
  const shell = useRootStore(s => s.shell);
  const startFolder = useThreadFolder(workspaceId);
  const linkWord = useLinkWord(workspaceId);
  const { cwd, shellCwd, running } = thread.view;
  const opening = opensThread(thread);
  // A view on a turn names that turn's folder; a view about to open a thread names the one the thread will start in.
  const folder = opening ? startFolder : (cwd ?? startFolder);
  const branch = useBranch(wire, folder, true, linkWord, { running, moved: thread.view.entries.length });
  // What the copy's own checkout holds uncommitted, beside the branch only where this folder is that checkout on that
  // branch: a folder of the thread's may be another repository altogether.
  const fact = useStatus(workspaceId)?.checkout;
  const checkoutPath = useStore(s => {
    const held = s.workspaces.find(w => w.id === workspaceId);
    return held?.copy?.path ?? held?.project.path;
  });
  const onCheckout = fact !== undefined && branch.kind === "repo" && folder === checkoutPath && fact.branch === branch.head;
  const counts = onCheckout ? checkoutCounts(fact) : [];

  useEffect(() => {
    if (cwd !== null) follow(workspaceId, cwd);
  }, [cwd, follow, workspaceId]);
  useEffect(() => {
    shell(workspaceId, shellCwd);
  }, [shell, shellCwd, workspaceId]);

  return (
    <ComposerSurface.ContextStrip data-composer-checkout data-opening={opening || undefined}>
      {/* The folder gives its width up first, down to a floor, then the branch line does; the access words beside it
          never give any. The weights are lopsided so the later ones' share rounds to nothing until the earlier ones
          reach their floors: a fraction of a pixel is enough to cut a branch's name. */}
      <div className={cn("flex min-w-20 shrink-[100000] items-center", access === null && "me-auto")}>
        {opening ? (
          <span className={labelClass} data-composer-folder={folder ?? undefined}>
            {branch.kind === "repo" ? <FolderGitIcon className="size-3 shrink-0" /> : <FolderIcon className="size-3 shrink-0" />}
            <FolderPath path={folder ?? ""} />
          </span>
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className={labelClass} tabIndex={0} data-composer-folder={folder ?? undefined} />}>
              {branch.kind === "repo" ? <FolderGitIcon className="size-3 shrink-0" /> : <FolderIcon className="size-3 shrink-0" />}
              <FolderPath path={folder ?? ""} />
            </TooltipTrigger>
            <TooltipPopup side="top" align="start" className="max-w-80">
              {LOCKED_FOLDER_NOTE}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      {access !== null ? <span className="-ms-1 me-auto flex shrink-0 items-center">{access}</span> : null}
      {stash}
      {branch.kind === "repo" && branch.head !== DETACHED_HEAD ? (
        <Tooltip>
          <TooltipTrigger render={<span className={branchSlotClass} tabIndex={0} data-composer-branch={branch.head} />}>
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="min-w-12 truncate">{branch.head}</span>
            {counts.length === 0 ? null : (
              // When the line runs out the counts go before the branch's name does, whole and from the last, each onto
              // a line the strip does not show; the empty first item holds that shown line, so even the first can go.
              <span data-composer-counts className="flex h-lh min-w-0 shrink-[100000] flex-wrap overflow-hidden">
                <span aria-hidden className="h-lh" />
                {counts.map(count => (
                  <span key={count} className="ms-3 whitespace-nowrap">
                    {count}
                  </span>
                ))}
              </span>
            )}
          </TooltipTrigger>
          <TooltipPopup side="top" align="end" className="max-w-80">
            {BRANCH_NOTE}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {branch.kind === "repo" && onCheckout ? <PullRequestStrip workspaceId={workspaceId} /> : null}
      {branch.kind === "repo" && branch.head !== DETACHED_HEAD ? null : (
        <span className={branchSlotClass} data-composer-branch={branch.kind === "repo" ? "detached" : branch.kind} />
      )}
    </ComposerSurface.ContextStrip>
  );
}

/** The strip under a project home's composer: no workspace exists yet, so it names the folder and the branch the
 * send's workspace starts from, off the project's own record. */
export function HomeCheckoutRow({ path, branch, access = null }: { path: string; branch: string; access?: ReactNode }) {
  return (
    <ComposerSurface.ContextStrip data-composer-checkout data-composer-home>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span className={labelClass} data-composer-folder={path}>
          <FolderGitIcon className="size-3 shrink-0" />
          <FolderPath path={path} />
        </span>
        {access !== null ? <span className="flex shrink-0 items-center">{access}</span> : null}
      </div>
      {branch !== "" ? (
        <span className={branchSlotClass} data-composer-branch={branch}>
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      ) : null}
    </ComposerSurface.ContextStrip>
  );
}
