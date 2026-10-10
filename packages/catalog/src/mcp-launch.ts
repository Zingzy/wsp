// SPDX-License-Identifier: AGPL-3.0-only
// Which MCP servers a turn of an agent gets in a folder, read off the files
// that computer holds, by scope; and the values the vault holds for them,
// handed to one turn's launch on a computer the person owns: each server that
// reads one of them by name, as the launch takes it. No config file is written
// and the agent's environment carries none of them. Claude Code takes whole
// entries in an --mcp-config file, which stand for the config's own for that
// run; Codex takes config keys on its thread's start, laid over its own
// entries, so every key the person set there stays.
import { underProject } from "@wsp/protocol";
import { readJsonc } from "./jsonc.js";
import { CODEX_TOML, MCP_SERVERS_JSON, editJson, type McpFormat, type McpServer } from "./mcp.js";
import { codexTrusts } from "./mcp-codex.js";

/** One config file as that computer holds it. */
export interface TurnFile {
  path: string;
  text: string;
}

/** The agent's config as that computer holds it for one turn: its own file, and each project file the folder the
 * turn runs in reads, nearest first; absent where there is none. */
export interface LaunchConfigs {
  user?: TurnFile;
  projects?: readonly TurnFile[];
  /** The folder the turn runs in. */
  folder: string;
  /** The folder the agent keeps the turn's own servers and trust under: the project's folder for a turn in one of
   * its worktrees, which Claude Code and Codex key by the main checkout; the folder itself without one. */
  key?: string;
}

/** Where a turn's server is defined: the agent's own file for every folder (`user`), its own file for this folder
 * alone (`local`), or a file in the folder or one above it (`project`). */
export type TurnScope = "user" | "local" | "project";

/** One server a turn reads, in the scope and file it is defined in; its `disabled` where the agent keeps it switched
 * off there, which the turn lists and does not start. */
export interface TurnServer {
  server: McpServer;
  scope: TurnScope;
  file: string;
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

// The web app bundles this module, so its paths are joined by hand rather than with node:path.
/** An absolute path with its `.` and `..` parts read and no empty part. */
const normal = (path: string): string => `/${path.split("/").reduce<string[]>((out, p) => (p === "" || p === "." ? out : p === ".." ? out.slice(0, -1) : [...out, p]), []).join("/")}`;
const parentOf = (path: string): string => (path.lastIndexOf("/") <= 0 ? "/" : path.slice(0, path.lastIndexOf("/")));
const join = (folder: string, rel: string): string => normal(`${folder}/${rel}`);

/** Each folder from `folder` up to the root, nearest first, or up to `top` where `top` holds it. */
const upFrom = (folder: string, top?: string): string[] => {
  const out = [normal(folder)];
  const end = top === undefined ? undefined : normal(top);
  const holds = end !== undefined && (end === out[0] || out[0]!.startsWith(`${end === "/" ? "" : end}/`));
  while (out.at(-1) !== "/" && !(holds && out.at(-1) === end)) out.push(parentOf(out.at(-1)!));
  return holds || end === undefined ? out : out.slice(0, 1);
};

/** The folder's checkout as git answers it there: its own top, and the folder both agents key a turn's own servers
 * and trust by, which is the main checkout's top for a worktree and the folder itself outside git. */
export interface Checkout {
  top?: string;
  key: string;
}

/** The git line that reads a folder's checkout, as arguments to git. */
export const checkoutArgs = (folder: string): string[] => ["-C", folder, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"];

/** A folder's checkout off what `checkoutArgs` printed, or nothing where git did not answer (a folder outside git). */
export function checkoutOf(said: string | undefined, folder: string): Checkout {
  const [top, common] = (said ?? "").split("\n").map(l => l.trim());
  if (top === undefined || top === "" || !top.startsWith("/")) return { key: folder };
  return { top, key: common !== undefined && common.endsWith("/.git") ? parentOf(common) : top };
}

/** Claude Code's servers for a turn, as 2.1.296 loads them (measured): the folder's own entry under `projects` in
 * its user file, keyed by the main checkout, before each .mcp.json from the folder up to the root, nearest first,
 * before the user file's own. That entry's disabledMcpServers switches a server of any scope off, and its
 * disabledMcpjsonServers leaves a .mcp.json server out altogether; an .mcp.json server waiting on approval in the app
 * still starts in a turn. */
function claudeServers(configs: LaunchConfigs): TurnServer[] {
  const key = configs.key ?? configs.folder;
  const user = configs.user;
  const folder = user === undefined ? undefined : objectOf(user.text)["projects"];
  const entry = isObject(folder) ? folder[key] : undefined;
  const off = new Set(namesIn(isObject(entry) ? entry["disabledMcpServers"] : undefined));
  const left = new Set(namesIn(isObject(entry) ? entry["disabledMcpjsonServers"] : undefined));
  const own = user === undefined ? [] : MCP_SERVERS_JSON.read(user.text, key);
  const project = (configs.projects ?? []).flatMap(f =>
    MCP_SERVERS_JSON.read(f.text, key)
      .filter(s => s.scope === "user" && !left.has(s.name))
      .map(server => ({ server, scope: "project" as const, file: f.path })),
  );
  const mine = (scope: "user" | "home"): TurnServer[] => own.filter(s => s.scope === scope).map(server => ({ server, scope: scope === "home" ? "local" : "user", file: user!.path }));
  return [...mine("home"), ...project, ...mine("user")].map(s => (off.has(s.server.name) ? { ...s, server: { ...s.server, disabled: true } } : s));
}

/** Codex's servers for a turn, as 0.162.1 loads them (measured): each .codex/config.toml from the folder up to its
 * checkout's top, nearest first, where its own file marks the main checkout trusted, before its own file's. */
async function codexServers(configs: LaunchConfigs): Promise<TurnServer[]> {
  const user = configs.user;
  if (user === undefined) return [];
  const files = configs.projects ?? [];
  const trusted = files.length > 0 && (await codexTrusts(user.text, configs.key ?? configs.folder));
  const project = trusted ? files.flatMap(f => CODEX_TOML.read(f.text, configs.folder).map(server => ({ server, scope: "project" as const, file: f.path }))) : [];
  return [...project, ...CODEX_TOML.read(user.text, configs.folder).map(server => ({ server, scope: "user" as const, file: user.path }))];
}

/** The servers that start: the first definition of each name in the order the agent reads them, where it is on. */
export function startedServers(servers: readonly TurnServer[]): TurnServer[] {
  const seen = new Set<string>();
  const out: TurnServer[] = [];
  for (const s of servers) {
    if (seen.has(s.server.name)) continue;
    seen.add(s.server.name);
    if (s.server.disabled !== true) out.push(s);
  }
  return out;
}

/** Claude Code: every server the turn's folder starts that reads a name `values` holds, as its whole entry with those
 * filled in place and every other key as written. */
export function claudeLaunchServers(configs: LaunchConfigs, values: Readonly<Record<string, string>>): Record<string, Json> {
  if (Object.keys(values).length === 0) return {};
  const key = configs.key ?? configs.folder;
  const texts = new Map([...(configs.user !== undefined ? [configs.user] : []), ...(configs.projects ?? [])].map(f => [f.path, f.text]));
  const out: Record<string, Json> = {};
  for (const s of startedServers(claudeServers(configs))) {
    const entry = MCP_SERVERS_JSON.entryOf(texts.get(s.file)!, s.server.name, s.scope === "local" ? key : undefined);
    if (entry === undefined) continue;
    const { value, any } = filled(JSON.parse(entry) as unknown, values);
    if (any) out[s.server.name] = value as Json;
  }
  return out;
}

const PLAIN_KEY = /^[A-Za-z0-9_-]+$/;

/** The ones of `keys` a TOML config sets no top-level value of, read by a TOML parser, so a quoted spelling is the same
 * key and one under a table is not. None where the text does not parse: Codex refuses that file whole, and a line
 * written above it would not mend it. */
export async function unsetTomlKeys<K extends { key: string }>(text: string, keys: readonly K[]): Promise<K[]> {
  const { parse } = await import("smol-toml");
  let top: Json;
  try {
    top = parse(text) as Json;
  } catch {
    return [];
  }
  return keys.filter(k => !Object.hasOwn(top, k.key));
}

/** Codex: the config keys a thread's start sets so each server that passes a name `values` holds through its
 * env_vars or env_http_headers gets it, the entry's own keys kept, since Codex lays these over the entry. A server
 * reading its token through bearer_token_env_var is not among them: Codex reads that from its own environment alone. */
export async function codexLaunchConfig(configs: LaunchConfigs, values: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  if (Object.keys(values).length === 0) return {};
  const out: Record<string, string> = {};
  for (const { server: s } of startedServers(await codexServers(configs))) {
    if (s.reads === undefined || !PLAIN_KEY.test(s.name)) continue;
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

/** A folder's own switches, by the key the agent keeps each list under: the names it leaves off for that folder. */
export type FolderSwitches = Readonly<Record<string, readonly string[]>>;

/** The lists Claude Code keeps under a folder's entry in its user file that switch servers off there. */
const CLAUDE_SWITCHES = ["disabledMcpServers", "disabledMcpjsonServers"] as const;

/** The folder's switches its user file holds under `key`, the lists that name any server; nothing where none does. */
function claudeSwitchesOf(text: string, key: string): FolderSwitches | undefined {
  const projects = objectOf(text)["projects"];
  const entry = isObject(projects) ? projects[key] : undefined;
  const out = Object.fromEntries(CLAUDE_SWITCHES.flatMap(k => (namesIn(isObject(entry) ? entry[k] : undefined).length > 0 ? [[k, namesIn(isObject(entry) ? entry[k] : undefined)]] : [])));
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The user file's text with each list of `switches` under `folder`'s entry, joined with the names already there. */
function withClaudeSwitches(text: string | undefined, folder: string, switches: FolderSwitches): string {
  if (text === undefined || text.trim() === "") return `${JSON.stringify({ projects: { [folder]: switches } }, null, 2)}\n`;
  const projects = objectOf(text)["projects"];
  const entry = isObject(projects) ? projects[folder] : undefined;
  return editJson(text, Object.entries(switches).map(([k, names]) => [["projects", folder, k], [...new Set([...namesIn(isObject(entry) ? entry[k] : undefined), ...names])]]));
}

export interface CarriedServers {
  files: string[];
  base: string;
  folder?: string;
  trust?: true;
}

/** Where an agent whose CLI takes servers at launch keeps them on a computer, how a turn reads them and how its launch
 * is filled: its own file under the store folder its variable names (the home's default without one), and the project
 * files a turn in a folder reads, nearest first. `hands` says whether the launch can hand a server a name it reads. */
export interface LaunchServerRoad {
  user: (store: string | undefined, home: string) => string;
  projectFiles: (folder: string, top?: string) => string[];
  servers: (configs: LaunchConfigs) => Promise<TurnServer[]>;
  /** Where a project's servers its checkout does not bring land on a computer wsp sets up, for the project's folder
   * there, given the agent's own file there: the files, the folder a write stays inside, the folder they sit under in
   * a file that keeps servers per folder, and whether the agent reads them only in a folder its own file trusts. */
  carry: (folder: string, own: { files: string[]; base: string }) => CarriedServers;
  /** A folder's switches as the agent's own file keeps them, read under one folder and written under another, for an
   * agent that keeps any; a project's switches travel with its servers. */
  switches?: { of: (text: string, key: string) => FolderSwitches | undefined; put: (text: string | undefined, folder: string, switches: FolderSwitches) => string };
  fill: (configs: LaunchConfigs, values: Readonly<Record<string, string>>) => Promise<LaunchServerValues>;
  hands: (server: McpServer, name: string) => boolean;
}

export const LAUNCH_SERVER_ROADS: Readonly<Record<string, LaunchServerRoad>> = {
  claude: {
    user: (store, home) => `${store ?? home}/.claude.json`,
    projectFiles: folder => upFrom(folder).map(d => join(d, ".mcp.json")),
    servers: async c => claudeServers(c),
    carry: (folder, own) => ({ ...own, folder }),
    switches: { of: claudeSwitchesOf, put: withClaudeSwitches },
    fill: async (c, v) => ({ entries: claudeLaunchServers(c, v) }),
    hands: () => true,
  },
  codex: {
    user: (store, home) => `${store ?? `${home}/.codex`}/config.toml`,
    projectFiles: (folder, top) => upFrom(folder, top ?? folder).map(d => join(d, ".codex/config.toml")),
    servers: codexServers,
    carry: folder => ({ files: [join(folder, ".codex/config.toml")], base: folder, trust: true }),
    fill: async (c, v) => ({ config: await codexLaunchConfig(c, v) }),
    hands: (server, name) => (server.reads?.env.includes(name) ?? false) || Object.values(server.reads?.headers ?? {}).includes(name),
  },
};

/** An agent as the resolver reads it: its catalog id and its format, with the project files it names. */
export type TurnAgent = { id: string; mcp: { format: McpFormat; files: readonly string[]; projectFiles?: readonly string[] } };

/** The files a turn of the agent in `folder` reads its servers from on a computer: its own file's candidates, the
 * first that is there being the one, and each project file, every one read. An agent with no road of its own names its
 * catalog files and every candidate of its project file in the folder, of which it reads the first that is there. `top`
 * is the folder's checkout top, up to which Codex reads its project files. */
export function turnServerFiles(agent: TurnAgent, folder: string, home: string, store?: string, top?: string): { user: string[]; projects: string[] } {
  const road = LAUNCH_SERVER_ROADS[agent.id];
  const user = ownServerConfig(agent, home, store).files;
  // A project file at home can be the agent's own file, which is read once, as its own.
  const projects = road !== undefined ? road.projectFiles(folder, top) : (agent.mcp.projectFiles ?? []).map(f => join(folder, f));
  return { user, projects: projects.filter(f => !user.includes(f)) };
}

/** Every server a turn of the agent gets in the configs' folder, by scope, in the order the agent reads them, so the
 * first of each name is the one that starts: the one answer the launch, the scan, the agents report and the checks
 * read. An agent with no road of its own reads the first of its project files that is there, before its own file. */
export async function turnServers(agent: TurnAgent, configs: LaunchConfigs): Promise<TurnServer[]> {
  const road = LAUNCH_SERVER_ROADS[agent.id];
  if (road !== undefined) return road.servers(configs);
  const format = agent.mcp.format;
  const project = (configs.projects ?? []).slice(0, 1).flatMap(f => format.read(f.text, configs.folder).filter(s => s.scope === "user").map(server => ({ server, scope: "project" as const, file: f.path })));
  const own = configs.user === undefined ? [] : format.read(configs.user.text, configs.folder).filter(s => s.scope === "user").map(server => ({ server, scope: "user" as const, file: configs.user!.path }));
  return [...project, ...own];
}

/** Where one agent's own servers live on a computer, the one rule every reader and writer of them takes there, the
 * launch among them: the file under the store its threads are pointed at, where one is named, else the catalog's files
 * under the home, the first that is there being the config. A store is whatever folder the agent's own variable names
 * (CLAUDE_CONFIG_DIR, CODEX_HOME), a box's logins folder among them. `base` is the folder a write must stay inside: the
 * home, or the store where it sits outside the home. */
export function ownServerConfig(agent: { id: string; mcp: { files: readonly string[] } }, home: string, store?: string): { files: string[]; base: string } {
  const road = LAUNCH_SERVER_ROADS[agent.id];
  if (store !== undefined && road !== undefined) return { files: [road.user(store, home)], base: underProject(store, home) ? home : store };
  return { files: agent.mcp.files.map(f => (f.startsWith("~/") ? `${home}/${f.slice(2)}` : f)), base: home };
}

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
