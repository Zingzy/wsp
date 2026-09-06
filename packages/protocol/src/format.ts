// SPDX-License-Identifier: AGPL-3.0-only
// The one way a byte count reads anywhere wsp prints one: the wizard, the
// engine's stage lines, the runtime's import events and the app.
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
