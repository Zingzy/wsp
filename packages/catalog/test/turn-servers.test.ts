// SPDX-License-Identifier: AGPL-3.0-only
// Which servers a turn of an agent gets in a folder, by scope, off the files
// that computer holds: the one answer the launch, the scan, the agents report
// and the checks read. The rules are the ones Claude Code 2.1.296 and Codex
// 0.162.1 were measured to follow.
import { describe, expect, it } from "vitest";
import { MCP_AGENTS } from "../src/catalog.js";
import { checkoutOf, startedServers, turnServerFiles, turnServers, type LaunchConfigs, type TurnServer } from "../src/mcp-launch.js";
import { CODEX_TOML, MCP_SERVERS_JSON } from "../src/mcp.js";
import { codexTrusts } from "../src/mcp-codex.js";

const agent = (id: string) => MCP_AGENTS.find(a => a.id === id)!;
const stdio = (name: string) => ({ command: "node", args: [`/srv/${name}.mjs`] });
const said = (servers: readonly TurnServer[]) => servers.map(s => [s.server.name, s.scope, s.file, s.server.disabled === true ? "off" : "on"]);

describe("a Claude Code turn's servers", () => {
  const user = {
    path: "/root/.claude-cfg/.claude.json",
    text: JSON.stringify({
      mcpServers: { userone: stdio("userone"), shared: stdio("user-shared") },
      projects: {
        "/root": { mcpServers: { homeonly: stdio("homeonly") } },
        "/root/acme": { mcpServers: { localone: stdio("localone"), shared: stdio("local-shared") }, disabledMcpServers: ["userone"], disabledMcpjsonServers: ["leftout"] },
      },
    }),
  };
  const repo = { path: "/root/acme/.mcp.json", text: JSON.stringify({ mcpServers: { inrepo: stdio("inrepo"), shared: stdio("repo-shared") } }) };
  const parent = { path: "/root/.mcp.json", text: JSON.stringify({ mcpServers: { parentone: stdio("parentone"), parenttwo: stdio("parenttwo"), leftout: stdio("leftout") } }) };
  const configs: LaunchConfigs = { user, projects: [repo, parent], folder: "/root/acme" };

  it("is the folder's local entry, then each .mcp.json from the folder up, then the user file, by scope", async () => {
    expect(said(await turnServers(agent("claude"), configs))).toEqual([
      ["localone", "local", user.path, "on"],
      ["shared", "local", user.path, "on"],
      ["inrepo", "project", repo.path, "on"],
      ["shared", "project", repo.path, "on"],
      ["parentone", "project", parent.path, "on"],
      ["parenttwo", "project", parent.path, "on"],
      ["userone", "user", user.path, "off"],
      ["shared", "user", user.path, "on"],
    ]);
  });

  it("starts the first of each name and none switched off, and leaves the home's own entry to a turn at home", async () => {
    const started = startedServers(await turnServers(agent("claude"), configs));
    expect(started.map(s => [s.server.name, s.scope])).toEqual([["localone", "local"], ["shared", "local"], ["inrepo", "project"], ["parentone", "project"], ["parenttwo", "project"]]);
    const home = startedServers(await turnServers(agent("claude"), { user, projects: [parent], folder: "/root" }));
    expect(home.map(s => [s.server.name, s.scope])).toEqual([["homeonly", "local"], ["parentone", "project"], ["parenttwo", "project"], ["leftout", "project"], ["userone", "user"], ["shared", "user"]]);
  });

  it("keys a worktree's local entry by the project's folder, as Claude Code keys it by the main checkout", async () => {
    const started = startedServers(await turnServers(agent("claude"), { user, projects: [], folder: "/root/.wsp/worktrees/acme-fix", key: "/root/acme" }));
    expect(started.map(s => s.server.name)).toEqual(["localone", "shared"]);
  });

  it("keys a subfolder's local entry by its checkout's top, as git answers it there", async () => {
    expect(checkoutOf("/root/acme\n/root/acme/.git\n", "/root/acme/web")).toEqual({ top: "/root/acme", key: "/root/acme" });
    expect(checkoutOf("/root/.wsp/worktrees/acme-fix\n/root/acme/.git\n", "/root/.wsp/worktrees/acme-fix")).toEqual({ top: "/root/.wsp/worktrees/acme-fix", key: "/root/acme" });
    expect(checkoutOf(undefined, "/root/notes")).toEqual({ key: "/root/notes" });
    const { key } = checkoutOf("/root/acme\n/root/acme/.git\n", "/root/acme/web");
    const started = startedServers(await turnServers(agent("claude"), { user, projects: [], folder: "/root/acme/web", key }));
    expect(started.map(s => s.server.name)).toEqual(["localone", "shared"]);
  });

  it("reads every .mcp.json from the folder up to the root", () => {
    expect(turnServerFiles(agent("claude"), "/root/acme/web", "/root", "/root/.claude-cfg")).toEqual({
      user: ["/root/.claude-cfg/.claude.json"],
      projects: ["/root/acme/web/.mcp.json", "/root/acme/.mcp.json", "/root/.mcp.json", "/.mcp.json"],
    });
  });
});

describe("a Codex turn's servers", () => {
  const toml = (...names: string[]) => names.flatMap(n => [`[mcp_servers.${n}]`, 'command = "node"', `args = ["/srv/${n}.mjs"]`, ""]).join("\n");
  const project = { path: "/root/acme/.codex/config.toml", text: toml("cproj", "shared") };
  const own = (extra: string) => ({ path: "/wsp/logins/codex/config.toml", text: `${toml("cuser", "shared")}\n[mcp_servers.off]\ncommand = "x"\nenabled = false\n${extra}` });

  it("reads the project's file before its own where its own file trusts the folder", async () => {
    const user = own('[projects."/root/acme"]\ntrust_level = "trusted"\n');
    const servers = await turnServers(agent("codex"), { user, projects: [project], folder: "/root/acme" });
    expect(said(servers)).toEqual([
      ["cproj", "project", project.path, "on"],
      ["shared", "project", project.path, "on"],
      ["cuser", "user", user.path, "on"],
      ["shared", "user", user.path, "on"],
      ["off", "user", user.path, "off"],
    ]);
    expect(startedServers(servers).map(s => [s.server.name, s.scope])).toEqual([["cproj", "project"], ["shared", "project"], ["cuser", "user"]]);
  });

  it("reads no project file in a folder its own file does not trust", async () => {
    for (const trust of ["", '[projects."/root/acme"]\ntrust_level = "untrusted"\n', '[projects."/root/other"]\ntrust_level = "trusted"\n']) {
      const servers = await turnServers(agent("codex"), { user: own(trust), projects: [project], folder: "/root/acme" });
      expect(servers.map(s => s.scope)).not.toContain("project");
    }
  });

  it("reads the folder's own .codex/config.toml under the store its turns read, and each one up to its checkout's top", () => {
    expect(turnServerFiles(agent("codex"), "/root/acme", "/root", "/wsp/logins/codex")).toEqual({ user: ["/wsp/logins/codex/config.toml"], projects: ["/root/acme/.codex/config.toml"] });
    expect(turnServerFiles(agent("codex"), "/root/acme/web/src", "/root", "/wsp/logins/codex", "/root/acme").projects).toEqual(["/root/acme/web/src/.codex/config.toml", "/root/acme/web/.codex/config.toml", "/root/acme/.codex/config.toml"]);
    // A worktree outside the main checkout reads its own folder's file alone.
    expect(turnServerFiles(agent("codex"), "/root/.wsp/worktrees/acme-fix", "/root", undefined, "/root/acme").projects).toEqual(["/root/.wsp/worktrees/acme-fix/.codex/config.toml"]);
  });

  it("reads a subfolder's servers from the checkout's top: its files up to there, trusted at the main checkout", async () => {
    const user = own('[projects."/root/acme"]\ntrust_level = "trusted"\n');
    const servers = await turnServers(agent("codex"), { user, projects: [{ path: "/root/acme/.codex/config.toml", text: toml("ctop") }], folder: "/root/acme/web", key: "/root/acme" });
    expect(startedServers(servers).map(s => [s.server.name, s.scope])).toEqual([["ctop", "project"], ["cuser", "user"], ["shared", "user"]]);
    expect((await turnServers(agent("codex"), { user, projects: [{ path: "/root/acme/.codex/config.toml", text: toml("ctop") }], folder: "/root/acme/web" })).map(s => s.scope)).not.toContain("project");
  });
});

describe("an agent with no road of its own", () => {
  it("reads the first of its project files in the folder before its own file", async () => {
    const opencode = agent("opencode");
    expect(turnServerFiles(opencode, "/root/acme", "/root").projects).toEqual(["/root/acme/opencode.json", "/root/acme/opencode.jsonc"]);
    const servers = await turnServers(opencode, {
      user: { path: "/root/.config/opencode/opencode.json", text: JSON.stringify({ mcp: { mine: { type: "local", command: ["m"] } } }) },
      projects: [{ path: "/root/acme/opencode.json", text: JSON.stringify({ mcp: { theirs: { type: "local", command: ["t"] } } }) }],
      folder: "/root/acme",
    });
    expect(servers.map(s => [s.server.name, s.scope])).toEqual([["theirs", "project"], ["mine", "user"]]);
  });
});

describe("what a project's servers travel in", () => {
  it("is a copy of the file holding the named servers alone, moved under the folder they are for", () => {
    const own = JSON.stringify({ mcpServers: { userone: stdio("userone") }, projects: { "/Users/dev/acme": { mcpServers: { localone: stdio("localone"), other: stdio("other") }, allowedTools: [] } } });
    expect(JSON.parse(MCP_SERVERS_JSON.only(own, ["localone", "gone"], "/Users/dev/acme", "/Users/dev/acme"))).toEqual({ projects: { "/Users/dev/acme": { mcpServers: { localone: stdio("localone") } } } });
    expect(JSON.parse(MCP_SERVERS_JSON.only(JSON.stringify({ mcpServers: { parentone: stdio("parentone"), b: stdio("b") } }), ["parentone"], undefined, "/Users/dev/acme"))).toEqual({ projects: { "/Users/dev/acme": { mcpServers: { parentone: stdio("parentone") } } } });
    const toml = 'model = "gpt"\n\n[mcp_servers.cproj]\ncommand = "npx"\n\n[mcp_servers.cproj.env]\nLOG = "info"\n\n[mcp_servers.other]\ncommand = "o"\n';
    expect(CODEX_TOML.only(toml, ["cproj"])).toBe('[mcp_servers.cproj]\ncommand = "npx"\n\n[mcp_servers.cproj.env]\nLOG = "info"\n');
  });

  it("marks a folder trusted in Codex's own file, in place where its table is there, and refuses a spelling it does not edit", async () => {
    expect((await CODEX_TOML.trust!(undefined, "/root/acme")).text).toBe('[projects."/root/acme"]\ntrust_level = "trusted"\n');
    expect((await CODEX_TOML.trust!('model = "gpt"\n', "/root/acme")).text).toBe('model = "gpt"\n\n[projects."/root/acme"]\ntrust_level = "trusted"\n');
    expect((await CODEX_TOML.trust!('[projects."/root/acme"]\ntrust_level = "untrusted"\n[mcp_servers.x]\ncommand = "x"\n', "/root/acme")).text).toBe('[projects."/root/acme"]\ntrust_level = "trusted"\n[mcp_servers.x]\ncommand = "x"\n');
    const trusted = 'projects."/root/acme".trust_level = "trusted"\n';
    expect((await CODEX_TOML.trust!(trusted, "/root/acme")).text).toBe(trusted);
    expect(await codexTrusts((await CODEX_TOML.trust!('model = "gpt"\n', "/root/acme")).text, "/root/acme")).toBe(true);
    await expect(CODEX_TOML.trust!('projects."/root/acme".trust_level = "untrusted"\n', "/root/acme")).rejects.toThrow(/shape wsp does not edit/);
    // A file that writes its projects as an inline table takes no table beside it: Codex could not read the result.
    await expect(CODEX_TOML.trust!('projects = { "/root/other" = { trust_level = "trusted" } }\n', "/root/acme")).rejects.toThrow(/shape wsp does not edit/);
  });
});
