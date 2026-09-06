// SPDX-License-Identifier: AGPL-3.0-only
// Binary units with one decimal for the wizard, the engine's stage lines, the
// runtime's import events and the app. The files that keep their own rule are
// the exception list in the protocol format test, each with its reason.
const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** Whole bytes under a kilobyte, then one decimal in binary units up to GB. */
export function fmtBytes(n: number): string {
  if (n < KIB) return `${n} B`;
  if (n < MIB) return `${(n / KIB).toFixed(1)} KB`;
  if (n < GIB) return `${(n / MIB).toFixed(1)} MB`;
  return `${(n / GIB).toFixed(1)} GB`;
}

/** A machine size's memory in GB as the size table names it: whole when whole, else one decimal; a size spec, not a byte count. */
export function fmtMemGb(memMb: number): string {
  return `${Number((memMb / 1024).toFixed(1))} GB`;
}
