// SPDX-License-Identifier: AGPL-3.0-only
// The window key listeners that resolve a shortcut against the rules and the
// focus context, then run the command. Mounted once, inside the sidebar
// provider so the sidebar toggle is reachable. The switcher overlay is the
// one command that outlives its keydown: it stays up while the switch chord's
// modifier is held, so this listens for that key coming up, for the Escape
// that cancels, and for the window losing focus with the hold unresolved.
import { useEffect, useRef } from "react";
import { surfaceShortcutTargetsTypingContext } from "../components/RightPanelTabs.js";
import { useSidebar } from "../components/ui/sidebar.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { resolveShortcutCommand } from "../keybindings.js";
import type { ResolvedKeybindingsConfig } from "../keybindingTypes.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { isPreviewFocused } from "../lib/previewFocus.js";
import { isTerminalFocused } from "../lib/terminalFocus.js";
import { useSelectedWorkspaceId } from "../protocol/store.js";
import { cancelWorkspaceSwitch, commitWorkspaceSwitch, runShellCommand, type ShellCommandTarget } from "./shellCommands.js";
import { switchHoldKeys, useWorkspaceSwitcher } from "./workspaceSwitcher.js";

export function KeybindingDispatcher({ keybindings = DEFAULT_RESOLVED_KEYBINDINGS }: { keybindings?: ResolvedKeybindingsConfig }) {
  const { toggleSidebar } = useSidebar();
  const workspaceId = useSelectedWorkspaceId();
  const target = useRef<ShellCommandTarget>({ workspaceId, toggleSidebar });
  target.current = { workspaceId, toggleSidebar };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      // Escape is the only key the overlay takes out of the rules; every other chord still reaches the shell under
      // it, so mod+k opens the palette over it and mod+b moves the sidebar behind it.
      if (event.key === "Escape" && useWorkspaceSwitcher.getState().open) {
        event.preventDefault();
        cancelWorkspaceSwitch();
        return;
      }
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
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!useWorkspaceSwitcher.getState().open) return;
      if (!switchHoldKeys(keybindings).includes(event.key)) return;
      commitWorkspaceSwitch();
    };
    // A chord that takes focus away (the system's own window switch) never delivers its key up here, so the hold
    // would stay unresolved and the overlay would sit over the page.
    const onBlur = (): void => cancelWorkspaceSwitch();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [keybindings]);

  useEffect(() => {
    const bridge = desktopBridge();
    const setTerminalFocus = bridge?.setTerminalFocus;
    const onShellChord = bridge?.onShellChord;
    if (setTerminalFocus === undefined || onShellChord === undefined) return;
    // A focusout fires before the focus lands, so what has it is read on the turn after the move.
    let reported: boolean | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const report = (): void => {
      pending = null;
      const focused = isTerminalFocused();
      if (focused === reported) return;
      reported = focused;
      setTerminalFocus(focused);
    };
    const scheduleReport = (): void => {
      if (pending === null) pending = setTimeout(report, 0);
    };
    report();
    window.addEventListener("focusin", scheduleReport);
    window.addEventListener("focusout", scheduleReport);
    const stopChords = onShellChord(chord => {
      const command = resolveShortcutCommand(chord, keybindings, {
        context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
      });
      if (command !== null) runShellCommand(command, target.current);
    });
    return () => {
      if (pending !== null) clearTimeout(pending);
      window.removeEventListener("focusin", scheduleReport);
      window.removeEventListener("focusout", scheduleReport);
      stopChords();
    };
  }, [keybindings]);

  return null;
}
