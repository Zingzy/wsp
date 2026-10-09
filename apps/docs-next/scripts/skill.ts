// SPDX-License-Identifier: AGPL-3.0-only
// The skill page: skills/wsp/SKILL.md as wsp mcp install writes it with the cloud off, its cloud spans cut, less
// the front matter and its own title.
import { skillFor } from "../../../packages/host/src/cloud-text.js";
import { mdxSafe, page, read, type Generated } from "./generated.js";

/** The skill as a host with no cloud writes it, from its first line after the title. */
export const skillText = (): string =>
  skillFor(read(new URL("../../../skills/wsp/SKILL.md", import.meta.url)), false)
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/^\s*# wsp\n/, "")
    .trim();

export default function skill(): Generated[] {
  const body = [
    "What `wsp mcp install --agent <id>` puts into an agent's skills folder, word for word, so the agent reads it before it opens a thread, sets a person up or forks a machine.",
    mdxSafe(skillText()),
  ];
  return [page("content/agents/skill.mdx", "The wsp skill", "skill.ts", body.join("\n\n"))];
}
