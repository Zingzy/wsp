// SPDX-License-Identifier: AGPL-3.0-only
// The table on the Give your agent the wsp tools page: each agent wsp mcp install takes, the config it writes the
// server into, as mcpConfigFile() picks it, and the skill's file, as skillFile() places it.
import { CATALOG_AGENTS, skillsDirOf, type AgentEntry } from "../../../packages/catalog/src/index.js";
import { table, within, type Generated } from "./generated.js";

/** The first of the agent's files that exists, else the first: the order mcpConfigFile() reads them in. */
function config(agent: AgentEntry): string {
  const files = agent.mcp?.files ?? [];
  if (files.length === 0) return "none";
  const [first, ...rest] = files;
  const folder = first!.slice(0, first!.lastIndexOf("/") + 1);
  if (rest.length > 1 || rest.some(f => !f.startsWith(folder))) throw new Error(`${agent.id} lists MCP configs this page has no sentence for: ${files.join(", ")}`);
  return rest.length === 0 ? `\`${first}\`` : `\`${first}\`, or \`${rest[0]!.slice(folder.length)}\` in the same folder when only that file exists`;
}

export default function mcpInstall(): Generated[] {
  const rows = CATALOG_AGENTS.map(a => [a.name, `\`${a.id}\``, config(a), `\`${skillsDirOf(a)}/wsp/SKILL.md\``]);
  return [within("content/agents/tools.mdx", { "mcp-install": table(["Agent", "Id", "MCP configuration", "Skill"], rows) })];
}
