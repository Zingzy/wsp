// SPDX-License-Identifier: AGPL-3.0-only
// The strip under the composer naming where the thread works: the folder and
// its git branch. Before the first message the folder is a picker over the
// daemon's listings, one level at a time; the pick is what sessions.start
// runs the harness in and where the panes root. Once a turn exists the row is
// a label, and the harness's own cwd on each turn keeps it current. The
// branch is read, not switched: the daemon has no checkout op.
import { ArrowLeftIcon, ChevronDownIcon, CheckIcon, FolderGitIcon, FolderIcon, GitBranchIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { displayPath, parentPath, ROOT } from "../../files/entries";
import { useWorkspaceListing } from "../../files/listing";
import { useFollowed, useRootStore } from "../../files/root";
import { useDaemonWire } from "../../files/wire";
import { cn } from "../../lib/utils";
import { DaemonOpError, gitStatus } from "../../terminal/daemon-fs";
import type { TerminalWire } from "../../terminal/link";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ComposerSurface } from "./ComposerSurface";
import type { ChatThreadHandle } from "./useChatThread";

/** What git said about the folder; "none" is a folder outside any repository, "unknown" a failed or unsent ask. */
type Branch = { readonly kind: "unknown" } | { readonly kind: "none" } | { readonly kind: "repo"; readonly head: string };

function useBranch(wire: TerminalWire | null, folder: string, running: boolean): Branch {
  const [state, setState] = useState<{ folder: string; branch: Branch }>({ folder, branch: { kind: "unknown" } });
  useEffect(() => {
    if (!wire || running) return;
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

const labelClass = "inline-flex h-7 min-w-0 items-center gap-1 px-2 text-xs text-muted-foreground/70 sm:h-6";

function FolderMenu({ workspaceId, folder, onPick }: { workspaceId: string; folder: string; onPick: (dir: string) => void }) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState(folder);
  const { levels, ensure } = useWorkspaceListing(workspaceId);
  const level = levels.get(dir);
  const parent = parentPath(dir);
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
        aria-label={`Working folder: ${displayPath(folder)}`}
        data-composer-folder={folder}
      >
        <FolderIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate font-mono">{displayPath(folder)}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-72">
        <MenuItem onClick={() => onPick(dir)} data-composer-folder-pick={dir}>
          <CheckIcon />
          <span className="min-w-0 flex-1 truncate">
            Work in <span className="font-mono">{displayPath(dir)}</span>
          </span>
        </MenuItem>
        {parent !== null ? (
          <MenuItem closeOnClick={false} onClick={() => setDir(parent)}>
            <ArrowLeftIcon />
            <span className="min-w-0 flex-1 truncate">Up to <span className="font-mono">{displayPath(parent)}</span></span>
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
              <MenuItem key={entry.path} closeOnClick={false} onClick={() => setDir(entry.path)}>
                <FolderIcon />
                <span className="min-w-0 flex-1 truncate font-mono">{entry.path.slice(entry.path.lastIndexOf("/") + 1)}</span>
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
  const follow = useRootStore(s => s.follow);
  const followed = useFollowed(workspaceId);
  const folder = followed ?? ROOT;
  const { cwd, entries, running } = thread.view;
  const pickable = thread.hydrated && (thread.fresh || (entries.length === 0 && !running));
  const branch = useBranch(wire, folder, running);

  useEffect(() => {
    if (cwd !== null) follow(workspaceId, cwd);
  }, [cwd, follow, workspaceId]);

  return (
    <ComposerSurface.ContextStrip data-composer-checkout data-pickable={pickable || undefined}>
      <div className="flex min-w-10 flex-1 items-center gap-1">
        {pickable && wire ? (
          <FolderMenu workspaceId={workspaceId} folder={folder} onPick={dir => follow(workspaceId, dir)} />
        ) : (
          <span className={labelClass} data-composer-folder={folder}>
            {branch.kind === "repo" ? <FolderGitIcon className="size-3 shrink-0" /> : <FolderIcon className="size-3 shrink-0" />}
            <span className="min-w-0 truncate font-mono">{displayPath(folder)}</span>
          </span>
        )}
      </div>
      <span className={cn(labelClass, "shrink-0 font-mono")} data-composer-branch={branch.kind === "repo" ? branch.head : branch.kind}>
        <GitBranchIcon className={cn("size-3 shrink-0", branch.kind !== "repo" && "opacity-50")} />
        <span className="truncate">{branch.kind === "repo" ? branch.head : branch.kind === "none" ? "no repository" : ""}</span>
      </span>
    </ComposerSurface.ContextStrip>
  );
}
