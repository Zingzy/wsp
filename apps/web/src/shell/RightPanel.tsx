// SPDX-License-Identifier: AGPL-3.0-only
// The right region: one surface at a time over the copied tab strip, keyed
// by the selected workspace. A surface the workspace cannot serve yet (not
// running, no display) stays greyed out in the picker with a reason. Terminal
// surfaces mount the Ghostty drawer in panel mode over the workspace's daemon
// link. Files, file and diff share one diff worker pool so switching between
// them keeps the highlighter warm.
import { useEffect, useMemo, type ReactNode } from "react";
import { useWorkspacePorts } from "../browser/model.js";
import { previewTabSnapshots, useBrowserTabs, useWorkspaceBrowserTabs } from "../browser/tabs.js";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider.js";
import { MachineSurface } from "../components/machine/MachineSurface.js";
import { ProcessesSurface } from "../components/procs/ProcessesSurface.js";
import { RightPanelSheet } from "../components/RightPanelSheet.js";
import { RightPanelTabs } from "../components/RightPanelTabs.js";
import { BrowserSurface } from "../components/preview/BrowserSurface.js";
import type { PreviewPanelMode } from "../components/preview/PreviewPanelShell.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { DiffSurface } from "../diffs/DiffSurface.js";
import { FilePreviewSurface } from "../files/FilePreviewSurface.js";
import { FilesSurface } from "../files/FilesSurface.js";
import { useStatus, useWorkspace } from "../protocol/store.js";
import { useRightPanelStore, type WorkspaceRightPanelState } from "../rightPanelStore.js";
import { ScreenSurface } from "../screen/ScreenSurface.js";
import { openPanelTerminal } from "./shellCommands.js";
import { useTerminalSurfaces, WorkspaceTerminalPanel } from "../components/WorkspaceTerminalPanel.js";

const NO_PENDING: ReadonlySet<string> = new Set();
/** index.html pins the dark theme; the code views take it as a prop. */
const THEME = "dark";

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
      onAddFiles={() => open(workspaceId, "files")}
      onAddMachine={() => open(workspaceId, "machine")}
      onAddProcesses={() => open(workspaceId, "processes")}
      onAddScreen={() => open(workspaceId, "screen")}
      browserAvailable={workspace?.phase === "running"}
      terminalAvailable={workspace?.phase === "running"}
      diffAvailable={workspace?.phase === "running"}
      filesAvailable={workspace?.phase === "running"}
      machineAvailable={workspace !== null}
      processesAvailable={workspace?.phase === "running"}
      screenAvailable={status?.screen !== undefined}
    >
      {active?.kind === "terminal" ? (
        <WorkspaceTerminalPanel workspaceId={workspaceId} surface={active} />
      ) : active?.kind === "preview" ? (
        <BrowserSurface key={active.id} workspaceId={workspaceId} surface={active} />
      ) : active?.kind === "machine" ? (
        <MachineSurface workspaceId={workspaceId} />
      ) : active?.kind === "processes" ? (
        <ProcessesSurface workspaceId={workspaceId} />
      ) : active?.kind === "screen" ? (
        <ScreenSurface workspaceId={workspaceId} />
      ) : active?.kind === "files" || active?.kind === "file" || active?.kind === "diff" ? (
        <DiffWorkerPoolProvider theme={THEME}>
          {active.kind === "files" ? (
            <FilesSurface workspaceId={workspaceId} theme={THEME} />
          ) : active.kind === "file" ? (
            <FilePreviewSurface key={active.id} workspaceId={workspaceId} surface={active} theme={THEME} />
          ) : (
            <DiffSurface workspaceId={workspaceId} theme={THEME} />
          )}
        </DiffWorkerPoolProvider>
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Nothing open here.</EmptyTitle>
            <EmptyDescription>Pick a surface from the tab strip above.</EmptyDescription>
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
