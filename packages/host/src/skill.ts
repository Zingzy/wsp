// SPDX-License-Identifier: AGPL-3.0-only
// The wsp skill for agents on this computer, inlined at build time from the
// one file in the repo, so the MCP server's instructions and the skill an
// install writes cannot drift apart.
/// <reference path="./markdown.d.ts" />
import text from "../../../skills/wsp/SKILL.md";

/** The skill's folder name under every agent's skills directory, and its frontmatter name. */
export const SKILL_NAME = "wsp";

export const WSP_SKILL: string = text;

/** The MCP server's instructions: the skill's opening, from its title to its first section heading, as one
 * paragraph. The frontmatter and the title line are not part of it. */
export function instructionsOf(skill: string): string {
  const lines = skill.split("\n");
  let i = 0;
  if (lines[0] === "---") {
    i = lines.indexOf("---", 1) + 1;
    if (i === 0) throw new Error("the skill's frontmatter never closes");
  }
  const body: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) break;
    if (line.startsWith("# ") || line.trim() === "") continue;
    body.push(line.trim());
  }
  if (body.length === 0) throw new Error("the skill has no opening paragraph before its first section");
  return body.join(" ");
}

export const INSTRUCTIONS: string = instructionsOf(WSP_SKILL);
