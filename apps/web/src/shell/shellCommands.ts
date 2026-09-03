// SPDX-License-Identifier: AGPL-3.0-only
// One place that turns a keybinding command into store calls, shared by the
// shortcut dispatcher, the palette, the header button and the terminal
// surfaces so they all agree on what a command does. The terminal shortcuts
// drive the drawer under the chat, except that new and split act on the right
// panel's terminal while one of its terminals has focus; the panel surface
// itself opens only from its own tab strip. Every pty comes from the link.
import { toggleCommandPalette } from "../commandPaletteBus.js";
import type { KeybindingCommand } from "../keybindingTypes.js";
import { getTerminalFocusOwner } from "../lib/terminalFocus.js";
import { useStore } from "../protocol/store.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../rightPanelStore.js";
import { useTerminalDrawerStore } from "../terminal/drawerStore.js";
import { getTerminals, type WorkspaceTerminals } from "../terminal/link.js";
import { requestNewThread } from "./shellRequests.js";

export interface ShellCommandTarget {
  readonly workspaceId: string | null;
  readonly toggleSidebar: () => void;
}

export type SplitDirection = "horizontal" | "vertical";

export function reportTerminalFailure(error: unknown): void {
  useStore.setState({ toast: `terminal: ${error instanceof Error ? error.message : String(error)}` });
}

/** Runs fn against the workspace's link; no link or a refused create ends in a toast, never in silence. */
function withTerminals(workspaceId: string, fn: (terminals: WorkspaceTerminals) => Promise<unknown>): Promise<void> {
  const terminals = getTerminals(workspaceId);
  if (!terminals) {
    reportTerminalFailure(new Error("no terminal link for this workspace"));
    return Promise.resolve();
  }
  return fn(terminals).then(() => undefined, reportTerminalFailure);
}

/** The drawer, shown; a workspace that never had a pty spawns one on mount. */
export function showTerminal(workspaceId: string): Promise<void> {
  useTerminalDrawerStore.getState().setOpen(workspaceId, true);
  return Promise.resolve();
}

/** A fresh pty as its own drawer tab; the drawer opens if it was closed. */
export function openDrawerTerminal(workspaceId: string): Promise<void> {
  return withTerminals(workspaceId, terminals =>
    terminals.open().then(tab => useTerminalDrawerStore.getState().add(workspaceId, tab.ptyId)),
  );
}

/** A fresh pty split into the drawer's active group. */
export function splitDrawerTerminal(workspaceId: string, direction: SplitDirection = "horizontal"): Promise<void> {
  return withTerminals(workspaceId, terminals =>
    terminals.open().then(tab => useTerminalDrawerStore.getState().split(workspaceId, tab.ptyId, direction)),
  );
}

/** A fresh pty in its own right-panel surface. */
export function openPanelTerminal(workspaceId: string): Promise<void> {
  return withTerminals(workspaceId, terminals =>
    terminals.open().then(tab => useRightPanelStore.getState().openTerminal(workspaceId, tab.ptyId)),
  );
}

/** A fresh pty split into one right-panel terminal surface. */
export function splitPanelTerminal(workspaceId: string, surfaceId: string, direction: SplitDirection = "horizontal"): Promise<void> {
  return withTerminals(workspaceId, terminals =>
    terminals.open().then(tab => useRightPanelStore.getState().splitTerminal(workspaceId, surfaceId, tab.ptyId, direction)),
  );
}

/** A fresh pty split into the panel's active terminal surface, or a new surface when none is active. */
export function splitActivePanelTerminal(workspaceId: string, direction: SplitDirection = "horizontal"): Promise<void> {
  const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, workspaceId);
  const active = state.surfaces.find(surface => surface.id === state.activeSurfaceId);
  if (!active || active.kind !== "terminal") return openPanelTerminal(workspaceId);
  return splitPanelTerminal(workspaceId, active.id, direction);
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
    case "terminal.toggle":
      if (workspaceId) useTerminalDrawerStore.getState().toggle(workspaceId);
      return;
    case "terminal.new":
      if (!workspaceId) return;
      void (getTerminalFocusOwner() === "right-panel" ? openPanelTerminal(workspaceId) : openDrawerTerminal(workspaceId));
      return;
    case "terminal.split":
      if (!workspaceId) return;
      void (getTerminalFocusOwner() === "right-panel" ? splitActivePanelTerminal(workspaceId) : splitDrawerTerminal(workspaceId));
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
