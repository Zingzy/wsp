// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Appearance: the side, then the themes of the side drawn, each as
// the window it makes; whether the glass shows what is behind the window; and
// the app and code faces and the sizes they are read at, under a sample drawn
// by the conversation's own renderer. The terminal draws with the person's
// Ghostty font and takes neither face nor size.
import { CODE_SIZES, DEFAULT_PREFERENCES, TEXT_SIZES, type Preferences, type PreferencesPatch } from "@wsp/protocol";
import { Suspense, lazy } from "react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { cn } from "../lib/utils.js";
import { FontPicker } from "./FontPicker.js";
import { hereName } from "./places.js";
import { FONT_WORDS, GLASS_WORDS, SETTINGS_WORDS, THEME_SECTION_WORDS, THEME_WORDS, TRANSPARENCY_WORDS } from "./format.js";
import { CARD_SURFACE, type SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { SYSTEM_DARK_QUERY, useAppDark } from "./theme.js";
import { ModePicker, shownSide, ThemePicker } from "./ThemePicker.js";
import { CARD_INSET } from "./layout.js";

const ChatMarkdown = lazy(() => import("../components/ChatMarkdown.js"));

/** The one patch Restore defaults writes: the side, each side's theme, Transparency, both faces and both sizes back to
 * the record's defaults. */
export const APPEARANCE_DEFAULTS: PreferencesPatch = {
  theme: DEFAULT_PREFERENCES.theme,
  lightTheme: DEFAULT_PREFERENCES.lightTheme,
  darkTheme: DEFAULT_PREFERENCES.darkTheme,
  appFont: DEFAULT_PREFERENCES.appFont,
  codeFont: DEFAULT_PREFERENCES.codeFont,
  textSize: null,
  codeSize: null,
  transparency: DEFAULT_PREFERENCES.transparency,
};

/** Whether any of those is off its default, which is when Restore defaults stands. */
export const appearanceOffDefaults = (p: Preferences): boolean =>
  p.theme !== DEFAULT_PREFERENCES.theme ||
  p.lightTheme !== DEFAULT_PREFERENCES.lightTheme ||
  p.darkTheme !== DEFAULT_PREFERENCES.darkTheme ||
  p.appFont !== DEFAULT_PREFERENCES.appFont ||
  p.codeFont !== DEFAULT_PREFERENCES.codeFont ||
  p.textSize !== undefined ||
  p.codeSize !== undefined ||
  p.transparency !== DEFAULT_PREFERENCES.transparency;

/** A size row's control: Default, which leaves every surface its own size, then each size the table offers. */
function SizePicker({ id, label, sizes, value, onChange }: { id: string; label: string; sizes: readonly number[]; value: number | undefined; onChange: (size: number | null) => void }) {
  return (
    <Select value={value === undefined ? "" : String(value)} onValueChange={next => onChange(typeof next === "string" && next !== "" ? Number(next) : null)}>
      <SelectTrigger size="sm" aria-label={label} data-k={id} className="w-28">
        <SelectValue>{(picked: string) => (picked === "" ? FONT_WORDS.default : FONT_WORDS.px(Number(picked)))}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="">{FONT_WORDS.default}</SelectItem>
        {sizes.map(size => (
          <SelectItem key={size} value={String(size)}>
            {FONT_WORDS.px(size)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** A reply with a line of code, drawn by the conversation's own renderer, so it reads in the faces and sizes the
 * conversation reads in. */
function TypeSample() {
  const dark = useAppDark();
  return (
    <div data-k="type-sample" className={cn(CARD_SURFACE, CARD_INSET, "py-3")}>
      <Suspense fallback={null}>
        <ChatMarkdown text={FONT_WORDS.sample} cwd={undefined} resolvedTheme={dark ? "dark" : "light"} />
      </Suspense>
    </div>
  );
}

export function appearanceCards(ctx: SettingsContext): SettingsCardData[] {
  const { preferences, setPreferences } = ctx;
  const themes = SETTINGS_WORDS.themesOf(THEME_WORDS[shownSide(preferences, window.matchMedia(SYSTEM_DARK_QUERY).matches)]);
  return [
    {
      id: "mode",
      head: SETTINGS_WORDS.mode,
      lede: THEME_SECTION_WORDS.modeLede(hereName(ctx.places)),
      items: [],
      search: [{ kind: "row", id: "mode", title: SETTINGS_WORDS.mode, description: THEME_SECTION_WORDS.modeLede(hereName(ctx.places)) }],
      body: <ModePicker picks={preferences} onChange={setPreferences} />,
    },
    {
      id: "theme",
      head: themes,
      lede: THEME_SECTION_WORDS.lede,
      items: [],
      search: [{ kind: "row", id: "theme", title: SETTINGS_WORDS.theme, description: THEME_SECTION_WORDS.lede }],
      body: <ThemePicker picks={preferences} onChange={setPreferences} />,
    },
    {
      id: "glass",
      head: GLASS_WORDS.head,
      lede: GLASS_WORDS.lede,
      items: [
        {
          kind: "row",
          id: "transparency",
          title: TRANSPARENCY_WORDS.title,
          description: TRANSPARENCY_WORDS.description,
          control: <Switch data-k="transparency" aria-label={TRANSPARENCY_WORDS.title} checked={preferences.transparency} onCheckedChange={transparency => setPreferences({ transparency })} />,
        },
      ],
    },
    {
      id: "fonts",
      head: FONT_WORDS.head,
      lede: FONT_WORDS.lede,
      body: <TypeSample />,
      items: [
        { kind: "row", id: "app-font", title: FONT_WORDS.app, description: FONT_WORDS.appDescription, control: <FontPicker id="app-font" label={FONT_WORDS.app} value={preferences.appFont} onChange={appFont => setPreferences({ appFont })} /> },
        { kind: "row", id: "text-size", title: FONT_WORDS.textSize, description: FONT_WORDS.textSizeDescription, control: <SizePicker id="text-size" label={FONT_WORDS.textSize} sizes={TEXT_SIZES} value={preferences.textSize} onChange={textSize => setPreferences({ textSize })} /> },
        { kind: "row", id: "code-font", title: FONT_WORDS.code, description: FONT_WORDS.codeDescription, control: <FontPicker id="code-font" label={FONT_WORDS.code} value={preferences.codeFont} onChange={codeFont => setPreferences({ codeFont })} /> },
        { kind: "row", id: "code-size", title: FONT_WORDS.codeSize, description: FONT_WORDS.codeSizeDescription, control: <SizePicker id="code-size" label={FONT_WORDS.codeSize} sizes={CODE_SIZES} value={preferences.codeSize} onChange={codeSize => setPreferences({ codeSize })} /> },
      ],
    },
  ];
}
