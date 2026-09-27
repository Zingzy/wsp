// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Appearance: the theme picker, the side and each side's theme, and
// the app and code fonts, whether a notification makes a sound, and whether
// the desktop app keeps this computer awake while a thread works. The
// terminal draws with the person's Ghostty font and takes neither font.
import { DEFAULT_PREFERENCES, type Preferences, type PreferencesPatch } from "@wsp/protocol";
import { Switch } from "../components/ui/switch.js";
import { FontPicker } from "./FontPicker.js";
import { AWAKE_WORDS, FONT_WORDS, NOTIFY_WORDS, SETTINGS_WORDS } from "./format.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { ThemePicker } from "./ThemePicker.js";

/** The one patch Restore defaults writes: the side, each side's theme, both fonts, the sound and keeping awake back to
 * the record's defaults. */
export const APPEARANCE_DEFAULTS: PreferencesPatch = {
  theme: DEFAULT_PREFERENCES.theme,
  lightTheme: DEFAULT_PREFERENCES.lightTheme,
  darkTheme: DEFAULT_PREFERENCES.darkTheme,
  appFont: DEFAULT_PREFERENCES.appFont,
  codeFont: DEFAULT_PREFERENCES.codeFont,
  notifySound: DEFAULT_PREFERENCES.notifySound,
  keepAwake: DEFAULT_PREFERENCES.keepAwake,
};

/** Whether any of those is off its default, which is when Restore defaults stands. */
export const appearanceOffDefaults = (p: Preferences): boolean =>
  p.theme !== DEFAULT_PREFERENCES.theme ||
  p.lightTheme !== DEFAULT_PREFERENCES.lightTheme ||
  p.darkTheme !== DEFAULT_PREFERENCES.darkTheme ||
  p.appFont !== DEFAULT_PREFERENCES.appFont ||
  p.codeFont !== DEFAULT_PREFERENCES.codeFont ||
  p.notifySound !== DEFAULT_PREFERENCES.notifySound ||
  p.keepAwake !== DEFAULT_PREFERENCES.keepAwake;

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
      id: "fonts",
      head: FONT_WORDS.head,
      items: [
        { kind: "row", id: "app-font", title: FONT_WORDS.app, description: FONT_WORDS.appDescription, control: <FontPicker id="app-font" label={FONT_WORDS.app} value={preferences.appFont} onChange={appFont => setPreferences({ appFont })} /> },
        { kind: "row", id: "code-font", title: FONT_WORDS.code, description: FONT_WORDS.codeDescription, control: <FontPicker id="code-font" label={FONT_WORDS.code} value={preferences.codeFont} onChange={codeFont => setPreferences({ codeFont })} /> },
      ],
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
    {
      id: "awake",
      head: AWAKE_WORDS.head,
      items: [
        {
          kind: "row",
          id: "keep-awake",
          title: AWAKE_WORDS.keepAwake,
          description: AWAKE_WORDS.keepAwakeDescription,
          control: <Switch data-k="keep-awake" aria-label={AWAKE_WORDS.keepAwake} checked={preferences.keepAwake} onCheckedChange={keepAwake => setPreferences({ keepAwake })} />,
        },
      ],
    },
  ];
}
