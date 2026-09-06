// SPDX-License-Identifier: AGPL-3.0-only
// How an agent on this computer keeps its MCP servers: the user-wide config
// file it reads them from, per its own docs, and the file's own way of naming
// one. One placer per config format; an agent entry registers its format and
// its files. Pure text in and out: nothing here reads or writes a file.
import { readJsonc, type Jsonc } from "./jsonc.js";

export type McpFormat = "claude" | "codex" | "gemini" | "opencode";

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

export interface McpPlacer {
  /** The file's text with the server called `name` placed, or replaced when it is already there; `text` is
   * undefined when the file does not exist yet. Throws when the text is not the format. */
  place(text: string | undefined, name: string, server: McpServerSpec): Placed;
}

export interface McpConfig extends McpPlacer {
  format: McpFormat;
  /** `~/`-relative, each one of the entry's configPaths; the first that exists is the config. */
  files: readonly string[];
  /** The scopes the file covers, shown on the wizard's group heading; every agent's docs also give a project scope
   * this file does not hold. */
  scope: string;
}

function jsonObject(text: string | undefined): { root: Record<string, unknown>; comments: boolean } {
  if (text === undefined || text.trim() === "") return { root: {}, comments: false };
  let read: Jsonc;
  try {
    read = readJsonc(text);
  } catch {
    throw new Error("the file is not valid JSON; add the server by hand");
  }
  const { value, comments } = read;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the file is not a JSON object; add the server by hand");
  return { root: value as Record<string, unknown>, comments };
}

/** A JSON file with the servers under one key, each an object of the format's own shape. */
function jsonServers(key: string, entry: (server: McpServerSpec) => unknown): McpPlacer {
  return {
    place: (text, name, server) => {
      const { root, comments } = jsonObject(text);
      const servers = root[key];
      const table = typeof servers === "object" && servers !== null && !Array.isArray(servers) ? (servers as Record<string, unknown>) : {};
      root[key] = { ...table, [name]: entry(server) };
      return { text: `${JSON.stringify(root, null, 2)}\n`, commentsDropped: comments };
    },
  };
}

/** `mcpServers.<name> = { command, args }`: Claude Code's user file and Gemini CLI's settings. */
const MCP_SERVERS_JSON = jsonServers("mcpServers", s => ({ command: s.command, args: [...s.args] }));

/** `mcp.<name> = { type: "local", command: [command, ...args], enabled: true }`: OpenCode's config. */
const OPENCODE_JSON = jsonServers("mcp", s => ({ type: "local", command: [s.command, ...s.args], enabled: true }));

// A JSON string is a valid TOML basic string: the same escapes for quote, backslash and control characters.
const tomlString = (s: string): string => JSON.stringify(s);

/** `[mcp_servers.<name>]` with command and args: Codex's config.toml. The table is replaced in place when it is
 * there (up to the next table header), appended after a blank line when it is not; every other line stays as written. */
const CODEX_TOML: McpPlacer = {
  place: (text, name, server) => ({ text: codexToml(text, name, server), commentsDropped: false }),
};

function codexToml(text: string | undefined, name: string, server: McpServerSpec): string {
  const table = `[mcp_servers.${name}]\ncommand = ${tomlString(server.command)}\nargs = [${server.args.map(tomlString).join(", ")}]\n`;
  if (text === undefined || text.trim() === "") return table;
  const lines = text.split("\n");
  const start = lines.findIndex(l => l.trim() === `[mcp_servers.${name}]`);
  if (start === -1) return `${text.endsWith("\n") ? text : `${text}\n`}\n${table}`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  // Blank lines before the next header stay with the table that follows, so the replaced block keeps one.
  const gap = end < lines.length ? [""] : [];
  return [...lines.slice(0, start), ...table.slice(0, -1).split("\n"), ...gap, ...lines.slice(end)].join("\n");
}

export const MCP_FORMATS: Readonly<Record<McpFormat, McpPlacer>> = {
  claude: MCP_SERVERS_JSON,
  codex: CODEX_TOML,
  gemini: MCP_SERVERS_JSON,
  opencode: OPENCODE_JSON,
};

/** An agent entry's MCP config: its format's placer with the files and scope the entry names. */
export function mcpConfig(format: McpFormat, files: readonly string[], scope: string): McpConfig {
  return { format, files, scope, place: MCP_FORMATS[format].place };
}
