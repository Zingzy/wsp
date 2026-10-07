// SPDX-License-Identifier: AGPL-3.0-only
// The vault's values for a turn's own MCP servers on a computer the person
// owns, as Claude Code's --mcp-config file and Codex's thread start take them:
// filled in place for that launch, every key the person set kept.
import { describe, expect, it } from "vitest";
import { claudeLaunchServers, codexLaunchConfig, launchMisses } from "../src/mcp-launch.js";
import { CODEX_TOML, MCP_SERVERS_JSON, OPENCODE_JSON } from "../src/mcp.js";

const values = { LINEAR_TOKEN: "lin_TESTONLY", GH_TOKEN: "ghp_TESTONLY", NOTION_TOKEN: "ntn_TESTONLY" };

describe("a Claude Code launch's servers", () => {
  const user = JSON.stringify({
    mcpServers: {
      tracker: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_TOKEN}" }, oauth: { clientId: "abc", callbackPort: 8080 } },
      gh: { command: "gh-mcp", args: ["--token=${GH_TOKEN:-}"], env: { GH_TOKEN: "${GH_TOKEN:-none}", LOG: "${LOG:-info}", HOME_AT: "${HOME}/x" }, timeout: 60000 },
      mine: { command: "mine-mcp", args: [], env: { OTHER: "${NOT_HELD}" } },
      off: { command: "off-mcp", env: { T: "${GH_TOKEN}" } },
    },
    projects: {
      "/root": { mcpServers: { homeonly: { command: "h", env: { N: "${NOTION_TOKEN}" } } } },
      "/root/spoo-ts": { disabledMcpServers: ["off"], mcpServers: { local: { command: "l", env: { N: "${NOTION_TOKEN}" } } } },
    },
  });

  it("is each server that reads a held value, whole, the value in place and every other key and reference as written", () => {
    const got = claudeLaunchServers({ user, folder: "/root/spoo-ts" }, values);
    expect(Object.keys(got).sort()).toEqual(["gh", "local", "tracker"]);
    expect(got["tracker"]).toEqual({ type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_TESTONLY" }, oauth: { clientId: "abc", callbackPort: 8080 } });
    // A reference with a default is filled like a plain one; one the vault does not hold is left for the agent.
    expect(got["gh"]).toEqual({ command: "gh-mcp", args: ["--token=ghp_TESTONLY"], env: { GH_TOKEN: "ghp_TESTONLY", LOG: "${LOG:-info}", HOME_AT: "${HOME}/x" }, timeout: 60000 });
  });

  it("fills the home folder's own servers for a turn there, and the project's .mcp.json beneath the folder's own", () => {
    expect(Object.keys(claudeLaunchServers({ user, folder: "/root" }, values)).sort()).toEqual(["gh", "homeonly", "off", "tracker"]);
    const project = JSON.stringify({ mcpServers: { shared: { command: "s", env: { T: "${LINEAR_TOKEN}" } }, local: { command: "from-project", env: { N: "${NOTION_TOKEN}" } } } });
    const got = claudeLaunchServers({ user, project, folder: "/root/spoo-ts" }, values);
    expect(got["shared"]).toEqual({ command: "s", env: { T: "lin_TESTONLY" } });
    expect(got["local"]).toEqual({ command: "l", env: { N: "ntn_TESTONLY" } });
  });

  it("is nothing with no value held or no file", () => {
    expect(claudeLaunchServers({ user, folder: "/root" }, {})).toEqual({});
    expect(claudeLaunchServers({ folder: "/root" }, values)).toEqual({});
    expect(claudeLaunchServers({ user: "not json", folder: "/root" }, values)).toEqual({});
  });
});

describe("a Codex thread start's config", () => {
  const user = [
    'model = "gpt"',
    "[mcp_servers.notion]",
    'command = "npx"',
    'args = ["notion-mcp"]',
    'env_vars = ["NOTION_TOKEN", "HTTPS_PROXY"]',
    'disabled_tools = ["delete_page"]',
    "startup_timeout_sec = 40",
    "[mcp_servers.tracker]",
    'url = "https://mcp.linear.app/mcp"',
    'env_http_headers = { "Authorization" = "LINEAR_TOKEN" }',
    "[mcp_servers.bearer]",
    'url = "https://b.example/mcp"',
    'bearer_token_env_var = "GH_TOKEN"',
    "[mcp_servers.off]",
    'command = "x"',
    'env_vars = ["GH_TOKEN"]',
    "enabled = false",
    "",
  ].join("\n");

  it("sets only the held names on each server that passes them through, so Codex lays them over the entry", async () => {
    expect(await codexLaunchConfig({ user, folder: "/root/spoo-ts" }, values)).toEqual({
      "mcp_servers.notion.env.NOTION_TOKEN": "ntn_TESTONLY",
      "mcp_servers.tracker.http_headers.Authorization": "lin_TESTONLY",
    });
  });

  it("reads the project's file only where Codex's own marks the folder trusted", async () => {
    const project = ['[mcp_servers.proj]', 'command = "p"', 'env_vars = ["GH_TOKEN"]', ""].join("\n");
    expect(Object.keys(await codexLaunchConfig({ user, project, folder: "/root/spoo-ts" }, values))).not.toContain("mcp_servers.proj.env.GH_TOKEN");
    const trusted = `${user}[projects."/root/spoo-ts"]\ntrust_level = "trusted"\n`;
    expect(await codexLaunchConfig({ user: trusted, project, folder: "/root/spoo-ts" }, values)).toMatchObject({ "mcp_servers.proj.env.GH_TOKEN": "ghp_TESTONLY" });
  });

  it("reads a folder's trust however the TOML spells it, a dotted key and an inline table among them", async () => {
    const project = ['[mcp_servers.proj]', 'command = "p"', 'env_vars = ["GH_TOKEN"]', ""].join("\n");
    for (const trust of ['projects."/root/spoo-ts".trust_level = "trusted"', 'projects = { "/root/spoo-ts" = { trust_level = "trusted" } }']) {
      expect(await codexLaunchConfig({ user: `${trust}\n${user}`, project, folder: "/root/spoo-ts" }, values)).toMatchObject({ "mcp_servers.proj.env.GH_TOKEN": "ghp_TESTONLY" });
    }
    const untrusted = `projects."/root/spoo-ts".trust_level = "untrusted"\n${user}`;
    expect(Object.keys(await codexLaunchConfig({ user: untrusted, project, folder: "/root/spoo-ts" }, values))).not.toContain("mcp_servers.proj.env.GH_TOKEN");
  });
});

describe("the held names a launch on a computer the person owns cannot hand a server", () => {
  const held = new Set(["LINEAR_TOKEN", "GH_TOKEN"]);
  const one = (format: typeof MCP_SERVERS_JSON, text: string) => format.read(text, "/root")[0]!;

  it("are none for Claude Code, which takes every server whole with its values in place", () => {
    const server = one(MCP_SERVERS_JSON, JSON.stringify({ mcpServers: { gh: { command: "gh-mcp", env: { GH_TOKEN: "${GH_TOKEN}" } } } }));
    expect(launchMisses("claude", MCP_SERVERS_JSON, server, held)).toEqual([]);
  });

  it("are the one a Codex server reads through its bearer variable, and none it passes through env_vars or env_http_headers", () => {
    const servers = CODEX_TOML.read(
      ['[mcp_servers.web]', 'url = "https://b.example/mcp"', 'bearer_token_env_var = "LINEAR_TOKEN"', '[mcp_servers.gh]', 'command = "gh-mcp"', 'env_vars = ["GH_TOKEN"]', '[mcp_servers.hdr]', 'url = "https://h.example"', 'env_http_headers = { "X-Key" = "LINEAR_TOKEN" }', ""].join("\n"),
      "/root",
    );
    expect(servers.map(s => [s.name, launchMisses("codex", CODEX_TOML, s, held)])).toEqual([["web", ["LINEAR_TOKEN"]], ["gh", []], ["hdr", []]]);
  });

  it("are every held name the server reads for an agent whose launch takes no servers, and none it does not hold", () => {
    const remote = one(OPENCODE_JSON, JSON.stringify({ mcp: { tracker: { type: "remote", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer {env:LINEAR_TOKEN}" } } } }));
    const local = one(OPENCODE_JSON, JSON.stringify({ mcp: { gh: { type: "local", command: ["gh-mcp"], environment: { GH_TOKEN: "{env:GH_TOKEN}", LOG: "{env:LOG}" } } } }));
    expect(launchMisses("opencode", OPENCODE_JSON, remote, held)).toEqual(["LINEAR_TOKEN"]);
    expect(launchMisses("opencode", OPENCODE_JSON, local, held)).toEqual(["GH_TOKEN"]);
    const cursor = one(MCP_SERVERS_JSON, JSON.stringify({ mcpServers: { gh: { command: "gh-mcp", env: { GH_TOKEN: "${GH_TOKEN}" } } } }));
    expect(launchMisses("cursor", MCP_SERVERS_JSON, cursor, held)).toEqual(["GH_TOKEN"]);
  });
});
