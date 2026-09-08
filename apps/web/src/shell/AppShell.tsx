// SPDX-License-Identifier: AGPL-3.0-only
// The three regions: a resizable sidebar on the left, the selected
// workspace's panes in the center, the surface panel on the right. State
// drives every switch here; there is no router.
import type { ReactNode } from "react";
import { ContextMenuHost } from "../actions/ContextMenuHost.js";
import { CommandPalette } from "../components/palette/CommandPalette.js";
import { WorkspaceSwitcher } from "../components/switcher/WorkspaceSwitcher.js";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls.js";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "../components/ui/sidebar.js";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader.js";
import { tintAttr } from "../components/workspaceLook.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { shortcutLabelForCommand } from "../keybindings.js";
import { isDesktopMac } from "../lib/desktopShell.js";
import { cn } from "../lib/utils.js";
import { useSelectedWorkspaceId, useStore } from "../protocol/store.js";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../rightPanelStore.js";
import { useSpaceTint } from "../sidebar/sidebarMode.js";
import { WorkspaceSidebar } from "../sidebar/WorkspaceSidebar.js";
import { selectTerminalUiState, useTerminalDrawerStore } from "../terminal/drawerStore.js";
import { DisconnectedBanner } from "./DisconnectedBanner.js";
import { KeybindingDispatcher } from "./KeybindingDispatcher.js";
import { RightPanel } from "./RightPanel.js";
import { SignInBanner } from "./SignInBanner.js";
import { ThreadBreadcrumb } from "./ThreadBreadcrumb.js";

const SIDEBAR_WIDTH_STORAGE_KEY = "wsp:sidebar-width";
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const RIGHT_PANEL_SHORTCUT_LABEL = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "rightPanel.toggle");
const TERMINAL_SHORTCUT_LABEL = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "terminal.toggle");

export function AppShell({ children }: { children: ReactNode }) {
  const workspaceId = useSelectedWorkspaceId();
  const conn = useStore(s => s.conn);
  const panel = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, workspaceId));
  const toggleVisibility = useRightPanelStore(s => s.toggleVisibility);
  const terminalOpen = useTerminalDrawerStore(s => selectTerminalUiState(s.byWorkspaceId, workspaceId).terminalOpen);
  const toggleTerminal = useTerminalDrawerStore(s => s.toggle);
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  // The current space's hue rides the sidebar element, so the glass recipe and the macOS material both take it.
  const spaceTint = useSpaceTint();
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
      <ContextMenuHost />
      <WorkspaceSwitcher />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        {...tintAttr(spaceTint)}
        className={cn(isDesktopMac() ? "sidebar-vibrancy" : "sidebar-glass", "border-r border-sidebar-border text-sidebar-foreground")}
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
              <ThreadBreadcrumb />
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
