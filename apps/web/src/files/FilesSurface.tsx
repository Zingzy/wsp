// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's Files surface: the copied tree rooted where the thread's
// agent works, with a location bar naming the folder, a way up, a pin to stop
// following the thread, and a new thread started in the shown folder. When
// the daemon browses more than one root (home and an imported project), a row
// above names them and switches between them. Picking a file opens it as its
// own surface beside this one.
import { ArrowUpIcon, MessageSquarePlusIcon, PinIcon, PinOffIcon } from "lucide-react";
import { useEffect } from "react";
import FileBrowserPanel from "../components/files/FileBrowserPanel.js";
import { Button } from "../components/ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { useWorkspace } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { requestNewThread } from "../shell/shellRequests.js";
import { parentPath } from "./entries.js";
import { useWorkspaceListing } from "./listing.js";
import { rootOf, usePinned, useRoot, useRoots, useRootStore } from "./root.js";
import { useDaemonWire } from "./wire.js";

export function FilesSurface({ workspaceId, theme }: { workspaceId: string; theme: "light" | "dark" }) {
  const workspace = useWorkspace(workspaceId);
  const wire = useDaemonWire(workspaceId);
  const roots = useRoots(workspaceId);
  const root = useRoot(workspaceId);
  const pinned = usePinned(workspaceId);
  const pin = useRootStore(s => s.pin);
  const unpin = useRootStore(s => s.unpin);
  const follow = useRootStore(s => s.follow);
  const { levels, ensure, refresh } = useWorkspaceListing(workspaceId);
  const openFile = useRightPanelStore(s => s.openFile);
  // The daemon refuses anything outside every root, so up stops at a root's edge.
  const above = root === null ? null : parentPath(root);
  const parent = above !== null && rootOf(roots, above) !== null ? above : null;
  const current = root === null ? null : rootOf(roots, root);

  useEffect(() => {
    if (root !== null) ensure(root);
  }, [ensure, root]);

  if (!wire || root === null) return <NotRunning />;
  const newThreadHere = () => {
    follow(workspaceId, root);
    requestNewThread({ workspaceId });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {roots.length > 1 ? (
        <div className="flex h-7 min-h-7 shrink-0 items-center gap-3 border-b border-border/60 px-2" role="group" aria-label="Browsable folders" data-files-roots>
          {roots.map(candidate => (
            <button
              key={candidate}
              type="button"
              className={cn(
                "min-w-0 truncate rounded-sm font-mono text-[11px] outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                candidate === current ? "text-foreground" : "text-muted-foreground",
              )}
              title={candidate}
              aria-pressed={candidate === current}
              onClick={() => pin(workspaceId, candidate)}
            >
              {candidate}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex h-7 min-h-7 shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5" data-files-location>
        <Tooltip>
          <TooltipTrigger
            render={<Button type="button" variant="ghost" size="icon-micro" aria-label="Up one folder" disabled={parent === null} onClick={() => parent !== null && pin(workspaceId, parent)} />}
          >
            <ArrowUpIcon />
          </TooltipTrigger>
          <TooltipPopup>Up one folder</TooltipPopup>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={root} data-files-root>
          {root}
        </span>
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
        onRefresh={dirs => dirs.forEach(refresh)}
        theme={theme}
      />
    </div>
  );
}

export function NotRunning() {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>The workspace is not running.</EmptyTitle>
        <EmptyDescription>Files and diffs are read over the machine's daemon; wake it to browse them.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
