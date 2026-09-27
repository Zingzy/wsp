// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { CURSOR } from "../linux-casks.js";
import { SIGN_IN_ROWS } from "../signin.js";
import { PROJECT_SHARED_SKILLS, SHARED_SKILLS } from "../skills.js";
import { UNMEASURED, agent } from "./entry.js";

export const CURSOR_AGENT: AgentEntry = {
  ...agent("cursor", { bytes: 583125383, on: "2026-09-27", method: "unpacked" }),
  ...UNMEASURED,
  // The one name every road gives it: Homebrew's cask links cursor-agent alone, the install script and the Linux
  // release both.
  bin: "cursor-agent",
  name: "Cursor",
  about: { creator: "Anysphere", description: "The command line agent from the makers of the Cursor editor.", homepage: "https://cursor.com/cli", license: "proprietary" },
  mark: { source: "https://github.com/lobehub/lobe-icons/blob/329f378cbd1a88f45b60cd096b9111ce16f3ea39/src/Cursor/components/Mono.tsx", license: "MIT", svg: `<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/></svg>` },
  // Where it keeps a folder's chats, ~/.cursor/projects/<folder key>, as a run under an empty home wrote it.
  stateHome: ".cursor",
  // The folders its skills docs name (cursor.com/docs/skills, read 2026-09-27), its own first by the shared-folder
  // rule in skills.ts; it loads Claude Code's too.
  skillRoots: {
    user: [{ dir: "~/.cursor/skills", lands: "copy" }, { dir: SHARED_SKILLS, lands: "copy" }, { dir: "~/.claude/skills", lands: "link" }],
    project: [{ dir: ".cursor/skills", lands: "copy" }, { dir: PROJECT_SHARED_SKILLS, lands: "copy" }, { dir: ".claude/skills", lands: "link" }],
  },
  installRoad: { road: "vendor", cask: CURSOR, version: CURSOR.version },
  signIn: SIGN_IN_ROWS.cursor,
};
