// SPDX-License-Identifier: AGPL-3.0-only
// The recipe's MCP servers on a computer somebody owns. The guest is a temp
// directory with real configs in it, so what the run ends with is the file on
// disk: a config wsp landed is edited, a config of the person's is read by
// nobody and left byte for byte as it was.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_TOML, MCP_SERVERS_JSON } from "@wsp/catalog";
import { MCP_ID_PREFIX } from "@wsp/protocol";
import type { McpPlan } from "../src/golden-mcp.js";
import { provisionMcp, theirConfigLine } from "../src/provision-mcp.js";
import { boxGuest, cleanGuests, type BoxGuest } from "./box-guest.js";

const HOME = "/Users/dev";

const guests: BoxGuest[] = [];
afterEach(() => cleanGuests(guests.splice(0)));

function box(): BoxGuest {
  const g = boxGuest(["npx"]);
  guests.push(g);
  return g;
}

const CLAUDE = {
  mcpServers: {
    github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    notes: { command: `${HOME}/Library/Notes/mcp`, args: [] },
  },
};

const CODEX = ['model = "gpt-5"', "", "[mcp_servers.grafana]", 'command = "npx"', ""].join("\n");

function planOn(root: string): McpPlan {
  return {
    agents: [
      {
        id: "claude",
        label: "Claude Code",
        scopes: [{ files: [join(root, ".claude-cfg/.claude.json")], format: MCP_SERVERS_JSON, keep: ["github"], drop: [{ name: "notes", reason: "command is macOS-only, will not run" }] }],
        aside: [],
      },
      { id: "codex", label: "Codex", scopes: [{ files: [join(root, ".codex/config.toml")], format: CODEX_TOML, keep: ["grafana"], drop: [] }], aside: [] },
    ],
    guestHome: root,
    rewrites: [[`${HOME}/`, `${root}/`]],
    binDirs: [`${HOME}/.local/bin/`],
    tools: [],
  };
}

function seed(root: string): void {
  mkdirSync(join(root, ".claude-cfg"), { recursive: true });
  writeFileSync(join(root, ".claude-cfg", ".claude.json"), `${JSON.stringify(CLAUDE, null, 2)}\n`);
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, ".codex", "config.toml"), CODEX);
}

describe("the recipe's servers on a computer somebody owns", () => {
  it("writes them into the config wsp landed and leaves the config the person keeps exactly as it is, naming that on its rows", async () => {
    const { root, machine, cmds, runs } = box();
    seed(root);
    const before = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    const rows = await provisionMcp(machine, planOn(root), { home: root, owned: new Map([[join(root, ".claude-cfg/.claude.json"), "present" as const]]), tools: [], stage: () => {} });
    expect(rows.map(r => [r.id, r.outcome, r.kind])).toEqual([
      [`${MCP_ID_PREFIX}claude/github`, "installed", "server"],
      [`${MCP_ID_PREFIX}claude/notes`, "skipped", "server"],
      [`${MCP_ID_PREFIX}codex/grafana`, "skipped", "server"],
    ]);
    expect(rows[2]!.note).toBe(theirConfigLine("Codex", join(root, ".codex/config.toml")));
    expect(rows[0]!.label).toBe("Claude Code github");
    // The person's own config is not read off the computer, not edited and not written back.
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toBe(before);
    expect(runs.some(r => r.includes(join(root, ".codex/config.toml")))).toBe(false);
    expect(cmds.some(c => c.includes(".codex/config.toml.wsp-mcp"))).toBe(false);
    const claude = JSON.parse(readFileSync(join(root, ".claude-cfg", ".claude.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(claude.mcpServers)).toEqual(["github"]);
  });

  it("says installed on the run the config arrived on, and present on the next, when the recipe's servers are already in it", async () => {
    const { root, machine } = box();
    seed(root);
    // The run that landed the config: every server in it arrived with this run, whatever the edit then changed.
    const landedNow = new Map([[join(root, ".claude-cfg/.claude.json"), "installed" as const]]);
    const first = await provisionMcp(machine, planOn(root), { home: root, owned: landedNow, tools: [], stage: () => {} });
    expect(first[0]!.outcome).toBe("installed");
    const owned = new Map([[join(root, ".claude-cfg/.claude.json"), "present" as const]]);
    const again = await provisionMcp(machine, planOn(root), { home: root, owned, tools: [], stage: () => {} });
    expect(again.map(r => [r.id, r.outcome])).toEqual([
      [`${MCP_ID_PREFIX}claude/github`, "present"],
      [`${MCP_ID_PREFIX}claude/notes`, "skipped"],
      [`${MCP_ID_PREFIX}codex/grafana`, "skipped"],
    ]);
  });

  it("leaves a config that is on no computer to the edit itself, which skips its servers rather than writing a file nobody has", async () => {
    const { root, machine } = box();
    const rows = await provisionMcp(machine, planOn(root), { home: root, owned: new Map(), tools: [], stage: () => {} });
    expect(rows.every(r => r.outcome === "skipped")).toBe(true);
    expect(rows[0]!.note).toContain("Claude Code's config is not on the machine");
  });
});
