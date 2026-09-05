// SPDX-License-Identifier: AGPL-3.0-only
// The three regions: a resizable sidebar on the left, the selected
// workspace's panes in the center, the surface panel on the right. State
// drives every switch here; there is no router.
import { MessageSquarePlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CommandPalette } from "../components/palette/CommandPalette.js";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls.js";
import { Button } from "../components/ui/button.js";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail, SidebarTrigger } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { shortcutLabelForCommand } from "../keybindings.js";
import { useCreation, useSelectedId, useStore, useWorkspace } from "../protocol/store.js";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../rightPanelStore.js";
import { WorkspaceSidebar } from "../sidebar/WorkspaceSidebar.js";
import { selectTerminalUiState, useTerminalDrawerStore } from "../terminal/drawerStore.js";
import { DisconnectedBanner } from "./DisconnectedBanner.js";
import { KeybindingDispatcher } from "./KeybindingDispatcher.js";
import { RightPanel } from "./RightPanel.js";
import { requestNewThread } from "./shellRequests.js";
import { SignInBanner } from "./SignInBanner.js";

const SIDEBAR_WIDTH_STORAGE_KEY = "wsp:sidebar-width";
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const RIGHT_PANEL_SHORTCUT_LABEL = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "rightPanel.toggle");
const TERMINAL_SHORTCUT_LABEL = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "terminal.toggle");
const NEW_THREAD_SHORTCUT_LABEL = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "chat.new");

export function AppShell({ children }: { children: ReactNode }) {
  const selectedId = useSelectedId();
  const creation = useCreation(selectedId);
  // A creation is selected by its key; no pane is a workspace's until it exists.
  const workspaceId = creation ? null : selectedId;
  const workspace = useWorkspace(workspaceId);
  const conn = useStore(s => s.conn);
  const panel = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, workspaceId));
  const toggleVisibility = useRightPanelStore(s => s.toggleVisibility);
  const terminalOpen = useTerminalDrawerStore(s => selectTerminalUiState(s.byWorkspaceId, workspaceId).terminalOpen);
  const toggleTerminal = useTerminalDrawerStore(s => s.toggle);
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const rightPanelOpen = workspaceId !== null && panel.isOpen;

  const layoutControls = (
    <PanelLayoutControls
      terminalAvailable={workspaceId !== null}
      terminalOpen={terminalOpen}
      terminalShortcutLabel={TERMINAL_SHORTCUT_LABEL}
      rightPanelAvailable={workspaceId !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={RIGHT_PANEL_SHORTCUT_LABEL}
      rightPanelUnavailableLabel="Select a workspace to open the right panel"
      liveAgentCount={0}
      onToggleTerminal={() => {
        if (workspaceId) toggleTerminal(workspaceId);
      }}
      onToggleRightPanel={() => {
        if (workspaceId) toggleVisibility(workspaceId);
      }}
    />
  );

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
      <KeybindingDispatcher />
      <CommandPalette />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        className="sidebar-glass border-r border-sidebar-border text-sidebar-foreground"
        resizable={{ minWidth: SIDEBAR_MIN_WIDTH, maxWidth: SIDEBAR_MAX_WIDTH, storageKey: SIDEBAR_WIDTH_STORAGE_KEY }}
      >
        <WorkspaceSidebar />
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden">
        {conn === "closed" || conn === "reconnecting" ? <DisconnectedBanner reconnecting={conn === "reconnecting"} /> : null}
        <SignInBanner />
        <div className="flex min-h-0 flex-1 flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-shell-center>
            <WorkspacePageHeader className="border-b border-border">
              <SidebarTrigger aria-label="Toggle main sidebar" />
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {workspace?.name ?? creation?.name ?? "No workspace selected"}
              </span>
              {workspace ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex shrink-0" />}>
                    <Button
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label="New thread"
                      className="[-webkit-app-region:no-drag]"
                      onClick={() => requestNewThread({ workspaceId: workspace.id })}
                    >
                      <MessageSquarePlusIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">{`New thread${NEW_THREAD_SHORTCUT_LABEL ? ` (${NEW_THREAD_SHORTCUT_LABEL})` : ""}`}</TooltipPopup>
                </Tooltip>
              ) : null}
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
