// SPDX-License-Identifier: AGPL-3.0-only
// The theme as the page draws it. The stylesheet has two sides, told apart by
// the dark class on the html element; the preference picks a side, or leaves
// it to the computer. One rule per value says which side it draws, and the
// desktop shell is told the value so its frame and glass draw the same side.
import type { ThemePreference } from "@wsp/protocol";
import { useEffect } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { useStore } from "../protocol/store.js";

/** Whether each value draws the dark side, given whether the computer does. */
const DRAWS_DARK: Record<ThemePreference, (systemDark: boolean) => boolean> = {
  system: systemDark => systemDark,
  light: () => false,
  dark: () => true,
};

export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/** Flips the side with transitions held off for one frame: the stylesheet transitions colours on cards and buttons,
 * and a paint mid-way between the sides is what a switch would show otherwise. */
export function applyTheme(theme: ThemePreference, systemDark: boolean): void {
  const html = document.documentElement;
  html.classList.add("no-transitions");
  html.classList.toggle("dark", DRAWS_DARK[theme](systemDark));
  window.requestAnimationFrame(() => html.classList.remove("no-transitions"));
}

/** Mounted once under the store: the html element follows the preference at once, and under system the computer's own
 * scheme as it changes; the desktop shell hears the value so the window's frame, glass and traffic-light bar follow. */
export function useThemeEffect(): void {
  const theme = useStore(s => s.preferences.theme);
  const systemDark = useMediaQuery(SYSTEM_DARK_QUERY);
  useEffect(() => {
    applyTheme(theme, systemDark);
    desktopBridge()?.setTheme?.(theme);
  }, [theme, systemDark]);
}
