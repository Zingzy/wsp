// SPDX-License-Identifier: AGPL-3.0-only
// Weight on the Tools and Agents screens: one set of thresholds colours a size
// column and the Disk line, and decides the tick a formula starts with. Hue on
// these screens means weight and nothing else.
import type { ManifestEntry } from "@wsp/collect";
import { BUILDER_DISK_GB, toolSize, type BrewTable, type DiskEstimate } from "@wsp/engine";
import { fmtBytes } from "@wsp/protocol";
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

/** The estimate's parts that are not zero, and how many rows have no size. */
export function diskParts(est: DiskEstimate): string {
  const parts = ([["files", est.files], ["Homebrew's toolchain", est.toolchain], ["tools", est.tools], ["agents", est.agents]] as const).filter(([, n]) => n > 0).map(([label, n]) => `${label} ${fmtBytes(n)}`);
  const unknown = est.unknown.length > 0 ? `${est.unknown.length} unmeasured, ~${fmtBytes(est.assumed)}` : "";
  return [parts.join(", "), unknown].filter(p => p !== "").join("; ");
}

/** The total against the room the builder's disk leaves. */
export function diskHead(est: DiskEstimate): string {
  return est.over > 0 ? `${fmtBytes(est.total)}, ${fmtBytes(est.over)} over the ${fmtBytes(est.room)} the ${BUILDER_DISK_GB} GB builder leaves` : `${fmtBytes(est.total)} of ${fmtBytes(est.room)} on the ${BUILDER_DISK_GB} GB builder`;
}

/** The summary's line: the total, then the parts in brackets. */
export function diskLine(est: DiskEstimate): string {
  const parts = diskParts(est);
  return parts === "" ? diskHead(est) : `${diskHead(est)} (${parts})`;
}
