// SPDX-License-Identifier: AGPL-3.0-only
// The shell line that runs one Codex turn on a workspace: `codex app-server`
// on its own stdio, as codex-cli 0.155.1 spells it. Everything about the turn
// (the prompt, the model, the sandbox) travels as JSON-RPC on stdin (rpc.ts),
// so the line carries only the folder and the MCP servers' config overrides.
// No listener is ever named: stdio is the server's default transport, and a
// socket would let anything on the machine drive the agent.
import { inFolder, LAUNCH_ENV, launchWords, MCP_SERVER_NAME, programWord, shellQuote, SLATE_SERVER_NAME, SLATE_TOOLS, WSP_TOOL_TIMEOUT_SEC, type AgentLaunch, type McpServerSpec } from "@wsp/protocol";

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** The sandbox modes thread/start takes; the one that turns the sandbox off is the one that asks nobody. */
const SANDBOXED = ["read-only", "workspace-write"] as const;
const NO_SANDBOX = "danger-full-access";

export interface CodexEnvOptions {
  base?: Readonly<Record<string, string | undefined>>;
  /** Absolute path for CODEX_HOME, where the box's own login is mounted or a sign-in there wrote auth.json. */
  home: string;
  /** The API key the vault holds for this agent; set on every turn's environment. */
  apiKey?: string;
}

/** CODEX_HOME points codex at the home the sign-in wrote, since a guest exec carries no HOME to derive it from. */
export function buildEnv(options: CodexEnvOptions): Record<string, string> {
  const home = options.home.trim();
  if (!home.startsWith("/")) throw new Error(`home must be an absolute path, got "${options.home}"`);
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.base ?? {})) if (value !== undefined) clean[key] = value;
  // The key travels under both names. CODEX_API_KEY is the one this CLI's own login reads and prefers over the
  // store under CODEX_HOME (read_codex_api_key_from_env, codex-rs/login/src/auth/manager.rs at rust-v0.153.0);
  // OPENAI_API_KEY is read by a provider a person configured with env_key and by nothing in the CLI's own login.
  const key: Record<string, string> = options.apiKey === undefined ? {} : { CODEX_API_KEY: options.apiKey, OPENAI_API_KEY: options.apiKey };
  return { ...clean, CODEX_HOME: home, ...key };
}

export interface BuildCommandOptions {
  cwd?: string;
  /** MCP servers this turn gets besides the ones its config names, by the name each takes there. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  /** The program run in place of codex and the words added after app-server, from the person's setup there. */
  launch?: AgentLaunch;
}

/** A value that may ride a codex command line or a SQL literal unquoted; anything else is refused before it does. */
export function slug(name: string, value: string): string {
  if (!SLUG_RE.test(value)) throw new Error(`${name} must be a plain slug, got "${value}"`);
  return value;
}

/** A config override whose value is a TOML string, which is JSON's quoting for these plain words. */
const config = (key: string, value: string): string => `-c ${key}=${shellQuote(JSON.stringify(value))}`;

/** A config override whose value is TOML already: a JSON array of strings is one. */
const configRaw = (key: string, toml: string): string => `-c ${key}=${shellQuote(toml)}`;

const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Each server as a whole config entry: an override naming only env_vars for a server the config does not hold stops
 * codex at start (measured on codex-cli 0.155.1). */
function serverFlags(servers: Readonly<Record<string, McpServerSpec>>): string[] {
  const entry = (name: string, spec: McpServerSpec): string[] => {
    const at = `mcp_servers.${name}`;
    return [
      config(`${at}.command`, spec.command),
      configRaw(`${at}.args`, JSON.stringify(spec.args)),
      // Codex hands a server only its own short list of variables (codex-rs/rmcp-client/src/utils.rs at
      // rust-v0.155.1), so the launch's are named for the wsp one: names only, the values stay in the environment.
      ...(name === MCP_SERVER_NAME || name === SLATE_SERVER_NAME ? [configRaw(`${at}.env_vars`, JSON.stringify(LAUNCH_ENV)), configRaw(`${at}.tool_timeout_sec`, String(WSP_TOOL_TIMEOUT_SEC))] : []),
    ];
  };
  return Object.entries(servers).flatMap(([name, spec]) => {
    if (!SERVER_NAME_RE.test(name)) throw new Error(`an MCP server name must be one plain word of a config key, got "${name}"`);
    if (name !== MCP_SERVER_NAME) return entry(name, spec);
    const slate = JSON.stringify(SLATE_TOOLS);
    // A thread another thread started has no slate: the tools stay off its wsp server and no slate server stands.
    if (spec.noSlate === true) return [...entry(name, spec), configRaw(`mcp_servers.${name}.disabled_tools`, slate)];
    return [
      ...entry(name, spec),
      configRaw(`mcp_servers.${name}.disabled_tools`, slate),
      ...entry(SLATE_SERVER_NAME, spec),
      configRaw(`mcp_servers.${SLATE_SERVER_NAME}.enabled_tools`, slate),
      configRaw(`mcp_servers.${SLATE_SERVER_NAME}.omit_tools_from`, JSON.stringify(["deferred"])),
    ];
  });
}

export interface AccessParams {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "on-request" | "never";
}

/** A sandboxed mode asks the person before the agent goes past its sandbox; full access, and a turn that names no
 * mode, as every turn in a throwaway machine does, runs unsandboxed and asks nobody. */
export function accessParams(mode: string | undefined): AccessParams {
  if (mode === undefined || mode === NO_SANDBOX) return { sandbox: NO_SANDBOX, approvalPolicy: "never" };
  const sandboxed = SANDBOXED.find(m => m === mode);
  if (sandboxed === undefined) throw new Error(`permissionMode must be one of ${[...SANDBOXED, NO_SANDBOX].join(", ")}, got "${mode}"`);
  return { sandbox: sandboxed, approvalPolicy: "on-request" };
}

/** The server as one bash line in the folder the turn runs in. Guest exec carries no HOME, so the default folder is
 * `~`, which bash reads from passwd. */
export function buildCommand(options: BuildCommandOptions): string {
  // The plan tool is off in a headless server unless its config turns it on; its updates are the turn's steps.
  return inFolder(options.cwd, [`${programWord("codex", options.launch)} app-server`, ...launchWords(options.launch), configRaw("tools.update_plan.enabled", "true"), ...serverFlags(options.mcpServers ?? {})].join(" "));
}

/** An image path is a plain absolute path on the machine, where the runtime landed it before the turn. */
export function imagePath(path: string): string {
  if (!path.startsWith("/") || path.includes("\n")) throw new Error(`an image path must be one absolute path on the machine, got "${path}"`);
  return path;
}
