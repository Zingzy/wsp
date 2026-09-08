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
  sidebarWidthDefault: "default",
  reset: "Reset",
  terminal: "Terminal",
  textSize: "Text size",
} as const;

/** Each theme as its row names it: the word, and the sentence under the one that does not say it all. */
export const THEME_WORDS: Record<ThemePreference, { readonly title: string; readonly detail?: string }> = {
  system: { title: "System", detail: "Follows this computer" },
  light: { title: "Light" },
  dark: { title: "Dark" },
};

/** Each size source as its row names it. */
export const TERMINAL_SIZE_WORDS: Record<TerminalSizeSource, string> = {
  app: "From the app",
  file: "From the Ghostty file",
};

/** The size each source hands the pane, as the fact beside its row: the app's own size, or the file's, which is the
 * app's again for a file that names none. */
export const TERMINAL_SIZE_FACT: Record<TerminalSizeSource, (appPx: number, filePx: number | undefined) => string> = {
  app: appPx => fmtPx(appPx),
  file: (appPx, filePx) => (filePx === undefined ? `${fmtPx(appPx)}, the file names no size` : fmtPx(filePx)),
};
