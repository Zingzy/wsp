// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's terminal surface: the same drawer in panel mode, with the
// surface's terminal ids and split direction as its one group and the right
// panel store as the arrangement. The panel owns the ptys it opened; they
// still come from the workspace's link, which also hands out their io.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore.js";
import { openPanelTerminal, splitPanelTerminal, type SplitDirection } from "../shell/shellCommands.js";
import { getTerminals, onTerminals, type WorkspaceTerminals } from "../terminal/link.js";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty.js";
import { terminalLabels } from "./WorkspaceTerminalDrawer.js";

const NO_TABS: readonly never[] = [];

/**
 * Tab titles for the panel's terminal surfaces, from the link's pty list. The
 * same list prunes surfaces whose pty the link no longer has (closed elsewhere,
 * or persisted from a session whose ptys are gone), so no surface outlives its pty.
 */
export function useTerminalSurfaces(workspaceId: string): ReadonlyMap<string, string> {
  const terms = useSyncExternalStore(onTerminals, () => getTerminals(workspaceId));
  const subscribe = useCallback((fn: () => void) => (terms ? terms.onTabs(fn) : () => {}), [terms]);
  const tabs = useSyncExternalStore(subscribe, () => (terms ? terms.tabs() : NO_TABS));
  const reconcile = useRightPanelStore(s => s.reconcileTerminalSurfaces);
  useEffect(() => {
    if (terms) reconcile(workspaceId, tabs.map(t => t.ptyId));
  }, [terms, reconcile, workspaceId, tabs]);
  return useMemo(() => terminalLabels(tabs), [tabs]);
}

export function WorkspaceTerminalPanel({
  workspaceId,
  surface,
}: {
  workspaceId: string;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
}) {
  const terms = useSyncExternalStore(onTerminals, () => getTerminals(workspaceId));
  if (!terms) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>No terminal link for this workspace.</EmptyTitle>
          <EmptyDescription>Terminals connect while the workspace is running.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <LinkedPanel terms={terms} workspaceId={workspaceId} surface={surface} />;
}

function LinkedPanel({
  terms,
  workspaceId,
  surface,
}: {
  terms: WorkspaceTerminals;
  workspaceId: string;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
}) {
  const tabs = useSyncExternalStore(fn => terms.onTabs(fn), () => terms.tabs());
  const labels = useMemo(() => terminalLabels(tabs), [tabs]);
  const terminalIo = useCallback((id: string) => terms.io(id), [terms]);
  const activateTerminal = useRightPanelStore(s => s.activateTerminal);
  const closeTerminal = useRightPanelStore(s => s.closeTerminal);
  const groups = useMemo(
    () => [
      {
        id: surface.id,
        terminalIds: surface.terminalIds,
        ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
      },
    ],
    [surface.id, surface.terminalIds, surface.splitDirection],
  );
  const split = (direction: SplitDirection) => void splitPanelTerminal(workspaceId, surface.id, direction);

  return (
    <ThreadTerminalDrawer
      mode="panel"
      workspaceId={workspaceId}
      height={0}
      terminalIds={surface.terminalIds}
      activeTerminalId={surface.activeTerminalId}
      terminalGroups={groups}
      activeTerminalGroupId={surface.id}
      focusRequestId={0}
      onSplitTerminal={() => split("horizontal")}
      onSplitTerminalVertical={() => split("vertical")}
      onNewTerminal={() => void openPanelTerminal(workspaceId)}
      onActiveTerminalChange={id => activateTerminal(workspaceId, surface.id, id)}
      onCloseTerminal={id => {
        closeTerminal(workspaceId, surface.id, id);
        void terms.close(id);
      }}
      onHeightChange={() => {}}
      terminalLabelsById={labels}
      terminalIo={terminalIo}
    />
  );
}
