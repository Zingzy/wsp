// SPDX-License-Identifier: AGPL-3.0-only
// The words the Keybindings page says for each command in the closed set, one
// table, exhaustive: a command added to the set must get its words here or
// the type check refuses the build. The nine jump commands each have an entry
// and the page folds them into one line.
import { WORKSPACE_SELECT_SLOTS, workspaceSelectCommand, type KeybindingCommand } from "../keybindingTypes.js";

export const JUMP_WORD = "Jump to a task";

/** What a line says while it listens for a chord, and why it refuses one. */
export const CHORD_WORDS = {
  capturing: "Press keys",
  capture: (label: string): string => `Change the chord for ${label}`,
  reset: "Reset",
  taken: (holders: readonly string[]): string => `Taken by ${holders.join(" and ")}`,
  tabKeeps: (chord: string): string => `A browser tab keeps ${chord} for itself`,
} as const;

export const KEYBINDING_WORDS: Record<KeybindingCommand, string> = {
  "commandPalette.toggle": "Search",
  "files.quickOpen": "Find a file",
  "files.search": "Search in files",
  "settings.toggle": "Settings",
  "sidebar.toggle": "Toggle the sidebar",
  "terminal.toggle": "Toggle the terminal drawer",
  "rightPanel.toggle": "Toggle the right panel",
  "rightPanel.nextTab": "Next panel tab",
  "rightPanel.previousTab": "Previous panel tab",
  "preview.toggle": "Toggle the preview",
  "chat.new": "New thread",
  "workspace.next": "Next task",
  "workspace.previous": "Previous task",
  "thread.next": "Next thread",
  "thread.previous": "Previous thread",
  "thread.settle": "Settle thread",
  "editor.open": "Open in editor",
  "thread.nextNeedsYou": "Next thread that needs you",
  "terminal.split": "Split the terminal",
  "terminal.new": "New terminal",
  "terminal.zoomIn": "Zoom in",
  "terminal.zoomOut": "Zoom out",
  "terminal.zoomReset": "Reset the zoom",
  ...(Object.fromEntries(WORKSPACE_SELECT_SLOTS.map(slot => [workspaceSelectCommand(slot), JUMP_WORD])) as Record<ReturnType<typeof workspaceSelectCommand>, string>),
};
