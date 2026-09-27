// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Appearance: the theme picker, the side and each side's theme, and
// whether a notification makes a sound.
import { DEFAULT_PREFERENCES, type Preferences, type PreferencesPatch } from "@wsp/protocol";
import { Switch } from "../components/ui/switch.js";
import { NOTIFY_WORDS, SETTINGS_WORDS } from "./format.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { ThemePicker } from "./ThemePicker.js";

/** The one patch Restore defaults writes: the side, each side's theme and the sound back to the record's defaults. */
export const APPEARANCE_DEFAULTS: PreferencesPatch = { theme: DEFAULT_PREFERENCES.theme, lightTheme: DEFAULT_PREFERENCES.lightTheme, darkTheme: DEFAULT_PREFERENCES.darkTheme, notifySound: DEFAULT_PREFERENCES.notifySound };

/** Whether any of those is off its default, which is when Restore defaults stands. */
export const appearanceOffDefaults = (p: Preferences): boolean =>
  p.theme !== DEFAULT_PREFERENCES.theme || p.lightTheme !== DEFAULT_PREFERENCES.lightTheme || p.darkTheme !== DEFAULT_PREFERENCES.darkTheme || p.notifySound !== DEFAULT_PREFERENCES.notifySound;

export function appearanceCards(ctx: SettingsContext): SettingsCardData[] {
  const { preferences, setPreferences } = ctx;
  return [
    {
      id: "theme",
      head: SETTINGS_WORDS.theme,
      items: [],
      body: <ThemePicker picks={preferences} onChange={setPreferences} />,
    },
    {
      id: "notifications",
      head: NOTIFY_WORDS.head,
      items: [
        {
          kind: "row",
          id: "notify-sound",
          title: NOTIFY_WORDS.sound,
          description: NOTIFY_WORDS.soundDescription,
          control: <Switch data-k="notify-sound" aria-label={NOTIFY_WORDS.sound} checked={preferences.notifySound} onCheckedChange={notifySound => setPreferences({ notifySound })} />,
        },
      ],
    },
  ];
}
