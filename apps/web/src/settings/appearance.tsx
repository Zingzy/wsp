// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Appearance: the theme picker, the side and each side's theme, and
// the app and code fonts, whether the glass shows through, and whether a
// notification makes a sound. The
// terminal draws with the person's Ghostty font and takes neither font.
import { DEFAULT_PREFERENCES, type Preferences, type PreferencesPatch } from "@wsp/protocol";
import { Switch } from "../components/ui/switch.js";
import { FontPicker } from "./FontPicker.js";
import { FONT_WORDS, NOTIFY_WORDS, SETTINGS_WORDS, TRANSPARENCY_WORDS } from "./format.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { ThemePicker } from "./ThemePicker.js";

/** The one patch Restore defaults writes: the side, each side's theme, both fonts and the sound back to the record's
 * defaults. */
export const APPEARANCE_DEFAULTS: PreferencesPatch = {
  theme: DEFAULT_PREFERENCES.theme,
  lightTheme: DEFAULT_PREFERENCES.lightTheme,
  darkTheme: DEFAULT_PREFERENCES.darkTheme,
  appFont: DEFAULT_PREFERENCES.appFont,
  codeFont: DEFAULT_PREFERENCES.codeFont,
  transparency: DEFAULT_PREFERENCES.transparency,
  notifySound: DEFAULT_PREFERENCES.notifySound,
};

/** Whether any of those is off its default, which is when Restore defaults stands. */
export const appearanceOffDefaults = (p: Preferences): boolean =>
  p.theme !== DEFAULT_PREFERENCES.theme ||
  p.lightTheme !== DEFAULT_PREFERENCES.lightTheme ||
  p.darkTheme !== DEFAULT_PREFERENCES.darkTheme ||
  p.appFont !== DEFAULT_PREFERENCES.appFont ||
  p.codeFont !== DEFAULT_PREFERENCES.codeFont ||
  p.transparency !== DEFAULT_PREFERENCES.transparency ||
  p.notifySound !== DEFAULT_PREFERENCES.notifySound;

export function appearanceCards(ctx: SettingsContext): SettingsCardData[] {
  const { preferences, setPreferences } = ctx;
  return [
    {
      id: "theme",
      head: SETTINGS_WORDS.theme,
      items: [
        {
          kind: "row",
          id: "transparency",
          title: TRANSPARENCY_WORDS.title,
          description: TRANSPARENCY_WORDS.description,
          control: <Switch data-k="transparency" aria-label={TRANSPARENCY_WORDS.title} checked={preferences.transparency} onCheckedChange={transparency => setPreferences({ transparency })} />,
        },
      ],
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
  ];
}
