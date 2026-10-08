// SPDX-License-Identifier: AGPL-3.0-only
// The values the vault holds for MCP servers, handed to one turn's launch on a
// computer the person owns: each server of the agent's own config that reads
// one of them by name, as the launch takes it. No config file is written and
// the agent's environment carries none of them. Claude Code takes whole entries
// in an --mcp-config file, which stand for the config's own for that run;
// Codex takes config keys on its thread's start, laid over its own entries, so
// every key the person set there stays.
import { readJsonc } from "./jsonc.js";
import { CODEX_TOML, type McpFormat, type McpServer } from "./mcp.js";

/** The agent's config as that computer holds it for one turn: its own file, and the project's in the folder the
 * turn runs in; absent where there is none. */
export interface LaunchConfigs {
  user?: string;
  project?: string;
  /** The folder the turn runs in, which picks the agent's servers kept for that folder. */
  folder: string;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const objectOf = (text: string | undefined): Json => {
  if (text === undefined) return {};
  try {
    const read = readJsonc(text).value;
    return isObject(read) ? read : {};
  } catch {
    return {};
  }
};
const serversIn = (v: unknown): Json => (isObject(v) && isObject(v["mcpServers"]) ? v["mcpServers"] : {});
const namesIn = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Each `${NAME}` and `${NAME:-default}` of a name `values` holds written as its value, a default with it; whether
 * any was. Every other reference stays, for the agent to read from its own environment. */
function filled(v: unknown, values: Readonly<Record<string, string>>): { value: unknown; any: boolean } {
  if (typeof v === "string") {
    let any = false;
    const value = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g, (whole, name: string) => {
      if (!Object.hasOwn(values, name)) return whole;
      any = true;
      return values[name]!;
    });
    return { value, any };
  }
  if (Array.isArray(v)) {
    const each = v.map(x => filled(x, values));
    return { value: each.map(x => x.value), any: each.some(x => x.any) };
  }
  if (isObject(v)) {
    const each = Object.entries(v).map(([k, x]) => [k, filled(x, values)] as const);
    return { value: Object.fromEntries(each.map(([k, x]) => [k, x.value])), any: each.some(([, x]) => x.any) };
  }
  return { value: v, any: false };
}

/** Claude Code: every server the turn's folder loads that reads a name `values` holds, as its whole entry with those
 * filled in place and every other key as written. The folder's own servers stand over the project's .mcp.json, and
 * those over the user's, as Claude Code loads them; one switched off for the folder stays off. */
export function claudeLaunchServers(configs: LaunchConfigs, values: Readonly<Record<string, string>>): Record<string, Json> {
  if (Object.keys(values).length === 0) return {};
  const user = objectOf(configs.user);
  const folder = isObject(user["projects"]) ? user["projects"][configs.folder] : undefined;
  const off = new Set([...namesIn(isObject(folder) ? folder["disabledMcpServers"] : undefined), ...namesIn(isObject(folder) ? folder["disabledMcpjsonServers"] : undefined)]);
  const loaded = { ...serversIn(user), ...serversIn(objectOf(configs.project)), ...serversIn(folder) };
  const out: Record<string, Json> = {};
  for (const [name, entry] of Object.entries(loaded)) {
    if (off.has(name) || !isObject(entry)) continue;
    const { value, any } = filled(entry, values);
    if (any) out[name] = value as Json;
  }
  return out;
}

const PLAIN_KEY = /^[A-Za-z0-9_-]+$/;

/** Whether Codex's own file marks the folder trusted, which is when it loads the project's file at all, read by a TOML
 * parser so every spelling of the key reads the same. The parser is loaded only when a project file is there. */
async function codexTrusts(user: string, folder: string): Promise<boolean> {
  const { parse } = await import("smol-toml");
  try {
    const projects = (parse(user) as Json)["projects"];
    const entry = isObject(projects) ? projects[folder] : undefined;
    return isObject(entry) && entry["trust_level"] === "trusted";
  } catch {
    return false;
  }
}

/** Codex: the config keys a thread's start sets so each server that passes a name `values` holds through its
 * env_vars or env_http_headers gets it, the entry's own keys kept, since Codex lays these over the entry. A server
 * reading its token through bearer_token_env_var is not among them: Codex reads that from its own environment alone. */
export async function codexLaunchConfig(configs: LaunchConfigs, values: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  if (Object.keys(values).length === 0 || configs.user === undefined) return {};
  const project = configs.project !== undefined && (await codexTrusts(configs.user, configs.folder)) ? CODEX_TOML.read(configs.project, configs.folder) : [];
  const servers = new Map([...CODEX_TOML.read(configs.user, configs.folder), ...project].map(s => [s.name, s]));
  const out: Record<string, string> = {};
  for (const s of servers.values()) {
    if (s.disabled === true || s.reads === undefined || !PLAIN_KEY.test(s.name)) continue;
    for (const name of s.reads.env) if (Object.hasOwn(values, name) && PLAIN_KEY.test(name)) out[`mcp_servers.${s.name}.env.${name}`] = values[name]!;
    for (const [header, name] of Object.entries(s.reads.headers)) if (Object.hasOwn(values, name) && PLAIN_KEY.test(header)) out[`mcp_servers.${s.name}.http_headers.${header}`] = values[name]!;
  }
  return out;
}

/** The values one launch hands an agent's servers, as its CLI takes them. */
export interface LaunchServerValues {
  entries?: Record<string, Json>;
  config?: Record<string, string>;
}

/** Where an agent whose CLI takes servers at launch keeps them on a computer, and how its launch is filled: its own
 * file under the store folder its variable names (the home's default without one), its project's file relative to
 * the folder a turn runs in. `hands` says whether the launch can hand a server a name it reads. */
export interface LaunchServerRoad {
  user: (store: string | undefined, home: string) => string;
  project: string;
  fill: (configs: LaunchConfigs, values: Readonly<Record<string, string>>) => Promise<LaunchServerValues>;
  hands: (server: McpServer, name: string) => boolean;
}

export const LAUNCH_SERVER_ROADS: Readonly<Record<string, LaunchServerRoad>> = {
  claude: { user: (store, home) => `${store ?? home}/.claude.json`, project: ".mcp.json", fill: async (c, v) => ({ entries: claudeLaunchServers(c, v) }), hands: () => true },
  codex: {
    user: (store, home) => `${store ?? `${home}/.codex`}/config.toml`,
    project: ".codex/config.toml",
    fill: async (c, v) => ({ config: await codexLaunchConfig(c, v) }),
    hands: (server, name) => (server.reads?.env.includes(name) ?? false) || Object.values(server.reads?.headers ?? {}).includes(name),
  },
};

/** The names `held` holds that a server reads and a turn's launch on a computer the person owns cannot hand it: every
 * one where the agent's CLI takes no servers at launch, and for Codex one read through bearer_token_env_var. The names
 * a server reads are the ones its own format's resolve asks for. */
export function launchMisses(agent: string, format: McpFormat, server: McpServer, held: ReadonlySet<string>): string[] {
  const read = new Set<string>();
  format.resolve(server, name => {
    read.add(name);
    return "";
  });
  const road = LAUNCH_SERVER_ROADS[agent];
  return [...read].filter(name => held.has(name) && road?.hands(server, name) !== true).sort();
}
