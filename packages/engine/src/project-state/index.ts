// SPDX-License-Identifier: AGPL-3.0-only
// The registry of project-state resolvers, one per catalog agent, and the core
// that walks the catalog's agents and applies each one. Adding an agent is its
// catalog entry, its module and one line in the list below; nothing here
// switches on an agent id.
import { existsSync } from "node:fs";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { claudeResolver } from "./claude.js";
import { codexResolver } from "./codex.js";
import { geminiResolver } from "./gemini.js";
import { hermesResolver } from "./hermes.js";
import { opencodeResolver } from "./opencode.js";
import { piResolver } from "./pi.js";
import { resolveProjectPath, type MovedState, type ProjectStateResolver } from "./resolver.js";

export { resolveProjectPath, type MovedState, type ProjectStateResolver } from "./resolver.js";

export const PROJECT_STATE_RESOLVERS: readonly ProjectStateResolver[] = [
  claudeResolver,
  codexResolver,
  geminiResolver,
  opencodeResolver,
  piResolver,
  hermesResolver,
];

export interface ProjectStateMove {
  /** The project's old absolute path, as the agents stored it on the machine it came from. */
  from: string;
  /** Where the project now sits. */
  to: string;
  /** Each agent's home by catalog id; an agent with no home, or a home that is not there, is nothing found. */
  homes: Readonly<Record<string, string>>;
}

/** What happened to one agent's project state: moved, nothing keyed to the path, no module to move it, or an error. */
export type AgentMoveReport =
  | { agent: string; outcome: "moved"; moved: readonly MovedState[] }
  | { agent: string; outcome: "nothing" }
  | { agent: string; outcome: "transcript-only" }
  | { agent: string; outcome: "failed"; error: string };

/** Applies the move for every catalog agent and reports each one; a home is left as it was when its move fails. */
export async function moveProjectState(move: ProjectStateMove, resolvers: readonly ProjectStateResolver[] = PROJECT_STATE_RESOLVERS): Promise<AgentMoveReport[]> {
  const from = resolveProjectPath(move.from);
  const to = resolveProjectPath(move.to);
  const report: AgentMoveReport[] = [];
  for (const { id: agent } of CATALOG_AGENTS) {
    const resolver = resolvers.find(r => r.agent === agent);
    if (from === to) {
      report.push({ agent, outcome: "nothing" });
      continue;
    }
    if (resolver === undefined) {
      report.push({ agent, outcome: "transcript-only" });
      continue;
    }
    const home = move.homes[agent];
    if (home === undefined || !existsSync(home)) {
      report.push({ agent, outcome: "nothing" });
      continue;
    }
    try {
      const moved = await resolver.move(home, from, to);
      report.push(moved.length === 0 ? { agent, outcome: "nothing" } : { agent, outcome: "moved", moved });
    } catch (e) {
      report.push({ agent, outcome: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}
