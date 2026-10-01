// SPDX-License-Identifier: AGPL-3.0-only
// The theme as a side and a pick on that side. Three tiles write the side, each
// a small wsp window drawn in the theme that side shows; under them one card per
// registered theme of the side shown, each drawn in its own tokens by carrying
// the theme's mark, so no hex is written twice. A pointer over a card shows that
// theme in the real window and leaving the cards puts the pick back. System shows
// the side this computer is on now.
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { PreferencesPatch, ThemePreference } from "@wsp/protocol";
import { useEffect, useRef } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { cn } from "../lib/utils.js";
import { THEMES, themeFor, type Theme, type ThemeSide } from "../themes/index.js";
import { SETTINGS_WORDS, THEME_WORDS } from "./format.js";
import { CARD_SURFACE } from "./rows.js";
import { applyTheme, SYSTEM_DARK_QUERY, type ThemePicks } from "./theme.js";

const MODES = ["system", "light", "dark"] as const satisfies readonly ThemePreference[];

const PICK_FIELD = { light: "lightTheme", dark: "darkTheme" } as const satisfies Record<ThemeSide, keyof ThemePicks>;

const HAIRLINE = { strokeWidth: 1, vectorEffect: "non-scaling-stroke" } as const;

/** A wsp window drawn small in one theme: the sidebar with its rows and the one picked, the person's message, a reply
 * of a strong line and three quiet ones, and the composer with the theme's accent on its send. */
export function WindowPicture({ theme }: { theme: Theme }) {
  return (
    <svg data-theme={theme.id} viewBox="0 0 200 125" preserveAspectRatio="xMidYMid slice" aria-hidden className="block size-full">
      <rect data-part="ground" width="200" height="125" className="fill-background" />
      <rect data-part="sidebar" width="52" height="125" className="fill-sidebar" />
      <line x1="52.5" y1="0" x2="52.5" y2="125" className="stroke-border" {...HAIRLINE} />
      <rect x="6" y="21" width="40" height="11" rx="3" className="fill-sidebar-foreground/10" />
      {[16, 27, 38, 49].map((y, at) => (
        <rect key={y} x="10" y={y} width={[24, 30, 20, 26][at]} height="3" rx="1.5" className={at === 1 ? "fill-sidebar-foreground/80" : "fill-sidebar-muted-foreground/50"} />
      ))}
      <rect data-part="message" x="128" y="12" width="62" height="13" rx="6.5" className="fill-message" />
      <rect x="64" y="38" width="108" height="4" rx="2" className="fill-foreground/80" />
      {[48, 57, 66].map((y, at) => (
        <rect key={y} x="64" y={y} width={[96, 104, 70][at]} height="3.5" rx="1.75" className="fill-muted-foreground/60" />
      ))}
      <rect data-part="composer" x="62.5" y="92.5" width="127" height="22" rx="11" className="fill-card stroke-border" {...HAIRLINE} />
      <rect x="73" y="102" width="44" height="3.5" rx="1.75" className="fill-muted-foreground/50" />
      <circle data-part="accent" cx="178" cy="103.5" r="6" className="fill-primary" />
    </svg>
  );
}

const RING = "ring-offset-2 ring-offset-background transition-[box-shadow,border-color] duration-150";
const PICKED = "ring-2 ring-primary";
/** An unpicked tile or card under the pointer: its edge a step up, the same on both grids. */
const HOVER = "group-hover:border-foreground/20";
const FOCUS = "group-focus-visible:ring-2 group-focus-visible:ring-ring";

/** One side tile: its window in the theme that side draws; System's halves are each side's, cut on a slant. */
function ModeTile({ mode, picks }: { mode: ThemePreference; picks: ThemePicks }) {
  const light = themeFor("light", picks.lightTheme);
  const dark = themeFor("dark", picks.darkTheme);
  const chosen = picks.theme === mode;
  return (
    <RadioPrimitive.Root value={mode} data-theme-mode={mode} className="group flex min-w-0 cursor-pointer flex-col gap-2 outline-none">
      <span className={cn(CARD_SURFACE, "relative block aspect-[16/10] w-full", RING, chosen ? PICKED : HOVER, FOCUS)}>
        <WindowPicture theme={mode === "dark" ? dark : light} />
        {mode === "system" ? (
          <span className="absolute inset-0 [clip-path:polygon(60%_0,100%_0,100%_100%,40%_100%)]">
            <WindowPicture theme={dark} />
          </span>
        ) : null}
      </span>
      <span className={cn("text-[13px] leading-4 transition-colors duration-150", chosen ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>{THEME_WORDS[mode]}</span>
    </RadioPrimitive.Root>
  );
}

/** One theme as a card: its window in its own tokens over its name and what it is like. */
function ThemeCard({ theme, chosen, onPreview }: { theme: Theme; chosen: boolean; onPreview: (theme: Theme) => void }) {
  return (
    <RadioPrimitive.Root
      value={theme.id}
      data-theme-option={theme.id}
      onPointerEnter={() => onPreview(theme)}
      className={cn(CARD_SURFACE, "group flex min-w-0 cursor-pointer flex-col text-left outline-none", RING, chosen ? PICKED : HOVER, "focus-visible:ring-2 focus-visible:ring-ring")}
    >
      <span className="block aspect-[16/10] w-full border-b border-border">
        <WindowPicture theme={theme} />
      </span>
      <span className="flex flex-col gap-1 px-3 py-2.5">
        <span className="text-[13px] leading-4 font-medium text-foreground">{theme.word}</span>
        <span data-theme-line className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
          {theme.line}
        </span>
      </span>
    </RadioPrimitive.Root>
  );
}

export function ThemePicker({ picks, onChange }: { picks: ThemePicks; onChange: (patch: PreferencesPatch) => void }) {
  const systemDark = useMediaQuery(SYSTEM_DARK_QUERY);
  const shown: ThemeSide = picks.theme === "system" ? (systemDark ? "dark" : "light") : picks.theme;
  const field = PICK_FIELD[shown];
  // The window back on the picks while a preview stands: the pointer leaving the cards, the window losing focus or the
  // pointer under a card, and the page going.
  const previewing = useRef(false);
  const restore = useRef(() => {});
  restore.current = () => {
    if (!previewing.current) return;
    previewing.current = false;
    applyTheme(picks, systemDark);
  };
  useEffect(() => {
    const back = (): void => restore.current();
    window.addEventListener("blur", back);
    window.addEventListener("pointercancel", back);
    return () => {
      window.removeEventListener("blur", back);
      window.removeEventListener("pointercancel", back);
      back();
    };
  }, []);
  const preview = (theme: Theme): void => {
    previewing.current = true;
    const html = document.documentElement;
    html.classList.add("no-transitions");
    html.dataset["theme"] = theme.id;
    window.requestAnimationFrame(() => html.classList.remove("no-transitions"));
  };
  return (
    <div data-k="theme-picker" className="flex flex-col gap-6">
      <RadioGroupPrimitive aria-label={SETTINGS_WORDS.theme} value={picks.theme} onValueChange={theme => onChange({ theme: theme as ThemePreference })} className="grid grid-cols-3 gap-4 max-sm:gap-2">
        {MODES.map(mode => (
          <ModeTile key={mode} mode={mode} picks={picks} />
        ))}
      </RadioGroupPrimitive>
      <RadioGroupPrimitive
        aria-label={SETTINGS_WORDS.themesOf(THEME_WORDS[shown])}
        value={picks[field]}
        onValueChange={id => onChange({ [field]: id })}
        onPointerLeave={() => restore.current()}
        className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3 max-sm:grid-cols-2 max-sm:gap-2"
      >
        {THEMES.filter(t => t.side === shown).map(theme => (
          <ThemeCard key={theme.id} theme={theme} chosen={theme.id === picks[field]} onPreview={preview} />
        ))}
      </RadioGroupPrimitive>
    </div>
  );
}
