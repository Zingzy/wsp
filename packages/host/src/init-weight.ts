// SPDX-License-Identifier: AGPL-3.0-only
// Weight on the Tools and Agents screens: one set of thresholds colours a size
// column and the Disk line, and decides the tick a formula starts with. Hue on
// these screens means weight and nothing else.
import type { ManifestEntry } from "@wsp/collect";
import { toolSize, type BrewTable } from "@wsp/engine";
import type { Tone } from "./init-select.js";

const MIB = 1024 * 1024;
/** A formula this heavy starts unticked; its detail line says what a tick brings. */
export const HEAVY_BYTES = 500 * MIB;
const YELLOW_BYTES = 200 * MIB;
const RED_BYTES = 1024 * MIB;

/** The colour a size takes in its column: plain under 200 MB, then yellow, bright yellow from 500 MB, red from 1 GB. */
export function weightTone(bytes: number): Tone | undefined {
  if (bytes >= RED_BYTES) return "red";
  if (bytes >= HEAVY_BYTES) return "yellowBright";
  return bytes >= YELLOW_BYTES ? "yellow" : undefined;
}

/** The share of the room from which nothing advances: the screens hold Enter, a headless run refuses. */
export const DISK_HOLD_SHARE = 0.75;

/** The colour the Disk line takes against the room: plain under 50 percent, yellow from 50, bright yellow from 65,
 * red from 75, where nothing advances; the plan itself refuses to boot at 100. */
export function diskTone(total: number, room: number): Tone | undefined {
  const share = room > 0 ? total / room : 1;
  if (share >= DISK_HOLD_SHARE) return "red";
  if (share >= 0.65) return "yellowBright";
  return share >= 0.5 ? "yellow" : undefined;
}

/** The tools rows with a heavy formula turned off by default; a saved tick, a locked row and rows nothing sized stay as they are. */
export function weighed(entries: readonly ManifestEntry[], brew: BrewTable): ManifestEntry[] {
  return entries.map(e => {
    if (e.rung !== "tools" || e.default !== "bring") return e;
    const size = toolSize(e, brew);
    return size !== undefined && size.bytes >= HEAVY_BYTES ? { ...e, default: "skip" } : e;
  });
}
