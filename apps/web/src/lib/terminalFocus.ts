// Adapted from pingdotgg/t3code apps/web/src/lib/terminalFocus.ts at 57a66608 (MIT).
// Their surfaces mark themselves with data-terminal-owner; the xterm pane
// in the center tabs has no such mark, so its own root class counts too.
const TERMINAL_FOCUS_SELECTOR = "[data-terminal-owner], .xterm";

export type TerminalFocusOwner = "drawer" | "right-panel";

function focusedTerminalRoot(): HTMLElement | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  return activeElement.closest<HTMLElement>(TERMINAL_FOCUS_SELECTOR);
}

export function isTerminalFocused(): boolean {
  return focusedTerminalRoot() !== null;
}

/** Which surface holds the focused terminal; the unmarked xterm pane is focused but owned by neither. */
export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const owner = focusedTerminalRoot()?.dataset["terminalOwner"];
  return owner === "drawer" || owner === "right-panel" ? owner : null;
}
