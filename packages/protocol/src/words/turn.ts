// SPDX-License-Identifier: AGPL-3.0-only
import type { TitleSource, TurnRefusal, TurnResult } from "../index.js";
import type { ThreadMessage } from "../thread-read.js";
import { cutLine, ELLIPSIS, fmtThreads, lastLine, plural, wordsWithin } from "./base.js";
import { fmtCost, fmtDuration, fmtTokens } from "./units.js";
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

/** A turn that ended with no result and no reason from the runtime. */
export const NO_RESULT_LINE = "turn ended without a result";

/** How long a line a listing carries for a turn or a subagent runs, in characters: what a lead's tree draws under a
 * child. */
export const LISTED_LINE_CHARS = 200;

/** How much of what a subagent was asked its listing carries, in characters: enough to name the job, never the whole
 * brief, which the call that launched it already holds in the transcript. */
export const SUBAGENT_ASKED_CHARS = 280;

/** A line cut from a longer text as a string of its own: V8 answers a piece of 13 characters or more as a view into the
 * whole, so a row keeping the piece would keep the whole reply for as long as the row lives (measured 2026-10-09: 2000
 * one-word last lines of 50 KB replies held 100 MB). */
const ownCopy = (line: string): string => line.split("").join("");

/** The last line of a reply as a listing carries it; nothing where the reply has no words. */
export function listedLastLine(text: string | undefined): string | undefined {
  const last = lastLine(text ?? "");
  return last === undefined ? undefined : ownCopy(cutLine(last, LISTED_LINE_CHARS));
}

/** Why something failed as a listing carries it: the first line of the words, or the words a turn with none ends on. */
export function listedFailure(why: string | undefined): string {
  const first = (why ?? "").split(/\r?\n/).find(line => line.trim().length > 0)?.replace(/\s+/g, " ").trim();
  return ownCopy(cutLine(first ?? NO_RESULT_LINE, LISTED_LINE_CHARS));
}

/** What a subagent was asked, as its listing carries it. */
export const subagentAsked = (prompt: string): string => ownCopy(cutLine(prompt.trim(), SUBAGENT_ASKED_CHARS));

/** What a turn's end leaves on its row: the reply's last line, and why it failed where it did, off the result's error
 * else the end's reason, as a read of the thread words the same end. A turn that did not fail leaves no failure. */
export function turnLines(result: Pick<TurnResult, "status" | "text" | "error">, reason?: string): { lastLine?: string; failure?: string } {
  const last = listedLastLine(result.text);
  return { ...(last !== undefined ? { lastLine: last } : {}), ...(result.status === "failed" ? { failure: listedFailure(result.error ?? reason) } : {}) };
}

/** The tail alone: the length a person's sidebar row and a wait's reply field read. */
export function notifyTail(result: TurnResult): string | undefined {
  return notifyBody(result, "tail");
}

/** The one line a thread's end sends to whoever its start named, and the one a wait on it prints: the thread's first
 * eight characters, the outcome word with how long the turn worked and what it cost, then the reply at `length`. */
export function notifyLine(threadId: string, result: TurnResult, length: NotifyLength = "tail"): string {
  const clocked = turnWorkedMs(result);
  const facts = [result.status, ...(clocked !== undefined ? [fmtDuration(clocked.worked)] : []), ...(result.costUsd !== undefined ? [fmtCost(result.costUsd)] : [])];
  const body = notifyBody(result, length);
  return `thread ${threadId.slice(0, 8)} finished (${facts.join(", ")})${body !== undefined ? `: ${body}` : ""}`;
}

/** What the person is told of a message steered into a turn whose agent never read it, when it is not sent again:
 * the turn was stopped, or the thread's door refused it. Its first line, as a row reads one. */
export function unreadLine(prompt: string): string {
  const first = prompt.split("\n").find(line => line.trim() !== "")?.trim() ?? "";
  return `the agent never read this message: ${first}`;
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

/** The minutes a settled turn stood stopped on a question, said where they are most of what it took: the figure
 * beside it counts work, and a turn that did four seconds of work in three and a half minutes has to say where the
 * rest went or the two readings of the same turn cannot be reconciled. */
export function waitedOnYouPart(waitedMs: number): string {
  return `waited on you ${fmtDuration(waitedMs)}`;
}

/** How long a settled turn worked and how long of it went on the person: the harness clocks wall time from launch
 * to result, prompts included, and this is the one place that splits it. Every reading of a turn's length takes
 * this, so the chat footer and the line a thread's end sends can never say two different minutes about one turn. */
export function turnWorkedMs(turn: { durationMs?: number | null; waitedMs?: number | null }): { worked: number; waited: number } | undefined {
  if (typeof turn.durationMs !== "number") return undefined;
  const waited = Math.min(typeof turn.waitedMs === "number" && turn.waitedMs > 0 ? turn.waitedMs : 0, turn.durationMs);
  return { worked: turn.durationMs - waited, waited };
}

/** What a settled turn says beside its outcome word, in the order every client shows it: how long it worked, what
 * it cost, and what the threads it opened cost where it opened any. The app's chat footer and the command line's
 * last line read from this one list. Worked for counts work: the spans the turn stood on a prompt nobody had
 * answered come off it, and where they outweigh the work they are said in their own part. */
export function turnSettledParts(turn: { durationMs?: number | null; costUsd?: number | null; waitedMs?: number | null }, openedCostUsd?: number | null, spendWord?: string): string[] {
  const opened = typeof openedCostUsd === "number" && openedCostUsd > 0;
  const parts: string[] = [];
  const clocked = turnWorkedMs(turn);
  if (clocked !== undefined) {
    parts.push(`Worked for ${fmtDuration(clocked.worked)}`);
    if (clocked.waited > clocked.worked) parts.push(waitedOnYouPart(clocked.waited));
  }
  if (typeof turn.costUsd === "number") parts.push(opened ? turnSpendPart(turn.costUsd, spendWord) : spendFigure(turn.costUsd, spendWord));
  if (opened) parts.push(openedSpendPart(openedCostUsd));
  return parts;
}

/** What a reply ran on and what it read and wrote, in the footer's order: the model, then the tokens in and out.
 * `modelLabel` is the name the app's picker gives the model; the command line has only the agent's id for it. */
export function turnFactsParts(turn: { model?: string | null; tokens?: { input: number; output: number } | null }, modelLabel?: string): string[] {
  const parts: string[] = [];
  const model = modelLabel ?? turn.model ?? undefined;
  if (model !== undefined && model !== "") parts.push(model);
  if (turn.tokens != null) parts.push(`${fmtTokens(turn.tokens.input)} in`, `${fmtTokens(turn.tokens.output)} out`);
  return parts;
}

/** The chat footer as one line, for a stream that has no footer: the outcome word, then what it worked and cost.
 * `spendWord` is what the figure is, where the surface knows: a turn on a computer of the person's own ran on
 * their own sign-in and its figure is LIST_PRICE_WORD, which is the word the app's footer already gives it. */
export function turnSettledLine(result: TurnResult, spendWord?: string): string {
  return [result.status, ...turnSettledParts(result, undefined, spendWord)].join("  ");
}

/** A compaction's line in the thread, with what the model held before and after it where the agent said. */
export function compactedLine(before: number | undefined, after: number | undefined): string {
  if (after === undefined) return "Compacted the context";
  return before === undefined ? `Compacted the context to ${fmtTokens(after)} tokens` : `Compacted the context, ${fmtTokens(before)} to ${fmtTokens(after)} tokens`;
}

/** The agent's step list as a read transcript's row says it: the count done, then one task line per step. */
export function planStepsLine(steps: ReadonlyArray<{ text: string; state: "pending" | "working" | "done" }>): string {
  const done = steps.filter(s => s.state === "done").length;
  const lines = steps.map(s => `- [${s.state === "done" ? "x" : " "}] ${s.text}${s.state === "working" ? " (working)" : ""}`);
  return [`Plan: ${done} of ${steps.length} steps done`, ...lines].join("\n");
}

/** What a turn changed in its folder, as a read transcript's row says it: the files and the lines added and taken, and
 * in a folder other threads worked in too, what else changed there, or that the list is the folder's
 * (SessionChangesEvent). */
export function turnChangesLine(changes: { files: ReadonlyArray<{ additions: number; deletions: number }>; others?: ReadonlyArray<unknown>; shared?: true }): string {
  const { files, others } = changes;
  const added = files.reduce((n, f) => n + f.additions, 0);
  const taken = files.reduce((n, f) => n + f.deletions, 0);
  const count = `${plural(files.length, "file")}, +${added} -${taken}`;
  if (others !== undefined) {
    const own = files.length === 0 ? "No files from this thread's edits" : `Changed ${count}`;
    return others.length === 0 ? own : `${own}; ${plural(others.length, "file")} also changed in this folder`;
  }
  return changes.shared === true ? `${plural(files.length, "file")} changed in this folder, +${added} -${taken}; other threads worked in it too` : `Changed ${count}`;
}

/** The row a turn's end leaves in a read transcript: the footer above, and why it did not complete where it did
 * not, since a reader of a failed turn needs the reason with the word. */
export function turnEndLine(result: TurnResult): string {
  const failure = result.status === "completed" ? undefined : result.error;
  const line = [turnSettledLine(result), ...turnFactsParts(result)].join("  ");
  return failure === undefined ? line : `${line}: ${failure}`;
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
    ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
    ...(result.model !== undefined ? { model: result.model } : {}),
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

/** The note a turn carries where the machine held no session for the thread to resume (a Boat box woke with none on
 * 2026-09-27): the turn ran in a new session, which the thread so far was handed as its first message. */
export const LOST_SESSION_NOTE = "the agent's session for this thread was gone from the machine, so this turn started a new one and handed it the thread so far";

/** The first message of that new session: the thread so far, then the person's message as they sent it. */
export const lostSessionPrompt = (thread: string, prompt: string): string =>
  `Your earlier session for this thread was lost, so it continues here in a new one. The thread so far, oldest first:\n\n${thread}\n\nThe new message:\n\n${prompt}`;

/** Text cut to one line: its first non-empty line with the whitespace collapsed, so a multi-paragraph brief is one
 * row in the CLI's table and one line in the sidebar, and a heredoc of a command is one line of a turn's activity. */
export function titleLine(text: string): string {
  const first = text.split(/\r?\n/).find(l => l.trim().length > 0) ?? "";
  return first.replace(/\s+/g, " ").trim();
}

/** The most characters a thread title made from its opening turn takes, the ellipsis counted. */
const OPENING_TITLE_MAX = 48;

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

/** The line that opens the block of landed paths after a message's words in the prompt an agent is handed. */
export const ATTACHED_FILES_HEAD = "Attached files:";

/** Where a title read out of the harness's own store came from: one that is the prompt the thread opened with, or its
 * head, is the seed under the harness's roof (codex names a thread from it the moment it starts, every line of the
 * prompt in its title column, the block of attached paths included) and the thread is still asked for a name; any
 * other is the person's rename or the harness's own made name, and stands. The paths are the machine's and the row
 * keeps none, so a prompt with files is matched as the opening words and that block's head. */
export function storedTitleSource(stored: string, opening: string | undefined): TitleSource {
  if (opening === undefined) return "person";
  const title = stored.replace(/\s+/g, " ").trim();
  const handed = `${opening.replace(/\s+/g, " ").trim()} ${ATTACHED_FILES_HEAD}`;
  return title !== "" && (handed.startsWith(title) || title.startsWith(handed)) ? "seed" : "person";
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
