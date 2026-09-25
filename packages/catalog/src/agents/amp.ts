// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { NO_SIGN_IN } from "../signin.js";
import { PROJECT_SHARED_SKILLS, SHARED_SKILLS, XDG_SHARED_SKILLS } from "../skills.js";
import { NOT_MEASURED, UNMEASURED, agent } from "./entry.js";

export const AMP: AgentEntry = {
  ...agent("amp", NOT_MEASURED),
  ...UNMEASURED,
  name: "Amp",
  about: { creator: "Sourcegraph", description: "The command line for Amp, a coding agent and development environment.", homepage: "https://ampcode.com", license: "proprietary" },
  stateHome: ".config/amp",
  // The folders its skills docs name; its own comes first by the shared-folder rule in skills.ts.
  skillRoots: {
    user: [{ dir: "~/.config/amp/skills", lands: "copy" }, { dir: XDG_SHARED_SKILLS, lands: "copy" }, { dir: SHARED_SKILLS, lands: "copy" }, { dir: "~/.claude/skills", lands: "link" }],
    project: [{ dir: PROJECT_SHARED_SKILLS, lands: "copy" }, { dir: ".claude/skills", lands: "link" }],
  },
  // Its postinstall links the binary out of the platform package npm already fetched; it downloads nothing.
  installRoad: { road: "npm", package: "@ampcode/cli", version: "0.0.1790352060-g26b83c" },
  signIn: NO_SIGN_IN,
};
