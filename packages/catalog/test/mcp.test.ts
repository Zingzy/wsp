// SPDX-License-Identifier: AGPL-3.0-only
// Each agent's MCP config: the files it reads servers from (among the entry's
// own config paths) and the format's placer, which puts the wsp server in a
// fresh file or beside what the person already has, once, on every run.
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS, MCP_FORMATS, catalogEntry, type McpServerSpec } from "../src/index.js";

const SERVER: McpServerSpec = { command: "/usr/local/bin/node", args: ["/opt/wsp/bin.js", "mcp", "--state", "/Users/me/.wsp/state.json"] };

describe("the catalog's MCP configs", () => {
  it("are registered from the agent entries that have one, each file among the entry's own config paths", () => {
    const withMcp = CATALOG_AGENTS.filter(a => a.mcp !== undefined);
    expect(withMcp.map(a => [a.id, a.mcp!.format])).toEqual([["claude", "claude"], ["codex", "codex"], ["gemini", "gemini"], ["opencode", "opencode"]]);
    for (const a of withMcp) for (const f of a.mcp!.files) expect(a.configPaths, a.id).toContain(f);
    expect(catalogEntry("pi")).toMatchObject({ kind: "agent" });
    expect((catalogEntry("pi") as { mcp?: unknown }).mcp).toBeUndefined();
  });

  it("mcpServers JSON (Claude Code, Gemini CLI): a fresh file holds the server; an existing one keeps its keys and other servers, and a rerun replaces", () => {
    const fresh = MCP_FORMATS.claude.place(undefined, "wsp", SERVER).text;
    expect(JSON.parse(fresh)).toEqual({ mcpServers: { wsp: { command: SERVER.command, args: SERVER.args } } });
    expect(fresh.endsWith("\n")).toBe(true);
    const existing = JSON.stringify({ numStartups: 4, mcpServers: { other: { command: "x", args: [] }, wsp: { command: "old", args: [] } }, projects: { "/a": {} } });
    const placed = JSON.parse(MCP_FORMATS.claude.place(existing, "wsp", SERVER).text) as Record<string, unknown>;
    expect(placed).toEqual({ numStartups: 4, mcpServers: { other: { command: "x", args: [] }, wsp: { command: SERVER.command, args: SERVER.args } }, projects: { "/a": {} } });
    expect(Object.keys(placed)).toEqual(["numStartups", "mcpServers", "projects"]);
    expect(MCP_FORMATS.gemini.place("", "wsp", SERVER).text).toBe(fresh);
    expect(() => MCP_FORMATS.claude.place("{ not json", "wsp", SERVER).text).toThrow("the file is not valid JSON; add the server by hand");
    expect(() => MCP_FORMATS.claude.place("[]", "wsp", SERVER).text).toThrow("the file is not a JSON object; add the server by hand");
  });

  it("OpenCode's JSON: the server is a local mcp entry whose command is one array, enabled", () => {
    const placed = JSON.parse(MCP_FORMATS.opencode.place('{ "$schema": "https://opencode.ai/config.json", "theme": "x" }', "wsp", SERVER).text);
    expect(placed).toEqual({ $schema: "https://opencode.ai/config.json", theme: "x", mcp: { wsp: { type: "local", command: [SERVER.command, ...SERVER.args], enabled: true } } });
  });

  it("a settings file with comments and a trailing comma (OpenCode's jsonc, Gemini CLI's settings) is placed into with its other servers intact; the rewrite is plain JSON", () => {
    const jsonc = '{\n  // servers I use\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    /* memory */ "other": { "type": "local", "command": ["x"], "enabled": true },\n  },\n}\n';
    const { text: placed, commentsDropped } = MCP_FORMATS.opencode.place(jsonc, "wsp", SERVER);
    expect(commentsDropped).toBe(true);
    expect(JSON.parse(placed)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { other: { type: "local", command: ["x"], enabled: true }, wsp: { type: "local", command: [SERVER.command, ...SERVER.args], enabled: true } },
    });
    expect(placed).not.toContain("servers I use");
    const gemini = MCP_FORMATS.gemini.place('{ "theme": "dark", // the look\n "mcpServers": { "docs": { "url": "https://docs.example/mcp" }, }, }', "wsp", SERVER);
    expect(gemini.commentsDropped).toBe(true);
    expect(JSON.parse(gemini.text)).toEqual({ theme: "dark", mcpServers: { docs: { url: "https://docs.example/mcp" }, wsp: { command: SERVER.command, args: SERVER.args } } });
    const url = MCP_FORMATS.opencode.place('{ "mcp": { "ctx": { "type": "remote", "url": "https://ctx.example/*/mcp" } }, }', "wsp", SERVER);
    expect((JSON.parse(url.text) as { mcp: { ctx: { url: string } } }).mcp.ctx.url).toBe("https://ctx.example/*/mcp");
    expect(url.commentsDropped).toBe(false);
  });

  it("Codex's TOML: a fresh file is one table; an existing file gets the table appended; a rerun replaces the table and leaves its neighbours", () => {
    const table = `[mcp_servers.wsp]\ncommand = "/usr/local/bin/node"\nargs = ["/opt/wsp/bin.js", "mcp", "--state", "/Users/me/.wsp/state.json"]\n`;
    expect(MCP_FORMATS.codex.place(undefined, "wsp", SERVER).text).toBe(table);
    const existing = 'model = "gpt-5"\n\n[projects."/Users/me/proj"]\ntrust_level = "trusted"\n';
    const appended = MCP_FORMATS.codex.place(existing, "wsp", SERVER).text;
    expect(appended).toBe(`${existing}\n${table}`);
    const rerun = MCP_FORMATS.codex.place(`${appended}\n[mcp_servers.other]\ncommand = "x"\n`, "wsp", { command: "/new/node", args: ["a"] }).text;
    expect(rerun).toBe(`${existing}\n[mcp_servers.wsp]\ncommand = "/new/node"\nargs = ["a"]\n\n[mcp_servers.other]\ncommand = "x"\n`);
    expect(MCP_FORMATS.codex.place(rerun, "wsp", { command: "/new/node", args: ["a"] }).text).toBe(rerun);
  });

  it("Codex's TOML quotes a path with a quote or a backslash in it as a basic string", () => {
    const placed = MCP_FORMATS.codex.place(undefined, "wsp", { command: 'C:\\node "x".exe', args: [] }).text;
    expect(placed).toContain('command = "C:\\\\node \\"x\\".exe"');
  });
});
