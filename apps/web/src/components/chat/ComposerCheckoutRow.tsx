// SPDX-License-Identifier: AGPL-3.0-only
// The row under the composer naming where the thread works, in one grammar as
// T3 Code's BranchToolbar: the computer's icon and name, the access picker,
// the stashed prompts and the git branch, each the same 12 px sans in the one
// muted ink with a 12 px icon, the same height and padding, a faint chevron
// only on what opens a menu, one even gap, left to right. Quiet text on the
// page, no tray. The folder is not on the row: the tile's card says it. Before
// the first message it is the one the runtime's rule will open, the project's;
// once a turn exists it is the harness folder, which a cd in the agent's shell
// cannot move; the shell's own folder, as the agent's tool calls move it, is
// what the panes follow. The branch is read, not switched: the daemon has no
// checkout op, and a detached head shows no branch word.
import { GitBranchIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { DETACHED_HEAD, type PlaceView } from "@wsp/protocol";
import { projectFolderOf, useRootStore, useThreadFolder } from "../../files/root";
import { useDaemonWire } from "../../files/wire";
import { useStatus, useWorkspace } from "../../protocol/store";
import { ComputerGlyph } from "../../settings/ComputerGlyph";
import { useComputer, useComputerName } from "../../sidebar/workspaceRows";
import { useBranch, useLinkWord } from "../../terminal/paneWords";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerSurface } from "./ComposerSurface";
import type { ChatThreadHandle } from "./useChatThread";

/** Whether the composer is about to open a new thread, so the folder is the one the next start opens rather than a
 * turn's: a fresh view, or an empty one whose send resumes no folder. */
export function opensThread(thread: ChatThreadHandle): boolean {
  const { cwd, entries, running } = thread.view;
  return thread.hydrated && (thread.fresh || (entries.length === 0 && !running && cwd === null));
}

/** Every item of the row: the computer, the access picker, the stash word and the branch. */
export const ROW_ITEM_CLASS = "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-normal text-muted-foreground sm:h-6 [&_svg]:size-3 [&_svg]:shrink-0";

const BRANCH_NOTE = "The folder's branch as the task reports it. Nothing here switches it; check out another branch from the terminal.";

/** The computer the thread runs on: its icon, as the Computers page draws it, and its name, the row's first item. */
export function RowComputer({ name, place, children }: { name: string; place: PlaceView | undefined; children?: ReactNode }) {
  return (
    <span data-composer-computer className={ROW_ITEM_CLASS}>
      {place === undefined ? null : <ComputerGlyph place={place} className="size-3" />}
      <span className="min-w-0 max-w-60 truncate">{name}</span>
      {children}
    </span>
  );
}

/** The branch with its icon, and the note that it is read, not switched, on its hover. Empty where none is known, at
 * the same height, so the row does not move when a branch arrives; `why` says which empty it is. */
function RowBranch({ head, why = "" }: { head: string | null; why?: string }) {
  if (head === null) return <span className={ROW_ITEM_CLASS} data-composer-branch={why} />;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn(ROW_ITEM_CLASS, "min-w-0 shrink")} tabIndex={0} data-composer-branch={head} />}>
        <GitBranchIcon aria-hidden />
        <span className="min-w-0 max-w-60 truncate">{head}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" align="start" className="max-w-80">
        {BRANCH_NOTE}
      </TooltipPopup>
    </Tooltip>
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
  access?: ReactNode;
  /** The word that counts the stashed prompts and opens them; nothing while there are none. */
  stash?: ReactNode;
}) {
  const wire = useDaemonWire(workspaceId);
  const follow = useRootStore(s => s.follow);
  const shell = useRootStore(s => s.shell);
  const startFolder = useThreadFolder(workspaceId);
  const linkWord = useLinkWord(workspaceId);
  const computer = useComputerName(workspaceId);
  const place = useComputer(workspaceId);
  const { cwd, shellCwd, running } = thread.view;
  const opening = opensThread(thread);
  // A view on a turn reads that turn's folder; a view about to open a thread reads the one the thread will start in.
  const folder = opening ? startFolder : (cwd ?? startFolder);
  // The workspace's own checkout reads as the host last read it, the one fact its tile shows; another folder asks git.
  const workspace = useWorkspace(workspaceId);
  const fact = useStatus(workspaceId)?.checkout;
  const onCheckout = fact !== undefined && workspace !== null && folder === projectFolderOf(workspace);
  const branch = useBranch(wire, folder, !onCheckout, linkWord, { running, moved: thread.view.entries.length });
  const head = onCheckout ? fact.branch : branch.kind === "repo" ? branch.head : null;

  useEffect(() => {
    if (cwd !== null) follow(workspaceId, cwd);
  }, [cwd, follow, workspaceId]);
  useEffect(() => {
    shell(workspaceId, shellCwd);
  }, [shell, shellCwd, workspaceId]);

  return (
    <ComposerSurface.ContextStrip data-composer-checkout data-opening={opening || undefined} data-composer-folder={folder ?? undefined}>
      <RowComputer name={computer} place={place} />
      {access}
      {stash}
      <RowBranch head={head !== null && head !== DETACHED_HEAD ? head : null} why={onCheckout || branch.kind === "repo" ? "detached" : branch.kind} />
    </ComposerSurface.ContextStrip>
  );
}

/** The row under a project home's composer: no workspace exists yet, so it names where the send will run (the
 * computer, a picker where several hold the repo), the access and the branch the workspace starts from, off the
 * project's own record. */
export function HomeCheckoutRow({ path, branch, where = null, access = null }: { path: string; branch: string; where?: ReactNode; access?: ReactNode }) {
  return (
    <ComposerSurface.ContextStrip data-composer-checkout data-composer-home data-composer-folder={path}>
      {where}
      {access}
      <RowBranch head={branch === "" ? null : branch} />
    </ComposerSurface.ContextStrip>
  );
}
