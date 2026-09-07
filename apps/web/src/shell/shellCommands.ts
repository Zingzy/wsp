// SPDX-License-Identifier: AGPL-3.0-only
// One place that turns a keybinding command into store calls, shared by the
// shortcut dispatcher, the palette, the header button and the terminal
// surfaces so they all agree on what a command does. The terminal shortcuts
// drive the drawer under the chat, except that new and split act on the right
// panel's terminal while one of its terminals has focus; the panel surface
// itself opens only from its own tab strip. Every pty comes from the link.
// The workspace switch walks the sidebar's own order and lands in the new
// workspace's composer; the chord's walk stays inside the switcher overlay
// until the hold is let go.
import { sidebarWorkspaceOrder } from "../adapt/index.js";
import { toggleCommandPalette } from "../commandPaletteBus.js";
import { isWorkspaceSelectCommand, workspaceSelectSlot, type KeybindingCommand, type WorkspaceSelectSlot } from "../keybindingTypes.js";
import { getTerminalFocusOwner } from "../lib/terminalFocus.js";
import { useStore } from "../protocol/store.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../rightPanelStore.js";
import { useTerminalDrawerStore } from "../terminal/drawerStore.js";
import { resetTerminalFontSize, stepTerminalFontSize } from "../terminal/fontSetting.js";
import { getTerminals, type WorkspaceTerminals } from "../terminal/link.js";
import { requestComposerFocus, requestNewThread } from "./shellRequests.js";
import { highlightedWorkspaceId, useWorkspaceSwitcher } from "./workspaceSwitcher.js";

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

/** The workspace ids in sidebar order. The creation rows a fork draws above them are left out: a creation
    row has no workspace to switch to, and counting one would move every slot under the person's fingers
    while a fork is in flight. */
function orderedWorkspaceIds(): string[] {
  const { workspaces, statuses, sessions } = useStore.getState();
  return sidebarWorkspaceOrder({ workspaces, statuses, sessions });
}

/** One step along an order that wraps at both ends, or null where there is nowhere else to go, which is what
    the palette's disabled rows say. A current id the order does not hold (a creation row) steps in from the
    end it came from. */
export function stepWorkspaceId(ids: ReadonlyArray<string>, currentId: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = currentId === null ? -1 : ids.indexOf(currentId);
  if (at === -1) return (step === 1 ? ids[0] : ids[ids.length - 1]) ?? null;
  const next = ids[(at + step + ids.length) % ids.length] ?? null;
  return next === currentId ? null : next;
}

/** Selects the workspace and puts the caret in its composer: the chords and the palette's rows land the same way. */
export function goToWorkspace(workspaceId: string): void {
  useStore.getState().select(workspaceId);
  requestComposerFocus(workspaceId);
}

export function goToAdjacentWorkspace(step: 1 | -1): void {
  const next = stepWorkspaceId(orderedWorkspaceIds(), useStore.getState().selectedId, step);
  if (next !== null) goToWorkspace(next);
}

/** The switch chord's step. The first one puts the overlay up over the workspace it would land on and the rest walk
 * it; nothing is selected until the hold is let go, so a walk past a workspace never mounts its threads and a tap,
 * which is a step and a release, still switches at once. */
export function cycleWorkspaceSwitcher(step: 1 | -1): void {
  const switcher = useWorkspaceSwitcher.getState();
  if (switcher.open) {
    switcher.step(step);
    return;
  }
  const ids = orderedWorkspaceIds();
  const selectedId = useStore.getState().selectedId;
  const next = stepWorkspaceId(ids, selectedId, step);
  if (next === null) return;
  switcher.openAt(ids, ids.indexOf(next), selectedId);
}

/** The hold let go: the highlighted workspace becomes the open one. */
export function commitWorkspaceSwitch(): void {
  const state = useWorkspaceSwitcher.getState();
  const target = highlightedWorkspaceId(state);
  state.close();
  if (target !== null) goToWorkspace(target);
}

/** Escape, or the window losing focus mid-walk: the overlay leaves and the person stays where they were. */
export function cancelWorkspaceSwitch(): void {
  useWorkspaceSwitcher.getState().close();
}

/** Nothing happens while the sidebar has no row in that slot. */
export function goToWorkspaceInSlot(slot: WorkspaceSelectSlot): void {
  const target = orderedWorkspaceIds()[slot - 1];
  if (target !== undefined) goToWorkspace(target);
}

export function runShellCommand(command: KeybindingCommand, target: ShellCommandTarget): void {
  if (isWorkspaceSelectCommand(command)) {
    goToWorkspaceInSlot(workspaceSelectSlot(command));
    return;
  }
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
    case "terminal.zoomIn":
      if (workspaceId) stepTerminalFontSize(workspaceId, 1);
      return;
    case "terminal.zoomOut":
      if (workspaceId) stepTerminalFontSize(workspaceId, -1);
      return;
    case "terminal.zoomReset":
      if (workspaceId) resetTerminalFontSize(workspaceId);
      return;
    case "chat.new":
      if (workspaceId) requestNewThread({ workspaceId });
      return;
    case "workspace.next":
      cycleWorkspaceSwitcher(1);
      return;
    case "workspace.previous":
      cycleWorkspaceSwitcher(-1);
      return;
    default: {
      const _exhaustive: never = command;
      return;
    }
  }
}
