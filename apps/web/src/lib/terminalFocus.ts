// Adapted from pingdotgg/t3code apps/web/src/lib/terminalFocus.ts at 57a66608 (MIT).
// Their surfaces mark themselves with data-terminal-owner; the xterm pane
// in the center tabs has no such mark, so its own root class counts too.
const TERMINAL_FOCUS_SELECTOR = "[data-terminal-owner], .xterm";

export function isTerminalFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  return activeElement.closest(TERMINAL_FOCUS_SELECTOR) !== null;
}
