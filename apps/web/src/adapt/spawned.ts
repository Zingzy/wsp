// SPDX-License-Identifier: AGPL-3.0-only
// The child a call in a lead's transcript started. A wsp run or fork, through the tool or the command line, answers
// with the thread it opened: as the answer's JSON, or as its text line (`thread <id> on <project> in <folder>`), which
// Claude Code writes in the JSON's place behind a flag of its own, and Codex wraps in its content blocks. An agent's
// own Agent or Task call is the parentToolUseId its subagent carries.
import { spawnsThread } from "@wsp/protocol";
import type { SpawnCall, TimelineEntry } from "./view-model.js";

/** wsp's run or fork at any path, as a command of its own in a chain. */
const CLI_SPAWN = /(?:^|[\s;&|(])(?:[^\s;&|()'"]*\/)?wsp\s+(?:run|fork)\b/;
/** A shell running one script, as Codex reports its commands: the script is what ran. */
const SHELL_SCRIPT = /^\S*sh\s+-l?c\s+(['"])([\s\S]*)\1$/;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const OPENED_LINE = /^thread (\S+)/m;

const startsThread = (command: string): boolean => CLI_SPAWN.test((SHELL_SCRIPT.exec(command.trim())?.[2] ?? command).replace(QUOTED, "''"));

/** The thread one answer text names: the run answer's threadId, the fork answer's turn's, or the text line's. */
function threadIn(text: string, parsed: unknown): string | undefined {
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const { threadId, turn } = parsed as { threadId?: unknown; turn?: { threadId?: unknown } | null };
    if (typeof threadId === "string") return threadId;
    if (typeof turn?.threadId === "string") return turn.threadId;
  }
  return OPENED_LINE.exec(text)?.[1];
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The thread a call's answer names. Codex writes an MCP answer as the JSON of its content blocks, each block's text
 * the tool's own answer; the command line's --json prints its frames first and the result last. */
function namedThread(answer: string): string | undefined {
  const whole = parse(answer);
  if (Array.isArray(whole)) {
    for (const block of whole as Array<{ text?: unknown }>) {
      const text = typeof block?.text === "string" ? block.text : undefined;
      const found = text === undefined ? undefined : threadIn(text, parse(text));
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return threadIn(answer, whole ?? parse(answer.trim().split("\n").at(-1) ?? ""));
}

/** The thread a finished call started, where it is a start of one: nothing for any other call, or a start refused. */
export function spawnedThreadOf(toolName: string | undefined, command: string | undefined, answer: string): string | undefined {
  const starts = (toolName !== undefined && spawnsThread(toolName)) || (command !== undefined && startsThread(command));
  return starts ? namedThread(answer) : undefined;
}

/** The children of the thread a transcript is, by its key: its threads by the runtime's id, its subagents by the
 * call that launched each. A call whose child is in neither stays a tool row. */
export interface SpawnedChildren {
  readonly lead: string;
  readonly threads: ReadonlySet<string>;
  readonly subagents: ReadonlySet<string>;
}

/** One call and its child as one string, what two derivations of a row are compared by. */
export const spawnKey = (call: SpawnCall): string => `${call.id} ${"thread" in call ? call.thread : call.subagent}`;

/** The child one transcript entry stands for, where it is a call that started a child this thread holds. */
export function spawnCallOf(entry: TimelineEntry, children: SpawnedChildren | undefined): SpawnCall | null {
  if (children === undefined) return null;
  if (entry.kind === "subagent") return children.subagents.has(entry.subagent.parentToolUseId) ? { id: entry.id, subagent: entry.subagent.parentToolUseId } : null;
  if (entry.kind !== "work") return null;
  const { spawned, toolCallId } = entry.entry;
  if (spawned !== undefined && children.threads.has(spawned)) return { id: entry.id, thread: spawned };
  // An Agent call stands as a work row until its subagent writes its first line, and is the subagent from its start.
  return toolCallId !== undefined && children.subagents.has(toolCallId) ? { id: entry.id, subagent: toolCallId } : null;
}
