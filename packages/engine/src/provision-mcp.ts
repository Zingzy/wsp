// SPDX-License-Identifier: AGPL-3.0-only
// The MCP servers the recipe names, on a computer somebody owns. The edit
// itself is the image's own: each agent's config is read off the machine,
// rewritten by the catalog format's module and landed again. What is here is
// the one rule a computer somebody lives on adds to it: the edit runs over a
// config wsp put there and over no other, so a file the person keeps is
// answered with its own row and left exactly as it is.
import { shellQuote, type PlaceProvisionRow } from "@wsp/protocol";
import { markersOf, pagedReads } from "./exec-detached.js";
import { applyMcp, mcpRowId, parseMcpId, type McpAgentPlan, type McpPlan, type McpResult } from "./golden-mcp.js";
import type { ToolResult } from "./golden-tools.js";
import type { StageListener } from "./golden.js";
import type { Machine } from "./machine.js";
import type { OwnedPaths } from "./provision-files.js";

/** What the digest read prints, so no path of the person's can be read as the run's own words. */
const CONFIG_MARK = "wsp-config";

/** The digest of each config that is on the computer, by path; a path that is not there, or that a page could not
 * be made for, says nothing and counts as a config wsp has not seen. */
export async function configDigests(machine: Machine, files: readonly string[]): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  if (files.length === 0) return digests;
  const pages = await pagedReads(
    machine,
    files,
    (file, at) => `if [ -f ${shellQuote(file)} ]; then printf '${CONFIG_MARK} %s %s\\n' ${at} "$(sha256sum ${shellQuote(file)} | cut -d' ' -f1)"; fi`,
    "set -u",
  );
  for (const { rows, res } of pages) {
    if (res.exitCode !== 0) continue;
    const marked = markersOf(res.stdout, CONFIG_MARK);
    for (const [at, file] of rows.entries()) {
      const digest = marked.get(String(at));
      if (digest !== undefined) digests.set(file, digest);
    }
  }
  return digests;
}

/** The plan as it reads on a computer whose login keeps its home somewhere else: every guest path the plan carries
 * hangs off the home it was planned for, so the whole of it moves with that home. The plan is made once for every
 * computer this host holds; where the home is the one it was planned for, it stands as it is. */
export function atHome(plan: McpPlan, home: string): McpPlan {
  if (home === plan.guestHome) return plan;
  const moved = (path: string): string => (path === plan.guestHome ? home : path.startsWith(`${plan.guestHome}/`) ? `${home}/${path.slice(plan.guestHome.length + 1)}` : path);
  return {
    ...plan,
    guestHome: home,
    rewrites: plan.rewrites.map(([from, to]) => [from, moved(to.replace(/\/$/, "")) + (to.endsWith("/") ? "/" : "")] as [string, string]),
    agents: plan.agents.map(a => ({
      ...a,
      scopes: a.scopes.map(s => ({ ...s, files: s.files.map(moved), ...(s.project !== undefined ? { project: { from: s.project.from, to: moved(s.project.to) } } : {}) })),
    })),
  };
}

/** Why an agent's servers are set aside: the config they would be written into is the person's own file. */
export const theirConfigLine = (label: string, path: string): string => `${path} on this computer is ${label}'s own; wsp does not write over it`;

/** One agent with every server it names set aside for the same reason and no scope left to edit: applyMcp then
 * reads nothing of that agent's off the computer and touches no file of theirs, and each server still answers
 * with a row under its own id. */
function setAside(agent: McpAgentPlan, reason: string): McpAgentPlan {
  const servers = agent.scopes.flatMap(s => [...s.keep, ...s.drop.map(d => d.name)].map(name => ({ id: mcpRowId(agent.id, s.project !== undefined, name), name, reason })));
  return { ...agent, scopes: [], aside: [...agent.aside, ...servers] };
}

/** One server's row of the job. A server is present where the config it lives in was already on that computer and
 * the edit changed nothing in it: it was there as the recipe asks, so a second run installs nothing and says so. */
function rowOf(r: McpResult, arrived: ReadonlySet<string>, configOf: (id: string) => string | undefined): PlaceProvisionRow {
  const config = configOf(r.id);
  const outcome = r.outcome === "skipped" ? "skipped" : config !== undefined && !arrived.has(config) ? "present" : "installed";
  return { id: r.id, label: `${r.agent} ${r.name}`, outcome, kind: "server", ...(r.note !== undefined && outcome !== "present" ? { note: r.note } : {}) };
}

/** Writes the recipe's servers into the agents' own configs on the computer and answers one row each. `home` is
 * the home the computer's own login keeps, which every path of the plan hangs off; `owned` is every path under it
 * holding what wsp landed there, and an agent whose config is not one of them keeps its file, with every server of
 * its own skipped for that reason. */
export async function provisionMcp(machine: Machine, planned: McpPlan, o: { home: string; owned: OwnedPaths; tools: readonly ToolResult[]; stage: StageListener }): Promise<PlaceProvisionRow[]> {
  const plan = atHome(planned, o.home);
  const files = [...new Set(plan.agents.flatMap(a => a.scopes.flatMap(s => s.files)))];
  const before = await configDigests(machine, files);
  // The config the agent reads there is the first of its own files that exists, which is the file applyMcp edits.
  const configOfAgent = (a: McpAgentPlan): string | undefined => a.scopes[0]?.files.find(f => before.has(f));
  const agents = plan.agents.map(a => {
    const config = configOfAgent(a);
    return config === undefined || o.owned.has(config) ? a : setAside(a, theirConfigLine(a.label, config));
  });
  const results = await applyMcp(machine, { ...plan, agents }, o.stage, o.tools);
  const edited = agents.flatMap(a => {
    const config = configOfAgent(a);
    return config !== undefined && a.scopes.length > 0 ? [[a.id, config] as const] : [];
  });
  const after = await configDigests(machine, edited.map(([, config]) => config));
  // A config this run landed is one every server in it arrived in, whatever the edit then did to its text.
  const arrived = new Set(edited.map(([, config]) => config).filter(config => after.get(config) !== before.get(config) || o.owned.get(config) === "installed"));
  const byAgent = new Map(edited);
  return results.map(r => rowOf(r, arrived, id => byAgent.get(parseMcpId(id)?.agent ?? "")));
}
