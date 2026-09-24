// SPDX-License-Identifier: AGPL-3.0-only
// Words the Workspace and Processes panes put next to wire values.

/** A time of day in the person's zone, hours and minutes. */
export const clockLabel = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const UNITS = ["", "K", "M", "G", "T"];

/** rss as a process table column with a three-digit budget fmtBytes does not fit, so its own rule: 900, 12K, 1.5M, 123M, 2.3G. */
export function compactBytes(n: number): string {
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i === 0 ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : String(Math.round(v));
  return `${text}${UNITS[i]}`;
}
