// SPDX-License-Identifier: AGPL-3.0-only
// The window keydown listener that resolves a shortcut against the rules
// and the focus context, then runs the command. Mounted once, inside the
// sidebar provider so the sidebar toggle is reachable.
import { useEffect, useRef } from "react";
import { surfaceShortcutTargetsTypingContext } from "../components/RightPanelTabs.js";
import { useSidebar } from "../components/ui/sidebar.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { resolveShortcutCommand } from "../keybindings.js";
import type { ResolvedKeybindingsConfig } from "../keybindingTypes.js";
import { isPreviewFocused } from "../lib/previewFocus.js";
import { isTerminalFocused } from "../lib/terminalFocus.js";
import { useSelectedId } from "../protocol/store.js";
import { runShellCommand, type ShellCommandTarget } from "./shellCommands.js";

export function KeybindingDispatcher({ keybindings = DEFAULT_RESOLVED_KEYBINDINGS }: { keybindings?: ResolvedKeybindingsConfig }) {
  const { toggleSidebar } = useSidebar();
  const workspaceId = useSelectedId();
  const target = useRef<ShellCommandTarget>({ workspaceId, toggleSidebar });
  target.current = { workspaceId, toggleSidebar };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
      });
      if (command === null) return;
      // An unchorded key inside an input is the user's text, whatever a rule says.
      const chorded = event.metaKey || event.ctrlKey;
      if (!chorded && event.target instanceof Element && surfaceShortcutTargetsTypingContext(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      runShellCommand(command, target.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  return null;
}
