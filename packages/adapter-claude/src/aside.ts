// SPDX-License-Identifier: AGPL-3.0-only
// A side question on Claude Code: the thread's session resumed as a fork with
// every tool and hook off, the answer read off the stream-json result.
// --no-session-persistence is not used: nothing read on 2.1.283 says it holds
// for the file a fork copies the transcript into. The fork's id is pinned with
// --session-id instead (the 2.1.283 binary refuses --session-id beside --resume
// unless --fork-session is given) and a second run removes that file once the
// CLI's run has ended, since the kill a stuck one gets takes its shell with it.

import { inFolder, programWord, shellQuote } from "@wsp/protocol";
import type { AgentLaunch, AsideAnswer, McpServerSpec } from "@wsp/protocol";
import { UUID_RE, mcpConfigFlag, slugFlag } from "./landmines.js";

export interface AsideCommandOptions {
  /** The thread's own session, as the CLI keys it. */
  session: string;
  /** The id the fork is written under, minted by the caller so its file can be removed after. */
  fork: string;
  /** The CLI's config dir on the machine, whose projects folder holds every session file. */
  configDir: string;
  cwd?: string;
  model?: string;
  /** The servers the thread's turns are handed on their launch. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  launch?: AgentLaunch;
}

/**
 * The one shell line a side question runs. A resumed session is told every CLAUDE.md and MCP server it announced that
 * this launch dropped, and the model opened each answer on that notice (2.1.289: "Instructions no longer present",
 * "The following MCP servers have disconnected"), so the fork loads what the thread's turns load, their servers
 * included, and is kept from acting by other flags: --tools '' empties the built-in set, --disallowedTools 'mcp__*'
 * takes every MCP tool off the list while its server stays connected, and disableAllHooks keeps a SessionStart hook
 * from running a command on the copy. The question is the one stream-json user line on stdin, the same channel a
 * turn takes.
 */
export function asideCommand(options: AsideCommandOptions): string {
  const { session, fork, configDir, cwd, model, mcpServers } = options;
  for (const id of [session, fork]) if (!UUID_RE.test(id)) throw new Error(`session identifier must be a UUID, got "${id}"`);
  const claude = [
    `${programWord("claude", options.launch)} -p`,
    "--input-format stream-json",
    "--output-format stream-json",
    "--verbose",
    "--tools ''",
    "--disallowedTools 'mcp__*'",
    `--settings ${shellQuote(JSON.stringify({ disableAllHooks: true }))}`,
    ...mcpConfigFlag(mcpServers),
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
