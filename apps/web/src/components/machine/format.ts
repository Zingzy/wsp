// SPDX-License-Identifier: AGPL-3.0-only
// Words the machine surface puts next to wire values; the state word itself is
// the protocol's, read from the same fold every other surface reads.

/** The rate rows and the chart's own axis ticks, which need places a spend figure does not: what a person reads as
 * a spend goes through the protocol's fmtCost, the one shape every surface shows a figure in. */
export const money = (n: number, digits = 4): string => `$${n.toFixed(digits)}`;

/** A tick's wall-clock time in the person's zone, hours and minutes. */
export const clockLabel = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function durationLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** idleAt is absent while napping, while a session holds the machine awake, or with auto-nap off; the wire does not say which. */
export function idleLabel(idleAt: number | undefined, now: number): string {
  if (idleAt === undefined) return "not scheduled";
  const left = idleAt - now;
  return left <= 0 ? "napping now" : `naps in ${durationLabel(left)}`;
}

export const percentLabel = (n: number): string => `${Math.round(n)}%`;

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
