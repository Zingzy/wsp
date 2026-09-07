// SPDX-License-Identifier: AGPL-3.0-only
// The one place the person's Ghostty config meets the terminal surface: each
// key the host read is mapped onto the surface's options, and where the file
// set nothing the app's own value stands. The viewer's typed family beats the
// file's, since the card is the one choice the pane offers.
import type { TerminalConfig, TerminalRgb, TerminalScheme } from "@wsp/protocol";
import type { GhosttyCursorDefaults, GhosttyTheme } from "./ghostty/core";
import type { TerminalPadding } from "./ghostty/renderer";
import { DEFAULT_TERMINAL_PADDING, appTerminalFontSize, type GhosttyTerminalFont } from "./ghostty/surface";

export interface TerminalSurfaceSettings {
  readonly theme: GhosttyTheme;
  readonly font: GhosttyTerminalFont;
  readonly cursor?: GhosttyCursorDefaults;
  readonly padding: TerminalPadding;
  readonly backgroundOpacity: number;
}

const cssRgb = ({ r, g, b }: TerminalRgb): string => `rgb(${r}, ${g}, ${b})`;

/** The scheme the app is showing, which picks the side of a light:...,dark:... theme. */
export const appScheme = (): TerminalScheme => (document.documentElement.classList.contains("dark") ? "dark" : "light");

/** The file's colors over the app's theme; a palette with nothing set is left out so libghostty keeps its own. */
export function terminalThemeWith(file: TerminalConfig | null, app: GhosttyTheme): GhosttyTheme {
  if (file === null) return app;
  const palette = file.palette.some(slot => slot !== null) ? file.palette : undefined;
  return {
    background: file.background ?? app.background,
    foreground: file.foreground ?? app.foreground,
    cursor: file.cursorColor ?? app.cursor,
    ...(file.selectionBackground !== undefined ? { selectionBackground: cssRgb(file.selectionBackground) } : app.selectionBackground !== undefined ? { selectionBackground: app.selectionBackground } : {}),
    ...(palette !== undefined ? { palette } : {}),
  };
}

/** The face the pane draws with: the viewer's choice, else the file's family and fallbacks, else the viewport's own.
 * The size is the pane's, the app's own text size until the pane's zoom moves it; the file's size stays on the wire,
 * read by nothing here. */
export function terminalFontWith(file: TerminalConfig | null, viewport: GhosttyTerminalFont | undefined, chosen: boolean): GhosttyTerminalFont {
  const size = viewport?.size ?? appTerminalFontSize();
  const [family, ...fallbacks] = !chosen && file !== null ? file.fontFamily : [];
  const base: GhosttyTerminalFont | undefined = family !== undefined ? { family, ...(fallbacks.length > 0 ? { fallbacks } : {}) } : viewport;
  return { ...base, size };
}

export function terminalSurfaceSettings(file: TerminalConfig | null, app: GhosttyTheme, viewportFont: GhosttyTerminalFont | undefined, chosen: boolean): TerminalSurfaceSettings {
  const font = terminalFontWith(file, viewportFont, chosen);
  const cursor: GhosttyCursorDefaults = {
    ...(file?.cursorStyle !== undefined ? { style: file.cursorStyle } : {}),
    ...(file?.cursorStyleBlink !== undefined ? { blink: file.cursorStyleBlink } : {}),
  };
  return {
    theme: terminalThemeWith(file, app),
    font,
    ...(Object.keys(cursor).length > 0 ? { cursor } : {}),
    padding: {
      left: file?.windowPaddingX?.left ?? DEFAULT_TERMINAL_PADDING.left,
      right: file?.windowPaddingX?.right ?? DEFAULT_TERMINAL_PADDING.right,
      top: file?.windowPaddingY?.top ?? DEFAULT_TERMINAL_PADDING.top,
      bottom: file?.windowPaddingY?.bottom ?? DEFAULT_TERMINAL_PADDING.bottom,
    },
    backgroundOpacity: file?.backgroundOpacity ?? 1,
  };
}
