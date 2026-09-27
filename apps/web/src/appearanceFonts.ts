// Adapted from pingdotgg/t3code apps/web/src/appearanceFonts.ts at 57a66608 (MIT).
// The family quoting, the monospace probe the terminal surface needs, and the
// app and code fonts laid on the root's two font tokens.

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  // Already quoted, or a single ident that needs no quoting.
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replace(/["\\]/g, "")}"`;
}

export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

let fontProbeContext: CanvasRenderingContext2D | null | undefined;

const MONOSPACE_PROBE_VARIANTS = ["normal 400", "normal 700", "italic 400", "italic 700"] as const;
const MONOSPACE_PROBE_GLYPHS = ["i", "M", "W", "0", "@", "#", ".", " "] as const;
const MONOSPACE_ADVANCE_TOLERANCE = 0.01;

export function areFontAdvancesMonospace(advances: readonly number[]): boolean {
  const reference = advances[0];
  if (
    reference === undefined ||
    reference <= 0 ||
    advances.some((advance) => !Number.isFinite(advance) || advance <= 0)
  ) {
    return true;
  }
  return advances.every((advance) => Math.abs(advance - reference) < MONOSPACE_ADVANCE_TOLERANCE);
}

/**
 * Whether a family renders every character on the same advance. Cell-grid
 * surfaces (the terminal) require this: a proportional face draws its text
 * narrower than the lattice the cursor and selection are placed on, which
 * reads as ragged gaps and a cursor stranded to the right of the text.
 *
 * Unmeasurable environments answer true, so a missing canvas never blocks a
 * legitimate font.
 */
export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return true;
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement("canvas").getContext("2d");
    }
    if (fontProbeContext === null) return true;
    const context = fontProbeContext;
    // Fall back to a generic mono so an absent face measures as monospace and
    // is left for the normal fallback chain to resolve.
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${families}, monospace`;
      const advances = MONOSPACE_PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width);
      if (!areFontAdvancesMonospace(advances)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

/** The two font tokens as the record's picks set them on the root: the family in front of the token's system stack,
 * or the token left to the stylesheet for none. The terminal draws with its own chain and reads neither. */
export function applyFonts(picks: { readonly appFont: string; readonly codeFont: string }, root: HTMLElement = document.documentElement): void {
  for (const [token, family] of [["--font-sans", picks.appFont], ["--font-mono", picks.codeFont]] as const) {
    const chosen = cssFontFamilies(family);
    if (chosen === null) root.style.removeProperty(token);
    else root.style.setProperty(token, `${chosen}, var(${token}-system)`);
  }
}
