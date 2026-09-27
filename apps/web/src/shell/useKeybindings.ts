// SPDX-License-Identifier: AGPL-3.0-only
// The rules every chord and every chord label reads: the defaults with the
// person's own chords from the preferences record over them. A component reads
// the hook, so a rebinding redraws its label; a key handler or a menu that
// runs outside render reads the store at the moment it runs.
import { keybindingsFor } from "../keybindingOverrides.js";
import { shortcutLabelForCommand, type ShortcutMatchOptions } from "../keybindings.js";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "../keybindingTypes.js";
import { useStore } from "../protocol/store.js";

export function useKeybindings(): ResolvedKeybindingsConfig {
  return keybindingsFor(useStore(s => s.preferences.keybindings));
}

export function currentKeybindings(): ResolvedKeybindingsConfig {
  return keybindingsFor(useStore.getState().preferences.keybindings);
}

export function useShortcutLabel(command: KeybindingCommand, options?: ShortcutMatchOptions): string | null {
  return shortcutLabelForCommand(useKeybindings(), command, options);
}
