// SPDX-License-Identifier: AGPL-3.0-only
// How an agent keeps its MCP servers: one module per config format, with the
// three things done to such a file. The collector reads its servers and the
// install helper places one, both on this computer; the import edits it on the
// machine, whose node runs the JavaScript the module carries. An agent entry
// registers its format and its files. Pure text in and out: nothing here reads
// or writes a file on this computer.
import { JSONC_READER, readJsonc, type Jsonc } from "./jsonc.js";

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

/** An MCP server as every agent's config names it: the program and its arguments, run over stdio. */
export interface McpServerSpec {
  command: string;
  args: readonly string[];
}

export interface Placed {
  text: string;
  /** The file held comments the rewrite does not keep, so the person is told. */
  commentsDropped: boolean;
}

/** One config on the machine as its editor gets it: the kept and dropped server names, and for a format with
 * per-folder servers, the laptop folder whose servers now belong to the machine's home. */
export interface McpGuestScope {
  keep: readonly string[];
  drop: readonly string[];
  project?: { from: string; to: string };
}

export interface McpGuestResult {
  name: string;
  outcome: "written" | "missing" | "dropped";
  /** The kept server's command as the machine will run it. */
  command?: string;
}

/** What the machine's node hands every editor. */
export interface McpGuestLib {
  fs: { readFileSync(file: string, encoding: "utf8"): string; writeFileSync(file: string, text: string): void };
  /** Off, the pass only reads each kept server's command as the machine would run it. */
  write: boolean;
  /** A kept definition's string as the machine reads it; `command` marks the program, a bare name when it sits in a bin directory. */
  rewriteString(s: string, command: boolean): string;
}

/** Edits one config file in place on the machine: kept servers' strings rewritten, dropped ones out, every other
 * key and server kept; reports each kept and dropped name. Throws when the text is not the format. */
export type McpGuestEditor = (lib: McpGuestLib, scope: McpGuestScope, file: string) => McpGuestResult[];

export interface McpFormat {
  /** Every server the text defines, in one shape; text that is not the format defines none. `home` is the folder
   * whose project-scoped servers count as the person's own. */
  read(text: string, home: string): McpServer[];
  /** The file's text with the server called `name` placed, or replaced when it is already there; `text` is
   * undefined when the file does not exist yet. Throws when the text is not the format. */
  place(text: string | undefined, name: string, server: McpServerSpec): Placed;
  /** JavaScript for the machine's node: one expression whose value is an McpGuestEditor, complete in itself. */
  guest: string;
}

export interface McpConfig {
  format: McpFormat;
  /** `~/`-relative, each one of the entry's configPaths; the first that exists is the config. */
  files: readonly string[];
  /** The scopes the file covers, shown on the wizard's group heading; every agent's docs also give a project scope
   * this file does not hold. */
  scope: string;
  /** Where an http server's sign-in lives when the agent keeps it beside its own login, for the row; absent, nothing is said. */
  httpAuth?: string;
}

type GuestFn = (...args: never[]) => unknown;

/** One expression for the machine's node: `body` evaluated with `uses` declared beside it, each function as its own
 * source, so a rule is written once here and runs there. A function listed is a declaration (an arrow has no name
 * of its own there) and may only name its parameters, what it declares, and the functions listed before it. */
function guestSource(uses: readonly GuestFn[], body: string): string {
  const sources = uses.map(String);
  const arrow = sources.find(src => !src.startsWith("function "));
  if (arrow !== undefined) throw new Error(`a guest function is not a declaration: ${arrow.slice(0, 40)}`);
  return `(() => {\n${sources.join("\n")}\nreturn ${body};\n})()`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
function dict(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
}

// --- JSON formats ----------------------------------------------------------------------------------------------

function jsonObject(text: string | undefined): { root: Record<string, unknown>; comments: boolean } {
  if (text === undefined || text.trim() === "") return { root: {}, comments: false };
  let read: Jsonc;
  try {
    read = readJsonc(text);
  } catch {
    throw new Error("the file is not valid JSON; add the server by hand");
  }
  const { value, comments } = read;
  if (!isObject(value)) throw new Error("the file is not a JSON object; add the server by hand");
  return { root: value, comments };
}

/** The servers under `key` of a JSON object, each read by the format's own entry shape. */
function jsonServers(root: Record<string, unknown>, key: string, scope: McpServer["scope"], server: JsonShape["server"]): McpServer[] {
  const table = root[key];
  if (!isObject(table)) return [];
  return Object.entries(table).flatMap(([name, raw]) => {
    const s = server(name, raw, scope);
    return s === undefined ? [] : [s];
  });
}

/** The machine's editor for a JSON file with its servers under `key`, and per-folder servers under
 * `projects.<folder>.<key>` when the scope names a folder. The reader comes in as an argument because the
 * editor's source travels on its own, and a name from another module would not travel with it. */
function jsonEditor(key: string, read: (text: string) => Jsonc): McpGuestEditor {
  return (lib, scope, file) => {
    type Tree = Record<string, unknown>;
    const obj = (v: unknown): Tree | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Tree) : undefined);
    const walk = (v: unknown, command: boolean): unknown => {
      if (typeof v === "string") return lib.rewriteString(v, command);
      if (Array.isArray(v)) return v.map((x, i) => walk(x, command && i === 0));
      const o = obj(v);
      return o === undefined ? v : Object.fromEntries(Object.keys(o).map(k => [k, walk(o[k], k === "command")]));
    };
    const commandOf = (def: unknown): string | undefined => {
      const c = obj(def)?.command;
      return typeof c === "string" ? c : Array.isArray(c) && typeof c[0] === "string" ? c[0] : undefined;
    };
    const before = lib.fs.readFileSync(file, "utf8");
    const root = obj(read(before).value);
    if (root === undefined) throw new Error("the file is not a JSON object");
    const project = scope.project;
    const source = project === undefined ? root : obj(obj(root.projects)?.[project.from]) ?? {};
    const servers = obj(source[key]) ?? {};
    const target = (): Tree => {
      if (project === undefined) return servers;
      const projects = (root.projects = obj(root.projects) ?? {});
      const to = (projects[project.to] = obj(projects[project.to]) ?? {});
      return (to[key] = obj(to[key]) ?? {});
    };
    const moved = project === undefined ? {} : obj(obj(obj(root.projects)?.[project.to])?.[key]) ?? {};
    const results: McpGuestResult[] = [];
    for (const name of scope.keep) {
      const def = servers[name];
      if (def === undefined) {
        results.push(moved[name] !== undefined ? { name, outcome: "written", command: commandOf(moved[name]) } : { name, outcome: "missing" });
        continue;
      }
      const next = walk(def, false);
      if (project !== undefined) delete servers[name];
      target()[name] = next;
      results.push({ name, outcome: "written", command: commandOf(next) });
    }
    for (const name of scope.drop) {
      delete servers[name];
      results.push({ name, outcome: "dropped" });
    }
    if (lib.write && JSON.stringify(read(before).value) !== JSON.stringify(root)) lib.fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`);
    return results;
  };
}

interface JsonShape {
  /** The root key the servers sit under. */
  key: string;
  /** The format's own entry as one server, or nothing when it names neither a command nor a url. */
  server(name: string, raw: unknown, scope: McpServer["scope"]): McpServer | undefined;
  /** The entry the format writes for a placed server. */
  entry(server: McpServerSpec): unknown;
  /** The file also holds per-folder servers under `projects.<folder>.<key>`; the home folder's are read as its own. */
  projects: boolean;
}

function jsonFormat(shape: JsonShape): McpFormat {
  return {
    read: (text, home) => {
      let root: unknown;
      try {
        root = readJsonc(text).value;
      } catch {
        return [];
      }
      if (!isObject(root)) return [];
      const own = jsonServers(root, shape.key, "user", shape.server);
      const project = shape.projects && isObject(root.projects) ? root.projects[home] : undefined;
      return isObject(project) ? [...own, ...jsonServers(project, shape.key, "home", shape.server)] : own;
    },
    place: (text, name, server) => {
      const { root, comments } = jsonObject(text);
      const current = root[shape.key];
      root[shape.key] = { ...(isObject(current) ? current : {}), [name]: shape.entry(server) };
      return { text: `${JSON.stringify(root, null, 2)}\n`, commentsDropped: comments };
    },
    guest: guestSource([...JSONC_READER, jsonEditor], `${jsonEditor.name}(${JSON.stringify(shape.key)}, ${readJsonc.name})`),
  };
}

/** `mcpServers.<name> = { command, args, env, cwd }` or `{ url | httpUrl, headers }`: Claude Code's user file, whose
 * `projects` hold the same shape per folder, and Gemini CLI's settings. */
export const MCP_SERVERS_JSON: McpFormat = jsonFormat({
  key: "mcpServers",
  projects: true,
  server: (name, raw, scope) => {
    if (!isObject(raw)) return undefined;
    const command = str(raw.command);
    const url = str(raw.httpUrl) ?? str(raw.url);
    if (command !== undefined) {
      const cwd = str(raw.cwd);
      return { name, scope, transport: { kind: "stdio", command, args: strs(raw.args), env: dict(raw.env), ...(cwd !== undefined ? { cwd } : {}) }, envRefs: [] };
    }
    if (url !== undefined) return { name, scope, transport: { kind: "http", url, headers: dict(raw.headers) }, envRefs: [] };
    return undefined;
  },
  entry: s => ({ command: s.command, args: [...s.args] }),
});

/** `mcp.<name> = { type: "local", command: [command, ...args], environment }` or `{ type: "remote", url, headers }`:
 * OpenCode's config. */
export const OPENCODE_JSON: McpFormat = jsonFormat({
  key: "mcp",
  projects: false,
  server: (name, raw, scope) => {
    if (!isObject(raw)) return undefined;
    if (raw.type === "remote") {
      const url = str(raw.url);
      return url === undefined ? undefined : { name, scope, transport: { kind: "http", url, headers: dict(raw.headers) }, envRefs: [] };
    }
    const [command, ...args] = strs(raw.command);
    if (command === undefined) return undefined;
    return { name, scope, transport: { kind: "stdio", command, args, env: dict(raw.environment) }, envRefs: [] };
  },
  entry: s => ({ type: "local", command: [s.command, ...s.args], enabled: true }),
});

// --- Codex's TOML ------------------------------------------------------------------------------------------------
// Only the table form Codex documents and `codex mcp add` writes is read or edited, line by line, so comments and
// order survive. The functions the machine's editor calls are written once here and travel as their own source.

/** A line without its trailing comment: `#` outside quotes ends it. */
function uncommentToml(line: string): string {
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

/** `[mcp_servers.<name>]` or `[mcp_servers.<name>.<sub>]`, the name bare or quoted; nothing for any other header. */
function tomlHeader(line: string): { name: string; sub?: string } | undefined {
  const m = /^\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:\.\s*([A-Za-z0-9_-]+)\s*)?\]$/.exec(line);
  if (m === null) return undefined;
  return { name: (m[1] ?? m[2] ?? m[3])!, ...(m[4] !== undefined ? { sub: m[4] } : {}) };
}

/** A basic string with its escapes, or a literal one: group 1 or group 2. */
function tomlStringPattern(): RegExp {
  return /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
}

function tomlEscapes(): Record<string, string> {
  return { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
}

function decodeToml(s: string): string {
  const escapes = tomlEscapes();
  return s.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (m, e: string) => (e[0] === "u" || e[0] === "U" ? String.fromCodePoint(parseInt(e.slice(1), 16)) : (escapes[e] ?? m)));
}

function encodeToml(s: string): string {
  const escapes = tomlEscapes();
  return s.replace(/[\\"\u0000-\u001f\u007f]/g, c => {
    const back = Object.keys(escapes).find(k => escapes[k] === c);
    return back !== undefined ? `\\${back}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/** Every string in the text, decoded. */
function tomlStrings(s: string): string[] {
  return [...s.matchAll(tomlStringPattern())].map(m => (m[1] !== undefined ? decodeToml(m[1]) : m[2]!));
}

/** A string, an array of strings, or an inline table of strings; anything else is left out. */
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

interface CodexTable {
  values: Record<string, unknown>;
  env: Record<string, string>;
  headers: Record<string, string>;
  envHeaders: Record<string, string>;
}

/** Codex's `[mcp_servers.<name>]` tables and their env, http_headers and env_http_headers sub-tables, in file order. */
function readCodex(text: string): McpServer[] {
  const tables = new Map<string, CodexTable>();
  let current: { name: string; sub?: string } | undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = uncommentToml(lines[i]!).trim();
    if (line === "") continue;
    if (line.startsWith("[")) {
      current = tomlHeader(line);
      if (current !== undefined && !tables.has(current.name)) tables.set(current.name, { values: {}, env: {}, headers: {}, envHeaders: {} });
      continue;
    }
    if (current === undefined) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"(.*)"$/, "$1");
    let value = line.slice(eq + 1).trim();
    // A multi-line array closes on a later line.
    while (value.startsWith("[") && !value.endsWith("]") && i + 1 < lines.length) value += uncommentToml(lines[++i]!).trim();
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

// A JSON string is a valid TOML basic string: the same escapes for quote, backslash and control characters.
const tomlString = (s: string): string => JSON.stringify(s);

/** `[mcp_servers.<name>]` with command and args. The table is replaced in place when it is there (up to the next
 * table header), appended after a blank line when it is not; every other line stays as written. */
function placeCodex(text: string | undefined, name: string, server: McpServerSpec): string {
  const header = `[mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name)}]`;
  const table = `${header}\ncommand = ${tomlString(server.command)}\nargs = [${server.args.map(tomlString).join(", ")}]\n`;
  if (text === undefined || text.trim() === "") return table;
  const lines = text.split("\n");
  const start = lines.findIndex(l => l.trim() === header);
  if (start === -1) return `${text.endsWith("\n") ? text : `${text}\n`}\n${table}`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  // Blank lines before the next header stay with the table that follows, so the replaced block keeps one.
  const gap = end < lines.length ? [""] : [];
  return [...lines.slice(0, start), ...table.slice(0, -1).split("\n"), ...gap, ...lines.slice(end)].join("\n");
}

/** The machine's editor: each line belongs to the server whose header came last (its sub-tables included), so a
 * dropped server's lines go and a kept one's strings are rewritten; a token is re-emitted only when its value
 * changed, so escapes the rewrite never touched stay as written. */
function codexEditor(lib: McpGuestLib, scope: McpGuestScope, file: string): McpGuestResult[] {
  const before = lib.fs.readFileSync(file, "utf8");
  const lines = before.split("\n");
  const owner: (string | undefined)[] = [];
  let current: string | undefined;
  for (const raw of lines) {
    const t = uncommentToml(raw).trim();
    if (t.startsWith("[")) current = tomlHeader(t)?.name;
    owner.push(current);
  }
  const rewriteLine = (line: string): string => {
    const code = uncommentToml(line);
    const isCommand = /^\s*command\s*=/.test(code);
    const next = code.replace(tomlStringPattern(), (m: string, basic: string | undefined, literal: string | undefined) => {
      if (literal !== undefined) {
        const value = lib.rewriteString(literal, isCommand);
        return value === literal ? m : `'${value}'`;
      }
      const value = decodeToml(basic!);
      const rewritten = lib.rewriteString(value, isCommand);
      return rewritten === value ? m : `"${encodeToml(rewritten)}"`;
    });
    return next + line.slice(code.length);
  };
  const keep = new Set(scope.keep);
  const drop = new Set(scope.drop);
  const out: string[] = [];
  const outOwner: (string | undefined)[] = [];
  lines.forEach((line, i) => {
    const o = owner[i];
    if (o !== undefined && drop.has(o)) return;
    out.push(o !== undefined && keep.has(o) ? rewriteLine(line) : line);
    outOwner.push(o);
  });
  const results: McpGuestResult[] = [];
  for (const name of scope.keep) {
    if (!owner.includes(name)) {
      results.push({ name, outcome: "missing" });
      continue;
    }
    let command: string | undefined;
    out.forEach((l, i) => {
      const code = uncommentToml(l);
      const m = /^\s*command\s*=\s*/.exec(code);
      if (outOwner[i] === name && m !== null) command = tomlStrings(code.slice(m[0].length))[0];
    });
    results.push({ name, outcome: "written", command });
  }
  for (const name of scope.drop) results.push({ name, outcome: "dropped" });
  const after = out.join("\n");
  if (lib.write && after !== before) lib.fs.writeFileSync(file, after);
  return results;
}

export const CODEX_TOML: McpFormat = {
  read: readCodex,
  place: (text, name, server) => ({ text: placeCodex(text, name, server), commentsDropped: false }),
  guest: guestSource([uncommentToml, tomlHeader, tomlStringPattern, tomlEscapes, decodeToml, encodeToml, tomlStrings, codexEditor], codexEditor.name),
};
