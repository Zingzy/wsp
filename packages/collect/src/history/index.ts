// SPDX-License-Identifier: AGPL-3.0-only
// The registry: one reader per session store format the catalog names. An
// agent whose entry names no history has no reader and reads as none.
import { CATALOG_AGENTS, type AgentEntry, type HistoryFormat } from "@wsp/catalog";
import type { RecipeHistory } from "@wsp/protocol";
import { type Host, expand } from "../host.js";
import { claudeReader } from "./claude.js";
import { codexReader } from "./codex.js";
import { hermesReader } from "./hermes.js";
import type { HistoryReader } from "./reader.js";
import { type Usage, tally } from "./tally.js";

export const HISTORY_READERS: Readonly<Record<HistoryFormat, HistoryReader>> = {
  "claude-jsonl": claudeReader,
  "codex-rollout": codexReader,
  "hermes-sqlite": hermesReader,
};

export interface AgentHistory extends RecipeHistory {
  usage: Usage;
}

const EMPTY: Usage = { sessions: 0, calls: 0, commands: new Map(), installs: new Map(), tools: new Map() };

export interface HistoryOptions {
  /** Told each agent's history as it is read, with the counts it kept. */
  onAgent?: (h: AgentHistory) => void;
  /** Absolute folders the counts are weighed against: only sessions that ran at one of them or inside it count. */
  folders?: readonly string[];
}

/** What each agent's session store on this computer says it used, read-only. A store that is there but cannot be
 * read is said so and counts nothing; a format with no reader is said so too. */
export async function readHistories(host: Host, agents: readonly AgentEntry[] = CATALOG_AGENTS, opts: HistoryOptions = {}): Promise<AgentHistory[]> {
  const { onAgent, folders } = opts;
  const out: AgentHistory[] = [];
  for (const a of agents) {
    let h: AgentHistory;
    if (a.history === undefined) h = { agent: a.id, state: "no-reader", sessions: 0, calls: 0, usage: EMPTY };
    else {
      try {
        const usage = await tally(HISTORY_READERS[a.history.format].read(host, expand(host, a.history.root)), folders);
        h = { agent: a.id, state: usage.sessions === 0 ? "empty" : "read", sessions: usage.sessions, calls: usage.calls, usage };
      } catch {
        h = { agent: a.id, state: "unreadable", sessions: 0, calls: 0, usage: EMPTY };
      }
    }
    onAgent?.(h);
    out.push(h);
  }
  return out;
}

export { type Call, type HistoryReader } from "./reader.js";
export { commandNames, commandWords, installNames, installsIn, splitCommands, withoutHeredocs, type Install } from "./commands.js";
export { type Count, type Usage, HEAVY_BYTES, HEAVY_USED_FLOOR, USED_FLOOR, inFolders, isHeavy, meetsUsedFloor, tally } from "./tally.js";
export { claudeCall, claudeReader, claudeSession } from "./claude.js";
export { codexCall, codexReader } from "./codex.js";
export { hermesCall, hermesCalls, hermesReader } from "./hermes.js";
