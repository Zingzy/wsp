// SPDX-License-Identifier: AGPL-3.0-only
import type { HarnessCatalog, MachineSizeOffer, MachineState, WorkspaceSize, WorkspaceView } from "../index.js";
import { namesPlace } from "../place-word.js";
import { shellLine } from "../shell-quote.js";
import { nameList, plural } from "./base.js";
import { chargesNothing, fmtBytes, fmtBytesOf, fmtDuration, fmtRate, fmtSize, fmtUptime } from "./units.js";
/** A limit as one unit: whole hours when it is hours, else whole minutes. */
export function fmtLimit(ms: number): string {
  return ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`;
}

/** Which rule ended a turn: idle is the turn doing nothing at all for the limit, TURN_IDLE_MS's own rule, and wall
 * is the turn limit set on the computer it ran on. */
export type TurnCutRule = "idle" | "wall";

/** The one line every client shows for a turn the runtime cut: which rule, how long the turn ran, the limit. */
export function turnCutLine(rule: TurnCutRule, elapsedMs: number, limitMs: number): string {
  return rule === "idle"
    ? `stopped after ${fmtDuration(elapsedMs, "clock")} with no output for ${fmtLimit(limitMs)}`
    : `stopped after ${fmtDuration(elapsedMs, "clock")} at the ${fmtLimit(limitMs)} turn limit; send to continue where it stopped, or change the limit in Settings > Computers`;
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
    return "the host does not serve this line; it runs another version of wsp, restart it with wsp restart";
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

/** What a send is told when the host stopped before it took the message and no host took it after: no turn runs and
 * nothing waits in the thread, so the person has to send it again. */
export const NOT_DELIVERED_LINE = "the host stopped before it took the message, so it was not delivered; send it again";

/** What a machine is called when the provider reports it running and the road every command takes is dead: whose
 * machine it is, which one, and the guest's own words, so the failure reads as the provider's and not as wsp's. */
export function guestUnusableLine(provider: string, machineId: string, detail: string): string {
  return `${provider} left ${machineId} running but nothing on it can run: ${detail}`;
}

/** What a machine is called when the provider answers that it cannot reach it: the provider's own words, then the two
 * roads open on a running machine. A wake of a running machine changes nothing and a rebuild is refused while the
 * machine is only not answering, so neither is named; the machine's id is nothing a person acts on. */
export function machineUnreachableLine(said: string): string {
  return `the provider cannot reach the machine (${said}); pause and wake the workspace, or delete it`;
}

/** The daemon's link came back while the provider's exec stayed down (2026-09-23), and its retryable 502 is documented for pause, not exec, so wait comes first. */
export function execFailedLine(said: string): string {
  return `the provider cannot run commands on the machine (${said}) while the machine and its threads may still be running; wait, or pause and wake the workspace, or delete it`;
}

/** A pause the provider refuses outright: its words, the cause measured on Solari (about 10 GB of memory and disk together), the road left. */
export function napRefusedLine(said: string): string {
  return `the provider does not pause this machine (${said}): its memory and disk together are over what it pauses; it runs until you delete it`;
}

/** A stop the provider would not take while the snapshot of the machine's disk fails, which it does rather than lose
 * what was written since the last one (Boat): its own reading, the cause seen (a full disk), and the road left. A Boat
 * machine whose stops kept failing was dropped with its disk on 2026-10-01, so pushing comes first. */
export function stopRefusedLine(said: string): string {
  return `the provider will not stop this machine while the snapshot of its disk fails (${said}): push its work, then free space on its disk, since a full disk fails the snapshot and a machine left like this has been dropped with its disk`;
}

/** How full a disk may be before its row says so, said only past it: past this a build's output can fill the rest
 * between two turns, and a stop that snapshots a full disk fails. */
export const DISK_FULL_PCT = 90;

/** A machine whose stop snapshots its disk, past DISK_FULL_PCT: said before a stop can fail. The share is cut to a
 * tenth and never rounded up, so a disk just past the line never reads as standing on it. */
export function diskFullLine(pct: number): string {
  return `its disk is ${Math.floor(pct * 10) / 10}% full: a stop snapshots the disk and fails once it is full, so free space on it (build output, caches) before it naps`;
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

/** The last line of a reply whose process ended while the agent's own background tasks were still running: the turn
 * reads done, since the work left running is not its failure, and this names that work. */
export function backgroundTasksLine(running: number): string {
  return `ended with ${plural(running, "background task")} running`;
}

/** One line under a held reply for a background command that finished after the agent's words without waking it: the
 * command as the harness described it, how it ended and how long after the reply, so the thread's last message says
 * what the turn stayed open for and what came of it. Where the harness wakes the agent instead, its own next reply
 * is the report and no line of ours is added. */
export function taskFinishedLine(description: string, status: string, msAfterReply: number): string {
  return `\`${description}\` ${status}, ${fmtDuration(msAfterReply)} after the reply`;
}

/** What a launch that woke a machine and then died before its agent said a word answers with. The wake was this
 * launch's and nothing else ran there, so the machine goes back where the launch found it rather than billing out
 * an idle window for work that never happened. */
export const workspaceAsleepAgainLine = (name: string): string => `${name} is asleep again`;

/** The same launch on a machine it did not wake, or one another thread is working on: nothing is touched, so the
 * line says what that costs by naming when the idle window takes it. Whole minutes, since nothing turns on the
 * seconds and a countdown a person reads once need not move. */
export const workspaceStaysAwakeLine = (name: string, napsInMs?: number): string =>
  `${name} stays awake${napsInMs === undefined ? "" : `, naps in ${fmtUptime(napsInMs)}`}`;

/** The reason a status carries when the runtime's idle policy napped a workspace, with the one reading of it back
 * beside it: the runtime stamps the nap through `of` and the app's paused line takes the window out through
 * `windowIn`, so the words and their parse are one thing and a rewording moves both at once. */
export const IDLE_REASON = {
  of: (windowMs: number): string => `idle ${Math.round(windowMs / 60_000)} min`,
  /** The window inside that reason, as its own words (`20 min`); nothing for a reason of any other shape, which is
   * every reason a nap the person asked for or a wake wrote. */
  windowIn: (reason: string | undefined): string | undefined => (reason === undefined ? undefined : (/^idle (\d+ min)$/.exec(reason)?.[1] ?? undefined)),
} as const;

/** What a window on another computer says while the wsp it shows has gone quiet: the computer that host runs on is
 * asleep or off, and the workspaces on every other computer keep working. It reads as a fact in the sidebar's own
 * prose line and as the send's reason, never as an alert: nothing is broken and nothing is lost. */
export const HOST_ASLEEP_LINE = "your Mac is asleep; threads on your other computers keep running";
export const HOST_ASLEEP_SEND = "your Mac is asleep; new turns start when it wakes";

/** One line per retry of a provider call that never left this computer: which call, the system error the road gave,
 * and which try of how many is about to go, so a run that still fails carries the whole flap in its log. */
export function providerRoadRetryLine(call: string, code: string, tryNumber: number, tries: number): string {
  return `${call} did not leave this computer (${code}); try ${tryNumber} of ${tries}`;
}

/** A fork the provider refused as "Snapshot not found" while its own listing holds that snapshot, asked again. */
export function snapshotListedWaitLine(snapshotId: string, waitMs: number, waitedMs: number): string {
  return `the provider lists snapshot ${snapshotId} yet answered "Snapshot not found"; asking again in ${fmtDuration(waitMs)} (${fmtDuration(waitedMs)} so far)`;
}

/** The same wait as a line of the create a person follows, one per ask: the lines' own pace is how long it has been. */
export function imageServedWaitLine(provider: string, waitMs: number): string {
  return `waiting for ${provider} to serve the image; asking again in ${fmtDuration(waitMs)}`;
}

/** The same refusal once the wait for it has run out: the snapshot is listed, so it is not gone. */
export function snapshotListedRefusedLine(snapshotId: string, waitedMs: number): string {
  return `the provider lists snapshot ${snapshotId} yet answered "Snapshot not found" for ${fmtDuration(waitedMs)}; it is not gone, so ask again in a minute`;
}

/** When a turn is over, in the one sentence every door the agent reads quotes whole: the skill, the tool
 * descriptions, the command line's help and the machine's own context. The reply comes back at once from a follow;
 * the row settles only at the process exit, since a harness can keep working after it answers. */
export const TURN_END_WORDS = "A turn ends when the agent process exits, not at its reply, and the thread reads running until then";

/** What another agent is, quoted whole by every door an agent reads before it picks a tool: the launch context, the
 * tool server's instructions, the run tool and the skill. An agent's own subagent tool answers inside its turn and
 * never reaches the sidebar, so the person asking for a second model or harness would see nothing of it. */
export const ANOTHER_AGENT_WORDS =
  "When the person asks for another agent, on another model or another harness, start it as a wsp thread with run, so it shows in their sidebar; your own subagent tool is for your own sub-steps";

/** How an agent starts work it wants to hear back from, quoted whole by the skill's rules and the machine's context:
 * the harness tracks its own background road and wakes the agent when it ends, and nothing tracks a shell `&`. The
 * machine context names the road by the agent's catalog entry where it carries one; the skill, read by every agent,
 * names none. */
export const backgroundWorkWords = (road?: string): string =>
  `Start long work with ${road ?? "your harness's own background road"}, which wakes you when it ends, and never with a shell &, which nothing tracks and which wakes nobody when it ends`;
export const BACKGROUND_WORK_WORDS = backgroundWorkWords();

/** When the notify line goes, quoted the same way: with the reply, once, never again at the exit. A reply the agent
 * gave while work it started was still running is delivered when that work is done, and the line goes with it. */
export const NOTIFY_WORDS = "The notify line goes once, at the reply, and a reply given with background tasks still running goes once they are done";

/** Which road a caller takes to its children's ends, in the two sentences every door quotes whole: the skill's rules,
 * the tool descriptions and the command line. Which one holds is decided by whether the caller is a thread, which its
 * launch environment says; nothing else decides it, and a blocking wait is neither road. */
export const NOTIFY_CALLER = "A wsp thread starts every child with --notify me and ends its turn, and each child's finished line wakes it with that child's whole report";
export const COORDINATOR_HANDOFF =
  "A caller that is not a wsp thread cannot be woken at all, so it takes the reply of one turn as the call returns, and hands work of more than one turn to a single coordinator thread in the project's folder on this computer";

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

/** Text with every hidden value blanked wherever it appears, as written and trimmed: a door that trims what it read
 * before echoing it would otherwise slip the padded value past. Longest first, so a value that is another's prefix
 * leaves no tail; a value under four characters once trimmed is no key, token or code and would blank the sentence
 * letter by letter. The one rule every log that must not hold a secret reads. */
export function redacted(text: string, hidden: readonly string[]): string {
  const values = [...new Set(hidden.flatMap(h => (h.trim().length < 4 ? [] : [h, h.trim()])))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join("<redacted>");
  return out;
}

/** A schema's issues on one line, each as its path and its message, for a log or a refusal that names what was wrong
 * rather than dumping the issue list. */
export function issuesLine(issues: readonly { path: readonly (string | number)[]; message: string }[]): string {
  return issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
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

/** The refusal of a side question on a thread whose agent never announced a session: there is no conversation of
 * its own to copy and ask. */
export const ASIDE_NO_SESSION_LINE = "this thread's agent has not started a conversation yet, so there is nothing to ask about; wait for its first reply";

/** The refusal of a side question with no words in it. */
export const BLANK_ASIDE_LINE = "a side question needs words to ask";

/** The refusal of a side question on a thread whose agent cannot copy a session. A message the thread should keep is
 * a send, which every agent takes. */
export function asideUnsupportedLine(harness: string): string {
  return `${harness} takes no side question; send it as a message and the thread keeps it`;
}

/** Why a side question came back with no answer: the harness said nothing for the whole wall and was stopped. */
export function asideWallLine(ms: number): string {
  return `the side question had no answer after ${fmtDuration(ms)} and was stopped`;
}

/** A rewind refused on a thread whose turn is running: the person stops it, never the rewind. */
export const REWIND_WORKING_LINE = "this thread is working; stop its turn first, since a rewind never stops it for you";

/** A rewind refused on a thread with threads under it that still run, named, so the person stops the ones they mean. */
export function rewindChildrenLine(titles: readonly string[]): string {
  return `stop the threads under this one first (${titles.join(", ")}); a rewind never stops them for you`;
}

/** An undo refused while another thread in the same folder runs: the files would go back under its agent mid-turn,
 * and nobody chose to lose what it is writing. */
export function rewindBesideLine(title: string): string {
  return `another thread in this folder is working (${title}), and its files would go back too; let its turn end or stop it first`;
}

/** Why a rewind put the conversation back and left the files: another thread worked in the folder after that reply,
 * and its work is in those files too. */
export const REWIND_SHARED_LINE = "another thread worked in this folder after that reply, so only the conversation goes back";

/** Files asked back to a turn whose end left no checkpoint of them. */
export const REWIND_NO_CHECKPOINT_LINE = "that reply kept no checkpoint of the files, so only its conversation can be rewound";

/** A conversation asked cut at a turn whose harness named no point to cut at. */
export function rewindNoAnchorLine(agent: string): string {
  return `${agent} left no point in that reply to cut its conversation at, so only the files can go back`;
}

/** A rewind whose harness kept the conversation whole, `why` in its own clause: what moved and what stayed. */
export function rewindKeptLine(why: string, filesBack: boolean): string {
  return `${why}; ${filesBack ? "the files went back and every turn stays" : "every turn stays"}`;
}

/** Why a Codex thread's conversation cannot be cut: the server cuts only the paginated history a Codex from 0.151.0
 * on writes. */
export const CODEX_LEGACY_HISTORY = "a Codex older than 0.151.0 made this thread and keeps its history in a form thread/revert cannot cut";

/** A Codex rewind by count whose server lists fewer turns than the cut would take: cutting there would take the
 * reply the person keeps too. */
export const CODEX_FEWER_TURNS = "codex lists fewer turns in this thread than the rewind would cut, so it cut nothing";

/** A rewind to the thread's latest reply, after which nothing stands to cut. */
export const REWIND_LATEST_LINE = "that is the thread's latest reply, so nothing comes after it to rewind";

/** An undo with no rewind to undo, or one a turn in the same folder has ended since. */
export const REWIND_NO_UNDO_LINE = "this thread has no rewind to undo; undo lasts until the next turn in this folder ends";

/** What Undo rewind puts back, said beside it: the files, and never the turns the rewind cut. */
export const UNDO_REWIND_LINE = "Files come back; the cut conversation does not.";

/** Said beside every rewind that moves files: they are the whole copy's, so another thread's work goes back too. */
const WHOLE_COPY = "The whole copy's files go back, other threads' work included.";

const turnsAfter = (turns: number): string => (turns === 1 ? "The turn after this reply leaves" : `The ${turns} turns after this reply leave`);

/** What a rewind to a reply takes, said before the click: how many turns go, whether the files go back, and what
 * Undo rewind brings back after. An agent that cuts no history of its own keeps every turn, and the note says so. */
export function rewindNote(o: { turns: number; files: boolean; cutsConversation: boolean; agent: string; kept?: string }): string {
  const undo = "Undo rewind puts them back until the next turn in this copy ends";
  if (o.kept !== undefined) return `${o.kept.charAt(0).toUpperCase()}${o.kept.slice(1)}, so the conversation stays and the files go back to how they stood at this reply. ${WHOLE_COPY} ${undo}.`;
  if (!o.cutsConversation) return `${o.agent} keeps its own history, so the conversation stays and the files go back to how they stood at this reply. ${WHOLE_COPY} ${undo}.`;
  if (!o.files) return `${turnsAfter(o.turns)} the conversation; the files stay as they are.`;
  return `${turnsAfter(o.turns)} the conversation, and the files go back to how they stood at this reply. ${WHOLE_COPY} ${undo}; the conversation does not come back.`;
}

/** The refusal of a send into a thread that names another agent. A thread's rows carry the agent its turns ran on
 * and the harness session those turns wrote, which another agent would open as a transcript of its own, at its own
 * access; the agent is picked where a thread is opened, so a second one is a second thread. */
export function threadRunsOnLine(agent: string, asked: string): string {
  return `this thread runs on ${agent}; open a new thread to run ${asked}`;
}

/** The refusal of a thread opened on no words: an empty or whitespace task would still start a process and a turn. */
export const EMPTY_MESSAGE_LINE = "the message is empty; say what the thread is to do";

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
  return version === null ? why : `${why}, ${version}`;
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
  return `Out of memory (${fmtBytes(r.used)} of ${fmtBytes(r.total)} used, load ${r.load1.toFixed(1)}) when the task last answered; the work on it took the memory, not a fault of the computer it runs on`;
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
  if (bigger === undefined) return "No size with more memory is offered; run less in the task at once";
  return `A task on ${fmtSize(bigger)} (${fmtRate(bigger.rateUsdPerHour)}) fits more; pick it when you make the next one`;
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

/** What a landing is refused with when the agents' state a machine answered with holds something that is neither a
 * folder nor a regular file, or a path that reaches out of the folder it was opened in: the entry as it sits in the
 * archive and what it is. The bytes are the machine's, the landing is the person's, and one such entry is a road
 * into the agents' own files on this computer, so nothing of that archive lands. */
export function stateEntryRefusal(entry: string, what: string): string {
  return `the agents' state from the machine holds ${entry}, which is ${what}; nothing of it was landed`;
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

/** A copy's first line on the computer the host runs on: the folder it is made of and the folder it becomes. */
export const copyingFolderLine = (from: string, to: string): string => `copying ${from} to ${to}`;

/** How long a build is said to take where none has been measured. */
export const BUILD_TAKES_UNMEASURED = "about ten minutes";

/** The creation log's first line for a fork at a place that holds no current copy of the image: the copy is built
 * there before the fork, which takes a build's time and, where the place charges, a builder's hours. */
export function copyFirstLine(where: string, name: string, rateUsdPerHour: number): string {
  const billed = chargesNothing(rateUsdPerHour) ? "" : `, billed at ${fmtRate(rateUsdPerHour)} while it builds`;
  return `building your image on ${where} first, ${BUILD_TAKES_UNMEASURED}${billed}, then ${name} forks from it`;
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

/** A moment as a person reads it in a line of wsp's own: UTC to the second, since the milliseconds are noise in a
 * sentence and a second is what a reader compares two lines by. The one spelling, read wherever a line carries a
 * time of its own. */
export const isoSeconds = (at: number): string => new Date(at).toISOString().replace(/\.\d+Z$/, "Z");

/** What a record says about a machine the provider stopped knowing: which call found it gone and the second it did,
 * quoting the provider where it said anything. Without a sighting, only that it is gone. */
export function goneWords(machineId: string, seen?: GoneSighting): string {
  const base = `machine ${machineId} is gone at the provider`;
  if (seen === undefined) return base;
  const at = isoSeconds(seen.at);
  const answer = seen.answer === undefined || seen.answer === "" ? "" : ` (${seen.answer})`;
  return `${base}: the ${seen.by} found it gone at ${at}${answer}`;
}

/** The machine row's line when a record that said paused met a machine the provider was running all along (a nap
 * whose pause never took, a resume nobody wrote): the record followed the fact and nothing was resumed. */
export const ALREADY_RUNNING = "already running at the provider";

/** The machine row's line when a record marked gone met a machine the provider still holds, running or paused: the
 * state read by id decides, so the record is gone no more and no rebuild abandoned a healthy machine. */
export const NOT_GONE = "not gone at the provider after all; the record follows the state read";

/** The machine row's line when a 404 was to be confirmed and the reads that followed failed: nothing is known
 * either way, so the record keeps its word and the next sweep asks again. */
export const GONE_UNCHECKED = "not known to be gone; wsp could not reach the provider to check it";

/** What a record held on one 404 at host start answers until the provider has been read again. */
export const goneUnconfirmedLine = (machineId: string, answer: string): string =>
  `machine ${machineId} answered ${answer} when this host started; wsp is asking the provider again before it calls it gone`;

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

/** A delete whose machine the provider still reads after three asks: the record stays, so the machine is still named. */
export function deleteRefusedLine(name: string, machineId: string, state: MachineState): string {
  return `${name}'s machine ${machineId} is still ${state} after three asks; run wsp delete again or delete it at the provider`;
}

/** The refusal a fork or a rename gets for a blank name: a person and an agent both address a workspace by its name. */
export const BLANK_NAME_REFUSAL = "a workspace name cannot be blank";

/** The one sentence every machine road answers with on a computer set up with no machine provider key: wsp init took
 * the local road, so this computer is a workspace and there is nothing to fork, pause or seal until a provider is
 * added. The provider module a keyless host wires says it, and so does the command line before it asks for anything.
 *
 * It ends on the verb off the front page that fixes it, never on a shell variable: this is the first refusal a
 * person who typed wsp new on a fresh home reads, and a variable named there is neither one of the sixteen words
 * nor true of the other providers. wsp add with no argument prints the words it takes. */
export const NO_PROVIDER_LINE = "no machine provider is set up on this computer, so wsp forks no machines here; wsp add <provider> connects one, and wsp init then builds your image on it";

/** The same refusal where no provider can be added at all: what is missing, and the one road that brings it. */
export const NO_MACHINES_LINE = "this needs a machine wsp starts, and nothing here starts one; wsp add user@host joins a computer of yours that does";

/** What an image build is refused with when no place this host holds runs workspaces: a joined computer whose doctor
 * said yes is such a place, and so is a provider with a key. The init job and the command line beside it both say it. */
export const NO_BUILD_PLACE_LINE = "no place here runs workspaces, so there is nowhere to build your image; join a computer that runs them with wsp add, or save a provider key";

/** The same when the default place runs no workspaces and more than one other place does: the run does not guess. */
export const buildPlaceAskLine = (names: readonly string[]): string => `${names.join(", ")} run workspaces and none of them is the default place; name the one to build your image on with --on`;

/** What a fork is refused with when the place it would land on forks nothing while other places run workspaces: the
 * places that do, so the sentence never sends a person to a provider they do not need. With none at all the
 * refusal is NO_PROVIDER_LINE. */
export const placeForksNothingPickLine = (place: string, names: readonly string[]): string => `${place} forks no machines; name a place that runs workspaces with --on: ${names.join(", ")}`;

/** The line under wsp init's opening that names where the image is built, so the first screen says it. */
export const imageBuiltOnLine = (place: string): string => `your image is built on ${place}`;

/** The line beside it when --on named a place other than the image's own: a rebuild never moves the image's home. */
export const imageHomeKeptLine = (on: string | undefined, home: { id: string; name: string }): string | undefined =>
  on === undefined || namesPlace(home, on) ? undefined : `your image lives on ${home.name}, so it is built there and not on ${on}`;
