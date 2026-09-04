// SPDX-License-Identifier: AGPL-3.0-only
import type { Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { entry, found } from "./common.js";

interface Agent {
  id: string;
  label: string;
  bin: string;
  /** Config that travels with the agent. An allowlist, because the login file
   * (auth.json, .credentials.json) sits next to it and belongs to the logins
   * rung, and because plugin clones and node_modules reinstall from their index. */
  config: string[];
  /** Config the agent rewrites while it runs: it travels, and never decides whether a golden is the same golden. */
  volatile?: string[];
}

export const AGENTS: readonly Agent[] = [
  {
    id: "claude", label: "Claude Code", bin: "claude",
    config: [
      "~/.claude/settings.json", "~/.claude/CLAUDE.md", "~/.claude/skills", "~/.claude/agents", "~/.claude/commands",
      "~/.claude/plugins/installed_plugins.json", "~/.claude/plugins/known_marketplaces.json", "~/.claude.json",
    ],
    // ~/.claude.json holds per-project state and caches rewritten on every run; the plugin indexes carry lastUpdated stamps.
    volatile: ["~/.claude/plugins/installed_plugins.json", "~/.claude/plugins/known_marketplaces.json", "~/.claude.json"],
  },
  { id: "codex", label: "Codex", bin: "codex", config: ["~/.codex/config.toml", "~/.codex/AGENTS.md", "~/.codex/prompts", "~/.codex/skills"] },
  { id: "gemini", label: "Gemini CLI", bin: "gemini", config: ["~/.gemini/settings.json", "~/.gemini/GEMINI.md", "~/.gemini/commands"] },
  {
    id: "opencode", label: "OpenCode", bin: "opencode",
    config: [
      "~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc", "~/.config/opencode/AGENTS.md", "~/.config/opencode/package.json",
      "~/.config/opencode/agents", "~/.config/opencode/commands", "~/.config/opencode/plugins", "~/.config/opencode/skills", "~/.config/opencode/themes",
    ],
  },
  { id: "aider", label: "Aider", bin: "aider", config: ["~/.aider.conf.yml", "~/.aider.model.settings.yml", "~/.aider.model.metadata.json"] },
  {
    // models.json stays: a provider entry may carry a literal apiKey. trust.json
    // stays: it keys on this laptop's absolute project paths.
    id: "pi", label: "Pi", bin: "pi",
    config: [
      "~/.pi/agent/settings.json", "~/.pi/agent/keybindings.json", "~/.pi/agent/AGENTS.md", "~/.pi/agent/SYSTEM.md", "~/.pi/agent/APPEND_SYSTEM.md",
      "~/.pi/agent/prompts", "~/.pi/agent/skills", "~/.pi/agent/extensions", "~/.pi/agent/themes",
    ],
  },
  {
    id: "hermes", label: "Hermes Agent", bin: "hermes",
    config: ["~/.hermes/config.yaml", "~/.hermes/SOUL.md", "~/.hermes/memories", "~/.hermes/skills", "~/.hermes/cron", "~/.hermes/hooks"],
  },
];

export async function detectAgents(host: Host): Promise<ManifestEntry[]> {
  const rows: ManifestEntry[] = [];
  for (const a of AGENTS) {
    const f = await found(host, a.config);
    if (f.paths.length === 0 && !(await host.exec.which(a.bin))) continue;
    rows.push(entry({ rung: "agents", id: `agents/${a.id}`, label: a.label, ...f, ...(a.volatile !== undefined ? { volatile: a.volatile } : {}) }));
  }
  return rows;
}
