// SPDX-License-Identifier: AGPL-3.0-only
import type { ProviderMark } from "./provider.js";

/** Solari publishes its mark only as a raster, a lit sphere crossed by an arc; this is that shape as an outline at
 * the 2px stroke of the glyphs it stands beside. */
export const SOLARI: ProviderMark = {
  id: "solari",
  provider: "solari",
  source: "https://getsolari.com (read 2026-09-28, traced from its favicon)",
  license: "Solari's trademark, drawn to name its service",
  svg: `<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M19.97 11.27A8 8 0 0 1 9.07 19.45M4.97 15.82A8 8 0 0 1 17.63 6.32M2 19C9 18.5 16 13.5 22 5"/></svg>`,
};
