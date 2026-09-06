// SPDX-License-Identifier: AGPL-3.0-only
// Puts the MCP server into a local agent's config: the command that runs this
// same wsp against this state file, placed by the catalog entry's own config
// module under the person's home. The catalog says where and how; this file
// only reads and writes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CATALOG_AGENTS, MCP_AGENTS, type McpServerSpec, type Placed } from "@wsp/catalog";

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
}

/** Writes the server into the agent's config under `home`: the first of its files that exists, else the first,
 * created with its folder. Says which agent and which file, and whether the file's comments were lost. */
export function installMcp(agentId: string, server: McpServerSpec, home: string): Installed {
  const entry = CATALOG_AGENTS.find(a => a.id === agentId);
  if (entry === undefined) throw new Error(`no agent ${agentId} in the catalog; agents with an MCP config: ${MCP_AGENTS.map(a => a.id).join(", ")}`);
  if (entry.mcp === undefined) return { agent: entry.name };
  const files = entry.mcp.files.map(f => ({ tilde: f, abs: join(home, f.slice(2)) }));
  const file = files.find(f => existsSync(f.abs)) ?? files[0]!;
  const text = existsSync(file.abs) ? readFileSync(file.abs, "utf8") : undefined;
  let placed: Placed;
  try {
    placed = entry.mcp.format.place(text, MCP_SERVER_NAME, server);
  } catch (e) {
    throw new Error(`${file.tilde}: ${e instanceof Error ? e.message : String(e)}`);
  }
  mkdirSync(dirname(file.abs), { recursive: true });
  writeFileSync(file.abs, placed.text);
  return { agent: entry.name, path: file.tilde, commentsDropped: placed.commentsDropped };
}
