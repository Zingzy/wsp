// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { pinnedRelease } from "../release-pins.js";
import { NO_SIGN_IN } from "../signin.js";
import { PROJECT_SHARED_SKILLS, SHARED_SKILLS, XDG_SHARED_SKILLS } from "../skills.js";
import { UNMEASURED, agent } from "./entry.js";

export const GOOSE: AgentEntry = {
  // The binary the x86_64 asset unpacks to.
  ...agent("goose", { bytes: 300841352, on: "2026-09-26", method: "unpacked" }),
  ...UNMEASURED,
  name: "Goose",
  about: { creator: "Block", description: "An open source, extensible agent that installs, runs, edits and tests code with any model.", homepage: "https://goose-docs.ai", repo: "https://github.com/aaif-goose/goose", license: "Apache-2.0" },
  stateHome: ".local/share/goose",
  // Its skills module at v1.52.0: its own config folder, the shared folder, Claude Code's and the XDG agents folder.
  skillRoots: {
    user: [{ dir: "~/.config/goose/skills", lands: "copy" }, { dir: SHARED_SKILLS, lands: "copy" }, { dir: "~/.claude/skills", lands: "link" }, { dir: XDG_SHARED_SKILLS, lands: "copy" }],
    project: [{ dir: ".goose/skills", lands: "copy" }, { dir: PROJECT_SHARED_SKILLS, lands: "copy" }, { dir: ".claude/skills", lands: "link" }],
  },
  installRoad: pinnedRelease("aaif-goose/goose"),
  signIn: NO_SIGN_IN,
};
