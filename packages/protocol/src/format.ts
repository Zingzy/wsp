// SPDX-License-Identifier: AGPL-3.0-only
// Binary units with one decimal for the wizard, the engine's stage lines, the
// runtime's import and export events and the app; a turn's duration as the chat's footer,
// the notify line and the cut line print it, and its cost. The files that keep their own
// rule are the exception list in the protocol format test, each with its reason.
import type { GoldenMissingTool, HarnessCatalog, MachineSizeOffer, MachineState, ProjectExportEvent, ProjectImportEvent, ProjectSecret, TerminalConfig, TerminalRgb, TitleSource, ToolPin, TurnResult, WorkspaceSize } from "./index.js";
import { shellLine } from "./shell-quote.js";
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

/** Memory in GB as the size table names it: whole when whole, else one decimal; a size spec, not a byte count. */
const memGb = (memMb: number): number => Number((memMb / 1024).toFixed(1));

/** A machine size's memory with its unit. */
export function fmtMemGb(memMb: number): string {
  return `${memGb(memMb)} GB`;
}

/** A size as the Machine tab and the new-workspace form show it: "2 vCPU · 4 GB". */
export function fmtSize(size: WorkspaceSize): string {
  return `${size.cpu} vCPU · ${fmtMemGb(size.memMb)}`;
}

/** A size as the --size flag and the fork tools spell it: vCPUs, an x, memory in GB ("2x4", "2x0.5"). */
export function sizeWord(size: WorkspaceSize): string {
  return `${size.cpu}x${memGb(size.memMb)}`;
}

/** The size a word names, or nothing when the word is not one. */
export function sizeFromWord(word: string): WorkspaceSize | undefined {
  const m = /^(\d+)x(\d+(?:\.\d+)?)$/.exec(word.trim());
  if (m === null) return undefined;
  const cpu = Number(m[1]);
  const memMb = Math.round(Number(m[2]) * 1024);
  return cpu > 0 && memMb > 0 ? { cpu, memMb } : undefined;
}

/** Whether a size is one the provider offers; the golden's own size is taken without this check. */
export function offeredSize(sizes: readonly WorkspaceSize[], size: WorkspaceSize): boolean {
  return sizes.some(s => s.cpu === size.cpu && s.memMb === size.memMb);
}

/** An awake rate in dollars an hour, to the cent. */
export function fmtRate(usdPerHour: number): string {
  return `$${usdPerHour.toFixed(2)}/hr`;
}

/** The one refusal every road gives a size the provider does not offer, malformed or merely absent: the word as it
 * was given, then every size that is offered with its rate. */
export function sizeRefusal(word: string, sizes: readonly MachineSizeOffer[]): string {
  const offered = sizes.map(s => `${sizeWord(s)} (${fmtRate(s.rateUsdPerHour)})`).join(", ");
  return `${word} is not a size this provider offers; the sizes are ${offered}`;
}

/** The one refusal a create or a fork gives when the provider is at its machine cap and no builder was left to stop
 * for room: the machines this host knows hold the slots, and the two moves that free one. The provider's own
 * sentence ("Too many concurrent sessions") names nothing a person can act on. A builder is named as one, since
 * the pause it is offered beside is a workspace's move; the runtime stops the builders it may before it asks here.
 * Only the holders are claimed: the plan's cap is nowhere in Capabilities, and a slot held by a machine this host
 * cannot name still counts against it, so no branch but the two-holder line the ticket wrote totals the slots. */
export function machineCapRefusal(workspaces: readonly string[], builders: readonly string[] = []): string {
  const holders = [...workspaces, ...builders.map(name => `${name} (builder)`)];
  if (holders.length === 0) return "the provider is at its machine cap and no machine of this computer holds a slot; free one at the provider and try again";
  const slots = holders.length === 1 ? "a machine slot is" : holders.length === 2 ? "both machine slots are" : "machine slots are";
  return `${slots} in use: ${holders.join(", ")}. Pause ${holders.length === 1 ? "it" : "one"} or wait for a nap.`;
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

/** What the notify line ends with, and what a wait answers as the reply: the last non-empty line of the reply, or the
 * error when there is no reply. A turn that did not complete says its error first, since that is what whoever waits
 * needs. */
export function notifyTail(result: TurnResult): string | undefined {
  const reply = lastLine(result.text ?? "");
  return result.status === "completed" ? reply ?? result.error : result.error ?? reply;
}

/** The one line a thread's end sends to whoever its start named, and the one a wait on it prints: the thread's first
 * eight characters, the outcome word with the duration and cost the harness reported, then the tail. */
export function notifyLine(threadId: string, result: TurnResult): string {
  const facts = [result.status, ...(result.durationMs !== undefined ? [fmtDuration(result.durationMs)] : []), ...(result.costUsd !== undefined ? [fmtCost(result.costUsd)] : [])];
  const tail = notifyTail(result);
  return `thread ${threadId.slice(0, 8)} finished (${facts.join(", ")})${tail !== undefined ? `: ${tail}` : ""}`;
}

/** The line a wait prints when its deadline passed with every named thread still running: one thread by its first
 * eight characters, more by their count. */
export function waitTimedOutLine(threadIds: readonly string[], ms: number): string {
  const who = threadIds.length === 1 ? `thread ${threadIds[0]!.slice(0, 8)}` : fmtThreads(threadIds.length);
  return `${who} still running after ${fmtDuration(ms)}`;
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

/** One name inside a comma-joined list of names: quoted when the name carries that comma itself, so a free-text
 * label an agent wrote reads as one entry and not as two nameless ones. */
export function listedName(name: string): string {
  return name.includes(",") ? JSON.stringify(name) : name;
}

/** A list of names as every tally that names its rows prints it, each name by the rule above. */
export function nameList(names: readonly string[]): string {
  return names.map(listedName).join(", ");
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

/** The most characters a thread title made from its opening turn takes, the ellipsis counted. */
const OPENING_TITLE_MAX = 48;
const ELLIPSIS = "\u2026";

/** A thread's title from its opening turn when the harness has no name for it: the turn's first sentence, cut at a
 * word boundary to at most 48 characters with an ellipsis only when cut, so a brief-shaped turn never titles the row,
 * the breadcrumb, the switcher card or the CLI's table with its whole opening words. */
export function openingTitle(text: string): string {
  const line = titleLine(text);
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  if (sentence.length <= OPENING_TITLE_MAX) return sentence;
  const room = OPENING_TITLE_MAX - ELLIPSIS.length;
  return `${wordsWithin(sentence, room) ?? sentence.slice(0, room).replace(SEPARATOR_TAIL, "")}${ELLIPSIS}`;
}

/** What a cut leaves dangling at its edge: the space it broke on and the punctuation that hung off the word before. */
const SEPARATOR_TAIL = /[\s,;:]+$/;

/** The whole words of a line that fit in the room, the separator they ended on taken off; nothing when the line's
 * first word alone overruns it. A word that ends exactly at the room's edge is kept whole. */
function wordsWithin(line: string, room: number): string | undefined {
  const head = line.slice(0, room + 1);
  const boundary = head.lastIndexOf(" ");
  return boundary > 0 ? head.slice(0, boundary).replace(SEPARATOR_TAIL, "") : undefined;
}

/** Where a title read out of the harness's own store came from: one that is the thread's opening words, or their head,
 * is the seed under the harness's roof (codex names a thread from them the moment it starts) and the thread is still
 * asked for a name; any other is the person's rename or the harness's own made name, and stands. */
export function storedTitleSource(stored: string, opening: string | undefined): TitleSource {
  if (opening === undefined) return "person";
  const title = stored.replace(/\s+/g, " ").trim();
  return title !== "" && titleLine(opening).startsWith(title) ? "seed" : "person";
}

/** The most characters a generated title takes; a longer answer is cut to the words that fit. */
export const GENERATED_TITLE_MAX = 40;
/** How much of the opening turn and of the reply the title question carries: the words a title comes from are at the
 * top of both, and a whole brief would cost more to send than the answer is worth. */
const TITLE_EXCERPT_MAX = 600;

const excerpt = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= TITLE_EXCERPT_MAX ? trimmed : `${trimmed.slice(0, TITLE_EXCERPT_MAX)}${ELLIPSIS}`;
};

/**
 * The one question every harness is asked for a thread's title, once, when its first turn starts: three to six
 * words of what was asked need no reply, so the runtime asks from the opening turn alone and the reply rides only
 * when a caller has one. Six words and 34 characters are asked for rather than the 40 the answer is measured
 * against: claude-sonnet-5 overran 34 in 26 of 80 answers, by up to 11 characters (measured 2026-09-07), and an
 * answer over the cap is cut to its first words.
 */
export function titlePrompt(opening: string, reply?: string): string {
  return [
    "Name this coding agent thread in 3 to 6 words, no more than 34 characters, sentence case, no quotes and no full stop.",
    "Do not repeat the opening words, and do not say anything is done, fixed or working.",
    "Answer with the title alone and nothing else; a longer answer is cut short.",
    "",
    "The opening turn:",
    excerpt(opening),
    ...(reply === undefined ? [] : ["", "The reply:", excerpt(reply)]),
  ].join("\n");
}

/**
 * A harness's answer to titlePrompt as a title, or nothing when it did not answer with one: a title is one line, so
 * an answer that explains itself over several lines is refused whole and the thread keeps the words its opening
 * turn seeded it with. One that runs past GENERATED_TITLE_MAX is cut to the whole words that fit, since a model asked
 * for 34 characters answers up to 45 a third of the time and its first words are still the title; a single word
 * longer than the cap has no words to keep. Wrapping quotes and a trailing stop are the two shapes a model adds
 * around an otherwise good title, so they come off first.
 */
export function generatedTitle(answer: string): string | null {
  const line = answer.trim();
  if (line === "" || /[\r\n]/.test(line)) return null;
  const unquoted = /^(["'\u201c\u2018])(.*)(["'\u201d\u2019])$/.exec(line)?.[2]?.trim() ?? line;
  const title = unquoted.replace(/[.]+$/, "").trim();
  if (title === "") return null;
  return title.length <= GENERATED_TITLE_MAX ? title : (wordsWithin(title, GENERATED_TITLE_MAX) ?? null);
}

/** Text cut to its last line: the last non-empty line with the whitespace collapsed, or nothing when the text has
 * none. The notify line ends with it and a switcher card shows it under the thread's title, so both read one rule. */
export function lastLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  const last = lines[lines.length - 1];
  return last === undefined ? undefined : last.replace(/\s+/g, " ").trim();
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

/** The turn's error when a host that came back looked for the turn's run on the machine and the machine no longer
 * holds it: the run's files were swept, so nothing the agent did while the host was away can be read back. */
export const RUN_GONE_LINE = "the machine no longer holds this turn's run, so nothing of it can be read back";

/** What a command waiting on a turn is told when the host it asked stops: the run is the machine's, not the host's,
 * so it goes on and its reply lands in the thread whether or not this command is still there to see it. */
export const HOST_STOPPING_LINE = "the host is restarting; the turn goes on and its reply lands in the thread";

/** The turn's error when nothing on the machine answered a launch from this computer for the whole reach window:
 * how many times it was tried and over how long. The fetch's own words name a Node error and the machine id,
 * neither of which a person can act on. */
export function machineUnreachedLine(attempts: number, elapsedMs: number): string {
  return `the machine could not be reached from this computer after ${plural(attempts, "attempt")} over ${fmtDuration(elapsedMs)}`;
}

/** The line an MCP install ends on: the command every agent's config now runs, as one shell line. */
export function mcpServerCommandLine(command: string, args: readonly string[]): string {
  return `The server command is ${shellLine([command, ...args])}`;
}

/** The very last line an MCP install prints: the thing to do next, which is inside the agent it just gave the tools
 * to. `open` is the agent's own command and `first` what to type at its prompt, its slash form where it has one. */
export function nextInsideAgentLine(open: string, first: string): string {
  return `Next: run ${shellLine([open])} in this folder and say: ${first}`;
}

/** One level of this computer's own folders in words, the same on the command line and in the app's folder browser:
 * how many folders the level holds, where it sits, and how many of it are dot-named, whether or not those are listed. */
export function folderLevelLine(listing: { dir: string; folders: readonly unknown[]; hidden: number }): string {
  const held = listing.hidden === 0 ? "" : `, ${listing.hidden} hidden`;
  return listing.folders.length === 0 ? `No folders in ${listing.dir}${held}.` : `${plural(listing.folders.length, "folder")} in ${listing.dir}${held}.`;
}

/** What the folder browser's state slot says for a level this computer would not let the host read, and the words the
 * command line's own refusal line carries: the host's reason, which names the folder itself, on one line whatever the
 * host said. A refused level leaves the list on the level it was already on, so this slot is where it is read. */
export function folderRefusalLine(reason: string): string {
  return `No folders read. ${reason.replace(/\s+/g, " ").trim()}`;
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

/** The one line the sidebar puts above the rows while the probes fail before leaving this computer; the rows keep
 * their last word. It names what could not be reached, not the computer: the road out was up and every other name
 * resolved while this one did not (measured 2026-09-07). */
export const PROVIDER_UNREACHED_LINE = "Solari cannot be reached from this computer";

/** One line per retry of a provider call that never left this computer: which call, the system error the road gave,
 * and which try of how many is about to go, so a run that still fails carries the whole flap in its log. */
export function providerRoadRetryLine(call: string, code: string, tryNumber: number, tries: number): string {
  return `${call} did not leave this computer (${code}); try ${tryNumber} of ${tries}`;
}

/** When a turn is over, in the one sentence every door the agent reads quotes whole: the skill, the tool
 * descriptions, the command line's help and the machine's own context. The reply comes back at once from a follow;
 * the row settles only at the process exit, since a harness can keep working after it answers. */
export const TURN_END_WORDS = "A turn ends when the agent process exits, not at its reply, and the thread reads running until then";

/** When the notify line goes, quoted the same way: with the reply, once, never again at the exit. */
export const NOTIFY_WORDS = "The notify line goes once, at the reply";

/** What a send meets when its thread's last turn has replied but its agent process is still running (a child it did
 * not wait for, a lingering task): the row still reads running and is not free for a new turn, so the caller is told
 * in words, by thread, instead of starting a second agent in the same worktree. */
export function stillWorkingRefusal(threadId: string): string {
  return `thread ${threadId.slice(0, 8)} replied, still working; wait for its turn to finish before sending`;
}

/** The send key's label while the thread's turn runs: Enter queues, nothing sends. */
export const TURN_IN_FLIGHT = "Turn in flight";

/** The composer's line for a stop click the runtime refused or could not place, over the runtime's own words. */
export function stopFailedLine(error: string): string {
  return `Could not stop: ${error}`;
}

/** The composer's line for a send-now into a running turn that did not go, over the runtime's own words. */
export function sendNowFailedLine(error: string): string {
  return `Could not send now: ${error}`;
}

/** The one line every client shows on a start whose thread's previous turn was cut, before the new turn's output. */
export const AFTER_CUT_LINE = "previous turn was cut; resuming";

/** The refusal of a flag another verb reads: the verbs it belongs to, then the one that does not read it, so the
 * caller is told where the flag lives rather than left with the parser's bare unknown-option line. */
export function foreignFlagLine(flag: string, readers: readonly string[], here: string): string {
  const owners = readers.length > 1 ? `${readers.slice(0, -1).join(", ")} and ${readers.at(-1)}` : readers[0];
  return `${flag} belongs to ${owners}; ${here} does not read it`;
}

/** An agent id no catalog entry carries, named beside the ids the catalog does know. */
export function unknownAgentLine(id: string, known: readonly string[]): string {
  return `no agent called ${id}; the catalog knows ${known.join(", ")}`;
}

/** The refusal of a start naming an agent the host has no adapter for, listing the ones it has. */
export function noAdapterLine(harness: string, agents: readonly string[]): string {
  return `no adapter registered for harness "${harness}"; agents on this host: ${agents.join(", ") || "none"}`;
}

/** The refusal of a thread opened on no words: an empty or whitespace task would still start a process and a turn. */
export const EMPTY_TASK_LINE = "the task is empty; say what the thread is to do";

/** The refusal of a rename to nothing: a blank name would take a thread's title away and leave nothing in its place. */
export const EMPTY_TITLE_LINE = "the name is empty; say what the thread is called";

/** The one line a codex turn fails with when its provider wants an OpenAI login the machine has not got: the CLI
 * itself only retries the 401 and dies. `login` is the catalog's command for signing in on a machine. */
export function codexNotSignedInLine(login: string): string {
  return `Codex is not signed in on this machine; run ${login} there`;
}

/** The line when codex's provider reads its key from an environment variable the machine does not set. */
export function codexMissingEnvLine(name: string): string {
  return `Codex's model provider reads its key from the environment variable ${name}, which is not set on this machine`;
}

/** The one line under the composer's model lists: the binary that filled them, else whose table stood in and what it
 * was pinned from, or the adapter's own words for why the binary gave nothing. Every word comes from the catalog being
 * shown, so a tab never borrows another agent's binary, reason or pin. The slot is one line at the popup's width, 290px
 * of the 10px mono it draws in, so the agent is named once and the pin's own words carry the rest. */
export function catalogSourceLine(catalog: HarnessCatalog): string {
  const version = catalog.version;
  if (catalog.source === "harness") return `${catalog.label}${version === null ? "" : ` ${version}`} on this machine`;
  const why = catalog.refusal ?? `${catalog.harness} table`;
  return version === null ? why : `${why} · ${version}`;
}

/** The one line in place of the model rows: what the binary reported, or what the table holds, and never a count the
 * source did not give. */
export function noModelsLine(catalog: HarnessCatalog): string {
  return catalog.source === "harness" ? `${catalog.label} reported no models` : `No model in the ${catalog.label} table`;
}

/** The line when codex kept reconnecting to its provider and nothing ever answered: the CLI itself never gives up. */
export function codexReconnectLine(elapsedMs: number): string {
  return `stopped after ${fmtDuration(elapsedMs, "clock")} of Codex reconnecting to its model provider with no answer`;
}

/** What the daemon last read of the guest's memory and load before its link went quiet. */
export interface MemoryReading {
  used: number;
  total: number;
  load1: number;
}

/** The share of memory in use past which the kernel's killer is one allocation away: 3.59 of 3.94 GB (91 percent)
 * when a build took a daemon, measured 2026-09-06. */
export const MEMORY_NEAR_FULL = 0.9;

export function memoryNearFull(mem: { used: number; total: number }): boolean {
  return mem.total > 0 && mem.used / mem.total >= MEMORY_NEAR_FULL;
}

/** The line every pane and row shows when a machine stopped answering with its memory near full: the last figures
 * the daemon sent, and that the work took the memory, so nobody rebuilds a machine that is fine. */
export function outOfMemoryLine(r: MemoryReading): string {
  return `Out of memory (${fmtBytes(r.used)} of ${fmtBytes(r.total)} used, load ${r.load1.toFixed(1)}) when the machine last answered; the work on it took the memory, not a fault of the machine`;
}

/** Two byte counts against each other with the unit said once when they share it: "3.6 of 3.9 GB", "900.0 MB of 3.9 GB". */
function fmtBytesOf(used: number, total: number): string {
  const t = fmtBytes(total);
  const u = fmtBytes(used);
  const unit = t.slice(t.lastIndexOf(" "));
  return `${u.endsWith(unit) ? u.slice(0, -unit.length) : u} of ${t}`;
}

/** The sidebar row's form of the same fact, in the shape the daemon note takes: the row's second line is about
 * thirty characters wide, so the sentence above would be cut at the figures. */
export function outOfMemoryRowLine(r: MemoryReading): string {
  return `out of memory, ${fmtBytesOf(r.used, r.total)}`;
}

/** What to do about it, shown ahead of any rebuild: the smallest size in the provider's table with more memory than
 * this machine, with its rate, for the next workspace. With none in the table, less at once is the only road. */
export function biggerSizeLine(current: WorkspaceSize, offers: readonly MachineSizeOffer[]): string {
  const bigger = offers.filter(o => o.memMb > current.memMb).sort((a, b) => a.memMb - b.memMb)[0];
  if (bigger === undefined) return "No size with more memory is offered; run less on the machine at once";
  return `A workspace on ${fmtSize(bigger)} (${fmtRate(bigger.rateUsdPerHour)}) fits more; pick it when you make the next one`;
}

/** The machine row's line while the runtime replaces a daemon older than this wsp, and the line it shows instead
 * when the replacement failed. A person is never told the helper is called a daemon: they did not install it and
 * cannot run it, so its name would only be one more thing to know. Neither line carries the reason a deploy gave:
 * that is an npm log a person can do nothing with, hundreds of characters wide in a row that fits about thirty,
 * and it names the daemon in its own words. The runtime logs it for whoever runs the host. */
export const DAEMON_UPDATING = "updating the helper";
export const DAEMON_UPDATE_FAILED = "could not update the helper";

/** Why a nap's vault export was refused: its size against the cap, both in the one byte rule. */
export function vaultOverCapLine(bytes: number, capBytes: number): string {
  return `the export was ${fmtBytes(bytes)}, over the ${fmtBytes(capBytes)} cap`;
}

/** A store an agent keeps for every project that an export could not read on the machine: nothing from it travelled,
 * so the project's rows in it stayed there rather than every other project's leaving with them. */
export function storeUnreadLine(store: string, why: string): string {
  return `could not read ${store} on the machine, so nothing from it travelled: ${why}`;
}

/** The napping status's line when the nap could not store a fresh vault and the previous one stands: a wake that has
 * to rebuild the machine restores older files than the person left, so they are told at the nap, not at the wake. */
export function vaultKeptLine(why: string): string {
  return `nap kept the previous vault; ${why}`;
}

/** Which call found the provider no longer knew a record's machine: the status poll's read, a pause, a wake's read,
 * the sweep's read of a machine its listing lacked, or the record load at host start. */
export type GoneSeenBy = "status poll" | "pause" | "wake" | "sweep" | "record load";

/** One sighting of a machine gone at the provider: who saw it, when (epoch ms), and the provider's answer to that
 * call when it answered in words (its status and message); a state read that came back gone carries none. */
export interface GoneSighting {
  by: GoneSeenBy;
  at: number;
  answer?: string;
}

/** What a record says about a machine the provider stopped knowing: which call found it gone and the second it did,
 * quoting the provider where it said anything. Without a sighting, only that it is gone. */
export function goneWords(machineId: string, seen?: GoneSighting): string {
  const base = `machine ${machineId} is gone at the provider`;
  if (seen === undefined) return base;
  const at = new Date(seen.at).toISOString().replace(/\.\d{3}Z$/, "Z");
  const answer = seen.answer === undefined || seen.answer === "" ? "" : ` (${seen.answer})`;
  return `${base}: the ${seen.by} found it gone at ${at}${answer}`;
}

/** The answer a sighting quotes when the host's metrics read came back missing while the state read still said
 * running: the host lost the VM before the gateway's record followed, so a pause or snapshot would have failed next. */
export function hostLostAnswer(said: string): string {
  return `metrics ${said}; the state read still said running`;
}

/** The machine row's line when a record that said paused met a machine the provider was running all along (a nap
 * whose pause never took, a resume nobody wrote): the record followed the fact and nothing was resumed. */
export const ALREADY_RUNNING = "already running at the provider";

/** The machine row's line on a workspace the sweep recorded from the provider's listing: a machine of this setup's
 * that no record claimed, kept rather than killed, since a machine nobody records bills unseen. */
export const RECORD_RESTORED = "record restored from the provider's listing";

/** The host's line for it, with the name the fork stamped on the machine (or the machine id where it stamped none)
 * and the verb that removes it. */
export function recordRestoredLine(machineId: string, name: string, workspaceId: string): string {
  return `reap: recorded ${machineId} as workspace ${name} (${workspaceId}): a machine from this setup that no record claimed; it bills until wsp delete ${name}`;
}

/** The refusal a fork gets for a name another workspace holds; a name names at most one workspace. */
export function nameTakenRefusal(name: string): string {
  return `${name} is already a workspace; pick another name, or delete it first`;
}

/** The refusal a fork gets for a name whose workspace is being deleted this moment: the two never interleave. */
export function nameDeletingRefusal(name: string): string {
  return `${name} is being deleted; wait for the delete to finish, then fork it again`;
}

/** The refusal a fork or a rename gets for a blank name: a person and an agent both address a workspace by its name. */
export const BLANK_NAME_REFUSAL = "a workspace name cannot be blank";

/** The row's line when a pause or a wake ran its deadline out, once and once more after the retry: which move, how
 * long it was given in all, and what the provider reads about the machine after it, or that the provider could not
 * be read. The person's road is to try again; the runtime never leaves the row at Pausing or Waking. */
export function moveTimedOutLine(move: "pause" | "wake", elapsedMs: number, reads: MachineState | undefined): string {
  const provider = reads === undefined ? "could not be read about the machine" : `reads the machine ${reads}`;
  return `${move} did not complete in ${fmtDuration(elapsedMs)}; the provider did not answer and ${provider}; try again`;
}

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

/** How much of a checksum a line shows: enough to tell two apart, short enough that a reason line with both fits its cut. */
export const SUM_SHOWN = 12;
export const shortSum = (sha256: string): string => sha256.slice(0, SUM_SHOWN);

/** The install step's failure when a download the recipe pinned does not hash to the recorded sum: what came down,
 * at which tag, and both sums, so a moved asset reads as a moved asset and never as a broken download. */
export function pinMismatchLine(what: string, tag: string, recorded: string, served: string): string {
  return `${what} at ${tag} does not match the checksum recorded on its first install: recorded ${recorded}, served ${served}`;
}

/** Why a tool in the recipe installs differently now: the road it takes moved. Both sides in the roads' own words. */
export function roadMovedLine(from: string, to: string): string {
  return `now ${to}, was ${from}`;
}

/** Why a tool installs differently now: the version it installs at moved; a side with none reads as unpinned. */
export function versionMovedLine(from: string | undefined, to: string | undefined): string {
  return `${from ?? "unpinned"} to ${to ?? "unpinned"}`;
}

/** The words for a tools row no road installs, where a road's own words would stand. */
export const NO_ROAD_WORDS = "by no road";

/** Why a tool installs differently now: the release it is fixed to moved, or the sum recorded for that release did. */
export function pinMovedLine(from: ToolPin | undefined, to: ToolPin | undefined): string {
  if (from === undefined) return `now fixed to release ${to!.tag}`;
  if (to === undefined) return `no longer fixed to release ${from.tag}`;
  return from.tag === to.tag ? `the checksum recorded for ${from.tag} changed` : `release ${from.tag} to ${to.tag}`;
}

/** Why a tool installs differently now when its road and pin stand: the lines the road runs are not the golden's. */
export const INSTALLER_MOVED_LINE = "its install lines changed";

/** The detail of a tools row the catalog does not carry: it is on this Mac, at the version this Mac runs when the
 * collector read one. */
export function installedOnMacLine(version: string | undefined): string {
  return version === undefined ? "installed on this Mac" : `installed on this Mac, ${version}`;
}

/** What the build does with a tools row it installs: the road in its own words, then the line the step runs. */
export function installsByLine(words: string, shown: string): string {
  return `installs ${words}: ${shown}`;
}

/** What the build does with a ticked tools row it sets aside, with the plan's reason. */
export function leftOutLine(note: string): string {
  return `left out of the build: ${note}`;
}

/** Why `wsp recipe --add` refuses a package a manager on this Mac already has: that package is a row of its own,
 * which the build installs by the road the plan resolves for it (a tap formula from its GitHub release, pinned),
 * and a second row would install it twice by a line the image can refuse. The word that ticks the row instead. */
export function addAlreadyHereLine(id: string, scanId: string): string {
  return `--add ${id}: a package manager on this Mac already has ${id}, so it is a row of its own; tick it with --set ${scanId}=on, which installs it by its own road, rather than adding a second row that installs it again`;
}

/** A recipe file's tick on a tool outside the catalog that this Mac has no row for: nothing here says how to install
 * it, so the tick is said and left out rather than dropped in silence. */
export function notHereLine(name: string, file: string): string {
  return `${name} is ticked in ${file}, but this Mac has no row that installs it; it is left out.`;
}

/** The app's line for a workspace still forked from an older golden version, offered the way the helper update is:
 * a state in words, never a badge. The move is the person's; nothing replaces a machine they are working on. */
export function behindGoldenLine(on: number, head: number): string {
  return `on image v${on}, v${head} available`;
}

/** The states a lineage row can be in, each as the muted mono word the row's marks column shows: state is text there,
 * never a badge, and a missing tool's outcome indexes this table as it is. */
export const LINEAGE_MARKS = { now: "now", head: "head", fork: "this fork", failed: "failed", skipped: "skipped", volatile: "volatile" } as const;
export type LineageMark = keyof typeof LINEAGE_MARKS;

/** What is said for each folder git named no branch for, by door: the word the composer's branch slot and the diff
 * pane's git mark show and the sentence it explains on hover, nothing for a folder outside any repository or one not
 * yet asked (both ordinary) and a word for a read the machine refused or failed (an outside cause the person should
 * see); and the one line an empty diff pane says in place of a diff, only for a folder outside any repository, since
 * an empty pane with no reason reads as broken while a refused read shows the cause git gave. */
export const REPO_STATE_WORDS = {
  unknown: { word: "", note: "", pane: "" },
  none: { word: "", note: "", pane: "This folder is not inside a git repository, so there is nothing to diff." },
  refused: { word: "git unread", note: "The machine could not read this folder's git state, so no branch is shown.", pane: "" },
} as const;
export type RepoStateWord = keyof typeof REPO_STATE_WORDS;

/** A missing tool's row as the lineage shows it. A record sealed before the name and outcome were recorded still
 * carries its id, so it reads by that and as failed rather than as a blank row. */
export function missingToolRow(t: { id: string; name?: string; outcome?: GoldenMissingTool["outcome"]; note: string }): { name: string; note: string; mark: LineageMark } {
  return { name: t.name === undefined || t.name === "" ? t.id : t.name, note: t.note, mark: t.outcome ?? "failed" };
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

/** The promoting stage's line for one read of the template: what the provider says it is, and whether the seal asks
 * again. Ready is the last line the stage writes. */
export function templateStatusLine(templateId: string, status: string): string {
  return status === "ready" ? `${templateId} is ready` : `${templateId} is ${status}; asking again`;
}

/** The seal's failure line when the provider marks the template failed: forks would have nothing to boot from. */
export function templateFailedLine(templateId: string, reason: string | undefined): string {
  return `the provider failed the template ${templateId}: ${reason ?? "no reason given"}`;
}

/** The seal's failure line when the template never read ready inside the wait. */
export function templateWaitedLine(templateId: string, status: string, waitedMs: number): string {
  return `the template ${templateId} still reads ${status} after ${fmtDuration(waitedMs)}`;
}

/** The doctor's line per version it made durable: the golden and version, the template it promoted, and when other
 * templates already carry the name (another host's, or a run that recorded nothing), how many; none when the count
 * is zero or the listing was not given. */
export function templateRecordedLine(golden: string, version: number, templateId: string, sharing: number | undefined): string {
  const head = `golden ${golden} v${version}: template ${templateId} promoted and recorded`;
  return sharing === undefined || sharing === 0 ? head : `${head}; ${sharing} other ${sharing === 1 ? "template carries" : "templates carry"} its name`;
}

/** The doctor's line per version it could not make durable and why: a lost snapshot in the provider's own words is
 * left to the doctor's rebuild road below it. */
export function templateSkippedLine(golden: string, version: number, reason: string): string {
  return `golden ${golden} v${version}: no template recorded, ${reason}`;
}

/** What a version's row says when the provider answers 404 for its snapshot: the vanish the templates exist to outlive. */
export const SNAPSHOT_GONE_REASON = "its snapshot is gone at the provider";

/** The doctor's line on a backend whose capabilities lack templates: nothing to promote, nothing wrong. */
export const NO_TEMPLATES_LINE = "this backend has no templates; goldens stay as snapshots";

/** The doctor's line for the machines its teardown check found on the account that this host did not make: each
 * named with the host that did, left alone and never a failure, since two computers on one account each stand
 * their own. */
export function otherHostsMachinesLine(machines: readonly { id: string; owner?: string }[]): string {
  const named = machines.map(m => `${m.id} (${m.owner === undefined ? "no owner" : `owner ${m.owner}`})`);
  return `left alone ${plural(machines.length, "machine")} this host did not make: ${named.join(", ")}`;
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

/** The line under the import dialog's title: which workspace, and that the folder lands at the path it has here. */
export function importIntoLine(workspaceName: string): string {
  return `Into ${workspaceName}, at the same path.`;
}

/** The repository row of a plan, in words a stranger reads: the history travels with a .git, or there is none. */
export function repoLine(repo: boolean): string {
  return repo ? "Git repository, history travels" : "No repository";
}

/** What the ticks on the secret-shaped rows do, under how many rows there are. */
export function secretsNote(n: number): string {
  return `${plural(n, "file")} ${n === 1 ? "looks like a secret" : "look like secrets"}. Ticked files are copied as they are. Unticked files are left out and listed.`;
}

/** What the ticks on the agent rows do. */
export const SESSIONS_NOTE = "Ticked agents' sessions go with the folder. The rest stay here.";

/** Why a secret-shaped file was flagged and its size, as the CLI's plan column and the dialog's hover both print it. */
export function secretSignalsLine(s: ProjectSecret): string {
  return `${s.signals.join(", ")}, ${fmtBytes(s.bytes)}`;
}

/** The line under the export dialog's title: which workspace the folder leaves, and where it lands. */
export function exportFromLine(workspaceName: string): string {
  return `From ${workspaceName}, to this Mac.`;
}

/** What the ticks on the export dialog's agent rows do. */
export const EXPORT_SESSIONS_NOTE = "Ticked agents' sessions come home with the folder. The rest stay on the machine.";

/** The export dialog's agent section when the workspace has no threads to make rows of. */
export const NO_THREADS_NOTE = "No threads here. Every agent's sessions for the folder come home with it.";

/** What a row of the export's summary says before the folder has landed, since nothing is read from the machine first. */
export const NOT_LANDED_WORD = "when it lands";

/** A trip's events folded into the one progress line and its bar. */
export interface TripProgress {
  readonly line: string;
  /** How far the bar is, 0 to 1; it never goes back. */
  readonly fraction: number;
}

/** An import's events folded into the one progress line and its bar. The words are the last event's step: the two
 * steps before packing pass in a blink and read as starting, packing keeps the runtime's count, an upload is named
 * by its total so the words hold still while the bar moves, a landing by the workspace it lands on. The runtime lands
 * the project and then uploads and lands the sessions tar in a second pass, so that pass is named and the bar holds
 * its high-water mark instead of dropping to nought. A failure has no step; the status line carries it. */
export function importProgress(events: readonly Pick<ProjectImportEvent, "stage" | "message" | "bytes" | "total">[], workspaceName: string): TripProgress | null {
  let line = "";
  let fraction = 0;
  let landings = 0;
  for (const e of events) {
    switch (e.stage) {
      case "planned":
      case "consented":
        line = "Starting";
        break;
      case "packing":
        line = e.message.replace(/\.$/, "");
        break;
      case "uploading": {
        const what = landings > 0 ? " sessions" : "";
        const size = e.total === undefined ? "" : `${what === "" ? "" : ","} ${fmtBytes(e.total)}`;
        line = `Uploading${what}${size}`;
        if (e.bytes !== undefined && e.total !== undefined && e.total > 0) fraction = Math.max(fraction, e.bytes / e.total);
        break;
      }
      case "landing":
        landings += 1;
        line = `Landing on ${workspaceName}`;
        fraction = 1;
        break;
      case "done":
        line = "Done";
        fraction = 1;
        break;
      case "failed":
        return null;
    }
  }
  return events.length === 0 ? null : { line, fraction };
}

/** An export's events folded into the one progress line and its bar. The runtime packs and downloads the folder,
 * then packs and downloads the sessions as a second pass whose bytes start again at nought, so the pass is named by
 * counting the packings and the bar holds its high-water mark; a download is named by its total so the words hold
 * still while the bar moves. A failure has no step; the status line carries it. */
export function exportProgress(events: readonly Pick<ProjectExportEvent, "stage" | "bytes" | "total">[]): TripProgress | null {
  let line = "";
  let fraction = 0;
  let packings = 0;
  const pass = (): string => (packings > 1 ? "sessions" : "the folder");
  for (const e of events) {
    switch (e.stage) {
      case "packing":
        packings += 1;
        line = `Packing ${pass()}`;
        break;
      case "downloading":
        line = `Downloading ${pass()}${e.total === undefined ? "" : `, ${fmtBytes(e.total)}`}`;
        if (e.bytes !== undefined && e.total !== undefined && e.total > 0) fraction = Math.max(fraction, e.bytes / e.total);
        break;
      case "landing":
        line = "Landing on this Mac";
        fraction = 1;
        break;
      case "done":
        line = "Done";
        fraction = 1;
        break;
      case "failed":
        return null;
    }
  }
  return events.length === 0 ? null : { line, fraction };
}

/** A color as a Ghostty file writes it. */
export function hexColor({ r, g, b }: TerminalRgb): string {
  return `#${[r, g, b].map(c => c.toString(16).padStart(2, "0")).join("")}`;
}

export const NO_TERMINAL_CONFIG_LINE = "No Ghostty config on this computer; the terminal pane keeps its defaults.";

/** The person's terminal config as wsp terminal config prints it: the files read, then each key the pane honours as
 * the file would write it, so a line here can be pasted back into the config. */
export function terminalConfigLines(config: TerminalConfig): string[] {
  if (config.files.length === 0) return [NO_TERMINAL_CONFIG_LINE];
  const set = config.palette.filter(c => c !== null).length;
  const pair = (a: number, b: number): string => (a === b ? `${a}` : `${a},${b}`);
  const rows: [string, string | undefined][] = [
    ["font-family", config.fontFamily.length === 0 ? undefined : config.fontFamily.join(", ")],
    ["font-size", config.fontSize?.toString()],
    ["theme", config.theme],
    ["background", config.background && hexColor(config.background)],
    ["foreground", config.foreground && hexColor(config.foreground)],
    ["palette", set === 0 ? undefined : `${set} of 16 colors`],
    ["selection-background", config.selectionBackground && hexColor(config.selectionBackground)],
    ["cursor-color", config.cursorColor && hexColor(config.cursorColor)],
    ["cursor-style", config.cursorStyle],
    ["cursor-style-blink", config.cursorStyleBlink?.toString()],
    ["window-padding-x", config.windowPaddingX && pair(config.windowPaddingX.left, config.windowPaddingX.right)],
    ["window-padding-y", config.windowPaddingY && pair(config.windowPaddingY.top, config.windowPaddingY.bottom)],
    ["background-opacity", config.backgroundOpacity?.toString()],
    ["background-blur", config.backgroundBlur?.toString()],
  ];
  return [`Read ${config.files.join(", ")}`, ...rows.filter(([, value]) => value !== undefined).map(([key, value]) => `${key} = ${value}`)];
}
