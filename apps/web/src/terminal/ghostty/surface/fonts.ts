// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/terminal/ghostty/surface.ts at 57a66608 (MIT).
import symbolsFontUrl from "../fonts/SymbolsNerdFontMono-Regular.woff2?url";
import { cssFontFamilies, isMonospaceFamily } from "../../../appearanceFonts";
import { TERMINAL_SYMBOLS_FACE, terminalFontChain } from "../fontChain";
import { localFontFamilies, registerLocalFonts } from "../localFonts";

const TERMINAL_FONT_SIZE_TOKEN = "--font-size-terminal";
/** The number that token names, for a page whose stylesheet has not landed; the two must stay one size. */
const TERMINAL_FONT_SIZE_FALLBACK = 14;
const MIN_TERMINAL_FONT_SIZE = 6;
const MAX_TERMINAL_FONT_SIZE = 32;
export const DEFAULT_TERMINAL_FONT_FAMILY = terminalFontChain(undefined);
const TERMINAL_FONT_LOAD_TEXT = "iMW0@# .";
const TERMINAL_FONT_LOAD_VARIANTS = [
  "normal 400",
  "normal 700",
  "italic 400",
  "italic 700",
] as const;

/** Requested terminal font; omitted fields fall back to the defaults. */
export interface GhosttyTerminalFont {
  readonly family?: string;
  /** Faces tried after the family, in order, as a config's later font-family lines name them. */
  readonly fallbacks?: readonly string[];
  readonly size?: number;
}

let symbolsFontLoad: Promise<void> | null = null;

/**
 * Register the bundled symbols-only Nerd Font once per page. It loads lazily
 * with the first terminal, and because it carries no regular text glyphs it
 * composes with any text face without changing metrics: prompt symbols and
 * devicons render even on machines without a locally installed Nerd Font.
 */
export function ensureTerminalSymbolsFont(): Promise<void> {
  if (symbolsFontLoad !== null) return symbolsFontLoad;
  symbolsFontLoad = (async () => {
    try {
      const face = new FontFace(TERMINAL_SYMBOLS_FACE, `url(${symbolsFontUrl})`);
      document.fonts.add(await face.load());
    } catch {
      // Locally installed fallback faces still apply.
    }
  })();
  return symbolsFontLoad;
}

/** The installed faces registered for the family and each fallback, in that order. */
function localFaces(family: string | undefined, fallbacks: readonly string[]): string[] {
  return [family, ...fallbacks].flatMap(name => localFontFamilies(name));
}

function uncheckedTerminalFontFamily(family?: string, fallbacks: readonly string[] = []): string {
  const custom = family === undefined ? null : cssFontFamilies(family);
  return custom === null ? DEFAULT_TERMINAL_FONT_FAMILY : terminalFontChain(custom, [...fallbacks, ...localFaces(family, fallbacks)]);
}

export function terminalFontFamily(family?: string, fallbacks: readonly string[] = []): string {
  // Quote non-ident names ("3270 Nerd Font", "M+ 1m"): an unquoted one makes
  // the whole canvas font string invalid and the assignment silently no-ops.
  const custom = family === undefined ? null : cssFontFamilies(family);
  if (custom === null) return DEFAULT_TERMINAL_FONT_FAMILY;
  // The grid places the cursor and selection on one cell advance, so a
  // proportional face would draw its text narrower than its own cells. Refuse
  // it here rather than render a ragged grid with a stranded cursor.
  if (!isMonospaceFamily(custom)) return DEFAULT_TERMINAL_FONT_FAMILY;
  return uncheckedTerminalFontFamily(family, fallbacks);
}

/** Register the computer's faces for the family and its fallbacks, load every style the renderer can request, then validate the actual face. */
export async function loadTerminalFontFamily(
  family: string | undefined,
  size: number,
  environment?: {
    readonly load: (font: string, text: string) => Promise<unknown>;
    readonly resolve: (family: string | undefined, fallbacks: readonly string[]) => string;
  },
  fallbacks: readonly string[] = [],
): Promise<string> {
  await Promise.all([family, ...fallbacks].map(name => registerLocalFonts(name)));
  const candidate = uncheckedTerminalFontFamily(family, fallbacks);
  const load =
    environment?.load ?? ((font: string, text: string) => document.fonts.load(font, text));
  try {
    await Promise.all(
      TERMINAL_FONT_LOAD_VARIANTS.map((variant) =>
        load(`${variant} ${size}px ${candidate}`, TERMINAL_FONT_LOAD_TEXT),
      ),
    );
  } catch {
    // The fixed-width fallback stack remains available if a face cannot load.
  }
  return (environment?.resolve ?? terminalFontFamily)(family, fallbacks);
}

/** The size a pane draws at with nothing else asked for: the app's own text size, from the type scale in index.css. */
export function appTerminalFontSize(): number {
  if (typeof document === "undefined") return TERMINAL_FONT_SIZE_FALLBACK;
  const named = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(TERMINAL_FONT_SIZE_TOKEN));
  return Number.isFinite(named) ? named : TERMINAL_FONT_SIZE_FALLBACK;
}

export function terminalFontSize(size?: number): number {
  if (size === undefined || !Number.isFinite(size)) return appTerminalFontSize();
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(size)));
}
