// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Appearance: the theme as three pictures of the app, and what the
// chosen one does under them.
import { DEFAULT_PREFERENCES, type Preferences, type PreferencesPatch } from "@wsp/protocol";
import { SETTINGS_WORDS } from "./format.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { ThemePicker } from "./ThemePicker.js";

/** The one patch Restore defaults writes: the theme back to the record's default. */
export const APPEARANCE_DEFAULTS: PreferencesPatch = { theme: DEFAULT_PREFERENCES.theme };

/** Whether the theme is off its default, which is when Restore defaults stands. */
export const appearanceOffDefaults = (p: Preferences): boolean => p.theme !== DEFAULT_PREFERENCES.theme;

export function appearanceCards(ctx: SettingsContext): SettingsCardData[] {
  const { preferences, setPreferences } = ctx;
  return [
    {
      id: "theme",
      head: SETTINGS_WORDS.theme,
      items: [],
      body: <ThemePicker value={preferences.theme} onChange={theme => setPreferences({ theme })} />,
    },
  ];
}
