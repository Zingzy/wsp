// SPDX-License-Identifier: AGPL-3.0-only
// In the desktop shell the main process reads the computer's font files for a
// family and hands them here; each is registered under the family the file
// names so the canvas can draw with the person's own face and its Nerd Font
// variant. A browser tab has no such bridge and resolves names on its own.
import type { DesktopBridge } from "@wsp/protocol";

declare global {
  interface Window {
    wsp?: Partial<DesktopBridge>;
  }
}

const pending = new Map<string, Promise<string[]>>();
const registered = new Map<string, string[]>();

/** The installed families registered for a requested family so far; empty until registerLocalFonts settles. */
export function localFontFamilies(family: string | undefined): string[] {
  return family === undefined ? [] : (registered.get(family) ?? []);
}

/** Registers the computer's faces for a family once per page and answers with their family names, in the shell's order. */
export function registerLocalFonts(
  family: string | undefined,
  bridge: Partial<DesktopBridge> | undefined = typeof window === "undefined" ? undefined : window.wsp,
): Promise<string[]> {
  if (family === undefined || family.trim().length === 0 || bridge?.localFonts === undefined) return Promise.resolve([]);
  const have = pending.get(family);
  if (have !== undefined) return have;
  const localFonts = bridge.localFonts;
  const load = (async (): Promise<string[]> => {
    const families: string[] = [];
    try {
      for (const face of await localFonts(family)) {
        const fontFace = new FontFace(face.family, face.data, { weight: String(face.weight), style: face.style });
        document.fonts.add(await fontFace.load());
        if (!families.includes(face.family)) families.push(face.family);
      }
    } catch {
      // Whatever registered before the failure still serves; the chain's own names cover the rest.
    }
    registered.set(family, families);
    return families;
  })();
  pending.set(family, load);
  return load;
}
