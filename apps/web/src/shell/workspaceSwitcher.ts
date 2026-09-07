// SPDX-License-Identifier: AGPL-3.0-only
// The hold-to-switch overlay's state: the workspace order frozen at the
// moment it opened and where the highlight sits in it. The order is frozen
// because a turn ending elsewhere re-sorts the sidebar, and a card must not
// move out from under the highlight while a person is stepping through them.
// Nothing is selected until the commit, so stepping past a workspace never
// mounts its threads.
import { create } from "zustand";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { shortcutHoldKeysForCommand } from "../keybindings.js";
import type { ResolvedKeybindingsConfig } from "../keybindingTypes.js";

interface WorkspaceSwitcherState {
  /** The workspace ids the overlay walks, in sidebar order; empty while it is closed. */
  ids: ReadonlyArray<string>;
  /** Where the highlight sits in ids. */
  at: number;
  open: boolean;
  /** The workspace that was selected when it opened, so a card can say which one that is. */
  from: string | null;
  openAt: (ids: ReadonlyArray<string>, at: number, from: string | null) => void;
  step: (step: 1 | -1) => void;
  close: () => void;
}

export const useWorkspaceSwitcher = create<WorkspaceSwitcherState>(set => ({
  ids: [],
  at: 0,
  open: false,
  from: null,
  openAt: (ids, at, from) => set({ ids, at, open: true, from }),
  step: step => set(s => (s.open ? { at: stepSwitcherAt(s.ids.length, s.at, step) } : s)),
  close: () => set({ ids: [], at: 0, open: false, from: null }),
}));

/**
 * How long the overlay waits before it paints. The state opens on the first step, so a tap's step and a second tab
 * straight after it both land; only the paint waits, so a tap that lets the hold go inside this window switches
 * without ever dimming the app. The system switchers this follows hold their paint back the same way.
 */
export const SWITCHER_PAINT_DELAY_MS = 150;

/** One step of the highlight around the frozen order. It always moves, unlike the tap's step, which has nowhere to
 * go with one workspace: once the overlay is up the key has to answer. */
export function stepSwitcherAt(length: number, at: number, step: 1 | -1): number {
  if (length === 0) return 0;
  return (at + step + length) % length;
}

/** The workspace the highlight sits on, or null while the overlay is closed. */
export function highlightedWorkspaceId(state: Pick<WorkspaceSwitcherState, "ids" | "at" | "open">): string | null {
  return state.open ? state.ids[state.at] ?? null : null;
}

/** The keys the switch chord holds down, from the one keybinding table; letting one go commits the overlay. The two
 * directions share the hold, so it is the modifiers both chords carry: Shift is only one step's, and a table that
 * binds the two directions under different modifiers has no hold at all rather than one that never comes up. Empty
 * in a browser tab too, where the chords are the browser's and the overlay never opens. */
export function switchHoldKeys(
  keybindings: ResolvedKeybindingsConfig = DEFAULT_RESOLVED_KEYBINDINGS,
  options?: { platform?: string; context?: { desktopShell?: boolean } },
): string[] {
  const back = shortcutHoldKeysForCommand(keybindings, "workspace.previous", options);
  return shortcutHoldKeysForCommand(keybindings, "workspace.next", options).filter(key => back.includes(key));
}
