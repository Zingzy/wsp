// SPDX-License-Identifier: AGPL-3.0-only
// One place that turns a keybinding command into store calls, shared by the
// shortcut dispatcher and the palette so both agree on what a command does.
// Terminal commands go through the right panel store's surface actions; the
// pty itself comes from the workspace's terminal link.
import { toggleCommandPalette } from "../commandPaletteBus.js";
import type { KeybindingCommand } from "../keybindingTypes.js";
import { useStore } from "../protocol/store.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../rightPanelStore.js";
import { getTerminals } from "../terminal/link.js";
import { requestNewThread } from "./shellRequests.js";

export interface ShellCommandTarget {
  readonly workspaceId: string | null;
  readonly toggleSidebar: () => void;
}

const reportTerminalFailure = (error: unknown): void => {
  useStore.setState({ toast: `terminal: ${error instanceof Error ? error.message : String(error)}` });
};

/** A fresh pty in its own surface. */
export function openNewTerminal(workspaceId: string): Promise<void> {
  const terminals = getTerminals(workspaceId);
  if (!terminals) {
    reportTerminalFailure(new Error("no terminal link for this workspace"));
    return Promise.resolve();
  }
  return terminals
    .open()
    .then(tab => useRightPanelStore.getState().openTerminal(workspaceId, tab.ptyId))
    .catch(reportTerminalFailure);
}

/** The last terminal surface if there is one, else a new one. */
export function showTerminal(workspaceId: string): Promise<void> {
  const panel = useRightPanelStore.getState();
  const state = selectWorkspaceRightPanelState(panel.byWorkspaceId, workspaceId);
  const last = [...state.surfaces].reverse().find(surface => surface.kind === "terminal");
  if (last) {
    panel.activateSurface(workspaceId, last.id);
    return Promise.resolve();
  }
  return openNewTerminal(workspaceId);
}

/** A fresh pty split into the active terminal surface, or a new surface when none is active. */
export function splitTerminal(workspaceId: string): Promise<void> {
  const panel = useRightPanelStore.getState();
  const state = selectWorkspaceRightPanelState(panel.byWorkspaceId, workspaceId);
  const active = state.surfaces.find(surface => surface.id === state.activeSurfaceId);
  if (!active || active.kind !== "terminal") return openNewTerminal(workspaceId);
  const terminals = getTerminals(workspaceId);
  if (!terminals) {
    reportTerminalFailure(new Error("no terminal link for this workspace"));
    return Promise.resolve();
  }
  return terminals
    .open()
    .then(tab => useRightPanelStore.getState().splitTerminal(workspaceId, active.id, tab.ptyId))
    .catch(reportTerminalFailure);
}

export function runShellCommand(command: KeybindingCommand, target: ShellCommandTarget): void {
  const { workspaceId } = target;
  switch (command) {
    case "sidebar.toggle":
      target.toggleSidebar();
      return;
    case "commandPalette.toggle":
      toggleCommandPalette();
      return;
    case "rightPanel.toggle":
      if (workspaceId) useRightPanelStore.getState().toggleVisibility(workspaceId);
      return;
    case "preview.toggle":
      if (workspaceId) useRightPanelStore.getState().toggle(workspaceId, "preview");
      return;
    case "terminal.toggle": {
      if (!workspaceId) return;
      const panel = useRightPanelStore.getState();
      const state = selectWorkspaceRightPanelState(panel.byWorkspaceId, workspaceId);
      const active = state.surfaces.find(surface => surface.id === state.activeSurfaceId);
      if (state.isOpen && active?.kind === "terminal") {
        panel.close(workspaceId);
        return;
      }
      void showTerminal(workspaceId);
      return;
    }
    case "terminal.new":
      if (workspaceId) void openNewTerminal(workspaceId);
      return;
    case "terminal.split":
      if (workspaceId) void splitTerminal(workspaceId);
      return;
    case "chat.new":
      if (workspaceId) requestNewThread({ workspaceId });
      return;
    default: {
      const _exhaustive: never = command;
      return;
    }
  }
}
