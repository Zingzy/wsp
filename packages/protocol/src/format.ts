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

/** Minutes and two-digit seconds, with whole hours ahead when there are any: how long a turn ran. */
export function fmtElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  const sec = `${String(s % 60).padStart(2, "0")}s`;
  return s < 3600 ? `${Math.floor(s / 60)}m ${sec}` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m ${sec}`;
}

/** A limit as one unit: whole hours when it is hours, else whole minutes. */
function fmtLimit(ms: number): string {
  return ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`;
}

/** Which rule ended a turn: idle is no byte from the harness for the limit, wall is the cap on one turn's run. */
export type TurnCutRule = "idle" | "wall";

/** The one line every client shows for a turn the runtime cut: which rule, how long the turn ran, the limit. */
export function turnCutLine(rule: TurnCutRule, elapsedMs: number, limitMs: number): string {
  return rule === "idle"
    ? `stopped after ${fmtElapsed(elapsedMs)} with no output for ${fmtLimit(limitMs)}`
    : `stopped after ${fmtElapsed(elapsedMs)} at the ${fmtLimit(limitMs)} cap on one turn`;
}
