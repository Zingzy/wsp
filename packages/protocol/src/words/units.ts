// SPDX-License-Identifier: AGPL-3.0-only
import type { InitDraft, InitJob, InitScreen, InitScreenId, MachineSizeOffer, PlaceCapacity, WorkspaceSize } from "../index.js";
import { plural } from "./base.js";
export const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** Bytes as a person reads them, in binary units: whole under a gigabyte, since a tenth of a megabyte is noise at that
 * scale, and GB with one decimal unless whole. */
const COMPACT_UNITS = ["", "K", "M", "G", "T"];

/** rss as a process table column with a three-digit budget fmtBytes does not fit, so its own rule: 900, 12K, 1.5M, 123M, 2.3G. */
export function compactBytes(n: number): string {
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1000 && i < COMPACT_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i === 0 ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : String(Math.round(v));
  return `${text}${COMPACT_UNITS[i]}`;
}

export function fmtBytes(n: number): string {
  if (n < KIB) return `${n} B`;
  if (n < MIB) return `${Math.round(n / KIB)} KB`;
  if (n < GIB) return `${Math.round(n / MIB)} MB`;
  const gb = n / GIB;
  return `${Number.isInteger(Number(gb.toFixed(1))) ? Math.round(gb) : gb.toFixed(1)} GB`;
}

/** A size said to be over a cap: past 1 MB with one decimal rounded up, so a file a byte over a cap never reads as
 * the cap itself. */
export function fmtBytesOver(n: number): string {
  if (n < MIB || n >= GIB) return fmtBytes(n);
  return `${(Math.ceil((n / MIB) * 10) / 10).toFixed(1)} MB`;
}

/** What a row reads where the catalog has measured no size. */
export const UNKNOWN_SIZE = "size unknown";

/** How often the agents ran a tool here, the one number a usage row shows. */
export const fmtCalls = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "call" : "calls"}`;

/** The tally under a screen's card, first half: the count of rows on the image, so a view can colour the estimate after it on its own. The
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
 * tone, 200 MB and over the warning tone, 50 MB and over the yellow tone, anything under muted. */
export type SizeTone = "danger" | "warning" | "yellow" | "muted";
const SIZE_TONES: readonly (readonly [number, SizeTone])[] = [
  [1024 * MIB, "danger"],
  [200 * MIB, "warning"],
  [50 * MIB, "yellow"],
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

/** A count of cpus in the kind's word: "1 core" and "2 cores", while a provider's vCPU reads the same at any count. */
export function fmtCpus(n: number, cpu: CpuWord = "vCPU"): string {
  return `${n} ${cpu === "cores" && n === 1 ? "core" : cpu}`;
}

/** A size as the sidebar row and the Machine tab show it: "2 vCPU, 4 GB", or "10 cores, 16 GB"
 * in the word the machine's kind has for a cpu. A size offer is always a provider's, so the provider's word is the default. */
/** The size joins its words with no-break spaces, so a sentence carrying it never breaks between a number and its unit. */
export function fmtSize(size: WorkspaceSize, cpu: CpuWord = "vCPU"): string {
  return `${fmtCpus(size.cpu, cpu)},\u00a0${fmtMemGb(size.memMb)}`.replace(/ /g, "\u00a0");
}

/** What the create says where the machine it got is not the size it was forked at, the one asked for or else the
 * image's own: both sizes, in the row's own words. */
export function sizeGotLine(asked: WorkspaceSize, got: WorkspaceSize, named: boolean): string {
  return `${named ? "asked for" : "the image's size is"} ${fmtSize(asked)}; the machine has ${fmtSize(got)}`;
}

/** What a computer of the person's own is worth saying in one line: the cores and memory it has, and the room left
 * where its threads work. The one reading, so the screen a computer joins on and the row it lands in later cannot
 * describe the same computer differently. A computer that would not say how much room it has leaves that out. The
 * whole line is joined with no-break spaces, fmtSize's own rule carried on: it is one phrase about one computer. */
export function placeFactsLine(shape: WorkspaceSize, diskFreeBytes?: number): string {
  const parts = [fmtSize(shape, "cores"), ...(diskFreeBytes === undefined ? [] : [`${fmtBytes(diskFreeBytes)} free`])];
  return parts.join(", ").replace(/ /g, "\u00a0");
}

/** The room a box has left, as the doctor reads it back: what the computer has, what the workspaces on it hold
 * right now, and what is left over. One line for the cores and one for the memory, built the same way so neither
 * can say a different thing about the same box; a computer that counts neither says nothing rather than a guess. */
export function boxRoomLines(capacity: Pick<PlaceCapacity, "cores" | "memMb" | "cpuTaken" | "memTakenMb">): string[] {
  const { cpuTaken, memTakenMb } = capacity;
  if (cpuTaken === undefined || memTakenMb === undefined) return [];
  return [
    `${fmtCpus(capacity.cores, "cores")}, ${cpuTaken} in use by forks, ${Math.max(0, capacity.cores - cpuTaken)} free`,
    `${fmtMemGb(capacity.memMb)}, ${fmtMemGb(memTakenMb)} in use by forks, ${fmtMemGb(Math.max(0, capacity.memMb - memTakenMb))} free`,
  ];
}

/** What a row the computer already had says where the command answered from a directory that row's own road never
 * links into: the path it answered from, and the directories the road puts its commands in. The path is a fact the
 * read already has; the road that did answer is not named, since several roads link into the same directory and
 * naming one would be a guess. Read by the computers row, by the app's line for it and by the doctor. */
export const presentElsewhereLine = (bin: string, path: string, roadWords: string, bins: readonly string[]): string =>
  `${bin} answers from ${path}, outside where ${roadWords.replace(/^(?:by|with|as|from) /, "")} puts it (${bins.join(", ")})`;

/** What the doctor adds to a tool it found missing inside a workspace that the computer's own row read present:
 * the two readings disagree, which is either a tool that went off the computer since or one that answers from
 * somewhere no workspace can see, and the line that reads the computer again settles it. */
export const doctorComputerRowLine = (name: string, finishedAt: string): string =>
  `the computers row read it present at ${finishedAt}; wsp add ${name} --update reads it again`;

/** Why the folders of a provider are refused: a workspace there is forked fresh, so there is no computer standing
 * to browse, and a project there starts from a repository address or from a folder here, which seeds it. */
export const providerFoldersRefusal = (name: string): string =>
  `${name} keeps no computer to browse, since every workspace there is forked fresh; add the project from a repository address, or from a folder on this computer, which seeds it`;

/** Why a doctor's computer road was refused for a row that is not a computer somebody joined: the computer the
 * host runs on and a cloud account are proved by the terminal that typed the line, since one reads that computer's
 * own files and the other forks a machine and bills. */
export const doctorRowRefusal = (name: string): string =>
  `wsp doctor proves a computer you added on the host that holds its link; ${name} is proved at the terminal that typed the line`;

/** Why a second doctor on one computer is refused while the first is still going: two of them would make two
 * workspaces there and read the same tools twice. */
export const doctorRunningLine = (name: string): string => `the doctor is already proving ${name}; wait for it`;

/** What a host that serves the op without wiring the road answers: the road is the host's own, so a runtime served
 * without one has no computer to prove. */
export const DOCTOR_UNSERVED = "the host that answered wired no doctor for the computers it holds";

/** Why a copy on the computer the host runs on was refused: the daemon binary staged beside this wsp is older than
 * the one this wsp needs, which is what an update that rebuilt the host and not the binary leaves. Read before the
 * first copy is made, so the binary's own usage text never reaches a person as the refusal. */
export const hereDaemonBehindLine = (version: number, host: number, fix: string): string =>
  `this computer's wsp daemon is version ${version} and this wsp needs ${host}; ${fix} stages the right one`;

/** What a child verb's failure that the verb itself never worded comes to: one sentence naming the verb and where
 * its output is, since a parse error's usage text and a signal say nothing to the person who asked for a copy. */
export const copyVerbFailedLine = (exitCode: number): string => `the daemon's copy verb failed (exit ${exitCode}); the host log has its output`;

/** What a machine wsp neither forks nor pays for costs, on its row's cost line and the Machine tab's Cost row. */
export const FREE_WORD = "free";

/** Whether a place charges nothing an hour: a rate of nothing, and a rate nobody reported, both read free, since
 * neither is a figure to weigh against another. The one reading, so a caption that builds its own clauses and the
 * formatter below cannot disagree about which rows are free. */
export const chargesNothing = (usdPerHour: number | undefined): usdPerHour is undefined | 0 => usdPerHour === undefined || usdPerHour === 0;

/** A rate a person is being quoted before they pick: a size on offer, a place's own hourly price. A place that
 * charges nothing reads free, since $0.00/hr beside a row a person is choosing between reads as a figure that has
 * not arrived rather than as the fact that nobody is billed. A rate that was metered rather than quoted, which is
 * what a place is burning this minute, keeps its figure and reads fmtRate. */
export const fmtPrice = (usdPerHour: number): string => (chargesNothing(usdPerHour) ? FREE_WORD : fmtRate(usdPerHour));

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

/** A token count as a reply's footer reads it: whole under a thousand, then thousands and millions to one place,
 * with no trailing zero place. */
export function fmtTokens(n: number): string {
  const count = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  if (count < 1_000) return String(count);
  // Three figures in the unit, the decimals that leaves and no trailing zero: 4.27k, 22.6M, 7.37B, 687M.
  const [value, unit] = count < 999_500 ? [count / 1_000, "k"] : count < 999_500_000 ? [count / 1_000_000, "M"] : [count / 1_000_000_000, "B"];
  return `${Number(value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0))}${unit}`;
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
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Rupees as India writes them, lakh grouping and the ₹ sign: ₹1,44,740, paise only where the value has them. */
export function fmtInr(inr: number): string {
  const paise = Math.round(inr * 100) % 100 !== 0;
  return inr.toLocaleString("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: paise ? 2 : 0, maximumFractionDigits: paise ? 2 : 0 });
}

/** The word beside a figure nobody is billed for: what the agent's own table lists for the tokens a turn spent, on
 * a computer whose turns run on the person's own sign-in. */
export const LIST_PRICE_WORD = "list price";

/** Two byte counts against each other with the unit said once when they share it: "3.6 of 3.9 GB", "900.0 MB of 3.9 GB". */
export function fmtBytesOf(used: number, total: number): string {
  const t = fmtBytes(total);
  const u = fmtBytes(used);
  const unit = t.slice(t.lastIndexOf(" "));
  return `${u.endsWith(unit) ? u.slice(0, -unit.length) : u} of ${t}`;
}
