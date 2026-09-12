// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's Files surface: the copied tree rooted where the thread's
// agent works, with one breadcrumb row naming the folder, a pin to stop
// following the thread, and a new thread started in the shown folder. The
// first crumb is the root the folder sits in, which is also where the roots
// the daemon browses (home and an imported project) are picked between.
// Picking a file opens it as its own surface beside this one; a right-click
// on a row offers the file registry's actions. A root a daemon
// too old for it will not browse says what that daemon predates in place of
// its refusal, which names a path nobody asked about; the runtime is already
// replacing that daemon.
import { MessageSquarePlusIcon, PinIcon, PinOffIcon } from "lucide-react";
import { useEffect, useMemo } from "react";
import { copyText } from "../actions/clipboard.js";
import { openContextMenu } from "../actions/contextMenu.js";
import { fileActions, type FileVerbs } from "../actions/fileActions.js";
import { resolveActions } from "../actions/registry.js";
import { DaemonDown } from "../components/DaemonDown.js";
import FileBrowserPanel from "../components/files/FileBrowserPanel.js";
import { Button } from "../components/ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useDiffRevealStore } from "../diffs/reveal.js";
import { daemonBehindLine } from "../machine/daemon.js";
import { useAbsentComputer, useStore, useWorkspace } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { focusPaneOnShow, FolderBreadcrumbs, useUpAFolder } from "./FolderBreadcrumbs.js";
import { useWorkspaceListing } from "./listing.js";
import { rootOf, usePinned, useRoot, useRootStore } from "./root.js";
import { useDaemonRoot, useDaemonVersion, useDaemonWire } from "./wire.js";

export function FilesSurface({ workspaceId, theme }: { workspaceId: string; theme: "light" | "dark" }) {
  const workspace = useWorkspace(workspaceId);
  const absent = useAbsentComputer(workspaceId);
  const wire = useDaemonWire(workspaceId);
  const version = useDaemonVersion(workspaceId);
  const home = useDaemonRoot(workspaceId);
  const root = useRoot(workspaceId);
  const pinned = usePinned(workspaceId);
  const pin = useRootStore(s => s.pin);
  const unpin = useRootStore(s => s.unpin);
  const follow = useRootStore(s => s.follow);
  const newThread = useStore(s => s.newThread);
  const { levels, ensure, refresh } = useWorkspaceListing(workspaceId);
  const openFile = useRightPanelStore(s => s.openFile);
  const openSurface = useRightPanelStore(s => s.open);
  const requestReveal = useDiffRevealStore(s => s.request);
  const onKeyDown = useUpAFolder(workspaceId);
  const verbs = useMemo<FileVerbs>(
    () => ({
      open: path => openFile(workspaceId, path),
      revealInDiff: path => {
        requestReveal(workspaceId, path);
        openSurface(workspaceId, "diff");
      },
      copyText,
    }),
    [openFile, openSurface, requestReveal, workspaceId],
  );
  // A daemon that predates the roots file browses its home and nothing else, so a folder outside it comes back
  // refused, naming a path nobody asked about; that one refusal reads as what the daemon predates. Every other
  // failure, on any daemon, is its own and says so.
  const behind = root !== null && home !== null && rootOf([home], root) === null ? daemonBehindLine(version, "files") : null;

  useEffect(() => {
    if (root !== null) ensure(root);
  }, [ensure, root]);

  // A listing already drawn is not a listing that is still true: the daemon that reads it can go while the tree
  // sits there, and a stale tree with no sentence is the pane saying the daemon is fine.
  if (!wire || root === null || absent?.start !== undefined) return <NotRunning workspaceId={workspaceId} />;
  const newThreadHere = () => {
    follow(workspaceId, root);
    newThread(workspaceId);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={focusPaneOnShow} tabIndex={0} onKeyDown={onKeyDown} data-files-pane>
      <div className="flex h-7 min-h-7 shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5" data-files-location>
        <FolderBreadcrumbs workspaceId={workspaceId} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-micro"
                aria-label={pinned ? "Follow the agent's folder" : "Stay in this folder"}
                aria-pressed={pinned}
                onClick={() => (pinned ? unpin(workspaceId) : pin(workspaceId, root))}
              />
            }
          >
            {pinned ? <PinOffIcon /> : <PinIcon />}
          </TooltipTrigger>
          <TooltipPopup>{pinned ? "Follow the agent's folder again" : "Stay here when the agent moves"}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-micro" aria-label="New thread in this folder" onClick={newThreadHere} />}>
            <MessageSquarePlusIcon />
          </TooltipTrigger>
          <TooltipPopup>New thread in this folder</TooltipPopup>
        </Tooltip>
      </div>
      <FileBrowserPanel
        projectName={workspace?.name ?? "workspace"}
        root={root}
        levels={levels}
        onExpandDirectory={ensure}
        onOpenFile={path => openFile(workspaceId, path)}
        onContextMenuEntry={(entry, event) => void openContextMenu(event, resolveActions(fileActions, entry, verbs))}
        onRefresh={dirs => dirs.forEach(refresh)}
        behind={behind}
        theme={theme}
      />
    </div>
  );
}

/** What the files, the diff and a file preview say instead of a listing. A daemon this host started and is not
 * running is said in the one reading's sentence, with the button that starts another, so the pane a person clicked
 * holds both the reason and the road; every other reason keeps the shipped line. */
export function NotRunning({ workspaceId }: { workspaceId: string }) {
  const absent = useAbsentComputer(workspaceId);
  if (absent !== null && absent.start !== undefined) {
    return (
      <Empty className="flex-1">
        <DaemonDown absent={absent} workspaceId={workspaceId} />
      </Empty>
    );
  }
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>The workspace is not running.</EmptyTitle>
        <EmptyDescription>{absent?.sentence ?? "Files and diffs are read over the workspace's daemon; wake it to browse them."}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
