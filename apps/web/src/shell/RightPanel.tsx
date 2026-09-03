// SPDX-License-Identifier: AGPL-3.0-only
// The right region: one surface at a time over the copied tab strip, keyed
// by the selected workspace. Surfaces whose panes still live in the center
// tabs stay greyed out here with a reason, so the picker never opens a tab
// that has nothing behind it. Terminal surfaces mount the Ghostty drawer in
// panel mode over the workspace's daemon link.
import { useEffect, useMemo, type ReactNode } from "react";
import { useWorkspacePorts } from "../browser/model.js";
import { previewTabSnapshots, useBrowserTabs, useWorkspaceBrowserTabs } from "../browser/tabs.js";
import { MachineSurface } from "../components/machine/MachineSurface.js";
import { RightPanelSheet } from "../components/RightPanelSheet.js";
import { RightPanelTabs } from "../components/RightPanelTabs.js";
import { BrowserSurface } from "../components/preview/BrowserSurface.js";
import type { PreviewPanelMode } from "../components/preview/PreviewPanelShell.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { useStatus, useWorkspace } from "../protocol/store.js";
import { useRightPanelStore, type WorkspaceRightPanelState } from "../rightPanelStore.js";
import { ScreenTab } from "../tabs/ScreenTab.js";
import { getTerminals } from "../terminal/link.js";
import { useTerminalLabels, WorkspaceTerminalPanel } from "../components/WorkspaceTerminalPanel.js";

const NO_PENDING: ReadonlySet<string> = new Set();

export function RightPanel({
  workspaceId,
  state,
  mode,
  layoutControls,
}: {
  workspaceId: string;
  state: WorkspaceRightPanelState;
  mode: PreviewPanelMode;
  layoutControls?: ReactNode;
}) {
  const workspace = useWorkspace(workspaceId);
  const status = useStatus(workspaceId);
  const open = useRightPanelStore(s => s.open);
  const openTerminal = useRightPanelStore(s => s.openTerminal);
  const activateSurface = useRightPanelStore(s => s.activateSurface);
  const closeSurface = useRightPanelStore(s => s.closeSurface);
  const close = useRightPanelStore(s => s.close);
  const terminalLabelsById = useTerminalLabels(workspaceId);
  const active = state.surfaces.find(surface => surface.id === state.activeSurfaceId) ?? null;
  const browserTabs = useWorkspaceBrowserTabs(workspaceId);
  const ports = useWorkspacePorts(workspaceId);
  const previewSessions = useMemo(() => previewTabSnapshots(browserTabs, ports), [browserTabs, ports]);
  const pruneBrowserTabs = useBrowserTabs(s => s.prune);
  const openBrowserTabIds = useMemo(
    () => state.surfaces.flatMap(surface => (surface.kind === "preview" && surface.resourceId !== null ? [surface.resourceId] : [])),
    [state.surfaces],
  );
  useEffect(() => {
    pruneBrowserTabs(workspaceId, openBrowserTabIds);
  }, [pruneBrowserTabs, workspaceId, openBrowserTabIds]);

  const tabs = (
    <RightPanelTabs
      mode={mode}
      {...(layoutControls !== undefined ? { layoutControls } : {})}
      surfaces={state.surfaces}
      activeSurfaceId={state.activeSurfaceId}
      pendingSurfaceIds={NO_PENDING}
      previewSessions={previewSessions}
      terminalLabelsById={terminalLabelsById}
      onActivate={surface => activateSurface(workspaceId, surface.id)}
      onCloseSurface={surface => closeSurface(workspaceId, surface.id)}
      onAddBrowser={() => open(workspaceId, "preview")}
      onAddTerminal={() => {
        void getTerminals(workspaceId)
          ?.open()
          .then(tab => openTerminal(workspaceId, tab.ptyId))
          .catch(() => {});
      }}
      onAddDiff={() => open(workspaceId, "diff")}
      onAddFiles={() => open(workspaceId, "files")}
      onAddMachine={() => open(workspaceId, "machine")}
      onAddScreen={() => open(workspaceId, "screen")}
      browserAvailable={workspace?.phase === "running"}
      terminalAvailable={workspace?.phase === "running"}
      diffAvailable={false}
      filesAvailable={false}
      machineAvailable={workspace !== null}
      screenAvailable={status?.screen !== undefined}
    >
      {active?.kind === "terminal" ? (
        <WorkspaceTerminalPanel workspaceId={workspaceId} surface={active} />
      ) : active?.kind === "preview" ? (
        <BrowserSurface key={active.id} workspaceId={workspaceId} surface={active} />
      ) : active?.kind === "machine" ? (
        <MachineSurface workspaceId={workspaceId} />
      ) : active?.kind === "screen" ? (
        <ScreenTab workspaceId={workspaceId} />
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Nothing to show here yet.</EmptyTitle>
            <EmptyDescription>This surface has no pane behind it in this build.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </RightPanelTabs>
  );

  if (mode === "sheet") {
    return (
      <RightPanelSheet open onClose={() => close(workspaceId)}>
        {tabs}
      </RightPanelSheet>
    );
  }
  return tabs;
}
