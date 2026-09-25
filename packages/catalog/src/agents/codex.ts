// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { CODEX_CONFIG_FILE, CODEX_HOOKS } from "../codex-hooks.js";
import { CODEX_CONTEXT } from "../context.js";
import { CODEX_MCP_LOGIN } from "../mcp-login.js";
import { CODEX_TOML } from "../mcp.js";
import { PROJECT_SHARED_SKILLS, SHARED_SKILLS } from "../skills.js";
import { SIGN_IN_ROWS } from "../signin.js";
import { agent, dfSize } from "./entry.js";

export const CODEX: AgentEntry = {
  ...agent("codex", dfSize(455)),
  stateHome: ".codex",
  name: "Codex",
  about: { creator: "OpenAI", description: "OpenAI's coding agent that runs locally in the terminal.", homepage: "https://developers.openai.com/codex", repo: "https://github.com/openai/codex", license: "Apache-2.0" },
  context: CODEX_CONTEXT,
  // 0.155.1: CODEX_HOME's skills, where it writes copies, and the shared folder.
  skillRoots: { user: [{ dir: "~/.codex/skills", lands: "copy" }, { dir: SHARED_SKILLS, lands: "copy" }], project: [{ dir: PROJECT_SHARED_SKILLS, lands: "copy" }] },
  installRoad: { road: "npm", package: "@openai/codex", version: "0.153.0" },
  node: 16,
  signIn: SIGN_IN_ROWS.codex,
  // https://developers.openai.com/codex/config-basic (project scope is a trusted repo's .codex/config.toml)
  mcp: { format: CODEX_TOML, files: [CODEX_CONFIG_FILE], projectFiles: [".codex/config.toml"], scope: "user scope", login: CODEX_MCP_LOGIN },
  hooks: CODEX_HOOKS,
  configPaths: [CODEX_CONFIG_FILE, "~/.codex/AGENTS.md", "~/.codex/prompts", "~/.codex/skills"],
  projectState: [
    { state: "rollout transcript", location: "sessions/YYYY/MM/DD/rollout-TIMESTAMP-THREADID.jsonl", key: "by date and thread id, not by path", pathFields: ["cwd in the session_meta payload and on per-turn lines"], move: "rewrite cwd", status: "measured" },
    { state: "thread index", location: "state_5.sqlite, table threads", key: "one row per thread id", pathFields: ["cwd", "rollout_path"], move: "update threads set cwd; rollout_path changes only if CODEX_HOME itself moves", status: "measured" },
    { state: "trust", location: "config.toml, table [projects.\"PATH\"]", key: "the quoted resolved path as the TOML table name", pathFields: ["the table name"], move: "rename the table", status: "inferred" },
    { state: "memories", location: "memories/rollout_summaries/*.md and memories/MEMORY.md", key: "global files", pathFields: ["cwd: and path: lines in each summary", "applies_to: cwd=PATH lines in MEMORY.md"], move: "rewrite if memories should follow the project", status: "inferred" },
  ],
  history: { format: "codex-rollout", root: "~/.codex/sessions" },
  source: { sessions: 5, images: 1, road: "measured" },
};
