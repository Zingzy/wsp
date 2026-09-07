// SPDX-License-Identifier: AGPL-3.0-only
// Binary units with one decimal for the wizard, the engine's stage lines, the
// runtime's import events and the app; a turn's duration as the chat's footer,
// the notify line and the cut line print it, and its cost. The files that keep their own
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

/** How a duration reads: short is the chat footer's and the notify line's ("1.5s", "8m 12s"), clock is the cut
 * line's ("15m 00s", "1h 00m 00s"). */
export type DurationStyle = "short" | "clock";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The short style under a minute: ms under a second, tenths under ten, whole seconds after; nothing sensible is "0ms". */
function shortSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) {
    const tenths = Math.round(ms / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  return `${Math.round(ms / 1_000)}s`;
}

/** How long a turn ran. Short: ms under a second, tenths under ten, whole seconds under a minute, then minutes and
 * seconds. Clock: minutes and two-digit seconds, whole hours ahead once there are any. */
export function fmtDuration(ms: number, style: DurationStyle = "short"): string {
  if (style === "short" && (ms < 60_000 || !Number.isFinite(ms))) return shortSeconds(ms);
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1_000) : 0;
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (style === "short") return seconds === 0 ? `${hours * 60 + minutes}m` : `${hours * 60 + minutes}m ${seconds}s`;
  return hours === 0 ? `${minutes}m ${pad2(seconds)}s` : `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`;
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

/** A count with its noun, the noun pluralised by an s: the one rule every line that counts rows, sessions, calls,
 * threads or a plan's files reads, so none of them says "1 sessions". A noun that does not take an s is spelled by
 * its caller. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A thread count with its noun, as the sidebar's counts and the verbs' lines say it. */
export function fmtThreads(n: number): string {
  return plural(n, "thread");
}

/** What forgetting a workspace takes off this computer, the one sentence every client's confirmation shows. */
export function forgetNotice(threads: number): string {
  return `Its record and ${fmtThreads(threads)} leave this computer; the machine is already gone.`;
}

/** What deleting a workspace takes, the one sentence every client's confirmation shows: the machine goes at the
 * provider, the record and the threads go from here. */
export function deleteNotice(threads: number): string {
  return `Its machine is deleted at the provider; its record and ${fmtThreads(threads)} leave this computer.`;
}

/** A thread's title as every list shows it: the prompt's first non-empty line with its whitespace collapsed, so a
 * multi-paragraph brief is one row in the CLI's table and one line in the sidebar. */
export function titleLine(text: string): string {
  const first = text.split(/\r?\n/).find(l => l.trim().length > 0) ?? "";
  return first.replace(/\s+/g, " ").trim();
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
    ? `stopped after ${fmtDuration(elapsedMs, "clock")} with no output for ${fmtLimit(limitMs)}`
    : `stopped after ${fmtDuration(elapsedMs, "clock")} at the ${fmtLimit(limitMs)} cap on one turn`;
}

/** The turn's error when the harness process ended before any result. Exit 127 is the shell saying the binary was
 * not on PATH, so the line names the binary and the PATH the launch exported (or that it exported none) instead of a
 * bare code; every other code reads as the code. */
export function harnessExitLine(bin: string, exitCode: number | null, path: string | undefined): string {
  if (exitCode !== 127) return `${bin} exited with code ${String(exitCode)} before emitting a result`;
  const searched = path === undefined ? "the launch exported no PATH, the machine's own was searched" : `PATH searched: ${path}`;
  return `${bin} was not found on PATH (exit 127); ${searched}`;
}

/** The one stderr line the command line shows under a command that exited non-zero, naming the folder it ran in:
 * the host chose it when none was named, so the person did not see it go by; absent, the runtime ran it in ~. */
export function execFolderLine(cwd: string | undefined): string {
  return `ran in ${cwd ?? "the home folder"}`;
}

/** The one line every client shows on a start whose thread's previous turn was cut, before the new turn's output. */
export const AFTER_CUT_LINE = "previous turn was cut; resuming";

/** The one line a codex turn fails with when its provider wants an OpenAI login the machine has not got: the CLI
 * itself only retries the 401 and dies. `login` is the catalog's command for signing in on a machine. */
export function codexNotSignedInLine(login: string): string {
  return `Codex is not signed in on this machine; run ${login} there`;
}

/** The line when codex's provider reads its key from an environment variable the machine does not set. */
export function codexMissingEnvLine(name: string): string {
  return `Codex's model provider reads its key from the environment variable ${name}, which is not set on this machine`;
}

/** The line when codex kept reconnecting to its provider and nothing ever answered: the CLI itself never gives up. */
export function codexReconnectLine(elapsedMs: number): string {
  return `stopped after ${fmtDuration(elapsedMs, "clock")} of Codex reconnecting to its model provider with no answer`;
}

/** The machine row's line while the runtime replaces a daemon older than this wsp, and the line it shows instead
 * when the replacement failed. A person is never told the helper is called a daemon: they did not install it and
 * cannot run it, so its name would only be one more thing to know. Neither line carries the reason a deploy gave:
 * that is an npm log a person can do nothing with, hundreds of characters wide in a row that fits about thirty,
 * and it names the daemon in its own words. The runtime logs it for whoever runs the host. */
export const DAEMON_UPDATING = "updating the helper";
export const DAEMON_UPDATE_FAILED = "could not update the helper";

/** The machine row's line when a record that said paused met a machine the provider was running all along (a nap
 * whose pause never took, a resume nobody wrote): the record followed the fact and nothing was resumed. */
export const ALREADY_RUNNING = "already running at the provider";

/** One noun's change in a golden build line: "2 tools added". */
export interface GoldenChange {
  count: number;
  /** Singular; the line pluralises it. */
  noun: string;
  word: string;
}

/** The wizard's build line and the app's word for what a re-run does: which version it makes, the version it is
 * built on top of, and what it changes. `from` is 0 before any golden was sealed, and the line says so instead of
 * naming a version nothing was built on. */
export function goldenBuildLine(from: number, to: number, changes: readonly GoldenChange[]): string {
  const what = changes.filter(c => c.count > 0).map(c => `${plural(c.count, c.noun)} ${c.word}`);
  const head = from === 0 ? `Builds version ${to}` : `Builds version ${to} on top of version ${from}`;
  return what.length === 0 ? head : `${head}: ${what.join(", ")}`;
}

/** The app's line for a workspace still forked from an older golden version, offered the way the helper update is:
 * a state in words, never a badge. The move is the person's; nothing replaces a machine they are working on. */
export function behindGoldenLine(on: number, head: number): string {
  return `on image v${on}, v${head} available`;
}
