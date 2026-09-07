// SPDX-License-Identifier: AGPL-3.0-only
// Which catalog agents wsp can open a thread on. The runtime's adapter
// registry is typed by this list, so an id here without a factory there does
// not build and a factory there without an id here does not either; the list
// lives with the catalog rows because the wizard, the recipe verbs and the verb
// table behind both the command line and the MCP tools read it, and none of
// them may pull the runtime in.

export const THREAD_AGENTS = ["claude", "codex"] as const;
export type ThreadAgent = (typeof THREAD_AGENTS)[number];

/** Whether the agent's own store keeps a name a person gave one of its sessions, per agent, so a rename in wsp can
 * write the field the agent itself writes and the agent shows the same name: Claude Code's custom-title record in
 * the session file, Codex's threads.name in its thread index. An agent whose store keeps only a title it generated
 * reads false, and a rename there would be overwritten by its next turn, so no client offers one. The adapter of an
 * agent that reads true carries renameSession; a runtime test holds the two to each other. */
const AGENT_KEEPS_RENAME: Readonly<Record<ThreadAgent, boolean>> = { claude: true, codex: true };

/** Whether a rename in wsp survives in this harness's own store; false for a harness wsp opens no thread on. */
export function keepsRename(harness: string): boolean {
  return Object.hasOwn(AGENT_KEEPS_RENAME, harness) && AGENT_KEEPS_RENAME[harness as ThreadAgent];
}
