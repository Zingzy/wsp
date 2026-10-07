// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { AGENTS, detectAgents } from "../src/index.js";
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
        // Rewritten by Claude Code while it runs (project state, plugin timestamps): they travel but never decide the recipe hash.
        volatile: ["~/.claude/plugins/installed_plugins.json", "~/.claude.json"],
      },
    ]);
  });

  it("Claude Code's row lists every local file a hook in its settings runs, and nothing for a system binary or a command on PATH", async () => {
    const settings = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "~/.claude/hooks/commit-batching", timeout: 10 }, { type: "command", command: "bash $HOME/.claude/hooks/no-secret-print.sh" }] },
          { hooks: [{ type: "command", command: "/usr/bin/true" }, { type: "command", command: "jq -r .tool_input.command" }, { type: "command", command: "~/.claude/hooks/gone" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "~/.claude/skills/x/run.sh" }] }],
      },
    });
    const host = fakeHost({
      files: { "~/.claude/settings.json": settings, "~/.claude/skills/x/run.sh": 30, "~/.claude/hooks/commit-batching": 120, "~/.claude/hooks/no-secret-print.sh": 80 },
      which: ["claude"],
    });
    const [claude] = await detectAgents(host);
    expect(claude?.paths).toEqual(["~/.claude/settings.json", "~/.claude/skills", "~/.claude/hooks/commit-batching", "~/.claude/hooks/no-secret-print.sh"]);
    expect(claude?.bytes).toBe(settings.length + 30 + 120 + 80);
  });

  it.each([
    ["codex", { "~/.codex/config.toml": 50, "~/.codex/auth.json": 900, "~/.codex/prompts/p.md": 20 }, "Codex", ["~/.codex/config.toml", "~/.codex/prompts"], 70],
    ["gemini", { "~/.gemini/settings.json": 30, "~/.gemini/oauth_creds.json": 500 }, "Gemini CLI", ["~/.gemini/settings.json"], 30],
    ["opencode", { "~/.config/opencode/opencode.json": 60, "~/.config/opencode/node_modules/x/index.js": 5000, "~/.local/share/opencode/auth.json": 200 }, "OpenCode", ["~/.config/opencode/opencode.json"], 60],
    ["aider", { "~/.aider.conf.yml": 40 }, "Aider", ["~/.aider.conf.yml"], 40],
    [
      "pi",
      { "~/.pi/agent/settings.json": 80, "~/.pi/agent/keybindings.json": 10, "~/.pi/agent/AGENTS.md": 500, "~/.pi/agent/prompts/p.md": 20, "~/.pi/agent/skills/s/SKILL.md": 30, "~/.pi/agent/extensions/e.ts": 40, "~/.pi/agent/themes/t.json": 50,
        "~/.pi/agent/auth.json": 900, "~/.pi/agent/models.json": 300, "~/.pi/agent/trust.json": 70, "~/.pi/agent/sessions/x/s.jsonl": 5_000_000, "~/.pi/agent/git/pkg/index.ts": 8000, "~/.pi/agent/npm/node_modules/x/index.js": 9000 },
      "Pi",
      ["~/.pi/agent/settings.json", "~/.pi/agent/keybindings.json", "~/.pi/agent/AGENTS.md", "~/.pi/agent/prompts", "~/.pi/agent/skills", "~/.pi/agent/extensions", "~/.pi/agent/themes"],
      730,
    ],
    [
      "hermes",
      { "~/.hermes/config.yaml": 600, "~/.hermes/SOUL.md": 200, "~/.hermes/memories/MEMORY.md": 300, "~/.hermes/skills/s/SKILL.md": 40, "~/.hermes/cron/jobs.json": 50, "~/.hermes/hooks/h.py": 60,
        "~/.hermes/.env": 25_000, "~/.hermes/auth.json": 400, "~/.hermes/state.db": 9_000_000, "~/.hermes/sessions/s.json": 700, "~/.hermes/hermes-agent/.git/pack": 90_000_000, "~/.hermes/cache/x": 100, "~/.hermes/logs/gateway.log": 800 },
      "Hermes Agent",
      ["~/.hermes/config.yaml", "~/.hermes/SOUL.md", "~/.hermes/memories", "~/.hermes/skills", "~/.hermes/cron", "~/.hermes/hooks"],
      1250,
    ],
  ])("%s config travels without its login file", async (name, files, label, paths, bytes) => {
    const rows = await detectAgents(fakeHost({ files }));
    expect(rows).toEqual([{ rung: "agents", id: `agents/${name}`, label, paths, bytes, default: "bring" }]);
  });

  it.each([
    ["codex", "Codex"],
    ["pi", "Pi"],
    ["hermes", "Hermes Agent"],
  ])("%s on PATH with no config is still an installed agent", async (bin, label) => {
    const rows = await detectAgents(fakeHost({ which: [bin] }));
    expect(rows).toEqual([{ rung: "agents", id: `agents/${bin}`, label, paths: [], bytes: 0, default: "bring" }]);
  });

  it("lists the catalog's agents in its order, then Aider, which the catalog does not ship", () => {
    expect(AGENTS.map(a => a.id)).toEqual([...CATALOG_AGENTS.map(a => a.id), "aider"]);
  });

  it("agents the laptop does not have are not listed", async () => {
    expect(await detectAgents(fakeHost())).toEqual([]);
  });
});
