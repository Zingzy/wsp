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
}

export const AGENTS: readonly Agent[] = [
  {
    id: "claude", label: "Claude Code", bin: "claude",
    config: [
      "~/.claude/settings.json", "~/.claude/CLAUDE.md", "~/.claude/skills", "~/.claude/agents", "~/.claude/commands",
      "~/.claude/plugins/installed_plugins.json", "~/.claude/plugins/known_marketplaces.json", "~/.claude.json",
    ],
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
];

export async function detectAgents(host: Host): Promise<ManifestEntry[]> {
  const rows: ManifestEntry[] = [];
  for (const a of AGENTS) {
    const f = await found(host, a.config);
    if (f.paths.length === 0 && !(await host.exec.which(a.bin))) continue;
    rows.push(entry({ rung: "agents", id: `agents/${a.id}`, label: a.label, ...f }));
  }
  return rows;
}
