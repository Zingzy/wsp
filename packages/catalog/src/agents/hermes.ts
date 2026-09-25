// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { HERMES, HERMES_INSTALL } from "../roads.js";
import { HERMES_CONTEXT } from "../context.js";
import { SIGN_IN_ROWS } from "../signin.js";
import { agent, dfSize } from "./entry.js";

export const HERMES_AGENT: AgentEntry = {
  ...agent("hermes", dfSize(484)),
  stateHome: ".hermes",
  name: "Hermes Agent",
  about: { creator: "Nous Research", description: "Nous Research's agent that keeps memories and skills and grows with use.", homepage: "https://hermes-agent.nousresearch.com", repo: "https://github.com/NousResearch/hermes-agent", license: "MIT" },
  context: HERMES_CONTEXT,
  // 0.20.0: one folder, skills under a category folder or straight in it, links into the shared folder among them.
  skillRoots: { user: [{ dir: "~/.hermes/skills", lands: "link" }], project: [] },
  installRoad: { road: "script", script: HERMES_INSTALL, version: HERMES.tag },
  signIn: SIGN_IN_ROWS.hermes,
  configPaths: ["~/.hermes/config.yaml", "~/.hermes/SOUL.md", "~/.hermes/memories", "~/.hermes/skills", "~/.hermes/cron", "~/.hermes/hooks"],
  projectState: [
    { state: "sessions", location: "state.db, table sessions", key: "id like 20260906_033144_55e3e2", pathFields: ["cwd", "git_repo_root"], move: "update sessions set cwd and git_repo_root", status: "measured" },
    { state: "projects registry", location: "projects.db: projects.primary_path, project_folders.path, discovered_repos.root", key: "resolved path columns", pathFields: ["primary_path", "path", "root"], move: "update the rows", status: "inferred" },
  ],
  history: { format: "hermes-sqlite", root: "~/.hermes/state.db" },
  source: { sessions: 1, images: 0, road: "measured" },
};
