// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { AGENTS_MD, SET_UP_WSP, agent, dfSize } from "./entry.js";
import { CLAUDE_CODE, CLAUDE_CONFIG_DIR, CLAUDE_INSTALL, CLAUDE_LATEST, LOCAL_BIN } from "../roads.js";
import { CLAUDE_CONTEXT } from "../context.js";
import { CLAUDE_HOOKS, CLAUDE_SETTINGS_FILE } from "../hooks.js";
import { CLAUDE_MCP_CHECK } from "../mcp-check.js";
import { CLAUDE_MCP_LOGIN } from "../mcp-login.js";
import { CLAUDE_PLUGIN_SKILLS } from "../skills.js";
import { MCP_SERVERS_JSON } from "../mcp.js";
import { SIGN_IN_ROWS } from "../signin.js";

export const CLAUDE: AgentEntry = {
  ...agent("claude", dfSize(208)),
  stateHome: ".claude",
  guestStateHome: CLAUDE_CONFIG_DIR,
  stateHomeEnv: "CLAUDE_CONFIG_DIR",
  projectKeyEnv: "CLAUDE_CODE_PROJECT_DIR_NAME",
  name: "Claude Code",
  about: { creator: "Anthropic", description: "Anthropic's coding agent for the terminal. It reads the codebase, edits files, runs commands and handles git.", homepage: "https://code.claude.com/docs/en/overview", repo: "https://github.com/anthropics/claude-code", license: "proprietary" },
  context: CLAUDE_CONTEXT,
  // 2.1.281: ~/.claude/skills alone, links into the shared folder among them; plugins under their own folders.
  skillRoots: { user: [{ dir: "~/.claude/skills", lands: "link" }], project: [{ dir: ".claude/skills", lands: "link" }] },
  pluginSkills: CLAUDE_PLUGIN_SKILLS,
  projectDocs: [AGENTS_MD, "CLAUDE.md"],
  // The slash is the skill's folder name, host's SKILL_NAME, which the catalog cannot import; mcp-install.test.ts pins this to it.
  firstMove: `/wsp ${SET_UP_WSP}`,
  installRoad: { road: "script", script: CLAUDE_INSTALL, version: CLAUDE_CODE.version, bins: [LOCAL_BIN] },
  latest: { from: "text", url: CLAUDE_LATEST },
  signIn: SIGN_IN_ROWS.claude,
  // https://docs.claude.com/en/docs/claude-code/mcp (user scope; project scope lives in each repo's .mcp.json)
  mcp: { format: MCP_SERVERS_JSON, files: ["~/.claude.json"], projectFiles: [".mcp.json"], scope: "user scope and your home folder", httpAuth: "its sign-in is kept with the Claude Code login", check: CLAUDE_MCP_CHECK, login: CLAUDE_MCP_LOGIN },
  hooks: CLAUDE_HOOKS,
  configPaths: [
    CLAUDE_SETTINGS_FILE, "~/.claude/CLAUDE.md", "~/.claude/skills", "~/.claude/agents", "~/.claude/commands",
    "~/.claude/plugins/installed_plugins.json", "~/.claude/plugins/known_marketplaces.json", "~/.claude.json",
  ],
  // ~/.claude.json holds per-project state and caches rewritten on every run; the plugin indexes carry lastUpdated stamps.
  volatile: ["~/.claude/plugins/installed_plugins.json", "~/.claude/plugins/known_marketplaces.json", "~/.claude.json"],
  projectState: [
    { state: "session transcripts", location: "projects/KEY/SESSIONID.jsonl and projects/KEY/SESSIONID/", key: "the resolved path with every character outside A-Z a-z 0-9 replaced by a dash", pathFields: ["cwd on every message line"], move: "rename the KEY directory; rewriting cwd is optional", status: "measured" },
    { state: "auto memory", location: "projects/KEY/memory/", key: "the same KEY", pathFields: [], move: "comes along with the directory rename", status: "measured" },
    { state: "per-project settings", location: "~/.claude.json, the projects object", key: "the plain resolved path as the JSON key", pathFields: ["the key"], move: "rename the key", status: "inferred" },
    { state: "prompt history", location: "history.jsonl", key: "one line per prompt", pathFields: ["project"], move: "rewrite the field", status: "inferred" },
  ],
  history: { format: "claude-jsonl", root: "~/.claude/projects" },
  source: { sessions: 149, images: 1, road: "measured" },
};
