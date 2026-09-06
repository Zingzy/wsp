// SPDX-License-Identifier: AGPL-3.0-only
// Binary units with one decimal for the wizard, the engine's stage lines, the
// runtime's import events and the app; a turn's duration and cost as the
// chat's footer and the notify line print them. The files that keep their own
// rule are the exception list in the protocol format test, each with its reason.
import type { TurnResult } from "./index.js";
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

/** A turn's wall time: ms under a second, tenths under ten, whole seconds under a minute, then minutes and seconds. */
export function fmtDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

/** A turn's cost in dollars: cents, or four places under a cent so a short turn does not read as free. */
export function fmtCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** The one line a thread's end sends to whoever its start named: the thread's first eight characters, the outcome
 * word with the duration and cost the harness reported, and the last non-empty line of the reply, or the error when
 * there is no reply. */
export function notifyLine(threadId: string, result: TurnResult): string {
  const facts = [result.status, ...(result.durationMs !== undefined ? [fmtDuration(result.durationMs)] : []), ...(result.costUsd !== undefined ? [fmtCost(result.costUsd)] : [])];
  const lines = (result.text ?? "").split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const tail = lines.at(-1) ?? result.error;
  return `thread ${threadId.slice(0, 8)} finished (${facts.join(", ")})${tail !== undefined ? `: ${tail}` : ""}`;
}

/** A thread count with its noun, as the sidebar's counts and the verbs' lines say it. */
export function fmtThreads(n: number): string {
  return `${n} ${n === 1 ? "thread" : "threads"}`;
}

/** What forgetting a workspace takes off this computer, the one sentence every client's confirmation shows. */
export function forgetNotice(threads: number): string {
  return `Its record and ${fmtThreads(threads)} leave this computer; the machine is already gone.`;
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
