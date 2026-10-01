// SPDX-License-Identifier: AGPL-3.0-only
// A side question on Claude Code: the thread's session resumed as a fork with
// every built-in tool off, the answer read off the stream-json result.
// --no-session-persistence is not used: nothing read on 2.1.283 says it holds
// for the file a fork copies the transcript into. The fork's id is pinned with
// --session-id instead (the 2.1.283 binary refuses --session-id beside --resume
// unless --fork-session is given) and a second run removes that file once the
// CLI's run has ended, since the kill a stuck one gets takes its shell with it.

import { inFolder, programWord, shellQuote } from "@wsp/protocol";
import type { AgentLaunch, AsideAnswer } from "@wsp/protocol";
import { UUID_RE, slugFlag } from "./landmines.js";

export interface AsideCommandOptions {
  /** The thread's own session, as the CLI keys it. */
  session: string;
  /** The id the fork is written under, minted by the caller so its file can be removed after. */
  fork: string;
  /** The CLI's config dir on the machine, whose projects folder holds every session file. */
  configDir: string;
  cwd?: string;
  model?: string;
  launch?: AgentLaunch;
}

/**
 * The one shell line a side question runs. --safe-mode leaves the person's hooks, MCP servers, plugins and skills out
 * and --strict-mcp-config leaves out any server a managed config adds, since --tools governs the built-in set alone
 * and an MCP tool or a SessionStart hook would run a command on the copy. The question is the one stream-json user
 * line on stdin, the same channel a turn takes.
 */
export function asideCommand(options: AsideCommandOptions): string {
  const { session, fork, configDir, cwd, model } = options;
  for (const id of [session, fork]) if (!UUID_RE.test(id)) throw new Error(`session identifier must be a UUID, got "${id}"`);
  const claude = [
    `${programWord("claude", options.launch)} -p`,
    "--input-format stream-json",
    "--output-format stream-json",
    "--verbose",
    "--tools ''",
    "--safe-mode",
    "--strict-mcp-config",
    ...slugFlag("--model", "model", model),
    `--resume ${session}`,
    "--fork-session",
    `--session-id ${fork}`,
  ].join(" ");
  return inFolder(cwd, claude);
}

/** Removes the fork's transcript and its folder wherever the CLI filed them under the projects folder, leaving the
 * thread's own session beside them. */
export function forkCleanupCommand(options: { fork: string; configDir: string }): string {
  if (!UUID_RE.test(options.fork)) throw new Error(`session identifier must be a UUID, got "${options.fork}"`);
  const projects = shellQuote(`${options.configDir}/projects`);
  return `rm -rf ${projects}/*/${options.fork}.jsonl ${projects}/*/${options.fork}`;
}

/** The answer a result event carries, or the CLI's own words for why it gave none. */
export function asideAnswer(event: Record<string, unknown>): AsideAnswer | { error: string } {
  const text = typeof event.result === "string" ? event.result : "";
  if (event.is_error === true || event.subtype !== "success") {
    const errors = Array.isArray(event.errors) ? event.errors.filter((e): e is string => typeof e === "string" && !e.startsWith("[ede_diagnostic]")) : [];
    return { error: text.trim() || errors[0] || `claude ended the side question with ${String(event.subtype ?? "no result")}` };
  }
  const usage = typeof event.usage === "object" && event.usage !== null && !Array.isArray(event.usage) ? (event.usage as Record<string, unknown>) : undefined;
  return { text, ...(usage !== undefined ? { usage } : {}) };
}
