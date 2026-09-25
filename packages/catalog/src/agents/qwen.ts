// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { NO_SIGN_IN } from "../signin.js";
import { NOT_MEASURED, UNMEASURED, agent } from "./entry.js";

export const QWEN: AgentEntry = {
  ...agent("qwen", NOT_MEASURED),
  ...UNMEASURED,
  name: "Qwen Code",
  about: { creator: "Qwen team, Alibaba", description: "An open source coding agent for the terminal from the Qwen team.", homepage: "https://qwenlm.github.io/qwen-code-docs/en/users/overview", repo: "https://github.com/QwenLM/qwen-code", license: "Apache-2.0" },
  stateHome: ".qwen",
  // Its skills docs as of 0.24.5: one folder for the person, one in the project.
  skillRoots: { user: [{ dir: "~/.qwen/skills", lands: "copy" }], project: [{ dir: ".qwen/skills", lands: "copy" }] },
  // The package runs no script of its own; its dependencies ship prebuilt per platform.
  installRoad: { road: "npm", package: "@qwen-code/qwen-code", version: "0.24.5", ignoreScripts: true },
  latest: { from: "npm", package: "@qwen-code/qwen-code" },
  node: 22,
  signIn: NO_SIGN_IN,
};
