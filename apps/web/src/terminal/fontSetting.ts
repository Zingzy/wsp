// SPDX-License-Identifier: AGPL-3.0-only
// The terminal font as this viewer chose it, kept in localStorage; with no
// choice the pane draws with the family the collector read from the person's
// terminal config (the boot payload), and with neither its own default stack.
// The size is the other half: one per workspace, the app's own text size until
// a zoom chord steps it, and kept beside the sidebar's width.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { bootPayload } from "../boot.js";
import type { TerminalViewportConfig } from "../components/ThreadTerminalDrawer.js";
import { appTerminalFontSize, terminalFontSize } from "./ghostty/surface.js";

export const TERMINAL_FONT_KEY = "wsp:terminal-font";
export const TERMINAL_FONT_SIZE_PREFIX = "wsp:terminal-font-size:";
const CHANGE_EVENT = "wsp:terminal-font-change";
/** The step Ghostty's own zoom takes, in css px. */
const FONT_SIZE_STEP = 1;

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

const sizeKey = (workspaceId: string): string => `${TERMINAL_FONT_SIZE_PREFIX}${workspaceId}`;

/** The size this workspace's panes draw at: the app's own text size until a zoom chord moves it. */
export function readTerminalFontSize(workspaceId: string): number {
  try {
    const raw = window.localStorage.getItem(sizeKey(workspaceId))?.trim();
    return terminalFontSize(raw === undefined || raw.length === 0 ? undefined : Number(raw));
  } catch {
    return appTerminalFontSize();
  }
}

function writeTerminalFontSize(workspaceId: string, size: number | null): void {
  try {
    if (size === null) window.localStorage.removeItem(sizeKey(workspaceId));
    else window.localStorage.setItem(sizeKey(workspaceId), String(size));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** One step of the terminal's own zoom, clamped to the sizes the surface draws. */
export function stepTerminalFontSize(workspaceId: string, steps: number): void {
  writeTerminalFontSize(workspaceId, terminalFontSize(readTerminalFontSize(workspaceId) + steps * FONT_SIZE_STEP));
}

/** The panes back on the app's own text size, with nothing of this workspace's own left behind. */
export function resetTerminalFontSize(workspaceId: string): void {
  writeTerminalFontSize(workspaceId, null);
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TERMINAL_FONT_KEY || event.key.startsWith(TERMINAL_FONT_SIZE_PREFIX)) onChange();
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

/** The viewport config for the effective family and this workspace's size, saying whether the viewer typed the family,
 * since a typed family beats the one in their terminal config file where a detected one does not; its identity changes
 * only with those, so a chunk of output never rebuilds it. */
export function useTerminalViewportConfig(workspaceId: string): TerminalViewportConfig {
  const family = useSyncExternalStore(subscribe, effectiveTerminalFont, effectiveTerminalFont);
  const chosenFont = useSyncExternalStore(subscribe, chosen, chosen) !== "";
  const readSize = useCallback(() => readTerminalFontSize(workspaceId), [workspaceId]);
  const size = useSyncExternalStore(subscribe, readSize, readSize);
  return useMemo(() => ({ font: { ...(family !== undefined ? { family } : {}), size }, chosenFont }), [family, size, chosenFont]);
}
