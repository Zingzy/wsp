// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { detectAgents } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

describe("agents", () => {
  it("Claude Code brings settings, memory, skills, the plugin index and MCP config; never the credential file or marketplace clones", async () => {
    const host = fakeHost({
      files: {
        "~/.claude/settings.json": 400,
        "~/.claude/CLAUDE.md": 900,
        "~/.claude/skills/x/SKILL.md": 3000,
        "~/.claude/agents/a.md": 100,
        "~/.claude/.credentials.json": 800,
        "~/.claude/plugins/installed_plugins.json": 600,
        "~/.claude/plugins/marketplaces/x/.git/pack": 90_000_000,
        "~/.claude/projects/p/transcript.jsonl": 5_000_000,
        "~/.claude.json": 2000,
      },
      which: ["claude"],
    });
    const rows = await detectAgents(host);
    expect(rows).toEqual([
      {
        rung: "agents", id: "agents/claude", label: "Claude Code",
        paths: ["~/.claude/settings.json", "~/.claude/CLAUDE.md", "~/.claude/skills", "~/.claude/agents", "~/.claude/plugins/installed_plugins.json", "~/.claude.json"],
        bytes: 7000, default: "bring",
      },
    ]);
  });

  it.each([
    ["codex", { "~/.codex/config.toml": 50, "~/.codex/auth.json": 900, "~/.codex/prompts/p.md": 20 }, "Codex", ["~/.codex/config.toml", "~/.codex/prompts"], 70],
    ["gemini", { "~/.gemini/settings.json": 30, "~/.gemini/oauth_creds.json": 500 }, "Gemini CLI", ["~/.gemini/settings.json"], 30],
    ["opencode", { "~/.config/opencode/opencode.json": 60, "~/.config/opencode/node_modules/x/index.js": 5000, "~/.local/share/opencode/auth.json": 200 }, "OpenCode", ["~/.config/opencode/opencode.json"], 60],
    ["aider", { "~/.aider.conf.yml": 40 }, "Aider", ["~/.aider.conf.yml"], 40],
  ])("%s config travels without its login file", async (name, files, label, paths, bytes) => {
    const rows = await detectAgents(fakeHost({ files }));
    expect(rows).toEqual([{ rung: "agents", id: `agents/${name}`, label, paths, bytes, default: "bring" }]);
  });

  it("a binary with no config is still an installed agent", async () => {
    const rows = await detectAgents(fakeHost({ which: ["codex"] }));
    expect(rows).toEqual([{ rung: "agents", id: "agents/codex", label: "Codex", paths: [], bytes: 0, default: "bring" }]);
  });

  it("agents the laptop does not have are not listed", async () => {
    expect(await detectAgents(fakeHost())).toEqual([]);
  });
});
