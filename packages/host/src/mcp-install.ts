// SPDX-License-Identifier: AGPL-3.0-only
// Puts the MCP server into a local agent's config, the command that runs this
// same wsp against this state file, placed by the catalog entry's own config
// module under the person's home, and the wsp skill into the agent's skills
// folder. The catalog says where and how; this file only reads and writes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CATALOG_AGENTS, MCP_AGENTS, type AgentEntry, type McpAgent, type McpServerSpec, type Placed } from "@wsp/catalog";
import { SKILL_NAME, WSP_SKILL } from "./skill.js";

/** The name the server has in every agent's config. */
export const MCP_SERVER_NAME = "wsp";

/** How the agent runs this same wsp again: the node, the flags and the script this process was started with, then
 * `mcp --state <path>`, so the agent's own cwd never picks another state file. */
export function mcpServerSpec(statePath: string, proc: Pick<typeof process, "execPath" | "execArgv" | "argv"> = process): McpServerSpec {
  return { command: proc.execPath, args: [...proc.execArgv, proc.argv[1] ?? "wsp", "mcp", "--state", statePath] };
}

export interface Installed {
  agent: string;
  /** `~/`-relative; absent when the catalog knows no MCP config for the agent yet, and then nothing was written. */
  path?: string;
  /** The file held comments the rewrite did not keep. */
  commentsDropped?: boolean;
  /** The skill's file, `~/`-relative. */
  skill: string;
}

/** The config the server goes into under `home`: the first of the agent's files that exists, else the first. */
export function mcpConfigFile(agent: McpAgent, home: string): { tilde: string; abs: string } {
  const files = agent.mcp.files.map(f => ({ tilde: f, abs: join(home, f.slice(2)) }));
  return files.find(f => existsSync(f.abs)) ?? files[0]!;
}

/** The skill's file under `home`, in the agent's skills folder. */
export function skillFile(agent: AgentEntry, home: string): { tilde: string; abs: string } {
  const tilde = `${agent.skills}/${SKILL_NAME}/SKILL.md`;
  return { tilde, abs: join(home, tilde.slice(2)) };
}

/** Writes the skill into the agent's skills folder under `home`, replacing an earlier copy. */
function installSkill(agent: AgentEntry, home: string): string {
  const file = skillFile(agent, home);
  mkdirSync(dirname(file.abs), { recursive: true });
  writeFileSync(file.abs, WSP_SKILL);
  return file.tilde;
}

/** Writes the server into the agent's config under `home`, created with its folder when it is not there, and the
 * skill into its skills folder. Says which agent and which files, and whether the config's comments were lost. */
export function installMcp(agentId: string, server: McpServerSpec, home: string): Installed {
  const entry = CATALOG_AGENTS.find(a => a.id === agentId);
  if (entry === undefined) throw new Error(`no agent ${agentId} in the catalog; agents with an MCP config: ${MCP_AGENTS.map(a => a.id).join(", ")}`);
  const agent = MCP_AGENTS.find(a => a.id === agentId);
  if (agent === undefined) return { agent: entry.name, skill: installSkill(entry, home) };
  const file = mcpConfigFile(agent, home);
  const text = existsSync(file.abs) ? readFileSync(file.abs, "utf8") : undefined;
  let placed: Placed;
  try {
    placed = agent.mcp.format.place(text, MCP_SERVER_NAME, server);
  } catch (e) {
    throw new Error(`${file.tilde}: ${e instanceof Error ? e.message : String(e)}`);
  }
  mkdirSync(dirname(file.abs), { recursive: true });
  writeFileSync(file.abs, placed.text);
  return { agent: entry.name, path: file.tilde, commentsDropped: placed.commentsDropped, skill: installSkill(entry, home) };
}

/** What an install says, for the command and the wizard alike: the agent and its file, then the comments line
 * when the rewrite lost them, or the by-hand line when the catalog knows no config and the server was not written;
 * last, where the skill went. */
export function installLines(placed: Installed): string[] {
  const lines = placed.path === undefined ? [`${placed.agent}: the catalog has no MCP config for it yet, so the server was not written; add it by hand.`] : [`${placed.agent} now has the wsp tools: ${placed.path}`];
  if (placed.commentsDropped === true) lines.push("The file held comments; the rewrite is plain JSON, so they are gone.");
  lines.push(`The wsp skill went to ${placed.skill}`);
  return lines;
}
