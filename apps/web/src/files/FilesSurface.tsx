// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's Files surface: the copied tree rooted where the thread's
// agent works, with a location bar naming the folder, a way up, a pin to stop
// following the thread, and a new thread started in the shown folder. Picking
// a file opens it as its own surface beside this one.
import { ArrowUpIcon, MessageSquarePlusIcon, PinIcon, PinOffIcon } from "lucide-react";
import { useEffect } from "react";
import FileBrowserPanel from "../components/files/FileBrowserPanel.js";
import { Button } from "../components/ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useWorkspace } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { requestNewThread } from "../shell/shellRequests.js";
import { displayPath, parentPath } from "./entries.js";
import { useWorkspaceListing } from "./listing.js";
import { usePinned, useRoot, useRootStore } from "./root.js";
import { useDaemonWire } from "./wire.js";

export function FilesSurface({ workspaceId, theme }: { workspaceId: string; theme: "light" | "dark" }) {
  const workspace = useWorkspace(workspaceId);
  const wire = useDaemonWire(workspaceId);
  const root = useRoot(workspaceId);
  const pinned = usePinned(workspaceId);
  const pin = useRootStore(s => s.pin);
  const unpin = useRootStore(s => s.unpin);
  const follow = useRootStore(s => s.follow);
  const { levels, ensure, refresh } = useWorkspaceListing(workspaceId);
  const openFile = useRightPanelStore(s => s.openFile);
  const parent = parentPath(root);

  useEffect(() => ensure(root), [ensure, root]);

  if (!wire) return <NotRunning />;
  const newThreadHere = () => {
    follow(workspaceId, root);
    requestNewThread({ workspaceId });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 min-h-7 shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5" data-files-location>
        <Tooltip>
          <TooltipTrigger
            render={<Button type="button" variant="ghost" size="icon-micro" aria-label="Up one folder" disabled={parent === null} onClick={() => parent !== null && pin(workspaceId, parent)} />}
          >
            <ArrowUpIcon />
          </TooltipTrigger>
          <TooltipPopup>Up one folder</TooltipPopup>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={displayPath(root)} data-files-root>
          {displayPath(root)}
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
