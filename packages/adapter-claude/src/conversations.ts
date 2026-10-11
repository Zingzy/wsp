// SPDX-License-Identifier: AGPL-3.0-only
// Claude Code's own conversations on a computer, for a person picking one up as a thread: the list and the earlier
// messages come off its transcripts through the daemon there (transcripts.list, transcripts.read), and what is open
// now off `claude agents --json`, which lists the session each running Claude Code process holds and drops a killed
// one's stale file (measured on 2.1.296).
import { buildEnv } from "./landmines.js";
import { claudeProjectKey, ENV_FROM_INPUT, foldersStampCommand, programWord, shellQuote, TranscriptsListReply, TranscriptsReadReply, type AgentLaunch, type ConversationOrigin, type ConversationStore } from "@wsp/protocol";

/** The entrypoints Claude Code's own picker leaves out as programmatic, `PROGRAMMATIC_ENTRYPOINTS` in the 2.1.296
 * bundle: a `-p` run, the TypeScript SDK and the Python SDK. wsp's own turns run as `sdk-cli` too. */
export const PROGRAMMATIC_ENTRYPOINTS: readonly string[] = ["sdk-cli", "sdk-ts", "sdk-py"];

/** Who opened a conversation, off the entrypoint its first line carries. */
export const originOf = (entrypoint: string | undefined): ConversationOrigin => (entrypoint !== undefined && PROGRAMMATIC_ENTRYPOINTS.includes(entrypoint) ? "script" : "terminal");

/** The project folders under the store a folder's conversations sit in: the key Claude Code gives each folder, and the
 * one a launch pins every session of the project to. */
export const keysFor = (cwds: readonly string[], pinned: string | undefined): string[] => [...new Set([...cwds.map(claudeProjectKey), ...(pinned !== undefined ? [pinned] : [])])];

/** `claude agents --json`, with the turn's environment off its input as the other probes take it. */
export function liveCommand(options: { launch?: AgentLaunch } = {}): string {
  return `cd ~ && unset \${!CLAUDE_CODE_@} CLAUDECODE FORCE_CODE_TERMINAL; ${ENV_FROM_INPUT}; ${programWord("claude", options.launch)} agents --json`;
}

/** The session ids the running processes hold, or null where the answer is no list of them: a Claude Code too old to
 * have the command prints its help or an error instead. */
export function parseLive(stdout: string): Set<string> | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const row of value) {
    const id = typeof row === "object" && row !== null ? (row as Record<string, unknown>).sessionId : undefined;
    if (typeof id === "string" && id !== "") ids.add(id);
  }
  return ids;
}

export function claudeConversations(deps: { configDir: string; projectDirName?: string; launch?: AgentLaunch; baseEnv?: Readonly<Record<string, string | undefined>> }): ConversationStore {
  const root = `${deps.configDir.replace(/\/+$/, "")}/projects`;
  // What every probe of the binary runs under: the person's environment with the CLI's own variables cut.
  const env = buildEnv({ base: deps.baseEnv });
  return {
    list: async (cwds, road) => {
      const reply = TranscriptsListReply.parse(await road.ask({ op: "transcripts.list", root, dirs: keysFor(cwds, deps.projectDirName), cwds: [...cwds] }));
      return reply.rows.map(r => ({
        id: r.id,
        title: r.title ?? r.firstPrompt ?? r.id,
        ...(r.firstPrompt !== undefined ? { firstPrompt: r.firstPrompt } : {}),
        ...(r.branch !== undefined ? { branch: r.branch } : {}),
        cwd: r.cwd,
        lastAt: r.lastAt,
        bytes: r.bytes,
        origin: originOf(r.entrypoint),
      }));
    },
    stamp: (cwds, road) => road.exec(foldersStampCommand(keysFor(cwds, deps.projectDirName).map(k => shellQuote(`${root}/${k}`)))),
    live: road => road.exec(liveCommand(deps.launch !== undefined ? { launch: deps.launch } : {}), env).then(parseLive, () => null),
    earlier: async (id, o, road) => {
      const reply = TranscriptsReadReply.parse(await road.ask({ op: "transcripts.read", root, dirs: keysFor(o.cwds, deps.projectDirName), session: id, last: o.last }));
      if (!reply.found) return "gone";
      return {
        ...(reply.cwd !== undefined ? { cwd: reply.cwd } : {}),
        ...(reply.title !== undefined ? { title: reply.title } : {}),
        lines: reply.messages.map(m => ({ who: m.who, text: m.text, ...(m.tool !== undefined ? { tool: m.tool } : {}) })),
        earlier: reply.earlier,
      };
    },
  };
}
