// SPDX-License-Identifier: AGPL-3.0-only
// The table of exit codes on the contract page, from EXIT_CODES and EXIT_WORDS, and the skill's "The contract"
// section under it, as the host writes the skill with the cloud off.
import { EXIT_CODES, EXIT_WORDS, ExitClass } from "../../../packages/protocol/src/exit.js";
import { cell, mdxSafe, table, within, type Generated } from "./generated.js";
import { skillText } from "./skill.js";

/** One section of the skill, its own heading off and its subheadings one level up. */
export function skillSection(heading: string): string {
  const text = skillText();
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`the skill has no "## ${heading}" section`);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).replace(/^### /gm, "## ").trim();
}

/** The skill's words for itself, and what they say on a docs page. */
const SELF = ["The command line, the MCP tools and this skill are one contract", "The command line, the MCP tools and the wsp skill are one contract"] as const;

export default function contract(): Generated[] {
  const exits = table(["Exit", "Class", "When"], ExitClass.options.map(cls => [String(EXIT_CODES[cls]), `\`${cls}\``, cell(EXIT_WORDS[cls])]));
  const section = skillSection("The contract");
  const skillTable = /\n\| exit \| class \| when \|\n(\|.*\|\n)+/;
  if (!skillTable.test(section) || !section.includes(SELF[0])) throw new Error("the skill's contract section no longer holds its exit table or its opening words: change scripts/contract.ts to match");
  // The skill's own copy of the table is swapped for one read off the codes themselves, in the same place.
  const [before, after] = section.replace(SELF[0], SELF[1]).split(skillTable).filter((_, i) => i !== 1);
  return [within("content/reference/contract.mdx", { contract: `${mdxSafe(before!.trimEnd())}\n\n${exits}\n\n${mdxSafe(after!.trimStart())}` })];
}
