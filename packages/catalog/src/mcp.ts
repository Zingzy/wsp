// SPDX-License-Identifier: AGPL-3.0-only
// How an agent keeps its MCP servers: one module per config format, with the
// three things done to such a file. The collector reads its servers and the
// install helper places one, both on this computer; the import edits the text
// it read off the machine, here, since a machine need carry no node of its own.
// An agent entry registers its format and its files. Pure text in and out:
// nothing here reads or writes a file.
import type { McpServerSpec } from "@wsp/protocol";
import { readJsonc, type Jsonc } from "./jsonc.js";
import type { McpCheck } from "./mcp-check.js";
import type { McpLogin } from "./mcp-login.js";

export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: "http"; url: string; headers: Record<string, string> };

export interface McpServer {
  name: string;
  /** `home`: Claude Code's project scope for the home folder itself, which the machine's home stands in for. */
  scope: "user" | "home";
  transport: McpTransport;
  /** Variables the definition reads from the environment at run time (Codex's bearer_token_env_var, a header's
   * reference in the format's own syntax); names only. */
  envRefs: string[];
  /** The file keeps the definition and switches it off: OpenCode's `enabled: false`, Codex's `enabled = false`. */
  disabled?: true;
}

export interface Placed {
  text: string;
  /** The file held comments the rewrite does not keep, so the person is told. */
  commentsDropped: boolean;
}

/** What a remove came to: the file as it should stand, the text as it was where the file defines none of the
 * names, and whether the rewrite could not keep the comments it held, which is the same loss a merge answers. */
export interface McpRemoved {
  text: string;
  commentsDropped: boolean;
}

/** One config on the machine as its editor gets it: the kept and dropped server names, and for a format with
 * per-folder servers, the laptop folder whose servers now belong to the machine's home. */
export interface McpEditScope {
  keep: readonly string[];
  drop: readonly string[];
  project?: { from: string; to: string };
}

export interface McpEditResult {
  name: string;
  outcome: "written" | "missing" | "dropped";
  /** The kept server's command as the machine will run it. */
  command?: string;
}

/** One config on the machine as a merge gets it: the kept and dropped names as an edit has them, and the names
 * whose entry in the agent's own file is wsp's by the list beside the job, so it may be replaced or taken out.
 * Every other name in that file is the agent's own or the person's and stands. */
export interface McpMergeScope extends McpEditScope {
  replace: readonly string[];
}

export interface McpMergeResult {
  name: string;
  /** `added`: not in the agent's file, written from the copy that travelled; `replaced`: wsp's own entry, now the
   * travelled one; `same`: already the travelled entry; `theirs`: another entry under that name, left as it is;
   * `missing`: not in the copy that travelled; `dropped`: wsp's own entry taken out; `left`: a dropped name that is
   * not wsp's, untouched. */
  outcome: "added" | "replaced" | "same" | "theirs" | "missing" | "dropped" | "left";
  /** The written name's command as the machine will run it. */
  command?: string;
}

/** What a merge came to: the file as it should stand on the machine, the text as it was where nothing moved, and
 * empty where there is no file yet and nothing to put in one. */
export interface McpMerged {
  text: string;
  results: McpMergeResult[];
  /** The agent's own file held comments the rewrite does not keep, so the person is told. */
  commentsDropped: boolean;
}

/** What every editor is handed besides the text. */
export interface McpEditLib {
  /** A kept definition's string as the machine reads it; `command` marks the program, a bare name when it sits in a bin directory. */
  rewriteString(s: string, command: boolean): string;
}

/** What an edit came to: the file as it should stand on the machine, the text unchanged where nothing moved. */
export interface McpEdited {
  text: string;
  results: McpEditResult[];
}

/** Edits one config file's text: kept servers' strings rewritten, dropped ones out, every other key and server
 * kept; reports each kept and dropped name. Throws when the text is not the format. */
export type McpEditor = (lib: McpEditLib, scope: McpEditScope, text: string) => McpEdited;

export interface McpFormat {
  /** Every server the text defines, in one shape; text that is not the format defines none. `home` is the folder
   * whose project-scoped servers count as the person's own. */
  read(text: string, home: string): McpServer[];
  /** The file's text with the server called `name` placed, or replaced when it is already there; `text` is
   * undefined when the file does not exist yet. Throws when the text is not the format. */
  place(text: string | undefined, name: string, server: McpServerSpec): Placed;
  /** The edit the import runs over the text it read off the machine. */
  edit: McpEditor;
  /** The definition one server has in a file of this format, in the one shape it keeps when the agent rewrites the
   * file: a JSON entry with its keys sorted at every depth, a TOML table's lines uncommented and trimmed. Whether a
   * key is wsp's own rests on this, so a field the agent adds to a table wsp wrote makes the entry read as the
   * agent's and never written over again. Nothing when the text names no server called that; `project` is the
   * folder whose own servers the name sits under, for a format that keeps servers per folder. */
  entryOf(text: string, name: string, project?: string): string | undefined;
  /** The agent's own file on the machine with wsp's servers merged into it: each kept name's definition taken from
   * the copy that travelled and put under this format's own key of `own`, every other key of `own` untouched.
   * `own` is undefined when the agent's file is not there yet, and the text is then empty when there was nothing to
   * put in one. Throws when either text is not the format. */
  merge(lib: McpEditLib, scope: McpMergeScope, own: string | undefined, travelled: string): McpMerged;
  /** The agent's own file with the named servers taken out from under this format's own key, every other key,
   * table and line of theirs as it was; `project` is the folder whose own servers the names sit under, for a
   * format that keeps servers per folder. The text stands where it defines none of them, and the comments it
   * held are answered the way a merge answers them. Throws when the text is not the format. */
  remove(text: string, names: readonly string[], project?: string): McpRemoved;
}

export interface McpConfig {
  format: McpFormat;
  /** `~/`-relative, each one of the entry's configPaths; the first that exists is the config. */
  files: readonly string[];
  /** The same agent's servers inside a project, project-relative; the first that exists is the project's. */
  projectFiles?: readonly string[];
  /** The scopes the file covers, shown on the wizard's group heading; every agent's docs also give a project scope
   * this file does not hold. */
  scope: string;
  /** Where an http server's sign-in lives when the agent keeps it beside its own login, for the row; absent, nothing is said. */
  httpAuth?: string;
  /** How the harness answers for one server's sign-in; absent where no harness's words were measured. */
  check?: McpCheck;
  /** How the harness signs one server in. */
  login?: McpLogin;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** Each variable the header values name under the format's reference syntax, first seen first. */
const refsIn = (values: readonly string[], ref: RegExp): string[] => [...new Set(values.flatMap(v => [...v.matchAll(ref)].map(m => (m[1] ?? m[2])!)))];

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

type Tree = Record<string, unknown>;
const tree = (v: unknown): Tree | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Tree) : undefined);

/** Every string of a definition as the machine reads it: the value under `command` and the first word of a command
 * array are the program, everything else a plain string. */
const walkStrings = (lib: McpEditLib, v: unknown, command: boolean): unknown => {
  if (typeof v === "string") return lib.rewriteString(v, command);
  if (Array.isArray(v)) return v.map((x, i) => walkStrings(lib, x, command && i === 0));
  const o = tree(v);
  return o === undefined ? v : Object.fromEntries(Object.keys(o).map(k => [k, walkStrings(lib, o[k], k === "command")]));
};

/** The program a JSON definition names, as a string or as the first word of its command array. */
const jsonCommandOf = (def: unknown): string | undefined => {
  const c = tree(def)?.command;
  return typeof c === "string" ? c : Array.isArray(c) && typeof c[0] === "string" ? c[0] : undefined;
};

/** A JSON value in the one shape it keeps when the agent rewrites the file: every object's keys in sorted order at
 * every depth, so an entry written back with its keys another way round still reads as the same entry. */
function jsonCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonCanonical).join(",")}]`;
  const o = tree(v);
  return o === undefined ? (JSON.stringify(v) ?? "null") : `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${jsonCanonical(o[k])}`).join(",")}}`;
}

/** The merge for a JSON file with its servers under `key`: the agent's own file parsed, wsp's keys put in it, the
 * whole of it written back, and not one other key of theirs read or moved. Per-folder servers go under
 * `projects.<folder>.<key>` as the editor puts them, and the folder the definitions travelled from is not made. */
function jsonMerger(key: string): McpFormat["merge"] {
  return (lib, scope, own, travelled) => {
    const held = own === undefined || own.trim() === "" ? undefined : readJsonc(own);
    const root = tree(held?.value ?? {});
    if (root === undefined) throw new Error("the file is not a JSON object");
    const from = tree(readJsonc(travelled).value);
    if (from === undefined) throw new Error("the copy that travelled is not a JSON object");
    const project = scope.project;
    const source = project === undefined ? from : tree(tree(from.projects)?.[project.from]) ?? {};
    const arrived = tree(source[key]) ?? {};
    /** The servers standing in the agent's own file under this scope's key, read without making the table. */
    const standing = (): Tree => (project === undefined ? tree(root[key]) ?? {} : tree(tree(tree(root.projects)?.[project.to])?.[key]) ?? {});
    /** The same table, made where the file has none, for a name that is about to be written. */
    const target = (): Tree => {
      if (project === undefined) return (root[key] = tree(root[key]) ?? {});
      const projects = (root.projects = tree(root.projects) ?? {});
      const to = (projects[project.to] = tree(projects[project.to]) ?? {});
      return (to[key] = tree(to[key]) ?? {});
    };
    const replace = new Set(scope.replace);
    const results: McpMergeResult[] = [];
    let wrote = false;
    for (const name of scope.keep) {
      const def = arrived[name];
      if (def === undefined) {
        results.push({ name, outcome: "missing" });
        continue;
      }
      const next = walkStrings(lib, def, false);
      const said = (outcome: McpMergeResult["outcome"]): void => void results.push({ name, outcome, command: jsonCommandOf(next) });
      const here = standing()[name];
      if (here !== undefined && jsonCanonical(here) === jsonCanonical(next)) said("same");
      else if (here !== undefined && !replace.has(name)) said("theirs");
      else {
        target()[name] = next;
        wrote = true;
        said(here === undefined ? "added" : "replaced");
      }
    }
    for (const name of scope.drop) {
      if (standing()[name] === undefined || !replace.has(name)) {
        results.push({ name, outcome: "left" });
        continue;
      }
      delete target()[name];
      wrote = true;
      results.push({ name, outcome: "dropped" });
    }
    return { text: wrote ? `${JSON.stringify(root, null, 2)}\n` : own ?? "", results, commentsDropped: wrote && held?.comments === true };
  };
}

/** The remove for a JSON file with its servers under `key`: the named keys taken out of the table they sit in,
 * written back as the merge writes the file, and every other key of theirs where it was. The table itself stays,
 * empty or not: it is the agent's own key, not wsp's to take. */
function jsonRemover(key: string): McpFormat["remove"] {
  return (text, names, project) => {
    const held = readJsonc(text);
    const root = tree(held.value);
    if (root === undefined) throw new Error("the file is not a JSON object");
    const table = project === undefined ? tree(root[key]) : tree(tree(tree(root.projects)?.[project])?.[key]);
    if (table === undefined) return { text, commentsDropped: false };
    let took = false;
    for (const name of names) {
      if (table[name] === undefined) continue;
      delete table[name];
      took = true;
    }
    return took ? { text: `${JSON.stringify(root, null, 2)}\n`, commentsDropped: held.comments } : { text, commentsDropped: false };
  };
}

/** The editor for a JSON file with its servers under `key`, and per-folder servers under
 * `projects.<folder>.<key>` when the scope names a folder. */
function jsonEditor(key: string): McpEditor {
  return (lib, scope, before) => {
    const root = tree(readJsonc(before).value);
    if (root === undefined) throw new Error("the file is not a JSON object");
    const project = scope.project;
    const source = project === undefined ? root : tree(tree(root.projects)?.[project.from]) ?? {};
    const servers = tree(source[key]) ?? {};
    const target = (): Tree => {
      if (project === undefined) return servers;
      const projects = (root.projects = tree(root.projects) ?? {});
      const to = (projects[project.to] = tree(projects[project.to]) ?? {});
      return (to[key] = tree(to[key]) ?? {});
    };
    const moved = project === undefined ? {} : tree(tree(tree(root.projects)?.[project.to])?.[key]) ?? {};
    const results: McpEditResult[] = [];
    for (const name of scope.keep) {
      const def = servers[name];
      if (def === undefined) {
        results.push(moved[name] !== undefined ? { name, outcome: "written", command: jsonCommandOf(moved[name]) } : { name, outcome: "missing" });
        continue;
      }
      const next = walkStrings(lib, def, false);
      if (project !== undefined) delete servers[name];
      target()[name] = next;
      results.push({ name, outcome: "written", command: jsonCommandOf(next) });
    }
    for (const name of scope.drop) {
      delete servers[name];
      results.push({ name, outcome: "dropped" });
    }
    // The text stands byte for byte where nothing moved: a rewrite of its own would drop comments and reindent it.
    const changed = JSON.stringify(readJsonc(before).value) !== JSON.stringify(root);
    return { text: changed ? `${JSON.stringify(root, null, 2)}\n` : before, results };
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
    edit: jsonEditor(shape.key),
    entryOf: (text, name, project) => {
      let held: unknown;
      try {
        held = readJsonc(text).value;
      } catch {
        return undefined;
      }
      const root = tree(held);
      const source = root === undefined ? undefined : project === undefined ? root : tree(tree(root.projects)?.[project]);
      const def = source === undefined ? undefined : tree(source[shape.key])?.[name];
      return def === undefined ? undefined : jsonCanonical(def);
    },
    merge: jsonMerger(shape.key),
    remove: jsonRemover(shape.key),
  };
}

/** `mcpServers.<name> = { command, args, env, cwd }` or `{ url | httpUrl, headers }`, whose url and headers take
 * `ref`'s variables from the environment. */
const mcpServersJson = (ref: RegExp): McpFormat =>
  jsonFormat({
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
      if (url !== undefined) {
        const headers = dict(raw.headers);
        return { name, scope, transport: { kind: "http", url, headers }, envRefs: refsIn([url, ...Object.values(headers)], ref) };
      }
      return undefined;
    },
    entry: s => ({ command: s.command, args: [...s.args] }),
  });

/** Claude Code's user file, whose `projects` hold the same shape per folder: `${X}` and `${X:-default}`. */
export const MCP_SERVERS_JSON: McpFormat = mcpServersJson(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g);

/** Gemini CLI's settings, which also expand a bare `$X`. */
export const GEMINI_SETTINGS_JSON: McpFormat = mcpServersJson(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g);

/** `mcp.<name> = { type: "local", command: [command, ...args], environment }` or `{ type: "remote", url, headers }`:
 * OpenCode's config. */
export const OPENCODE_JSON: McpFormat = jsonFormat({
  key: "mcp",
  projects: false,
  server: (name, raw, scope) => {
    if (!isObject(raw)) return undefined;
    const off = raw.enabled === false ? { disabled: true as const } : {};
    if (raw.type === "remote") {
      const url = str(raw.url);
      const headers = dict(raw.headers);
      return url === undefined ? undefined : { name, scope, transport: { kind: "http", url, headers }, envRefs: refsIn(Object.values(headers), /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g), ...off };
    }
    const [command, ...args] = strs(raw.command);
    if (command === undefined) return undefined;
    return { name, scope, transport: { kind: "stdio", command, args, env: dict(raw.environment) }, envRefs: [], ...off };
  },
  entry: s => ({ type: "local", command: [s.command, ...s.args], enabled: true }),
});

// --- Codex's TOML ------------------------------------------------------------------------------------------------
// Only the table form Codex documents and `codex mcp add` writes is read or edited, line by line, so comments and
// order survive. The functions the machine's editor calls are written once here and travel as their own source, so
// each one may only name declarations of this module: an import would reach for a binding the machine never got.

/** A line without its trailing comment: `#` outside quotes ends it. */
export function uncommentToml(line: string): string {
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
export function tomlStrings(s: string): string[] {
  return [...s.matchAll(tomlStringPattern())].map(m => (m[1] !== undefined ? decodeToml(m[1]) : m[2]!));
}

/** Whether a value read so far is an array that closes on a later line. */
export function tomlOpenArray(value: string): boolean {
  return value.startsWith("[") && !value.endsWith("]");
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
  disabled?: true;
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
    while (tomlOpenArray(value) && i + 1 < lines.length) value += uncommentToml(lines[++i]!).trim();
    if (current.sub === undefined && key === "enabled" && value === "false") tables.get(current.name)!.disabled = true;
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
    const off = t.disabled === true ? { disabled: true as const } : {};
    if (command !== undefined) {
      out.push({ name, scope: "user", transport: { kind: "stdio", command, args: strs(t.values.args), env: { ...dict(t.values.env), ...t.env } }, envRefs, ...off });
    } else if (url !== undefined) {
      out.push({ name, scope: "user", transport: { kind: "http", url, headers: { ...dict(t.values.http_headers), ...t.headers } }, envRefs, ...off });
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

/** A line with every string on it put through `to`, decoded and re-encoded only where the value changed, so escapes
 * the rewrite never touched stay as written and the trailing comment is left alone. */
export function rewriteTomlLine(line: string, to: (value: string) => string): string {
  const code = uncommentToml(line);
  const next = code.replace(tomlStringPattern(), (m: string, basic: string | undefined, literal: string | undefined) => {
    if (literal !== undefined) {
      const value = to(literal);
      return value === literal ? m : `'${value}'`;
    }
    const value = decodeToml(basic!);
    const rewritten = to(value);
    return rewritten === value ? m : `"${encodeToml(rewritten)}"`;
  });
  return next + line.slice(code.length);
}

/** Which server each line of the text belongs to: the name of the last `[mcp_servers.<name>]` header, that table's
 * sub-tables and the blank lines under them included; nothing for a line before any of them or under another
 * table. */
function codexOwners(lines: readonly string[]): (string | undefined)[] {
  const owner: (string | undefined)[] = [];
  let current: string | undefined;
  for (const raw of lines) {
    const t = uncommentToml(raw).trim();
    if (t.startsWith("[")) current = tomlHeader(t)?.name;
    owner.push(current);
  }
  return owner;
}

/** Where one server's tables sit in the text, in file order. `trim` leaves the blank lines at their end out, which
 * is what keeps the gap in front of whatever follows when the block is written over. */
function codexBlock(lines: readonly string[], name: string, trim: boolean): number[] {
  const owner = codexOwners(lines);
  const at = lines.flatMap((_, i) => (owner[i] === name ? [i] : []));
  if (trim) while (at.length > 0 && lines[at[at.length - 1]!]!.trim() === "") at.pop();
  return at;
}

/** One server's tables in the one shape they keep when Codex writes the file again: every line without its comment
 * and its spacing, the blank ones left out. */
const codexEntry = (lines: readonly string[]): string =>
  lines
    .map(l => uncommentToml(l).trim())
    .filter(l => l !== "")
    .join("\n");

/** The command one server's tables name, as the machine will run it. */
function codexCommand(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const code = uncommentToml(line);
    const m = /^\s*command\s*=\s*/.exec(code);
    if (m !== null) return tomlStrings(code.slice(m[0].length))[0];
  }
  return undefined;
}

/** A kept server's line with every string on it as the machine reads it. */
const codexRewrite = (lib: McpEditLib, line: string): string =>
  rewriteTomlLine(line, value => lib.rewriteString(value, /^\s*command\s*=/.test(uncommentToml(line))));

/** The editor: each line belongs to the server whose header came last (its sub-tables included), so a dropped
 * server's lines go and a kept one's strings are rewritten. */
function codexEditor(lib: McpEditLib, scope: McpEditScope, before: string): McpEdited {
  const lines = before.split("\n");
  const owner = codexOwners(lines);
  const keep = new Set(scope.keep);
  const drop = new Set(scope.drop);
  const out: string[] = [];
  const outOwner: (string | undefined)[] = [];
  lines.forEach((line, i) => {
    const o = owner[i];
    if (o !== undefined && drop.has(o)) return;
    out.push(o !== undefined && keep.has(o) ? codexRewrite(lib, line) : line);
    outOwner.push(o);
  });
  const results: McpEditResult[] = [];
  for (const name of scope.keep) {
    if (!owner.includes(name)) {
      results.push({ name, outcome: "missing" });
      continue;
    }
    results.push({ name, outcome: "written", command: codexCommand(out.filter((_, i) => outOwner[i] === name)) });
  }
  for (const name of scope.drop) results.push({ name, outcome: "dropped" });
  return { text: out.join("\n"), results };
}

/** The merge: wsp's tables spliced into the file Codex keeps for itself. A name it has no table for is appended
 * after a blank line as `place` appends one; a name whose table is wsp's own is written over in place; every other
 * line of theirs, the trust tables and the hooks state included, stays byte for byte. */
function codexMerge(lib: McpEditLib, scope: McpMergeScope, own: string | undefined, travelled: string): McpMerged {
  const from = travelled.split("\n");
  const replace = new Set(scope.replace);
  let lines = own === undefined ? [] : own.split("\n");
  const results: McpMergeResult[] = [];
  let wrote = false;
  const append = (block: readonly string[]): void => {
    const kept = [...lines];
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
    lines = kept.length === 0 ? [...block, ""] : [...kept, "", ...block, ""];
  };
  /** The block in place of the lines it stands on, which for an empty block is those lines taken out. */
  const over = (at: readonly number[], block: readonly string[]): void => {
    lines = lines.flatMap((line, i) => (i === at[0] ? block : at.includes(i) ? [] : [line]));
  };
  for (const name of scope.keep) {
    const at = codexBlock(from, name, true);
    if (at.length === 0) {
      results.push({ name, outcome: "missing" });
      continue;
    }
    const block = at.map(i => codexRewrite(lib, from[i]!));
    const said = (outcome: McpMergeResult["outcome"]): void => void results.push({ name, outcome, command: codexCommand(block) });
    const here = codexBlock(lines, name, true);
    if (here.length === 0) {
      append(block);
      wrote = true;
      said("added");
    } else if (codexEntry(here.map(i => lines[i]!)) === codexEntry(block)) said("same");
    else if (!replace.has(name)) said("theirs");
    else {
      over(here, block);
      wrote = true;
      said("replaced");
    }
  }
  for (const name of scope.drop) {
    const here = codexBlock(lines, name, false);
    if (here.length === 0 || !replace.has(name)) {
      results.push({ name, outcome: "left" });
      continue;
    }
    over(here, []);
    wrote = true;
    results.push({ name, outcome: "dropped" });
  }
  return { text: wrote ? lines.join("\n") : own ?? "", results, commentsDropped: false };
}

/** The remove: each named server's tables go with their sub-tables and the blank lines under them, the way a
 * dropped name goes in the merge, and every other line of the file, the trust tables and the hooks state
 * included, stays byte for byte. */
function removeCodex(text: string, names: readonly string[]): McpRemoved {
  let lines = text.split("\n");
  let took = false;
  for (const name of names) {
    const at = new Set(codexBlock(lines, name, false));
    if (at.size === 0) continue;
    lines = lines.filter((_, i) => !at.has(i));
    took = true;
  }
  return { text: took ? lines.join("\n") : text, commentsDropped: false };
}

export const CODEX_TOML: McpFormat = {
  read: readCodex,
  place: (text, name, server) => ({ text: placeCodex(text, name, server), commentsDropped: false }),
  edit: codexEditor,
  entryOf: (text, name) => {
    const lines = text.split("\n");
    const at = codexBlock(lines, name, true);
    return at.length === 0 ? undefined : codexEntry(at.map(i => lines[i]!));
  },
  merge: codexMerge,
  remove: removeCodex,
};
