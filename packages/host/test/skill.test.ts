// SPDX-License-Identifier: AGPL-3.0-only
// The wsp skill for agents on this computer: one file in the repo, read as
// text at build time, that names every verb and tool and gives the MCP server
// its instructions.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_AGENTS } from "@wsp/catalog";
import { SessionStartOutcome, notifyLine } from "@wsp/protocol";
import { INSTRUCTIONS, SKILL_NAME, WSP_SKILL, instructionsOf } from "../src/skill.js";
import { VERBS } from "../src/verbs.js";

describe("the wsp skill", () => {
  it("is the repo's skills/wsp/SKILL.md, with the frontmatter name and a one-line description without a colon or a quote", () => {
    expect(WSP_SKILL).toBe(readFileSync(new URL("../../../skills/wsp/SKILL.md", import.meta.url), "utf8"));
    const [open, name, description, close] = WSP_SKILL.split("\n");
    expect(open).toBe("---");
    expect(name).toBe(`name: ${SKILL_NAME}`);
    expect(close).toBe("---");
    expect(description).toMatch(/^description: \S/);
    expect(description!.slice("description: ".length)).not.toMatch(/[:"']/);
    expect(description!.length).toBeLessThan(1024);
  });

  it("names every verb in the verbs table and the agents the MCP server installs for; a new verb without a line fails here", () => {
    for (const verb of VERBS) expect(WSP_SKILL, verb.name).toContain(`\`wsp ${verb.name}`);
    expect(WSP_SKILL).toContain(`get the server: ${MCP_AGENTS.map(a => a.id).join(", ")}.`);
  });

  it("quotes the notify line as the protocol prints it and names every send outcome the protocol knows", () => {
    expect(WSP_SKILL).toContain(`\`${notifyLine("1a2b3c4d-0000", { status: "completed", durationMs: 724_000, costUsd: 0.41, text: "first line\n<last line of the reply>" })}\``);
    for (const outcome of SessionStartOutcome.options) expect(WSP_SKILL, outcome).toContain(`(outcome \`${outcome}\`)`);
  });

  it("carries no em dash", () => {
    expect(WSP_SKILL).not.toContain("\u2014");
  });

  it("the MCP instructions are the skill's opening as one paragraph: after the frontmatter and title, before the first section", () => {
    expect(instructionsOf("---\nname: x\ndescription: y\n---\n\n# x\n\nOne.\nTwo.\n\n## Later\n\nNot this.\n")).toBe("One. Two.");
    expect(() => instructionsOf("---\nname: x\n")).toThrow("never closes");
    expect(() => instructionsOf("# x\n\n## Later\n")).toThrow("no opening paragraph");
    expect(INSTRUCTIONS).toBe(instructionsOf(WSP_SKILL));
    expect(INSTRUCTIONS.startsWith("wsp runs cloud machines called workspaces")).toBe(true);
    expect(INSTRUCTIONS).not.toContain("\n");
    expect(INSTRUCTIONS).not.toContain("## ");
  });
});
