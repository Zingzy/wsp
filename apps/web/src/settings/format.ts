// SPDX-License-Identifier: AGPL-3.0-only
// The words the settings page and its palette row say, one place, keyed by the
// preference value where a value has words of its own.
import { fmtPx, type TerminalSizeSource, type ThemePreference } from "@wsp/protocol";

/** The caps mono label over a section, and the muted mono a fact wears in a row's slot. Two class strings the page,
 * the table and the sheet all draw with, so one type ladder holds across the three files. */
export const ZONE_LABEL = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground";
export const FACT = "font-mono text-[11px] tabular-nums text-muted-foreground";

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
  about: "About",
  version: "Version",
} as const;

/** Both halves on the about row: the shell holding the page and the host that served it, which are one release run
 * together and two run apart. A browser tab has no shell of its own, so it shows the host's alone; a shell from
 * before the bridge carried a version has one this page cannot name. */
export function versionFact(app: string | undefined, host: string | undefined, inShell: boolean): string {
  const hostPart = `host ${host ?? "unknown"}`;
  return inShell ? `app ${app ?? "unknown"} · ${hostPart}` : hostPart;
}

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
