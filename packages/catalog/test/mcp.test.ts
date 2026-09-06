// SPDX-License-Identifier: AGPL-3.0-only
// Each agent's MCP config: the files it reads servers from (among the entry's
// own config paths) and its format module, which reads the servers a file
// defines, places the wsp server in a fresh file or beside what the person
// already has, once, on every run, and carries the editor the machine runs.
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS, CODEX_TOML, MCP_AGENTS, MCP_SERVERS_JSON, OPENCODE_JSON, catalogEntry, type McpFormat, type McpServer, type McpServerSpec } from "../src/index.js";

const HOME = "/Users/dev";
const SERVER: McpServerSpec = { command: "/usr/local/bin/node", args: ["/opt/wsp/bin.js", "mcp", "--state", "/Users/me/.wsp/state.json"] };

describe("the catalog's MCP configs", () => {
  it("are registered from the agent entries that have one, each naming its format module and files among the entry's own config paths", () => {
    expect(MCP_AGENTS.map(a => a.id)).toEqual(["claude", "codex", "gemini", "opencode"]);
    expect(MCP_AGENTS.map(a => a.mcp.format)).toEqual([MCP_SERVERS_JSON, CODEX_TOML, MCP_SERVERS_JSON, OPENCODE_JSON]);
    for (const a of MCP_AGENTS) for (const f of a.mcp.files) expect(a.configPaths, a.id).toContain(f);
    expect(CATALOG_AGENTS.filter(a => a.mcp !== undefined)).toEqual(MCP_AGENTS);
    expect(catalogEntry("pi")).toMatchObject({ kind: "agent" });
    expect((catalogEntry("pi") as { mcp?: unknown }).mcp).toBeUndefined();
  });

  it("every module's guest editor is one JavaScript expression that stands alone: it evaluates to a function with nothing else in scope", () => {
    for (const format of new Set<McpFormat>(MCP_AGENTS.map(a => a.mcp.format))) {
      const editor: unknown = new Function(`return ${format.guest}`)();
      expect(typeof editor).toBe("function");
    }
  });
});

describe("read", () => {
  it("mcpServers JSON: command or url entries at the root are user scope, the home folder's project entry is home scope, and entries that name neither are left out", () => {
    const text = JSON.stringify({
      mcpServers: { a: { command: "x" }, b: { url: "https://b" }, c: { type: "sse", url: "https://c" }, d: {} },
      projects: { [HOME]: { mcpServers: { z: { type: "stdio", command: "npx", args: ["mcp-remote", "https://z"] } } }, [`${HOME}/code`]: { mcpServers: { other: { command: "o" } } } },
    });
    expect(MCP_SERVERS_JSON.read(text, HOME)).toEqual<McpServer[]>([
      { name: "a", scope: "user", transport: { kind: "stdio", command: "x", args: [], env: {} }, envRefs: [] },
      { name: "b", scope: "user", transport: { kind: "http", url: "https://b", headers: {} }, envRefs: [] },
      { name: "c", scope: "user", transport: { kind: "http", url: "https://c", headers: {} }, envRefs: [] },
      { name: "z", scope: "home", transport: { kind: "stdio", command: "npx", args: ["mcp-remote", "https://z"], env: {} }, envRefs: [] },
    ]);
    const gemini = '{\n  // my servers\n  "mcpServers": { "docs": { "httpUrl": "https://docs.example/mcp", "headers": { "Authorization": "Bearer abcdef" } }, },\n}\n';
    expect(MCP_SERVERS_JSON.read(gemini, HOME)).toEqual<McpServer[]>([{ name: "docs", scope: "user", transport: { kind: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer abcdef" } }, envRefs: [] }]);
    expect(MCP_SERVERS_JSON.read("nope", HOME)).toEqual([]);
    expect(MCP_SERVERS_JSON.read("[]", HOME)).toEqual([]);
  });

  it("OpenCode's JSON: local entries carry the command as one array with their environment, remote ones a url; an empty command is no server", () => {
    const text = '{ "mcp": { "memory": { "type": "local", "command": ["/Users/dev/.local/bin/mem", "--v"], "environment": { "MEM_KEY": "k" }, "enabled": true }, "ctx": { "type": "remote", "url": "https://ctx.example/mcp" }, "none": { "type": "local", "command": [] } } }';
    expect(OPENCODE_JSON.read(text, HOME)).toEqual<McpServer[]>([
      { name: "memory", scope: "user", transport: { kind: "stdio", command: "/Users/dev/.local/bin/mem", args: ["--v"], env: { MEM_KEY: "k" } }, envRefs: [] },
      { name: "ctx", scope: "user", transport: { kind: "http", url: "https://ctx.example/mcp", headers: {} }, envRefs: [] },
    ]);
  });

  it("Codex's TOML: mcp_servers tables with their env, header and bearer sub-keys, quoted names, multi-line arrays and inline tables, in file order", () => {
    const toml = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.grafana]",
      'command = "/opt/homebrew/bin/uvx"',
      'args = ["mcp-grafana", "a\\tb\\u00e9"]',
      "",
      "[mcp_servers.grafana.env]",
      'GRAFANA_SERVICE_ACCOUNT_TOKEN = "glsa_abcdefghij"',
      'GRAFANA_URL = "https://g.example" # keep',
      "",
      "# a remote one",
      "[mcp_servers.sentry]",
      'url = "https://mcp.sentry.dev/mcp?x=1"',
      'bearer_token_env_var = "SENTRY_TOKEN"',
      "",
      "[mcp_servers.sentry.env_http_headers]",
      'X-Org = "SENTRY_ORG"',
      "",
      '[mcp_servers."my server"]',
      "command = 'node'",
      "args = [",
      '  "/Applications/Tool.app/Contents/mcp.js",',
      "]",
      'env = { A_KEY = "1234" }',
      "",
      "[[hooks.SessionStart]]",
      'matcher = "x"',
    ].join("\n");
    expect(CODEX_TOML.read(toml, HOME)).toEqual<McpServer[]>([
      { name: "grafana", scope: "user", transport: { kind: "stdio", command: "/opt/homebrew/bin/uvx", args: ["mcp-grafana", "a\tbé"], env: { GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa_abcdefghij", GRAFANA_URL: "https://g.example" } }, envRefs: [] },
      { name: "sentry", scope: "user", transport: { kind: "http", url: "https://mcp.sentry.dev/mcp?x=1", headers: {} }, envRefs: ["SENTRY_TOKEN", "SENTRY_ORG"] },
      { name: "my server", scope: "user", transport: { kind: "stdio", command: "node", args: ["/Applications/Tool.app/Contents/mcp.js"], env: { A_KEY: "1234" } }, envRefs: [] },
    ]);
    expect(CODEX_TOML.read('model = "x"\n', HOME)).toEqual([]);
  });
});

describe("place", () => {
  it("mcpServers JSON (Claude Code, Gemini CLI): a fresh file holds the server; an existing one keeps its keys and other servers, and a rerun replaces", () => {
    const fresh = MCP_SERVERS_JSON.place(undefined, "wsp", SERVER).text;
    expect(JSON.parse(fresh)).toEqual({ mcpServers: { wsp: { command: SERVER.command, args: SERVER.args } } });
    expect(fresh.endsWith("\n")).toBe(true);
    const existing = JSON.stringify({ numStartups: 4, mcpServers: { other: { command: "x", args: [] }, wsp: { command: "old", args: [] } }, projects: { "/a": {} } });
    const placed = JSON.parse(MCP_SERVERS_JSON.place(existing, "wsp", SERVER).text) as Record<string, unknown>;
    expect(placed).toEqual({ numStartups: 4, mcpServers: { other: { command: "x", args: [] }, wsp: { command: SERVER.command, args: SERVER.args } }, projects: { "/a": {} } });
    expect(Object.keys(placed)).toEqual(["numStartups", "mcpServers", "projects"]);
    expect(MCP_SERVERS_JSON.place("", "wsp", SERVER).text).toBe(fresh);
    expect(() => MCP_SERVERS_JSON.place("{ not json", "wsp", SERVER).text).toThrow("the file is not valid JSON; add the server by hand");
    expect(() => MCP_SERVERS_JSON.place("[]", "wsp", SERVER).text).toThrow("the file is not a JSON object; add the server by hand");
  });

  it("OpenCode's JSON: the server is a local mcp entry whose command is one array, enabled", () => {
    const placed = JSON.parse(OPENCODE_JSON.place('{ "$schema": "https://opencode.ai/config.json", "theme": "x" }', "wsp", SERVER).text);
    expect(placed).toEqual({ $schema: "https://opencode.ai/config.json", theme: "x", mcp: { wsp: { type: "local", command: [SERVER.command, ...SERVER.args], enabled: true } } });
  });

  it("a settings file with comments and a trailing comma (OpenCode's jsonc, Gemini CLI's settings) is placed into with its other servers intact; the rewrite is plain JSON", () => {
    const jsonc = '{\n  // servers I use\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    /* memory */ "other": { "type": "local", "command": ["x"], "enabled": true },\n  },\n}\n';
    const { text: placed, commentsDropped } = OPENCODE_JSON.place(jsonc, "wsp", SERVER);
    expect(commentsDropped).toBe(true);
    expect(JSON.parse(placed)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { other: { type: "local", command: ["x"], enabled: true }, wsp: { type: "local", command: [SERVER.command, ...SERVER.args], enabled: true } },
    });
    expect(placed).not.toContain("servers I use");
    const gemini = MCP_SERVERS_JSON.place('{ "theme": "dark", // the look\n "mcpServers": { "docs": { "url": "https://docs.example/mcp" }, }, }', "wsp", SERVER);
    expect(gemini.commentsDropped).toBe(true);
    expect(JSON.parse(gemini.text)).toEqual({ theme: "dark", mcpServers: { docs: { url: "https://docs.example/mcp" }, wsp: { command: SERVER.command, args: SERVER.args } } });
    const url = OPENCODE_JSON.place('{ "mcp": { "ctx": { "type": "remote", "url": "https://ctx.example/*/mcp" } }, }', "wsp", SERVER);
    expect((JSON.parse(url.text) as { mcp: { ctx: { url: string } } }).mcp.ctx.url).toBe("https://ctx.example/*/mcp");
    expect(url.commentsDropped).toBe(false);
  });

  it("Codex's TOML: a fresh file is one table; an existing file gets the table appended; a rerun replaces the table and leaves its neighbours", () => {
    const table = `[mcp_servers.wsp]\ncommand = "/usr/local/bin/node"\nargs = ["/opt/wsp/bin.js", "mcp", "--state", "/Users/me/.wsp/state.json"]\n`;
    expect(CODEX_TOML.place(undefined, "wsp", SERVER).text).toBe(table);
    const existing = 'model = "gpt-5"\n\n[projects."/Users/me/proj"]\ntrust_level = "trusted"\n';
    const appended = CODEX_TOML.place(existing, "wsp", SERVER).text;
    expect(appended).toBe(`${existing}\n${table}`);
    const rerun = CODEX_TOML.place(`${appended}\n[mcp_servers.other]\ncommand = "x"\n`, "wsp", { command: "/new/node", args: ["a"] }).text;
    expect(rerun).toBe(`${existing}\n[mcp_servers.wsp]\ncommand = "/new/node"\nargs = ["a"]\n\n[mcp_servers.other]\ncommand = "x"\n`);
    expect(CODEX_TOML.place(rerun, "wsp", { command: "/new/node", args: ["a"] }).text).toBe(rerun);
  });

  it("Codex's TOML quotes a path with a quote or a backslash in it as a basic string", () => {
    const placed = CODEX_TOML.place(undefined, "wsp", { command: 'C:\\node "x".exe', args: [] }).text;
    expect(placed).toContain('command = "C:\\\\node \\"x\\".exe"');
  });
});
