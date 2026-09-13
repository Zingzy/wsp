// SPDX-License-Identifier: AGPL-3.0-only
// Binary units with one decimal for the wizard, the engine's stage lines, the
// runtime's import and export events and the app; a turn's duration as the chat's footer,
// the notify line and the cut line print it, and its cost. The files that keep their own
// rule are the exception list in the protocol format test, each with its reason.
import type { ContextMenuItem, GoldenMissingTool, GoldenStage, HarnessCatalog, HostsView, InitDraft, InitJob, InitPhase, InitRow, InitScreen, InitScreenId, InitSetup, LoginState, MachineSizeOffer, MachineState, PermissionEffect, PermissionOption, PermissionOutcome, PlaceView, ProjectExportEvent, ProjectGolden, ProjectImportEvent, ProjectSecret, SealedImage, SealedImageCopy, SealedImageExport, SessionEvent, SessionPermissionEvent, TerminalConfig, TerminalRgb, TitleSource, ToolPin, TurnRefusal, TurnResult, WorkspaceGlyph, WorkspaceSize, WorkspaceView } from "./index.js";
import { dotColour, effectiveOpacity, themeInk, type Rgb, type WorkspaceTheme } from "./workspace-look.js";
import { DEFAULT_PORT } from "./app-ports.js";
import { compareVersions } from "./semver.mjs";
import { folderName, parentFolderName } from "./project-path.js";
import { shellLine } from "./shell-quote.js";
import type { ThreadMessage } from "./thread-read.js";
const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** Bytes as a person reads them, in binary units: whole under a gigabyte, since a tenth of a megabyte is noise at that
 * scale, and GB with one decimal unless whole. */
export function fmtBytes(n: number): string {
  if (n < KIB) return `${n} B`;
  if (n < MIB) return `${Math.round(n / KIB)} KB`;
  if (n < GIB) return `${Math.round(n / MIB)} MB`;
  const gb = n / GIB;
  return `${Number.isInteger(Number(gb.toFixed(1))) ? Math.round(gb) : gb.toFixed(1)} GB`;
}

/** What a row reads where the catalog has measured no size. */
export const UNKNOWN_SIZE = "size unknown";

/** How often the agents ran a tool here, the one number a usage row shows. */
export const fmtCalls = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "call" : "calls"}`;

/** The line under a screen's card: the step's own count, then the whole image so far against the machine's disk. */
export const initTallyLine = (count: number, noun: string, used: number, total?: number): string => `${initTallyCount(count, noun)} · ${fmtBytesOfTotal(used, total)}`;
/** The tally's first half, the count of rows on the image, so a view can colour the estimate after it on its own. The
 * noun is the screen's plural ("agents", "tools"), or a word that does not count ("more") kept as it is. */
export const initTallyCount = (count: number, noun: string): string => `${noun.endsWith("s") ? plural(count, noun.replace(/s$/, "")) : `${count} ${noun}`} on the image`;
/** Two byte counts against each other, each under the byte rule ("4.9 GB of 20 GB"): the tally's running estimate
 * against the disk and the machine tab's memory and disk rows, each read in the tone the share earns; the first count
 * alone where there is no total. */
export const fmtBytesOfTotal = (used: number, total?: number): string => (total === undefined ? fmtBytes(used) : `${fmtBytes(used)} of ${fmtBytes(total)}`);

/** How many rows of a screen are on the image with these ticks and the bytes they come to: a locked row is on, a row
 * that takes an answer is not counted, and a row nothing measured adds nothing. */
export function initTallyOf(screen: Pick<InitScreen, "items">, ticks: ReadonlySet<string>): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const item of screen.items) {
    if (item.choices !== undefined) continue;
    if (!(item.lock === "on" || ticks.has(item.id))) continue;
    count += 1;
    if (typeof item.size === "number") bytes += item.size;
  }
  return { count, bytes };
}

/** The ticks of a screen as they stand: the draft kept on its step where the person left one, else what the host last
 * answered. The one rule for what a screen opens on and for what the estimate counts. */
export const initTicksOf = (screen: Pick<InitScreen, "ticks">, kept?: Pick<InitDraft, "ticks">): ReadonlySet<string> => new Set(kept?.ticks ?? screen.ticks);

/** The running estimate of the image in bytes: what the disk holds before any tick plus every screen's ticked rows as
 * they stand, drafts over answers. The one number every step's tally, the meter and Continue's refusal read. A client
 * passes the draft it holds and the host has not echoed yet, so a tick moves the number before the round trip. */
export function initImageBytes(job: Pick<InitJob, "disk" | "screens" | "drafts">, current?: { at: string; ticks: Iterable<string> }): number {
  const fixed = job.disk?.fixed ?? 0;
  return job.screens.reduce((sum, s) => sum + initTallyOf(s, current !== undefined && current.at === s.id ? new Set(current.ticks) : initTicksOf(s, job.drafts?.find(d => d.at === s.id))).bytes, fixed);
}

/** The tone a size is read in, by weight, the one table every size cell reads: a gigabyte and over is the danger
 * tone, 300 MB and over the warning tone, 100 MB and over the yellow tone, anything under muted. */
export type SizeTone = "danger" | "warning" | "yellow" | "muted";
const SIZE_TONES: readonly (readonly [number, SizeTone])[] = [
  [1024 * MIB, "danger"],
  [300 * MIB, "warning"],
  [100 * MIB, "yellow"],
];
export function sizeTone(bytes: number): SizeTone {
  return SIZE_TONES.find(([from]) => bytes >= from)?.[1] ?? "muted";
}

/** The screens where a person is choosing weight, whose size cells wear the weight tone. The agents screen's sizes
 * are muted: the agents are what the person came for, not a place to be warned off. */
const WEIGHED_SCREENS: ReadonlySet<InitScreenId> = new Set<InitScreenId>(["tools", "also"]);
/** The tone a row's size cell wears on a screen: the weight table where the screen weighs, muted elsewhere and where
 * nothing measured the row. */
export const initSizeTone = (screen: Pick<InitScreen, "id">, bytes: number | null): SizeTone => (bytes === null || !WEIGHED_SCREENS.has(screen.id) ? "muted" : sizeTone(bytes));

/** The tone of the disk meter and the tally's estimate by the share the estimate takes of the disk: muted under 70
 * percent, the warning tone from 70, the danger tone from 90 and when over. */
export function diskTone(used: number, total: number): "muted" | "warning" | "danger" {
  const share = total > 0 ? used / total : 1;
  if (share >= 0.9) return "danger";
  return share >= 0.7 ? "warning" : "muted";
}

/** The disk meter's tooltip: what the image holds against the machine's disk, and by how much it is over once it is;
 * the overshoot is said here and in Continue's refusal, nowhere else. */
export const initDiskLine = (used: number, total: number): string => `about ${fmtBytes(used)} of ${fmtBytes(total)} on the image${used > total ? `, ${initDiskOverLine(used - total)}` : ""}`;

/** The primary's refusal once the ticks pass the disk, and the tail of the meter's tooltip. */
export const initDiskOverLine = (over: number): string => `over by ${fmtBytes(over)}`;

/** Memory in GB as the size table names it: whole when whole, else one decimal; a size spec, not a byte count. */
const memGb = (memMb: number): number => Number((memMb / 1024).toFixed(1));

/** A size in css pixels, as the settings page states the text and sidebar sizes. */
export function fmtPx(px: number): string {
  return `${px} px`;
}

/** A machine size's memory with its unit. */
export function fmtMemGb(memMb: number): string {
  return `${memGb(memMb)} GB`;
}

/** What one of a machine's cpus is called: a provider's are virtual, this computer's are the cores it has. */
export type CpuWord = "vCPU" | "cores";

/** A size as the sidebar row, the Machine tab and the new-workspace form show it: "2 vCPU · 4 GB", or "10 cores · 16 GB"
 * in the word the machine's kind has for a cpu. A size offer is always a provider's, so the provider's word is the default. */
/** The size joins its words with no-break spaces, so a sentence carrying it never breaks between a number and its unit. */
export function fmtSize(size: WorkspaceSize, cpu: CpuWord = "vCPU"): string {
  return `${size.cpu}\u00a0${cpu}\u00a0·\u00a0${fmtMemGb(size.memMb).replace(" ", "\u00a0")}`;
}

/** What a computer of the person's own is worth saying in one line: the cores and memory it has, and the room left
 * where its threads work. The one reading, so the screen a computer joins on and the row it lands in later cannot
 * describe the same computer differently. A computer that would not say how much room it has leaves that out. The
 * whole line is joined with no-break spaces, fmtSize's own rule carried on: it is one phrase about one computer. */
export function placeFactsLine(shape: WorkspaceSize, diskFreeBytes?: number): string {
  const parts = [fmtSize(shape, "cores"), ...(diskFreeBytes === undefined ? [] : [`${fmtBytes(diskFreeBytes)} free`])];
  return parts.join(" · ").replace(/ /g, "\u00a0");
}

/** What a machine wsp neither forks nor pays for costs, on its row's cost line and the Machine tab's Cost row. */
export const FREE_WORD = "free";

/** What a pane prints in the slot a reading would fill on a kind whose machines serve that reading on no road: the
 * Machine tab's Live rows and the Processes table both read it, in place of a pending that would never settle. The
 * kind table says which kinds serve which reading, so a pane says this within one probe window. */
export const NOT_ON_THIS_KIND = "not on this kind";

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

/** The row a size names among the ones offered, with whatever that row carries beside the shape, or nothing where
 * the provider offers no such size. The one match, so a picker reading a size's rate and a refusal reading whether
 * it is offered cannot disagree about which row a size is. */
export function sizeOffer<T extends WorkspaceSize>(sizes: readonly T[], size: WorkspaceSize): T | undefined {
  return sizes.find(s => s.cpu === size.cpu && s.memMb === size.memMb);
}

/** Whether a size is one the provider offers; the golden's own size is taken without this check. */
export function offeredSize(sizes: readonly WorkspaceSize[], size: WorkspaceSize): boolean {
  return sizeOffer(sizes, size) !== undefined;
}

/** An awake rate in dollars an hour, at the fewest places that do not round the price: cents where cents are the
 * whole of it, three places where they are not, since a workspace at $0.018 an hour reads as $0.02 to the cent and
 * that is a fifth of the price. A third place that says nothing is not added: $0.09 is $0.09, not $0.090.
 *
 * Which it is, is read off the rounded thousandth and never off the number itself: a provider computes its rate
 * (Solari charges per vCPU-hour plus per GB-hour), so a real one arrives as 0.09000000000000001, and any test of
 * the float against its own cent form calls that noise a third place. The one rate rule, read by the size refusal,
 * the places table, the size pickers and the provider rows alike. */
export function fmtRate(usdPerHour: number): string {
  const mils = usdPerHour.toFixed(3);
  return `$${mils.endsWith("0") ? usdPerHour.toFixed(2) : mils}/hr`;
}

/** The one refusal every road gives a size the provider does not offer, malformed or merely absent: the word as it
 * was given, then every size that is offered with its rate. What happened, alone: each road joins its own fix to it
 * through refusalLine, since what to do about it is the road's (a flag at a terminal, a pick in the app). */
export function sizeRefusal(word: string, sizes: readonly MachineSizeOffer[]): string {
  const offered = sizes.map(s => `${sizeWord(s)} (${fmtRate(s.rateUsdPerHour)})`).join(", ");
  return `${word} is not a size this provider offers; the sizes are ${offered}`;
}

/** What to do about such a size on a road with no flag to name: the app's picker and the wire both ask for one of
 * the sizes the half above just listed. The command line names its own flag instead. */
export const SIZE_PICK_FIX = "Ask for one of those instead.";

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

/** How long a machine has been up, as the Machine tab reads it: minutes under an hour, hours and minutes under a
 * day, then days and hours. Coarser than a turn's duration on purpose: the figure is read once, not watched. */
export function fmtUptime(ms: number): string {
  const minutes = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A running clock on a row redrawn every tick: whole seconds, then the short style's minutes and seconds; tenths
 * would flicker. */
export function fmtElapsed(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1_000) : 0;
  return seconds < 60 ? `${seconds}s` : fmtDuration(seconds * 1_000);
}

/** Every spend figure a person reads, in one shape: cents, whatever the size. Three figures in one thread used to
 * read $0.51, $0.22 and $0.0000, and a reader cannot tell at a glance that the third is the smallest of them. A
 * turn under a cent reads $0.00, which is what it costs to the cent. */
export function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** The word beside a figure nobody is billed for: what the agent's own table lists for the tokens a turn spent, on
 * a computer whose turns run on the person's own sign-in. The composer's model menu says the whole of it in
 * whoPaysLines; this is the word the figure itself carries, where a person meets the figure long before the menu. */
export const LIST_PRICE_WORD = "list price";

/** A spend figure with the word that says what it is, where the surface has one to give it. */
const spendFigure = (usd: number, word: string | undefined): string => (word === undefined ? fmtCost(usd) : `${fmtCost(usd)} ${word}`);

/** How much of the reply a finished line carries: `tail`, its last line, which is what a person reads in a sidebar
 * row and what a wait answers with; `whole`, the final message entire, which is what a thread woken by the line acts
 * on without reading the transcript again. */
export type NotifyLength = "tail" | "whole";

/** The agent's own words at the length asked for, and nothing else: nothing at all where the turn left no text,
 * which a completed turn does (a harness that spent its tokens and answered with an empty message). A reader that
 * has to say whose words it is holding asks this beside notifyBody rather than reading the text twice. */
export function notifyReply(result: TurnResult, length: NotifyLength = "tail"): string | undefined {
  const text = result.text ?? "";
  return length === "tail" ? lastLine(text) : text.trim() === "" ? undefined : text.trim();
}

/** What the notify line ends with, and what a wait answers as the reply: the reply at the length asked for, or the
 * error when there is no reply. A turn that did not complete says its error first, since that is what whoever waits
 * needs. One rule for both lengths, so a tail can never say something the whole message does not. */
export function notifyBody(result: TurnResult, length: NotifyLength = "tail"): string | undefined {
  const reply = notifyReply(result, length);
  return result.status === "completed" ? reply ?? result.error : result.error ?? reply;
}

/** The tail alone: the length a person's sidebar row and a wait's reply field read. */
export function notifyTail(result: TurnResult): string | undefined {
  return notifyBody(result, "tail");
}

/** The one line a thread's end sends to whoever its start named, and the one a wait on it prints: the thread's first
 * eight characters, the outcome word with the duration and cost the harness reported, then the reply at `length`. */
export function notifyLine(threadId: string, result: TurnResult, length: NotifyLength = "tail"): string {
  const facts = [result.status, ...(result.durationMs !== undefined ? [fmtDuration(result.durationMs)] : []), ...(result.costUsd !== undefined ? [fmtCost(result.costUsd)] : [])];
  const body = notifyBody(result, length);
  return `thread ${threadId.slice(0, 8)} finished (${facts.join(", ")})${body !== undefined ? `: ${body}` : ""}`;
}

/** The line a wait prints when its deadline passed with every named thread still running: one thread by its first
 * eight characters, more by their count. */
export function waitTimedOutLine(threadIds: readonly string[], ms: number): string {
  const who = threadIds.length === 1 ? `thread ${threadIds[0]!.slice(0, 8)}` : fmtThreads(threadIds.length);
  return `${who} still running after ${fmtDuration(ms)}`;
}

/** What the threads a thread opened have spent, said as its own fact: this is their whole life, and the turn's own
 * figure counts none of their work. */
export function openedSpendPart(costUsd: number): string {
  return `${fmtCost(costUsd)} in threads it opened`;
}

/** The turn's own cost where a second figure stands beside it. The two count different things, one turn against
 * whole threads, so where both are shown each says which spend it is and neither can be read as the other. */
export function turnSpendPart(costUsd: number, word?: string): string {
  return `${spendFigure(costUsd, word)} this turn`;
}

/** What a settled turn says beside its outcome word, in the order every client shows it: how long it worked, what
 * it cost, and what the threads it opened cost where it opened any. The app's chat footer and the command line's
 * last line read from this one list. */
export function turnSettledParts(turn: { durationMs?: number | null; costUsd?: number | null }, openedCostUsd?: number | null, spendWord?: string): string[] {
  const opened = typeof openedCostUsd === "number" && openedCostUsd > 0;
  const parts: string[] = [];
  if (typeof turn.durationMs === "number") parts.push(`Worked for ${fmtDuration(turn.durationMs)}`);
  if (typeof turn.costUsd === "number") parts.push(opened ? turnSpendPart(turn.costUsd, spendWord) : spendFigure(turn.costUsd, spendWord));
  if (opened) parts.push(openedSpendPart(openedCostUsd));
  return parts;
}

/** The chat footer as one line, for a stream that has no footer: the outcome word, then what it worked and cost. */
export function turnSettledLine(result: TurnResult): string {
  return [result.status, ...turnSettledParts(result)].join(" · ");
}

/** The row a turn's end leaves in a read transcript: the footer above, and why it did not complete where it did
 * not, since a reader of a failed turn needs the reason with the word. */
export function turnEndLine(result: TurnResult): string {
  const failure = result.status === "completed" ? undefined : result.error;
  return failure === undefined ? turnSettledLine(result) : `${turnSettledLine(result)}: ${failure}`;
}

/** A turn the agent refused outright: it answered with an error line of its own and did none of the work. The word
 * is failed whatever the harness's own subtype said, and the sentence is the agent's with wsp's half after it where
 * the caller knows the road out. The reply is dropped, since a refusal is not a reply: every road reads a turn that
 * did not complete by its error alone, so one shape here is what keeps the sentence from being printed twice.
 * `cause` is what wsp classes the failure by; no door may read a cause out of the agent's words. */
export function refusedTurn(result: TurnResult, refusal?: { road?: string; cause?: TurnRefusal }): TurnResult {
  // The result's own text is the agent's sentence and the errors entry beside it is harness telemetry; a harness
  // that sends both would say the same thing twice, so the sentence wins and the entry is dropped with the reply.
  const said = (result.text ?? result.error ?? "").trim();
  const sentence = [said, refusal?.road ?? ""].filter(part => part.length > 0).join("; ");
  return {
    status: "failed",
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(sentence.length > 0 ? { error: sentence } : {}),
    ...(refusal?.cause !== undefined ? { refusal: refusal.cause } : {}),
  };
}

/** The clock a read prints beside a row, to the second, in the zone of the computer reading it, which is the
 * computer the app shows the same thread on; nothing for a row the runtime stamped no time on. */
export function fmtClock(at: number | undefined): string {
  return at === undefined ? "" : new Date(at).toTimeString().slice(0, 8);
}

/** One row of a read: who spoke and when on its own line, then the text under it, so a reply of many lines reads as
 * the agent wrote it and a row with no text of its own is still one row. */
export function threadRowLines(row: ThreadMessage): string[] {
  const clock = fmtClock(row.at);
  return [clock === "" ? row.who : `${row.who} ${clock}`, ...row.text.split("\n")];
}

/** A thread's messages as one printout, a blank line between rows. */
export function threadReadText(rows: readonly ThreadMessage[]): string {
  return rows.map(row => threadRowLines(row).join("\n")).join("\n\n");
}

/** What a read prints for a thread the transcript this host holds carries no message of: the cap dropped its rows,
 * or its turns are older than the stamp that names a thread. */
export const noMessagesLine = (threadId: string): string => `thread ${threadId.slice(0, 8)} has no messages in the transcript this host holds`;

/** What a read of the final reply alone prints for a thread whose first turn has not ended yet. */
export const noReplyLine = (threadId: string): string => `thread ${threadId.slice(0, 8)} has not replied yet`;

/** The row under a final reply the thread has already moved past: the turn that gave it is over and another is
 * working, so what is above is the report before this one, not the one being written. */
export const NEWER_TURN_LINE = "a newer turn is running; the reply above is the one before it";

/** One tool call's input, as the wire's delta carries it: the JSON the harness reported, already parsed. */
type ToolInput = Readonly<Record<string, unknown>>;

/** Which moment a call's line is written for: the call as the harness reported it, which is before it has run and
 * before any prompt it waits on is answered, or the result that says it ran. A row whose words differ between the
 * two carries both, so nothing reads as done before it is. */
type ToolMoment = "asked" | "done";

/** The line one tool name reads as at one of those moments; undefined when the call's input does not carry what
 * the line needs. */
type ToolLine = (input: ToolInput, moment: ToolMoment) => string | undefined;

/** What kind of item a call is to a client that groups its rows by kind, in the words the app's transcript uses. */
export type ToolItemType = "command_execution" | "file_change" | "web_search" | "collab_agent_tool_call" | "mcp_tool_call";

/** What a call asks of the machine, for the client that puts the ask to a person. */
export type ToolRequestKind = "command" | "file-read" | "file-change";

/** One tool's row: the line its call reads as, the input field a client shows for it, what kind of item the call is,
 * the paths it changed when it changes any, and whether it looked through the code. */
interface ToolRow {
  readonly line: ToolLine;
  readonly shows: readonly string[];
  /** The words a person reads for this kind of call, where the harness's own name for it is none: a row that names
   * no title is drawn by that name, which is what every tool a person already knows the word for wants. */
  readonly title?: string;
  /** What the row shows under the title, where the field it is in is not a plain string; `shows` covers the rest. */
  readonly detail?: (input: ToolInput) => string | undefined;
  readonly itemType?: ToolItemType;
  readonly requestKind?: ToolRequestKind;
  readonly paths?: (input: ToolInput) => readonly string[];
  readonly codeSearch?: boolean;
}

function toolField(input: ToolInput, name: string): string | undefined {
  const value = input[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** A tool a server lends the agent, whose name carries both: `mcp__<server>__<tool>` as every harness spells it. */
function serverTool(toolName: string): { server: string; tool: string } | undefined {
  const parts = toolName.split("__");
  return parts.length >= 3 && parts[0] === "mcp" && parts[1] !== "" ? { server: parts[1]!, tool: parts.slice(2).join("__") } : undefined;
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

const pathRow = (doing: string, did: string, field: string, requestKind: ToolRequestKind): ToolRow => ({
  line: (input, moment) => {
    const path = toolField(input, field);
    return path === undefined ? undefined : `${moment === "done" ? did : doing} ${path}`;
  },
  shows: [field],
  requestKind,
  ...(requestKind === "file-change"
    ? { itemType: "file_change" as const, paths: (input: ToolInput) => { const path = toolField(input, field); return path === undefined ? [] : [path]; } }
    : {}),
});

const aboutRow = (words: { doing: string; did?: string }, field: string, rest: Omit<ToolRow, "line" | "shows"> = {}): ToolRow => ({
  line: (input, moment) => {
    const what = toolField(input, field);
    return what === undefined ? undefined : `${(moment === "done" ? words.did : undefined) ?? words.doing} ${titleLine(what)}`;
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
  line: (input, moment) => {
    const paths = changedPaths(input);
    if (paths.length === 0) return undefined;
    const verb = moment === "done" ? "edited" : "editing";
    return paths.length === 1 ? `${verb} ${paths[0]}` : `${verb} ${plural(paths.length, "file")}`;
  },
  shows: [],
  itemType: "file_change",
  requestKind: "file-change",
  paths: changedPaths,
};

/** The harness's question tool, which asks the person and runs nothing. Its prompt is the question itself: the
 * options a person picks from are the tool's own, the pick rides back as the call's input, and there is no consent
 * in it to give. The name is the harness's; the rest of this file reads the shape, never the name. */
export const QUESTION_TOOL = "AskUserQuestion";

/** One choice on a question, as a row draws it: the words on its button and the sentence under them. */
export interface AskedOption {
  /** What the pick is named by on the wire; the label alone is what the harness reads back. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** One question the harness put to the person: the two or three words it heads it with, the sentence itself, the
 * choices, and whether it takes more than one of them. */
export interface AskedQuestion {
  /** What the harness keys the answer by: the question's own text. */
  readonly key: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly AskedOption[];
  readonly multiSelect: boolean;
}

/** Several picks travel as one option id, since one pick closes one prompt: a multi-select question's Answer button
 * names every box that is ticked, and a prompt carrying more than one question names one pick per question. */
const PICK_JOIN = "|";

const optionId = (question: number, option: number): string => `q${question}:o${option}`;

function askedOptions(raw: unknown, question: number): AskedOption[] {
  if (!Array.isArray(raw)) return [];
  const options: AskedOption[] = [];
  for (const entry of raw) {
    const fields = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as ToolInput) : undefined;
    const label = fields === undefined ? undefined : toolField(fields, "label");
    if (label === undefined) continue;
    options.push({ id: optionId(question, options.length), label, description: (fields === undefined ? undefined : toolField(fields, "description")) ?? "" });
  }
  return options;
}

/** The questions a call to the question tool carries, in the order it asked them; nothing for every other call and
 * for a question whose input has not finished arriving. A question with no choices is left out: there is no button
 * to draw for it and no pick to send back. */
export function askedQuestions(toolName: string, input: string): readonly AskedQuestion[] | undefined {
  const fields = toolInput(input);
  return fields === undefined ? undefined : permissionWords(toolName).questions?.(fields);
}

function questionsIn(fields: ToolInput): readonly AskedQuestion[] | undefined {
  const raw = fields["questions"];
  if (!Array.isArray(raw)) return undefined;
  const questions: AskedQuestion[] = [];
  for (const [at, entry] of raw.entries()) {
    const q = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as ToolInput) : undefined;
    const text = q === undefined ? undefined : toolField(q, "question");
    if (q === undefined || text === undefined) continue;
    const options = askedOptions(q["options"], at);
    if (options.length === 0) continue;
    questions.push({ key: text, header: toolField(q, "header") ?? "", question: text, options, multiSelect: q["multiSelect"] === true });
  }
  return questions.length === 0 ? undefined : questions;
}

/** The options a question's prompt carries on the wire: one per choice, each an answer rather than a consent, so
 * nothing offers to allow or refuse a call that only asks. Empty for every other kind of call, which keeps its
 * harness's own options. */
export function questionOptions(toolName: string, input: string): PermissionOption[] {
  const questions = askedQuestions(toolName, input) ?? [];
  return questions.flatMap(q => q.options.map(o => ({ id: o.id, label: o.label, effect: "answer" as const })));
}

/** One pick as the several options it names, or nothing when any of them is not on this prompt. Every reader of a
 * pick goes through here, so the rule that a multi-select answer is one id holding several lives in one place. */
export function pickedOptions(options: readonly PermissionOption[], picked: string): PermissionOption[] | undefined {
  const named = picked.split(PICK_JOIN).map(id => options.find(o => o.id === id));
  return named.length > 0 && named.every((o): o is PermissionOption => o !== undefined) ? named : undefined;
}

/** The one id a set of ticked boxes travels as. */
export const pickedOptionId = (ids: readonly string[]): string => ids.join(PICK_JOIN);

/** The call's input with the person's answer written into it, which is how the harness reads a pick: every question
 * keyed by its own text, a single-select question answered by the one label and a multi-select one by the labels it
 * took. Undefined when the picks name no question on this call. */
export function questionAnswerInput(toolName: string, input: string, picked: readonly string[]): Record<string, unknown> | undefined {
  const fields = toolInput(input);
  const questions = askedQuestions(toolName, input);
  if (questions === undefined || fields === undefined) return undefined;
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const labels = question.options.filter(o => picked.includes(o.id)).map(o => o.label);
    if (labels.length === 0) continue;
    answers[question.key] = question.multiSelect ? labels : labels[0]!;
  }
  return Object.keys(answers).length === 0 ? undefined : { ...fields, answers };
}

/** What the call itself reads as while it waits: the question, never the tool's own name, which is no word a
 * person knows. Registered in the tool table below by the same key the prompt's words are. */
const questionRow: ToolRow = {
  line: input => {
    const first = questionsIn(input)?.[0];
    return first === undefined ? undefined : `asked: ${first.question}`;
  },
  // No detail: the prompt under this row is the question, whole, and a row that repeated it would put the same
  // sentence on the screen twice.
  title: "Asked you",
  shows: [],
};

const questionAsk: PermissionWords = {
  lead: input => {
    const first = questionsIn(input)?.[0];
    return first === undefined ? undefined : { says: first.question };
  },
  questions: questionsIn,
  named: ["questions"],
};

/** Launching a subagent, under either name the harness gives that call. */
const agentRow: ToolRow = aboutRow({ doing: "agent:" }, "description", { itemType: "collab_agent_tool_call" });

/** Every tool a harness reports, one row per name, Claude's and Codex's alike: what the command line writes for the
 * call and what the app's transcript makes of it come from the same row, so a new tool is a row here and nothing
 * else. A name with no row reads as itself, by the fields below. */
const TOOL_ROWS: ReadonlyMap<string, ToolRow> = new Map<string, ToolRow>([
  ["Bash", shellRow],
  ["command_execution", shellRow],
  ["Read", pathRow("reading", "read", "file_path", "file-read")],
  ["Write", pathRow("writing", "wrote", "file_path", "file-change")],
  ["Edit", pathRow("editing", "edited", "file_path", "file-change")],
  ["MultiEdit", pathRow("editing", "edited", "file_path", "file-change")],
  ["NotebookEdit", pathRow("editing", "edited", "notebook_path", "file-change")],
  ["file_change", changeRow],
  ["Grep", aboutRow({ doing: "searching code for", did: "searched code for" }, "pattern", { codeSearch: true })],
  ["Glob", aboutRow({ doing: "searching code for", did: "searched code for" }, "pattern", { codeSearch: true })],
  ["WebSearch", aboutRow({ doing: "searching the web for", did: "searched the web for" }, "query", { itemType: "web_search" })],
  ["web_search", aboutRow({ doing: "searching the web for", did: "searched the web for" }, "query", { itemType: "web_search" })],
  ["WebFetch", aboutRow({ doing: "fetching", did: "fetched" }, "url", { itemType: "web_search" })],
  ["Task", agentRow],
  ["Agent", agentRow],
  [QUESTION_TOOL, questionRow],
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
  return fields === undefined ? name : row.line(fields, "asked") ?? name;
}

/** The same call once its result says it ran: the past of the line it opened with, which is the only place a client
 * may write one. Nothing for a call whose row reads the same at both moments, and for one whose input never became
 * an object, so the call's own answer stands there instead. */
export function toolDoneLine(toolName: string | undefined, input: string): string | undefined {
  const row = TOOL_ROWS.get(toolName ?? "tool");
  const fields = row === undefined ? undefined : toolInput(input);
  if (row === undefined || fields === undefined) return undefined;
  const done = row.line(fields, "done");
  return done === undefined || done === row.line(fields, "asked") ? undefined : done;
}

/** What a tool call is, for a client whose rows carry more than one line: the field to show, the shell command and
 * what it was for, the paths the call changed, and the kinds a client groups by. Input that is not an object yet is
 * shown as it stands, since a call streams in and a row is drawn before it is whole. */
export interface ToolCallFacts {
  /** The words for this kind of call, where its row names them; absent leaves the harness's own name to stand. */
  readonly title?: string;
  readonly detail?: string;
  readonly command?: string;
  readonly description?: string;
  readonly changedFiles?: readonly string[];
  readonly itemType?: ToolItemType;
  readonly requestKind?: ToolRequestKind;
}

export function toolCallFacts(toolName: string, input: string): ToolCallFacts {
  const row = TOOL_ROWS.get(toolName);
  const itemType = row?.itemType ?? (serverTool(toolName) === undefined ? undefined : "mcp_tool_call");
  const kinds = {
    ...(itemType !== undefined ? { itemType } : {}),
    ...(row?.requestKind !== undefined ? { requestKind: row.requestKind } : {}),
  };
  const titled = row?.title === undefined ? {} : { title: row.title };
  const fields = toolInput(input);
  if (fields === undefined) return { ...kinds, ...titled, ...(input.length > 0 ? { detail: input } : {}) };
  const detail = row?.detail?.(fields) ?? firstField(fields, [...(row?.shows ?? []), ...SHOWN_FIELDS]);
  const shell = row?.requestKind === "command";
  const command = shell ? toolField(fields, "command") : undefined;
  const description = shell ? toolField(fields, "description") : undefined;
  const changedFiles = row?.paths?.(fields) ?? [];
  return {
    ...kinds,
    ...titled,
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

/** The sentence a harness stamps on a result it wrote for the agent and not for the person; it carries handles the
 * agent needs and reads as an instruction to a model, and it is cut by every row that shows it. Matched on the
 * stamp rather than on the whole sentence, which differs per kind of thing launched. */
const INTERNAL_RESULT_MARK = "This tool result is internal metadata";

/** Whether the harness marked this result its own note to the agent, so nothing draws it. The one test, read by the
 * line a call's row shows and by the transcript that folds a call's result. */
export function internalToolResult(text: string): boolean {
  return text.includes(INTERNAL_RESULT_MARK);
}

/** What one tool call answered, as the line under the call: its first line by the rule the call's own line is cut
 * by, with the word ahead of it when the harness marked the call failed. Nothing when a call that worked answered
 * with nothing, since a blank line says less than no line. */
export function toolResultLine(text: string, isError = false): string | undefined {
  if (internalToolResult(text)) return undefined;
  const first = titleLine(text);
  if (!isError) return first === "" ? undefined : first;
  return first === "" ? "failed" : `failed: ${first}`;
}

/** What a terminal watching a turn prints once one call's result lands: what a call that changed a file changed,
 * in the past, since the answer such a call hands back is the harness telling itself the write landed; and for
 * every other call what came back, which is what a person is watching it for. Nothing where neither has anything
 * to say. A call still waiting on a person has no result and so no line here, which is what keeps the past out of
 * a terminal until the thing has happened. */
export function toolAnsweredLine(toolName: string | undefined, input: string, result: { text: string; isError?: boolean }): string | undefined {
  if (result.isError !== true && toolCallFacts(toolName ?? "tool", input).requestKind === "file-change") {
    const did = toolDoneLine(toolName, input);
    if (did !== undefined) return did;
  }
  return toolResultLine(result.text, result.isError === true);
}

/** What a call that launched a subagent said the task was, from the call's own input: the title of the fold that
 * subagent's lines sit under. Nothing where the call named no task, and the fold then reads the call. */
export function subagentTaskLine(input: string): string | undefined {
  const fields = toolInput(input);
  const described = fields === undefined ? undefined : toolField(fields, "description");
  return described === undefined ? undefined : titleLine(described);
}

/** What a prompt raised inside a subagent's own run says above it, so a person answering knows which of them is
 * asking rather than reading one unowned question. */
export const subagentAskerLine = (task: string): string => `${task} asks`;

/** A count with its noun, the noun pluralised by an s: the one rule every line that counts rows, sessions, calls,
 * threads or a plan's files reads, so none of them says "1 sessions". A noun that does not take an s is spelled by
 * its caller. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// --- the image and its copies, as `wsp image` and Settings > Image read them ---

/** What a record with no vault says: its copies ask for every sign-in again until the next version holds them. */
export const IMAGE_NO_VAULT = "no sign-ins held; cut the next version to hold them";
/** Where a run with nobody at its terminal reads the passphrase an export is sealed to; never a flag, since every
 * process on a computer can read another's command line. */
export const IMAGE_PASSPHRASE_ENV = "WSP_IMAGE_PASSPHRASE";
/** What a host that has sealed nothing says. Named apart from the attachment lines beside it: those are pictures. */
export const NO_SEALED_IMAGE = "no image yet; run wsp init to build one";

/** Whether a copy stands on the record as it is now: built at the record's hash, which is the whole of it. The
 * version is the place's own manifest number and says nothing about which record the copy came from, so a second
 * place's v1 built from the record's v2 is current. A copy with no hash was built before hashes were recorded and
 * no record matches it. The one rule: the refusal that will not rebuild a current copy reads it too. */
export function copyIsCurrent(image: Pick<SealedImage, "hash">, copy: Pick<SealedImageCopy, "hash">): boolean {
  return copy.hash === image.hash;
}

/** The states a login ends in with something of it on the machine, which is what the vault then carries: signed in
 * there, copied from this computer, or there with no status command to prove it. The rest left nothing behind. */
const LOGIN_ON_MACHINE: readonly LoginState[] = ["signed-in", "copied", "not-verified"];

/** How many of this image's logins ended with something on the machine for the vault to hold. */
export function sealedLoginsHeld(image: Pick<SealedImage, "logins">): number {
  return image.logins.filter(l => LOGIN_ON_MACHINE.includes(l.state)).length;
}

/** The record in one line: the version, its hash, how many sign-ins it holds and what its disk came to. */
export function sealedImageLine(image: SealedImage): string {
  const held = image.vault === undefined ? IMAGE_NO_VAULT : `${plural(sealedLoginsHeld(image), "sign-in")} held, ${plural(image.vault.paths, "path")}`;
  const size = image.usedBytes === undefined ? [] : [fmtBytes(image.usedBytes)];
  return [`${image.name} v${image.version}`, image.hash, held, ...size, `sealed on ${image.sealedFrom}`].join(" · ");
}

/** The two words a copy's standing is said in, either of which fits the slot the longer one needs. */
export const COPY_CURRENT = "current";
export const COPY_STALE = "stale";

/** How a copy stands against the record, as the one word a person reads: current when it was built from the record
 * as it is now, stale when it was built from an older one. Nothing at all where the record holds no vault: such a
 * record was read back off its own copies rather than written at a seal, so it has nothing to judge them by. The
 * one home for the word and for that gate; `wsp image` and Settings > Image both read it. */
export function copyStanding(image: Pick<SealedImage, "hash" | "vault">, copy: Pick<SealedImageCopy, "hash">): string | undefined {
  if (image.vault === undefined) return undefined;
  return copyIsCurrent(image, copy) ? COPY_CURRENT : COPY_STALE;
}

/** One place's copy in one line: the place, the version it holds, its size where the provider reports one, and
 * whether it stands on the record as it is now. */
export function sealedCopyLine(image: SealedImage, copy: SealedImageCopy): string {
  const size = copy.sizeBytes === undefined ? [] : [fmtBytes(copy.sizeBytes)];
  const standing = copyStanding(image, copy);
  return [copy.place, `v${copy.version}`, ...size, ...(standing === undefined ? [] : [standing])].join(" · ");
}

/** What a build at a place came to, as the line a person reads after it: the copy that place now holds, and, when
 * the place already stood on the record, that nothing was built. */
export function sealedBuiltLine(image: SealedImage, built: { copy: SealedImageCopy; built: boolean }): string {
  const line = sealedCopyLine(image, built.copy);
  return built.built ? line : `${line} · already built from this image; nothing was built`;
}

/** One project image under the image, as a line: the workspace it was taken off, the projects on that disk and when. */
export function sealedProjectLine(project: ProjectGolden): string {
  return [`project ${project.workspaceName}`, project.projects.map(p => p.name).join(", "), project.createdAt].join(" · ");
}

/** What an export wrote, as the line a person reads after it. */
export function sealedExportLine(exported: SealedImageExport): string {
  return `${exported.path} · ${fmtBytes(exported.bytes)} · opens with the passphrase you typed and nothing else`;
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
  return `Its record and ${fmtThreads(threads)} leave this computer; the computer it ran on is already gone.`;
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
  return cutLine(/^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line, OPENING_TITLE_MAX);
}

/** The most characters the third line of a workspace row holds: the row leaves 201 px for text at the sidebar's
 * default 256 px and 11 px mono fits 30 of them there, so a longer line is cut by the width with no say in where.
 * Here rather than in the app because the lines written for that slot are written here too, and the cut is what
 * takes the half that says what to do off a line nobody measured. */
export const ROW_LINE_MAX = 30;

/** Text cut to at most room characters, at a word boundary where one fits, with the ellipsis counted inside the
 * room and drawn only where something was taken off. One rule for every line a surface cuts itself: a thread's
 * title from its opening turn, a sidebar row's third line. */
export function cutLine(text: string, room: number): string {
  if (text.length <= room) return text;
  const head = room - ELLIPSIS.length;
  return `${wordsWithin(text, head) ?? text.slice(0, head).replace(SEPARATOR_TAIL, "")}${ELLIPSIS}`;
}

/** What a cut leaves dangling at its edge: the space it broke on, the punctuation that hung off the word before,
 * and the middle dot a row's line parts its facts with. */
const SEPARATOR_TAIL = /[\s,;:·]+$/;

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

/** Which rule ended a turn: idle is the turn doing nothing at all for the limit, TURN_IDLE_MS's own rule, and wall
 * is the cap on one turn's run. */
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

/** The turn's error when the harness process ended before any result, in the words of what actually ended it rather
 * than in a number nobody can act on. Exit 127 is the shell saying the binary was not on PATH, so the line names the
 * binary and the PATH the launch exported, or that it exported none. A signal is the process being killed, named.
 * A code the run has is the code. No code at all is a run whose leader is gone without leaving one, which is a kill
 * the road could not name; where nothing of the agent ever came back, the launch never reached it and says so. */
export function harnessExitLine(bin: string, exitCode: number | null, path: string | undefined, ended: HarnessEnded = {}): string {
  if (exitCode === 127) {
    const searched = path === undefined ? "the launch exported no PATH, the machine's own was searched" : `PATH searched: ${path}`;
    return `${bin} was not found on PATH (exit 127); ${searched}`;
  }
  if (ended.signal !== undefined) return `${bin} was killed (${ended.signal}) before it answered`;
  if (exitCode !== null) return `${bin} exited with code ${String(exitCode)} before emitting a result`;
  if (ended.reached === false) return `the launch never reached ${bin}: its run ended before the agent said a word`;
  return `${bin} was killed before it answered`;
}

/** What the road that watched the run knows about how it ended, beyond the code: the signal that ended it where it
 * saw one, and whether the agent ever announced itself. A road that knows neither leaves both out and the code
 * stands on its own. */
export interface HarnessEnded {
  /** The signal's own name, as the computer running the process spells it. */
  readonly signal?: string;
  /** False says nothing of the agent ever came back, so the run ended before the launch became a turn. */
  readonly reached?: boolean;
}

/** What a person's line calls each field a request carries, for the refusal that has to name one. The wire's own
 * names are never printed: a person types flags and words, not fields. A field with no row here is one no line
 * names on its own, and the refusal says the line instead. */
const REQUEST_WORDS: Readonly<Record<string, string>> = {
  workspaceId: "the workspace",
  threadId: "the thread",
  sessionId: "the thread",
  argv: "the command",
  prompt: "the message",
  cwd: "--cwd",
  model: "--model",
  effort: "--effort",
  permissionMode: "--access",
};

/** What the host would not read, out of the refusal its own validator answers a request with. The list carries the
 * wire's field names and every op the host serves, so none of it reaches a person: what comes back is the one thing
 * they can act on, which of their arguments the host refused, or that this wsp and the host are different builds.
 * Nothing when the refusal is a sentence, which is every refusal wsp writes itself. */
export function validatorRefusal(error: string): string | undefined {
  let issues: unknown;
  try {
    issues = JSON.parse(error);
  } catch {
    return undefined;
  }
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const rows = issues.map(issue => (typeof issue === "object" && issue !== null ? (issue as { code?: unknown; path?: unknown }) : {}));
  if (!rows.every(row => typeof row.code === "string" && Array.isArray(row.path))) return undefined;
  const fields = rows.map(row => (row.path as unknown[])[0]).filter((field): field is string => typeof field === "string");
  // A discriminator the host does not know is this wsp asking for an op the host does not serve, which no argument
  // of the line can fix: the two builds differ.
  if (rows.some(row => row.code === "invalid_union_discriminator") && fields.every(field => field === "op")) {
    return "the host does not serve this line; it runs another version of wsp, restart it with wsp up";
  }
  const named = [...new Set(fields.map(field => REQUEST_WORDS[field]).filter((word): word is string => word !== undefined))];
  return named.length === 0 ? "the host would not read this line" : `the host would not read ${named.join(" and ")} on this line`;
}

/** The host's one line when it asked the person's login shell for their PATH and got none back: why, and that the
 * PATH the launch handed it stands. A host started from Finder or the Dock has only launchd's four system folders,
 * so this line is what says why no agent of theirs was found afterwards. */
export function loginPathLine(why: string): string {
  return `login shell: no PATH read (${why}); this host keeps the PATH it was started with`;
}

/** The turn's error when a host that came back looked for the turn's run on the machine and the machine no longer
 * holds it: the run's files were swept, so nothing the agent did while the host was away can be read back. */
export const RUN_GONE_LINE = "the machine no longer holds this turn's run, so nothing of it can be read back";

/** What a command waiting on a turn is told when the host it asked stops: the run is the machine's, not the host's,
 * so it goes on and its reply lands in the thread whether or not this command is still there to see it. */
export const HOST_STOPPING_LINE = "the host is restarting; the turn goes on and its reply lands in the thread";

/** What a machine is called when the provider reports it running and the road every command takes is dead: whose
 * machine it is, which one, and the guest's own words, so the failure reads as the provider's and not as wsp's. */
export function guestUnusableLine(provider: string, machineId: string, detail: string): string {
  return `${provider} left ${machineId} running but nothing on it can run: ${detail}`;
}

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
 * how many folders the level holds, where it sits, and how many of it are hidden, whether or not those are listed. */
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
 * the host chose it when none was named, so the person did not see it go by. The caller passes the folder the host
 * answered with rather than the one it asked for; absent, the workspace's kind named none and the machine's own home
 * is where the command ran. */
export function execFolderLine(cwd: string | undefined): string {
  return `ran in ${cwd ?? "the home folder"}`;
}

/** The turn's error when the harness's result arrived while the agent's own background tasks were still running: the
 * harness kills them with the turn and nothing wakes the thread when they would have finished, so the turn ended
 * before the work it started did. */
export function backgroundTasksLine(running: number): string {
  return `ended with ${plural(running, "background task")} running`;
}

/** The reason a status carries when the runtime's idle policy napped a workspace, with the one reading of it back
 * beside it: the runtime stamps the nap through `of` and the app's paused line takes the window out through
 * `windowIn`, so the words and their parse are one thing and a rewording moves both at once. */
export const IDLE_REASON = {
  of: (windowMs: number): string => `idle ${Math.round(windowMs / 60_000)} min`,
  /** The window inside that reason, as its own words (`20 min`); nothing for a reason of any other shape, which is
   * every reason a nap the person asked for or a wake wrote. */
  windowIn: (reason: string | undefined): string | undefined => (reason === undefined ? undefined : (/^idle (\d+ min)$/.exec(reason)?.[1] ?? undefined)),
} as const;

/** The one line the sidebar puts above the rows while the probes fail before leaving this computer; the rows keep
 * their last word. It names what could not be reached, not the computer: the road out was up and every other name
 * resolved while this one did not (measured 2026-09-07). */
export const PROVIDER_UNREACHED_LINE = "Solari cannot be reached from this computer";

/** What a window on another computer says while the wsp it shows has gone quiet: the computer that host runs on is
 * asleep or off, and the workspaces on every other computer keep working. It reads as a fact in the sidebar's own
 * prose line and as the send's reason, never as an alert: nothing is broken and nothing is lost. */
export const HOST_ASLEEP_LINE = "your Mac is asleep · threads on your other computers keep running";
export const HOST_ASLEEP_SEND = "your Mac is asleep; new turns start when it wakes";

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

/** Which road a caller takes to its children's ends, in the two sentences every door quotes whole: the skill's rules,
 * the tool descriptions and the command line. Which one holds is decided by whether the caller is a thread, which its
 * launch environment says; nothing else decides it, and a blocking wait is neither road. */
export const NOTIFY_CALLER = "A wsp thread starts every child with --notify me and ends its turn, and each child's finished line wakes it with that child's whole report";
export const COORDINATOR_HANDOFF =
  "A caller that is not a wsp thread cannot be woken at all, so it takes the reply of one turn as the call returns, and hands work of more than one turn to a single coordinator thread on the local workspace";

/** The refusal of a start whose turn token no turn on this host carries: the host minted every token it knows into a
 * turn's own launch, so one it does not know is a caller naming a turn it is not, and reading it as the person would
 * put a builder's report in front of nobody. */
export const NO_SUCH_TURN = "no turn on this host carries that token; only wsp running inside a turn has one, and a turn that ended has none";

/** What a send meets when its thread's last turn has replied but its agent process is still running (a child it did
 * not wait for, a lingering task): the row still reads running and is not free for a new turn, so the message waits
 * for that process rather than starting a second agent in the same worktree. Not a refusal: it says where the
 * message went, and every door shows it in these words. The thread is named by its title where the caller holds
 * one; a caller without one says nothing, since an id names no thread to the person reading the line. */
export function stillWorkingLine(title?: string): string {
  const named = title === undefined || title.trim() === "" ? "This thread" : title.trim();
  return `${named} replied, still working; the message runs as its next turn once that process exits`;
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

/** Every refusal a terminal reads is two halves, what happened and then what to do about it, in one or two lines:
 * the law the app's first-run slot draws in its two inks, in the one sentence stderr gets. A refusal that only
 * names the fault leaves the person to guess the fix, which is the whole complaint. The first half is closed here
 * when it closes itself with nothing, since many of these sentences are written for the app as well, where they
 * stand alone and nothing follows them. */
export function refusalLine(happened: string, fix: string): string {
  const said = happened.trimEnd();
  return `${said}${/[.!?:]$/.test(said) ? "" : "."} ${fix}`;
}

/** The command's name, said once. A line refused inside a verb is printed behind the verb's name, so a sentence
 * that opens with that same name would say it twice; the prefix is the one home for it, and the sentence may open
 * with it or not without either of them knowing about the other. */
export function sayOnce(prefix: string, message: string): string {
  const name = prefix.replace(/:\s*$/, "");
  return name !== "" && (message === name || message.startsWith(`${name} `)) ? message : `${prefix}${message}`;
}

/** A word no command answers to, named: the first half of that refusal, wherever the word was typed. */
export const unknownWordLine = (word: string): string => `unknown command: ${word}.`;

/** Where the list of words is: the second half of an unknown word's refusal. The help runs to hundreds of lines,
 * so a typo is pointed at it and never handed it. */
export const runForTheList = (list: string): string => `Run ${list} for the list.`;

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
 * itself only retries the 401 and dies. `login` is the catalog's command for signing in on a machine. It is also
 * what the composer's model menu shows in place of its footer's source line, which is why it names the workspace
 * rather than the machine it runs on. */
export function codexNotSignedInLine(login: string): string {
  return `Codex is not signed in where this workspace runs; run ${login} there`;
}

/** The line when codex's provider reads its key from an environment variable the machine does not set. */
export function codexMissingEnvLine(name: string): string {
  return `Codex's model provider reads its key from the environment variable ${name}, which is not set on this machine`;
}

/** The one line under the composer's model lists: the binary that filled them, else whose table stood in and what it
 * was pinned from, or the adapter's own words for why the binary gave nothing. Every word comes from the catalog being
 * shown, so a tab never borrows another agent's binary, reason or pin. `where` is the word for where the turn runs,
 * which the caller reads off the workspace: the binary the line names is the one on that computer and on no other.
 * The slot is one line at the popup's width, 290px of the 10px mono it draws in, so the agent is named once and the
 * pin's own words carry the rest. */
export function catalogSourceLine(catalog: HarnessCatalog, where: string): string {
  const version = catalog.version;
  if (catalog.source === "harness") return `${catalog.label}${version === null ? "" : ` ${version}`} on ${where}`;
  const why = catalog.refusal ?? `${catalog.harness} table`;
  return version === null ? why : `${why} · ${version}`;
}

/** What the foot of the composer's model menu says after that line, and the only place it is said. The rows above it
 * carry the agent's own dollar prices per million tokens, which a person with no account anywhere read as a bill from
 * wsp: so the foot names whose sign-in the turn runs on and where that sign-in is, and says the prices are the agent's
 * own. Both sentences hold on every workspace and only the word for where the turn runs changes, so a person who moves
 * a thread to another computer reads the same two sentences with one word swapped. The prices sentence is dropped
 * where the menu lists no model, since there is then no price on the screen for it to be about. */
export function whoPaysLines(catalog: HarnessCatalog, where: string): string[] {
  const runs = `Threads run on ${catalog.label}'s own sign-in on ${where}, which costs this wsp nothing.`;
  return catalog.models.length === 0 ? [runs] : [runs, "The prices are its list prices, not a bill."];
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
  return `Out of memory (${fmtBytes(r.used)} of ${fmtBytes(r.total)} used, load ${r.load1.toFixed(1)}) when the workspace last answered; the work on it took the memory, not a fault of the computer it runs on`;
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
  if (bigger === undefined) return "No size with more memory is offered; run less in the workspace at once";
  return `A workspace on ${fmtSize(bigger)} (${fmtRate(bigger.rateUsdPerHour)}) fits more; pick it when you make the next one`;
}

/** The machine row's line while the runtime replaces a daemon older than this wsp, and the line it shows instead
 * when the replacement failed. A person is never told the helper is called a daemon: they did not install it and
 * cannot run it, so its name would only be one more thing to know. Neither line carries the reason a deploy gave:
 * that is an npm log a person can do nothing with, hundreds of characters wide in a row that fits about thirty,
 * and it names the daemon in its own words. The runtime logs it for whoever runs the host. */
export const DAEMON_UPDATING = "updating the helper";
export const DAEMON_UPDATE_FAILED = "could not update the helper";

/** The same two lines for the daemon the runtime is putting back after the machine answered with none, in the
 * words of the thing a person is waiting on: the row is grey because nothing answers, and this says wsp is on it
 * rather than that the machine is lost. */
export const DAEMON_RESTARTING = "restarting the helper";
export const DAEMON_RESTART_FAILED = "could not restart the helper";

/** The same two lines for the first daemon a machine ever takes. A machine somebody already owned had none until
 * wsp put one there, so nothing about it is being updated or put back, and a person watching that machine's row
 * is told what is happening on it rather than that something they never installed is being replaced. */
export const DAEMON_INSTALLING = "installing the helper";
export const DAEMON_INSTALL_FAILED = "could not install the helper";

/** Why a nap's vault export was refused: its size against the cap, both in the one byte rule. */
export function vaultOverCapLine(bytes: number, capBytes: number): string {
  return `the export was ${fmtBytes(bytes)}, over the ${fmtBytes(capBytes)} cap`;
}

/** A store an agent keeps for every project that an export could not read on the machine: nothing from it travelled,
 * so the project's rows in it stayed there rather than every other project's leaving with them. */
export function storeUnreadLine(store: string, why: string): string {
  return `could not read ${store} on the machine, so nothing from it travelled: ${why}`;
}

/** The verdict when a nap could not store a fresh backup, said once with whatever the machine answered on the
 * line's title: the machine's own words name folders and commands nobody asked for, and a person reading this
 * needs to know where their files stand. The second clause is what is true of this workspace: an earlier nap's
 * backup is what a rebuild would restore, older than the files the person left, and a workspace whose naps have
 * never stored one has nothing off the machine at all. */
export function vaultKeptLine(w: Pick<WorkspaceView, "vaultedAt">): string {
  return `the nap saved no backup; ${w.vaultedAt === undefined ? "nothing is saved off the machine" : "what was saved before is kept"}`;
}

/** The verdict when a guest refused the hostname the fork asked for. Naming a fork is cosmetic, so the create goes
 * on and the workspace answers to the name the machine booted with; the guest's own refusal rides the title. */
export const HOSTNAME_KEPT = "hostname not set; the workspace keeps the machine's own name";

/** The same step where the guest took the name, in the one form the creation log's lines are written in: lower
 * case, no full stop, the workspace and never the machine's own id. */
export function hostnameSetLine(host: string): string {
  return `hostname set to ${host}`;
}

/** The creation log's line for the fork itself, in the words the app says a workspace and a computer in. */
export function startingLine(name: string, where: string): string {
  return `starting ${name} on ${where}`;
}

/** The last line of a create, as the word table ends it. */
export const CREATE_READY = "ready";

/** The day of a stamp in UTC, which is as far as this fact goes: the vault that stands can be days old, and the
 * time of day is noise on a row about thirty characters wide. */
const onDay = (iso: string): string => iso.slice(0, 10);

const staleWord = (w: Pick<WorkspaceView, "vaultedAt">): string => (w.vaultedAt === undefined ? "no backup" : `no backup since ${onDay(w.vaultedAt)}`);

/** The row's and the Machine tab's word for a machine whose last nap could not store a fresh vault: a rebuild
 * restores the vault that still stands, which is as old as this says, and a machine that never stored one has
 * nothing to restore at all. Null while the last nap stored its vault, which is every machine's steady state. One
 * form on every surface, short enough that the sidebar row shows all of it: the sizes it was refused for are on
 * the Machine tab's own line, not in here. */
export function vaultStaleLine(w: Pick<WorkspaceView, "vaultedAt" | "vaultRefused">): string | null {
  return w.vaultRefused === undefined ? null : staleWord(w);
}

/** What moving a workspace onto a newer image does, the words every client shows before it runs. The home travels,
 * less the files the image's own recipe wrote and this workspace never changed, whose newer copies come with the
 * image; an archive carries no deletion, so a file the person took out of a folder the image writes into comes back
 * with it; nothing installed outside the home travels at all, and the machine it all runs on is replaced. */
export const IMAGE_MOVE_CONFIRM =
  "Your home folder moves to the new copy, minus the files the image itself wrote and you never changed, which come from the new image; a file you deleted from a folder the image writes into comes back with it. Anything installed outside your home comes from the new image, and everything running in this workspace stops with it.";

/** What a move found nothing to do: the workspace already stands on the newest version, so no machine was replaced
 * and no file was judged. Said in place of the kept line, which would otherwise claim files came across. */
export const IMAGE_ALREADY_NEWEST = "already on the newest version of its image, so nothing moved";

/** What the move came to, for the line the command line, the tool and the app print after it: the workspace's own
 * edits to the image's files, which travelled, or the note that the image it stood on lists no files of its own
 * (sealed before they were recorded), so its whole home came across and nothing of the newer image's stands. */
export function imageKeptLine(kept: readonly string[], fallback = false): string {
  if (fallback) return "the image it stood on lists no files of its own, so its whole home came across and none of the new image's copies stand";
  if (kept.length === 0) return "every file the image wrote came from the new image; none of them had been changed here";
  return `kept ${plural(kept.length, "changed file")}: ${nameList([...kept].sort())}; every other file the image wrote came from the new image`;
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

/** The machine row's line when a record that said paused met a machine the provider was running all along (a nap
 * whose pause never took, a resume nobody wrote): the record followed the fact and nothing was resumed. */
export const ALREADY_RUNNING = "already running at the provider";

/** The machine row's line when a record marked gone met a machine the provider still holds, running or paused: the
 * state read by id decides, so the record is gone no more and no rebuild abandoned a healthy machine. */
export const NOT_GONE = "not gone at the provider after all; the record follows the state read";

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

/** The one sentence every machine road answers with on a computer set up with no machine provider key: wsp init took
 * the local road, so this computer is a workspace and there is nothing to fork, pause or seal until a key is here.
 * The provider module a keyless host wires says it, and so does the command line before it asks for anything. */
export const NO_PROVIDER_LINE = "no machine provider is set up on this computer, so wsp forks no machines here; set SOLARI_API_KEY and run wsp init again to build your image";

/** Where a Solari key comes from, spelled once for the terminal's ask, the modal's guide and its link. */
export const SOLARI_CONSOLE = "console.getsolari.com";

/** What a person calls a provider's key and where they get one, keyed by the word WSP_PROVIDER holds. The host's
 * provider registry reads its keyName and keyConsole from here and the app's provider rows read the same, so the
 * screen that asks for a key and the terminal that asks for it say one thing. A provider that takes no key has no
 * row. */
export const PROVIDER_KEY_WORDS: Record<string, { keyName: string; keyConsole?: string }> = {
  box: { keyName: "Box API key", keyConsole: "ascii.dev" },
  solari: { keyName: "Solari API key", keyConsole: SOLARI_CONSOLE },
};

/** Every word of the six screens that build the image, opened from Settings under the title the image section
 * gives them. Micro-labels are the caps mono words over a screen, headlines the one sentence under them, keycaps
 * the one primary button each screen has. Nothing here asks the person to run a command, and nothing here is a
 * word for a computer or a provider: those are PLACES_WORDS. */
export const CLOUD_SETUP_WORDS = {
  choice: {
    headline: "What goes on your image",
    top: "What your agents need goes on one image, built once and copied for every workspace",
    manual: "Choose what goes on the image",
    agent: "Let an agent choose from your usage",
    agentWith: "with",
    /** An agent here whose thread wsp cannot hand the recipe tools at launch: shown, never offered. */
    noTools: "no wsp tools yet",
    /** What the agent row says with no agent on this computer at all. */
    none: "no agent here",
    keycap: "Continue",
  },
  keys: {
    headline: "Your Solari key",
    top: "Solari runs the computers your workspaces sit on",
    solari: "API key",
    /** The empty field's ghost: the start every Solari key has, and no more. */
    placeholder: "slr_live_...",
    where: "Get one at Solari",
    /** Why Save is disabled, as its tooltip. */
    pasteFirst: "paste the key first",
    saved: "saved",
    unset: "not set",
    keycap: "Save",
    /** Under the field when the provider answered and refused what was typed; its own status and word follow. */
    refused: "Solari refused this key",
    /** The build's line for a key already saved that the provider refuses, read before the first stage. */
    refusedSaved: "Solari refused the saved key",
    /** Under the field when nothing came back about the key at all; what this computer saw follows. */
    unchecked: "Solari could not be reached to check the key",
    /** What the Save keycap says after a check nothing answered, since pressing it again is worth something. */
    retry: "Try again",
    /** What the build offers when the saved key was refused: back to this step, not another build. */
    changeKey: "Change the key",
    /** The quiet link under a saved key's dots that empties the field for a new one. */
    change: "Change",
  },
  screen: {
    keycap: "Continue",
    back: "Back",
    build: "Build",
    again: "Start over",
    /** A sign-in row whose tool is off the image: its picker is fixed on skip. */
    notOnImage: "not on the image",
    /** A sign-in row the catalog locked out. */
    leftAlone: "left alone",
    /** A sign-in row whose tool stops on a question nobody but the person can answer, so the machine is no road for it. */
    asksYou: "asks questions only you can answer",
    /** The disk ring's name for the tooltip's reader. */
    disk: "Disk on the image",
  },
  ask: {
    headline: "Your first cloud workspace",
    top: "A copy of the image as soon as the build finishes",
    name: "Name",
    folder: "Project folder",
    optional: "optional",
    choose: "Choose",
    /** Why the build keycap is held while the name field is empty: without a name nothing is forked, so a folder
     * typed beside it would have nowhere to land. */
    needsName: "give the workspace a name",
  },
  build: {
    headline: "Building your image",
    top: "The computer starts, installs what you ticked and is saved as the image every workspace starts from",
    /** The one stage row the sign-ins fold into, its sub-rows one per sign-in. */
    signingIn: "Signing in on the computer",
    /** The slide the build becomes while that stage runs: room to act on each sign-in. */
    slideHeadline: "Sign in on the computer",
    slideTop: "Each one opens a page on this computer, and the image keeps the sign-in",
    open: "Open sign-in",
    retry: "Retry",
    codeAsk: "Paste the code from the page",
    codeSubmit: "Submit",
    keeps: "You can close this. The build keeps going and wsp tells you when it needs you",
    cancel: "Cancel the build",
    /** Why the cancel link is disabled while the seal runs: the host's refusal and the app's tooltip, one sentence. */
    cannotStop: "The image is being saved. The snapshot and the save cannot be stopped.",
    cancelSure: "Stop the build",
    cancelWhy: "The computer it was building on is thrown away and nothing is saved",
    cancelKeep: "Keep building",
    done: "Your image is ready",
    /** The sentence under that title: the running one would say the machine is still being saved. */
    doneTop: "Your image is built; every workspace starts from it",
    failed: "The build stopped",
    /** The headline of a build the person stopped, so the screen never reads as the machine's doing. */
    stopped: "You stopped the build",
    keycap: "Open workspace",
    again: "Start over",
  },
  agent: {
    headline: "Reading what your agents used",
    top: "Your agent reads this computer and writes the recipe the next screens start from",
    /** What the thread this road opens is called, which is what the sidebar's row for it reads. */
    title: "Build your image",
    /** The link to the thread doing the work, which the sidebar focuses. */
    open: "Open the thread",
    /** The headline once the turn ended without the recipe, and the two ways on from there. */
    failed: "Your agent stopped",
    /** The sentence under it when nothing named a reason, which is a job stopped from another client. */
    stopped: "The thread ended before the recipe was written",
    retry: "Retry",
    again: "Start over",
    /** What the block under the title says before the thread's first line. */
    waiting: "waiting for the thread's first line",
  },
  reading: {
    headline: "Reading this computer",
    top: "What is installed here and what your agents used decides what the image starts with",
    /** The one row the card shows until the first fact lands, so the work reads as started. */
    first: "This computer",
  },
  needsYou: {
    /** The one action on the toast and the one thing a system notification's click does. */
    open: "Open",
  },
  create: {
    /** Why a new cloud workspace is held back while the image is still being built; the stage count follows it. */
    building: "the image is still building",
    /** The same where no image is sealed and no build runs, which is a computer nothing has been built on. */
    none: "build your image first",
    /** The word beside that sentence, which opens the screens that build it. */
    build: "Build your image",
    /** The word beside the building sentence, which opens the build the count is of. */
    open: "Open the build",
  },
} as const;

/** The state of a sign-in as a word, the one spelling the terminal's rows and the modal's rows print. */
export const LOGIN_STATE_WORDS: Record<LoginState, string> = {
  "signed-in": "signed in",
  "not-signed-in": "not signed in",
  copied: "copied",
  "not-verified": "not verified",
  skipped: "skipped",
};

/** The word for a job that waits on the person rather than the machine: the answers, or a sign-in's page. */
const WAITING_FOR_YOU = "waiting for you";

/** The job's phase as the muted mono word a row or a footer prints. */
export function initPhaseWord(phase: InitPhase): string {
  switch (phase) {
    case "agent":
      return "agent writing the recipe";
    case "reading":
      return "reading this computer";
    case "answering":
      return WAITING_FOR_YOU;
    case "building":
      return "building";
    case "signing-in":
      return "signing in";
    case "sealing":
      return "sealing";
    case "finishing":
      return "finishing";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

/** The words a build row's state is written in, one table for the host that sets them and the client that reads them;
 * a sign-in row's other words are LOGIN_STATE_WORDS. */
export const INIT_ROW_STATES = {
  waiting: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
  forking: "forking",
  forked: "forked",
  importing: "importing",
  imported: "imported",
  /** A sign-in whose page waits for the person. */
  open: "waiting for you",
  /** A stage running only in the sense that the provider has no room yet: the account is at its machine cap. */
  slot: "waiting for a machine slot",
  /** A first workspace or its project the build ended before reaching. */
  notMade: "not made",
  /** A machine a stop could not reach the provider to kill, being killed again until it is. */
  retrying: "machine still running, retrying",
  /** That machine once the provider took the kill: nothing is billing. */
  gone: "gone",
  /** The stage a person's stop ended: over, but nothing failed, so the row never wears the failure's cross. */
  stopped: "stopped",
  /** A sign-in answered with an API key the home held, so the machine has it and nothing is asked. */
  keySet: "key set",
  /** A step the build left out: a sign-in it never reached, or a first workspace it carried no name for. */
  skipped: "skipped",
  /** An agent on this computer whose config carries the wsp tools. */
  mcpAdded: "MCP added",
} as const;

/** A sign-in row's word once its outcome is in, the app's and wsp setup's spelling, drawn for the computer the run
 * reads; the terminal's own table of the same outcomes keeps LOGIN_STATE_WORDS. The word is what a row prints and
 * never what a client reads: the outcome travels beside it as the row's login. */
export const INIT_SIGN_IN_WORDS: Record<LoginState, (platform: "darwin" | "linux") => string> = {
  "signed-in": () => INIT_ROW_STATES.done,
  "not-signed-in": () => "not signed in",
  copied: platform => `copied from ${thisComputer(platform)}`,
  "not-verified": () => "not verified",
  skipped: () => INIT_ROW_STATES.skipped,
};

/** A sign-in row's outcome as it travels: the name every client reads and, beside it, the word drawn for the
 * computer that ran the sign-in. The two are set together, so no row can carry one computer's word under another's
 * outcome. */
export const initSignInOutcome = (login: LoginState, platform: "darwin" | "linux"): Pick<InitRow, "state" | "login"> => ({ state: INIT_SIGN_IN_WORDS[login](platform), login });

/** Every build stage in plain words, the one table the app's rows and the terminal's lines read. */
export const GOLDEN_STAGE_WORDS: Record<Exclude<GoldenStage, "failed">, string> = {
  creating: "Creating the machine",
  "deploying-daemon": "Installing the base tools",
  "applying-setup": "Applying your setup",
  "uploading-files": "Copying your files",
  "installing-harness": "Installing agents",
  "installing-tools": "Installing tools",
  "installing-mcp": "Installing MCP servers",
  ready: "Checking the machine answers",
  snapshotting: "Taking the snapshot",
  promoting: "Saving the image",
  "smoke-forking": "Checking a fork boots",
  sealed: "Finishing",
};

/** The stages the provider gives no progress for: the snapshot and the save go to their end with nothing to say in
 * between, so the row counts its own seconds while one runs. */
export const GOLDEN_STAGE_TIMED: ReadonlySet<GoldenStage> = new Set<GoldenStage>(["snapshotting", "promoting"]);

/** A stage's row id, the one spelling the host writes and a client reads. */
export const initStageRowId = (stage: GoldenStage): string => `stage/${stage}`;

/** Whether a row is one of the stages that count their own seconds. */
export const initRowTimed = (row: Pick<InitRow, "id">): boolean => [...GOLDEN_STAGE_TIMED].some(stage => row.id === initStageRowId(stage));

/** A row's clock while it runs: whole seconds under a minute, then minutes and seconds. */
export const initElapsedLine = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1_000))}s` : fmtDuration(ms));

/** The snapshot stage's one line: what is being snapshotted in words a person can use, never the snapshot's name,
 * and the size when the builder's disk could be read. */
export const snapshotStageLine = (bytes: number | undefined): string => `snapshotting${bytes === undefined ? "" : ` about ${fmtBytes(bytes)}`}, usually under a minute`;

/** The save stage's one line. */
export const SAVING_IMAGE_LINE = "saving the image";

/** The one sentence on a sign-in the person is waited on for, beside the way to act: what the machine waits on, never
 * the command it ran, and short enough to share the action line with the code and the keycap uncut. A page that shows
 * a code or hands one back has the machine waiting for that code; any other page is open on this computer. A row
 * nobody is waited on for has no sentence. */
export function initSignInLine(row: Pick<InitRow, "state" | "code" | "finish">): string | undefined {
  if (row.state !== INIT_ROW_STATES.open) return undefined;
  return row.code !== undefined || row.finish === "code" ? "waiting for the code" : "the page is open on this computer";
}

/** The id of the wsp tools screen's row for an agent, the one the app answers for it from the first launch's own answer. */
export const wspToolsRowId = (agent: string): string => `wsp-tools/${agent}`;

/** The name a first workspace takes when nobody names one: what the terminal falls back to and what the app's name
 * field opens on, so the two roads cannot drift apart. */
export const FIRST_WORKSPACE = "first";

/** The sentence under the first workspace's title: when it comes and on what, from the recipe's own numbers. */
export const initForkLine = (size: WorkspaceSize): string => `Forked from the image as soon as the build finishes, on a ${fmtSize(size)} machine`;

/** What a sign-in row says when the run ended without reaching it. */
export const SIGN_IN_NEVER_REACHED = "the build never reached this sign-in";
/** What any other row says when the build ended with it unfinished, whether or not it had started. */
export const NEVER_REACHED = "the build ended before this step";
/** What the first workspace's row says when the build carried no name, which is the answer that forks nothing. */
export const NO_FIRST_WORKSPACE = "no name was given, so nothing was forked";

/** The state word of a sign-in row while its page waits for the person. */
export const SIGN_IN_OPEN_STATE = INIT_ROW_STATES.open;

/** The state word of an agent on this computer whose config carries the wsp tools. */
export const MCP_ADDED_WORD = INIT_ROW_STATES.mcpAdded;

const ROW_OVER: ReadonlySet<string> = new Set([INIT_ROW_STATES.done, INIT_ROW_STATES.failed, INIT_ROW_STATES.stopped, INIT_ROW_STATES.forked, INIT_ROW_STATES.imported, INIT_ROW_STATES.keySet, INIT_ROW_STATES.mcpAdded, INIT_ROW_STATES.skipped, INIT_ROW_STATES.notMade, INIT_ROW_STATES.gone]);

const ROW_UNRUN: ReadonlySet<string> = new Set([INIT_ROW_STATES.skipped, INIT_ROW_STATES.notMade, INIT_ROW_STATES.stopped]);

/** Whether a row's state is one it ended on without anything having run: the build never reached it, or a person's
 * stop ended it. The count leaves these out of its done, and a glyph gives them the ring they waited with rather
 * than a check, which would read as work that happened. */
export const initRowUnrun = (state: string): boolean => ROW_UNRUN.has(state);

/** The end states that are not an end well: what the count leaves out of its done, so a build that failed, was
 * stopped, or never reached a stage never reads complete. */
const ROW_UNDONE: ReadonlySet<string> = new Set([INIT_ROW_STATES.failed, ...ROW_UNRUN]);

/** Whether a row is a failure to show as one: the stage that failed, and the sign-in or the stage it folds into whose
 * sign-in ran out, which must never wear a tick. The one answer to "this sign-in ran out", so the cross, the
 * attention mark and the Retry keycap all read it and none of them spells it again. */
export const initRowFailed = (row: Pick<InitRow, "state" | "login">): boolean => row.state === INIT_ROW_STATES.failed || row.login === "not-signed-in";

/** Whether a row has ended: what the progress count and a section's count read. A sign-in answers from its outcome,
 * so a row a Linux host worded for itself ends the same as a Mac's; every other row from the word it prints. */
export const initRowOver = (row: Pick<InitRow, "state" | "login">): boolean => row.login !== undefined || ROW_OVER.has(row.state);

/** Where a stopped build was, from the stage that was running: one spelling for the terminal's stop line and the
 * app's sentence, since the stage names read as sentence openings ("Creating the machine"). */
export const initStageWhile = (stage: string): string => `while ${stage.charAt(0).toLowerCase()}${stage.slice(1)}`;

/** The opening of every stop line, terminal and app alike: where the run was when it stopped. What follows it is
 * what became of the machine, which differs by who is reading. */
export const initStoppedAt = (where: string): string => `Stopped ${where}.`;

/** What the app says after that opening when the provider would not take the kill: the terminal tells the person
 * how to finish it themselves, the app does not, because the host is already trying again and its row says so. */
export const STOP_LEFT_MACHINE_LINE = "The machine did not stop yet; wsp keeps trying.";

/** A machine row's name: the builder, never its provider id, which is the host's to hold and no sentence's to say. */
export const MACHINE_ROW_LABEL = "The builder";

/** What a stopped build says of its machine once the provider took the kill: the same words in the terminal and the app. */
export const MACHINE_GONE_LINE = "The machine is gone; nothing is billing.";

/** A stage's line for a machine its rollback could not remove, with the provider's own refusal: it goes in the stage's
 * block, never in the headline, which stays the failure's own sentence; the machine's row carries the retries. */
export const machineLeftLine = (reason: string): string => `the machine could not be removed and bills on: ${reason}`;

/** What the sidebar's keycap says while a machine an earlier build left is still being removed: the one line that
 * keeps a machine from billing unseen once the setup has moved on to another job. */
export const MACHINE_SWEEP_LINE = "a machine from the last build is still being removed";

/** What a build says stopped it when nothing on this computer could reach anything. */
export const NETWORK_LOST_LINE = "This computer lost its network";

/** The failures a provider client raises when the network is gone rather than when the provider refused. */
const OFFLINE_FAILURE = /^fetch failed$|\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETDOWN|ENETUNREACH|EHOSTUNREACH)\b/;

/** The sentence a stopped build shows for what happened: this computer's own word when every part of the error is
 * the network going away, else the error's parts said once. A run that failed the same way twice reports it twice;
 * the person reads one reason, not a list. */
export function initStoppedLine(error: string): string {
  const parts = [...new Set(error.split(";").map(p => p.trim()).filter(p => p !== ""))];
  if (parts.length === 0) return error;
  return parts.every(p => OFFLINE_FAILURE.test(p)) ? NETWORK_LOST_LINE : parts.join("; ");
}

/** Whether the job's phase is one it ends on. */
export const initJobOver = (phase: InitPhase): boolean => phase === "done" || phase === "failed" || phase === "cancelled";

/** Whether the job is on the build: from the machine booting to the first workspace, the stretch the count is over. */
export const initJobBuilding = (phase: InitPhase): boolean => phase === "building" || phase === "signing-in" || phase === "sealing" || phase === "finishing";

/** Whether the job's step is the agent's own: the agent road while its thread writes the recipe, and a job that
 * ended there, which is the step that carries Retry. A job that ended with screens ended past this step, on the
 * build. One rule, so the app's sheet and the terminal pick the same step for one job. */
export const initAgentStep = (job: Pick<InitJob, "road" | "phase" | "screens">): boolean =>
  job.road === "agent" && (job.phase === "agent" || (initJobOver(job.phase) && job.screens.length === 0));

/** The sentence a sign-in whose page is open makes: one spelling for the sidebar's line, the toast and a system
 * notification. */
const signInTo = (label: string): string => `sign in to ${label}`;

/** The sign-in row whose page waits for the person, if one does. */
const openSignIn = (rows: InitJob["rows"]): InitJob["rows"][number] | undefined => rows.find(r => r.kind === "sign-in" && r.state === SIGN_IN_OPEN_STATE);

/** What the job waits on the person for, or nothing: a sign-in whose page is open on the machine and nothing else
 * today. Only a wait the person is not already looking at counts, so the screens they just opened are not one; the
 * phase word says where those stand. The host writes the job's needsYou from this and every surface reads that
 * field, so nothing derives the wait twice. */
export function initNeedWhat(job: Pick<InitJob, "rows">): string | undefined {
  const open = openSignIn(job.rows);
  return open === undefined ? undefined : signInTo(open.label);
}

/** What the app says when it needs the person: the toast's opening and a system notification's title. */
export const NEEDS_YOU = "wsp needs you";

/** The one line the toast and a system notification say for a need. */
export const initNeedsYouLine = (what: string): string => `${NEEDS_YOU}: ${what}`;

/** Whether a sentence standing in the toast is a need's, so a need ending takes its own line away and no other. */
export const isNeedsYouLine = (line: string): boolean => line.startsWith(`${NEEDS_YOU}: `);

/** What a window or tab title leads with while a need stands, so a person reading only the title sees it. */
export const NEEDS_YOU_MARK = "• ";

/** The title with the mark on it while a need stands and without it otherwise, from a title that may already carry
 * one: the same title goes through this on every change, so the mark can never double or stick. */
export function titleWithNeed(title: string, needed: boolean): string {
  const plain = title.startsWith(NEEDS_YOU_MARK) ? title.slice(NEEDS_YOU_MARK.length) : title;
  return needed ? `${NEEDS_YOU_MARK}${plain}` : plain;
}

/** Whether a machine an earlier build left is still being removed: the row the host's sweep rides on whatever job
 * is current. */
export const initSweeping = (rows: readonly InitRow[]): boolean => rows.some(r => r.kind === "machine" && r.state === INIT_ROW_STATES.retrying);

/** The one line the collapsed sidebar row shows for a running job: the sign-in waited on while one is open, then a
 * machine still being removed, since that one bills while nobody looks, then the phase with the count of stages
 * done while it builds, the phase word alone otherwise. */
export function initProgressLine(job: Pick<InitJob, "phase" | "rows" | "progress">): string {
  const open = openSignIn(job.rows);
  if (open !== undefined) return signInTo(open.label);
  if (initSweeping(job.rows)) return MACHINE_SWEEP_LINE;
  const word = initPhaseWord(job.phase);
  return initJobBuilding(job.phase) && job.progress.total > 0 ? `${word} · ${job.progress.done}/${job.progress.total}` : word;
}

/** The facts the sidebar's button and the build screen's bar draw: the rows over as a fraction of the total (0 before
 * the build has rows), and whether the job waits on the person rather than on the machine, which is the host's own
 * needsYou field and nothing derived beside it. */
export function initProgressState(job: Pick<InitJob, "progress" | "needsYou">): { fraction: number; waitingOnYou: boolean } {
  return { fraction: job.progress.total > 0 ? job.progress.done / job.progress.total : 0, waitingOnYou: job.needsYou !== undefined };
}

/** The id of the stage row the build's sign-ins fold into. */
export const SIGN_IN_STAGE_ID = "stage/sign-ins";

/** What the stage the sign-ins fold into stands at, from the sign-ins themselves. A run-out hands the stage its own
 * outcome and its own word, so the stage says what the row under it says on whichever computer wrote it. */
function signInStageState(signIns: readonly InitRow[]): Pick<InitRow, "state" | "login"> {
  if (signIns.some(r => r.state === SIGN_IN_OPEN_STATE)) return { state: SIGN_IN_OPEN_STATE };
  if (signIns.some(r => r.state === INIT_ROW_STATES.running)) return { state: INIT_ROW_STATES.running };
  if (!signIns.every(r => initRowOver(r))) return { state: signIns.every(r => r.state === INIT_ROW_STATES.waiting) ? INIT_ROW_STATES.waiting : INIT_ROW_STATES.running };
  const ranOut = signIns.find(r => initRowFailed(r));
  if (ranOut !== undefined) return { state: ranOut.state, login: ranOut.login };
  // A build that ended before it reached any of them signed none in, so the fold says so rather than done.
  if (signIns.every(r => r.state === INIT_ROW_STATES.skipped)) return { state: INIT_ROW_STATES.skipped };
  return { state: INIT_ROW_STATES.done };
}

/** The build's list as the app draws it: stages only, in the job's order, the sign-ins folded into one stage row where
 * the first of them sits, whose state is the sign-ins' own (waiting for you while a page waits on the person, running
 * while one runs, not signed in once every one is over and one ran out, done once every one is over well, waiting
 * before any starts); the agent rows are not build stages and leave. The sign-ins come back beside it, for the stage's sub-rows. */
export function initBuildRows(rows: readonly InitRow[]): { rows: InitRow[]; signIns: InitRow[] } {
  const signIns = rows.filter(r => r.kind === "sign-in");
  const out: InitRow[] = [];
  let folded = false;
  for (const row of rows) {
    if (row.kind === "agent") continue;
    if (row.kind !== "sign-in") {
      out.push(row);
      continue;
    }
    if (folded) continue;
    folded = true;
    out.push({ id: SIGN_IN_STAGE_ID, kind: "stage", label: CLOUD_SETUP_WORDS.build.signingIn, ...signInStageState(signIns) });
  }
  return { rows: out, signIns };
}

/** How many of the build's stages ended well, of all of them: the one count a build has, read by the line along the
 * card's top edge, the count beside the title and the host's own progress field, so the sidebar and the sheet can
 * never say two things. Stages alone, so the bar measures the build and not the agents given the tools, the first
 * workspace or its project; it takes the rows initBuildRows hands over, with the sign-ins folded into their stage.
 * A stage that failed, that a stop ended, or that the build never reached is over without having run, so a build
 * that stopped never reads complete however early it stopped. */
export function initStageCount(rows: readonly InitRow[]): { done: number; total: number } {
  const stages = rows.filter(r => r.kind === "stage");
  return { done: stages.filter(r => initRowOver(r) && !ROW_UNDONE.has(r.state)).length, total: stages.length };
}

/** Where a step sits in the steps its run shows, over the title ("2/4"): the steps the person sees, the build or the
 * first workspace counted as the last, a step with nothing to pick not counted since it is not shown. */
export const initStepCounter = (at: number, total: number): string => `${at}/${total}`;

/** The count as words: `3 of 12`. */
export const initStageCountLine = (count: { done: number; total: number }): string => `${count.done} of ${count.total}`;

/** What a road to a new cloud workspace is held back with: the sentence every surface says and the word on the
 * action that opens the setup where the job stands. */
export interface CloudCreateRefusal {
  readonly line: string;
  readonly word: string;
}

/** Why a new cloud workspace cannot be asked for yet, or null when it can. A workspace is forked from the sealed
 * image, so a computer with none has nothing to fork: while the build runs the person is told where it stands, and
 * with no build at all they are sent to the setup. A sealed image holds nothing back, whatever a later build does,
 * since its head is there to fork. */
export function cloudCreateRefusal(state: { hasGolden: boolean | null; job: Pick<InitJob, "phase" | "rows"> | null }): CloudCreateRefusal | null {
  if (state.hasGolden !== false) return null;
  const words = CLOUD_SETUP_WORDS.create;
  if (state.job === null || !initJobBuilding(state.job.phase)) return { line: words.none, word: words.build };
  return { line: `${words.building} · ${initStageCountLine(initStageCount(initBuildRows(state.job.rows).rows))}`, word: words.open };
}

/** The sidebar button's words for a running job: `waiting for you` while the person is waited on, the progress line
 * otherwise. */
export function initButtonLine(job: Pick<InitJob, "phase" | "rows" | "progress" | "needsYou">): string {
  return initProgressState(job).waitingOnYou ? WAITING_FOR_YOU : initProgressLine(job);
}

/** The provider's own answer about a key: the status it replied with and the word it used, so a person reads whose
 * refusal they are looking at rather than ours. */
export function providerSaidLine(status: number, said: string): string {
  return said === "" ? String(status) : `${status} ${said}`;
}

/** Under the keys field when the provider answered and refused the key typed there. */
export function keyRefusedLine(said: string): string {
  return `${CLOUD_SETUP_WORDS.keys.refused}: ${said}`;
}

/** The same for a key already saved, which is what the build reads before its first stage. */
export function savedKeyRefusedLine(said: string): string {
  return `${CLOUD_SETUP_WORDS.keys.refusedSaved}: ${said}`;
}

/** Either place when nothing came back about the key at all: what this computer saw instead, with Try again beside it. */
export function keyUncheckedLine(said: string): string {
  return `${CLOUD_SETUP_WORDS.keys.unchecked}: ${said}`;
}

/** How a terminal run closes when the check stopped it before the first stage. The refusal itself is said above this
 * line, so this one carries the way on alone; wsp init asks for a key it can use, so running it again is that road. */
export const SAVED_KEY_STOPPED_LINE = "Save a key Solari takes and run wsp init again; nothing booted, and the recipe is kept.";

/** What the machine the build boots costs, said once under the key screen's title from the backend's own rate. */
export function initCostLine(size: WorkspaceSize, rateUsdPerHour: number): string {
  return `A ${fmtSize(size)} workspace costs about $${rateUsdPerHour.toFixed(2)} an hour while it runs and naps when idle`;
}

/** The cloud setup as wsp setup prints it: which keys are held, the agents here with their tools, the price, and the
 * job's phase with each of its rows when one runs or ran. */
export function initSetupLines(setup: InitSetup): string[] {
  const held = (yes: boolean): string => (yes ? CLOUD_SETUP_WORDS.keys.saved : CLOUD_SETUP_WORDS.keys.unset);
  const agents = setup.agents.length === 0 ? "none found" : setup.agents.map(a => (a.configured ? `${a.name} (${MCP_ADDED_WORD})` : a.name)).join(", ");
  const keys = Object.entries(setup.keys).map(([provider, yes]) => `${PROVIDER_KEY_WORDS[provider]?.keyName ?? provider}: ${held(yes)}`);
  const lines = [...keys, `Agents here: ${agents}`];
  if (setup.pricing !== null) lines.push(initCostLine(setup.pricing.size, setup.pricing.rateUsdPerHour));
  const job = setup.job;
  if (job === null) {
    lines.push("No setup is running; the app's Image section starts one.");
    return lines;
  }
  lines.push(`Setup on the ${job.road} road: ${initProgressLine(job)}${job.error !== undefined ? ` (${job.error})` : ""}`);
  for (const r of job.rows) lines.push(`  ${r.label}: ${r.state}${r.page !== undefined ? ` ${r.page}` : ""}${r.code !== undefined ? ` code ${r.code}` : ""}${r.detail !== undefined ? ` (${r.detail})` : ""}`);
  if (job.workspace !== undefined) lines.push(`Workspace ${job.workspace.name} (${job.workspace.id}) is up.`);
  return lines;
}

/** The first message of the thread the agent road opens on this computer: read this computer with recipe_scan, write
 * the recipe with recipe to the path the job reads it from, and ask the person nothing, since they review every row
 * on the screens that follow. The two tools are named as the only road on purpose: a thread that reached for the
 * command line instead spent its turn on one permission prompt per `sed` over its own tool results (seen 2026-09-10),
 * and the launch carries the wsp server so both tools are there to call. */
export function initAgentPrompt(recipePath: string): string {
  return [
    "Write the recipe for this person's wsp machine image from what their agents actually used on this computer.",
    "Use the wsp tools recipe_scan and recipe, and nothing else: run no commands and read no files.",
    "Call recipe_scan first and read every row's recommended value and its reason.",
    `Then call recipe once, with tick set to used, set for every row whose reason says it is worth changing, signin for every sign-in row at its recommended choice, and out set to ${recipePath}.`,
    "Ask them nothing: they review every row in the app once the file is written.",
    "Reply with one line saying the recipe is written.",
  ].join(" ");
}

/** What the agent step says when the thread's turn ended and no recipe arrived at the path the brief named: the
 * turn's own reason where it had one, and what the file was waited on for. A recipe that was already beside the
 * state is not this thread's, so this is the line even when a file is sitting there. */
export function initAgentNoRecipeLine(recipePath: string, reason?: string): string {
  return `the thread ended without writing ${recipePath}${reason === undefined || reason === "" ? "" : `: ${reason}`}`;
}

/** What a local workspace's machine is, in every sentence and every row that names it: the refusals below, the
 * sidebar row's second line and the Machine tab's lineage all read this one phrase. */
export const THIS_COMPUTER = "this computer";

/** The one sentence for the local workspace a run just recorded: wsp init's last tick and a host asked to serve a
 * state with nothing in it both say it, so this computer is named the same way whichever road wrote the record. */
export const thisComputerLine = (name: string, id: string): string => `Workspace ${name} (${id}) is ${THIS_COMPUTER}; its threads run here, under your own sign-ins.`;

/** What an ssh workspace's computer is, in every sentence and every row that names it: a computer of the person's
 * own that wsp reaches and never runs. The sidebar row prints it on line two, so it is a person's words. */
export const OVER_SSH = "a computer over ssh";

/** What a place's machine is, in every sentence and every row that names it: a computer of the person's own that
 * dialled this host and holds the link, so wsp drives it with the daemon protocol and never made it. */
export const JOINED_COMPUTER = "a computer you joined";

/** What a cloud workspace's machine is in a sentence that names it: a machine wsp forked at a provider and pays for,
 * whether the provider runs virtual machines or containers. A refusal on one says this rather than borrowing this
 * computer's words, since what it cannot do is the provider's limit and not the machine being the person's own. */
export const MACHINE_WSP_FORKS = "a machine wsp forks";

/** What the computer wsp is reading is called on the screens that read it: a Mac by the name its owner uses for it,
 * any other computer the plain word. The one place that word is decided, so no screen tells a Linux reader the tool
 * was built for somebody else. */
export const thisComputer = (platform: "darwin" | "linux"): string => (platform === "darwin" ? "this Mac" : THIS_COMPUTER);

/** Whether the machine that reported this system name is a Mac: the name its maker gives it, and the kernel's own
 * word where the machine answered nothing better, which is what a machine on this computer falls back to. The
 * folder browsers read it beside the home to know whether that home keeps a Library. Absent is not a Mac: what
 * reads this hides a folder, and a machine that said nothing has said nothing to hide. */
export function isMacMachine(osName: string | null | undefined): boolean {
  return /^(?:macOS|Darwin)\b/.test(osName ?? "");
}

/** The computer the host runs on as a row names it, off what that machine itself reported: the same word every
 * screen that names this computer uses, so a table and the settings list cannot call one computer two things. */
export const computerWord = (os: string | null | undefined): string => thisComputer(isMacMachine(os) ? "darwin" : "linux");

/** The heading over the tools a package manager here has that no catalog row carries: the wizard's own screen and
 * the `wsp recipe scan` section are one section, so they carry one name. */
export const alsoTitle = (platform: "darwin" | "linux"): string => `Also on ${thisComputer(platform)}`;

/** The one sentence a local workspace refuses a request relayed from a machine with. A local workspace is this
 * computer; it answers only its own person, so a request that reached the host from a machine wsp runs cannot drive
 * it. Today no machine has a road into the host, so nothing relays yet; the rule and its test land now. */
export function relayedRefusal(name: string): string {
  return `${name} is ${THIS_COMPUTER}; it answers only requests from ${THIS_COMPUTER}, never one relayed from a machine`;
}

/** The one sentence a request relayed from a machine is refused with when it would record a machine that already
 * exists. Which of the person's own machines wsp holds is theirs to say, whatever the kind: the address and the key
 * a record stands on are named on this computer, so nothing a machine asks for reaches that road. */
export function relayedRecordRefusal(named: string): string {
  return `recording ${named} is this computer's own act; a request relayed from a machine cannot record a machine here`;
}

/** The short form of a thread id every sentence about a thread uses, so a refusal, a table and a tree all name a
 * thread the same way. */
export const threadWord = (threadId: string): string => threadId.slice(0, 8);

/** The one sentence a forget is refused with once a turn of the thread did work: the runtime raises it, the command
 * line prints it and the app's row action shows it without asking, so all three say the same thing. */
export function threadForgetRefusal(threadId: string): string {
  return `thread ${threadWord(threadId)} has a turn that ran; only a thread no turn ever ran on can be forgotten`;
}

/** The one sentence a forget is refused with for a row from before threads: the fold keys such a row by its own
 * turn id, so no thread here answers to it and nothing a forget could take is named. */
export function threadWithoutIdRefusal(rowId: string): string {
  return `${rowId} is a turn from before threads and carries no thread id of its own; no forget can name it`;
}

/** Every act a thread scoped token can be refused for, and the word each is refused by name with. The table is
 * the whole rule: an act absent from it is one no thread may ask for, and adding an act is one row here. */
export const SPAWN_ACTS = {
  thread_new: "open a thread",
  fork: "fork a machine",
  send: "send into a thread",
  delete: "delete a workspace",
  pause: "pause a machine",
  import: "import a folder",
  export: "export a folder",
  agents: "change what agents may do",
} as const;
export type SpawnAct = keyof typeof SPAWN_ACTS;

/** The acts a thread may ask for at all; every other act in the table is refused whatever the caps say. */
export const SPAWN_ACTS_ALLOWED: readonly SpawnAct[] = ["thread_new", "fork", "send"];

/** The one sentence a thread's own token is refused with when the workspace it runs on lets its agents spawn
 * nothing. Off is what every workspace reads as until a person turns it on. */
export function agentsOffRefusal(workspace: string, act: SpawnAct): string {
  return `agents on ${workspace} may not ${SPAWN_ACTS[act]}; turn it on with wsp workspaces agents ${workspace} --spawn on`;
}

/** The one sentence a thread's own token is refused with for an act no thread may ask for, whatever the caps. */
export function spawnActRefusal(threadId: string, act: SpawnAct): string {
  return `this request came out of thread ${threadWord(threadId)} on a machine, and a thread may only ${SPAWN_ACTS_ALLOWED.map(a => SPAWN_ACTS[a]).join(", ")}, never ${SPAWN_ACTS[act]}`;
}

/** The one sentence a fork past the machine cap is refused with, naming the root the machines were counted under. */
export function spawnCapRefusal(rootThreadId: string, standing: number, cap: number): string {
  return `thread ${threadWord(rootThreadId)} already holds ${standing} of its ${cap} machines; delete one before forking another`;
}

/** The one sentence a spawn deeper than the workspace allows is refused with. */
export function spawnDepthRefusal(threadId: string, depth: number, cap: number): string {
  return `thread ${threadWord(threadId)} is ${depth} deep under its root and this workspace allows ${cap}; a thread this deep may not spawn`;
}

/** The one sentence a thread is refused with for reaching a workspace outside its own tree. */
export function spawnReachRefusal(threadId: string, name: string): string {
  return `thread ${threadWord(threadId)} may drive the workspace it runs on and the ones it forked, and ${name} is neither`;
}

/** The one sentence a name no workspace of this host carries is refused with. Absence is the only thing it says: a
 * workspace that exists and cannot be driven from here is refused by the rule that hides it, never as missing. */
export function noWorkspaceRefusal(ref: string): string {
  return `no workspace ${ref}`;
}

/** The workspace table's cell for the switch: empty where agents spawn nothing, which is nearly every row, so the
 * column is quiet until a workspace has one. */
export function agentsWord(agents: { spawn: boolean; maxMachines: number } | undefined): string {
  return agents?.spawn !== true ? "" : `${agents.maxMachines} ${agents.maxMachines === 1 ? "machine" : "machines"}`;
}

/** What a listing and the workspace card say about a workspace's switch, one line either way. */
export function agentsLine(agents: { spawn: boolean; maxMachines: number; maxDepth: number } | undefined): string {
  return agents?.spawn !== true ? "agents may not spawn" : `agents may spawn: up to ${agents.maxMachines} ${agents.maxMachines === 1 ? "workspace" : "workspaces"}`;
}

/** What a first dial says about the machine it reached: the host key it answered with, for the person to compare
 * against the machine's own before they trust the road. Printed once, when the workspace is recorded. */
export function sshHostKeyNotice(hostKey: string): string {
  return `its host key is ${hostKey}; compare it with the machine's own before a thread runs there`;
}

/** What a verb is refused with when this host wired no module for the kind it names. */
export function noKindLine(kind: string): string {
  return `this host has no ${kind} backend wired, so it serves no ${kind} workspace`;
}

/** What a road is refused with when the record names no home on its machine: every path a turn runs there is built
 * from it, and the dial that records a workspace refuses a machine that names none, so a record without one is one
 * to make again rather than one to guess a folder for. */
export function noMachineHomeLine(name: string): string {
  return `${name} carries no home folder for its machine; add that computer again with wsp add user@host`;
}

/** What the roads that need a daemon are refused with on a machine reached over ssh before one is on it: the
 * record was made but the deploy has not landed, so the panes that ride a daemon have nothing to dial yet. The
 * host offers one again on its own, so the line says that rather than naming a verb: nothing a person types puts
 * a daemon on a machine already recorded, and the one thing they can do is fix what the deploy said it needed.
 * Later, not at every start: a machine that answered with what it lacks is left alone until its window is out. */
export function noSshDaemonLine(name: string): string {
  return `${name} carries no daemon yet, so its terminal, files and ports are not served; this host offers it again later on its own`;
}

/** What import is refused with on a kind no road lands a folder on, said before the folder is read. Every kind
 * has a road today; the sentence stands for the next kind added without one, which is what the words table's
 * null import road means. */
export function noImportRoadLine(name: string, machine: string): string {
  return `${name} is ${machine}, which lands no folder yet; import to a fork, or register the folder on this computer`;
}

/** What a machine without a node the wsp command runs on is refused with. The daemon itself is one static binary
 * and asks nothing of the machine; the wsp command that rides beside it, which every turn's agent drives the host
 * through, still runs on node. A machine wsp builds carries the floor's; a machine somebody already owns may carry
 * none, or one too old. Said before the install rather than after, so nothing lands on a machine that refuses. */
export const NO_NODE_LINE =
  "this machine has no Node 22, which the wsp command beside the daemon runs on; install Node 22 or newer on it and deploy the daemon again";

/** What a machine whose login does not linger is refused with. Its own systemd stops when its last session ends
 * and takes the daemon with it, so a daemon deployed there is gone the moment the host's connection closes; the
 * person turns linger on once and it holds for every login after. */
export const NO_LINGER_LINE =
  "this login does not linger, so its services stop when you log out and the daemon would not outlive the connection; run loginctl enable-linger on it and deploy the daemon again";

/** Every sentence a machine's own checks refuse with, in one place beside them. Read by the rule that keeps each
 * one's first clause short enough for a row, so a refusal added later takes that rule without anyone remembering
 * where it is checked. Nothing decides anything by searching this: which ending a throw is comes off its mark. */
export const MACHINE_LACKS_LINES: readonly string[] = [NO_NODE_LINE, NO_LINGER_LINE];

/** The marks the checks a machine takes before a daemon is put on it end with, put on where the throw happens
 * rather than matched against text: a check added to a place's preflight is then one shell line and one sentence,
 * and nothing keeps a second copy of which sentences mean what. Two of them, because the two endings lead
 * opposite ways. A machine that answered and refused has said what it has not got, which a row shows and which
 * stands until a person puts that thing there. A check that never reached the machine has said nothing about it
 * either way: those are the client's own words, they belong in no row, and whatever the record already knew about
 * that machine still holds. Every other failure is a deploy log and carries neither mark. */
const MACHINE_LACKS = "wspMachineLacks";
const MACHINE_UNANSWERED = "wspMachineUnanswered";

export function machineLacking(said: string): Error {
  return Object.assign(new Error(said), { [MACHINE_LACKS]: true });
}

export function machineUnanswered(said: string): Error {
  return Object.assign(new Error(said), { [MACHINE_UNANSWERED]: true });
}

/** The sentence a machine refused with, or undefined for every other failure. */
export function machineLacksLine(e: unknown): string | undefined {
  return marked(e, MACHINE_LACKS) ? e.message : undefined;
}

/** Whether the check never reached the machine, so nothing about what that machine has was learned. */
export function machineNeverAnswered(e: unknown): boolean {
  return marked(e, MACHINE_UNANSWERED);
}

const marked = (e: unknown, mark: string): e is Error => e instanceof Error && (e as unknown as Record<string, unknown>)[mark] === true;

/** A refusal cut to its first clause, which is what the machine has not got. Every sentence above is written in
 * that order, what is wrong, then why it matters, then what to do, and its head is short enough for a row about
 * thirty characters wide; the whole sentence goes where there is room, since the instruction is at the end of it
 * and a row that cut from the right would take the instruction off. A refusal added later is written to the same
 * shape rather than carrying a second, shorter copy of itself. */
export function machineLacksShort(said: string): string {
  return said.split(",")[0]!.trim();
}

/** The one sentence a socket a machine's requests arrive on is refused a ticket with. A ticket authenticates the
 * next socket, and a socket this host minted no relay ticket for is one of the person's own, so a machine that
 * could mint one would hand itself the origin the relay stamps on it. */
export const RELAY_TICKET_REFUSAL = "a request relayed from a machine cannot mint a ticket into this host";

/** What a thread is doing, as the one line a client with no transcript shows: the tool call it is running, the
 * prompt it is blocked on, else its own latest line of prose. Nothing for an event that says nothing about the
 * work, so a caller keeps the line it had. */
export function threadWorkingLine(e: SessionEvent): string | undefined {
  switch (e.type) {
    case "session.delta":
      return e.kind === "text" || e.kind === "thinking" ? lastLine(e.text) : e.kind === "tool_use" ? toolActivityLine(e.toolName, e.text) : undefined;
    case "session.permission":
      return permissionAskLine(e.toolName, e.input, e.detail);
    default:
      return undefined;
  }
}

/** A prompt's lead in two parts: the words, and the call's own text where the call has some. They are apart because
 * a command is judged by characters a sentence face blurs, two hyphens reading as one dash among them, so a client
 * with more than one face draws the second part as code while a one-face surface joins them back into a sentence. */
interface AskLead {
  readonly says: string;
  readonly code?: string;
}

/** How one kind of call is put to a person when the harness asks permission for it: the lead they judge it by,
 * the input fields that lead already carries, and the field holding a file's body. */
interface PermissionWords {
  readonly lead: (input: ToolInput, toolName: string) => AskLead | undefined;
  /** The questions this kind of call puts to the person, on the one kind that asks rather than does; absent on
   * every other kind, which is what tells a prompt that asks from a prompt that wants consent. */
  readonly questions?: (input: ToolInput) => readonly AskedQuestion[] | undefined;
  /** Fields the lead says itself, left out of the values shown under it so nothing is read twice. */
  readonly named: readonly string[];
  readonly body?: string;
}

const writeAsk: PermissionWords = {
  lead: input => {
    const path = toolField(input, "file_path");
    if (path === undefined) return undefined;
    const folder = parentFolderName(path);
    const content = input["content"];
    const size = typeof content === "string" ? ` (${fmtBytes(new TextEncoder().encode(content).length)})` : "";
    return { says: `Write ${folderName(path)}${folder === "" ? "" : ` in ${folder}`}${size}` };
  },
  named: ["file_path", "content"],
  body: "content",
};

const commandAsk: PermissionWords = {
  lead: input => {
    const command = toolField(input, "command");
    return command === undefined ? undefined : { says: "Run:", code: command };
  },
  named: ["command", "description"],
};

const skillAsk: PermissionWords = {
  lead: input => {
    const skill = toolField(input, "skill");
    return skill === undefined ? undefined : { says: `Run the skill ${skill}` };
  },
  named: ["skill"],
};

const serverAsk: PermissionWords = {
  lead: (_input, toolName) => {
    const lent = serverTool(toolName);
    return lent === undefined ? undefined : { says: `Use the ${lent.server} tools: ${lent.tool.replace(/_/g, " ")}` };
  },
  named: [],
};

/** A kind with no words of its own yet: the lead falls back to the harness's own phrase under the tool's name. */
const plainAsk: PermissionWords = { lead: () => undefined, named: [] };

/** Every kind of call a permission prompt is worded for, one row per kind. The chat row and the command line both
 * read this table, so the words live here and in neither of them, and a kind worded later is a row and nothing
 * else. A name no row matches is a server's tool where its name carries one, else the plain row. */
const PERMISSION_ASKS: ReadonlyMap<string, PermissionWords> = new Map<string, PermissionWords>([
  ["Write", writeAsk],
  ["Bash", commandAsk],
  ["Skill", skillAsk],
  [QUESTION_TOOL, questionAsk],
]);

function permissionWords(toolName: string): PermissionWords {
  return PERMISSION_ASKS.get(toolName) ?? (serverTool(toolName) === undefined ? plainAsk : serverAsk);
}

/** What the disclosure a file's body sits behind reads: the buttons stay in reach and the file is one click away. */
const BODY_LABEL = "show the file";

/** The lead its kind words the call by, or the harness's own phrase under the tool's name for a call whose input
 * carries none of what its rule needs and for a kind with no rule. */
function askLead(toolName: string, input: string, detail?: string): AskLead {
  const fields = toolInput(input);
  const lead = fields === undefined ? undefined : permissionWords(toolName).lead(fields, toolName);
  if (lead !== undefined) return lead;
  return { says: detail === undefined || detail === "" ? `Permission for ${toolName}` : `Permission for ${toolName}: ${detail}` };
}

/** The two parts joined back into one line, the one rule for it. */
const leadLine = (lead: AskLead): string => (lead.code === undefined ? lead.says : `${lead.says} ${lead.code}`);

/** The prompt row's lead as one line, for a surface with one face: the command line's. No question mark, since the
 * options under it are the question. */
export function permissionAskLine(toolName: string, input: string, detail?: string): string {
  return leadLine(askLead(toolName, input, detail));
}

/** One value as the row reads it: its own whitespace collapsed, so a field holding a paragraph is one line rather
 * than a wall, while the fields stay apart under their separator. */
const restValue = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value) ?? "").replace(/\s+/g, " ").trim();

/** The whole of a relayed permission prompt as a client draws it: the lead in its two parts, the input values that
 * lead does not already carry, and the file body folded away behind its own disclosure. Nothing here is cut, since
 * this is the row consent is given on, which is also why a file's text is folded rather than shown: a wall of it
 * between the question and the buttons is what nobody reads. */
export interface PermissionPromptWords {
  /** The lead as one line, the two parts joined, which is what a surface with one face shows. */
  readonly lead: string;
  readonly says: string;
  /** The call's own text, where the call has some: a client with a code face draws this in it, breaks it at no
   * character inside a token and scrolls it sideways rather than cutting it. */
  readonly code?: string;
  readonly rest: string;
  readonly body?: { readonly label: string; readonly text: string };
  /** Set only on a call that asks the person something: the row draws these and nothing else, since a question's
   * whole input is the question. */
  readonly questions?: readonly AskedQuestion[];
}

export function permissionPromptWords(toolName: string, input: string, detail?: string): PermissionPromptWords {
  const lead = askLead(toolName, input, detail);
  const parts = { lead: leadLine(lead), says: lead.says, ...(lead.code === undefined ? {} : { code: lead.code }) };
  const questions = askedQuestions(toolName, input);
  if (questions !== undefined) return { ...parts, rest: "", questions };
  const fields = toolInput(input);
  if (fields === undefined) return { ...parts, rest: input };
  const words = permissionWords(toolName);
  const named = new Set(words.named);
  const body = words.body === undefined ? undefined : toolField(fields, words.body);
  const rest = Object.entries(fields)
    .filter(([key]) => !named.has(key))
    .map(([key, value]) => `${key}: ${restValue(value)}`)
    .join(" · ");
  return { ...parts, rest, ...(body === undefined ? {} : { body: { label: BODY_LABEL, text: body } }) };
}

/** That lead taken off the prompt itself, which is what a thread's row says it is waiting on and what the app says
 * outside the thread's own pane. The one call both make, so the whole prompt is in hand here and reading another of
 * its fields to word the lead is an edit to this body alone. */
export function askingLine(ask: Pick<SessionPermissionEvent, "toolName" | "input" | "detail">): string {
  return permissionAskLine(ask.toolName, ask.input, ask.detail);
}

/** What an answered prompt row reads once it is closed, one word per outcome. The option's own label rides beside it
 * only where it says something the outcome does not, which is the pick that also changed the access for the rest of
 * the turn: "Allowed: Allow" and "Denied: Deny" name the same fact twice. */
export function permissionOutcomeLine(outcome: PermissionOutcome, picked?: { label: string; effect: PermissionEffect }): string {
  const named = picked?.effect === "mode" ? `: ${picked.label}` : "";
  switch (outcome) {
    case "allowed":
      return picked?.effect === "answer" ? `You answered: ${picked.label}` : `Allowed${named}`;
    case "denied":
      return `Denied${named}`;
    case "unanswered":
      return "Nobody answered; denied";
    case "cancelled":
      return "Cancelled with the turn";
    default: {
      const _exhaustive: never = outcome;
      return "";
    }
  }
}

/** What the harness is told when a person picked deny in the chat: the agent reads it as the call's result, so it
 * says who refused rather than reading as a tool that failed. */
export const PERMISSION_DENIED_LINE = "the person denied this in the chat";

/** One option on a prompt that also puts the rest of the turn in another access mode, as the row shows it; the mode
 * arrives as the CLI's own slug and the runtime's harness table lends it the words the picker uses. */
export function permissionModeOptionLabel(modeLabel: string): string {
  return `Allow, then ${modeLabel}`;
}

/** What the access picker says over its list while a turn is running: what a pick does to that turn, read before the
 * pick rather than under the box after it. A harness that takes a mode change mid-turn puts the pick to the turn in
 * front of the person, the prompt it is stopped on included; one that does not keeps the pick for the next message. */
export function accessReachLine(movesRunningTurn: boolean): string {
  return movesRunningTurn ? "Applies to the turn running now" : "Applies from your next message";
}

/** What the composer says under the box when an access pick the harness's own row said would reach the running turn
 * came back refused: the two halves every refusal in this app has, what happened and then what to do about it. It
 * stands only for a refusal the harness actually answered with, never for one the menu said before the pick, so
 * nobody reads the same sentence twice. Short because that slot is one line the width of the box and it truncates
 * from the right: 54 characters is what fits at the window this app is smallest in (measured 2026-09-08, 364 px of
 * slot at a 1200 px viewport), and a refusal cut before its second half is no use. */
export const ACCESS_REFUSED_WORDS = { said: "The turn refused it.", fix: "Your next message carries it." } as const;

/** Those two halves as the one line that slot holds. */
export const ACCESS_REFUSED_LINE = `${ACCESS_REFUSED_WORDS.said} ${ACCESS_REFUSED_WORDS.fix}`;

/** The one sentence a second workspace on a machine that already carries one is refused with. wsp forks a machine
 * for every workspace it makes and records one for every machine it does not, so one record stands on one machine
 * whatever the kind: this computer, or a machine reached over ssh. */
export function alreadyRecorded(machine: string, name: string): string {
  return `${machine} is already the workspace ${name}; one workspace stands on one machine`;
}

/** The one sentence a workspace on a machine wsp does not run refuses a verb that machine cannot take with. This
 * computer and a machine reached over ssh are not machines wsp forks, pauses or snapshots, so the verbs that move a
 * fork have no meaning on either; `machine` is the kind's own word for what it is and `action` is the verb as the
 * person typed it. The capability behind each is false, so the road that reads the capability says this. */
export function undrivenRefusal(name: string, machine: string, action: string): string {
  return `${name} is ${machine}, which wsp does not run; it cannot ${action}`;
}

/** The one sentence a forget on a workspace wsp does not run the machine of is refused with. Such a machine is
 * never gone, so the sentence about a machine still standing at a provider says two impossible things on it: there
 * is no provider to pause it at, and the road that takes the record away is the delete, which asks a provider for
 * nothing either. */
export function forgetUndrivenRefusal(name: string, machine: string): string {
  return `${name} runs on ${machine}, which is not at a provider; run wsp delete ${name}`;
}

/** The one sentence a workspace on a machine wsp does run refuses a verb with when the provider under it has no
 * road for that verb: the machine is wsp's to move, so the refusal names the provider's limit rather than telling a
 * person their fork is their own computer. Each verb reads its own capability, so what is missing is that verb's
 * road and nothing else about the machine. The machine stays the subject the action was written for, since every
 * action is the machine's own verb phrase, and where the road is missing comes after it. */
export function providerCannotRefusal(name: string, machine: string, action: string): string {
  return `${name} is ${machine}, and it cannot ${action} on the provider it runs on`;
}

/** The row's line when a pause or a wake ran its deadline out, once and once more after the retry: which move, how
 * long it was given in all, and what the provider reads about the machine after it, or that the provider could not
 * be read. The person's road is to try again; the runtime never leaves the row at Pausing or Waking. */
export function moveTimedOutLine(move: "pause" | "wake", elapsedMs: number, reads: MachineState | undefined): string {
  const provider = reads === undefined ? "could not be read about the machine" : `reads the machine ${reads}`;
  return `${move} did not complete in ${fmtDuration(elapsedMs)}; the provider did not answer and ${provider}; try again`;
}

/** How many asks a window of asking holds at a cadence, which is the count the row counts against and the last ask
 * a wake makes. An ask starting exactly as the window runs out is not made, so a window of one cadence holds one.
 * The window and the cadence are the backend's to declare. */
export const wakeAsksIn = (forMs: number, everyMs: number): number => Math.ceil(forMs / everyMs);

/** The row's line the moment a resume runs its cap out with nothing back. Not a refusal and not a failed resume: the
 * provider's mutating calls hang at the HTTP level while the operation goes through (probed 2026-09-10, a pause that
 * answered nothing in 30 s had the machine paused 40 s later), so the machine's own state is what settles it and the
 * sentence says that is what is happening next. */
export const RESUME_UNANSWERED = "the provider has not answered the resume request; reading the machine";

/** The line for an ask the host is making on its own: which ask this is, of the ones it will make. Two readings of
 * the one fact, since two surfaces show it: the long one is the Machine tab's, which has a line to spend on prose,
 * and the short one is the sidebar row's, whose meta slot holds a couple of words beside the spend and the nap
 * countdown and cuts from the right. The count is passed rather than worked out here so a runtime given a
 * shorter cadence says the number it will keep to. */
export function wakeAskingAgainLine(ask: number, of: number, style: "long" | "short" = "long"): string {
  return style === "short" ? `asking ${ask}/${of}` : `waking, asking again (${ask} of ${of})`;
}

/** The row's line, and what the wake ends with, when the person stopped the host asking from the row. */
export const WAKE_STOPPED = "waking stopped; the machine is still paused";

/** The row's line once the host's asking ran out and the machine is still paused there, which is the fault probed on
 * 2026-09-10: machines paused for days never resume, while a fresh pause resumes in seconds. Three facts in the order
 * a person needs them: what the provider did, that their work is where they left it, and the one road to a machine
 * now. The disk clause is about the machine as it stands, not about the rebuild, which kills the old machine and
 * lands the nap-time vault instead; the rebuild's own dialog says that. */
export function wakeGaveUpLine(asks: number, overMs: number): string {
  return `the provider answered none of ${plural(asks, "resume request")} over ${fmtDuration(overMs)}; the work on this machine's disk stays with the provider, and a rebuild starts a new machine from the image`;
}

/** What the needs-you road says outside the app when a machine came up while the person was looking elsewhere. */
export const workspaceAwakeLine = (name: string): string => `${name} is awake`;

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

/** The detail of a tools row the catalog does not carry: it is on this computer, at the version this computer runs
 * when the collector read one. */
export function installedHereLine(platform: "darwin" | "linux", version: string | undefined): string {
  const here = `installed on ${thisComputer(platform)}`;
  return version === undefined ? here : `${here}, ${version}`;
}

/** What the build does with a tools row it installs: the road in its own words, then the line the step runs. */
export function installsByLine(words: string, shown: string): string {
  return `installs ${words}: ${shown}`;
}

/** What the build does with a ticked tools row it sets aside, with the plan's reason. */
export function leftOutLine(note: string): string {
  return `left out of the build: ${note}`;
}

/** Why `wsp recipe --add` refuses a package a manager on this computer already has: that package is a row of its own,
 * which the build installs by the road the plan resolves for it (a tap formula from its GitHub release, pinned),
 * and a second row would install it twice by a line the image can refuse. The word that ticks the row instead. */
export function addAlreadyHereLine(platform: "darwin" | "linux", id: string): string {
  return `--add ${id}: a package manager on ${thisComputer(platform)} already has ${id}, so it is a row of its own.`;
}

/** What to do about it: the word that ticks that row, which installs the package by its own road rather than by a
 * second row that installs it again. */
export function addAlreadyHereFix(scanId: string): string {
  return `Tick it with --set ${scanId}=on.`;
}

/** A recipe file's tick on a tool outside the catalog that this computer has no row for: nothing here says how to install
 * it, so the tick is said and left out rather than dropped in silence. */
export function notHereLine(platform: "darwin" | "linux", name: string, file: string): string {
  return `${name} is ticked in ${file}, but ${thisComputer(platform)} has no row that installs it; it is left out.`;
}

/** The app's line for a workspace still forked from an older golden version, offered the way the helper update is:
 * a state in words, never a badge. The move is the person's; nothing replaces a machine they are working on. */
export function behindGoldenLine(on: number, head: number): string {
  return `on image v${on}, v${head} available`;
}

/** The states a version row can be in, each as the muted mono word the row's marks column shows: state is text there,
 * never a badge, and a missing tool's outcome indexes this table as it is. The keys are the wire's; the words are
 * the person's, so a row says what the version is rather than the name the code holds it under. The volatile key's
 * word says what such a version has behind it, a snapshot at the provider and no durable template, since that is
 * the whole of what it is and what the provider can drop. */
export const LINEAGE_MARKS = { now: "now", head: "newest", fork: "this one", failed: "failed", skipped: "skipped", volatile: "snapshot only" } as const;
export type LineageMark = keyof typeof LINEAGE_MARKS;

/** What is said for each folder git named no branch for, by door: the word the composer's branch slot and the diff
 * pane's git mark show and the sentence it explains on hover, nothing for a folder outside any repository or one not
 * yet asked (both ordinary) and a word for a read the machine refused or failed (an outside cause the person should
 * see); and the one line an empty diff pane says in place of a diff, only for a folder outside any repository, since
 * an empty pane with no reason reads as broken while a refused read shows the cause git gave. */
export const REPO_STATE_WORDS = {
  unknown: { word: "", note: "", pane: "" },
  none: { word: "", note: "", pane: "This folder is not inside a git repository, so there is nothing to diff." },
  refused: { word: "git unread", note: "The workspace could not read this folder's git state, so no branch is shown.", pane: "" },
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

/** The promoting stage's line for one read of the saved image: what the provider says of it and whether the seal asks
 * again. Ready is the last line the stage writes; the template's id is the provider's and reaches no screen. */
export function templateStatusLine(status: string): string {
  return status === "ready" ? "the image is saved" : `${SAVING_IMAGE_LINE}, the provider says ${status}; asking again`;
}

/** The seal's failure line when the provider marks the template failed: forks would have nothing to boot from. */
export function templateFailedLine(templateId: string, reason: string | undefined): string {
  return `the provider failed the template ${templateId}: ${reason ?? "no reason given"}`;
}

/** The seal's failure line when the template never read ready inside the wait. */
export function templateWaitedLine(templateId: string, status: string, waitedMs: number): string {
  return `the template ${templateId} still reads ${status} after ${fmtDuration(waitedMs)}`;
}

/** The doctor's line per version it made durable: the image and version, the template it promoted, and when other
 * templates already carry the name (another host's, or a run that recorded nothing), how many; none when the count
 * is zero or the listing was not given. */
export function templateRecordedLine(image: string, version: number, templateId: string, sharing: number | undefined): string {
  const head = `image ${image} v${version}: template ${templateId} promoted and recorded`;
  return sharing === undefined || sharing === 0 ? head : `${head}; ${sharing} other ${sharing === 1 ? "template carries" : "templates carry"} its name`;
}

/** The doctor's line per version it could not make durable and why: a lost snapshot in the provider's own words is
 * left to the doctor's rebuild road below it. */
export function templateSkippedLine(image: string, version: number, reason: string): string {
  return `image ${image} v${version}: no template recorded, ${reason}`;
}

/** What a version's row says when the provider answers 404 for its snapshot: the vanish the templates exist to outlive. */
export const SNAPSHOT_GONE_REASON = "its snapshot is gone at the provider";

/** The doctor's line on a backend whose capabilities lack templates: nothing to promote, nothing wrong. */
export const NO_TEMPLATES_LINE = "this backend has no templates; image versions stay as snapshots";

/** The doctor's line on a backend that cannot list snapshots: nothing to split, nothing to clean. */
export const NO_SNAPSHOT_LISTING = "this backend lists no snapshots; nothing to split by owner";

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
  return `Image v${version} is unchanged. Builder ${builderId} is as it was, up at about $${rateUsdPerHour.toFixed(2)}/hr; run wsp init again to retry, and the sweep stops it once it is six hours old.`;
}

/** The update's last line when the snapshot failed and the provider would not say what became of the machine it
 * ran on: nothing on it was touched, the retry runs on it or the sweep ends it. */
export function upgradeSealFailedUnreadLine(version: number, builderId: string): string {
  return `Image v${version} is unchanged. The provider could not be read about builder ${builderId}, so nothing on it was touched; run wsp init again to retry, and the sweep stops it once it is six hours old.`;
}

/** The update's last line when the snapshot failed and the provider answers 404 for the machine it ran on. */
export function upgradeSealFailedGoneLine(version: number): string {
  return `Image v${version} is unchanged and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again to retry.`;
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
export const EXPORT_SESSIONS_NOTE = "Ticked agents' sessions come home with the folder. The rest stay in the workspace.";

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

/** A glyph's id as a picker names it. The ids are one word each, so the word is the id with its first letter up; a
 * second table of names would drift from the list the wire validates against. */
export function lookWord(id: WorkspaceGlyph): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The custom properties a workspace's theme paints with, the one place the theme object is read. The gradient is
 * one dot's colour laid flat, two dots fading toward each other from opposite corners, or three with two settling
 * in the top corners over the third rising from the bottom; every stop carries the opacity as its alpha, so the
 * colour lies over whatever surface the sidebar has, the glass, the macOS material or the plain token, rather
 * than replacing it, held under the cap that keeps the side's words reading. The grain is the slider's number,
 * which the stylesheet gives to a pre-rendered tile. The ink is the one colour the chrome takes from the theme. */
export interface ThemeVars {
  readonly "--space-gradient": string;
  readonly "--space-grain": string;
  readonly "--space-tint": string;
}

/** A share as a whole percent: 0.5 reads 50%. */
export function fmtPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** What the app says about a desktop shell and the host that served it its page being of two releases. */
export interface ShellVersionNotice {
  /** The one line the app shows. */
  line: string;
  /** True while the person is being pointed at a newer app; the line asks for the app's own host instead when the
   * shell is the newer half, since there is nothing to download for that. */
  update: boolean;
}

/** The word on the notice's one button, which opens the releases page away from the app's window. */
export const GET_THE_APP_WORD = "Get";

/** The line for a desktop shell whose page came from a host of another release, and nothing while the two agree.
 * The halves ship together and every call over the bridge needs both, so the older one is named with what to do
 * about it. A shell whose bridge carries no version at all is one from before the bridge carried one, which is
 * older than any host that reads this. */
export function shellVersionNotice(shell: string | undefined, host: string, label?: string): ShellVersionNotice | undefined {
  const named = label === undefined ? "the host" : `the host ${label}`;
  if (shell === undefined) return { line: `this app is older than ${named}, which is ${host}: get the new app`, update: true };
  const order = compareVersions(shell, host);
  if (order === 0) return undefined;
  const both = `this app is ${shell}, ${named} is ${host}`;
  return order < 0 ? { line: `${both}: get the new app`, update: true } : { line: `${both}: run the app's own host`, update: false };
}

/** The words of the desktop's hosts: the menu, the sidebar's foot and the connect sheet all read them here. */
export const HOST_WORDS = {
  hosts: "Hosts",
  connectMenu: "Connect to a host…",
  disconnect: (label: string): string => `Disconnect ${label}`,
  /** Why the disconnect row is dimmed while the window is on the app's own computer. */
  hereStays: (here: string): string => `${here} is the app's own host`,
  /** The two rows a computer that joined another wsp adds, and the line its sidebar foot reads. */
  place: {
    line: (hostName: string): string => `runs threads for ${hostName}`,
    leave: "leave",
    leaveRow: (hostName: string): string => `Leave ${hostName}'s wsp`,
    awakeRow: "Stay awake while joined",
    awakeWhy: "while the lid is open and it is plugged in",
  },
  sheet: {
    headline: "Connect to a host",
    top: "A wsp host on another computer, by its address or over ssh.",
    direct: "Address and code",
    ssh: "Over ssh",
    address: "Address",
    addressPlaceholder: `http://box:${DEFAULT_PORT}`,
    code: "Code",
    codePlaceholder: "XXXX-XXXX",
    login: "Login",
    loginPlaceholder: "user@host",
    port: "Port",
    portPlaceholder: "22",
    keycap: "Connect",
    cancel: "Cancel",
    directNote: "The app pairs with the host at this address, with the code wsp host pair printed on that computer, and opens it.",
    sshNote: "The app logs in over ssh, starts wsp there when nothing serves, forwards its port to this computer and pairs.",
    /** Why Connect is held, as its tooltip. */
    fillFirst: "type the address and the code first",
    fillLoginFirst: "type the login first",
  },
} as const;

/** How long a computer has been away, coarse on purpose: the figure is read once in a table, not watched. */
export function offlineFor(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/** The Workspaces cell of that table: how many stand on the computer, what it has cost this month where somebody
 * is charging for them, and the one thing about the computer that changes what a person may put there. Whether it
 * is answering is not one of them: the state slot beside its name carries that, and a row that said it twice was a
 * row that said it in two wordings. The count is what the caller reads off the workspace list, never off the row:
 * a row carries at most the one workspace its join recorded, so this computer's own workspace and a provider's
 * forks are on neither. */
export function placeWorkspacesCell(view: PlaceView, count: number, monthUsd?: number): string {
  const { count: n, note } = placeWorkspacesParts(view, count, monthUsd);
  return note === undefined ? n : `${n} · ${note}`;
}

/** The same cell in its two parts, for a table that draws them in two inks: the count a person is counting, and
 * the note behind it, which is the mock's muted clause. A line that is one string (the command line's row, a
 * title) reads placeWorkspacesCell instead; both are this one rule. */
export function placeWorkspacesParts(view: PlaceView, count: number, monthUsd?: number): { count: string; note?: string } {
  const n = `${count}`;
  // Only a provider bills: a computer of the person's own runs their workspaces for nothing, whatever it runs them on.
  if (view.kind === "provider") return monthUsd === undefined ? { count: n } : { count: n, note: spentThisMonth(monthUsd) };
  return view.runsWorkspaces === true ? { count: n } : { count: n, note: AGENTS_ONLY };
}

/** What a computer that does not run workspaces of its own runs: the person's agents, and no workspace but the one it is. */
export const AGENTS_ONLY = "agents only";

/** What a place has taken since the first of the month, the clause every surface that says it says. */
export const spentThisMonth = (usd: number): string => `${fmtCost(usd)} this month`;

/** The Spend row of a place's detail: the month behind it, what it burns right now and how many workspaces that is
 * across. A row burning nothing says so with the rate rather than dropping the clause, since a $0.00/hr that is
 * measured and a figure left out read differently. */
export function placeSpendLine(spend: { monthUsd: number; rateUsdPerHour: number }, workspaces: number): string {
  return `${spentThisMonth(spend.monthUsd)} · ${fmtRate(spend.rateUsdPerHour)} now across ${plural(workspaces, "workspace")}`;
}

/** The foot under the places table: what the providers that have taken something this month took, together, and how
 * many of them that is. A provider that took nothing is not in the count, whether nothing was ever metered on it or
 * its workspaces have all been asleep since last month: a count of two where one charged reads as two bills. */
export function placesSpendFoot(monthUsd: number, providers: number): string {
  return `${spentThisMonth(monthUsd)} across ${plural(providers, "provider")}`;
}

/** The doctor's word on whether this computer runs workspaces: the positive line, or the one kernel reason the
 * daemon's self check named. A place that has not yet said reads neither. */
export function placeWorkspacesLine(view: Pick<PlaceView, "name" | "runsWorkspaces" | "workspacesBlocked">): string | undefined {
  if (view.runsWorkspaces === undefined) return undefined;
  if (view.runsWorkspaces) return `${view.name} runs your workspaces`;
  // The daemon's reason names "this computer"; on a named row it is that computer, so the line says which.
  return view.workspacesBlocked?.replace("this computer", view.name) ?? `${view.name}'s kernel cannot run wsp workspaces`;
}

/** The doctor's word on the engine a project's own containers run on here: the engine when the box has one, else
 * the line that says installing one opens it. A place that has not yet said reads nothing. */
export function placeEngineLine(view: Pick<PlaceView, "name" | "engine">): string | undefined {
  if (view.engine === undefined) return undefined;
  if (view.engine === "none") return `${view.name} has no container engine, so a project's own containers do not run here; install Docker or podman on it and they will`;
  return `${view.name} runs a project's own containers on ${view.engine}`;
}

/** The one line that takes wsp off a computer it is typed on. */
export const PLACE_LEAVE_LINE = "wsp leave";

/** Everything wsp puts on a computer it is installed on, named once. The Add sheet writes its lines and the note
 * under them from this list and the Remove dialog writes its sentence from the same, so what a person is told
 * before they press Add is what they are told on the way out. Nothing here is called a shim: a person reads what
 * the thing does, since nobody outside this repo knows what a shim is.
 *
 * The paths behind the words are placeOwnedPaths', which is the list a sweep actually walks. */
export const PLACE_INSTALL = {
  /** Where wsp's own files land under that login's home, and what they weigh there. */
  folder: "~/.wsp",
  weight: "about 40 MB",
  /** Whose service manager holds the agent up: that login's own, never the system's, so nothing here needs root. */
  service: "a user service",
  /** The three things a sweep takes off again, in the order placeOwnedPaths walks them and in the grammar Remove
   * says them: the unit that holds the agent up, the files under wsp's own folder, and the command beside them.
   * The Add lines name the same three in their own grammar, so a fourth thing landing on a box cannot show on one
   * screen and not the other. */
  taken: {
    service: "the agent's service",
    files: "wsp's own files under that login's home",
    opener: "the command beside them that opens sign-in pages in your browser",
  },
  /** What that command does, as its own sentence for a screen that lists what lands rather than what comes off. */
  openerLine: "Sign-in pages started on that computer open in your browser here.",
  /** What Docker on that computer ends up holding, and when. The size is the image's own, where this host has
   * built one; a host with none yet says the sentence without a figure rather than a figure it is guessing. */
  imageCopy: (size: string | undefined): string =>
    `Your image${size === undefined ? "" : ` (${size})`} is copied into Docker there the first time a workspace is created. Remove takes all of it off again.`,
} as const;

/** The words of the Settings section for where a person's agents run, and of the sheet that adds a computer. */
export const PLACES_WORDS = {
  section: "Where agents run",
  columns: ["Computer", "Size", "Disk free", "Workspaces"],
  addComputer: "Add a computer",
  connectProvider: "Connect a provider",
  sheet: {
    title: "Add a computer",
    description: "A computer you own runs threads for your wsp. It connects to this Mac over your network. You open nothing on it.",
    appRoad: 'On that computer, open wsp and press "This Mac joins another wsp". Type these.',
    address: "Address",
    code: "Code",
    waiting: "waiting for it to connect",
    connected: (from: string): string => `connected from ${from} · keys exchanged`,
    reading: "reading what it has",
    joined: (os: string, agents: readonly string[]): string => `joined · ${os}${agents.length === 0 ? "" : ` · ${agents.join(", ")} found`}`,
    cannotRunWorkspaces: "runs your agents as one workspace",
    joinedTitle: (name: string): string => `${name} joined`,
    joinedDescription: "It runs your agents as one workspace.",
    open: (name: string): string => `Open ${name}`,
    noApp: "No app on that computer",
    noAppLine: "In its terminal, install wsp, then join:",
    install: "npm i -g @zingzy/wsp",
    joinLine: (url: string, code: string): string => `wsp join ${url} --code ${code}`,
    escStays: "esc closes, the code stays good",
    newCode: "New code",
    close: "Close",
    /** Said once, the first time the door binds: a Mac with its firewall on asks whether wsp may accept connections. */
    firewall: "macOS may ask once whether wsp can accept connections; allow it",
  },
  remove: {
    /** The line run on the computer itself, which is the one road that also takes the agent's service: the sweep
     * the host asks for over the link leaves the unit standing, since its name is the host's rule and not the
     * agent's. */
    leaveLine: PLACE_LEAVE_LINE,
    /** What that line takes and what it leaves, off the one list a sweep reads (placeOwnedPaths), which names the
     * files under wsp's folder and never the folder itself, and the unit the manager holds the agent up with. */
    leaveTakes: `It takes off ${PLACE_INSTALL.taken.service}, ${PLACE_INSTALL.taken.files}, and ${PLACE_INSTALL.taken.opener}. Your work folder stays, and so do any copies of your image in Docker there.`,
  },
} as const;

/** What the app calls the computer it runs on, first in every hosts list. */
export const hereWord = (mac: boolean): string => (mac ? "This Mac" : "This computer");

const HOST_MENU_SWITCH = "switch:";
const HOST_MENU_CONNECT = "connect";
const HOST_MENU_DISCONNECT = "disconnect:";
const HOST_MENU_AWAKE = "awake:";
const HOST_MENU_LEAVE = "leave-place";

/** The Hosts menu as one list of rows, read by the shell's own menu bar and by the sidebar's foot alike: this computer
 * first, every saved host, the current one marked, then the connect row, then the disconnect of the host the window is
 * on, dimmed on this computer since its host is the app's own. */
export function hostsMenuItems(view: HostsView): ContextMenuItem[] {
  const current = view.hosts.find(h => h.alias === view.current);
  return [
    { id: HOST_MENU_SWITCH, label: view.here, group: "hosts", enabled: true, checked: view.current === null },
    ...view.hosts.map((h): ContextMenuItem => ({ id: `${HOST_MENU_SWITCH}${h.alias}`, label: h.label, group: "hosts", enabled: true, checked: h.alias === view.current })),
    { id: HOST_MENU_CONNECT, label: HOST_WORDS.connectMenu, group: "add", enabled: true },
    current !== undefined
      ? { id: `${HOST_MENU_DISCONNECT}${current.alias}`, label: HOST_WORDS.disconnect(current.label), group: "remove", enabled: true, destructive: true }
      : { id: HOST_MENU_DISCONNECT, label: HOST_WORDS.disconnect(view.here), group: "remove", enabled: false, refusal: HOST_WORDS.hereStays(view.here), destructive: true },
    ...(view.place === undefined
      ? []
      : [
          { id: `${HOST_MENU_AWAKE}${view.place.awake ? "off" : "on"}`, label: HOST_WORDS.place.awakeRow, group: "place", enabled: true, checked: view.place.awake, hint: HOST_WORDS.place.awakeWhy },
          { id: HOST_MENU_LEAVE, label: HOST_WORDS.place.leaveRow(view.place.hostName), group: "place", enabled: true, destructive: true },
        ]),
  ];
}

/** What a row of the Hosts menu does, read back off its id; nothing for an id the list above never minted. */
export type HostMenuAction =
  | { kind: "switch"; alias: string | null }
  | { kind: "connect" }
  | { kind: "disconnect"; alias: string }
  | { kind: "awake"; on: boolean }
  | { kind: "leave" };

export function hostMenuAction(id: string): HostMenuAction | undefined {
  if (id === HOST_MENU_CONNECT) return { kind: "connect" };
  if (id === HOST_MENU_LEAVE) return { kind: "leave" };
  if (id.startsWith(HOST_MENU_AWAKE)) {
    const word = id.slice(HOST_MENU_AWAKE.length);
    return word === "on" || word === "off" ? { kind: "awake", on: word === "on" } : undefined;
  }
  if (id.startsWith(HOST_MENU_SWITCH)) {
    const alias = id.slice(HOST_MENU_SWITCH.length);
    return { kind: "switch", alias: alias === "" ? null : alias };
  }
  if (id.startsWith(HOST_MENU_DISCONNECT)) {
    const alias = id.slice(HOST_MENU_DISCONNECT.length);
    return alias === "" ? undefined : { kind: "disconnect", alias };
  }
  return undefined;
}

/** A colour as CSS spells it, with its alpha as a percent where one is given. */
export function fmtRgb(colour: Rgb, alpha?: number): string {
  const channels = `${colour[0]} ${colour[1]} ${colour[2]}`;
  return alpha === undefined ? `rgb(${channels})` : `rgb(${channels} / ${fmtPercent(alpha)})`;
}

export function fmtThemeVars(theme: WorkspaceTheme, appDark: boolean): ThemeVars {
  const alpha = effectiveOpacity(theme, appDark);
  const colours = theme.dots.map(dot => fmtRgb(dotColour(dot), alpha));
  const [first, second, third] = colours;
  const gradient =
    colours.length === 1
      ? `linear-gradient(${first}, ${first})`
      : colours.length === 2
        ? `linear-gradient(160deg, ${second} 0%, transparent 100%), linear-gradient(340deg, ${first} 0%, transparent 100%)`
        : `radial-gradient(circle at 0% 0%, ${first} 0%, transparent 70%), radial-gradient(circle at 100% 0%, ${second} 0%, transparent 70%), linear-gradient(to top, ${third} 0%, transparent 65%)`;
  return { "--space-gradient": gradient, "--space-grain": String(theme.grain), "--space-tint": fmtRgb(themeInk(theme, appDark)) };
}
