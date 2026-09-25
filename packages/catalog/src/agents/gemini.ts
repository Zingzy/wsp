// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { GEMINI_CONTEXT } from "../context.js";
import { GEMINI_MCP_LOGIN } from "../mcp-login.js";
import { GEMINI_SETTINGS_JSON } from "../mcp.js";
import { SIGN_IN_ROWS } from "../signin.js";
import { agent, dfSize } from "./entry.js";

export const GEMINI: AgentEntry = {
  ...agent("gemini", dfSize(189)),
  stateHome: ".gemini",
  name: "Gemini CLI",
  about: { creator: "Google", description: "An open source agent that brings Gemini into the terminal.", homepage: "https://geminicli.com", repo: "https://github.com/google-gemini/gemini-cli", license: "Apache-2.0" },
  context: GEMINI_CONTEXT,
  // Its docs as of 0.58.0 (no Gemini on the Mac measured); copies found there.
  skillRoots: { user: [{ dir: "~/.gemini/skills", lands: "copy" }], project: [{ dir: ".gemini/skills", lands: "copy" }] },
  installRoad: { road: "npm", package: "@google/gemini-cli", version: "0.58.0" },
  latest: { from: "npm", package: "@google/gemini-cli" },
  node: 20,
  signIn: SIGN_IN_ROWS.gemini,
  // https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md (project scope is a repo's .gemini/settings.json)
  mcp: { format: GEMINI_SETTINGS_JSON, files: ["~/.gemini/settings.json"], projectFiles: [".gemini/settings.json"], scope: "user scope", login: GEMINI_MCP_LOGIN },
  configPaths: ["~/.gemini/settings.json", "~/.gemini/GEMINI.md", "~/.gemini/commands"],
  projectState: [
    { state: "project registry", location: "projects.json", key: "{\"projects\": {\"PATH\": \"SLUG\"}}; SLUG is the folder basename, deduplicated", pathFields: ["the key"], move: "rewrite the key, keep the slug", status: "measured" },
    { state: "project temp dir", location: "tmp/SLUG/ with chats/, logs/ and .project_root", key: "the slug from the registry", pathFields: [".project_root"], move: "rewrite .project_root", status: "measured" },
    { state: "shell history", location: "history/SLUG/ with .project_root", key: "the same slug", pathFields: [".project_root"], move: "rewrite .project_root", status: "measured" },
    { state: "chat files", location: "tmp/SLUG/chats/session-TIMESTAMP-ID8.jsonl", key: "by slug directory", pathFields: ["projectHash in the header line, the sha256 hex of the resolved path", "the workspace path as text in the first user message"], move: "optional; neither listing nor resume checks it", status: "measured" },
    { state: "trust", location: "trustedFolders.json", key: "the resolved path to a trust level", pathFields: ["the key"], move: "rewrite the key", status: "inferred" },
  ],
  source: { sessions: 0, images: 0, road: "measured" },
};
