// SPDX-License-Identifier: AGPL-3.0-only
// The right region: one of three panes at a time over the copied tab strip,
// keyed by the selected workspace. A pane the workspace cannot serve yet (not
// running) stays greyed out in the picker with a reason. Terminal
// surfaces mount the Ghostty drawer in panel mode over the workspace's daemon
// link. The diff runs in its own worker pool, themed for the side the page is
// drawing.
import { useEffect, useMemo, type ReactNode } from "react";
import { useWorkspacePorts } from "../browser/model.js";
import { previewTabSnapshots, useBrowserTabs, useWorkspaceBrowserTabs } from "../browser/tabs.js";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider.js";
import { RightPanelSheet } from "../components/RightPanelSheet.js";
import { RightPanelTabs } from "../components/RightPanelTabs.js";
import { BrowserSurface } from "../components/preview/BrowserSurface.js";
import type { PreviewPanelMode } from "../components/preview/PreviewPanelShell.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { DiffSurface } from "../diffs/DiffSurface.js";
import { useAbsentComputer, useWorkspace } from "../protocol/store.js";
import { useAppDark } from "../settings/theme.js";
import { useRightPanelStore, type WorkspaceRightPanelState } from "../rightPanelStore.js";
import { openPanelTerminal } from "./shellCommands.js";
import { useTerminalSurfaces, WorkspaceTerminalPanel } from "../components/WorkspaceTerminalPanel.js";

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
  const absent = useAbsentComputer(workspaceId);
  // The code views take a side as a prop and colour their tokens from it. It has to be the side the page is
  // drawing: a diff themed for the other side draws its lines in an ink the row tints were never measured against.
  const theme = useAppDark() ? "dark" : "light";
  const open = useRightPanelStore(s => s.open);
  const activateSurface = useRightPanelStore(s => s.activateSurface);
  const closeSurface = useRightPanelStore(s => s.closeSurface);
  const close = useRightPanelStore(s => s.close);
  const terminalLabelsById = useTerminalSurfaces(workspaceId);
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
      onAddTerminal={() => void openPanelTerminal(workspaceId)}
      onAddDiff={() => open(workspaceId, "diff")}
      browserAvailable={workspace?.phase === "running"}
      terminalAvailable={workspace?.phase === "running" && absent === null}
      diffAvailable={workspace?.phase === "running"}
      // A panel terminal cannot open at all without a pty, so its tab keeps the computer's own sentence as the
      // reason it is held, and the drawer under the chat is where that sentence carries the button.
      {...(absent === null ? {} : { unavailableReasons: { terminal: absent.sentence } })}
    >
      {active?.kind === "terminal" ? (
        <WorkspaceTerminalPanel workspaceId={workspaceId} surface={active} />
      ) : active?.kind === "preview" ? (
        <BrowserSurface key={active.id} workspaceId={workspaceId} surface={active} />
      ) : active?.kind === "diff" ? (
        <DiffWorkerPoolProvider theme={theme}>
          <DiffSurface workspaceId={workspaceId} theme={theme} />
        </DiffWorkerPoolProvider>
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Nothing open here.</EmptyTitle>
            <EmptyDescription>Pick a panel from the tab strip above.</EmptyDescription>
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
