// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's Files surface: the copied tree over the workspace
// listing. Picking a file opens it as its own surface beside this one.
import FileBrowserPanel from "../components/files/FileBrowserPanel.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { useWorkspace } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { useWorkspaceListing } from "./listing.js";
import { useDaemonWire } from "./wire.js";

export function FilesSurface({ workspaceId, theme }: { workspaceId: string; theme: "light" | "dark" }) {
  const workspace = useWorkspace(workspaceId);
  const wire = useDaemonWire(workspaceId);
  const listing = useWorkspaceListing(workspaceId);
  const openFile = useRightPanelStore(s => s.openFile);
  if (!wire) return <NotRunning />;
  return (
    <FileBrowserPanel
      projectName={workspace?.name ?? "workspace"}
      entries={listing.entries}
      truncated={listing.truncated}
      isPending={listing.isPending}
      error={listing.error}
      selectedPath={null}
      selectedPathRevealId={0}
      onOpenFile={path => openFile(workspaceId, path)}
      onRefresh={listing.refresh}
      theme={theme}
    />
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
