// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Appearance: the three picks the host's record holds, each one
// row with its control, and the one group with defaults to restore.
import { DEFAULT_PREFERENCES, TerminalSizeSource, ThemePreference, type Preferences, type PreferencesPatch } from "@wsp/protocol";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "../components/ui/number-field.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../shell/sidebarWidth.js";
import { appTerminalFontSize } from "../terminal/ghostty/surface.js";
import { SETTINGS_WORDS, TERMINAL_SIZE_FACT, TERMINAL_SIZE_WORDS, THEME_WORDS } from "./format.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

const THEMES = ThemePreference.options.map(value => ({ value, label: THEME_WORDS[value] }));
const SIZES = TerminalSizeSource.options.map(value => ({ value, label: TERMINAL_SIZE_WORDS[value] }));

/** The one patch Restore defaults writes: every pick of the group back to the record's defaults. */
export const APPEARANCE_DEFAULTS: PreferencesPatch = { theme: DEFAULT_PREFERENCES.theme, sidebarWidth: null, terminalSize: DEFAULT_PREFERENCES.terminalSize };

/** Whether any of the three is off its default, which is when Restore defaults stands. */
export const appearanceOffDefaults = (p: Preferences): boolean => p.theme !== DEFAULT_PREFERENCES.theme || p.sidebarWidth !== undefined || p.terminalSize !== DEFAULT_PREFERENCES.terminalSize;

export function appearanceCards(ctx: SettingsContext): SettingsCardData[] {
  const { preferences, setPreferences } = ctx;
  const width = preferences.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
  return [
    {
      id: "appearance",
      items: [
        {
          kind: "row",
          id: "theme",
          title: SETTINGS_WORDS.theme,
          description: SETTINGS_WORDS.themeDescription,
          drops: true,
          control: <SegmentedControl aria-label={SETTINGS_WORDS.theme} value={preferences.theme} segments={THEMES} onChange={theme => setPreferences({ theme })} />,
        },
        {
          kind: "row",
          id: "sidebar-width",
          title: SETTINGS_WORDS.sidebarWidth,
          description: SETTINGS_WORDS.sidebarWidthDescription,
          drops: true,
          control: (
            <NumberField
              aria-label={SETTINGS_WORDS.sidebarWidth}
              className="w-auto"
              size="sm"
              min={SIDEBAR_MIN_WIDTH}
              max={SIDEBAR_MAX_WIDTH}
              step={8}
              value={width}
              onValueChange={value => {
                // Held to the drag's bounds before the host hears it, since every keystroke lands here; the field's
                // own clamp on blur then repeats the value, which is not sent twice.
                if (value === null || !Number.isFinite(value)) return;
                const sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
                if (sidebarWidth !== width) setPreferences({ sidebarWidth });
              }}
            >
              <NumberFieldGroup className="w-auto">
                <NumberFieldDecrement aria-label="Narrower" />
                <NumberFieldInput data-k="sidebar-width" aria-label={SETTINGS_WORDS.sidebarWidth} className="w-14 font-mono text-[11px]" />
                <NumberFieldIncrement aria-label="Wider" />
              </NumberFieldGroup>
            </NumberField>
          ),
        },
        {
          kind: "row",
          id: "terminal-size",
          title: SETTINGS_WORDS.textSize,
          description: SETTINGS_WORDS.textSizeDescription,
          drops: true,
          word: TERMINAL_SIZE_FACT[preferences.terminalSize](appTerminalFontSize(), ctx.reads.file?.fontSize),
          attrs: { "data-k": "terminal-size-row" },
          control: <SegmentedControl aria-label={SETTINGS_WORDS.textSize} value={preferences.terminalSize} segments={SIZES} onChange={terminalSize => setPreferences({ terminalSize })} />,
        },
      ],
    },
  ];
}
