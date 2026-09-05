// SPDX-License-Identifier: AGPL-3.0-only
// The strip under the composer naming where the thread works: the folder and
// its git branch. Before the first message the folder is a picker over the
// daemon's listings, one level at a time; the pick is what sessions.start
// runs the harness in and where the panes root. Once a turn exists the row is
// a label for the harness folder, which a cd in the agent's shell cannot move
// (the CLI keys a session to it), so the label explains itself on hover and
// offers a new thread with the picker open; the shell's own folder, as the
// agent's tool calls move it, is what the panes follow. The branch is read,
// not switched: the daemon has no checkout op.
import { ArrowLeftIcon, ChevronDownIcon, CheckIcon, FolderGitIcon, FolderIcon, GitBranchIcon, LoaderCircleIcon, MessageSquarePlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { baseName, parentPath } from "../../files/entries";
import { useWorkspaceListing } from "../../files/listing";
import { useRootStore, useThreadFolder } from "../../files/root";
import { useDaemonRoot, useDaemonWire } from "../../files/wire";
import { cn } from "../../lib/utils";
import { DaemonOpError, gitStatus } from "../../terminal/daemon-fs";
import type { TerminalWire } from "../../terminal/link";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerSurface } from "./ComposerSurface";
import type { ChatThreadHandle } from "./useChatThread";

/** What git said about the folder; "none" is a folder outside any repository, "unknown" a failed or unsent ask. */
type Branch = { readonly kind: "unknown" } | { readonly kind: "none" } | { readonly kind: "repo"; readonly head: string };

function useBranch(wire: TerminalWire | null, folder: string | null, running: boolean): Branch {
  const [state, setState] = useState<{ folder: string | null; branch: Branch }>({ folder, branch: { kind: "unknown" } });
  useEffect(() => {
    if (!wire || folder === null || running) return;
    let gone = false;
    gitStatus(wire, folder).then(
      status => {
        if (!gone) setState({ folder, branch: { kind: "repo", head: status.branch.head } });
      },
      (e: unknown) => {
        if (!gone) setState({ folder, branch: e instanceof DaemonOpError && e.code === "not-a-git-repo" ? { kind: "none" } : { kind: "unknown" } });
      },
    );
    return () => {
      gone = true;
    };
  }, [wire, folder, running]);
  return state.folder === folder ? state.branch : { kind: "unknown" };
}

/** Sized like the picker button (size xs), so the row does not move when the label replaces it. */
const labelClass = "inline-flex h-7 min-w-0 items-center gap-1 px-2 text-sm text-muted-foreground/70 sm:h-6 sm:text-xs";

const LOCKED_FOLDER_NOTE = "The folder this thread's harness runs in. A cd inside the agent's shell does not move it; start a new thread to work from another folder.";

function FolderMenu({
  workspaceId,
  daemonRoot,
  folder,
  defaultOpen,
  onPick,
}: {
  workspaceId: string;
  daemonRoot: string;
  folder: string;
  defaultOpen: boolean;
  onPick: (dir: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [dir, setDir] = useState(folder);
  const { levels, ensure } = useWorkspaceListing(workspaceId);
  const level = levels.get(dir);
  // The daemon refuses anything above its root, so the menu stops there.
  const parent = dir === daemonRoot ? null : parentPath(dir);
  const folders = level?.entries?.filter(entry => entry.kind === "directory") ?? null;

  useEffect(() => {
    if (open) ensure(dir);
  }, [open, dir, ensure]);

  return (
    <Menu
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) setDir(folder);
      }}
    >
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className="min-w-0 justify-start font-medium text-muted-foreground/70 hover:text-foreground/80"
        aria-label={`Working folder: ${folder}`}
        data-composer-folder={folder}
      >
        <FolderIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate font-mono">{folder}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-72">
        <MenuItem onClick={() => onPick(dir)} data-composer-folder-pick={dir}>
          <CheckIcon />
          <span className="min-w-0 flex-1 truncate">
            Work in <span className="font-mono">{dir}</span>
          </span>
        </MenuItem>
        {parent !== null ? (
          <MenuItem closeOnClick={false} onClick={() => setDir(parent)}>
            <ArrowLeftIcon />
            <span className="min-w-0 flex-1 truncate">Up to <span className="font-mono">{parent}</span></span>
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuGroup key={dir}>
          {folders === null && level?.error ? (
            <MenuItem disabled>{level.error}</MenuItem>
          ) : folders === null ? (
            <MenuItem disabled>
              <LoaderCircleIcon className="animate-spin" />
              Loading folder…
            </MenuItem>
          ) : folders.length === 0 ? (
            <MenuItem disabled>No folders here.</MenuItem>
          ) : (
            folders.map(entry => (
              <MenuItem key={entry.path} closeOnClick={false} onClick={() => setDir(entry.path)} data-composer-folder-entry={entry.path}>
                <FolderIcon />
                <span className="min-w-0 flex-1 truncate font-mono">{baseName(entry.path)}</span>
              </MenuItem>
            ))
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function ComposerCheckoutRow({ workspaceId, thread }: { workspaceId: string; thread: ChatThreadHandle }) {
  const wire = useDaemonWire(workspaceId);
  const daemonRoot = useDaemonRoot(workspaceId);
  const follow = useRootStore(s => s.follow);
  const shell = useRootStore(s => s.shell);
  const folder = useThreadFolder(workspaceId);
  const { cwd, shellCwd, entries, running } = thread.view;
  const pickable = thread.hydrated && (thread.fresh || (entries.length === 0 && !running));
  const canPick = wire !== null && daemonRoot !== null && folder !== null;
  const [pickNext, setPickNext] = useState(false);
  const branch = useBranch(wire, folder, running);

  useEffect(() => {
    if (cwd !== null) follow(workspaceId, cwd);
  }, [cwd, follow, workspaceId]);
  useEffect(() => {
    shell(workspaceId, shellCwd);
  }, [shell, shellCwd, workspaceId]);
  useEffect(() => {
    if (!pickable) setPickNext(false);
  }, [pickable]);

  const newThreadHere = () => {
    setPickNext(true);
    thread.startNewThread();
  };

  return (
    <ComposerSurface.ContextStrip data-composer-checkout data-pickable={pickable || undefined}>
      <div className="flex min-w-10 flex-1 items-center gap-1">
        {pickable && canPick ? (
          <FolderMenu workspaceId={workspaceId} daemonRoot={daemonRoot} folder={folder} defaultOpen={pickNext} onPick={dir => follow(workspaceId, dir)} />
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger render={<span className={labelClass} tabIndex={0} data-composer-folder={folder ?? undefined} />}>
                {branch.kind === "repo" ? <FolderGitIcon className="size-3 shrink-0" /> : <FolderIcon className="size-3 shrink-0" />}
                <span className="min-w-0 truncate font-mono">{folder ?? ""}</span>
              </TooltipTrigger>
              <TooltipPopup side="top" align="start" className="max-w-72">
                {LOCKED_FOLDER_NOTE}
              </TooltipPopup>
            </Tooltip>
            {canPick ? (
              <Tooltip>
                <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-micro" aria-label="New thread here" onClick={newThreadHere} />}>
                  <MessageSquarePlusIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">New thread here</TooltipPopup>
              </Tooltip>
            ) : null}
          </>
        )}
      </div>
      <span className={cn(labelClass, "shrink-0 font-mono")} data-composer-branch={branch.kind === "repo" ? branch.head : branch.kind}>
        <GitBranchIcon className={cn("size-3 shrink-0", branch.kind !== "repo" && "opacity-50")} />
        <span className="truncate">{branch.kind === "repo" ? branch.head : branch.kind === "none" ? "no repository" : ""}</span>
      </span>
    </ComposerSurface.ContextStrip>
  );
}
