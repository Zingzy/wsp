// SPDX-License-Identifier: AGPL-3.0-only
// The registry of project-state resolvers by catalog agent id, and the core
// that walks the catalog's agents and applies each one. The catalog cannot
// import the engine, so this registry is the one engine place an agent
// touches: its entry, its module and one line below. Nothing here switches
// on an agent id.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_AGENTS, GUEST_HOME, type AgentEntry } from "@wsp/catalog";
import type { ProjectAgent } from "@wsp/protocol";
import { missingCommands } from "../golden-tools.js";
import type { Machine } from "../machine.js";
import { claudeResolver } from "./claude.js";
import { codexResolver } from "./codex.js";
import { geminiResolver } from "./gemini.js";
import { hermesResolver } from "./hermes.js";
import { opencodeResolver } from "./opencode.js";
import { piResolver } from "./pi.js";
import { resolveProjectPath, type MovedState, type ProjectStateResolver } from "./resolver.js";

export { filesUnder, resolveProjectPath, underProject, type MovedState, type ProjectStateResolver } from "./resolver.js";

export const PROJECT_STATE_RESOLVERS: ReadonlyMap<string, ProjectStateResolver> = new Map(
  [claudeResolver, codexResolver, geminiResolver, hermesResolver, opencodeResolver, piResolver].map(r => [r.agent, r]),
);

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
export async function moveProjectState(move: ProjectStateMove, agents: readonly Pick<AgentEntry, "id">[] = CATALOG_AGENTS): Promise<AgentMoveReport[]> {
  const from = resolveProjectPath(move.from);
  const to = resolveProjectPath(move.to);
  const report: AgentMoveReport[] = [];
  for (const { id: agent } of agents) {
    const resolver = PROJECT_STATE_RESOLVERS.get(agent);
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

/** Every catalog agent's home under a home directory, by id: the entry's stateHome joined onto it. */
export function agentHomes(homeDir: string): Record<string, string> {
  return Object.fromEntries(CATALOG_AGENTS.map(a => [a.id, join(homeDir, a.stateHome)]));
}

/** Every catalog agent's home on the guest, by id: the entry's own guest home where it names one, else stateHome under the guest's home. */
export function guestAgentHomes(): Record<string, string> {
  return Object.fromEntries(CATALOG_AGENTS.map(a => [a.id, a.guestStateHome ?? join(GUEST_HOME, a.stateHome)]));
}

/** The paths a trip pulls from the homes: each registered module's roots under its agent's home, in catalog order,
 * for the agents named (every one with a home when none is). An id the catalog does not know is refused, so a typo
 * is a sentence rather than a trip that brings nothing. */
export function stateRoots(homes: Readonly<Record<string, string>>, ids?: readonly string[]): string[] {
  const unknown = ids?.find(id => !CATALOG_AGENTS.some(a => a.id === id));
  if (unknown !== undefined) throw new Error(`no agent called ${unknown}; the catalog knows ${CATALOG_AGENTS.map(a => a.id).join(", ")}`);
  return CATALOG_AGENTS.flatMap(({ id }) => {
    const home = homes[id];
    const resolver = PROJECT_STATE_RESOLVERS.get(id);
    if (home === undefined || resolver === undefined || (ids !== undefined && !ids.includes(id))) return [];
    return resolver.roots.map(root => join(home, root));
  });
}

/** The agents whose home holds sessions for the folder, in catalog order, each with its name, the bytes of the files
 * its module names for the folder and how its state travels; an agent with no home on disk, no module or no session
 * for the folder has no row. An agent whose store cannot be read keeps a row carrying the reason, and the count goes
 * on with the rest. */
export async function countProjectState(path: string, homes: Readonly<Record<string, string>>, agents: readonly Pick<AgentEntry, "id" | "name">[] = CATALOG_AGENTS): Promise<ProjectAgent[]> {
  const root = resolveProjectPath(path);
  const rows: ProjectAgent[] = [];
  for (const { id: agent, name } of agents) {
    const resolver = PROJECT_STATE_RESOLVERS.get(agent);
    const home = homes[agent];
    if (resolver === undefined || home === undefined || !existsSync(home)) continue;
    try {
      const sessions = await resolver.sessions(home, root);
      if (sessions === 0) continue;
      const bytes = (await resolver.entries(home, root)).reduce((n, f) => n + statSync(f).size, 0);
      rows.push({ agent, name, sessions, bytes, carry: resolver.carry });
    } catch (e) {
      rows.push({ agent, name, sessions: 0, bytes: 0, carry: resolver.carry, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return rows;
}

/** Which of the catalog agents are on the machine: the ones whose command is on its tools PATH. */
export async function agentsOnMachine(machine: Machine, ids: readonly string[]): Promise<Set<string>> {
  const agents = CATALOG_AGENTS.filter(a => ids.includes(a.id));
  if (agents.length === 0) return new Set();
  const { missing, failed } = await missingCommands(machine, agents.map(a => a.bin));
  if (failed !== undefined) throw new Error(`could not see which agents are on the machine: ${failed}`);
  return new Set(agents.filter(a => !missing.has(a.bin)).map(a => a.id));
}
