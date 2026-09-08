// SPDX-License-Identifier: AGPL-3.0-only
// What the first paint needs before the host answers: the theme, the sidebar's
// width and its body, kept in this browser as the store last held them, so a
// load paints the side, the width and the body the person picked and nothing
// shifts when the record lands. A cache of the record, never the truth: the
// store boots on it and the record replaces it the moment the host answers;
// every change to the record rewrites it; a value the record's own shape does
// not vouch for reads as none.
import { DEFAULT_PREFERENCES, Preferences } from "@wsp/protocol";

const FIRST_PAINT_KEY = "wsp:first-paint";

const FirstPaint = Preferences.pick({ theme: true, sidebarWidth: true, sidebarMode: true }).partial();
type FirstPaint = ReturnType<typeof FirstPaint.parse>;

function cachedFirstPaint(): FirstPaint {
  try {
    const parsed = FirstPaint.safeParse(JSON.parse(window.localStorage.getItem(FIRST_PAINT_KEY) ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** A storage that throws leaves the next load on the defaults; nothing else depends on the write. */
export function rememberFirstPaint(preferences: Preferences): void {
  const { theme, sidebarWidth, sidebarMode } = preferences;
  try {
    window.localStorage.setItem(FIRST_PAINT_KEY, JSON.stringify({ theme, ...(sidebarWidth !== undefined ? { sidebarWidth } : {}), sidebarMode }));
  } catch {
    return;
  }
}

/** The record the page boots on: the defaults, with what this browser kept in their place. */
export function bootPreferences(): Preferences {
  return { ...DEFAULT_PREFERENCES, ...cachedFirstPaint() };
}
