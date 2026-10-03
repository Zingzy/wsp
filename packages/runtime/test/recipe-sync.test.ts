// SPDX-License-Identifier: AGPL-3.0-only
// What moved between what a computer applied and the recipe it follows now,
// and which steps of the setup carry each move.
import { describe, expect, it } from "vitest";
import { RecipeFile } from "@wsp/protocol";
import { recipeChanges, stepsFor } from "../src/recipe-sync.js";

const BEFORE = RecipeFile.parse({
  name: "laptop",
  agents: { claude: { signin: "vault" } },
  clis: { jq: { via: "brew" } },
  skills: { unslop: { from: "~/.claude/skills" } },
  mcp: { linear: { agents: ["claude"] } },
  configs: { git: {} },
});
const ITEMS = { "agents/claude": "a1", "clis/jq": "1.7", "skills/unslop": "s1", "mcp/linear/claude": "m1", "configs/git": "g1" };

describe("what moved in a followed recipe", () => {
  it("is nothing where nothing moved", () => {
    expect(recipeChanges(BEFORE, ITEMS, BEFORE, ITEMS)).toEqual([]);
  });

  it("names each row added, changed in the recipe, edited on this computer and taken out", () => {
    const after = RecipeFile.parse({ ...BEFORE, agents: { claude: { signin: "machine" } }, skills: { why: { from: "~/.claude/skills" } }, plugins: { "lint@acme": {} } });
    const changes = recipeChanges(BEFORE, ITEMS, after, { ...ITEMS, "clis/jq": "1.8", "skills/why": "w1" });
    expect(changes.map(c => [c.key, c.how])).toEqual([
      ["agents/claude", "changed"],
      ["clis/jq", "edited"],
      ["skills/why", "added"],
      ["skills/unslop", "removed"],
      ["plugins/lint@acme", "added"],
    ]);
  });

  it("reads every row with an item as edited once, on a computer that kept no items", () => {
    expect(recipeChanges(BEFORE, undefined, BEFORE, ITEMS).map(c => c.key)).toEqual(["agents/claude", "mcp/linear", "clis/jq", "skills/unslop", "configs/git"]);
  });

  it("carries each move by the steps that put it on, and a removal by none but the servers'", () => {
    const steps = (after: RecipeFile, items: Record<string, string>) => [...stepsFor(recipeChanges(BEFORE, ITEMS, after, items), after)].sort();
    expect(steps({ ...BEFORE, skills: { ...BEFORE.skills, why: { from: "~/.claude/skills" } } }, { ...ITEMS, "skills/why": "w" })).toEqual(["skills"]);
    expect(steps(BEFORE, { ...ITEMS, "agents/claude": "a2" })).toEqual(["mcp"]);
    expect(steps({ ...BEFORE, agents: { claude: { signin: "machine" } } }, ITEMS)).toEqual(["signins"]);
    expect(steps({ ...BEFORE, agents: { ...BEFORE.agents, codex: { signin: "machine" } } }, ITEMS)).toEqual(["agents", "context", "mcp", "signins", "skills"]);
    expect(steps({ ...BEFORE, clis: { ...BEFORE.clis, nextest: { via: "cargo", needs: ["build-essential"] } } }, ITEMS)).toEqual(["clis", "context", "floor"]);
    expect(steps({ ...BEFORE, mcp: {} }, ITEMS)).toEqual(["mcp"]);
    expect(steps({ ...BEFORE, skills: {} }, ITEMS)).toEqual([]);
    expect(steps({ ...BEFORE, configs: { git: {}, github: { signin: "vault" } } }, ITEMS)).toEqual(["github"]);
  });
});
