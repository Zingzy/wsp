// SPDX-License-Identifier: AGPL-3.0-only
// Puts the MCP server into a local agent's config and the wsp skill into its
// skills folder, under the person's home. This file decides the one command
// that runs this same wsp against this state file; the catalog entry's own
// config module says where it goes and in what format.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { CATALOG_AGENTS, MCP_AGENTS, MCP_AGENT_IDS, type AgentEntry, type McpAgent, type McpServerSpec, type Placed } from "@wsp/catalog";
import { mcpServerCommandLine } from "@wsp/protocol";
import { SKILL_NAME, WSP_SKILL } from "./skill.js";
import { VERSION } from "./version.js";

/** The name the server has in every agent's config. */
export const MCP_SERVER_NAME = "wsp";

/** The package `npx` fetches wsp from. */
const NPM_PACKAGE = "@zingzy/wsp";

/** The folder under npm's cache where npx keeps what it ran; a path through it dies with a cache sweep. */
const NPX_CACHE_DIR = "_npx";

/** What the install reads of the process it runs in, to say how an agent starts this same wsp again. */
export interface RunningWsp {
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  version: string;
  PATH: string | undefined;
}

export const runningWsp = (): RunningWsp => ({ execPath: process.execPath, execArgv: process.execArgv, argv: process.argv, version: VERSION, PATH: process.env.PATH });

/** The `wsp` a shell would run from PATH: the first folder that holds one. */
function wspOnPath(PATH: string | undefined): string | undefined {
  return (PATH ?? "")
    .split(delimiter)
    .filter(dir => dir !== "")
    .map(dir => join(dir, "wsp"))
    .find(file => existsSync(file));
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** The npx that ships beside this node, so the agent's shorter PATH (a GUI launch has less than a shell) never
 * matters; the bare word only when none sits there. */
function npxBeside(execPath: string): string {
  const beside = join(dirname(execPath), "npx");
  return existsSync(beside) ? beside : "npx";
}

/** How an agent starts this same wsp again, the one rule for every agent's config. Run out of npx's cache, the
 * command is npx with this version pinned: the cache path goes with a sweep or a version bump, and the pin brings
 * the same wsp back. Run as the wsp on PATH, the command is that binary. Any other start (a checkout, a bin folder
 * PATH does not hold) is this node with the flags and script it was given. */
function mcpServerCommand(run: RunningWsp): McpServerSpec {
  const script = run.argv[1];
  if (script !== undefined && script.split(sep).includes(NPX_CACHE_DIR)) return { command: npxBeside(run.execPath), args: ["-y", `${NPM_PACKAGE}@${run.version}`, "mcp"] };
  const onPath = wspOnPath(run.PATH);
  if (script !== undefined && onPath !== undefined && sameFile(script, onPath)) return { command: onPath, args: ["mcp"] };
  return { command: run.execPath, args: [...run.execArgv, script ?? "wsp", "mcp"] };
}

/** The server every agent's config gets: the command that runs this same wsp, then `--state <path>`, so the
 * agent's own cwd never picks another state file. */
export function mcpServerSpec(statePath: string, run: RunningWsp = runningWsp()): McpServerSpec {
  const wsp = mcpServerCommand(run);
  return { command: wsp.command, args: [...wsp.args, "--state", statePath] };
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
  if (entry === undefined) throw new Error(`no agent ${agentId} in the catalog; agents with an MCP config: ${MCP_AGENT_IDS}`);
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

/** One `wsp mcp install` as a machine reads it: every agent that took the server or the skill under the catalog id
 * it was asked for, and every one that took neither with the reason, so a caller naming several is not left
 * guessing which of them landed. */
export interface InstallReport {
  /** The command every written config now runs. */
  server: McpServerSpec;
  installed: Array<Installed & { id: string }>;
  failures: Array<{ id: string; error: string }>;
}

/** Installs for each agent in turn and keeps going past one that fails: an id the catalog does not know must not
 * cost the agents named beside it. */
export function installEach(agentIds: Iterable<string>, server: McpServerSpec, home: string): InstallReport {
  const report: InstallReport = { server, installed: [], failures: [] };
  for (const id of agentIds) {
    try {
      report.installed.push({ id, ...installMcp(id, server, home) });
    } catch (e) {
      report.failures.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
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

/** The line after every agent's own: the command their configs now run, once; none when no config took the server. */
export function registeredLine(report: InstallReport): string | undefined {
  return report.installed.some(p => p.path !== undefined) ? mcpServerCommandLine(report.server.command, report.server.args) : undefined;
}
