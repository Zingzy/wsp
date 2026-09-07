// SPDX-License-Identifier: AGPL-3.0-only
// The terminal font as this viewer chose it, kept in localStorage; with no
// choice the pane draws with the family the collector read from the person's
// terminal config (the boot payload), and with neither its own default stack.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { bootPayload } from "../boot.js";
import type { TerminalViewportConfig } from "../components/ThreadTerminalDrawer.js";

export const TERMINAL_FONT_KEY = "wsp:terminal-font";
const CHANGE_EVENT = "wsp:terminal-font-change";

/** The family this viewer chose, or undefined for none; a storage that throws reads as none. */
export function readTerminalFont(): string | undefined {
  try {
    const raw = window.localStorage.getItem(TERMINAL_FONT_KEY);
    const family = raw?.trim();
    return family === undefined || family.length === 0 ? undefined : family;
  } catch {
    return undefined;
  }
}

/** Saves the choice; an empty family clears it. A storage that throws leaves the page on its current font. */
export function writeTerminalFont(family: string): void {
  try {
    const trimmed = family.trim();
    if (trimmed.length === 0) window.localStorage.removeItem(TERMINAL_FONT_KEY);
    else window.localStorage.setItem(TERMINAL_FONT_KEY, trimmed);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The family the collector read from the person's terminal config, when the recipe ticked it. */
export function detectedTerminalFont(): string | undefined {
  const family = bootPayload()?.terminalFont?.trim();
  return family === undefined || family.length === 0 ? undefined : family;
}

/** The family the pane draws with: the viewer's choice, else the detected one, else undefined for the default stack. */
export function effectiveTerminalFont(): string | undefined {
  return readTerminalFont() ?? detectedTerminalFont();
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TERMINAL_FONT_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

const chosen = (): string => readTerminalFont() ?? "";

export function useTerminalFont(): { family: string; detected: string | undefined; setFamily: (family: string) => void } {
  const family = useSyncExternalStore(subscribe, chosen, chosen);
  const setFamily = useCallback((next: string) => writeTerminalFont(next), []);
  return { family, detected: detectedTerminalFont(), setFamily };
}

const NO_FONT: TerminalViewportConfig = {};

/** The viewport config for the effective family, saying whether the viewer typed it, since a typed family beats the
 * one in their terminal config file where a detected one does not; its identity changes only with the family, so a
 * chunk of output never rebuilds it. */
export function useTerminalViewportConfig(): TerminalViewportConfig {
  const family = useSyncExternalStore(subscribe, effectiveTerminalFont, effectiveTerminalFont);
  const chosenFont = useSyncExternalStore(subscribe, chosen, chosen) !== "";
  return useMemo(() => (family === undefined ? NO_FONT : { font: { family }, chosenFont }), [family, chosenFont]);
}
