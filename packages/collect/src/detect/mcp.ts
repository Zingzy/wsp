// SPDX-License-Identifier: AGPL-3.0-only
// MCP servers travel with the agent that runs them, credentials included: one
// row per server under its agent. The definition itself rides inside the
// agent's config file (the agent's own row); this file reads that config to
// say what each server is, what it needs on Linux and which secret it carries.
// Token files are only stat'ed, never read.
import { createHash } from "node:crypto";
import { type Host, expand } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { isSecretName } from "../everything/shell-rc.js";

export const MCP_ID_PREFIX = "agents/mcp/";
/** The row that carries mcp-remote's saved browser sign-ins for every agent. */
export const MCP_REMOTE_ID = `${MCP_ID_PREFIX}mcp-remote`;
export const MCP_REMOTE_LABEL = "mcp-remote sign-ins";

export type McpFormat = "claude" | "codex" | "gemini" | "opencode";

export interface McpConfig {
  agent: string;
  label: string;
  format: McpFormat;
  /** `~/`-relative; the first that exists is read. */
  files: readonly string[];
}

/** Where each agent keeps its user-wide MCP definitions, per its own docs. */
export const MCP_CONFIGS: readonly McpConfig[] = [
  // https://docs.claude.com/en/docs/claude-code/mcp (user scope; project scope lives in each repo's .mcp.json)
  { agent: "claude", label: "Claude Code", format: "claude", files: ["~/.claude.json"] },
  // https://github.com/openai/codex/blob/main/docs/config.md#mcp_servers
  { agent: "codex", label: "Codex", format: "codex", files: ["~/.codex/config.toml"] },
  // https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
  { agent: "gemini", label: "Gemini CLI", format: "gemini", files: ["~/.gemini/settings.json"] },
  // https://opencode.ai/docs/mcp-servers/
  { agent: "opencode", label: "OpenCode", format: "opencode", files: ["~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc"] },
];

export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: "http"; url: string; headers: Record<string, string> };

export interface McpServer {
  name: string;
  /** `home`: Claude Code's project scope for the home folder itself, which the machine's home stands in for. */
  scope: "user" | "home";
  transport: McpTransport;
  /** Variables the definition reads from the environment at run time (Codex's bearer_token_env_var); names only. */
  envRefs: string[];
}

export type LinuxFit = { ok: true; needs: string } | { ok: false; reason: string };

const MCP_AUTH = "~/.mcp-auth";
/** mcp-remote's store since its versioned folders went away: MCP_REMOTE_CONFIG_DIR or ~/.mcp-auth, then mcp-remote-v1. */
const MCP_REMOTE_STORE = `${MCP_AUTH}/mcp-remote-v1`;

// --- parsing -----------------------------------------------------------------

/** Comments outside strings go; Gemini CLI and OpenCode accept them in their settings. */
function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) out += text[++i];
      else if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(stripJsonComments(text));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
function dict(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** Claude Code and Gemini CLI share one shape: command/args/env/cwd, or url (httpUrl for Gemini's streamable HTTP) with headers. */
function fromClaudeLike(name: string, raw: unknown, scope: McpServer["scope"]): McpServer | undefined {
  if (!isObject(raw)) return undefined;
  const command = str(raw.command);
  const url = str(raw.httpUrl) ?? str(raw.url);
  if (command !== undefined) {
    const cwd = str(raw.cwd);
    return { name, scope, transport: { kind: "stdio", command, args: strs(raw.args), env: dict(raw.env), ...(cwd !== undefined ? { cwd } : {}) }, envRefs: [] };
  }
  if (url !== undefined) return { name, scope, transport: { kind: "http", url, headers: dict(raw.headers) }, envRefs: [] };
  return undefined;
}

function fromOpenCode(name: string, raw: unknown): McpServer | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.type === "remote") {
    const url = str(raw.url);
    return url === undefined ? undefined : { name, scope: "user", transport: { kind: "http", url, headers: dict(raw.headers) }, envRefs: [] };
  }
  const [command, ...args] = strs(raw.command);
  if (command === undefined) return undefined;
  return { name, scope: "user", transport: { kind: "stdio", command, args, env: dict(raw.environment) }, envRefs: [] };
}

interface CodexTable {
  values: Record<string, unknown>;
  env: Record<string, string>;
  headers: Record<string, string>;
  envHeaders: Record<string, string>;
}

const TOML_HEADER = /^\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:\.\s*([A-Za-z0-9_-]+)\s*)?\]$/;
const TOML_STRING = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

/** A line without its trailing comment: `#` outside quotes ends it. */
function uncommented(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== undefined) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function unescapeToml(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_, ch: string) => ({ '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t" })[ch] ?? ch);
}

function tomlStrings(s: string): string[] {
  return [...s.matchAll(TOML_STRING)].map(m => (m[1] !== undefined ? unescapeToml(m[1]) : m[2]!));
}

/** A basic string, an array of strings, or an inline table of strings; anything else is left out. */
function tomlValue(raw: string): unknown {
  const s = raw.trim();
  if (s.startsWith("[")) return tomlStrings(s);
  if (s.startsWith("{")) {
    const out: Record<string, string> = {};
    for (const m of s.slice(1, -1).matchAll(/(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) {
      out[m[1] ?? m[2] ?? m[3]!] = tomlStrings(m[4]!)[0] ?? "";
    }
    return out;
  }
  if (s.startsWith('"') || s.startsWith("'")) return tomlStrings(s)[0];
  return undefined;
}

/** Codex's `[mcp_servers.<name>]` tables and their env, http_headers and env_http_headers sub-tables, in file
 * order. Only the table form Codex documents and `codex mcp add` writes is read. */
export function parseCodexMcp(text: string): McpServer[] {
  const tables = new Map<string, CodexTable>();
  let current: { name: string; sub?: string } | undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = uncommented(lines[i]!).trim();
    if (line === "") continue;
    if (line.startsWith("[")) {
      const m = TOML_HEADER.exec(line);
      current = m === null ? undefined : { name: m[1] ?? m[2] ?? m[3]!, ...(m[4] !== undefined ? { sub: m[4] } : {}) };
      if (current !== undefined && !tables.has(current.name)) tables.set(current.name, { values: {}, env: {}, headers: {}, envHeaders: {} });
      continue;
    }
    if (current === undefined) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"(.*)"$/, "$1");
    let value = line.slice(eq + 1).trim();
    // A multi-line array closes on a later line.
    while (value.startsWith("[") && !value.endsWith("]") && i + 1 < lines.length) value += uncommented(lines[++i]!).trim();
    const parsed = tomlValue(value);
    if (parsed === undefined) continue;
    const table = tables.get(current.name)!;
    if (current.sub === undefined) table.values[key] = parsed;
    else if (typeof parsed === "string") {
      if (current.sub === "env") table.env[key] = parsed;
      else if (current.sub === "http_headers") table.headers[key] = parsed;
      else if (current.sub === "env_http_headers") table.envHeaders[key] = parsed;
    }
  }
  const out: McpServer[] = [];
  for (const [name, t] of tables) {
    const command = str(t.values.command);
    const url = str(t.values.url);
    const bearer = str(t.values.bearer_token_env_var);
    const envRefs = [...(bearer !== undefined ? [bearer] : []), ...Object.values({ ...dict(t.values.env_http_headers), ...t.envHeaders })];
    if (command !== undefined) {
      out.push({ name, scope: "user", transport: { kind: "stdio", command, args: strs(t.values.args), env: { ...dict(t.values.env), ...t.env } }, envRefs });
    } else if (url !== undefined) {
      out.push({ name, scope: "user", transport: { kind: "http", url, headers: { ...dict(t.values.http_headers), ...t.headers } }, envRefs });
    }
  }
  return out;
}

/** Every server an agent's config defines, in one shape; a file that does not parse defines none. */
export function parseMcp(format: McpFormat, text: string, home: string): McpServer[] {
  if (format === "codex") return parseCodexMcp(text);
  const root = parseJson(text);
  if (root === undefined) return [];
  const out: McpServer[] = [];
  if (format === "opencode") {
    if (isObject(root.mcp)) for (const [name, raw] of Object.entries(root.mcp)) out.push(...present(fromOpenCode(name, raw)));
    return out;
  }
  if (isObject(root.mcpServers)) for (const [name, raw] of Object.entries(root.mcpServers)) out.push(...present(fromClaudeLike(name, raw, "user")));
  if (format === "claude" && isObject(root.projects) && isObject(root.projects[home]) && isObject((root.projects[home] as Record<string, unknown>).mcpServers)) {
    for (const [name, raw] of Object.entries((root.projects[home] as Record<string, unknown>).mcpServers as Record<string, unknown>)) out.push(...present(fromClaudeLike(name, raw, "home")));
  }
  return out;
}

const present = <T>(v: T | undefined): T[] => (v === undefined ? [] : [v]);

// --- what runs on Linux --------------------------------------------------------

/** Absolute prefixes with no Linux equivalent. */
const MAC_ONLY = ["/Applications/", "/System/", "/Library/", "/Volumes/", "/private/", "/opt/homebrew/Caskroom/"];
/** Directories whose binaries the machine finds on its own PATH under the same name. */
const BIN_DIRS = ["/opt/homebrew/bin/", "/opt/homebrew/sbin/", "/usr/local/bin/", "/usr/bin/", "/bin/"];

function tilde(home: string, p: string): string {
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function isMacOnly(p: string, home: string): boolean {
  const abs = p.startsWith("~/") ? `${home}${p.slice(1)}` : p;
  return abs.startsWith(`${home}/Library/`) || MAC_ONLY.some(prefix => abs.startsWith(prefix));
}

/** `--flag=/path` carries its path after the equals sign. */
const pathOf = (s: string): string => (/^--?[\w-]+=/.test(s) ? s.slice(s.indexOf("=") + 1) : s);

/** The binary a command names: a path under a known bin directory or under ~/.local/bin is found by name on the machine. */
function binaryOf(command: string, home: string): string {
  const abs = command.startsWith("~/") ? `${home}${command.slice(1)}` : command;
  if (!abs.startsWith("/")) return abs;
  if (BIN_DIRS.some(d => abs.startsWith(d)) || abs.startsWith(`${home}/.local/bin/`)) return abs.slice(abs.lastIndexOf("/") + 1);
  return tilde(home, abs);
}

/** Whether a definition can run on the machine and what it needs there. A path under ~/Library or a macOS
 * install location has no Linux equivalent; home paths and Homebrew's prefix are rewritten on the machine. */
export function linuxFit(server: McpServer, home: string): LinuxFit {
  const t = server.transport;
  if (t.kind === "http") return { ok: true, needs: "nothing to install" };
  if (isMacOnly(t.command, home)) return { ok: false, reason: `command ${tilde(home, t.command)} is macOS-only, will not run` };
  for (const s of [...t.args.map(pathOf), ...(t.cwd !== undefined ? [t.cwd] : []), ...Object.values(t.env)]) {
    if (isMacOnly(s, home)) return { ok: false, reason: `path ${tilde(home, s)} is macOS-only, will not run` };
  }
  const bin = binaryOf(t.command, home);
  if (bin === "npx") return { ok: true, needs: "runs via npx" };
  if (bin === "uvx" || bin === "uv") return { ok: true, needs: "needs uv, installed on the machine when missing" };
  return { ok: true, needs: `needs ${bin} on the machine` };
}

// --- mcp-remote ------------------------------------------------------------------

const isUrl = (s: string): boolean => /^https?:\/\//.test(s);

/** The store key mcp-remote derives for a definition that runs it: md5 of the server url, joined with `|` to
 * the sorted JSON of any `--header` pairs. Undefined when the definition does not run mcp-remote. */
export function mcpRemoteHash(args: readonly string[]): string | undefined {
  const at = args.findIndex(a => /^mcp-remote(@[^/]*)?$/.test(a));
  if (at < 0) return undefined;
  const url = args.slice(at + 1).find(isUrl);
  if (url === undefined) return undefined;
  const headers: Record<string, string> = {};
  for (let i = at + 1; i < args.length; i++) {
    if (args[i] !== "--header" && args[i] !== "-H") continue;
    const pair = args[i + 1];
    const colon = pair?.indexOf(":") ?? -1;
    if (pair !== undefined && colon > 0) headers[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
  }
  const keys = Object.keys(headers).sort();
  const parts = [url, ...(keys.length > 0 ? [JSON.stringify(headers, keys)] : [])];
  return createHash("md5").update(parts.join("|")).digest("hex");
}

// --- rows ----------------------------------------------------------------------------

function fmt(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${Math.round(n / (1024 * 1024))} MB`;
}

/** isSecretName's words plus the ones a file-valued variable tends to carry. */
function secretNamed(name: string): boolean {
  return isSecretName(name) || name.toUpperCase().split("_").some(w => ["CREDENTIAL", "CREDENTIALS", "AUTH", "CERT", "PASSWD"].includes(w));
}

const shownUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

/** The definition in a few words: the command and its arguments with npx's yes flag dropped, urls shown as
 * host and path, and the value of a --header flag hidden. */
function transportLine(t: McpTransport, home: string): string {
  if (t.kind === "http") return `http: ${shownUrl(t.url)}`;
  const shown: string[] = [];
  for (let i = 0; i < t.args.length; i++) {
    const a = t.args[i]!;
    if (a === "-y" || a === "--yes") continue;
    if (a === "--header" || a === "-H") {
      shown.push(a, "…");
      i++;
      continue;
    }
    shown.push(isUrl(a) ? `(${shownUrl(a)})` : tilde(home, a));
  }
  const cut = shown.length > 5 ? [...shown.slice(0, 5), "…"] : shown;
  return `stdio: ${[tilde(home, t.command), ...cut].join(" ")}`;
}

interface Carried {
  secrets: string[];
  notes: string[];
  paths: string[];
  bytes: number;
}

/** What a definition carries: secret-named env values by size, the file such a value points at (which travels on
 * the row), header values, and where its mcp-remote or Claude Code sign-in lives. Nothing is read. */
async function carried(host: Host, server: McpServer, format: McpFormat, remoteTokens: ReadonlyMap<string, number>): Promise<Carried> {
  const out: Carried = { secrets: [], notes: [], paths: [], bytes: 0 };
  const t = server.transport;
  if (t.kind === "http") {
    for (const [k, v] of Object.entries(t.headers)) out.secrets.push(`header ${k} (${Buffer.byteLength(v)} B)`);
    if (format === "claude") out.notes.push("its sign-in is kept with the Claude Code login");
    return out;
  }
  for (const [k, v] of Object.entries(t.env)) {
    if (!secretNamed(k)) continue;
    const abs = v.startsWith("~/") ? expand(host, v) : v;
    const st = abs.startsWith("/") ? await host.fs.stat(abs) : undefined;
    if (st?.kind === "file") {
      if (!abs.startsWith(`${host.home}/`)) {
        out.notes.push(`the file ${k} points at, ${abs}, is outside your home and is not copied`);
        continue;
      }
      out.secrets.push(`the file ${k} points at (${fmt(st.bytes)})`);
      out.paths.push(`~${abs.slice(host.home.length)}`);
      out.bytes += st.bytes;
      continue;
    }
    out.secrets.push(`env ${k} (${Buffer.byteLength(v)} B)`);
  }
  const hash = mcpRemoteHash(t.args);
  if (hash !== undefined) {
    const bytes = remoteTokens.get(hash);
    out.notes.push(bytes === undefined ? "no saved sign-in; the browser sign-in runs again on the machine" : `its saved sign-in (${fmt(bytes)}) travels on the ${MCP_REMOTE_LABEL} row`);
  }
  return out;
}

function serverRow(config: McpConfig, server: McpServer, fit: LinuxFit, c: Carried, home: string): ManifestEntry {
  const id = `${MCP_ID_PREFIX}${config.agent}/${server.scope === "home" ? "home/" : ""}${server.name}`;
  const words = [
    ...(server.scope === "home" ? ["local to ~"] : []),
    transportLine(server.transport, home),
    ...(fit.ok ? [fit.needs] : []),
    ...server.envRefs.map(n => `reads ${n} from the environment, set it on the machine`),
    ...(c.secrets.length > 0 ? [`carries ${c.secrets.length === 1 ? "a secret" : "secrets"}: ${c.secrets.join(", ")}`] : c.notes.length === 0 ? ["carries no secret"] : []),
    ...c.notes,
  ];
  return {
    rung: "agents",
    id,
    label: server.name,
    group: `${config.label} MCP servers`,
    paths: c.paths,
    bytes: c.bytes,
    default: fit.ok ? "bring" : "skip",
    ...(fit.ok ? {} : { reason: fit.reason }),
    detail: words.join("; "),
  };
}

interface RemoteStore {
  /** Token file size by server hash. */
  tokens: Map<string, number>;
  /** client_info and token files together. */
  bytes: number;
  excludes: string[];
}

/** The store as it is on disk, by listing: token sizes per hash, older bridge versions' folders and lock files
 * set aside. Undefined when there is no store. */
async function remoteStore(host: Host): Promise<RemoteStore | undefined> {
  if ((await host.fs.stat(expand(host, MCP_AUTH)))?.kind !== "dir") return undefined;
  const out: RemoteStore = { tokens: new Map(), bytes: 0, excludes: [] };
  for (const name of await host.fs.list(expand(host, MCP_AUTH))) if (/^mcp-remote-\d/.test(name)) out.excludes.push(`${MCP_AUTH}/${name}`);
  for (const name of await host.fs.list(expand(host, MCP_REMOTE_STORE))) {
    const m = /^([0-9a-f]{32})_(tokens|client_info|lock)\.json$/.exec(name);
    if (m === null) continue;
    if (m[2] === "lock") {
      out.excludes.push(`${MCP_REMOTE_STORE}/${name}`);
      continue;
    }
    const bytes = (await host.fs.stat(expand(host, `${MCP_REMOTE_STORE}/${name}`)))?.bytes ?? 0;
    out.bytes += bytes;
    if (m[2] === "tokens") out.tokens.set(m[1]!, bytes);
  }
  return out;
}

function remoteRow(store: RemoteStore, matched: readonly string[]): ManifestEntry {
  const n = store.tokens.size;
  const tokenBytes = [...store.tokens.values()].reduce((a, b) => a + b, 0);
  const older = store.excludes.some(e => !e.startsWith(`${MCP_REMOTE_STORE}/`));
  const base = { rung: "agents" as const, id: MCP_REMOTE_ID, label: MCP_REMOTE_LABEL, group: "MCP sign-ins", paths: [MCP_AUTH], ...(store.excludes.length > 0 ? { excludes: store.excludes } : {}), bytes: store.bytes };
  if (n === 0) return { ...base, default: "skip", reason: `no saved sign-in the current bridge reads${older ? "; older versions' folders are left here" : ""}` };
  const elsewhere = n - matched.length;
  const whom = [...(matched.length > 0 ? [`for ${matched.join(", ")}`] : []), ...(elsewhere > 0 ? [`${elsewhere} for server${elsewhere === 1 ? "" : "s"} configured elsewhere (a repo's .mcp.json)`] : [])];
  return {
    ...base,
    default: "bring",
    detail: `browser sign-ins saved by mcp-remote for remote servers: ${n} token${n === 1 ? "" : "s"} (${fmt(tokenBytes)})${whom.length > 0 ? `, ${whom.join("; ")}` : ""}${older ? "; older bridge versions' folders stay here" : ""}`,
  };
}

/** One row per MCP server under its agent, then the mcp-remote sign-in store when there is one. */
export async function detectMcp(host: Host): Promise<ManifestEntry[]> {
  const store = await remoteStore(host);
  const tokens = store?.tokens ?? new Map<string, number>();
  const rows: ManifestEntry[] = [];
  const matched: string[] = [];
  for (const config of MCP_CONFIGS) {
    let text: string | undefined;
    for (const file of config.files) {
      if ((await host.fs.stat(expand(host, file)))?.kind !== "file") continue;
      text = await host.fs.readText(expand(host, file));
      if (text !== undefined) break;
    }
    if (text === undefined) continue;
    for (const server of parseMcp(config.format, text, host.home)) {
      const fit = linuxFit(server, host.home);
      const c = await carried(host, server, config.format, tokens);
      const hash = server.transport.kind === "stdio" ? mcpRemoteHash(server.transport.args) : undefined;
      if (hash !== undefined && tokens.has(hash)) matched.push(server.name);
      rows.push(serverRow(config, server, fit, c, host.home));
    }
  }
  if (store !== undefined) rows.push(remoteRow(store, matched));
  return rows;
}
