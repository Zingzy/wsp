// SPDX-License-Identifier: AGPL-3.0-only
// The last theme the page applied, kept in this browser so the first paint
// after a load is the side the person picked, not the stylesheet's default
// while the socket connects. A cache of the record, never the truth: the
// record replaces it the moment the host answers, every applied change
// rewrites it, and a value the enum does not vouch for reads as none.
import { DEFAULT_PREFERENCES, ThemePreference, type Preferences } from "@wsp/protocol";

const THEME_CACHE_KEY = "wsp:theme";

export function cachedTheme(): ThemePreference | undefined {
  try {
    const parsed = ThemePreference.safeParse(window.localStorage.getItem(THEME_CACHE_KEY));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A storage that throws leaves the next load on the default; nothing else depends on the write. */
export function rememberTheme(theme: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    return;
  }
}

/** The record the page boots on: the defaults, with the cached theme in the default's place. */
export function bootPreferences(): Preferences {
  const theme = cachedTheme();
  return theme === undefined ? DEFAULT_PREFERENCES : { ...DEFAULT_PREFERENCES, theme };
}
