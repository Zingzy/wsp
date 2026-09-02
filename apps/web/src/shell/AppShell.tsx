// SPDX-License-Identifier: AGPL-3.0-only
// The three regions: a resizable sidebar on the left, the selected
// workspace's panes in the center, the surface panel on the right. State
// drives every switch here; there is no router.
import type { ReactNode } from "react";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls.js";
import { Rail } from "../components/Rail.js";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail, SidebarTrigger } from "../components/ui/sidebar.js";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { useSelectedId, useStore, useWorkspace } from "../protocol/store.js";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../rightPanelStore.js";
import { DisconnectedBanner } from "./DisconnectedBanner.js";
import { RightPanel } from "./RightPanel.js";

const SIDEBAR_WIDTH_STORAGE_KEY = "wsp:sidebar-width";
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;

export function AppShell({ children }: { children: ReactNode }) {
  const workspaceId = useSelectedId();
  const workspace = useWorkspace(workspaceId);
  const conn = useStore(s => s.conn);
  const panel = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, workspaceId));
  const toggleVisibility = useRightPanelStore(s => s.toggleVisibility);
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const rightPanelOpen = workspaceId !== null && panel.isOpen;

  const layoutControls = (
    <PanelLayoutControls
      showTerminalControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      rightPanelAvailable={workspaceId !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={null}
      rightPanelUnavailableLabel="Select a workspace to open the right panel"
      liveAgentCount={0}
      onToggleTerminal={() => {}}
      onToggleRightPanel={() => {
        if (workspaceId) toggleVisibility(workspaceId);
      }}
    />
  );

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        className="sidebar-glass border-r border-sidebar-border text-sidebar-foreground"
        resizable={{ minWidth: SIDEBAR_MIN_WIDTH, maxWidth: SIDEBAR_MAX_WIDTH, storageKey: SIDEBAR_WIDTH_STORAGE_KEY }}
      >
        <Rail />
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden">
        {conn === "closed" ? <DisconnectedBanner /> : null}
        <div className="flex min-h-0 flex-1 flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-shell-center>
            <WorkspacePageHeader className="border-b border-border">
              <SidebarTrigger aria-label="Toggle main sidebar" />
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {workspace?.name ?? "No workspace selected"}
              </span>
              {rightPanelOpen && !useSheet ? null : <div className="ml-auto mr-px">{layoutControls}</div>}
            </WorkspacePageHeader>
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </div>
          {rightPanelOpen ? (
            <RightPanel
              workspaceId={workspaceId}
              state={panel}
              mode={useSheet ? "sheet" : "inline"}
              {...(useSheet ? {} : { layoutControls })}
            />
          ) : null}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
