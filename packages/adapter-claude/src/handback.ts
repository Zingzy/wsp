// SPDX-License-Identifier: AGPL-3.0-only
// How a subagent's end reaches the fold on Claude Code 2.1.295, read into one book per turn. The CLI decides at each
// subagent's start whether it hands its report back (in auto mode, behind its own flag, never for a fork), and the
// stream says so only at the end: such a subagent calls SubagentHandback and its notification says how that went
// (`handback`, with the report as `handback_report`: send, flagged with a warning, or withheld), while the launching
// call is answered with a note to the model. Any other subagent's waited-on call is answered with the report inside a
// frame, and a backgrounded one only with a note. Either way the adapter hands the fold the report as the launching
// call's answer, the shape an older CLI wrote it in, and the subagent's page ends on it.
import { NO_REPORT_LINE, type AdapterEvent, type SubagentState } from "@wsp/protocol";
import { rec, str } from "./fields.js";

export type TurnDelta = Extract<AdapterEvent, { type: "turn.delta" }>;

/** The tool a subagent hands its report back with; the call is held until its result says whether anything went. */
const HANDBACK_TOOL = "SubagentHandback";

/** The line the CLI opens a report it frames with, at column zero; the report follows it, every line indented by two
 * spaces, and the CLI's own lines after it start at column zero again (2.1.295). */
const REPORT_FRAME = "[Subagent hand-back] ";

export interface HandbackBook {
  /** The CLI's handles for the turn's subagents; a background command is a task too, and none of this is for it. */
  subagents: Set<string>;
  /** Each task a subagent started, until its notification, with that subagent's handle (`parent_task_id`). */
  owned: Map<string, string>;
  /** The subagents a notification has ended: a later one for the same task replaces what it said. */
  notified: Set<string>;
  /** The launching calls whose subagents run in the background: their own answer is a note, never the report. */
  backgrounded: Set<string>;
  /** Each hand-back call until its result, drawn only where the CLI refused it. */
  held: Map<string, TurnDelta>;
  /** The launching calls a notification answered, with that answer, which the CLI's own answer after it gives way to. */
  answered: Map<string, string>;
  /** The last words each subagent wrote, by its launching call. */
  lastText: Map<string, string>;
}

export const newHandbackBook = (): HandbackBook => ({ subagents: new Set(), owned: new Map(), notified: new Set(), backgrounded: new Set(), held: new Map(), answered: new Map(), lastText: new Map() });

/** What a line says about the turn's tasks and subagents: a subagent started, in the background or not, a task one of
 * them started and its end, and a subagent's words. */
export function noteLine(book: HandbackBook, event: Record<string, unknown>): void {
  const subtype = str(event.subtype);
  const task = str(event.task_id);
  const call = str(event.tool_use_id);
  if (str(event.type) === "system" && subtype === "task_started" && task !== undefined) {
    const owner = str(event.parent_task_id);
    if (owner !== undefined) book.owned.set(task, owner);
    if (str(event.task_type) === "local_agent") book.subagents.add(task);
    if (str(event.task_type) === "local_agent" && event.is_backgrounded === true && call !== undefined) book.backgrounded.add(call);
  }
  if (isNotification(event) && task !== undefined) book.owned.delete(task);
  const parent = str(event.parent_tool_use_id);
  const blocks = rec(event.message)?.content;
  if (str(event.type) !== "assistant" || parent === undefined || !Array.isArray(blocks)) return;
  for (const block of blocks) if (str(rec(block)?.type) === "text") book.lastText.set(parent, str(rec(block)?.text) ?? "");
}

/** Holds a subagent's hand-back call until its result; false for any other call, which is drawn as it comes. */
export function heldCall(book: HandbackBook, call: TurnDelta): boolean {
  if (call.parentToolUseId === undefined || call.toolName !== HANDBACK_TOOL || call.toolUseId === undefined) return false;
  book.held.set(call.toolUseId, call);
  return true;
}

function parsed(text: string): Record<string, unknown> | undefined {
  try {
    return rec(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The report inside the CLI's frame, or nothing for an answer it did not frame. */
function unframed(text: string): string | undefined {
  if (!text.startsWith(REPORT_FRAME)) return undefined;
  const lines: string[] = [];
  for (const line of text.split("\n").slice(1)) {
    if (!line.startsWith("  ")) break;
    lines.push(line.slice(2));
  }
  return lines.join("\n").trim();
}

/** The lines one answer to a call draws. A hand-back that went draws none, its words coming with the notification; one
 * the CLI refused draws the call and why, as a failed call. A launching call the notification answered gives way to
 * that answer: the lead's own draws nothing, and a call inside a subagent, which its page shows, reads the same. */
export function readAnswer(book: HandbackBook, answer: TurnDelta): TurnDelta[] {
  const call = answer.toolUseId;
  if (call === undefined) return [answer];
  const handback = book.held.get(call);
  if (handback !== undefined) {
    book.held.delete(call);
    const said = parsed(answer.text);
    if (said?.success === true) return [];
    const why = str(said?.message);
    return [handback, why === undefined ? answer : { ...answer, text: why, isError: true }];
  }
  const given = book.answered.get(call);
  if (given !== undefined) {
    book.answered.delete(call);
    return answer.parentToolUseId === undefined ? [] : [{ ...answer, text: given }];
  }
  const report = unframed(answer.text);
  return [report === undefined ? answer : { ...answer, text: report }];
}

function isNotification(event: Record<string, unknown>): boolean {
  return str(event.type) === "system" && str(event.subtype) === "task_notification";
}

/** A subagent's notification sent while a task it started still runs: the CLI ends it then only to say it waits (with
 * no `handback`), and the task's end resumes it, as 2.1.295 decides it per subagent from its own tasks. */
export function interimEnd(book: HandbackBook, event: Record<string, unknown>): boolean {
  const task = str(event.task_id);
  if (!isNotification(event) || task === undefined || !book.subagents.has(task) || event.handback !== undefined) return false;
  return [...book.owned.values()].includes(task);
}

/** A subagent's notification after one that already ended it, which the CLI sends when it resumes: it replaces the end. */
export const laterEnd = (book: HandbackBook, event: Record<string, unknown>): boolean => isNotification(event) && book.notified.has(str(event.task_id) ?? "");

/** The report an end delivered, its warning above its text as the CLI asks it drawn. */
function reportOf(event: Record<string, unknown>): { said: string; warning?: string } | undefined {
  const report = rec(event.handback_report);
  const text = str(report?.text);
  const warning = str(report?.warning);
  if (text === undefined) return undefined;
  return warning === undefined ? { said: text } : { said: `${warning}\n\n${text}`, warning };
}

/** The CLI's own word for how a subagent ended, as wsp's; a word it has not used before reads as failed. */
const SUBAGENT_ENDS: Readonly<Record<string, SubagentState>> = { completed: "done", failed: "failed", stopped: "stopped", killed: "stopped" };

/** A task the CLI says is over, off either line that says so: the notification with its summary, or the update a kill
 * writes ahead of it. Any task; the caller knows which of them are subagents. */
export function taskEnded(event: Record<string, unknown>): { task: string; state: SubagentState; summary?: string } | undefined {
  if (str(event.type) !== "system") return undefined;
  const subtype = str(event.subtype);
  const task = str(event.task_id);
  const status = subtype === "task_notification" ? str(event.status) : subtype === "task_updated" ? str(rec(event.patch)?.status) : undefined;
  if (task === undefined || status === undefined) return undefined;
  if (subtype === "task_updated" && status !== "killed") return undefined;
  const summary = subtype === "task_notification" ? endSummary(event) : undefined;
  return { task, state: SUBAGENT_ENDS[status] ?? "failed", ...(summary !== undefined && summary !== "" ? { summary } : {}) };
}

/** What a notification's end leaves as the subagent's last line: the warning where its report carries one, since the
 * line is one line; a report withheld in wsp's words; and never a note the CLI wrote to the model. */
function endSummary(event: Record<string, unknown>): string | undefined {
  if (event.handback === undefined) return str(event.summary);
  const report = reportOf(event);
  return report === undefined ? NO_REPORT_LINE : report.warning ?? report.said;
}

/** The lines a subagent's end hands the fold: a delivered report as its last words, unless it already wrote them, or a
 * line saying none came, which its page would otherwise leave out, and the launching call's answer. A backgrounded
 * launch is answered here or never, since its own answer is a note. */
export function endAnswer(book: HandbackBook, event: Record<string, unknown>, sessionId: string): TurnDelta[] {
  const call = str(event.tool_use_id);
  const task = str(event.task_id);
  const status = str(event.status);
  if (!isNotification(event) || call === undefined || task === undefined || !book.subagents.has(task)) return [];
  book.notified.add(task);
  const report = event.handback === undefined ? undefined : reportOf(event);
  const failed = status === "failed";
  let answer: string;
  if (event.handback !== undefined) answer = report?.said ?? NO_REPORT_LINE;
  else if (book.backgrounded.has(call) && (status === "completed" || failed)) answer = str(event.summary) ?? "";
  else return [];
  book.answered.set(call, answer);
  const words: TurnDelta[] =
    report === undefined
      ? event.handback === undefined ? [] : [{ type: "turn.delta", sessionId, kind: "note", text: NO_REPORT_LINE, parentToolUseId: call }]
      : book.lastText.get(call)?.trim() === report.said.trim() ? [] : [{ type: "turn.delta", sessionId, kind: "text", text: report.said, parentToolUseId: call }];
  return [...words, { type: "turn.delta", sessionId, kind: "tool_result", text: answer, toolUseId: call, isError: failed }];
}
