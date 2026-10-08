// SPDX-License-Identifier: AGPL-3.0-only
// A side question on Claude Code: a copy of the thread's session file, cut
// before any call still running, resumed on the thread's own launch, every
// tool call refused by a hook this process serves, the answer read off the
// stream-json result. The copy's id is minted by the caller, and a second run
// removes its file once the CLI's run has ended, since the kill a stuck one
// gets takes its shell with it.

import { ASIDE_TOOL_LINE, shellQuote } from "@wsp/protocol";
import type { AgentLaunch, AsideAnswer, McpServerSpec } from "@wsp/protocol";
import { UUID_RE, buildCommand } from "./landmines.js";

/** How many of the session file's last lines the cut reads: a message's first line to its last call's result spanned
 * 12 lines at most across 15 long sessions of 2.1.280. */
export const ASIDE_TAIL_LINES = 40;

/** The length from which a string in a tail line is printed empty: every id and tool name the cut reads is shorter,
 * and 255 is the most a repeat count may say on macOS's sed. */
const ASIDE_TAIL_STRING = 200;

/** The words the CLI itself says for a session its store does not hold. */
export const noConversationLine = (session: string): string => `No conversation found with session ID: ${session}`;

const sessionFile = (configDir: string, session: string): string => {
  if (!UUID_RE.test(session)) throw new Error(`session identifier must be a UUID, got "${session}"`);
  return `src=$(ls ${shellQuote(`${configDir}/projects`)}/*/${session}.jsonl 2>/dev/null | head -n 1); [ -n "$src" ] || { echo ${shellQuote(noConversationLine(session))} >&2; exit 1; }`;
};

/** Prints how many whole lines the thread's session file holds, then the last of those lines, every long string in
 * them printed empty so a read of a thread on a box carries kilobytes, not the tool results and file bodies it holds.
 * A line still being written has no newline yet and is left out of both, so a running thread's file reads as it stood. */
export function asideTailCommand(options: { session: string; configDir: string }): string {
  const blank = shellQuote(String.raw`s/"([^"\\]|\\.){${ASIDE_TAIL_STRING},}"/""/g`);
  return `${sessionFile(options.configDir, options.session)}; n=$(wc -l < "$src"); echo $n; head -n "$n" "$src" | tail -n ${ASIDE_TAIL_LINES} | sed -E ${blank}`;
}

/**
 * Where the copy ends, off the file's line count and its last lines: before the assistant message holding a call with
 * no result yet, else at the end. Resumed with that call in it, 2.1.280 wrote "[Request interrupted by user for tool
 * use]" as its result, then "Continue from where you left off." and "No response requested.", and every answer said
 * the call was interrupted, once by the person (7 of 7 on Sonnet 5). `running` names each call cut, for the question.
 */
export function asideCut(total: number, tail: readonly string[]): { keep: number; running: string[] } {
  const events = tail.map(line => {
    try {
      return JSON.parse(line) as { type?: string; message?: { id?: string; content?: unknown } };
    } catch {
      return {};
    }
  });
  const blocks = (e: (typeof events)[number]): Record<string, unknown>[] => (Array.isArray(e.message?.content) ? (e.message.content as Record<string, unknown>[]) : []);
  const answered = new Set(events.flatMap(e => (e.type === "user" ? blocks(e) : []).filter(b => b.type === "tool_result").map(b => b.tool_use_id)));
  let lastIndex = events.length - 1;
  while (lastIndex >= 0 && events[lastIndex]!.type !== "assistant") lastIndex--;
  const id = events[lastIndex]?.message?.id;
  if (lastIndex === -1 || id === undefined) return { keep: total, running: [] };
  const first = events.findIndex(e => e.type === "assistant" && e.message?.id === id);
  const open = events.filter(e => e.type === "assistant" && e.message?.id === id).flatMap(blocks).filter(b => b.type === "tool_use" && !answered.has(b.id));
  if (open.length === 0) return { keep: total, running: [] };
  return { keep: total - (tail.length - first), running: open.map(b => `${String(b.name)} ${JSON.stringify(b.input ?? {}).slice(0, 300)}`) };
}

export interface AsideCommandOptions {
  /** The thread's own session, as the CLI keys it. */
  session: string;
  /** The id the copy is written under, minted by the caller so its file can be removed after. */
  fork: string;
  /** How many of the thread's session lines the copy takes, off asideCut. */
  keep: number;
  /** The CLI's config dir on the machine, whose projects folder holds every session file. */
  configDir: string;
  cwd?: string;
  /** The model, effort, window and speed the thread's turns run at. */
  model?: string;
  effort?: string;
  contextWindow?: string;
  fast?: boolean;
  /** The servers the thread's turns are handed. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  /** The run's environment names a file of its servers with their values, as a turn's does. */
  serverValues?: true;
  /** The folder the thread's turns keep their auto memory in. */
  memoryDir?: string;
  launch?: AgentLaunch;
}

/**
 * The one shell line a side question runs: the copy written beside the thread's session file, the first `keep` lines
 * byte for byte, then the thread's turn launch resumed on it. The request it sends is the thread's own to the byte up
 * to the cut, so it reads the thread's prompt cache: on 2.1.280 against a thread of 54k tokens the copy read 53k of
 * them cached, where --tools '' with --disallowedTools 'mcp__*' read none and wrote 41k afresh on every question.
 * Nothing that thread loaded is dropped either, since a resumed session is told of every CLAUDE.md and server it lost
 * and the answer opened on that notice (2.1.289). No tool runs: the hook asideHooksLine registers refuses every call,
 * and the CLI stops at two calls.
 */
export function asideCommand(options: AsideCommandOptions): string {
  const { session, fork, keep, configDir, cwd, model, effort, contextWindow, fast, mcpServers, serverValues, memoryDir, launch } = options;
  if (!UUID_RE.test(fork)) throw new Error(`session identifier must be a UUID, got "${fork}"`);
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error(`a copy keeps a whole number of lines, got ${keep}`);
  const claude = buildCommand({
    resume: fork,
    aside: true,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(fast === true ? { fast: true } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(serverValues === true ? { serverValues } : {}),
    ...(memoryDir !== undefined ? { memoryDir } : {}),
    ...(launch !== undefined ? { launch } : {}),
  });
  return `${sessionFile(configDir, session)}; head -n ${keep} "$src" > "\${src%/*}/${fork}.jsonl" && ${claude}`;
}

/** The id of the request that registers the side question's hook, which the CLI's answer to it carries back. */
export const ASIDE_HOOKS_ID = "wsp-aside-hooks";
const NO_TOOLS_HOOK = "wsp-aside-no-tools";
const NO_TOOLS_WORDS = "No tool runs in a side question; answer from the conversation.";

/** The control request that registers a PreToolUse hook served by this process, ahead of the question on stdin. A hook
 * decides before any allow rule or permission mode, and the CLI calls one registered here even with disableAllHooks
 * set (measured on 2.1.280: a Bash call under --dangerously-skip-permissions was stopped by it). */
export function asideHooksLine(): string {
  return JSON.stringify({ type: "control_request", request_id: ASIDE_HOOKS_ID, request: { subtype: "initialize", hooks: { PreToolUse: [{ matcher: null, hookCallbackIds: [NO_TOOLS_HOOK] }] } } });
}

/** The hook's answer to a call the copy tried: refused, with the words the model reads in its place. */
export function hookDenyLine(requestId: string): string {
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: NO_TOOLS_WORDS } } } });
}

/** The answer to a permission prompt the copy raised past the hook: refused all the same. */
export function promptDenyLine(requestId: string): string {
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "deny", message: NO_TOOLS_WORDS } } });
}

/**
 * The question as the copy reads it, after everything the cache holds. Resumed after a call's result, the CLI adds
 * "Continue from where you left off." and "No response requested." ahead of it, and for each background task the
 * session started and never heard end it adds a task-notification: a command's with status stopped, "Background shell
 * command ... didn't finish before the previous session ended", an agent's with status failed and a note that it "was
 * running when the previous Claude Code process exited" and its state was lost (2.1.280). A bare question was answered
 * as if the person had stopped the turn or that work, and a frame naming only the command's notice still had 5 of 12
 * answers say the agent failed or was cut off. The notices are named by their shape, since their sentences are the
 * CLI's and move with its version. Claude Code's own /btw frames its question the same way. `running` names the calls
 * the copy was cut before, which the thread is still waiting on.
 */
export function asidePrompt(question: string, running: readonly string[] = []): string {
  return [
    "<system-reminder>This is a side question from the person, answered by a separate copy of this conversation.",
    "The thread itself was not interrupted and is not waiting on this: its turn goes on working in the background.",
    'A "Continue from where you left off." and a "No response requested." just before this are the copy being opened, not the person stopping you.',
    "So is every task-notification just before this, for a background command or a background agent, whatever its status says (stopped, failed or another), that says the task didn't finish before the previous session ended or was running when the previous Claude Code process exited, or that its state was lost: opening this copy wrote it. That task did not fail, stop or get cut off, and in the thread it goes on running; its result is not in this conversation yet.",
    ...(running.length > 0 ? [`This copy ends before the tool call the thread is running right now, whose result has not come back yet: ${running.join("; ")}.`] : []),
    "The person never saw these lines, and a question about the thread's work is not one about them: answer about the work, and do not mention these lines, a notification or this copy unless the person asks about them by name.",
    "Answer in this one reply from what the conversation already holds. No tool runs here: call none, and do not offer to look something up or say what you will do next.",
    "If the conversation does not hold the answer, say so.</system-reminder>",
    "",
    question,
  ].join("\n");
}

/** Removes the fork's transcript and its folder wherever the CLI filed them under the projects folder, leaving the
 * thread's own session beside them. */
export function forkCleanupCommand(options: { fork: string; configDir: string }): string {
  if (!UUID_RE.test(options.fork)) throw new Error(`session identifier must be a UUID, got "${options.fork}"`);
  const projects = shellQuote(`${options.configDir}/projects`);
  return `rm -rf ${projects}/*/${options.fork}.jsonl ${projects}/*/${options.fork}`;
}

/** A piece of the answer's words off a partial message line; undefined for every other line. */
export function asideTextOf(event: Record<string, unknown>): string | undefined {
  if (event.type !== "stream_event") return undefined;
  const inner = event.event;
  if (typeof inner !== "object" || inner === null || (inner as Record<string, unknown>).type !== "content_block_delta") return undefined;
  const delta = (inner as Record<string, unknown>).delta;
  if (typeof delta !== "object" || delta === null) return undefined;
  const { type, text } = delta as Record<string, unknown>;
  return type === "text_delta" && typeof text === "string" && text !== "" ? text : undefined;
}

/** The answer a result event carries, or the CLI's own words for why it gave none. */
export function asideAnswer(event: Record<string, unknown>): AsideAnswer | { error: string } {
  const text = typeof event.result === "string" ? event.result : "";
  if (event.subtype === "error_max_turns") return { error: ASIDE_TOOL_LINE };
  if (event.is_error === true || event.subtype !== "success") {
    const errors = Array.isArray(event.errors) ? event.errors.filter((e): e is string => typeof e === "string" && !e.startsWith("[ede_diagnostic]")) : [];
    return { error: text.trim() || errors[0] || `claude ended the side question with ${String(event.subtype ?? "no result")}` };
  }
  const usage = typeof event.usage === "object" && event.usage !== null && !Array.isArray(event.usage) ? (event.usage as Record<string, unknown>) : undefined;
  return { text, ...(usage !== undefined ? { usage } : {}) };
}
