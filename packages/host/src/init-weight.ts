// SPDX-License-Identifier: AGPL-3.0-only
// The Disk line under the wizard's screens and on the summary card, and the
// colour a single row's size takes: one set of thresholds each, in one place.
// Hue here means weight and nothing else.
import { MIB } from "@wsp/catalog";
import { BUILDER_DISK_GB, type DiskEstimate } from "@wsp/engine";
import { fmtBytes } from "@wsp/protocol";
import type { Tone } from "./init-select.js";

/** The colour the Disk line takes against the room: plain under 50 percent, yellow from 50, bright yellow from 65,
 * red from 75; the plan itself refuses to boot at 100. */
export function diskTone(total: number, room: number): Tone | undefined {
  const share = room > 0 ? total / room : 1;
  if (share >= 0.75) return "red";
  if (share >= 0.65) return "yellowBright";
  return share >= 0.5 ? "yellow" : undefined;
}

/** A row this size is worth a word with the person before it goes on the image. */
export const HEAVY_BYTES = 300 * MIB;

/** The colour a row's own size takes on a list: the same three tiers as the Disk line, read in bytes. Nothing
 * under the heavy line, then yellow, orange from 500 MB, red past a gigabyte. */
export function sizeTone(bytes: number | undefined): Tone | undefined {
  if (bytes === undefined) return undefined;
  if (bytes >= 1024 * MIB) return "red";
  if (bytes >= 500 * MIB) return "yellowBright";
  return bytes >= HEAVY_BYTES ? "yellow" : undefined;
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

/** The Disk line: the total, then the parts in brackets. */
export function diskLine(est: DiskEstimate): string {
  const parts = diskParts(est);
  return parts === "" ? diskHead(est) : `${diskHead(est)} (${parts})`;
}
