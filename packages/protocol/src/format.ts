// SPDX-License-Identifier: AGPL-3.0-only
// Binary units with one decimal for the wizard, the engine's stage lines, the
// runtime's import events and the app; a turn's duration as the chat's footer,
// the notify line and the cut line print it, and its cost. The files that keep their own
// rule are the exception list in the protocol format test, each with its reason.
import type { MachineState, TurnResult } from "./index.js";
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

/** A running clock on a row redrawn every tick: whole seconds, then the short style's minutes and seconds; tenths
 * would flicker. */
export function fmtElapsed(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1_000) : 0;
  return seconds < 60 ? `${seconds}s` : fmtDuration(seconds * 1_000);
}

/** A turn's cost in dollars: cents, or four places under a cent so a short turn does not read as free. */
export function fmtCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** The one line a thread's end sends to whoever its start named: the thread's first eight characters, the outcome
 * word with the duration and cost the harness reported, then the last non-empty line of the reply, or the error when
 * there is no reply. A turn that did not complete says its error first, since that is what whoever waits needs. */
export function notifyLine(threadId: string, result: TurnResult): string {
  const facts = [result.status, ...(result.durationMs !== undefined ? [fmtDuration(result.durationMs)] : []), ...(result.costUsd !== undefined ? [fmtCost(result.costUsd)] : [])];
  const lines = (result.text ?? "").split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const tail = result.status === "completed" ? lines.at(-1) ?? result.error : result.error ?? lines.at(-1);
  return `thread ${threadId.slice(0, 8)} finished (${facts.join(", ")})${tail !== undefined ? `: ${tail}` : ""}`;
}

/** What a settled turn says beside its outcome word, in the order every client shows it: how long it worked, then
 * what it cost. The app's chat footer and the command line's last line read from this one list. */
export function turnSettledParts(turn: { durationMs?: number | null; costUsd?: number | null }): string[] {
  const parts: string[] = [];
  if (typeof turn.durationMs === "number") parts.push(`Worked for ${fmtDuration(turn.durationMs)}`);
  if (typeof turn.costUsd === "number") parts.push(fmtCost(turn.costUsd));
  return parts;
}

/** The chat footer as one line, for a stream that has no footer: the outcome word, then what it worked and cost. */
export function turnSettledLine(result: TurnResult): string {
  return [result.status, ...turnSettledParts(result)].join(" · ");
}

/** One tool call's input, as the wire's delta carries it: the JSON the harness reported, already parsed. */
type ToolInput = Readonly<Record<string, unknown>>;

/** The line one tool name reads as; undefined when the call's input does not carry what the line needs. */
type ToolLine = (input: ToolInput) => string | undefined;

/** What kind of item a call is to a client that groups its rows by kind, in the words the app's transcript uses. */
export type ToolItemType = "command_execution" | "file_change" | "web_search" | "collab_agent_tool_call" | "mcp_tool_call";

/** What a call asks of the machine, for the client that puts the ask to a person. */
export type ToolRequestKind = "command" | "file-read" | "file-change";

/** One tool's row: the line its call reads as, the input field a client shows for it, what kind of item the call is,
 * the paths it changed when it changes any, and whether it looked through the code. */
interface ToolRow {
  readonly line: ToolLine;
  readonly shows: readonly string[];
  readonly itemType?: ToolItemType;
  readonly requestKind?: ToolRequestKind;
  readonly paths?: (input: ToolInput) => readonly string[];
  readonly codeSearch?: boolean;
}

function toolField(input: ToolInput, name: string): string | undefined {
  const value = input[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function firstField(input: ToolInput, fields: readonly string[]): string | undefined {
  return fields.map(name => toolField(input, name)).find(value => value !== undefined);
}

const shellRow: ToolRow = {
  line: input => {
    const command = toolField(input, "command");
    return command === undefined ? undefined : `$ ${titleLine(command)}`;
  },
  shows: ["description"],
  itemType: "command_execution",
  requestKind: "command",
};

const pathRow = (verb: string, field: string, requestKind: ToolRequestKind): ToolRow => ({
  line: input => {
    const path = toolField(input, field);
    return path === undefined ? undefined : `${verb} ${path}`;
  },
  shows: [field],
  requestKind,
  ...(requestKind === "file-change"
    ? { itemType: "file_change" as const, paths: (input: ToolInput) => { const path = toolField(input, field); return path === undefined ? [] : [path]; } }
    : {}),
});

const aboutRow = (verb: string, field: string, rest: Omit<ToolRow, "line" | "shows"> = {}): ToolRow => ({
  line: input => {
    const what = toolField(input, field);
    return what === undefined ? undefined : `${verb} ${titleLine(what)}`;
  },
  shows: [field],
  ...rest,
});

/** Codex reports every path one call touched in a single change item; Claude reports one path per call. */
function changedPaths(input: ToolInput): readonly string[] {
  const changes = input["changes"];
  if (!Array.isArray(changes)) return [];
  return changes.flatMap(change => {
    const path = typeof change === "object" && change !== null ? (change as ToolInput)["path"] : undefined;
    return typeof path === "string" && path.length > 0 ? [path] : [];
  });
}

const changeRow: ToolRow = {
  line: input => {
    const paths = changedPaths(input);
    if (paths.length === 0) return undefined;
    return paths.length === 1 ? `edited ${paths[0]}` : `edited ${plural(paths.length, "file")}`;
  },
  shows: [],
  itemType: "file_change",
  requestKind: "file-change",
  paths: changedPaths,
};

/** Every tool a harness reports, one row per name, Claude's and Codex's alike: what the command line writes for the
 * call and what the app's transcript makes of it come from the same row, so a new tool is a row here and nothing
 * else. A name with no row reads as itself, by the fields below. */
const TOOL_ROWS: ReadonlyMap<string, ToolRow> = new Map<string, ToolRow>([
  ["Bash", shellRow],
  ["command_execution", shellRow],
  ["Read", pathRow("read", "file_path", "file-read")],
  ["Write", pathRow("wrote", "file_path", "file-change")],
  ["Edit", pathRow("edited", "file_path", "file-change")],
  ["MultiEdit", pathRow("edited", "file_path", "file-change")],
  ["NotebookEdit", pathRow("edited", "notebook_path", "file-change")],
  ["file_change", changeRow],
  ["Grep", aboutRow("searched code for", "pattern", { codeSearch: true })],
  ["Glob", aboutRow("searched code for", "pattern", { codeSearch: true })],
  ["WebSearch", aboutRow("searched the web for", "query", { itemType: "web_search" })],
  ["web_search", aboutRow("searched the web for", "query", { itemType: "web_search" })],
  ["WebFetch", aboutRow("fetched", "url", { itemType: "web_search" })],
  ["Task", aboutRow("agent:", "description", { itemType: "collab_agent_tool_call" })],
]);

/** The fields a call's row shows when its own row names none, most particular first. */
const SHOWN_FIELDS: readonly string[] = ["file_path", "notebook_path", "pattern", "query", "url", "description", "prompt"];

/** The call's input as an object, or undefined while it is still arriving or when it is not one. */
function toolInput(input: string): ToolInput | undefined {
  let fields: unknown;
  try {
    fields = JSON.parse(input);
  } catch {
    return undefined;
  }
  return typeof fields === "object" && fields !== null && !Array.isArray(fields) ? (fields as ToolInput) : undefined;
}

/** The one line a tool call reads as while a turn runs: the shell line behind a prompt, the file behind the verb
 * that touched it, the search behind what it looked for, else the tool's own name. `input` is the delta's text,
 * the JSON the harness reported for the call; text that is not an object leaves the name alone. */
export function toolActivityLine(toolName: string | undefined, input: string): string {
  const name = toolName ?? "tool";
  const row = TOOL_ROWS.get(name);
  if (row === undefined) return name;
  const fields = toolInput(input);
  return fields === undefined ? name : row.line(fields) ?? name;
}

/** What a tool call is, for a client whose rows carry more than one line: the field to show, the shell command and
 * what it was for, the paths the call changed, and the kinds a client groups by. Input that is not an object yet is
 * shown as it stands, since a call streams in and a row is drawn before it is whole. */
export interface ToolCallFacts {
  readonly detail?: string;
  readonly command?: string;
  readonly description?: string;
  readonly changedFiles?: readonly string[];
  readonly itemType?: ToolItemType;
  readonly requestKind?: ToolRequestKind;
}

export function toolCallFacts(toolName: string, input: string): ToolCallFacts {
  const row = TOOL_ROWS.get(toolName);
  const itemType = row?.itemType ?? (toolName.startsWith("mcp__") ? "mcp_tool_call" : undefined);
  const kinds = {
    ...(itemType !== undefined ? { itemType } : {}),
    ...(row?.requestKind !== undefined ? { requestKind: row.requestKind } : {}),
  };
  const fields = toolInput(input);
  if (fields === undefined) return { ...kinds, ...(input.length > 0 ? { detail: input } : {}) };
  const detail = firstField(fields, [...(row?.shows ?? []), ...SHOWN_FIELDS]);
  const shell = row?.requestKind === "command";
  const command = shell ? toolField(fields, "command") : undefined;
  const description = shell ? toolField(fields, "description") : undefined;
  const changedFiles = row?.paths?.(fields) ?? [];
  return {
    ...kinds,
    ...(detail !== undefined ? { detail } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
  };
}

/** Whether a call looked through the code, for the client that folds those rows together. */
export function isCodeSearchTool(toolName: string | undefined): boolean {
  return toolName !== undefined && TOOL_ROWS.get(toolName)?.codeSearch === true;
}

/** What one tool call answered, as the line under the call: its first line by the rule the call's own line is cut
 * by, with the word ahead of it when the harness marked the call failed. Nothing when a call that worked answered
 * with nothing, since a blank line says less than no line. */
export function toolResultLine(text: string, isError = false): string | undefined {
  const first = titleLine(text);
  if (!isError) return first === "" ? undefined : first;
  return first === "" ? "failed" : `failed: ${first}`;
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

/** Text cut to one line: its first non-empty line with the whitespace collapsed, so a multi-paragraph brief is one
 * row in the CLI's table and one line in the sidebar, and a heredoc of a command is one line of a turn's activity. */
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

/** An install step the guard ended at its road's limit: the seconds, and that it was the second time when it was. */
export function timedOutLine(limitS: number, times = 1): string {
  return `timed out after ${limitS}s${times === 2 ? ", twice" : ""}`;
}

/** The step's line when its road's limit ended it and the step is run once more: a download that ran the clock out
 * was a dead read, and the words say so before the second run starts. */
export function stepRetryLine(limitS: number): string {
  return `${timedOutLine(limitS)}; trying once more`;
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

/** The turn's error when the harness's result arrived while the agent's own background tasks were still running: the
 * harness kills them with the turn and nothing wakes the thread when they would have finished, so the turn ended
 * before the work it started did. */
export function backgroundTasksLine(running: number): string {
  return `ended with ${plural(running, "background task")} running`;
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

/** What the provider answered one call with: the status, its message, the request id its reply carried when it
 * carried one (measured 2026-09-07: Solari's replies carry none), and the UTC time the reply landed. */
export interface ProviderAnswer {
  status: number;
  message: string;
  requestId?: string;
  at: string;
}

/** What the builder read at the provider after the last attempt: a state, or unread when the GET itself failed. */
export type BuilderReading = MachineState | "unread";

/** The provider's answer as a report to the provider needs it: status, message, and the request id; without one,
 * that the reply carried none and when it landed, never an empty id. */
export function providerAnswerLine(a: ProviderAnswer): string {
  return `${a.status} ${a.message} (${a.requestId !== undefined ? `request ${a.requestId}` : `no request id from the provider, at ${a.at}`})`;
}

/** The snapshotting stage's line after one refused attempt with another to come: which attempt, what the provider
 * said, what the builder reads at the provider, and when the next attempt is. */
export function snapshotAttemptLine(attempt: number, attempts: number, answer: ProviderAnswer, builderState: BuilderReading, retryMs: number): string {
  return `attempt ${attempt} of ${attempts} answered ${providerAnswerLine(answer)}; the builder reads ${builderState}, next attempt in ${fmtDuration(retryMs)}`;
}

/** The seal's failure line once the snapshot is given up on: how many attempts, the last answer, and whether the
 * provider still has the builder. A builder the provider answers 404 for is named gone at the provider's hand. */
export function snapshotFailedLine(attempts: number, answer: ProviderAnswer, builderState: BuilderReading, readError?: string): string {
  const head = `the snapshot failed ${plural(attempts, "time")}: the provider answered ${providerAnswerLine(answer)}`;
  if (builderState === "gone") return `${head} and no longer has the builder (404)`;
  if (builderState === "unread") return `${head} and could not be read about the builder (${readError ?? "no reason given"})`;
  return `${head} while the builder read ${builderState}`;
}

/** The one sentence every road that leaves a builder running says: its id, what it costs, how to attach to it
 * again, and that the sweep ends it. */
export function builderStaysLine(builderId: string, rateUsdPerHour: number, attachCommand: string): string {
  return `Builder ${builderId} stays up at about $${rateUsdPerHour.toFixed(2)}/hr; ${attachCommand} attaches to it again, and the sweep stops it once it is six hours old.`;
}

/** The wizard's last line when the snapshot failed and the provider still has the builder: nothing on it changed. */
export function sealFailedBuilderStaysLine(builderId: string, rateUsdPerHour: number, attachCommand: string): string {
  return `Seal failed; the builder is as you left it. ${builderStaysLine(builderId, rateUsdPerHour, attachCommand)}`;
}

/** The wizard's last line when the snapshot failed and the provider would not say what became of the builder: it
 * was not touched, and the attach is offered as when it is known to be up. */
export function sealFailedBuilderUnreadLine(builderId: string, rateUsdPerHour: number, attachCommand: string): string {
  return `Seal failed; the provider could not be read about the builder, so nothing on it was touched. ${builderStaysLine(builderId, rateUsdPerHour, attachCommand)}`;
}

/** The wizard's last line when the seal failed on any road but a refused snapshot: the builder was consumed. */
export const SEAL_FAILED_LINE = "Seal failed and the builder is gone. Run wsp init again; the recipe is kept.";

/** The wizard's last line when the snapshot failed and the provider answers 404 for the builder: the provider
 * dropped it, not wsp. */
export const SEAL_FAILED_BUILDER_GONE_LINE = "Seal failed and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again; the recipe is kept.";

/** The update's last line when the snapshot of the new version failed and the provider still has the machine it
 * ran on: the golden stands, the machine is as it was, the retry runs on it or the sweep ends it. */
export function upgradeSealFailedStaysLine(version: number, builderId: string, rateUsdPerHour: number): string {
  return `Golden v${version} is unchanged. Builder ${builderId} is as it was, up at about $${rateUsdPerHour.toFixed(2)}/hr; run wsp init again to retry, and the sweep stops it once it is six hours old.`;
}

/** The update's last line when the snapshot failed and the provider would not say what became of the machine it
 * ran on: nothing on it was touched, the retry runs on it or the sweep ends it. */
export function upgradeSealFailedUnreadLine(version: number, builderId: string): string {
  return `Golden v${version} is unchanged. The provider could not be read about builder ${builderId}, so nothing on it was touched; run wsp init again to retry, and the sweep stops it once it is six hours old.`;
}

/** The update's last line when the snapshot failed and the provider answers 404 for the machine it ran on. */
export function upgradeSealFailedGoneLine(version: number): string {
  return `Golden v${version} is unchanged and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again to retry.`;
}
