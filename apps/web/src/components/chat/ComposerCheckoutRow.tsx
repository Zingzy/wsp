// SPDX-License-Identifier: AGPL-3.0-only
// The row under the composer naming where the thread works, in one grammar as
// T3 Code's BranchToolbar: the computer's icon and name, the access picker,
// the stashed prompts and the git branch, each the same 12 px sans in the one
// muted ink with a 12 px icon, the same height and padding, a faint chevron
// only on what opens a menu, one even gap, left to right, seated in the tray
// joined to the box's foot. The folder is not on the row: the tile's card says it. Before
// the first message it is the one the runtime's rule will open, the project's;
// once a turn exists it is the harness folder, which a cd in the agent's shell
// cannot move; the shell's own folder, as the agent's tool calls move it, is
// what the panes follow. The branch is read, not switched: the daemon has no
// checkout op, and a detached head shows no branch word.
import { GitBranchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DETACHED_HEAD, type PlaceView, type ProjectBranch } from "@wsp/protocol";
import { projectFolderOf, useRootStore, useThreadFolder } from "../../files/root";
import { useDaemonWire } from "../../files/wire";
import { useStatus, useStore, useWorkspace } from "../../protocol/store";
import { ComputerGlyph } from "../../settings/ComputerGlyph";
import { useComputer, useComputerName } from "../../sidebar/workspaceRows";
import { useBranch, useLinkWord } from "../../terminal/paneWords";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerSurface } from "./ComposerSurface";
import type { ChatThreadHandle, ChatThreadView } from "./useChatThread";

/** How many of the agent's calls have finished, its own and its subagents' folds, as the timeline holds them. */
function finishedCalls(entries: ChatThreadView["entries"]): number {
  let n = 0;
  for (const entry of entries) {
    if (entry.kind === "work" && (entry.entry.toolLifecycleStatus === "completed" || entry.entry.toolLifecycleStatus === "failed")) n += 1;
    else if (entry.kind === "subagent" && entry.subagent.state !== "running") n += 1;
  }
  return n;
}

/** Whether the composer is about to open a new thread, so the folder is the one the next start opens rather than a
 * turn's: a fresh view, or an empty one whose send resumes no folder. */
export function opensThread(thread: ChatThreadHandle): boolean {
  const { cwd, entries, running } = thread.view;
  return thread.hydrated && (thread.fresh || (entries.length === 0 && !running && cwd === null));
}

/** Every item of the row: the computer, the access picker, the stash word and the branch. */
export const ROW_ITEM_CLASS = "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-normal text-muted-foreground sm:h-6 [&_svg]:size-3 [&_svg]:shrink-0";

const BRANCH_NOTE = "The folder's branch as the task reports it. Nothing here switches it; check out another branch from the terminal.";
const COPY_BRANCH_NOTE = "The branch a new copy of the project starts from.";

/** How often a composer about to open a thread reads its branch again while the window shows it, so a checkout made
 * in a terminal reaches the row without a send. */
export const BRANCH_REREAD_MS = 5_000;

/** Calls `read` now, each time the window comes back, and every BRANCH_REREAD_MS while the page is visible. */
function useRereads(on: boolean, read: () => void): void {
  useEffect(() => {
    if (!on) return;
    const again = (): void => {
      if (document.visibilityState === "visible") read();
    };
    read();
    const timer = setInterval(again, BRANCH_REREAD_MS);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [on, read]);
}

/** The branch a new thread of the project starts on, as the host reads it now; null until its first answer lands,
 * since the record's own branch is the remote's default and not what a folder is on. */
export function useProjectBranch(projectId: string | null): ProjectBranch | null {
  const api = useStore(s => s.api);
  const [read, setRead] = useState<{ projectId: string; said: ProjectBranch } | null>(null);
  const asked = useRef(projectId);
  asked.current = projectId;
  const ask = useCallback(() => {
    if (projectId === null) return;
    const land = (said: ProjectBranch): void => {
      if (asked.current === projectId) setRead(was => (was?.projectId === projectId && was.said.branch === said.branch && was.said.folder === said.folder ? was : { projectId, said }));
    };
    // A read that failed knows no branch, so the chip goes empty rather than keep one the folder may have left.
    void api?.projectBranch?.(projectId).then(land, () => land({ branch: null, folder: true }));
  }, [api, projectId]);
  const held = read !== null && read.projectId === projectId ? read.said : null;
  // A copy's branch is the record's, which no checkout in a terminal moves: one read is the whole of it.
  useRereads(projectId !== null && api?.projectBranch !== undefined && held?.folder !== false, ask);
  return held;
}

/** The computer the thread runs on: its icon, as the Computers page draws it, and its name, the row's first item. */
export function RowComputer({ name, place, className }: { name: string; place: PlaceView | undefined; className?: string }) {
  return (
    <span data-composer-computer className={cn(ROW_ITEM_CLASS, className)}>
      {place === undefined ? null : <ComputerGlyph place={place} className="size-3" />}
      <span className="min-w-0 max-w-60 truncate">{name}</span>
    </span>
  );
}

/** The branch with its icon, and the note that it is read, not switched, on its hover. Empty where none is known, at
 * the same height, so the row does not move when a branch arrives; `why` says which empty it is. */
function RowBranch({ head, why = "", note = BRANCH_NOTE }: { head: string | null; why?: string; note?: string }) {
  if (head === null) return <span className={ROW_ITEM_CLASS} data-composer-branch={why} />;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn(ROW_ITEM_CLASS, "min-w-0 shrink")} tabIndex={0} data-composer-branch={head} />}>
        <GitBranchIcon aria-hidden />
        <span className="min-w-0 max-w-60 truncate">{head}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" align="start" className="max-w-80">
        {note}
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
  // The branch moves only by a call the agent made, so it is read again when a turn starts or ends or a call finishes,
  // not on every line of text: each read that lands is a commit of its own.
  const moved = useMemo(() => thread.view.turns.length + finishedCalls(thread.view.entries), [thread.view.turns.length, thread.view.entries]);
  const branch = useBranch(wire, folder, !onCheckout, linkWord, { running, moved });
  const head = onCheckout ? fact.branch : branch.kind === "repo" ? branch.head : null;
  // About to open a thread, the fact is asked for again now and as the window shows it, so the tile reads the same.
  const api = useStore(s => s.api);
  const refresh = useCallback(() => void api?.workspaceCheckout?.(workspaceId, true).catch(() => undefined), [api, workspaceId]);
  useRereads(opening && onCheckout, refresh);

  useEffect(() => {
    if (cwd !== null) follow(workspaceId, cwd);
  }, [cwd, follow, workspaceId]);
  useEffect(() => {
    shell(workspaceId, shellCwd);
  }, [shell, shellCwd, workspaceId]);

  return (
    <ComposerSurface.Tray data-composer-checkout data-opening={opening || undefined} data-composer-folder={folder ?? undefined}>
      <RowComputer name={computer} place={place} />
      {access}
      {stash}
      <RowBranch head={head !== null && head !== DETACHED_HEAD ? head : null} why={onCheckout || branch.kind === "repo" ? "detached" : branch.kind} />
    </ComposerSurface.Tray>
  );
}

/** The row under a project home's composer: no workspace exists yet, so it names where the send will run (the
 * project's one computer), the access and the branch the thread starts on, read off the project's folder; none
 * while the workspace a send asked for is still being made. */
export function HomeCheckoutRow({ path, projectId, where = null, access = null }: { path: string; projectId: string | null; where?: ReactNode; access?: ReactNode }) {
  const read = useProjectBranch(projectId);
  return (
    <ComposerSurface.Tray data-composer-checkout data-composer-home data-composer-folder={path}>
      {where}
      {access}
      <RowBranch head={read?.branch ?? null} note={read?.folder === false ? COPY_BRANCH_NOTE : BRANCH_NOTE} />
    </ComposerSurface.Tray>
  );
}
