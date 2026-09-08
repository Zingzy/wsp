// SPDX-License-Identifier: AGPL-3.0-only
// The three view preferences the page once kept in this browser's localStorage,
// read once so a person's picks survive the move onto the host's record, and
// dropped once the host has them. A browser that never held them reads as
// nothing to move.
import { SidebarMode, type PreferencesPatch } from "@wsp/protocol";
import { appTerminalFontSize } from "../terminal/ghostty/surface.js";

const SIDEBAR_WIDTH_KEY = "wsp:sidebar-width";
const SIDEBAR_MODE_KEY = "wsp:sidebar-mode";
const TERMINAL_SIZE_PREFIX = "wsp:terminal-font-size:";

const keysOf = (storage: Storage): string[] => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => key !== null);

/** The old width was JSON; anything else under the key reads as none. */
function widthOf(raw: string | null): number | undefined {
  try {
    const width = Number(JSON.parse(raw ?? "null"));
    return Number.isFinite(width) && width > 0 ? Math.round(width) : undefined;
  } catch {
    return undefined;
  }
}

/** What the old keys hold, as a patch for the host's record, or null when this browser kept none of them. A storage that
 * throws reads as none. The old per-workspace size was absolute; the record keeps the pixels added to the app's size. */
export function legacyPreferences(storage: Storage): PreferencesPatch | null {
  const patch: PreferencesPatch = {};
  try {
    const width = widthOf(storage.getItem(SIDEBAR_WIDTH_KEY));
    if (width !== undefined) patch.sidebarWidth = width;
    const mode = SidebarMode.safeParse(storage.getItem(SIDEBAR_MODE_KEY));
    if (mode.success) patch.sidebarMode = mode.data;
    const zoom: Record<string, number> = {};
    for (const key of keysOf(storage)) {
      if (!key.startsWith(TERMINAL_SIZE_PREFIX)) continue;
      const size = Number(storage.getItem(key));
      if (Number.isFinite(size)) zoom[key.slice(TERMINAL_SIZE_PREFIX.length)] = Math.round(size) - appTerminalFontSize();
    }
    if (Object.keys(zoom).length > 0) patch.terminalZoom = zoom;
  } catch {
    return null;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Drops the old keys; called once the host answered with them on its record. */
export function clearLegacyPreferences(storage: Storage): void {
  try {
    for (const key of keysOf(storage)) if (key === SIDEBAR_WIDTH_KEY || key === SIDEBAR_MODE_KEY || key.startsWith(TERMINAL_SIZE_PREFIX)) storage.removeItem(key);
  } catch {
    return;
  }
}
