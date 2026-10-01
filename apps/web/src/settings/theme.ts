// SPDX-License-Identifier: AGPL-3.0-only
// The theme as the page draws it. The stylesheet has two sides, told apart by
// the dark class on the html element, and one sheet per theme, keyed on its
// data-theme; the preference picks a side, or leaves it to the computer, and
// each side draws the theme picked for it. One rule per value says which side
// it draws, and the desktop shell is told the value so its frame and glass
// draw the same side.
import type { Preferences, ThemePreference } from "@wsp/protocol";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { applyFonts } from "../appearanceFonts.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { useStore } from "../protocol/store.js";
import { themeFor } from "../themes/index.js";

/** Whether each value draws the dark side, given whether the computer does. */
const DRAWS_DARK: Record<ThemePreference, (systemDark: boolean) => boolean> = {
  system: systemDark => systemDark,
  light: () => false,
  dark: () => true,
};

export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/** What the page draws its theme from: the side's pick, and each side's theme. */
export type ThemePicks = Pick<Preferences, "theme" | "lightTheme" | "darkTheme">;

/** Sets the side and that side's theme together, with transitions held off for one frame: the stylesheet
 * transitions colours on cards and buttons, and a paint mid-way between two themes is what a switch would show
 * otherwise. */
export function applyTheme({ theme, lightTheme, darkTheme }: ThemePicks, systemDark: boolean): void {
  const dark = DRAWS_DARK[theme](systemDark);
  const html = document.documentElement;
  html.classList.add("no-transitions");
  html.classList.toggle("dark", dark);
  html.dataset["theme"] = dark ? themeFor("dark", darkTheme).id : themeFor("light", lightTheme).id;
  window.requestAnimationFrame(() => html.classList.remove("no-transitions"));
}

/** Mounted once: the html element follows the record's pick before the first paint and at once after, and as the
 * computer's own scheme changes where the pick is system; the desktop shell hears the value so the window's frame,
 * glass and traffic-light bar follow. The pick is a row in Settings, and system is its default, so no side can
 * strand a person where the app cannot read the computer's. */
export function useThemeEffect(): void {
  const theme = useStore(s => s.preferences.theme);
  const lightTheme = useStore(s => s.preferences.lightTheme);
  const darkTheme = useStore(s => s.preferences.darkTheme);
  const systemDark = useMediaQuery(SYSTEM_DARK_QUERY);
  useLayoutEffect(() => {
    applyTheme({ theme, lightTheme, darkTheme }, systemDark);
    desktopBridge()?.setTheme?.(theme);
  }, [theme, lightTheme, darkTheme, systemDark]);
}

/** The root's class while the page draws no glass: the stylesheet takes every glass to its solid ground. */
export const SOLID_CLASS = "solid";

/** The computer's Reduce transparency, as the page reads it. */
export const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

/** Whether the page draws glass: the record's Transparency on, and the computer not asking for less of it. */
export function useGlass(): boolean {
  const transparency = useStore(s => s.preferences.transparency);
  const reduced = useMediaQuery(REDUCED_TRANSPARENCY_QUERY);
  return transparency && !reduced;
}

/** Mounted once beside the theme: the root carries the solid class while the page draws no glass, and the desktop
 * shell hears it, so the window draws its own glass only under a page that draws glass. */
export function useTransparencyEffect(): void {
  const glass = useGlass();
  useLayoutEffect(() => {
    document.documentElement.classList.toggle(SOLID_CLASS, !glass);
    desktopBridge()?.setGlass?.(glass);
  }, [glass]);
}

/** Mounted once beside the theme: the root's app and code font tokens follow the record's picks. */
export function useFontEffect(): void {
  const appFont = useStore(s => s.preferences.appFont);
  const codeFont = useStore(s => s.preferences.codeFont);
  const textSize = useStore(s => s.preferences.textSize);
  const codeSize = useStore(s => s.preferences.codeSize);
  useLayoutEffect(() => applyFonts({ appFont, codeFont }), [appFont, codeFont]);
  useLayoutEffect(() => rootVariables(sizeVariables({ textSize, codeSize })), [textSize, codeSize]);
}

/** The variables a picked size sets, the conversation's text and the composer's for the reading size and every code
 * surface's for the code size; an unpicked one sets none, so each surface keeps its own size. */
export function sizeVariables({ textSize, codeSize }: Pick<Preferences, "textSize" | "codeSize">): Record<string, string | null> {
  const px = (n: number | undefined): string | null => (n === undefined ? null : `${n}px`);
  return { "--font-size-chat": px(textSize), "--font-size-prompt": px(textSize), "--font-size-code": px(codeSize), "--diffs-font-size": px(codeSize) };
}

/** Each variable set on the root, or taken off it where its value is null. */
function rootVariables(values: Record<string, string | null>): void {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(values)) {
    if (value === null) style.removeProperty(name);
    else style.setProperty(name, value);
  }
}

const subscribeToHtmlClass = (onChange: () => void): (() => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};
const readDark = (): boolean => document.documentElement.classList.contains("dark");

/** Which side the page is drawing right now, read off the html element the rule above flips: what a workspace theme
 * following the app needs to know to pick its ink. */
export function useAppDark(): boolean {
  return useSyncExternalStore(subscribeToHtmlClass, readDark, () => false);
}
