// SPDX-License-Identifier: AGPL-3.0-only
// The words the settings page and its palette row say, one place, keyed by the
// preference value where a value has words of its own.
import { fmtPx, type TerminalSizeSource, type ThemePreference } from "@wsp/protocol";

export const SETTINGS_WORDS = {
  title: "Settings",
  hint: "Theme, sidebar and terminal",
  appearance: "Appearance",
  theme: "Theme",
  sidebar: "Sidebar",
  sidebarWidth: "Sidebar width",
  reset: "Reset",
  terminal: "Terminal",
  textSize: "Text size",
} as const;

/** Each theme as its segment names it. */
export const THEME_WORDS: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" };

/** Each size source as its segment names it. */
export const TERMINAL_SIZE_WORDS: Record<TerminalSizeSource, string> = {
  app: "From the app",
  file: "From the Ghostty file",
};

/** The size the picked source hands the pane, as the fact beside the control: the app's own size, or the file's,
 * which is the app's again for a file that names none. */
export const TERMINAL_SIZE_FACT: Record<TerminalSizeSource, (appPx: number, filePx: number | undefined) => string> = {
  app: appPx => fmtPx(appPx),
  file: (appPx, filePx) => fmtPx(filePx ?? appPx),
};
