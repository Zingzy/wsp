// SPDX-License-Identifier: AGPL-3.0-only
// Two threads for find in thread, one per agent, each row kind carrying a word of its own so a test can ask where a
// match was found: the person's message, a reply folded in a settled turn, the last reply, a plan, a subagent's own
// words and its tool line, a command row with its description and output, a file change row and a Thinking row. The
// Claude Code thread's second turn holds a long message the bubble clamps and a reply with a diagram and math.
import type { SessionEvent } from "@wsp/protocol";

export const FIND_T0 = Date.parse("2026-10-01T10:00:00.000Z");
export const CLAUDE_WS = "ws_find_claude";
export const CODEX_WS = "ws_find_codex";
export const CLAUDE_THREAD = "th_find_claude";
export const CODEX_THREAD = "th_find_codex";

const LONG = `${"The cart total is read in many places and each one rounds it again. ".repeat(10)}The last line names longword.`;

function scopeOf(workspaceId: string, threadId: string, n: number) {
  return { workspaceId, threadId, sessionId: `sess_${threadId}`, turnId: `turn_${threadId}_${n}` };
}

/** A Claude Code thread of three settled turns. */
export function claudeThread(): SessionEvent[] {
  const at = (n: number, s: number) => FIND_T0 + n * 600_000 + s * 1000;
  const t1 = scopeOf(CLAUDE_WS, CLAUDE_THREAD, 1);
  const t2 = scopeOf(CLAUDE_WS, CLAUDE_THREAD, 2);
  const t3 = scopeOf(CLAUDE_WS, CLAUDE_THREAD, 3);
  const call = "tu_agent";
  return [
    { type: "session.start", ...t1, at: at(1, 0), model: "claude-opus-5-5", prompt: "Where is promptword read?", cwd: "/w" },
    { type: "session.delta", ...t1, at: at(1, 1), kind: "thinking", text: "thinkword first\nthinkword second" },
    { type: "session.delta", ...t1, at: at(1, 2), kind: "text", messageId: "m1a", text: "Looking at commentword now." },
    { type: "session.delta", ...t1, at: at(1, 3), kind: "tool_use", toolName: "Bash", toolUseId: "tu_bash", text: JSON.stringify({ command: "pnpm test cmdword", description: "Run the descword tests" }) },
    { type: "session.delta", ...t1, at: at(1, 4), kind: "tool_result", toolUseId: "tu_bash", text: "outword passed\nhiddenword second line" },
    { type: "session.delta", ...t1, at: at(1, 5), kind: "tool_use", toolName: "Edit", toolUseId: "tu_edit", text: JSON.stringify({ file_path: "/w/src/pathword.ts", old_string: "a", new_string: "b" }) },
    { type: "session.delta", ...t1, at: at(1, 6), kind: "tool_result", toolUseId: "tu_edit", text: "The file has been updated." },
    { type: "session.delta", ...t1, at: at(1, 7), kind: "tool_use", toolName: "Agent", toolUseId: call, text: JSON.stringify({ description: "Find the callers", prompt: "List them.", subagent_type: "Explore" }) },
    { type: "session.subagent", ...t1, at: at(1, 7), task: "task1", state: "running", parentToolUseId: call, title: "Find the callers" },
    { type: "session.delta", ...t1, at: at(1, 8), kind: "text", parentToolUseId: call, text: "subword found three callers" },
    { type: "session.delta", ...t1, at: at(1, 8), kind: "tool_use", toolName: "Grep", toolUseId: "tu_sub_grep", parentToolUseId: call, text: JSON.stringify({ pattern: "subtoolword", path: "src" }) },
    { type: "session.subagent", ...t1, at: at(1, 9), task: "task1", state: "done", parentToolUseId: call, summary: "Three callers." },
    { type: "session.delta", ...t1, at: at(1, 9), kind: "tool_result", toolUseId: call, text: "Three callers." },
    { type: "session.plan", ...t1, at: at(1, 10), text: "# Plan\n\n1. The planword step\n2. Then the rest" },
    { type: "session.delta", ...t1, at: at(1, 11), kind: "text", messageId: "m1b", text: "**boldword** and a [linkword](https://example.com/docs) then:\n\n```ts\nconst fenceword = 1;\n```" },
    { type: "session.done", ...t1, at: at(1, 12), result: { status: "completed", durationMs: 12_000 } },
    { type: "session.end", ...t1, at: at(1, 12), exitCode: 0, sawResult: true },
    { type: "session.start", ...t2, at: at(2, 0), model: "claude-opus-5-5", prompt: LONG, cwd: "/w" },
    { type: "session.delta", ...t2, at: at(2, 1), kind: "text", messageId: "m2", text: "Drawn:\n\n```mermaid\ngraph TD\n  A[mermaidword] --> B\n```\n\nand $mathword^2$ too, then replyword." },
    { type: "session.done", ...t2, at: at(2, 2), result: { status: "completed", durationMs: 2_000 } },
    { type: "session.end", ...t2, at: at(2, 2), exitCode: 0, sawResult: true },
    { type: "session.start", ...t3, at: at(3, 0), model: "claude-opus-5-5", prompt: "And the last replyword?", cwd: "/w" },
    { type: "session.delta", ...t3, at: at(3, 1), kind: "text", messageId: "m3", text: "The newest replyword. Changed `src/auth/session.ts`, [the store](src/links/store.ts) and `src/api/session.ts:12`.\n\n`★ Insight ─────────────────`\nAn insightword aside.\n`─────────────────`" },
    { type: "session.done", ...t3, at: at(3, 2), result: { status: "completed", durationMs: 2_000 } },
    { type: "session.end", ...t3, at: at(3, 2), exitCode: 0, sawResult: true },
  ] as SessionEvent[];
}

/** A Codex thread of two settled turns. */
export function codexThread(): SessionEvent[] {
  const at = (n: number, s: number) => FIND_T0 + n * 600_000 + s * 1000;
  const t1 = scopeOf(CODEX_WS, CODEX_THREAD, 1);
  const t2 = scopeOf(CODEX_WS, CODEX_THREAD, 2);
  const call = "call_spawn";
  return [
    { type: "session.start", ...t1, at: at(1, 0), model: "gpt-5.5", harness: "codex", prompt: "Key the cxprompt cache per user", cwd: "/w" },
    { type: "session.delta", ...t1, at: at(1, 1), kind: "thinking", text: "cxthink about the keys" },
    { type: "session.delta", ...t1, at: at(1, 2), kind: "tool_use", toolName: "command_execution", toolUseId: "cx_cmd", text: JSON.stringify({ command: "rg -n cxcmd src" }) },
    { type: "session.delta", ...t1, at: at(1, 3), kind: "tool_result", toolUseId: "cx_cmd", text: "cxout src/a.ts:1\ncxhidden src/b.ts:2" },
    { type: "session.delta", ...t1, at: at(1, 4), kind: "tool_use", toolName: "file_change", toolUseId: "cx_patch", text: JSON.stringify({ changes: [{ kind: "edit", path: "src/cxpath.ts" }] }) },
    { type: "session.delta", ...t1, at: at(1, 5), kind: "tool_result", toolUseId: "cx_patch", text: "applied" },
    { type: "session.delta", ...t1, at: at(1, 6), kind: "tool_use", toolName: "spawn_agent", toolUseId: call, text: JSON.stringify({ prompt: "Check the keys" }) },
    { type: "session.subagent", ...t1, at: at(1, 6), task: "cx1", state: "running", parentToolUseId: call, title: "Check the keys" },
    { type: "session.delta", ...t1, at: at(1, 7), kind: "text", parentToolUseId: call, text: "cxsub the key is per user" },
    { type: "session.subagent", ...t1, at: at(1, 8), task: "cx1", state: "done", parentToolUseId: call, summary: "Per user." },
    { type: "session.delta", ...t1, at: at(1, 8), kind: "tool_result", toolUseId: call, text: "Per user." },
    { type: "session.delta", ...t1, at: at(1, 9), kind: "text", text: "Keyed it, cxreply." },
    { type: "session.done", ...t1, at: at(1, 10), result: { status: "completed", durationMs: 10_000 } },
    { type: "session.end", ...t1, at: at(1, 10), exitCode: 0, sawResult: true },
    { type: "session.start", ...t2, at: at(2, 0), model: "gpt-5.5", harness: "codex", prompt: "Anything left?", cwd: "/w" },
    { type: "session.delta", ...t2, at: at(2, 1), kind: "text", text: "Nothing left, cxreply." },
    { type: "session.done", ...t2, at: at(2, 2), result: { status: "completed", durationMs: 2_000 } },
    { type: "session.end", ...t2, at: at(2, 2), exitCode: 0, sawResult: true },
  ] as SessionEvent[];
}
