// SPDX-License-Identifier: AGPL-3.0-only
// The wsp skill for agents on this computer, inlined at build time from the
// one file in the repo, so the MCP server's instructions and the skill an
// install writes cannot drift apart.
/// <reference path="./markdown.d.ts" />
import text from "../../../skills/wsp/SKILL.md";

/** The skill's folder name under every agent's skills directory, and its frontmatter name. */
export const SKILL_NAME = "wsp";

export const WSP_SKILL: string = text;

/** The section whose opening paragraph is the condensed walkthrough the instructions carry; the numbered steps and
 * the exact lines to watch for stay in the skill, which is too long to be a server's instructions. */
export const SETUP_HEADING = "## Setting a person up from nothing";

/** What a caller holding only the tools cannot read off them: where the whole procedure lives, and that the setup
 * verbs are on the command line alone, so a caller with a shell should reach for that instead. */
const BEYOND_THE_TOOLS =
  "The steps, with the exact line to run and what to watch for after each, are in the wsp skill, which `wsp mcp install --agent <id>` writes into this agent's skills folder; when you have a shell prefer the `wsp` command line, since `wsp init` and `wsp up` are the command line's alone and the init is the person's to run in their own terminal.";

/** The lines from `from` up to the next blank line or heading, trimmed and joined as one paragraph. */
function paragraph(lines: readonly string[], from: number): string {
  const body: string[] = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("#")) break;
    if (line.trim() === "") {
      if (body.length > 0) break;
      continue;
    }
    body.push(line.trim());
  }
  return body.join(" ");
}

/** The MCP server's instructions: the skill's opening paragraph, then the setup walkthrough's, then the line that
 * points back at the skill and the command line. The frontmatter and the title line are not part of it. */
export function instructionsOf(skill: string): string {
  const lines = skill.split("\n");
  let start = 0;
  if (lines[0] === "---") {
    start = lines.indexOf("---", 1) + 1;
    if (start === 0) throw new Error("the skill's frontmatter never closes");
  }
  const title = lines.findIndex((line, at) => at >= start && line.startsWith("# "));
  const opening = paragraph(lines, title === -1 ? start : title + 1);
  if (opening === "") throw new Error("the skill has no opening paragraph before its first section");
  const heading = lines.indexOf(SETUP_HEADING);
  if (heading === -1) throw new Error(`the skill has no ${SETUP_HEADING} section`);
  const walkthrough = paragraph(lines, heading + 1);
  if (walkthrough === "") throw new Error(`${SETUP_HEADING} has no opening paragraph`);
  return [opening, walkthrough, BEYOND_THE_TOOLS].join(" ");
}

export const INSTRUCTIONS: string = instructionsOf(WSP_SKILL);
